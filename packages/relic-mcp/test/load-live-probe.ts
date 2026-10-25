/**
 * Production live probe for Relic loading progress and early key cancellation.
 * Written for Spec B (§5.L). Run only after merge and a verified deploy.
 *
 *   RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic \
 *     bun packages/relic-mcp/test/load-live-probe.ts
 *
 * Supports loopback verification:
 *   RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic \
 *   RELIC_SERVICE_ORIGIN=loopback \
 *     bun packages/relic-mcp/test/load-live-probe.ts
 */

import type { Server } from 'bun';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';

import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

if (process.env['RELIC_LOAD_PROBE_CONFIRM'] !== 'publish-one-1-day-relic') {
  console.error(
    'Refusing to run live probe: RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic must be set.'
  );
  process.exit(1);
}

const rawOrigin = process.env['RELIC_SERVICE_ORIGIN'];
const isLoopbackMode =
  rawOrigin === 'loopback' ||
  rawOrigin?.startsWith('http://127.0.0.1') ||
  rawOrigin?.startsWith('http://localhost');

const viewerDist =
  process.env['RELIC_VIEWER_DIST'] ??
  fileURLToPath(new URL('../../relic-viewer/dist/', import.meta.url));

const probeClient = process.env['RELIC_LOAD_PROBE_CLIENT'] ?? 'source';
const proofDir = process.env['RELIC_LOAD_PROOF_DIR'];

const CHUNK_SIZE = 16384;
const CHUNK_DELAY_MS = Number(
  process.env['RELIC_LOAD_PROOF_CHUNK_DELAY_MS'] ?? 15
);

let serviceOrigin = (rawOrigin ?? 'https://relik.link').replace(/\/+$/, '');
let usercontentService: Server<unknown> | undefined;
let mainService: Server<unknown> | undefined;

if (rawOrigin === 'loopback') {
  usercontentService = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/sandbox.html') {
        return new Response(Bun.file(join(viewerDist, 'sandbox.html')), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
          },
        });
      }
      if (url.pathname === '/sandbox.js') {
        return new Response(Bun.file(join(viewerDist, 'sandbox.js')), {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  const usercontentOrigin = `http://127.0.0.1:${usercontentService.port}`;

  let handler: ((request: Request) => Promise<Response>) | undefined;
  mainService = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!handler) return new Response('Not ready', { status: 503 });
      return handler(request);
    },
  });
  serviceOrigin = `http://127.0.0.1:${mainService.port}`;

  const store = new MemoryStore();
  const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
  const storage = new MemoryStorage(`${serviceOrigin}/__storage`);

  const app = createApp({
    config: {
      serviceOrigin,
      usercontentOrigin,
    },
    store,
    storage,
    now: () => Date.now(),
    operatorTokens,
    assets: diskAssets(viewerDist),
  });

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname === '/sw.js' ||
      url.pathname === '/assets/register-sw.js'
    ) {
      return new Response(null, { status: 404 });
    }

    if (request.method === 'POST' && url.pathname.includes('/mint')) {
      await Bun.sleep(100);
    }

    // Storage upload
    if (
      url.pathname.startsWith('/__storage/upload/') &&
      request.method === 'PUT'
    ) {
      const objectKey = decodeURIComponent(
        url.pathname.slice('/__storage/upload/'.length).split('?')[0] ?? ''
      );
      const bytes = new Uint8Array(await request.arrayBuffer());
      storage.put(objectKey, bytes);
      return new Response(null, { status: 200 });
    }

    // Storage download (chunked with delay)
    if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
      const objectKey = decodeURIComponent(
        url.pathname.slice('/__storage/o/'.length).split('?')[0] ?? ''
      );
      const bytes = await storage.read(objectKey);
      if (!bytes) return new Response('Not found', { status: 404 });

      let cancelled = false;
      request.signal.addEventListener('abort', () => {
        cancelled = true;
      });

      const stream = new ReadableStream({
        async start(controller) {
          let offset = 0;
          while (offset < bytes.length) {
            if (request.signal.aborted || cancelled) {
              return;
            }
            const end = Math.min(offset + CHUNK_SIZE, bytes.length);
            const chunk = bytes.subarray(offset, end);
            controller.enqueue(chunk);
            offset = end;
            if (offset < bytes.length && CHUNK_DELAY_MS > 0) {
              await Bun.sleep(CHUNK_DELAY_MS);
            }
          }
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
      });
    }

    return app.fetch(request);
  };
}

