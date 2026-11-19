/**
 * An SVG published as a relic renders in the sandboxed frame, and the script in
 * it reaches nothing it should. Runs the built viewer, the MCP bundle and
 * loopback services in an isolated headless browser:
 *
 *   mise exec -- bun run --cwd packages/relic-viewer build
 *   mise exec -- bun run --cwd packages/relic-mcp build
 *   RELIC_CHROME_PATH=<isolated headless shell> \
 *     mise exec -- bun packages/relic-mcp/test/svg-path.ts
 *
 * Each process model runs the same checks in its own browser:
 *   default   the browser's own model. The headless shell keeps the frame in
 *             the page's process; full Chrome may isolate it.
 *   isolated  --site-per-process --enable-features=IsolateSandboxedIframes.
 *             The frame must appear as its own out-of-process iframe target.
 * The usercontent origin is relic-usercontent.test, which the host resolver maps
 * to 127.0.0.1. It is cross-site from the service, as in production (spec 2),
 * and it does not depend on IPv6 resolution.
 *
 * The positive run publishes an SVG whose script tries to read the parent, the
 * cookie and storage, fetch an external URL and the service, open a popup, and
 * navigate the top window. The script reports into its own document, and the
 * harness reads that report from the frame wherever the frame lives. The
 * drawing must show in the frame, and every attempt must be refused.
 *
 * Three controls show that each detector can fire, in the same browser:
 *   A  the frame sandbox is loosened in a throwaway viewer copy; the origin,
 *      cookie, storage and top-navigation checks must flip;
 *   B  the shim's connection policy is loosened; the service and network checks
 *      must fire;
 *   C  a user-gesture window.open must create a popup target that is counted.
 *
 * Request interception is a harness aid: it sees what leaves a page or a frame.
 * It covers the page session and every out-of-process frame session. Control B
 * shows it reaches the frame, so the zero counts in the positive run are not
 * vacuous.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  type CdpConnection,
  type CdpEvent,
  connectPipe,
} from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

/** A CDP payload or a JSON object returned by the browser. */
type Json = Record<string, unknown>;

/** The app's request surface; the proof only calls fetch. */
interface AppLike {
  fetch(request: Request): Response | Promise<Response>;
}

interface Mode {
  readonly name: 'default' | 'isolated';
  readonly flags: readonly string[];
}

interface Seen {
  readonly server: 'service' | 'usercontent';
  readonly path: string;
}

interface Child {
  readonly sessionId: string;
  readonly targetId: string;
  readonly type: string;
}

interface Logged {
  readonly scope: 'page' | 'frame';
  readonly text: string;
}

interface Paused {
  readonly scope: 'page' | 'frame';
  readonly url: string;
  readonly resourceType: string;
}

interface Page {
  readonly targetId: string;
  readonly sessionId: string;
  readonly children: Map<string, Child>;
  readonly mainNavigations: string[];
  readonly logs: Logged[];
  readonly paused: Paused[];
  readonly setupErrors: string[];
}

interface Browser {
  readonly popups: string[];
  send: (method: string, params?: Json, sessionId?: string) => Promise<Json>;
  open(url: string, token: string): Promise<Page>;
  close(): Promise<void>;
}

/** Where the viewer's usercontent frame lives: in this page, or in its own target. */
interface ViewerFrame {
  readonly kind: 'in-process' | 'out-of-process';
  readonly frameId: string;
  readonly sessionId: string | undefined;
}

/** The viewer's iframe element, read from the top page. */
interface FrameElement {
  readonly src: string | null;
  readonly sandbox: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A CDP RemoteObject. Only `value` and `objectId` are read. */
interface RemoteObject {
  readonly value?: unknown;
  readonly objectId?: string;
}

interface FrameTree {
  readonly frame: { readonly id: string; readonly url: string };
  readonly childFrames?: readonly FrameTree[];
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url?: string;
  readonly openerId?: string;
}

interface NavigatedFrame {
  readonly parentId?: string;
  readonly url?: string;
}

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Buffer;
}

