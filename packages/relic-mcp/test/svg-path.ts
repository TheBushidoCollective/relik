/**
 * An SVG published as a relic renders in the sandboxed frame, and the script
 * inside it can reach nothing. Runs against the built viewer, the MCP bundle,
 * and loopback services, in an isolated headless browser:
 *
 *   mise exec -- bun run --cwd packages/relic-viewer build
 *   mise exec -- bun run --cwd packages/relic-mcp build
 *   RELIC_CHROME_PATH=<isolated headless shell> \
 *     mise exec -- bun packages/relic-mcp/test/svg-path.ts
 *
 * The positive run publishes an SVG whose script reads the parent, the cookie
 * and storage, fetches an external URL and the service, opens a popup, and
 * navigates the top window. Each attempt records what the sandbox returned.
 * The drawing must show in the frame, and every attempt must be refused.
 *
 * The negative control serves a throwaway copy of the viewer whose frame
 * grants allow-same-origin and allow-top-navigation. The isolation assertions
 * must fail there, or the positive run proves nothing.
 *
 * Request interception is a harness aid: it sees what leaves the page. The
 * script's own recorded errors and the console's CSP refusals show what the
 * sandbox refused. The shim is served by the production app, so its headers
 * are the production policy. Both origins are loopback, so the frame is
 * same-site with the viewer and process isolation is not exercised here.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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

interface AppLike {
  fetch(request: Request): Response | Promise<Response>;
}
type Json = Record<string, unknown>;
interface Seen {
  readonly server: 'service' | 'usercontent';
  readonly path: string;
  readonly origin: string | null;
}
interface FrameNode {
  readonly frame: { readonly id: string; readonly url: string };
  readonly childFrames?: readonly FrameNode[];
}
interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Buffer;
}
interface PageHandle {
  readonly target: string;
  readonly mainNavigations: string[];
  readonly logs: string[];
  readonly worlds: Map<string, number>;
  send(method: string, params?: Json): Promise<Json>;
  evaluate<T>(expression: string): Promise<T>;
}
interface BrowserHandle {
  readonly popups: string[];
  readonly externalPaused: string[];
  open(url: string, token: string): Promise<PageHandle>;
  targetUrl(target: string): Promise<string>;
  close(): Promise<void>;
}
interface RunEvidence {
  readonly probe: Json;
  readonly popupProbe: Json;
  readonly sandbox: string | null;
  readonly frameSrc: string | null;
  readonly navigationsBefore: number;
  readonly navigationsAfter: number;
  readonly topUrl: string;
  readonly popups: number;
  readonly serviceHits: number;
  readonly serviceNullOrigin: number;
  readonly externalPaused: number;
  readonly cspRefusals: number;
  readonly pixels: { readonly red: number; readonly blue: number } | undefined;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist = join(root, 'packages/relic-viewer/dist');
const bundle = join(root, 'packages/relic-mcp/dist/relic-mcp.js');
const scratch = await mkdtemp(join(tmpdir(), 'relic-svg-path-'));
const statePath = join(scratch, 'state.json');
const EXTERNAL = 'https://collector.relic-proof.invalid';
const SERVICE_PROBE_PATH = '/svg-probe-service-fetch';
const SHIM_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  'img-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "webrtc 'block'",
];

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const seen: Seen[] = [];
const checks: Array<{ label: string; ok: boolean }> = [];
let activeApp: AppLike | undefined;

function check(label: string, ok: boolean, evidence: string): void {
  checks.push({ label, ok });
  console.log(`${ok ? 'PROVEN' : 'NOT_PROVEN'} ${label} | ${evidence}`);
}

async function handle(
  server: Seen['server'],
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  seen.push({
    server,
    path: url.pathname,
    origin: request.headers.get('origin'),
  });
  const app = activeApp;
  if (app === undefined) return new Response('Not ready', { status: 503 });
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const id = url.pathname.slice('/__storage/upload/'.length);
    storage.put(id, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const bytes = await storage.read(
      url.pathname.slice('/__storage/o/'.length)
    );
    return bytes === undefined
      ? new Response('Not found', { status: 404 })
      : new Response(Buffer.from(bytes), {
          headers: { 'content-type': 'application/octet-stream' },
        });
  }
  if (url.pathname === SERVICE_PROBE_PATH) {
    return new Response('reached', { status: 200 });
  }
  return app.fetch(request);
}

const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => handle('service', request),
});
const usercontent = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => handle('usercontent', request),
});
const origin = `http://127.0.0.1:${service.port}`;
const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

function appFor(dist: string): AppLike {
  return createApp({
    config: { serviceOrigin: origin, usercontentOrigin },
    store,
    storage,
    assets: diskAssets(dist),
    now: () => Date.now(),
    operatorTokens,
    mailer: { send: async () => {}, sendMail: async () => {} },
  });
}

// The SVG under test. The script records its attempts in the frame's own DOM,
// because the harness cannot read a sandboxed frame's JavaScript globals. The
// top-window navigation waits 1.5 s after the results are written, so they
// are read before any navigation can unload the frame.
function svgSource(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
  <rect id="red" x="20" y="20" width="200" height="280" fill="#e53935"/>
  <circle id="blue" cx="340" cy="160" r="100" fill="#1e88e5"/>
  <image href="${EXTERNAL}/pixel.png" x="0" y="0" width="1" height="1"/>
  <script>
    (() => {
      const probe = { origin: String(window.origin) };
      const read = (name, run) => {
        try { probe[name] = 'read:' + String(run()); }
        catch (error) { probe[name] = 'threw:' + (error && error.name); }
      };
      read('parentLocation', () => window.parent.location.href);
      read('topDocument', () => window.top.document.title);
      read('cookie', () => document.cookie);
      read('localStorage', () => window.localStorage.getItem('relic-probe'));
      const settle = (name, promise) => promise.then(
        () => { probe[name] = 'reached'; },
        (error) => { probe[name] = 'blocked:' + (error && error.name); });
      Promise.all([
        settle('externalFetch', fetch('${EXTERNAL}/beacon?from=svg')),
        settle('serviceFetch', fetch('${origin}${SERVICE_PROBE_PATH}')),
      ]).then(() => {
        document.documentElement.setAttribute('data-svg-probe', JSON.stringify(probe));
        probe.popup = window.open('${EXTERNAL}/popup?from=svg') === null ? 'null' : 'object';
        document.documentElement.setAttribute('data-svg-popup', JSON.stringify(probe));
        window.setTimeout(() => {
          probe.topNavigation = 'assigned';
          window.top.location = '${EXTERNAL}/navigate?from=svg';
        }, 1500);
      });
    })();
  </script>
</svg>
`;
}

async function mcp(name: string, args: Record<string, unknown>): Promise<Json> {
  const child = Bun.spawn(['node', bundle], {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_MCP_HTTP: '0',
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/svg-path',
      RELIC_CHROME_PATH: 'none',
      RELIC_OTIO_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const timer = setTimeout(() => child.kill(), 90_000);
  const send = (message: Json) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  const receive = async (id: number): Promise<Json> => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Json;
        assert.equal(message['id'], id, `${name}: unexpected RPC id`);
        assert.equal(
          message['error'],
          undefined,
          `${name}: ${JSON.stringify(message['error'])}`
        );
        assert.ok(message['result'], `${name}: missing RPC result`);
        return message['result'] as Json;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false, `${name}: MCP closed before response`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'svg-path', version: '1' },
      },
    });
    await receive(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const result = await receive(2);
    child.stdin.end();
    const exit = await child.exited;
    const errors = await stderr;
    assert.equal(exit, 0, `${name}: MCP exit ${exit}: ${errors}`);
    assert.equal(
      result['isError'],
      false,
      `${name}: ${JSON.stringify(result['structuredContent'])}`
    );
    return result['structuredContent'] as Json;
  } finally {
    clearTimeout(timer);
    child.kill();
    reader.releaseLock();
  }
}

async function session(email: string): Promise<string> {
  const token = `svg-path-${randomUUID()}`;
  const now = Date.now();
  await store.putSession({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    email,
    createdAt: now,
    expiresAt: now + 3_600_000,
  });
  return token;
}

async function until(
  test: () => Promise<boolean>,
  label: string,
  timeout = 60_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launchBrowser(): Promise<BrowserHandle> {
  const requested = process.env['RELIC_CHROME_PATH'];
  assert.ok(
    requested && requested !== 'none' && requested !== 'disabled',
    'RELIC_CHROME_PATH must name an isolated headless executable'
  );
  const found = await discoverChrome(requested);
  assert.equal(
    found.kind,
    'found',
    `headless browser not found: ${found.kind}`
  );
  if (found.kind !== 'found') throw new Error('unreachable');
  const profile = await mkdtemp(join(tmpdir(), 'relic-svg-chrome-'));
  const launch = createBrowserHeadlessLaunch(
    chromeArgs(found.path, profile).map((argument) =>
      argument === '--proxy-bypass-list=<-loopback>'
        ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port};127.0.0.1:${usercontent.port}`
        : argument === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : argument
    ),
    profile
  );
  const child: ChildProcess = spawn(found.path, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  child.stderr?.resume();
  let cdp: CdpConnection | undefined;
  try {
    cdp = connectPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    await attestBrowserHeadless(cdp, launch);
    const connection = cdp;
    const pages = new Map<string, PageHandle>();
    const popups: string[] = [];
    const externalPaused: string[] = [];
    connection.onEvent((event) => {
      if (event.method === 'Target.targetCreated') {
        const info = event.params['targetInfo'] as
          | { type?: string; openerId?: string; url?: string }
          | undefined;
        if (info?.type === 'page' && info.openerId !== undefined) {
          popups.push(info.url ?? '');
        }
        return;
      }
      const page = event.sessionId ? pages.get(event.sessionId) : undefined;
      if (!page) return;
      if (event.method === 'Page.frameNavigated') {
        const frame = event.params['frame'] as
          | { parentId?: string; url?: string }
          | undefined;
        if (frame && frame.parentId === undefined) {
          page.mainNavigations.push(frame.url ?? '');
        }
        return;
      }
      if (event.method === 'Log.entryAdded') {
        const entry = event.params['entry'] as { text?: string } | undefined;
        page.logs.push(entry?.text ?? '');
        return;
      }
      if (event.method === 'Page.javascriptDialogOpening') {
        void page
          .send('Page.handleJavaScriptDialog', { accept: true })
          .catch(() => {});
        return;
      }
      if (event.method !== 'Fetch.requestPaused') return;
      const request = event.params['request'] as
        | { url?: string; method?: string }
        | undefined;
      const requestId = event.params['requestId'];
      if (typeof requestId !== 'string') return;
      const url = request?.url ?? '';
      const local =
        url.startsWith(`${origin}/`) ||
        url.startsWith(`${usercontentOrigin}/`) ||
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url === 'about:blank';
      if (!local) externalPaused.push(`${request?.method ?? 'GET'} ${url}`);
      void page
        .send(
          local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }
        )
        .catch(() => {});
    });
    return {
      popups,
      externalPaused,
      async open(url, token) {
        const created = await connection.send('Target.createBrowserContext', {
          disposeOnDetach: true,
        });
        const context = String(created['browserContextId']);
        const target = await connection.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: context,
        });
        const targetId = String(target['targetId']);
        const attached = await connection.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        const id = String(attached['sessionId']);
        const send = (method: string, params?: Json) =>
          connection.send(method, params, id);
        const handle: PageHandle = {
          target: targetId,
          mainNavigations: [],
          logs: [],
          worlds: new Map(),
          send,
          async evaluate<T>(expression: string): Promise<T> {
            const result = await send('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true,
              timeout: 20_000,
            });
            assert.equal(
              result['exceptionDetails'],
              undefined,
              `browser evaluation: ${JSON.stringify(result['exceptionDetails'])}`
            );
            const value = result['result'] as { value?: unknown } | undefined;
            return value?.value as T;
          },
        };
        pages.set(id, handle);
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Network.enable');
        await send('Log.enable');
        await send('Network.setCacheDisabled', { cacheDisabled: true });
        await send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
        await send('Network.setCookie', {
          name: 'relic_session',
          value: token,
          url: origin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        });
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const loaded = connection.waitForEvent('Page.loadEventFired', {
          sessionId: id,
          timeoutMs: 60_000,
        });
        const navigation = await send('Page.navigate', { url });
        assert.equal(
          navigation['errorText'],
          undefined,
          `navigation failed: ${String(navigation['errorText'])}`
        );
        await loaded;
        return handle;
      },
      async targetUrl(target) {
        const info = await connection.send('Target.getTargetInfo', {
          targetId: target,
        });
        const targetInfo = info['targetInfo'] as { url?: string } | undefined;
        return targetInfo?.url ?? '';
      },
      async close() {
        await cleanupOwnedBrowserStartup({
          child,
          connection,
          forgetChild: undefined,
          profile,
          removeProfile: undefined,
        });
      },
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

// The usercontent frame's CDP id, found through the frame tree.
async function usercontentFrameId(
  page: PageHandle
): Promise<string | undefined> {
  const tree = await page.send('Page.getFrameTree');
  const top = tree['frameTree'] as FrameNode;
  return top.childFrames?.find((node) =>
    node.frame.url.startsWith(usercontentOrigin)
  )?.frame.id;
}

// Reads an attribute of the frame's document from an isolated world, which
// sees the DOM across origins. The world is rebuilt when the frame's document
// is replaced by the shim's document.write.
async function frameAttribute(
  page: PageHandle,
  frameId: string,
  name: string
): Promise<string | null> {
  try {
    let contextId = page.worlds.get(frameId);
    if (contextId === undefined) {
      const world = await page.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'relic-svg-proof',
        grantUniveralAccess: true,
      });
      contextId = Number(world['executionContextId']);
      page.worlds.set(frameId, contextId);
    }
    const result = await page.send('Runtime.evaluate', {
      expression: `document.documentElement.getAttribute(${JSON.stringify(name)})`,
      contextId,
      returnByValue: true,
    });
    const value = result['result'] as { value?: unknown } | undefined;
    return typeof value?.value === 'string' ? value.value : null;
  } catch {
    page.worlds.delete(frameId);
    return null;
  }
}

async function awaitFrameJson(page: PageHandle, name: string): Promise<Json> {
  let found: Json | undefined;
  await until(async () => {
    const frameId = await usercontentFrameId(page);
    if (frameId === undefined) return false;
    const raw = await frameAttribute(page, frameId, name);
    if (raw === null) return false;
    found = JSON.parse(raw) as Json;
    return true;
  }, `frame attribute ${name}`);
  assert.ok(found, `frame attribute ${name} missing`);
  return found;
}

function predict(
  filter: number,
  left: number,
  up: number,
  upLeft: number
): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) return left;
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      throw new Error(`unknown PNG filter ${filter}`);
  }
}

// Decodes an 8-bit, non-interlaced RGB or RGBA PNG, the form Chrome writes.
function decodePng(bytes: Buffer): Pixels {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, 'PNG bit depth must be 8');
      const colorType = body[9] ?? -1;
      assert.ok(
        colorType === 2 || colorType === 6,
        `PNG color type ${colorType} is not RGB or RGBA`
      );
      assert.equal(body[12], 0, 'PNG must not be interlaced');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (row[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      row[x] = (value + predict(filter, left, up, upLeft)) & 0xff;
    }
    previous = row;
  }
  return { width, height, channels, data: out };
}

function countColor(
  pixels: Pixels,
  rect: { x: number; y: number; width: number; height: number },
  [red, green, blue]: readonly [number, number, number],
  tolerance = 24
): number {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pixels.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(pixels.height, Math.ceil(rect.y + rect.height));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * pixels.width + x) * pixels.channels;
      if (
        Math.abs((pixels.data[i] ?? 0) - red) <= tolerance &&
        Math.abs((pixels.data[i + 1] ?? 0) - green) <= tolerance &&
        Math.abs((pixels.data[i + 2] ?? 0) - blue) <= tolerance
      ) {
        count++;
      }
    }
  }
  return count;
}

// One reader, one published SVG, one browser page. Every number here is read
// from the page or the network layer, never from the script's own claim.
async function probeRun(
  browser: BrowserHandle,
  url: string,
  token: string,
  app: AppLike,
  withPixels: boolean
): Promise<RunEvidence> {
  activeApp = app;
  const seenBefore = seen.length;
  const popupsBefore = browser.popups.length;
  const externalBefore = browser.externalPaused.length;
  const page = await browser.open(url, token);
  await until(async () => {
    return (await usercontentFrameId(page)) !== undefined;
  }, 'usercontent frame');
  const sandbox = await page.evaluate<string | null>(
    "(() => { const f = document.querySelector('iframe.usercontent-frame'); return f ? f.getAttribute('sandbox') : null; })()"
  );
  const frameSrc = await page.evaluate<string | null>(
    "(() => { const f = document.querySelector('iframe.usercontent-frame'); return f ? f.getAttribute('src') : null; })()"
  );
  const probe = await awaitFrameJson(page, 'data-svg-probe');
  const popupProbe = await awaitFrameJson(page, 'data-svg-popup');
  // Results are read before the top-window navigation fires, 1.5 s after the
  // popup probe. This is the navigation count at that moment.
  const navigationsBefore = page.mainNavigations.length;
  await Bun.sleep(2_500);
  const navigationsAfter = page.mainNavigations.length;
  const topUrl = await browser.targetUrl(page.target);
  const serviceHits = seen
    .slice(seenBefore)
    .filter((entry) => entry.path === SERVICE_PROBE_PATH).length;
  const serviceNullOrigin = seen
    .slice(seenBefore)
    .filter((entry) => entry.origin === 'null').length;
  let pixels: RunEvidence['pixels'];
  if (withPixels) {
    const rect = await page.evaluate<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>(
      "(() => { const r = document.querySelector('iframe.usercontent-frame').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()"
    );
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const decoded = decodePng(Buffer.from(String(shot['data']), 'base64'));
    pixels = {
      red: countColor(decoded, rect, [229, 57, 53]),
      blue: countColor(decoded, rect, [30, 136, 229]),
    };
  }
  return {
    probe,
    popupProbe,
    sandbox,
    frameSrc,
    navigationsBefore,
    navigationsAfter,
    topUrl,
    popups: browser.popups.length - popupsBefore,
    serviceHits,
    serviceNullOrigin,
    externalPaused: browser.externalPaused.length - externalBefore,
    cspRefusals: page.logs.filter((text) =>
      /Content Security Policy|Refused to/i.test(text)
    ).length,
    pixels,
  };
}

async function main(): Promise<void> {
  const productionApp = appFor(viewerDist);
  activeApp = productionApp;
  const svgPath = join(scratch, 'drawing.svg');
  await writeFile(svgPath, svgSource());
  const published = await mcp('relic_publish', { path: svgPath, cover: false });
  assert.equal(typeof published['url'], 'string', 'publish returned no url');
  const url = String(published['url']);
  assert.ok(url.startsWith(`${origin}/`), 'published url is not the service');
  const token = await session('reader@relic.test');

  const shim = await fetch(`${usercontentOrigin}/sandbox.html`);
  const shimCsp = shim.headers.get('content-security-policy') ?? '';
  const shimHolds = [...SHIM_CSP_DIRECTIVES, `frame-ancestors ${origin}`].every(
    (directive) => shimCsp.includes(directive)
  );
  check(
    'the shim is served with the production policy',
    shim.status === 200 && shimHolds,
    `status ${shim.status}; CSP ${shimHolds ? 'holds' : 'lacks'} default-src 'none', script-src 'unsafe-inline' blob:, frame-ancestors ${origin}`
  );
  check(
    'the publisher sees renderer_class image for the svg; routing still uses the frame',
    published['renderer_class'] === 'image',
    `renderer_class=${String(published['renderer_class'])}`
  );

  const browser = await launchBrowser();
  try {
    const positive = await probeRun(browser, url, token, productionApp, true);
    const red = positive.pixels?.red ?? 0;
    const blue = positive.pixels?.blue ?? 0;
    check(
      'the drawing renders in the frame (red rect)',
      red >= 2000,
      `${red} red pixels in the frame rect`
    );
    check(
      'the drawing renders in the frame (blue circle)',
      blue >= 2000,
      `${blue} blue pixels in the frame rect`
    );
    check(
      'the frame is sandboxed to allow-scripts alone and loads the usercontent shim',
      positive.sandbox === 'allow-scripts' &&
        positive.frameSrc?.startsWith(`${usercontentOrigin}/sandbox.html`) ===
          true,
      `sandbox="${String(positive.sandbox)}" src=${String(positive.frameSrc)}`
    );
    const p = positive.probe;
    check(
      'the script ran and reported its attempts',
      typeof p['externalFetch'] === 'string' &&
        typeof p['serviceFetch'] === 'string',
      `externalFetch=${String(p['externalFetch'])} serviceFetch=${String(p['serviceFetch'])}`
    );
    check(
      'the script has an opaque origin',
      p['origin'] === 'null',
      `window.origin=${String(p['origin'])}`
    );
    check(
      'window.parent.location is unreadable (SecurityError)',
      String(p['parentLocation']).startsWith('threw:SecurityError'),
      `parentLocation=${String(p['parentLocation'])}`
    );
    check(
      'window.top.document is unreadable (SecurityError)',
      String(p['topDocument']).startsWith('threw:SecurityError'),
      `topDocument=${String(p['topDocument'])}`
    );
    check(
      'document.cookie is unreadable (SecurityError)',
      p['cookie'] === 'threw:SecurityError',
      `cookie=${String(p['cookie'])}`
    );
    check(
      'localStorage is unreadable (SecurityError)',
      p['localStorage'] === 'threw:SecurityError',
      `localStorage=${String(p['localStorage'])}`
    );
    check(
      'an external fetch from the script is refused (TypeError)',
      p['externalFetch'] === 'blocked:TypeError',
      `externalFetch=${String(p['externalFetch'])}`
    );
    check(
      'a fetch of the service origin from the script is refused (TypeError)',
      p['serviceFetch'] === 'blocked:TypeError',
      `serviceFetch=${String(p['serviceFetch'])}`
    );
    check(
      'nothing from the frame reached the service (path or null origin)',
      positive.serviceHits === 0 && positive.serviceNullOrigin === 0,
      `probe-path hits=${positive.serviceHits}; requests with Origin null=${positive.serviceNullOrigin}`
    );
    check(
      'window.open from the script opened no popup',
      positive.popupProbe['popup'] === 'null' && positive.popups === 0,
      `popup=${String(positive.popupProbe['popup'])}; new popup targets=${positive.popups}`
    );
    const topDocument = positive.topUrl.split('#')[0];
    const publishedDocument = url.split('#')[0];
    check(
      'the top-window navigation was refused: no main-frame navigation, viewer document unchanged',
      positive.navigationsAfter === positive.navigationsBefore &&
        topDocument === publishedDocument,
      `main-frame navigations ${positive.navigationsBefore}->${positive.navigationsAfter}; top document ${topDocument}; fragment present=${positive.topUrl.includes('#')} (format.md 2.5 strips it)`
    );
    check(
      'the console logged CSP refusals for the external requests',
      positive.cspRefusals >= 1,
      `CSP refusal log entries=${positive.cspRefusals}`
    );
    console.log(
      `INFO interception paused ${positive.externalPaused} external request(s); the harness failed each one`
    );

    // Negative control: a throwaway viewer whose frame grants the origin.
    const loosenedDist = await mkdtemp(join(tmpdir(), 'relic-svg-loosened-'));
    try {
      await cp(viewerDist, loosenedDist, { recursive: true });
      const original = 'setAttribute("sandbox","allow-scripts")';
      const loosened =
        'setAttribute("sandbox","allow-scripts allow-same-origin allow-top-navigation")';
      let rewritten = 0;
      for (const name of ['main.js', 'viewer.js']) {
        const path = join(loosenedDist, name);
        const text = await readFile(path, 'utf8');
        if (text.includes(original)) {
          await writeFile(path, text.split(original).join(loosened));
          rewritten++;
        }
      }
      assert.ok(
        rewritten >= 1,
        'the frame sandbox string was not in the viewer'
      );
      const control = await probeRun(
        browser,
        url,
        token,
        appFor(loosenedDist),
        false
      );
      check(
        'negative control: the copied frame sandbox is loosened',
        control.sandbox ===
          'allow-scripts allow-same-origin allow-top-navigation',
        `control sandbox="${String(control.sandbox)}"`
      );
      const c = control.probe;
      // Each flag is true when the isolation property still holds in the
      // loosened copy. Every one must be false for the control to be valid.
      const holds = {
        opaqueOrigin: c['origin'] === 'null',
        cookieRefused: c['cookie'] === 'threw:SecurityError',
        storageRefused: c['localStorage'] === 'threw:SecurityError',
        topNavigationRefused:
          control.navigationsAfter === control.navigationsBefore,
      };
      const stillHolding = Object.entries(holds)
        .filter(([, value]) => value)
        .map(([name]) => name);
      check(
        'negative control: each isolation assertion fails when the sandbox is loosened',
        stillHolding.length === 0,
        `control origin=${String(c['origin'])} cookie=${String(c['cookie'])} localStorage=${String(c['localStorage'])} navigations ${control.navigationsBefore}->${control.navigationsAfter}; still holding=[${stillHolding.join(',')}]`
      );
    } finally {
      await rm(loosenedDist, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
}

let failure: string | undefined;
try {
  await main();
} catch (error) {
  failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  service.stop(true);
  usercontent.stop(true);
  await rm(scratch, { recursive: true, force: true });
}

const notProven = checks.filter((item) => !item.ok).map((item) => item.label);
if (failure !== undefined) {
  console.error(`SVG_PATH_FAILED ${failure}`);
  process.exitCode = 1;
} else if (notProven.length > 0) {
  console.error(`SVG_PATH_FAILED not proven: ${notProven.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('SVG_PATH_OK');
}