const scratch = await mkdtemp(join(tmpdir(), 'relic-load-live-probe-'));
const statePath = join(scratch, 'state.json');

const bundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);
assert.ok(
  existsSync(bundlePath),
  `dist/relic-mcp.js not found at ${bundlePath}. Run bun run --cwd packages/relic-mcp build:bundle first.`
);

function resolveCommand(): string[] {
  if (probeClient.startsWith('npx:')) {
    const pkg = probeClient.slice(4);
    return ['npx', `relic-mcp@${pkg}`];
  }
  return ['node', bundlePath];
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cmd = resolveCommand();
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: serviceOrigin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/load-live-probe',
      RELIC_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(exit, 0, `relic-mcp exited with code ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const raw = lines[lines.length - 1];
  assert.ok(raw !== undefined, 'relic-mcp returned empty output');
  const response = JSON.parse(raw) as {
    error?: unknown;
    result?: { structuredContent?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
  };
  if (response.error) {
    throw new Error(`MCP error: ${JSON.stringify(response.error)}`);
  }
  const result = response.result?.structuredContent ?? response.result;
  assert.ok(result !== undefined, 'missing result in MCP response');
  return result;
}

/**
 * Generate a PNG of approximately targetBytes size filled with uncompressible noise.
 */
function makeNoisePng(targetBytes: number): Uint8Array {
  const width = 1000;
  // Each scanline: 1 filter byte + width * 3 bytes (RGB)
  const scanlineBytes = 1 + width * 3;
  const numScanlines = Math.max(1, Math.ceil(targetBytes / scanlineBytes));

  const rawData = new Uint8Array(numScanlines * scanlineBytes);
  for (let y = 0; y < numScanlines; y++) {
    const rowOffset = y * scanlineBytes;
    rawData[rowOffset] = 0; // Filter: None
    const rowData = randomBytes(width * 3);
    rawData.set(rowData, rowOffset + 1);
  }

  // Deflate the raw scanlines (with no compression to keep size large and incompressible)
  const idatData = deflateSync(rawData, { level: 0 });

  function makeChunk(type: string, data: Uint8Array): Uint8Array {
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    view.setUint32(0, data.length, false);
    chunk.set(new TextEncoder().encode(type), 4);
    chunk.set(data, 8);

    // CRC32 over type + data
    let c = 0xffffffff;
    for (let i = 4; i < 8 + data.length; i++) {
      c ^= chunk[i]!;
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
    }
    view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0, false);
    return chunk;
  }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(
    ihdrData.buffer,
    ihdrData.byteOffset,
    ihdrData.byteLength
  );
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, numScanlines, false);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 2; // RGB color type
  ihdrData[10] = 0; // Deflate
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Non-interlaced

  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const idatChunk = makeChunk('IDAT', idatData);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const totalLength =
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  out.set(sig, pos);
  pos += sig.length;
  out.set(ihdrChunk, pos);
  pos += ihdrChunk.length;
  out.set(idatChunk, pos);
  pos += idatChunk.length;
  out.set(iendChunk, pos);
  return out;
}

const RECORDER_SOURCE = `(() => {
  const samples = [];
  let sampling = true;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function doSample() {
    if (window.top !== window) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      if (sampling) requestAnimationFrame(doSample);
      return;
    }
    const body = document.body;
    if (body) {
      const bar = document.querySelector('header.bar');
      const plate = document.querySelector('[data-load-plate]');
      const meter = plate ? plate.querySelector('.load-meter, [role="progressbar"]') : null;
      const custody = document.querySelector('[data-load-custody], header.bar .identity .filename');
      const pill = document.querySelector('.render-status, [data-render-status]');
      const contentStage = document.querySelector('main.stage:not(.stage-loading):not(.stage-dead), .stage-wrap');
      const deadCard = document.querySelector('main.stage-dead .card, .stage.stage-dead .card, main.stage-dead');

      samples.push({
        time: performance.now(),
        bodyPresent: true,
        barVisible: isVisible(bar),
        plateVisible: isVisible(plate),
        platePhase: plate ? (plate.getAttribute('data-load-phase') || null) : null,
        meterValuenow: meter ? meter.getAttribute('aria-valuenow') : null,
        custodyText: custody ? (custody.textContent || '').trim() : null,
        renderPillVisible: isVisible(pill),
        renderPillText: pill ? (pill.textContent || '').trim() : null,
        contentStageVisible: isVisible(contentStage),
        deadCardVisible: isVisible(deadCard),
        scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
        innerWidth: window.innerWidth,
        url: location.href,
      });
    } else {
      samples.push({
        time: performance.now(),
        bodyPresent: false,
        barVisible: false,
        plateVisible: false,
        platePhase: null,
        meterValuenow: null,
        custodyText: null,
        renderPillVisible: false,
        renderPillText: null,
        contentStageVisible: false,
        deadCardVisible: false,
        scrollWidth: 0,
        innerWidth: window.innerWidth,
      });
    }

    if (sampling) {
      requestAnimationFrame(doSample);
    }
  }

  doSample();
  window.__relicLoadSamples = samples;
  window.__stopRelicLoadSampling = () => { sampling = false; return samples; };
})();`;

interface Sample {
  time: number;
  bodyPresent: boolean;
  barVisible: boolean;
  plateVisible: boolean;
  platePhase: string | null;
  meterValuenow: string | null;
  custodyText: string | null;
  renderPillVisible: boolean;
  renderPillText: string | null;
  contentStageVisible: boolean;
  deadCardVisible: boolean;
  scrollWidth: number;
  innerWidth: number;
}

interface StorageRequestTracker {
  requestId: string | undefined;
  requestWillBeSent: boolean;
  responseReceived: boolean;
  dataReceivedEvents: number;
  dataReceivedTimestamps: number[];
  dataReceivedBytes: number;
  encodedDataLength: number;
  loadingFinished: boolean;
  loadingFailed: { errorText: string; canceled: boolean } | undefined;
}

interface RunOutcome {
  targetId: string;
  sessionId: string;
  samples: Sample[];
  firstProgressShot: Buffer | null;
  readyShot: Buffer | null;
  storageRequest: StorageRequestTracker;
  throttleMethod: string;
  close: () => Promise<void>;
}

const defaultOwnedShell =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const chromeCandidate =
  process.env['RELIC_PROOF_CHROME_PATH'] ??
  process.env['RELIC_CHROME_PATH'] ??
  (existsSync(defaultOwnedShell) ? defaultOwnedShell : undefined);

const foundChrome = await discoverChrome(chromeCandidate);
assert.equal(
  foundChrome.kind,
  'found',
  `Could not find headless Chrome: ${foundChrome.kind === 'not_found' ? foundChrome.detail : foundChrome.kind}`
);
if (foundChrome.kind !== 'found') throw new Error('unreachable');

const chromeProfileDir = await mkdtemp(
  join(tmpdir(), 'relic-load-live-chrome-')
);
const sharedArgs = chromeArgs(foundChrome.path, chromeProfileDir);

const urlObj = new URL(serviceOrigin);
const host = urlObj.hostname;
const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

let customArgs: string[];
if (isLoopbackMode) {
  customArgs = [
    ...sharedArgs.map((arg) => {
      if (arg === '--proxy-bypass-list=<-loopback>') {
        return `--proxy-bypass-list=<-loopback>;localhost;127.0.0.1;${host}:${port};127.0.0.1:${port};localhost:${port}${usercontentService ? `;127.0.0.1:${usercontentService.port}` : ''}`;
      }
      if (arg === '--host-resolver-rules=MAP * ~NOTFOUND') {
        return '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';
      }
      return arg;
    }),
    '--autoplay-policy=no-user-gesture-required',
    '--disable-service-workers',
  ];
} else {
  const storageHost = 'storage.googleapis.com';
  customArgs = [
    ...sharedArgs.map((arg) => {
      if (arg === '--proxy-bypass-list=<-loopback>') {
        return `--proxy-bypass-list=<-loopback>;${host};*.${host};${storageHost}`;
      }
      if (arg === '--host-resolver-rules=MAP * ~NOTFOUND') {
        return `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}, EXCLUDE *.${host}, EXCLUDE ${storageHost}`;
      }
      if (arg.startsWith('--proxy-server=')) {
        return '--no-proxy-server';
      }
      return arg;
    }),
    '--autoplay-policy=no-user-gesture-required',
    '--disable-service-workers',
  ];
}

const launch = createBrowserHeadlessLaunch(customArgs, chromeProfileDir);
const child = spawn(foundChrome.path, launch.args, {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
});
const cdp: CdpConnection = connectPipe(
  child.stdio[3] as unknown as Writable,
  child.stdio[4] as unknown as Readable
);
await attestBrowserHeadless(cdp, launch);

async function runRelicPage(
  url: string,
  options: {
    viewport?: { width: number; height: number; mobile?: boolean };
    colorScheme?: 'light' | 'dark';
    waitForDeadCard?: boolean;
    throttle?: boolean;
  } = {}
): Promise<RunOutcome> {
  const created = (await cdp.send('Target.createTarget', {
    url: 'about:blank',
  })) as { targetId: string };
  const targetId = created.targetId;
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const sessionId = attached.sessionId;

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);
  await cdp.send('CSS.enable', {}, sessionId);
  await cdp.send(
    'Network.setCacheDisabled',
    { cacheDisabled: true },
    sessionId
  );

  const vp = options.viewport ?? { width: 1440, height: 900, mobile: false };
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.mobile ?? false,
    },
    sessionId
  );
  await cdp.send(
    'Emulation.setEmulatedMedia',
    {
      media: 'screen',
      features: [
        {
          name: 'prefers-color-scheme',
          value: options.colorScheme ?? 'light',
        },
      ],
    },
    sessionId
  );

  let throttleMethod = 'none';
  if (options.throttle !== false) {
    try {
      await cdp.send(
        'Network.emulateNetworkConditions',
        {
          offline: false,
          latency: 100,
          downloadThroughput: 1_000_000,
          uploadThroughput: 375_000,
          connectionType: 'cellular4g',
        },
        sessionId
      );
      throttleMethod = 'Network.emulateNetworkConditions';
    } catch {
      try {
        await cdp.send(
          'Network.emulateNetworkConditionsByRule',
          {
            rules: [
              {
                urlPattern: '*',
                latency: 100,
                downloadThroughput: 1_000_000,
                uploadThroughput: 375_000,
              },
            ],
          },
          sessionId
        );
        throttleMethod = 'Network.emulateNetworkConditionsByRule';
      } catch {}
    }
  }

  let isolatedContextId: number | undefined;
  const stopContextListener = cdp.onEvent((e) => {
    if (
      e.method === 'Runtime.executionContextCreated' &&
      e.sessionId === sessionId
    ) {
      const ctx = (e.params as { context: { id: number; name: string } })
        .context;
      if (ctx.name === 'relic-load-proof' && isolatedContextId === undefined) {
        isolatedContextId = ctx.id;
      }
    }
  });

  const storageReq: StorageRequestTracker = {
    requestId: undefined,
    requestWillBeSent: false,
    responseReceived: false,
    dataReceivedEvents: 0,
    dataReceivedTimestamps: [],
    dataReceivedBytes: 0,
    encodedDataLength: 0,
    loadingFinished: false,
    loadingFailed: undefined,
  };

  const stopNetListener = cdp.onEvent((e) => {
    if (e.sessionId !== sessionId) return;
    const params = e.params;
    if (!params || typeof params !== 'object') return;

    if (e.method === 'Network.requestWillBeSent') {
      if (
        'request' in params &&
        params.request &&
        typeof params.request === 'object' &&
        'url' in params.request
      ) {
        const reqUrl = String(params.request.url);
        if (
          reqUrl.includes('/__storage/o/') ||
          reqUrl.includes('storage.googleapis.com')
        ) {
          storageReq.requestId = String(params['requestId']);
          storageReq.requestWillBeSent = true;
        }
      }
    }
    if (e.method === 'Network.responseReceived') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.responseReceived = true;
      }
    }
    if (e.method === 'Network.dataReceived') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.dataReceivedEvents++;
        storageReq.dataReceivedTimestamps.push(Date.now());
        const dLen =
          typeof params['dataLength'] === 'number' ? params['dataLength'] : 0;
        const eLen =
          typeof params['encodedDataLength'] === 'number'
            ? params['encodedDataLength']
            : 0;
        storageReq.dataReceivedBytes += dLen || eLen;
        storageReq.encodedDataLength += eLen || dLen;
      }
    }
    if (e.method === 'Network.loadingFinished') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.loadingFinished = true;
        if (typeof params['encodedDataLength'] === 'number') {
          storageReq.encodedDataLength = params['encodedDataLength'];
        }
      }
    }
    if (e.method === 'Network.loadingFailed') {
      if (params['requestId'] === storageReq.requestId) {
        storageReq.loadingFailed = {
          errorText: String(params['errorText'] ?? ''),
          canceled: params['canceled'] === true,
        };
      }
    }
  });

  await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: RECORDER_SOURCE, worldName: 'relic-load-proof' },
    sessionId
  );

  await cdp.send('Page.navigate', { url }, sessionId);

  let firstProgressShot: Buffer | null = null;
  let readyShot: Buffer | null = null;

  const start = Date.now();
  const timeoutMs = 45_000;

  while (Date.now() - start < timeoutMs) {
    await Bun.sleep(25);
    if (isolatedContextId === undefined) continue;

    const evalRes = (await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const s = window.__relicLoadSamples || [];
            const latest = s[s.length - 1];
            return {
              len: s.length,
              hasValuenow: s.some(x => x.meterValuenow !== null),
              latest
            };
          })()`,
          contextId: isolatedContextId,
          returnByValue: true,
        },
        sessionId
      )
      .catch(() => null)) as {
      result?: {
        value?: { len: number; hasValuenow: boolean; latest?: Sample };
      };
    } | null;

    const state = evalRes?.result?.value;
    if (!state?.latest) continue;

    if (
      !firstProgressShot &&
      (state.hasValuenow || state.latest.platePhase === 'fetching')
    ) {
      const shot = (await cdp
        .send('Page.captureScreenshot', { format: 'png' }, sessionId)
        .catch(() => null)) as { data: string } | null;
      if (shot) firstProgressShot = Buffer.from(shot.data, 'base64');
    }

    if (options.waitForDeadCard) {
      if (state.latest.deadCardVisible) {
        await Bun.sleep(100);
        const shot = (await cdp
          .send('Page.captureScreenshot', { format: 'png' }, sessionId)
          .catch(() => null)) as { data: string } | null;
        if (shot) readyShot = Buffer.from(shot.data, 'base64');
        break;
      }
    } else {
      if (state.latest.contentStageVisible && !state.latest.renderPillVisible) {
        await Bun.sleep(100);
        const shot = (await cdp
          .send('Page.captureScreenshot', { format: 'png' }, sessionId)
          .catch(() => null)) as { data: string } | null;
        if (shot) readyShot = Buffer.from(shot.data, 'base64');
        break;
      }
    }
  }

  let samples: Sample[] = [];
  if (isolatedContextId !== undefined) {
    const rawSamples = (await cdp
      .send(
        'Runtime.evaluate',
        {
          expression:
            'window.__stopRelicLoadSampling ? window.__stopRelicLoadSampling() : (window.__relicLoadSamples || [])',
          contextId: isolatedContextId,
          returnByValue: true,
        },
        sessionId
      )
      .catch(() => null)) as { result?: { value?: Sample[] } } | null;
    samples = rawSamples?.result?.value ?? [];
  }

  return {
    targetId,
    sessionId,
    samples,
    firstProgressShot,
    readyShot,
    storageRequest: storageReq,
    throttleMethod,
    close: async () => {
      stopContextListener();
      stopNetListener();
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    },
  };
}