interface Evidence {
  readonly frame: ViewerFrame['kind'];
  readonly navigateAttempted: boolean;
  readonly sandbox: string | null;
  readonly src: string | null;
  readonly shimLocation: string;
  readonly probe: Json;
  readonly popupProbe: Json;
  readonly topBefore: string;
  readonly topAfter: string;
  readonly mainNavigations: number;
  readonly documentRequests: number;
  readonly externalRequests: number;
  readonly popups: number;
  readonly serviceHits: number;
  readonly cspLogs: string[];
  readonly pixels: { readonly red: number; readonly blue: number } | undefined;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist = join(root, 'packages/relic-viewer/dist');
const bundle = join(root, 'packages/relic-mcp/dist/relic-mcp.js');
// Screenshots are written only when a directory is named, so CI can upload them.
const shotsDir = process.env['RELIC_SVG_PATH_SHOTS'];
const scratch = await mkdtemp(join(tmpdir(), 'relic-svg-path-'));
const statePath = join(scratch, 'state.json');
const EXTERNAL = 'https://collector.relic-proof.invalid';
const SERVICE_PROBE_PATH = '/svg-probe-service-fetch';
// Resolves to 127.0.0.1 through the host resolver, so the usercontent origin is
// cross-site from the service with no dependence on localhost or IPv6.
const USERCONTENT_HOST = 'relic-usercontent.test';
const LOOSENED_SANDBOX = 'allow-scripts allow-same-origin allow-top-navigation';
const RED: readonly [number, number, number] = [229, 57, 53];
const BLUE: readonly [number, number, number] = [30, 136, 229];
const CSP_LOG =
  /Content Security Policy|Refused to|Unsafe attempt|Blocked opening|sandbox/i;
const FRAME_ELEMENT =
  "(() => { const f = document.querySelector('iframe.usercontent-frame'); if (!f) return null; const r = f.getBoundingClientRect(); return { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox'), x: r.x, y: r.y, width: r.width, height: r.height }; })()";
const MODES: readonly Mode[] = [
  { name: 'default', flags: [] },
  {
    name: 'isolated',
    flags: ['--site-per-process', '--enable-features=IsolateSandboxedIframes'],
  },
];

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const seen: Seen[] = [];
const checks: Array<{ readonly label: string; readonly ok: boolean }> = [];
let activeApp: AppLike | undefined;
let shimPolicyOverride: string | undefined;

async function handle(
  server: Seen['server'],
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  seen.push({ server, path: url.pathname });
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
  const response = await app.fetch(request);
  if (
    server === 'usercontent' &&
    url.pathname === '/sandbox.html' &&
    shimPolicyOverride !== undefined
  ) {
    const headers = new Headers(response.headers);
    headers.set('content-security-policy', shimPolicyOverride);
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
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
const usercontentOrigin = `http://${USERCONTENT_HOST}:${usercontent.port}`;
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

// The shim's response carries `sandbox allow-scripts`, and a CSP sandbox directive
// caps the frame's flags whatever the iframe attribute grants. With that directive,
// a loosened iframe attribute flips nothing, so control A is blind. Control A serves
// the loosened copy without that one directive, and only that one. The viewer rows
// keep the production app. The wrapper fails if the directive is absent, so the
// control cannot silently become a no-op.
const SHIM_SANDBOX_DIRECTIVE = 'sandbox allow-scripts; ';
function withoutShimSandboxDirective(inner: AppLike): AppLike {
  return {
    async fetch(request: Request): Promise<Response> {
      const response = await inner.fetch(request);
      if (new URL(request.url).pathname !== '/sandbox.html') return response;
      const csp = response.headers.get('content-security-policy');
      if (csp === null || !csp.includes(SHIM_SANDBOX_DIRECTIVE)) {
        throw new Error(
          'control A: sandbox.html no longer carries the sandbox directive it removes'
        );
      }
      const headers = new Headers(response.headers);
      headers.set(
        'content-security-policy',
        csp.replace(SHIM_SANDBOX_DIRECTIVE, '')
      );
      return new Response(response.body, { status: response.status, headers });
    },
  };
}

function check(label: string, ok: boolean, evidence: string): void {
  checks.push({ label, ok });
  console.log(`${ok ? 'PROVEN' : 'NOT_PROVEN'} ${label} | ${evidence}`);
}

// The SVG under test. Its script reports each attempt into its own document, and
// the top-window navigation waits until those results are written.
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
        settle('externalFetch', fetch('${EXTERNAL}/beacon?from=svg', { mode: 'no-cors' })),
        settle('serviceFetch', fetch('${origin}${SERVICE_PROBE_PATH}', { mode: 'no-cors' })),
      ]).then(() => {
        document.documentElement.setAttribute('data-svg-probe', JSON.stringify(probe));
        probe.popup = window.open('${EXTERNAL}/popup?from=svg') === null ? 'null' : 'object';
        document.documentElement.setAttribute('data-svg-popup', JSON.stringify(probe));
        window.setTimeout(() => {
          document.documentElement.setAttribute('data-svg-navigate', 'attempted');
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

// A CDP event for a page or a child target. Page-level state is kept per target,
// and the frame's own session contributes requests and console lines too.
function onPageEvent(
  connection: CdpConnection,
  pages: Map<string, Page>,
  page: Page,
  sessionId: string,
  event: CdpEvent
): void {
  const scope = sessionId === page.sessionId ? 'page' : 'frame';
  switch (event.method) {
    case 'Target.attachedToTarget': {
      // An out-of-process child. It stays paused until interception is attached
      // in prepareChild, so no request from it leaves before that.
      const childId = event.params['sessionId'];
      const info = event.params['targetInfo'] as TargetInfo | undefined;
      if (typeof childId !== 'string' || info === undefined) return;
      page.children.set(childId, {
        sessionId: childId,
        targetId: info.targetId,
        type: info.type,
      });
      pages.set(childId, page);
      void prepareChild(
        connection,
        page,
        childId,
        event.params['waitingForDebugger'] === true
      );
      return;
    }
    case 'Page.frameNavigated': {
      const frame = event.params['frame'] as NavigatedFrame | undefined;
      if (scope === 'page' && frame?.parentId === undefined) {
        page.mainNavigations.push(frame?.url ?? '');
      }
      return;
    }
    case 'Page.javascriptDialogOpening':
      void connection
        .send('Page.handleJavaScriptDialog', { accept: true }, sessionId)
        .catch(() => {});
      return;
    case 'Log.entryAdded': {
      const entry = event.params['entry'] as
        | { readonly text?: string }
        | undefined;
      page.logs.push({ scope, text: entry?.text ?? '' });
      return;
    }
    case 'Fetch.requestPaused': {
      const requestId = event.params['requestId'];
      if (typeof requestId !== 'string') return;
      const request = event.params['request'] as
        | { readonly url?: string }
        | undefined;
      const resourceType = event.params['resourceType'];
      const url = request?.url ?? '';
      page.paused.push({
        scope,
        url,
        resourceType: typeof resourceType === 'string' ? resourceType : '',
      });
      const local =
        url.startsWith(`${origin}/`) ||
        url.startsWith(`${usercontentOrigin}/`) ||
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url === 'about:blank';
      void connection
        .send(
          local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local ? { requestId } : { requestId, errorReason: 'BlockedByClient' },
          sessionId
        )
        .catch(() => {});
      return;
    }
    default:
      return;
  }
}

// Interception is attached before the child runs, then the child resumes.
async function prepareChild(
  connection: CdpConnection,
  page: Page,
  sessionId: string,
  waiting: boolean
): Promise<void> {
  try {
    await connection.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );
    await connection.send('Log.enable', {}, sessionId);
  } catch (error) {
    page.setupErrors.push(
      `${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (waiting) {
      await connection
        .send('Runtime.runIfWaitingForDebugger', {}, sessionId)
        .catch(() => {});
    }
  }
}

async function launchBrowser(mode: Mode): Promise<Browser> {
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
  const base = chromeArgs(found.path, profile).map((argument) =>
    argument === '--proxy-bypass-list=<-loopback>'
      ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port};${USERCONTENT_HOST}`
      : argument === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? `--host-resolver-rules=MAP ${USERCONTENT_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`
        : argument
  );
  const launch = createBrowserHeadlessLaunch(
    [...base.slice(0, -1), ...mode.flags, 'about:blank'],
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
    const pages = new Map<string, Page>();
    const popups: string[] = [];
    connection.onEvent((event) => {
      if (event.method === 'Target.targetCreated') {
        const info = event.params['targetInfo'] as TargetInfo | undefined;
        if (info?.type === 'page' && info.openerId !== undefined) {
          popups.push(info.targetId);
        }
        return;
      }
      if (event.sessionId === undefined) return;
      const page = pages.get(event.sessionId);
      if (page !== undefined) {
        onPageEvent(connection, pages, page, event.sessionId, event);
      }
    });
    await connection.send('Target.setDiscoverTargets', { discover: true });
    return {
      popups,
      send: (method, params, sessionId) =>
        connection.send(method, params, sessionId),
      async open(url, token) {
        const created = await connection.send('Target.createBrowserContext', {
          disposeOnDetach: true,
        });
        const target = await connection.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: String(created['browserContextId']),
        });
        const targetId = String(target['targetId']);
        const attached = await connection.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        const sessionId = String(attached['sessionId']);
        const page: Page = {
          targetId,
          sessionId,
          children: new Map(),
          mainNavigations: [],
          logs: [],
          paused: [],
          setupErrors: [],
        };
        pages.set(sessionId, page);
        await connection.send('Page.enable', {}, sessionId);
        await connection.send('DOM.enable', {}, sessionId);
        await connection.send('Log.enable', {}, sessionId);
        await connection.send('Network.enable', {}, sessionId);
        await connection.send(
          'Network.setCacheDisabled',
          { cacheDisabled: true },
          sessionId
        );
        await connection.send(
          'Fetch.enable',
          { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
          sessionId
        );
        await connection.send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          sessionId
        );
        await connection.send(
          'Network.setCookie',
          {
            name: 'relic_session',
            value: token,
            url: origin,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
          sessionId
        );
        await connection.send(
          'Emulation.setDeviceMetricsOverride',
          { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
          sessionId
        );
        const loaded = connection.waitForEvent('Page.loadEventFired', {
          sessionId,
          timeoutMs: 60_000,
        });
        const navigation = await connection.send(
          'Page.navigate',
          { url },
          sessionId
        );
        assert.equal(
          navigation['errorText'],
          undefined,
          `navigation failed: ${String(navigation['errorText'])}`
        );
        await loaded;
        return page;
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

// The value of a CDP evaluation, or undefined when it threw.
function remoteValue(result: Json | undefined): unknown {
  if (result === undefined || result['exceptionDetails'] !== undefined) {
    return undefined;
  }
  // A CDP RemoteObject. An undefined result has no `value`.
  const wrapped = result['result'] as RemoteObject | undefined;
  return wrapped?.value;
}

async function pageRead(
  browser: Browser,
  page: Page,
  expression: string
): Promise<unknown> {
  return remoteValue(
    await browser
      .send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        page.sessionId
      )
      .catch((): undefined => undefined)
  );
}

// True when the frame behind this owner element is the viewer's usercontent iframe.
async function ownsViewerFrame(
  browser: Browser,
  page: Page,
  frameId: string
): Promise<boolean> {
  const owner = await browser
    .send('DOM.getFrameOwner', { frameId }, page.sessionId)
    .catch((): undefined => undefined);
  const backendNodeId = owner?.['backendNodeId'];
  if (typeof backendNodeId !== 'number') return false;
  const resolved = await browser
    .send('DOM.resolveNode', { backendNodeId }, page.sessionId)
    .catch((): undefined => undefined);
  const element = resolved?.['object'] as RemoteObject | undefined;
  if (typeof element?.objectId !== 'string') return false;
  const verdict = await browser
    .send(
      'Runtime.callFunctionOn',
      {
        objectId: element.objectId,
        functionDeclaration:
          'function () { return this.classList.contains("usercontent-frame"); }',
        returnByValue: true,
      },
      page.sessionId
    )
    .catch((): undefined => undefined);
  return remoteValue(verdict) === true;
}

// The viewer's frame: an out-of-process iframe target when the browser isolates
// it, otherwise a child of the page's own frame tree.
async function viewerFrame(
  browser: Browser,
  page: Page
): Promise<ViewerFrame | undefined> {
  for (const child of page.children.values()) {
    if (
      child.type === 'iframe' &&
      (await ownsViewerFrame(browser, page, child.targetId))
    ) {
      return {
        kind: 'out-of-process',
        frameId: child.targetId,
        sessionId: child.sessionId,
      };
    }
  }
  const tree = await browser.send('Page.getFrameTree', {}, page.sessionId);
  const top = tree['frameTree'] as FrameTree | undefined;
  for (const node of top?.childFrames ?? []) {
    if (await ownsViewerFrame(browser, page, node.frame.id)) {
      return {
        kind: 'in-process',
        frameId: node.frame.id,
        sessionId: undefined,
      };
    }
  }
  return undefined;
}

async function awaitViewerFrame(
  browser: Browser,
  page: Page
): Promise<ViewerFrame> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const frame = await viewerFrame(browser, page);
    if (frame !== undefined) return frame;
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for the viewer's usercontent frame\nDIAGNOSTIC ${await diagnose(browser, page)}`
  );
}

// One evaluation inside the viewer's frame. A remote frame is read through its
// own session; an in-process frame through an isolated world.
async function frameRead(
  browser: Browser,
  page: Page,
  frame: ViewerFrame,
  expression: string
): Promise<unknown> {
  if (frame.sessionId !== undefined) {
    return remoteValue(
      await browser
        .send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          frame.sessionId
        )
        .catch((): undefined => undefined)
    );
  }
  const world = await browser
    .send(
      'Page.createIsolatedWorld',
      {
        frameId: frame.frameId,
        worldName: 'svg-path-proof',
        grantUniveralAccess: true,
      },
      page.sessionId
    )
    .catch((): undefined => undefined);
  const contextId = world?.['executionContextId'];
  if (typeof contextId !== 'number') return undefined;
  return remoteValue(
    await browser
      .send(
        'Runtime.evaluate',
        { expression, contextId, returnByValue: true },
        page.sessionId
      )
      .catch((): undefined => undefined)
  );
}

async function awaitFrame(
  browser: Browser,
  page: Page,
  frame: ViewerFrame,
  expression: string,
  label: string
): Promise<unknown> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await frameRead(browser, page, frame, expression);
    if (value !== undefined && value !== null && value !== '') return value;
    await Bun.sleep(50);
  }
  throw new Error(
    `Timed out waiting for ${label}\nDIAGNOSTIC ${await diagnose(browser, page)}`
  );
}

async function readJson(
  browser: Browser,
  page: Page,
  frame: ViewerFrame,
  name: string
): Promise<Json> {
  const raw = await awaitFrame(
    browser,
    page,
    frame,
    `document.documentElement.getAttribute(${JSON.stringify(name)})`,
    `the script's ${name} report`
  );
  assert.equal(typeof raw, 'string', `${name} is not a string`);
  return JSON.parse(String(raw)) as Json;
}

function frameElementOf(value: unknown): FrameElement | null {
  if (typeof value !== 'object' || value === null) return null;
  // A CDP object; every field is checked before use.
  const fields = value as Json;
  const { src, sandbox, x, y, width, height } = fields;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  return {
    src: typeof src === 'string' ? src : null,
    sandbox: typeof sandbox === 'string' ? sandbox : null,
    x,
    y,
    width,
    height,
  };
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
  rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
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

async function diagnose(browser: Browser, page: Page): Promise<string> {
  const version = await browser
    .send('Browser.getVersion')
    .catch((): Json => ({}));
  const processes = await browser
    .send('SystemInfo.getProcessInfo')
    .catch((): Json => ({}));
  const targets = await browser
    .send('Target.getTargets')
    .catch((): Json => ({}));
  const tree = await browser
    .send('Page.getFrameTree', {}, page.sessionId)
    .catch((): Json => ({}));
  const infos = Array.isArray(targets['targetInfos'])
    ? (targets['targetInfos'] as Json[])
    : [];
  const procs = Array.isArray(processes['processInfo'])
    ? (processes['processInfo'] as Json[])
    : [];
  return JSON.stringify(
    {
      product: version['product'],
      renderers: procs.filter((item) => item['type'] === 'renderer').length,
      element: frameElementOf(await pageRead(browser, page, FRAME_ELEMENT)),
      children: [...page.children.values()],
      targets: infos.map((item) => ({
        type: item['type'],
        url: item['url'],
        attached: item['attached'],
      })),
      frameTree: tree['frameTree'],
      logs: page.logs.slice(-12),
      paused: page.paused.slice(-12),
      setupErrors: page.setupErrors,
    },
    null,
    1
  );
}

// One reader, one published SVG, one page. Every value is read from the frame's
// own report, the top page, the network layer or the server, never from a claim.
async function probeRun(
  browser: Browser,
  url: string,
  token: string,
  app: AppLike,
  shot: string | undefined
): Promise<Evidence> {
  activeApp = app;
  const seenBefore = seen.length;
  const popupsBefore = browser.popups.length;
  const page = await browser.open(url, token);
  const frame = await awaitViewerFrame(browser, page);
  const element = frameElementOf(await pageRead(browser, page, FRAME_ELEMENT));
  const shimLocation = String(
    await awaitFrame(
      browser,
      page,
      frame,
      `(() => { const h = location.href; return h.startsWith(${JSON.stringify(`${usercontentOrigin}/sandbox.html`)}) ? h : ''; })()`,
      'the usercontent shim document'
    )
  );
  const probe = await readJson(browser, page, frame, 'data-svg-probe');
  const popupProbe = await readJson(browser, page, frame, 'data-svg-popup');
  // The top-window attempt comes 1.5 s after the popup report, so counts taken
  // now are before it. The attempt marker is read after it: a refused attempt
  // leaves the frame alive to report it, while an allowed navigation may replace
  // the frame first, so a missing marker is evidence, not a timeout.
  const topBefore = String(await pageRead(browser, page, 'location.href'));
  const mainBefore = page.mainNavigations.length;
  await Bun.sleep(2_500);
  const navigateAttempted =
    (await frameRead(
      browser,
      page,
      frame,
      "document.documentElement.getAttribute('data-svg-navigate')"
    )) === 'attempted';
  const topAfter = String(await pageRead(browser, page, 'location.href'));
  let pixels: Evidence['pixels'];
  if (shot !== undefined) {
    const screenshot = await browser.send(
      'Page.captureScreenshot',
      { format: 'png' },
      page.sessionId
    );
    const bytes = Buffer.from(String(screenshot['data']), 'base64');
    if (shotsDir !== undefined) {
      await mkdir(shotsDir, { recursive: true });
      await writeFile(join(shotsDir, shot), bytes);
    }
    if (element !== null) {
      const decoded = decodePng(bytes);
      pixels = {
        red: countColor(decoded, element, RED),
        blue: countColor(decoded, element, BLUE),
      };
    }
  }
  return {
    frame: frame.kind,
    navigateAttempted,
    sandbox: element?.sandbox ?? null,
    src: element?.src ?? null,
    shimLocation,
    probe,
    popupProbe,
    topBefore,
    topAfter,
    mainNavigations: page.mainNavigations.length - mainBefore,
    documentRequests: page.paused.filter(
      (item) =>
        item.url.startsWith(`${EXTERNAL}/navigate`) &&
        item.resourceType === 'Document'
    ).length,
    externalRequests: page.paused.filter((item) =>
      item.url.startsWith(EXTERNAL)
    ).length,
    popups: browser.popups.length - popupsBefore,
    serviceHits: seen
      .slice(seenBefore)
      .filter(
        (entry) =>
          entry.server === 'service' && entry.path === SERVICE_PROBE_PATH
      ).length,
    cspLogs: page.logs
      .filter((line) => CSP_LOG.test(line.text))
      .map((line) => `${line.scope}: ${line.text.slice(0, 160)}`),
    pixels,
  };
}

// Control C: a user-gesture window.open must produce a popup target.
async function popupDetector(browser: Browser): Promise<number> {
  const created = await browser.send('Target.createTarget', {
    url: 'about:blank',
  });
  const attached = await browser.send('Target.attachToTarget', {
    targetId: String(created['targetId']),
    flatten: true,
  });
  const before = browser.popups.length;
  await browser.send(
    'Runtime.evaluate',
    {
      expression: "window.open('about:blank') !== null",
      userGesture: true,
      returnByValue: true,
    },
    String(attached['sessionId'])
  );
  await until(
    async () => browser.popups.length > before,
    'a user-gesture popup target',
    15_000
  );
  return browser.popups.length - before;
}

function checkPositive(m: string, mode: Mode, e: Evidence): void {
  const p = e.probe;
  for (const line of e.cspLogs)
    console.log(`INFO ${m}: browser refusal: ${line}`);
  if (mode.name === 'isolated') {
    check(
      `${m}: the usercontent frame is out of process (its own iframe target)`,
      e.frame === 'out-of-process',
      `frame=${e.frame}`
    );
  } else {
    console.log(`INFO ${m}: the usercontent frame is ${e.frame} in this run`);
  }
  check(
    `${m}: the frame is sandboxed to allow-scripts alone and loads the usercontent shim`,
    e.sandbox === 'allow-scripts' &&
      (e.src ?? '').startsWith(`${usercontentOrigin}/sandbox.html`) &&
      e.shimLocation.startsWith(`${usercontentOrigin}/sandbox.html`),
    `sandbox=${String(e.sandbox)} src=${String(e.src)}`
  );
  check(
    `${m}: the script ran and its origin is opaque`,
    p['origin'] === 'null',
    `origin=${String(p['origin'])}`
  );
  check(
    `${m}: the parent window cannot be read`,
    String(p['parentLocation']).startsWith('threw:SecurityError'),
    `parentLocation=${String(p['parentLocation'])}`
  );
  check(
    `${m}: the top document cannot be read`,
    String(p['topDocument']).startsWith('threw:SecurityError'),
    `topDocument=${String(p['topDocument'])}`
  );
  check(
    `${m}: document.cookie cannot be read`,
    p['cookie'] === 'threw:SecurityError',
    `cookie=${String(p['cookie'])}`
  );
  check(
    `${m}: localStorage cannot be read`,
    p['localStorage'] === 'threw:SecurityError',
    `localStorage=${String(p['localStorage'])}`
  );
  check(
    `${m}: an external fetch is refused and never reaches the network layer`,
    p['externalFetch'] === 'blocked:TypeError' && e.externalRequests === 0,
    `externalFetch=${String(p['externalFetch'])} requests at interception=${e.externalRequests} csp=${e.cspLogs.length}`
  );
  check(
    `${m}: a fetch of the service is refused and the service records no probe request`,
    p['serviceFetch'] === 'blocked:TypeError' && e.serviceHits === 0,
    `serviceFetch=${String(p['serviceFetch'])} service hits=${e.serviceHits}`
  );
  check(
    `${m}: window.open returns null and no popup target appears`,
    e.popupProbe['popup'] === 'null' && e.popups === 0,
    `popup=${String(e.popupProbe['popup'])} popup targets=${e.popups}`
  );
  check(
    `${m}: the top-window navigation is attempted and refused`,
    e.navigateAttempted &&
      e.documentRequests === 0 &&
      e.mainNavigations === 0 &&
      new URL(e.topAfter).origin === new URL(e.topBefore).origin &&
      new URL(e.topAfter).pathname === new URL(e.topBefore).pathname,
    `attempt marker=${e.navigateAttempted} navigation requests=${e.documentRequests} main-frame navigations=${e.mainNavigations} top=${e.topAfter}`
  );
  check(
    `${m}: the drawing renders in the frame`,
    (e.pixels?.red ?? 0) >= 2000 && (e.pixels?.blue ?? 0) >= 2000,
    `red=${e.pixels?.red ?? 0} blue=${e.pixels?.blue ?? 0} px in the frame rect`
  );
}

function checkSandboxControl(m: string, e: Evidence): void {
  const p = e.probe;
  check(
    `${m}: control A: the loosened sandbox is in effect`,
    e.sandbox === LOOSENED_SANDBOX,
    `sandbox=${String(e.sandbox)}`
  );
  check(
    `${m}: control A: the origin check flips (not opaque)`,
    p['origin'] !== 'null',
    `origin=${String(p['origin'])}`
  );
  check(
    `${m}: control A: the cookie check flips (readable)`,
    String(p['cookie']).startsWith('read:'),
    `cookie=${String(p['cookie'])}`
  );
  check(
    `${m}: control A: the storage check flips (readable)`,
    String(p['localStorage']).startsWith('read:'),
    `localStorage=${String(p['localStorage'])}`
  );
  check(
    `${m}: control A: the top-navigation check fires (request reaches interception)`,
    e.documentRequests >= 1,
    `navigation requests=${e.documentRequests}`
  );
  console.log(
    `INFO ${m}: control A parent location: ${String(p['parentLocation'])} (the origin split is a separate layer)`
  );
}

function checkConnectControl(m: string, e: Evidence): void {
  check(
    `${m}: control B: the service fetch reaches the service, which records it`,
    e.serviceHits >= 1 && e.probe['serviceFetch'] === 'reached',
    `service hits=${e.serviceHits} serviceFetch=${String(e.probe['serviceFetch'])}`
  );
  check(
    `${m}: control B: the external fetch reaches network-layer interception`,
    e.externalRequests >= 1,
    `requests at interception=${e.externalRequests}`
  );
}

async function runMode(
  mode: Mode,
  url: string,
  token: string,
  loosenedDist: string,
  connectPolicy: string
): Promise<void> {
  const m = mode.name;
  const browser = await launchBrowser(mode);
  try {
    const positive = await probeRun(
      browser,
      url,
      token,
      appFor(viewerDist),
      `${m}.png`
    );
    checkPositive(m, mode, positive);
    const sandboxControl = await probeRun(
      browser,
      url,
      token,
      withoutShimSandboxDirective(appFor(loosenedDist)),
      undefined
    );
    checkSandboxControl(m, sandboxControl);
    shimPolicyOverride = connectPolicy;
    const connectControl = await probeRun(
      browser,
      url,
      token,
      appFor(viewerDist),
      undefined
    ).finally(() => {
      shimPolicyOverride = undefined;
    });
    checkConnectControl(m, connectControl);
    const created = await popupDetector(browser);
    check(
      `${m}: control C: a user-gesture window.open creates a popup target the check counts`,
      created >= 1,
      `popup targets created=${created}`
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  activeApp = appFor(viewerDist);
  const svgPath = join(scratch, 'drawing.svg');
  await writeFile(svgPath, svgSource());
  const published = await mcp('relic_publish', { path: svgPath, cover: false });
  assert.equal(typeof published['url'], 'string', 'publish returned no url');
  const url = String(published['url']);
  assert.ok(url.startsWith(`${origin}/`), 'published url is not the service');
  const token = await session('reader@relic.test');

  const shim = await fetch(`http://127.0.0.1:${usercontent.port}/sandbox.html`);
  const shimPolicy = shim.headers.get('content-security-policy') ?? '';
  await shim.arrayBuffer();
  const productionDirectives = [
    "default-src 'none'",
    "script-src 'sha256-",
    "frame-src 'none'",
    `frame-ancestors ${origin}`,
  ];
  check(
    'the shim is served with the production policy',
    shim.status === 200 &&
      productionDirectives.every((directive) => shimPolicy.includes(directive)),
    `status ${shim.status}; policy ${shimPolicy.slice(0, 96)}...`
  );
  check(
    'the publisher sees renderer_class image for the svg',
    published['renderer_class'] === 'image',
    `renderer_class=${String(published['renderer_class'])}`
  );

  // Control A's copy of the viewer, with the frame sandbox loosened.
  const loosenedDist = await mkdtemp(join(tmpdir(), 'relic-svg-loosened-'));
  try {
    await cp(viewerDist, loosenedDist, { recursive: true });
    const original = 'setAttribute("sandbox","allow-scripts")';
    const loosened = `setAttribute("sandbox","${LOOSENED_SANDBOX}")`;
    let rewritten = 0;
    for (const name of ['main.js', 'viewer.js']) {
      const path = join(loosenedDist, name);
      const text = await readFile(path, 'utf8');
      if (text.includes(original)) {
        await writeFile(path, text.split(original).join(loosened));
        rewritten++;
      }
    }
    check(
      'control A: the frame sandbox string was found and loosened in a copy',
      rewritten >= 1,
      `files rewritten=${rewritten}`
    );
    // Control B: the production policy plus a connection allowance for the
    // service and the external host, so the frame's own fetches can leave.
    const connectPolicy = `${shimPolicy}; connect-src ${origin} ${EXTERNAL}`;
    for (const mode of MODES) {
      await runMode(mode, url, token, loosenedDist, connectPolicy);
    }
  } finally {
    await rm(loosenedDist, { recursive: true, force: true });
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
