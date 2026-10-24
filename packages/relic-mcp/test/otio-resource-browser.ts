/**
 * Targeted OTIO resource and pixel proof browser harness.
 *
 * Exercises the real encrypted viewer through loopback publication and an owned
 * headless browser, verifying two OTIO resource repairs against pinned baseline:
 *   - Repair A (aaddcc54): Bounded held-sequence indexing
 *   - Repair B (80becfbf): Depth-reused composition surfaces
 *
 * Subcommands:
 *   record  --config <absolute-config.json> --out <new-absolute-output-dir>
 *   compare --baseline <baseline-dir> --candidate <candidate-dir> [--self-test-substitution]
 *
 * Loopback only: MemoryStore, MemoryStorage, mail recorder.
 * Browser is ONLY the configured owned headless shell, hash-checked before spawn.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { deflateSync } from 'node:zlib';

import { crc32 } from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';

import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs } from '../src/cover/chrome.ts';
import { buildZipArchive } from '../src/otio-bundle.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import { PRELUDE_SOURCE } from './otio-resource-browser-prelude.ts';

// Maximum browser stderr capture in bytes
const MAX_STDERR_BYTES = 1024 * 1024;

export interface HarnessConfig {
  readonly label: string;
  readonly productSha: string;
  readonly productRoot: string;
  readonly viewerDist: string;
  readonly nodePath: string;
  readonly mcpBundle: string;
  readonly chromePath: string;
  readonly chromeSha256: string;
}

interface CanvasStats {
  readonly creations: number;
  readonly offscreenCreated: number;
  readonly visibleCreated: number;
  readonly currentOffscreenPixels: number;
  readonly peakOffscreenPixels: number;
  readonly paintsCount: number;
  readonly lastPaint: {
    readonly paintIndex: number;
    readonly offscreenCanvasIdsUsed: readonly number[];
    readonly leafFills: number;
    readonly clears: number;
    readonly draws: number;
    readonly complete: boolean;
  } | null;
}

interface DisposalEvidence {
  readonly before: {
    readonly totalCanvasesCreated: number;
    readonly currentOffscreenPixels: number;
    readonly peakOffscreenPixels: number;
    readonly surfaces: Array<{
      readonly id: number;
      readonly role: string;
      readonly width: number;
      readonly height: number;
      readonly pixels: number;
    }>;
  };
  readonly after: {
    readonly totalCanvasesCreated: number;
    readonly currentOffscreenPixels: number;
    readonly peakOffscreenPixels: number;
    readonly surfaces: Array<{
      readonly id: number;
      readonly role: string;
      readonly width: number;
      readonly height: number;
      readonly pixels: number;
    }>;
  };
}

interface ChromeSession {
  readonly cdp: CdpConnection;
  readonly child: ChildProcess;
  readonly profile: string;
  readonly evaluate: <T>(expression: string) => Promise<T>;
  readonly screenshot: (label: string) => Promise<Buffer>;
  readonly captureCanvasPixels: () => Promise<Buffer>;
  readonly close: () => Promise<void>;
  readonly terminate: () => Promise<void>;
}

// Compute SHA-256 hex digest of a buffer or string
function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// Compute SHA-256 of file on disk
function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// Build sorted asset manifest for a directory
function buildAssetManifest(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(current: string) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(dir, fullPath).replace(/\\/g, '/');
        result[rel] = sha256File(fullPath);
      }
    }
  }
  walk(dir);
  const sortedKeys = Object.keys(result).sort();
  const sortedManifest: Record<string, string> = {};
  for (const k of sortedKeys) {
    sortedManifest[k] = result[k] ?? '';
  }
  return sortedManifest;
}

// Verify absolute path and existence
function assertAbsolutePath(p: string, name: string): void {
  assert.ok(isAbsolute(p), `${name} must be an absolute path: ${p}`);
  assert.ok(existsSync(p), `${name} path does not exist: ${p}`);
}

// Validate config shape and pre-conditions
function validateConfig(configPath: string): {
  config: HarnessConfig;
  hashes: Record<string, string>;
  assetManifest: Record<string, string>;
} {
  assert.ok(isAbsolute(configPath), `config path must be absolute: ${configPath}`);
  assert.ok(existsSync(configPath), `config file does not exist: ${configPath}`);

  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw) as HarnessConfig;

  assert.ok(typeof config.label === 'string' && config.label.length > 0, 'label is required');
  assert.ok(typeof config.productSha === 'string' && config.productSha.length > 0, 'productSha is required');

  assertAbsolutePath(config.productRoot, 'productRoot');
  assertAbsolutePath(config.viewerDist, 'viewerDist');
  assertAbsolutePath(config.nodePath, 'nodePath');
  assertAbsolutePath(config.mcpBundle, 'mcpBundle');
  assertAbsolutePath(config.chromePath, 'chromePath');

  // Verify productRoot HEAD matches productSha
  const headSha = execFileSync('git', ['-C', config.productRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.ok(
    headSha.startsWith(config.productSha) || config.productSha.startsWith(headSha),
    `productRoot HEAD ${headSha} does not match configured productSha ${config.productSha}`
  );

  // Hash Chrome executable before spawning
  const actualChromeHash = sha256File(config.chromePath);
  assert.strictEqual(
    actualChromeHash,
    config.chromeSha256,
    `chrome executable SHA-256 mismatch: expected ${config.chromeSha256}, got ${actualChromeHash}`
  );

  // Build viewerDist asset manifest
  const assetManifest = buildAssetManifest(config.viewerDist);

  // Record hashes of critical sources and binaries
  const otioTimingPath = join(config.productRoot, 'packages/relic-format/src/otio-timing.ts');
  const otioPlaybackPath = join(config.productRoot, 'packages/relic-viewer/src/otio-playback.ts');

  assert.ok(existsSync(otioTimingPath), `otio-timing.ts not found at ${otioTimingPath}`);
  assert.ok(existsSync(otioPlaybackPath), `otio-playback.ts not found at ${otioPlaybackPath}`);

  const hashes: Record<string, string> = {
    chrome: actualChromeHash,
    node: sha256File(config.nodePath),
    mcpBundle: sha256File(config.mcpBundle),
    otioTiming: sha256File(otioTimingPath),
    otioPlayback: sha256File(otioPlaybackPath),
  };

  return { config, hashes, assetManifest };
}

// Generate minimal deterministic PNG
export function buildPng(
  width: number,
  height: number,
  rgba: (x: number, y: number) => [number, number, number, number]
): Uint8Array {
  function makeChunk(type: string, data: Uint8Array): Uint8Array {
    const len = data.length;
    const buf = Buffer.alloc(4 + 4 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    Buffer.from(data).copy(buf, 8);
    const typeAndData = buf.subarray(4, 8 + len);
    const c = crc32(new Uint8Array(typeAndData));
    buf.writeUInt32BE(c >>> 0, 8 + len);
    return new Uint8Array(buf);
  }

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = makeChunk('IHDR', ihdr);

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgba(x, y);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }

  const compressed = deflateSync(raw, { level: 9 });
  const idatChunk = makeChunk('IDAT', new Uint8Array(compressed));
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const totalLen = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk], totalLen);
  return new Uint8Array(out);
}

// Build standard deterministic .otioz archive
export function buildOtioz(
  otioJson: string,
  mediaFiles: Array<{ name: string; data: Uint8Array }> = []
): Uint8Array {
  const entries = [
    {
      name: 'version.txt',
      data: new TextEncoder().encode('1.0.0\n'),
      method: 0 as const,
    },
    {
      name: 'content.otio',
      data: new TextEncoder().encode(otioJson),
      method: 8 as const,
    },
    ...mediaFiles.map((f) => ({
      name: f.name,
      data: f.data,
      method: 8 as const,
    })),
  ];
  return buildZipArchive(entries);
}

// Loopback service wrapper
interface LoopbackService {
  readonly origin: string;
  readonly port: number;
  readonly stop: () => Promise<void>;
  readonly createSessionToken: () => Promise<string>;
}

async function startLoopbackServer(
  viewerDist: string,
  stderrPath: string
): Promise<LoopbackService> {
  const store = new MemoryStore();
  const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
  const mails: Array<{ to: string; mail: unknown }> = [];
  const fakeNow = Date.now();

  let handler: ((request: Request) => Promise<Response>) | undefined;
  const service = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (!handler) return new Response('Not ready', { status: 503 });
      return handler(request);
    },
  });

  const origin = `http://127.0.0.1:${service.port}`;
  const storage = new MemoryStorage(`${origin}/__storage`);

  const app = createApp({
    config: { serviceOrigin: origin },
    store,
    storage,
    now: () => fakeNow,
    operatorTokens,
    assets: diskAssets(viewerDist),
    mailer: {
      send: async () => {},
      sendMail: async (to, mail) => {
        mails.push({ to, mail });
      },
    },
  });

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    assert.ok(
      url.hostname === '127.0.0.1' || url.hostname === 'localhost',
      `non-loopback request reached loopback server: ${url.hostname}`
    );

    if (url.pathname.startsWith('/__storage/upload/') && request.method === 'PUT') {
      const relicId = url.pathname.slice('/__storage/upload/'.length);
      storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
      const relicId = url.pathname.slice('/__storage/o/'.length);
      const bytes = await storage.read(relicId);
      if (!bytes) return new Response('Not found', { status: 404 });
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    const response = await app.fetch(request);
    if (response.status >= 400) {
      try {
        const clone = response.clone();
        const text = await clone.text().catch(() => '');
        appendFileSync(
          stderrPath,
          `[loopback ${request.method} ${url.pathname} -> ${response.status}]\n${text}\n`
        );
      } catch {}
    }
    return response;
  };

  async function createSessionToken(email = 'proof@example.test'): Promise<string> {
    const token = `otio-proof-${Math.random().toString(16).slice(2)}`;
    await store.putSession({
      tokenHash: sha256Hex(token),
      email,
      createdAt: fakeNow,
      expiresAt: fakeNow + 3600 * 1000,
    });
    return token;
  }

  return {
    origin,
    port: service.port,
    stop: async () => {
      service.stop();
    },
    createSessionToken,
  };
}

// Publish fixture via Node MCP process
async function publishFixture(
  nodePath: string,
  mcpBundle: string,
  origin: string,
  publishStatePath: string,
  fixturePath: string,
  stderrPath: string
): Promise<{ url: string; relicId: string }> {
  const child = spawn(nodePath, [mcpBundle], {
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: publishStatePath,
      RELIC_CHROME_PATH: 'none',
      RELIC_CLIENT_NAME: 'relic-mcp/otio-resource-browser',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => errChunks.push(d));

  const packet = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'relic_publish',
      arguments: {
        path: fixturePath,
        title: '',
        cover: false,
        force_new: true,
      },
    },
  })}\n`;

  child.stdin.write(packet);
  child.stdin.end();

  const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<number>();
  child.on('close', resolveExit);
  const exit = await exitPromise;

  const stderr = Buffer.concat(errChunks).toString('utf8');
  if (stderr.length > 0) {
    appendFileSync(stderrPath, `[mcp publish stderr for ${fixturePath}]\n${stderr}\n`);
  }

  assert.strictEqual(exit, 0, `Node MCP publish exited ${exit}: ${stderr}`);

  const stdout = Buffer.concat(chunks).toString('utf8');
  const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
  assert.ok(lines.length > 0, `No JSON-RPC response from relic_publish: ${stdout}`);

  const response = JSON.parse(lines[lines.length - 1] ?? '{}');
  assert.ok(!response.error, `JSON-RPC error from relic_publish: ${JSON.stringify(response.error)}`);
  const result = response.result as Record<string, unknown>;
  assert.ok(!result?.isError, `Tool error from relic_publish: ${JSON.stringify(result?.content)}`);

  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const contentArray = result.content as Array<{ text?: string }> | undefined;
  let parsedUrl = '';
  let relicId = '';

  if (typeof structured?.url === 'string') {
    parsedUrl = structured.url;
    relicId = String(structured.relic_id ?? '');
  } else if (contentArray && contentArray.length > 0 && typeof contentArray[0]?.text === 'string') {
    try {
      const parsedText = JSON.parse(contentArray[0].text);
      parsedUrl = parsedText.url ?? '';
      relicId = parsedText.relic_id ?? '';
    } catch {}
  }

  assert.ok(parsedUrl.length > 0, `Could not parse published URL from MCP response: ${stdout}`);
  return { url: parsedUrl, relicId };
}

// Browser session management
async function openBrowserSession(
  chromePath: string,
  servicePort: number,
  origin: string,
  url: string,
  sessionToken: string,
  stderrPath: string,
  attestationPath: string,
  onBindingEvent?: (payload: { type: string; count: number; timestamp: number }) => void
): Promise<ChromeSession> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-otio-res-chrome-'));
  const shared = chromeArgs(chromePath, profile);

  const launch = createBrowserHeadlessLaunch(
    [
      ...shared.map((arg) =>
        arg === '--proxy-bypass-list=<-loopback>'
          ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${servicePort}`
          : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
            ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
            : arg
      ),
      '--autoplay-policy=no-user-gesture-required',
    ],
    profile
  );

  let child: ChildProcess;
  try {
    child = spawn(chromePath, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  // Capped stderr capture
  let capturedStderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (capturedStderrBytes < MAX_STDERR_BYTES) {
      const slice = chunk.subarray(0, MAX_STDERR_BYTES - capturedStderrBytes);
      appendFileSync(stderrPath, slice);
      capturedStderrBytes += slice.length;
    }
  });

  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  assert.ok(toChrome instanceof Writable, 'Chrome fd 3 is not writable');
  assert.ok(fromChrome instanceof Readable, 'Chrome fd 4 is not readable');

  const cdp = connectPipe(toChrome, fromChrome);

  try {
    const attestation = await attestBrowserHeadless(cdp, launch);
    if (!existsSync(attestationPath)) {
      writeFileSync(attestationPath, JSON.stringify(attestation, null, 2), 'utf8');
    }

    const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);

    // Network confinement
    cdp.onEvent((event) => {
      if (event.method !== 'Fetch.requestPaused' || event.sessionId !== sessionId) return;
      const params = event.params as { requestId?: string; request?: { url?: string } };
      const reqUrl = params.request?.url ?? '';
      const reqId = params.requestId;
      if (!reqId) return;
      try {
        const parsed = new URL(reqUrl);
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
          void cdp.send('Fetch.continueRequest', { requestId: reqId }, sessionId).catch(() => {});
          return;
        }
      } catch {}
      void cdp.send('Fetch.failRequest', { requestId: reqId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    });

    // CDP Binding for held sequence decode counter
    await cdp.send('Runtime.addBinding', { name: '__otioResourceBinding' }, sessionId);
    cdp.onEvent((event) => {
      if (event.method !== 'Runtime.bindingCalled' || event.sessionId !== sessionId) return;
      const params = event.params as { name?: string; payload?: string };
      if (params.name === '__otioResourceBinding' && params.payload) {
        try {
          const parsed = JSON.parse(params.payload);
          onBindingEvent?.(parsed);
        } catch {}
      }
    });

    // Install prelude before navigation
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE_SOURCE }, sessionId);

    // Set authentication session cookie
    await cdp.send(
      'Network.setCookie',
      {
        name: 'relic_session',
        value: sessionToken,
        url: origin,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      sessionId
    );

    const loaded = cdp.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs: 25000 });
    const navigated = await cdp.send('Page.navigate', { url }, sessionId);
    assert.ok(navigated['errorText'] === undefined, `Navigation failed: ${String(navigated['errorText'])}`);
    await loaded;

    async function evaluate<T>(expression: string): Promise<T> {
      const res = await cdp.send(
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: 20000,
        },
        sessionId
      );
      const exception = res['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
      assert.ok(
        !exception,
        `Page evaluation failed: ${exception?.text ?? exception?.exception?.description ?? JSON.stringify(res)}`
      );
      return (res['result'] as { value?: T } | undefined)?.value as T;
    }

    async function screenshot(label: string): Promise<Buffer> {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)) as { data: string };
      const bytes = Buffer.from(shot.data, 'base64');
      assert.ok(bytes.length > 500, `Screenshot ${label} is empty or corrupted`);
      return bytes;
    }

    async function captureCanvasPixels(): Promise<Buffer> {
      const b64 = await evaluate<string>('window.__otioAccounting.getCanvasPixels()');
      assert.ok(b64 && b64.length > 0, 'Canvas pixel capture returned empty base64');
      return Buffer.from(b64, 'base64');
    }

    async function close(): Promise<void> {
      try {
        await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              for (const node of document.querySelectorAll('audio,video')) {
                node.pause();
                node.removeAttribute('src');
                node.load();
              }
              window.dispatchEvent(new Event('pagehide'));
            })()`,
            awaitPromise: true,
          },
          sessionId
        );
      } catch {}
      try {
        cdp.dispose();
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }

    async function terminate(): Promise<void> {
      try {
        cdp.dispose();
      } catch {}
      try {
        child.kill('SIGKILL');
      } catch {}
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }

    return {
      cdp,
      child,
      profile,
      evaluate,
      screenshot,
      captureCanvasPixels,
      close,
      terminate,
    };
  } catch (error) {
    await cleanupOwnedBrowserStartup({
      child,
      connection: cdp,
      forgetChild: undefined,
      profile,
      removeProfile: undefined,
    });
    throw error;
  }
}

// Wait for OTIO viewer to settle readiness
async function waitReady(browser: ChromeSession, timeoutMs = 25000): Promise<string> {
  const ready = await browser.evaluate<string>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const start = Date.now();
    const tick = () => {
      const root = document.querySelector('.otio-view');
      const state = root?.dataset?.ready ?? '';
      const buffering = root?.dataset?.buffering;
      if (buffering === 'false' && (state === 'true' || state === 'diagnostic')) {
        resolve(state);
      } else if (state === 'error') {
        resolve('error');
      } else if (Date.now() - start > ${timeoutMs}) {
        resolve(state || 'timeout');
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
    return promise;
  })()`);
  return ready;
}

// Seek playhead via native slider
async function seekTo(browser: ChromeSession, frame: number): Promise<void> {
  const landed = await browser.evaluate<boolean>(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const seek = document.querySelector('input.otio-seek');
    if (!seek) { resolve(false); return promise; }
    seek.value = '${frame}';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    const start = Date.now();
    const tick = () => {
      const root = document.querySelector('.otio-view');
      if (root && root.dataset.buffering === 'false' && Number(root.dataset.frame) === ${frame}) resolve(true);
      else if (Date.now() - start > 12000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
    return promise;
  })()`);
  assert.strictEqual(landed, true, `Seek to frame ${frame} did not settle on a decoded frame`);
}

// Generate R1 fixture: 50 wide black tracks
function generateR1FixtureContent(): string {
  const tracks: unknown[] = [];
  for (let i = 0; i < 50; i++) {
    tracks.push({
      OTIO_SCHEMA: 'Track.1',
      name: `Track ${i + 1}`,
      kind: 'Video',
      metadata: { relic: { id: `track-r1-${i}` } },
      children: [
        {
          OTIO_SCHEMA: 'Clip.1',
          name: `Clip ${i + 1}`,
          metadata: { relic: { id: `clip-r1-${i}` } },
          source_range: {
            OTIO_SCHEMA: 'TimeRange.1',
            start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
            duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
          },
          media_reference: {
            OTIO_SCHEMA: 'ImageSequenceReference.1',
            metadata: {},
            name: '',
            target_url_base: 'media/',
            name_prefix: 'hold_',
            name_suffix: '.png',
            start_frame: 1,
            frame_step: 1,
            rate: 24,
            frame_zero_padding: 4,
            missing_frame_policy: 'black',
            available_range: null,
          },
        },
      ],
    });
  }

  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-r1' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: {},
      children: tracks,
    },
  });
}

// Generate R2 fixtures: 61 Stacks accepted, 62 Stacks rejected
function generateR2StackChain(stackCount: number): string {
  let inner: unknown = {
    OTIO_SCHEMA: 'Clip.1',
    name: 'Bottom Clip',
    metadata: { relic: { id: 'bottom-clip' } },
    source_range: {
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
      duration: { OTIO_SCHEMA: 'RationalTime.1', value: 1, rate: 24 },
    },
    media_reference: {
      OTIO_SCHEMA: 'ImageSequenceReference.1',
      metadata: {},
      name: '',
      target_url_base: 'media/',
      name_prefix: 'hold_',
      name_suffix: '.png',
      start_frame: 1,
      frame_step: 1,
      rate: 24,
      frame_zero_padding: 4,
      missing_frame_policy: 'black',
      available_range: null,
    },
  };

  for (let i = stackCount - 1; i >= 0; i--) {
    inner = {
      OTIO_SCHEMA: 'Stack.1',
      name: `Stack ${i}`,
      metadata: { relic: { id: `stack-${i}` } },
      tracks: inner,
    };
  }
  return JSON.stringify(inner);
}

// Generate R3 layered composition fixture
function generateR3Fixture(): {
  otiozBytes: Uint8Array;
  expectedColor: { r: number; g: number; b: number; a: number };
} {
  // Base opaque blue
  const basePng = buildPng(960, 540, () => [0, 0, 200, 255]);
  // Translucent red: alpha 128
  const layer1Png = buildPng(960, 540, () => [200, 0, 0, 128]);
  // Translucent green: alpha 128
  const layer2Png = buildPng(960, 540, () => [0, 200, 0, 128]);

  // Analytic color derivation:
  // Base: (0, 0, 200)
  // + Layer 1 (200, 0, 0, a=128/255=0.50196):
  // r = 200*0.50196 = 100.39
  // g = 0
  // b = 200*(1-0.50196) = 99.61
  // + Layer 2 (0, 200, 0, a=128/255=0.50196):
  // r = 100.39*(1-0.50196) = 50.0
  // g = 200*0.50196 = 100.39
  // b = 99.61*(1-0.50196) = 49.6
  // Expected center color: ~ (50, 100, 50, 255)
  const expectedColor = { r: 50, g: 100, b: 50, a: 255 };

  const ref = (targetUrl: string) => ({
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url: targetUrl,
    available_range: {
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
      duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
    },
  });

  const otioJson = JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-r3' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Base Opaque Track',
          kind: 'Video',
          metadata: { relic: { id: 'track-r3-base' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Base Clip',
              source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
              },
              media_reference: ref('media/base.png'),
            },
          ],
        },
        {
          OTIO_SCHEMA: 'Stack.1',
          name: 'Nested Overlays',
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              name: 'Overlay Red',
              kind: 'Video',
              metadata: { relic: { id: 'track-r3-red' } },
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  name: 'Red Clip',
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                    duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
                  },
                  media_reference: ref('media/layer1.png'),
                },
              ],
            },
            {
              OTIO_SCHEMA: 'Track.1',
              name: 'Overlay Green',
              kind: 'Video',
              metadata: { relic: { id: 'track-r3-green' } },
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  name: 'Green Clip',
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                    duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
                  },
                  media_reference: ref('media/layer2.png'),
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const otiozBytes = buildOtioz(otioJson, [
    { name: 'media/base.png', data: basePng },
    { name: 'media/layer1.png', data: layer1Png },
    { name: 'media/layer2.png', data: layer2Png },
  ]);

  return { otiozBytes, expectedColor };
}

// Generate R4 SMPTE Dissolve fixture
function generateR4Fixture(): {
  otiozBytes: Uint8Array;
  colors: { bg: number[]; outgoing: number[]; incoming: number[] };
} {
  const bgPng = buildPng(960, 540, () => [40, 40, 40, 255]);
  const outPng = buildPng(960, 540, () => [220, 30, 30, 255]);
  const inPng = buildPng(960, 540, () => [30, 220, 220, 255]);

  const otioJson = JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-r4' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Lower Background Track',
          kind: 'Video',
          metadata: { relic: { id: 'track-r4-bg' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Background Clip',
              source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: 'RationalTime.1', value: 48, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/bg.png',
                available_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                  duration: { OTIO_SCHEMA: 'RationalTime.1', value: 48, rate: 24 },
                },
              },
            },
          ],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Dissolve Track',
          kind: 'Video',
          metadata: { relic: { id: 'track-r4-dissolve' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Outgoing Clip',
              source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/outgoing.png',
                available_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                  duration: { OTIO_SCHEMA: 'RationalTime.1', value: 48, rate: 24 },
                },
              },
            },
            {
              OTIO_SCHEMA: 'Transition.1',
              name: 'SMPTE Dissolve',
              transition_type: 'SMPTE_Dissolve',
              in_offset: { OTIO_SCHEMA: 'RationalTime.1', value: 6, rate: 24 },
              out_offset: { OTIO_SCHEMA: 'RationalTime.1', value: 6, rate: 24 },
            },
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Incoming Clip',
              source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/incoming.png',
                available_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                  duration: { OTIO_SCHEMA: 'RationalTime.1', value: 48, rate: 24 },
                },
              },
            },
          ],
        },
      ],
    },
  });

  const otiozBytes = buildOtioz(otioJson, [
    { name: 'media/bg.png', data: bgPng },
    { name: 'media/outgoing.png', data: outPng },
    { name: 'media/incoming.png', data: inPng },
  ]);

  return {
    otiozBytes,
    colors: {
      bg: [40, 40, 40, 255],
      outgoing: [220, 30, 30, 255],
      incoming: [30, 220, 220, 255],
    },
  };
}

// Generate R5 Hostile Held Sequences fixture
function generateR5Fixture(): Uint8Array {
  const unrelatedPng = buildPng(10, 10, () => [128, 128, 128, 255]);
  const tracks: unknown[] = [];

  for (let i = 0; i < 10; i++) {
    const prefix = `holdp00${i}_`;
    tracks.push({
      OTIO_SCHEMA: 'Track.1',
      name: `Hostile Hold Track ${i}`,
      kind: 'Video',
      metadata: { relic: { id: `track-r5-${i}` } },
      children: [
        {
          OTIO_SCHEMA: 'Clip.1',
          name: `Hostile Clip ${i}`,
          metadata: { relic: { id: `clip-r5-${i}` } },
          source_range: {
            OTIO_SCHEMA: 'TimeRange.1',
            start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
            duration: { OTIO_SCHEMA: 'RationalTime.1', value: 65532 + 24, rate: 24 },
          },
          media_reference: {
            OTIO_SCHEMA: 'ImageSequenceReference.1',
            name: '',
            target_url_base: 'media/',
            name_prefix: prefix,
            name_suffix: '.png',
            start_frame: 0,
            frame_step: 1,
            rate: 24,
            frame_zero_padding: 4,
            missing_frame_policy: 'hold',
            available_range: {
              OTIO_SCHEMA: 'TimeRange.1',
              start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
              duration: { OTIO_SCHEMA: 'RationalTime.1', value: 65532, rate: 24 },
            },
          },
        },
      ],
    });
  }

  const otioJson = JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-r5' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: tracks,
    },
  });

  return buildOtioz(otioJson, [{ name: 'media/unrelated.png', data: unrelatedPng }]);
}

// Generate R6 raw .otio fixture (empty index)
function generateR6RawOtio(): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-r6' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Raw Sequence Track',
          kind: 'Video',
          metadata: { relic: { id: 'track-r6' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Raw Sequence Clip',
              metadata: { relic: { id: 'clip-r6' } },
              source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: 'RationalTime.1', value: 30, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ImageSequenceReference.1',
                name: '',
                target_url_base: 'media/',
                name_prefix: 'hold_',
                name_suffix: '.png',
                start_frame: 10,
                frame_step: 1,
                rate: 24,
                frame_zero_padding: 4,
                missing_frame_policy: 'hold',
                available_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 10, rate: 24 },
                  duration: { OTIO_SCHEMA: 'RationalTime.1', value: 20, rate: 24 },
                },
              },
            },
          ],
        },
      ],
    },
  });
}

// Main Record Routine
async function runRecord(configPath: string, outDir: string): Promise<void> {
  assert.ok(!existsSync(outDir), `Output directory already exists: ${outDir}`);

  const { config, hashes, assetManifest } = validateConfig(configPath);

  // Create output structure
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'fixtures'), { recursive: true });
  mkdirSync(join(outDir, 'pixels'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  mkdirSync(join(outDir, 'stderr'), { recursive: true });

  const manifestPath = join(outDir, 'manifest.json');
  const assetManifestPath = join(outDir, 'asset-manifest.json');
  const attestationPath = join(outDir, 'browser-attestation.json');
  const observationsPath = join(outDir, 'observations.jsonl');
  const bindingEventsPath = join(outDir, 'binding-events.jsonl');
  const mcpStderrPath = join(outDir, 'stderr/mcp.stderr');
  const browserStderrPath = join(outDir, 'stderr/browser.stderr');
  const publishStatePath = join(outDir, 'state.json');
  const resultJsonPath = join(outDir, 'result.json');

  writeFileSync(assetManifestPath, JSON.stringify(assetManifest, null, 2), 'utf8');

  // Pre-generate fixtures and record hashes
  const fixtureHashes: Record<string, string> = {};

  const r1Bytes = buildOtioz(generateR1FixtureContent());
  const r1Path = join(outDir, 'fixtures/R1.otioz');
  writeFileSync(r1Path, r1Bytes);
  fixtureHashes['R1.otioz'] = sha256Hex(r1Bytes);

  const r2ValidBytes = buildOtioz(generateR2StackChain(61));
  const r2ValidPath = join(outDir, 'fixtures/R2.otioz');
  writeFileSync(r2ValidPath, r2ValidBytes);
  fixtureHashes['R2.otioz'] = sha256Hex(r2ValidBytes);

  const r2RejectJson = generateR2StackChain(62);
  const r2RejectPath = join(outDir, 'fixtures/R2_reject.otio');
  writeFileSync(r2RejectPath, r2RejectJson, 'utf8');
  fixtureHashes['R2_reject.otio'] = sha256Hex(r2RejectJson);

  const { otiozBytes: r3Bytes, expectedColor: r3ExpectedColor } = generateR3Fixture();
  const r3Path = join(outDir, 'fixtures/R3.otioz');
  writeFileSync(r3Path, r3Bytes);
  fixtureHashes['R3.otioz'] = sha256Hex(r3Bytes);

  const { otiozBytes: r4Bytes, colors: r4Colors } = generateR4Fixture();
  const r4Path = join(outDir, 'fixtures/R4.otioz');
  writeFileSync(r4Path, r4Bytes);
  fixtureHashes['R4.otioz'] = sha256Hex(r4Bytes);

  const r5Bytes = generateR5Fixture();
  const r5Path = join(outDir, 'fixtures/R5.otioz');
  writeFileSync(r5Path, r5Bytes);
  fixtureHashes['R5.otioz'] = sha256Hex(r5Bytes);

  const r6RawJson = generateR6RawOtio();
  const r6Path = join(outDir, 'fixtures/R6.otio');
  writeFileSync(r6Path, r6RawJson, 'utf8');
  fixtureHashes['R6.otio'] = sha256Hex(r6RawJson);

  hashes.fixtures = JSON.stringify(fixtureHashes);

  // Write running manifest before any child starts
  const manifest = {
    status: 'running',
    startedAt: new Date().toISOString(),
    label: config.label,
    productSha: config.productSha,
    productRoot: config.productRoot,
    viewerDist: config.viewerDist,
    nodePath: config.nodePath,
    mcpBundle: config.mcpBundle,
    chromePath: config.chromePath,
    hashes: {
      ...hashes,
      fixtureFiles: fixtureHashes,
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Start loopback server
  const loopbackStderrPath = join(outDir, 'stderr/loopback.stderr');
  const server = await startLoopbackServer(config.viewerDist, loopbackStderrPath);
  const sessionToken = await server.createSessionToken();

  function logObservation(record: Record<string, unknown>) {
    appendFileSync(observationsPath, `${JSON.stringify({ ...record, timestamp: Date.now() })}\n`, 'utf8');
  }

  const caseResults: Record<string, unknown> = {};

  try {
    // --- R1: Fifty wide black tracks ---
    try {
      const pubR1 = await publishFixture(
        config.nodePath,
        config.mcpBundle,
        server.origin,
        publishStatePath,
        r1Path,
        mcpStderrPath
      );
      const browserR1 = await openBrowserSession(
        config.chromePath,
        server.port,
        server.origin,
        pubR1.url,
        sessionToken,
        browserStderrPath,
        attestationPath
      );

      const readyR1 = await waitReady(browserR1);
      assert.ok(
        readyR1 === 'true' || readyR1 === 'structural' || readyR1 === 'diagnostic',
        `R1 never settled: ${readyR1}`
      );

      const stats1 = await browserR1.evaluate<CanvasStats>('window.__otioAccounting.getCanvasStats()');
      const trackRowsCount = await browserR1.evaluate<number>(
        "document.querySelectorAll('.otio-track-row:not(.otio-composition-row)').length"
      );
      const diagnostics1 = await browserR1.evaluate<string[]>(
        "Array.from(document.querySelectorAll('.otio-diagnostics .otio-diagnostic')).map(e => e.textContent || '')"
      );

      const pixels1 = await browserR1.captureCanvasPixels();
      const pixels1Sha = sha256Hex(pixels1);
      writeFileSync(join(outDir, 'pixels/R1_settled.rgba'), pixels1);
      const shot1 = await browserR1.screenshot('R1_settled');
      writeFileSync(join(outDir, 'screenshots/R1_settled.png'), shot1);

      // Verify canvas is opaque black
      let allBlack = true;
      for (let p = 0; p < pixels1.length; p += 4) {
        if (pixels1[p] !== 0 || pixels1[p + 1] !== 0 || pixels1[p + 2] !== 0 || pixels1[p + 3] !== 255) {
          allBlack = false;
          break;
        }
      }

      logObservation({
        case: 'R1',
        step: 'settled',
        creations: stats1.creations,
        offscreenCreated: stats1.offscreenCreated,
        finalOffscreenPixels: stats1.currentOffscreenPixels,
        leafFills: stats1.lastPaint?.leafFills ?? 0,
        trackRows: trackRowsCount,
        diagnostics: diagnostics1,
        isOpaqueBlack: allBlack,
        pixelsSha256: pixels1Sha,
      });

      // Second seek to frame 0
      await seekTo(browserR1, 0);
      const stats1Seek = await browserR1.evaluate<CanvasStats>('window.__otioAccounting.getCanvasStats()');
      const pixels1Seek = await browserR1.captureCanvasPixels();
      const pixels1SeekSha = sha256Hex(pixels1Seek);
      writeFileSync(join(outDir, 'pixels/R1_seek2.rgba'), pixels1Seek);

      logObservation({
        case: 'R1',
        step: 'seek2',
        additionalCreations: stats1Seek.creations - stats1.creations,
        leafFills: stats1Seek.lastPaint?.leafFills ?? 0,
        pixelsMatch: pixels1Sha === pixels1SeekSha,
        pixelsSha256: pixels1SeekSha,
      });

      // Disposal accounting
      const beforeDispose = await browserR1.evaluate<DisposalEvidence['before']>(
        'window.__otioAccounting.captureBeforeDispose()'
      );
      await browserR1.evaluate("window.dispatchEvent(new Event('pagehide'))");
      const afterDispose = await browserR1.evaluate<DisposalEvidence['after']>(
        'window.__otioAccounting.captureAfterDispose()'
      );

      await browserR1.close();

      logObservation({
        case: 'R1',
        step: 'disposal',
        before: beforeDispose,
        after: afterDispose,
      });

      caseResults.R1 = {
        status: 'pass',
        creations: stats1.creations,
        offscreenCreated: stats1.offscreenCreated,
        finalOffscreenPixels: stats1.currentOffscreenPixels,
        leafFills: stats1.lastPaint?.leafFills ?? 0,
        afterDisposePixels: afterDispose.currentOffscreenPixels,
      };
    } catch (err) {
      caseResults.R1 = { status: 'fail', error: (err as Error).message };
      logObservation({ case: 'R1', error: (err as Error).message });
    }

    // --- R2: Maximum-depth witness ---
    try {
      // 1. Test 62 stacks nesting limit rejection (> 64 JSON depth)
      let rejectPassed = false;
      let rejectError = '';
      try {
        // Runtime-selected productRoot format package: exercises parser at configured productRoot
        const formatMod = await import(join(config.productRoot, 'packages/relic-format/src/index.ts'));
        formatMod.parseOtioJson(r2RejectJson);
      } catch (e) {
        rejectPassed = true;
        rejectError = (e as Error).message;
      }
      assert.ok(rejectPassed, 'R2 62-stack nesting limit was not rejected by parser');

      logObservation({
        case: 'R2',
        step: 'reject',
        rejected: rejectPassed,
        error: rejectError,
      });

      // 2. Test 61 stacks accepted
      const pubR2 = await publishFixture(
        config.nodePath,
        config.mcpBundle,
        server.origin,
        publishStatePath,
        r2ValidPath,
        mcpStderrPath
      );
      const browserR2 = await openBrowserSession(
        config.chromePath,
        server.port,
        server.origin,
        pubR2.url,
        sessionToken,
        browserStderrPath,
        attestationPath
      );

      const readyR2 = await waitReady(browserR2);
      assert.ok(readyR2 === 'true' || readyR2 === 'structural', `R2 never settled: ${readyR2}`);

      const stats2 = await browserR2.evaluate<CanvasStats>('window.__otioAccounting.getCanvasStats()');
      const pixels2 = await browserR2.captureCanvasPixels();
      writeFileSync(join(outDir, 'pixels/R2_settled.rgba'), pixels2);
      const shot2 = await browserR2.screenshot('R2_settled');
      writeFileSync(join(outDir, 'screenshots/R2_settled.png'), shot2);

      const beforeDispose2 = await browserR2.evaluate<DisposalEvidence['before']>(
        'window.__otioAccounting.captureBeforeDispose()'
      );
      await browserR2.evaluate("window.dispatchEvent(new Event('pagehide'))");
      const afterDispose2 = await browserR2.evaluate<DisposalEvidence['after']>(
        'window.__otioAccounting.captureAfterDispose()'
      );

      await browserR2.close();

      logObservation({
        case: 'R2',
        step: 'settled',
        offscreenCreated: stats2.offscreenCreated,
        finalOffscreenPixels: stats2.currentOffscreenPixels,
        beforeDispose: beforeDispose2,
        afterDispose: afterDispose2,
      });

      caseResults.R2 = {
        status: 'pass',
        nestingLimitRejection: rejectPassed,
        offscreenCreated: stats2.offscreenCreated,
        finalOffscreenPixels: stats2.currentOffscreenPixels,
        afterDisposePixels: afterDispose2.currentOffscreenPixels,
      };
    } catch (err) {
      caseResults.R2 = { status: 'fail', error: (err as Error).message };
      logObservation({ case: 'R2', error: (err as Error).message });
    }

    // --- R3: Legitimate layered & nested composition ---
    try {
      const pubR3 = await publishFixture(
        config.nodePath,
        config.mcpBundle,
        server.origin,
        publishStatePath,
        r3Path,
        mcpStderrPath
      );
      const browserR3 = await openBrowserSession(
        config.chromePath,
        server.port,
        server.origin,
        pubR3.url,
        sessionToken,
        browserStderrPath,
        attestationPath
      );

      const readyR3 = await waitReady(browserR3);
      assert.ok(readyR3 === 'true' || readyR3 === 'diagnostic', `R3 never settled: ${readyR3}`);

      const trackRows3 = await browserR3.evaluate<number>(
        "document.querySelectorAll('.otio-track-row:not(.otio-composition-row)').length"
      );
      const diag3 = await browserR3.evaluate<string[]>(
        "Array.from(document.querySelectorAll('.otio-diagnostics .otio-diagnostic')).map(e => e.textContent || '')"
      );

      const pixels3 = await browserR3.captureCanvasPixels();
      const pixels3Sha = sha256Hex(pixels3);
      writeFileSync(join(outDir, 'pixels/R3_settled.rgba'), pixels3);
      const shot3 = await browserR3.screenshot('R3_settled');
      writeFileSync(join(outDir, 'screenshots/R3_settled.png'), shot3);

      // Sample center pixel (480, 270)
      const centerPixel = await browserR3.evaluate<[number, number, number, number]>(
        'window.__otioAccounting.samplePixel(480, 270)'
      );

      // Analytic color verification (+/- 4 rounding margin)
      const rDiff = Math.abs(centerPixel[0] - r3ExpectedColor.r);
      const gDiff = Math.abs(centerPixel[1] - r3ExpectedColor.g);
      const bDiff = Math.abs(centerPixel[2] - r3ExpectedColor.b);
      const analyticPassed = rDiff <= 4 && gDiff <= 4 && bDiff <= 4 && centerPixel[3] === 255;

      await browserR3.close();

      logObservation({
        case: 'R3',
        step: 'settled',
        trackRows: trackRows3,
        diagnostics: diag3,
        centerPixel,
        expectedColor: r3ExpectedColor,
        analyticPassed,
        pixelsSha256: pixels3Sha,
      });

      caseResults.R3 = {
        status: analyticPassed ? 'pass' : 'fail',
        trackRows: trackRows3,
        centerPixel,
        analyticPassed,
        pixelsSha256: pixels3Sha,
      };
    } catch (err) {
      caseResults.R3 = { status: 'fail', error: (err as Error).message };
      logObservation({ case: 'R3', error: (err as Error).message });
    }

    // --- R4: Legitimate SMPTE dissolve ---
    try {
      const pubR4 = await publishFixture(
        config.nodePath,
        config.mcpBundle,
        server.origin,
        publishStatePath,
        r4Path,
        mcpStderrPath
      );
      const browserR4 = await openBrowserSession(
        config.chromePath,
        server.port,
        server.origin,
        pubR4.url,
        sessionToken,
        browserStderrPath,
        attestationPath
      );

      const readyR4 = await waitReady(browserR4);
      assert.ok(readyR4 === 'true' || readyR4 === 'diagnostic', `R4 never settled: ${readyR4}`);

      const frameResults: Record<number, { pixelsSha256: string; draws: number; centerPixel: number[] }> = {};

      for (const frame of [18, 24, 30]) {
        await seekTo(browserR4, frame);
        const stats = await browserR4.evaluate<CanvasStats>('window.__otioAccounting.getCanvasStats()');
        const px = await browserR4.captureCanvasPixels();
        const pxSha = sha256Hex(px);
        writeFileSync(join(outDir, `pixels/R4_frame_${frame}.rgba`), px);
        const shot = await browserR4.screenshot(`R4_frame_${frame}`);
        writeFileSync(join(outDir, `screenshots/R4_frame_${frame}.png`), shot);

        const center = await browserR4.evaluate<[number, number, number, number]>(
          'window.__otioAccounting.samplePixel(480, 270)'
        );

        frameResults[frame] = {
          pixelsSha256: pxSha,
          draws: stats.lastPaint?.draws ?? 0,
          centerPixel: center,
        };

        logObservation({
          case: 'R4',
          step: `frame_${frame}`,
          frame,
          draws: stats.lastPaint?.draws ?? 0,
          centerPixel: center,
          pixelsSha256: pxSha,
        });
      }

      await browserR4.close();

      caseResults.R4 = {
        status: 'pass',
        frames: frameResults,
      };
    } catch (err) {
      caseResults.R4 = { status: 'fail', error: (err as Error).message };
      logObservation({ case: 'R4', error: (err as Error).message });
    }

    // --- R5: Hostile held sequences ---
    try {
      const pubR5 = await publishFixture(
        config.nodePath,
        config.mcpBundle,
        server.origin,
        publishStatePath,
        r5Path,
        mcpStderrPath
      );

      let budgetViolationObserved = false;
      let observedWork = 0;

      const browserR5 = await openBrowserSession(
        config.chromePath,
        server.port,
        server.origin,
        pubR5.url,
        sessionToken,
        browserStderrPath,
        attestationPath,
        (binding) => {
          appendFileSync(
            bindingEventsPath,
            `${JSON.stringify({ case: 'R5', event: binding.type, count: binding.count, timestamp: binding.timestamp })}\n`
          );
          if (binding.type === 'decode-count') {
            observedWork = binding.count;
            if (binding.count > 65532 && config.label === 'baseline') {
              budgetViolationObserved = true;
            }
          }
        }
      );

      if (config.label === 'baseline') {
        // Baseline: observe > 65532 calls, then terminate
        const startWait = Date.now();
        while (Date.now() - startWait < 30000) {
          if (budgetViolationObserved) break;
          await Bun.sleep(100);
        }

        await browserR5.terminate();

        assert.ok(
          budgetViolationObserved,
          `Baseline did not trigger budget violation > 65532 calls (observed: ${observedWork})`
        );

        logObservation({
          case: 'R5',
          step: 'execution',
          outcome: 'terminated-after-observed-budget-violation',
          observedWork,
          budgetLimit: 65532,
        });

        caseResults.R5 = {
          status: 'pass',
          outcome: 'terminated-after-observed-budget-violation',
          observedWork,
        };
      } else {
        // Candidate: settles with diagnostic, exactly 65532 calls across mount
        const readyR5 = await waitReady(browserR5, 30000);
        assert.strictEqual(readyR5, 'diagnostic', `Candidate R5 did not settle as diagnostic: ${readyR5}`);

        const finalDecodeCount = await browserR5.evaluate<number>('window.__otioAccounting.getDecodeCount()');
        assert.strictEqual(
          finalDecodeCount,
          65532,
          `Candidate R5 decode count mismatch: expected 65532, got ${finalDecodeCount}`
        );
        const trackRows5 = await browserR5.evaluate<number>(
          "document.querySelectorAll('.otio-track-row:not(.otio-composition-row)').length"
        );
        assert.strictEqual(trackRows5, 10, `Candidate R5 track rows mismatch: expected 10, got ${trackRows5}`);

        const diagnostics5 = await browserR5.evaluate<string[]>(
          "Array.from(document.querySelectorAll('.otio-diagnostics .otio-diagnostic')).map(e => e.textContent || '')"
        );

        // Check 9 tracks carry budget-refusal warning
        const budgetRefusals = diagnostics5.filter((d) => d.includes('held sequences exceed 65532 images'));
        assert.strictEqual(
          budgetRefusals.length,
          9,
          `Candidate R5 budget refusal count mismatch: expected 9, got ${budgetRefusals.length}`
        );

        // Seeks add 0 matching calls
        await seekTo(browserR5, 0);
        const decodeAfterSeek1 = await browserR5.evaluate<number>('window.__otioAccounting.getDecodeCount()');
        await seekTo(browserR5, 0);
        const decodeAfterSeek2 = await browserR5.evaluate<number>('window.__otioAccounting.getDecodeCount()');
        assert.strictEqual(
          decodeAfterSeek2,
          65532,
          `Candidate seeks added unexpected decode calls: ${decodeAfterSeek2} > 65532`
        );

        await browserR5.close();

        logObservation({
          case: 'R5',
          step: 'execution',
          outcome: 'settled',
          observedWork: finalDecodeCount,
          trackRows: trackRows5,
          diagnostics: diagnostics5,
          budgetRefusalWarnings: budgetRefusals.length,
          seekCallsAdded: decodeAfterSeek2 - finalDecodeCount,
        });

        caseResults.R5 = {
          status: 'pass',
          outcome: 'settled',
          observedWork: finalDecodeCount,
          trackRows: trackRows5,
          budgetRefusalWarnings: budgetRefusals.length,
        };
      }
    } catch (err) {
      caseResults.R5 = { status: 'fail', error: (err as Error).message };
      logObservation({ case: 'R5', error: (err as Error).message });
    }

    // --- R6: Raw empty-index semantic control ---
    try {
      // 1. Browser check
      const pubR6 = await publishFixture(
        config.nodePath,
        config.mcpBundle,
        server.origin,
        publishStatePath,
        r6Path,
        mcpStderrPath
      );
      const browserR6 = await openBrowserSession(
        config.chromePath,
        server.port,
        server.origin,
        pubR6.url,
        sessionToken,
        browserStderrPath,
        attestationPath
      );

      const readyR6 = await waitReady(browserR6);
      assert.strictEqual(readyR6, 'diagnostic', `R6 did not settle as diagnostic: ${readyR6}`);

      const trackRows6 = await browserR6.evaluate<number>(
        "document.querySelectorAll('.otio-track-row:not(.otio-composition-row)').length"
      );
      const diagnostics6 = await browserR6.evaluate<string[]>(
        "Array.from(document.querySelectorAll('.otio-diagnostics .otio-diagnostic')).map(e => e.textContent || '')"
      );

      // Check missing media present, no budget exhaustion
      const hasMissing = diagnostics6.some(
        (d) =>
          d.toLowerCase().includes('missing-media') ||
          d.toLowerCase().includes('missing-handles') ||
          d.toLowerCase().includes('outside available media')
      );
      const hasBudgetExhaustion = diagnostics6.some((d) => d.includes('exceed 65532'));
      assert.ok(hasMissing, 'R6 did not report missing media/handles');
      assert.ok(!hasBudgetExhaustion, 'R6 unexpectedly reported budget exhaustion');

      await browserR6.close();

      logObservation({
        case: 'R6',
        step: 'browser',
        ready: readyR6,
        trackRows: trackRows6,
        diagnostics: diagnostics6,
      });

      // 2. Evaluator check via dynamic import
      // Runtime-selected productRoot format package: exercises evaluator at configured productRoot
      const formatMod = await import(join(config.productRoot, 'packages/relic-format/src/index.ts'));
      const doc = formatMod.readOtioDocument(r6RawJson, { mediaIndex: {} });
      const evaluated = formatMod.evaluateOtioAt(doc, 'timeline-r6', { value: 0, rate: 24 });
      const contrib = evaluated.video_contributions[0];
      logObservation({
        case: 'R6',
        step: 'evaluator',
        bundle_path: contrib?.bundle_path ?? null,
        sample_kind: contrib?.sample_kind ?? null,
        diagnostics: contrib?.diagnostics ?? [],
      });

      caseResults.R6 = {
        status: 'pass',
        browser: { ready: readyR6, trackRows: trackRows6, diagnostics: diagnostics6 },
        evaluator: {
          bundle_path: contrib?.bundle_path ?? null,
          sample_kind: contrib?.sample_kind ?? null,
          diagnostics: contrib?.diagnostics ?? [],
        },
      };
    } catch (err) {
      caseResults.R6 = { status: 'fail', error: (err as Error).message };
      logObservation({ case: 'R6', error: (err as Error).message });
    }
  } finally {
    await server.stop();
  }

  // Write final result.json and manifest
  const finalResult = {
    label: config.label,
    productSha: config.productSha,
    cases: caseResults,
  };
  writeFileSync(resultJsonPath, JSON.stringify(finalResult, null, 2), 'utf8');
  const failedCases = Object.entries(caseResults).filter(
    ([, res]) => (res as { status?: string }).status === 'fail'
  );

  if (failedCases.length > 0) {
    manifest.status = 'failed';
    (manifest as Record<string, unknown>).finishedAt = new Date().toISOString();
    (manifest as Record<string, unknown>).resultsSummary = caseResults;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const errorDetails = failedCases
      .map(([k, v]) => `${k}: ${(v as { error?: string }).error ?? 'unknown error'}`)
      .join('; ');
    console.error(`RECORD_FAILED: ${config.label} encountered execution errors: ${errorDetails}`);
    process.exit(1);
  }

  manifest.status = 'completed';
  (manifest as Record<string, unknown>).finishedAt = new Date().toISOString();
  (manifest as Record<string, unknown>).resultsSummary = caseResults;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`RECORD_OK: ${config.label} results recorded to ${outDir}`);
}

// Compare Routine
async function runCompare(
  baselineDir: string,
  candidateDir: string,
  selfTestSubstitution = false
): Promise<void> {
  assert.ok(isAbsolute(baselineDir), `baseline dir must be absolute: ${baselineDir}`);
  assert.ok(existsSync(baselineDir), `baseline dir does not exist: ${baselineDir}`);
  assert.ok(isAbsolute(candidateDir), `candidate dir must be absolute: ${candidateDir}`);
  assert.ok(existsSync(candidateDir), `candidate dir does not exist: ${candidateDir}`);

  // In self-test substitution mode, we test baseline against baseline (pretending it is candidate)
  // and assert that compare fails!
  if (selfTestSubstitution) {
    let failedAsExpected = false;
    try {
      await executeCompareChecks(baselineDir, baselineDir);
    } catch {
      failedAsExpected = true;
    }
    assert.ok(
      failedAsExpected,
      'Self-test substitution falsifier FAILED: comparison did not reject baseline substituted as candidate'
    );
    console.log('SELF_TEST_SUBSTITUTION_OK: compare correctly rejected baseline observations substituted as candidate');
    return;
  }

  await executeCompareChecks(baselineDir, candidateDir);
  console.log('COMPARE_OK: All OTIO resource repair proofs verified');
}

async function executeCompareChecks(baselineDir: string, candidateDir: string): Promise<void> {
  const baseManifest = JSON.parse(readFileSync(join(baselineDir, 'manifest.json'), 'utf8'));
  const candManifest = JSON.parse(readFileSync(join(candidateDir, 'manifest.json'), 'utf8'));

  // Reject differing fixture hashes
  assert.deepStrictEqual(
    baseManifest.hashes.fixtureFiles,
    candManifest.hashes.fixtureFiles,
    'Fixture bytes mismatch between baseline and candidate'
  );

  // Reject differing browser executable
  assert.strictEqual(
    baseManifest.hashes.chrome,
    candManifest.hashes.chrome,
    'Chrome executable hash mismatch between baseline and candidate'
  );

  // Read observations
  function readObservations(dir: string): Record<string, Array<Record<string, unknown>>> {
    const lines = readFileSync(join(dir, 'observations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const item of lines) {
      const c = String(item.case);
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(item);
    }
    return grouped;
  }

  const baseObs = readObservations(baselineDir);
  const candObs = readObservations(candidateDir);

  // --- R1 Checks ---
  const r1BaseSettled = baseObs.R1?.find((o) => o.step === 'settled');
  const r1CandSettled = candObs.R1?.find((o) => o.step === 'settled');
  const r1CandSeek2 = candObs.R1?.find((o) => o.step === 'seek2');
  const r1BaseDisposal = baseObs.R1?.find((o) => o.step === 'disposal');
  const r1CandDisposal = candObs.R1?.find((o) => o.step === 'disposal');

  assert.ok(r1BaseSettled && r1CandSettled, 'R1 settled observations missing');
  // Baseline creates 101 offscreen canvases; Candidate creates 3
  assert.strictEqual(r1BaseSettled.offscreenCreated, 101, `R1 baseline offscreen canvases created: ${r1BaseSettled.offscreenCreated} != 101`);
  assert.strictEqual(r1CandSettled.offscreenCreated, 3, `R1 candidate offscreen canvases created: ${r1CandSettled.offscreenCreated} != 3`);
  assert.strictEqual(r1BaseSettled.finalOffscreenPixels, 52358400, 'R1 baseline final pixels != 52358400');
  assert.strictEqual(r1CandSettled.finalOffscreenPixels, 1555200, 'R1 candidate final pixels != 1555200');
  assert.strictEqual(r1BaseSettled.leafFills, 50, 'R1 baseline leaf fills != 50');
  assert.strictEqual(r1CandSettled.leafFills, 50, 'R1 candidate leaf fills != 50');
  assert.strictEqual(r1CandSettled.trackRows, 50, 'R1 track rows != 50');
  // Pixel equality: identical opaque black
  assert.strictEqual(r1BaseSettled.pixelsSha256, r1CandSettled.pixelsSha256, 'R1 pixel mismatch between baseline and candidate');

  // Candidate second seek: 0 additional canvases
  assert.ok(r1CandSeek2, 'R1 candidate seek2 observation missing');
  assert.strictEqual(r1CandSeek2.additionalCreations, 0, 'R1 candidate created additional canvases on seek');
  assert.strictEqual(r1CandSeek2.leafFills, 50, 'R1 candidate leaf fills on seek != 50');
  assert.strictEqual(r1CandSeek2.pixelsMatch, true, 'R1 candidate pixels changed on same-frame seek');

  // Candidate disposal: zeroes all 3 offscreen composition canvases
  assert.ok(r1CandDisposal, 'R1 candidate disposal observation missing');
  const afterDisposeCand = r1CandDisposal.after as DisposalEvidence['after'];
  assert.strictEqual(afterDisposeCand.currentOffscreenPixels, 0, 'R1 candidate did not zero offscreen pixels on pagehide');
  // Baseline retains nonzero surface dimensions
  assert.ok(r1BaseDisposal, 'R1 baseline disposal observation missing');
  const afterDisposeBase = r1BaseDisposal.after as DisposalEvidence['after'];
  assert.ok(afterDisposeBase.currentOffscreenPixels > 0, 'R1 baseline unexpectedly zeroed offscreen pixels');

  // --- R2 Checks ---
  const r2CandReject = candObs.R2?.find((o) => o.step === 'reject');
  const r2CandSettled = candObs.R2?.find((o) => o.step === 'settled');
  assert.ok(r2CandReject?.rejected, 'R2 62-stack nesting limit was not rejected');
  assert.ok(r2CandSettled, 'R2 candidate settled observation missing');
  assert.strictEqual(r2CandSettled.offscreenCreated, 62, 'R2 candidate offscreen canvases != 62');
  assert.strictEqual(r2CandSettled.finalOffscreenPixels, 32140800, 'R2 candidate offscreen pixels != 32140800');
  const r2AfterDispose = r2CandSettled.afterDispose as DisposalEvidence['after'];
  assert.strictEqual(r2AfterDispose.currentOffscreenPixels, 0, 'R2 candidate dispose did not zero 62 surfaces');

  // --- R3 Checks ---
  const r3Base = baseObs.R3?.find((o) => o.step === 'settled');
  const r3Cand = candObs.R3?.find((o) => o.step === 'settled');
  assert.ok(r3Base && r3Cand, 'R3 observations missing');
  assert.strictEqual(r3Base.pixelsSha256, r3Cand.pixelsSha256, 'R3 pixel mismatch: differing bytes between baseline and candidate');
  assert.strictEqual(r3Cand.analyticPassed, true, 'R3 analytic color check failed');
  assert.strictEqual(r3Cand.trackRows, 3, 'R3 track rows != 3');

  // --- R4 Checks ---
  for (const frame of [18, 24, 30]) {
    const fBase = baseObs.R4?.find((o) => o.step === `frame_${frame}`);
    const fCand = candObs.R4?.find((o) => o.step === `frame_${frame}`);
    assert.ok(fBase && fCand, `R4 frame ${frame} observation missing`);
    assert.strictEqual(fBase.pixelsSha256, fCand.pixelsSha256, `R4 frame ${frame} pixel mismatch`);
    if (frame === 24) {
      assert.ok((fCand.draws as number) >= 2, 'R4 midpoint did not observe both transition branch draws');
    }
  }

  // --- R5 Checks ---
  const r5Base = baseObs.R5?.find((o) => o.step === 'execution');
  const r5Cand = candObs.R5?.find((o) => o.step === 'execution');
  assert.ok(r5Base && r5Cand, 'R5 observations missing');
  assert.strictEqual(
    r5Base.outcome,
    'terminated-after-observed-budget-violation',
    'R5 baseline was not terminated on budget violation'
  );
  assert.ok((r5Base.observedWork as number) > 65532, 'R5 baseline observed work <= 65532');
  assert.strictEqual(r5Cand.outcome, 'settled', 'R5 candidate did not settle');
  assert.strictEqual(r5Cand.observedWork, 65532, 'R5 candidate observed work != 65532');
  assert.strictEqual(r5Cand.trackRows, 10, 'R5 candidate track rows != 10');
  assert.strictEqual(r5Cand.budgetRefusalWarnings, 9, 'R5 candidate budget refusal warnings != 9');
  assert.strictEqual(r5Cand.seekCallsAdded, 0, 'R5 candidate seeks added non-zero calls');

  // --- R6 Checks ---
  const r6BaseBrowser = baseObs.R6?.find((o) => o.step === 'browser');
  const r6CandBrowser = candObs.R6?.find((o) => o.step === 'browser');
  const r6BaseEval = baseObs.R6?.find((o) => o.step === 'evaluator');
  const r6CandEval = candObs.R6?.find((o) => o.step === 'evaluator');
  assert.ok(r6BaseBrowser && r6CandBrowser && r6BaseEval && r6CandEval, 'R6 observations missing');
  assert.strictEqual(r6BaseBrowser.ready, 'diagnostic', 'R6 baseline not diagnostic');
  assert.strictEqual(r6CandBrowser.ready, 'diagnostic', 'R6 candidate not diagnostic');
  assert.deepStrictEqual(r6BaseEval, r6CandEval, 'R6 evaluator output mismatch between baseline and candidate');
}

// CLI Entrypoint
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'record') {
    let configPath = '';
    let outDir = '';

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--config' && i + 1 < args.length) {
        configPath = resolve(args[++i] ?? '');
      } else if (args[i] === '--out' && i + 1 < args.length) {
        outDir = resolve(args[++i] ?? '');
      }
    }

    if (!configPath || !outDir) {
      console.error('Usage: otio-resource-browser.ts record --config <config.json> --out <outDir>');
      process.exit(1);
    }

    await runRecord(configPath, outDir);
  } else if (command === 'compare') {
    let baselineDir = '';
    let candidateDir = '';
    let selfTestSubstitution = false;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--baseline' && i + 1 < args.length) {
        baselineDir = resolve(args[++i] ?? '');
      } else if (args[i] === '--candidate' && i + 1 < args.length) {
        candidateDir = resolve(args[++i] ?? '');
      } else if (args[i] === '--self-test-substitution') {
        selfTestSubstitution = true;
      }
    }

    if (!baselineDir || !candidateDir) {
      console.error('Usage: otio-resource-browser.ts compare --baseline <dir> --candidate <dir> [--self-test-substitution]');
      process.exit(1);
    }

    await runCompare(baselineDir, candidateDir, selfTestSubstitution);
  } else {
    console.error('Unknown command. Available commands: record, compare');
    process.exit(1);
  }
}

if (import.meta.main) {
  void main().catch((err) => {
    console.error(`FATAL: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