try {
  const noisePath = join(scratch, 'noise.png');
  const noiseBytes = makeNoisePng(8 * 1024 * 1024);
  await writeFile(noisePath, noiseBytes);

  const pubResult = await callMcp('relic_publish', {
    path: noisePath,
    ttl_days: 1,
    title: '',
    cover: false,
  });

  const relicId = String(pubResult['relic_id'] ?? '');
  assert.ok(relicId.length > 0, 'missing relic_id in publish result');
  const shareUrl = String(pubResult['url'] ?? pubResult['share_url'] ?? '');
  assert.ok(shareUrl.length > 0, 'missing share_url/url in publish result');

  const hashIdx = shareUrl.indexOf('#');
  const rightKey = hashIdx !== -1 ? shareUrl.slice(hashIdx + 1) : '';
  assert.ok(
    rightKey && (rightKey.length === 22 || rightKey.length === 24),
    `invalid key format extracted from publish, length ${rightKey.length}`
  );

  console.log(`Published live probe relic: id=${relicId}`);

  // Fetch deployed viewer.js to record its sha256 in receipt
  const viewerResp = await fetch(`${serviceOrigin}/assets/viewer.js`);
  const viewerText = await viewerResp.text();
  const viewerBuffer = new TextEncoder().encode(viewerText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', viewerBuffer);
  const viewerSha256 = Array.from(new Uint8Array(hashBuffer), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

  const correctUrl = `${serviceOrigin}/${relicId}#${rightKey}`;

  // --- Run 1: Throttled valid open at 1440x900 light -------------------------
  console.log('Running Run 1: Throttled valid open (1440x900 light)...');
  const run1Outcome = await runRelicPage(correctUrl, {
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    throttle: true,
  });

  // 1. samples.length > 0
  assert.ok(run1Outcome.samples.length > 0, 'Run 1: no samples recorded');

  // 2. No blank frames
  for (const s of run1Outcome.samples) {
    if (s.bodyPresent) {
      assert.ok(
        s.barVisible,
        `Run 1: no-blank check failed: sample at t=${s.time.toFixed(1)} has body present but bar is not visible`
      );
      assert.ok(
        s.plateVisible ||
          s.contentStageVisible ||
          s.renderPillVisible ||
          s.deadCardVisible,
        `Run 1: no-blank check failed: sample at t=${s.time.toFixed(1)} has body present but neither plate, stage, pill, nor dead card is visible`
      );
    }
  }

  // 3. Phases in order through ready
  const phases: string[] = [];
  for (const s of run1Outcome.samples) {
    if (s.platePhase && phases[phases.length - 1] !== s.platePhase) {
      phases.push(s.platePhase);
    }
  }
  for (let i = 0; i < phases.length; i++) {
    if (i > 0) {
      const prev = phases[i - 1];
      const curr = phases[i];
      if (prev === 'decrypting' && curr === 'fetching') {
        assert.fail(`Run 1: phases out of order: ${phases.join(' -> ')}`);
      }
      if (prev === 'fetching' && curr === 'opening') {
        assert.fail(`Run 1: phases out of order: ${phases.join(' -> ')}`);
      }
    }
  }

  // 4. At least 5 distinct aria-valuenow values
  const valuenows = new Set(
    run1Outcome.samples
      .map((s) => s.meterValuenow)
      .filter((v): v is string => v !== null)
  );
  assert.ok(
    valuenows.size >= 5,
    `Run 1: must show >= 5 distinct aria-valuenow values, saw ${valuenows.size}`
  );

  // 5. Storage request receives at least 5 dataReceived events spread over at least 2 seconds
  const req1 = run1Outcome.storageRequest;
  assert.ok(req1.requestWillBeSent, 'Run 1: storage request was not sent');
  assert.ok(
    req1.dataReceivedTimestamps.length >= 5,
    `Run 1: storage request must receive >= 5 dataReceived events, saw ${req1.dataReceivedTimestamps.length}`
  );
  const storageDurationMs =
    req1.dataReceivedTimestamps[req1.dataReceivedTimestamps.length - 1]! -
    req1.dataReceivedTimestamps[0]!;
  assert.ok(
    storageDurationMs >= 2000,
    `Run 1: storage request dataReceived events must span >= 2000ms, spanned ${storageDurationMs}ms`
  );

  // 6. loadingFinished.encodedDataLength >= object_length
  assert.ok(
    req1.loadingFinished,
    'Run 1: storage request did not complete successfully'
  );
  const receivedBytes1 = req1.encodedDataLength || req1.dataReceivedBytes;
  assert.ok(
    receivedBytes1 >= noiseBytes.length,
    `Run 1: received bytes (${receivedBytes1}) must be >= object_length (${noiseBytes.length})`
  );

  // 7. Ready stage visible, pill hidden
  const lastSample1 = run1Outcome.samples[run1Outcome.samples.length - 1];
  assert.ok(
    lastSample1?.contentStageVisible,
    'Run 1: content stage must be visible at ready'
  );
  assert.ok(
    !lastSample1?.renderPillVisible,
    'Run 1: render pill must be hidden at ready'
  );

  await run1Outcome.close();

  // --- Run 2: Wrong key early cancellation -----------------------------------
  console.log('Running Run 2: Wrong key early cancellation...');
  const charIdx = rightKey.startsWith('r1') ? 2 : 0;
  const targetChar = rightKey[charIdx]!;
  const wrongChar = targetChar === 'A' ? 'B' : 'A';
  const wrongKey =
    rightKey.slice(0, charIdx) + wrongChar + rightKey.slice(charIdx + 1);
  const wrongUrl = `${serviceOrigin}/${relicId}#${wrongKey}`;

  const run2Outcome = await runRelicPage(wrongUrl, {
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    waitForDeadCard: true,
    throttle: true,
  });

  // 1. could-not-be-opened card within 30 seconds
  const deadCardSaw = run2Outcome.samples.some((s) => s.deadCardVisible);
  assert.ok(
    deadCardSaw,
    'Run 2: could-not-be-opened card must appear on wrong key within 30 seconds'
  );

  // 2. Storage request ends in Network.loadingFailed with canceled: true
  const req2 = run2Outcome.storageRequest;
  assert.ok(
    req2.loadingFailed?.canceled,
    `Run 2: storage request must end in Network.loadingFailed with canceled: true, got ${JSON.stringify(req2.loadingFailed)}`
  );

  // 3. Cancel bytes <= 1,048,576 and < object_length / 4
  const cancelBytes = req2.encodedDataLength || req2.dataReceivedBytes;
  assert.ok(
    cancelBytes <= 1_048_576,
    `Run 2: cancel_bytes (${cancelBytes}) must be <= 1,048,576 bytes`
  );
  assert.ok(
    cancelBytes < Math.floor(noiseBytes.length / 4),
    `Run 2: cancel_bytes (${cancelBytes}) must be < object_length / 4 (${Math.floor(noiseBytes.length / 4)})`
  );

  // 4. No dataReceived arrives in 5 seconds after card appears
  const bytesAtCard = req2.dataReceivedBytes;
  await Bun.sleep(5000);
  const bytesAfter5s = req2.dataReceivedBytes;
  assert.equal(
    bytesAfter5s,
    bytesAtCard,
    `Run 2: no dataReceived must arrive in 5 seconds after card appears (bytes at card: ${bytesAtCard}, after 5s: ${bytesAfter5s})`
  );

  await run2Outcome.close();

  // --- Run 3: Correct key at 390x844 dark ------------------------------------
  console.log('Running Run 3: Mobile dark (390x844)...');
  const run3Outcome = await runRelicPage(correctUrl, {
    viewport: { width: 390, height: 844, mobile: true },
    colorScheme: 'dark',
    throttle: false,
  });

  // 1. samples.length > 0
  assert.ok(run3Outcome.samples.length > 0, 'Run 3: no samples recorded');

  // 2. No blank frames
  for (const s of run3Outcome.samples) {
    if (s.bodyPresent) {
      assert.ok(
        s.barVisible,
        `Run 3: no-blank check failed: sample at t=${s.time.toFixed(1)} has body present but bar is not visible`
      );
      assert.ok(
        s.plateVisible ||
          s.contentStageVisible ||
          s.renderPillVisible ||
          s.deadCardVisible,
        `Run 3: no-blank check failed: sample at t=${s.time.toFixed(1)} has body present but neither plate, stage, pill, nor dead card is visible`
      );
    }
  }

  // 3. No horizontal overflow
  for (const s of run3Outcome.samples) {
    if (s.scrollWidth > 0 && s.innerWidth > 0) {
      assert.ok(
        s.scrollWidth <= s.innerWidth,
        `Run 3: horizontal overflow: scrollWidth (${s.scrollWidth}) > innerWidth (${s.innerWidth})`
      );
    }
  }

  // 4. Relic renders ready
  const lastSample3 = run3Outcome.samples[run3Outcome.samples.length - 1];
  assert.ok(
    lastSample3?.contentStageVisible,
    'Run 3: content stage must be visible at ready'
  );
  assert.ok(
    !lastSample3?.renderPillVisible,
    'Run 3: render pill must be hidden at ready'
  );

  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
    const receipt = {
      relicId,
      deployedViewerSha256: viewerSha256,
      objectLength: noiseBytes.length,
      timestamp: new Date().toISOString(),
      serviceOrigin,
      throttleMethod: run1Outcome.throttleMethod,
      measurements: {
        run1: {
          progressSteps: valuenows.size,
          valuenowValues: Array.from(valuenows),
          phases,
          storageDataReceivedEvents: req1.dataReceivedTimestamps.length,
          storageDurationMs,
          storageEncodedDataLength: receivedBytes1,
        },
        run2: {
          cancelBytes,
          loadingFailed: req2.loadingFailed,
          bytesAfterCardIn5s: bytesAfter5s - bytesAtCard,
        },
        run3: {
          scrollWidth: lastSample3?.scrollWidth ?? 0,
          innerWidth: 390,
          renderedReady: true,
        },
      },
    };
    await writeFile(
      join(proofDir, 'receipt.json'),
      JSON.stringify(receipt, null, 2)
    );
    if (run1Outcome.firstProgressShot) {
      await writeFile(
        join(proofDir, '01-progress.png'),
        run1Outcome.firstProgressShot
      );
    }
    if (run1Outcome.readyShot) {
      await writeFile(join(proofDir, '01-ready.png'), run1Outcome.readyShot);
    }
    if (run2Outcome.readyShot) {
      await writeFile(
        join(proofDir, '02-wrong-key-card.png'),
        run2Outcome.readyShot
      );
    }
    if (run3Outcome.readyShot) {
      await writeFile(
        join(proofDir, '03-mobile-dark-ready.png'),
        run3Outcome.readyShot
      );
    }
  }

  await run3Outcome.close();

  console.log(
    `LOAD_LIVE_OK relic_id=${relicId} progress_steps=${valuenows.size} cancel_bytes=${cancelBytes} object_length=${noiseBytes.length}`
  );
} finally {
  try {
    await cdp.send('Browser.close').catch(() => {});
  } catch {}
  await cleanupOwnedBrowserStartup({
    child,
    profile: chromeProfileDir,
    connection: cdp,
    forgetChild: undefined,
    removeProfile: undefined,
  }).catch(() => {});
  if (mainService) {
    await mainService.stop(true);
  }
  if (usercontentService) {
    await usercontentService.stop(true);
  }
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
