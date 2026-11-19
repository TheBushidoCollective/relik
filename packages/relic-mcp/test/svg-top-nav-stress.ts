/**
 * Stress probe for top-frame navigation out of the viewer's sandboxed frame.
 *
 * Each iteration opens a published relic in the production viewer, or in a
 * throwaway viewer copy whose frame grants top navigation as a positive control,
 * under one of two process models. The relic's frame makes one navigation
 * attempt. Each request that reaches interception is classified by the frame it
 * navigates (the frame id Chromium reports for it), and Chromium's refusal lines
 * are counted.
 *
 *   RELIC_CHROME_PATH=<isolated headless shell> \
 *     mise exec -- bun packages/relic-mcp/test/svg-top-nav-stress.ts
 *
 * Environment: RELIC_TOP_NAV_N (iterations per top attack per model, default 300),
 * RELIC_TOP_NAV_CONTROL_N (per attack in the positive control, default 20),
 * RELIC_TOP_NAV_CONCURRENCY (default 6), RELIC_TOP_NAV_MODES (default: both),
 * RELIC_TOP_NAV_OUT (a file for one JSON line per iteration).
 *
 * A top-frame navigation that reaches interception in the production viewer
 * stops the run and prints the frame's state at that moment.
 *
 * This is a manual probe and is not a CI step: at the defaults it runs on the
 * order of half an hour. Run it with a small RELIC_TOP_NAV_N for a quick look.
 *
 * Known labelling gap: with a real click on an anchor, the host opens a new tab
 * to the anchor's URL through `relic:open-link` (main.ts `openFrameExternalLink`).
 * That is a tab the host opened, not a navigation of the top window, but the
 * probe prints it as TOP_FRAME_ESCAPE and stops. Read `topChanged`, `hits` and
 * `popups` in the printed state to tell the two apart.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { type LimitVerdict, RateLimiter } from '@relic/server/src/ratelimit.ts';
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

type Json = Record<string, unknown>;
type Attack =
  | 'top-location'
  | 'window-open-top'
  | 'anchor-top'
  | 'anchor-top-gesture'
  | 'form-top'
  | 'self';
type Config = 'viewer' | 'positive-control';
type Classification =
  | 'top-frame navigation'
  | 'iframe self-navigation'
  | 'other';

interface AppLike {
  fetch(request: Request): Response | Promise<Response>;
}

interface Mode {
  readonly name: 'default' | 'isolated';
  readonly flags: readonly string[];
}

interface Job {
  readonly mode: Mode['name'];
  readonly config: Config;
  readonly attack: Attack;
  readonly delay: number;
  readonly index: number;
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
  readonly isNavigationRequest: boolean;
  readonly fetchFrameId: string | undefined;
  readonly networkFrameId: string | undefined;
  readonly loaderId: string | undefined;
}

interface Navigation {
  readonly event: string;
  readonly frameId: string | undefined;
  readonly url: string;
}

interface Page {
  readonly targetId: string;
  readonly sessionId: string;
  readonly browserContextId: string;
  readonly children: Map<string, Child>;
  readonly netMeta: Map<
    string,
    { frameId: string | undefined; loaderId: string | undefined }
  >;
  readonly paused: Paused[];
  readonly logs: Logged[];
  readonly navigations: Navigation[];
  readonly errors: string[];
  shimFrameId: string | undefined;
  shimCsp: string | undefined;
}

interface Browser {
  send(method: string, params?: Json, sessionId?: string): Promise<Json>;
  open(url: string, token: string): Promise<Page>;
  close(page: Page): Promise<void>;
  shutdown(): Promise<void>;
}

interface Hit {
  readonly url: string;
  readonly scope: 'page' | 'frame';
  readonly resourceType: string;
  readonly isNavigationRequest: boolean;
  readonly fetchFrameId: string | undefined;
  readonly networkFrameId: string | undefined;
  readonly loaderId: string | undefined;
  readonly classification: Classification;
}

interface Outcome {
  readonly mode: Mode['name'];
  readonly config: Config;
  readonly attack: Attack;
  readonly delay: number;
  readonly index: number;
  readonly attempts: number;
  readonly clicks: number;
  readonly frame: 'in-process' | 'out-of-process' | 'missing';
  readonly sandbox: string | null;
  readonly src: string | null;
  readonly iframeHtml: string | null;
  readonly topChanged: boolean;
  readonly topUrl: string;
  readonly mainFrameId: string | undefined;
  readonly iframeFrameId: string | undefined;
  readonly hits: readonly Hit[];
  readonly refusals: readonly string[];
  readonly navigations: readonly Navigation[];
  readonly popups: readonly string[];
  readonly clickAt: string | null;
  readonly anchorRect: string | null;
  readonly logs: readonly string[];
  readonly inputs: readonly string[];
  readonly shimCsp: string | null;
  readonly frameTree: string | null;
  readonly error: string | null;
}

interface FrameTree {
  readonly frame: { readonly id: string; readonly url: string };
  readonly childFrames?: readonly FrameTree[];
}

interface RemoteObject {
  readonly value?: unknown;
  readonly objectId?: string;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist = join(root, 'packages/relic-viewer/dist');
const bundle = join(root, 'packages/relic-mcp/dist/relic-mcp.js');
const scratch = await mkdtemp(join(tmpdir(), 'relic-top-nav-'));
const statePath = join(scratch, 'state.json');
const EXTERNAL = 'https://collector.relic-proof.invalid';
const USERCONTENT_HOST = 'relic-usercontent.test';
const LOOSENED_SANDBOX = 'allow-scripts allow-same-origin allow-top-navigation';
const TOP_ATTACKS: readonly Attack[] = [
  'top-location',
  'window-open-top',
  'anchor-top',
  'anchor-top-gesture',
  'form-top',
];
const ATTACKS: readonly Attack[] = [...TOP_ATTACKS, 'self'];
const DELAYS: readonly number[] = [0, 1500];
const SETTLE_MS = 900;
const COUNT = Number(process.env['RELIC_TOP_NAV_N'] ?? 300);
const CONTROL_COUNT = Number(process.env['RELIC_TOP_NAV_CONTROL_N'] ?? 20);
const CONCURRENCY = Number(process.env['RELIC_TOP_NAV_CONCURRENCY'] ?? 6);
const OUT = process.env['RELIC_TOP_NAV_OUT'];
const WANTED = (process.env['RELIC_TOP_NAV_MODES'] ?? 'default,isolated').split(
  ','
);
const ALL_MODES: readonly Mode[] = [
  { name: 'default', flags: [] },
  {
    name: 'isolated',
    flags: ['--site-per-process', '--enable-features=IsolateSandboxedIframes'],
  },
];
const MODES = ALL_MODES.filter((mode) => WANTED.includes(mode.name));
const REFUSAL =
  /Unsafe attempt|Blocked opening|sandbox|Refused to|Content Security Policy/i;
const MARKER_SCRIPT = `(() => {
  if (window.top !== window) return;
  window.__topNavMarks = [];
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data.kind === 'string' && data.kind.startsWith('top-nav-')) {
      window.__topNavMarks.push({ kind: data.kind, type: data.type, origin: event.origin, rect: data.rect || null });
    }
  });
})();`;

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const seen: Array<{ readonly server: string; readonly path: string }> = [];
let activeApp: AppLike | undefined;

async function handle(
  server: 'service' | 'usercontent',
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
const usercontentOrigin = `http://${USERCONTENT_HOST}:${usercontent.port}`;
const SELF_PROBE = `${usercontentOrigin}/self-navigation-probe`;
const storage = new MemoryStorage(`${origin}/__storage`);

// The probe drives every iteration from one loopback address. The app's
// per-address budgets would answer 429 before the viewer renders, so the attack
// never runs. Rate limiting is not what this probe measures, so this limiter
// never refuses.
class UnthrottledLimiter extends RateLimiter {
  override check(): LimitVerdict {
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function appFor(dist: string): AppLike {
  return createApp({
    config: { serviceOrigin: origin, usercontentOrigin },
    store,
    storage,
    assets: diskAssets(dist),
    now: () => Date.now(),
    operatorTokens,
    mailer: { send: async () => {}, sendMail: async () => {} },
    limiter: new UnthrottledLimiter(),
  });
}

// The relic's document. Each attack reports to the top window before it acts,
// so a refused attempt is still visible. The gesture attack is ready at once and
// is clicked by the harness, which is a trusted user gesture.
function attackSvg(attack: Attack, delay: number): string {
  const target =
    attack === 'self'
      ? `${SELF_PROBE}?self=1`
      : `${EXTERNAL}/navigate?from=${attack}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#e53935"/>
  <script>
    (() => {
      const attack = ${JSON.stringify(attack)};
      const url = ${JSON.stringify(target)};
      const formAction = ${JSON.stringify(`${EXTERNAL}/navigate`)};
      const mark = (kind) => window.parent.postMessage({ kind, type: attack }, '*');
      if (attack === 'anchor-top-gesture') {
        const a = document.createElement('a');
        a.textContent = 'go';
        a.setAttribute('style', 'position:absolute;left:0;top:0;width:120px;height:80px;background:#fff;font:40px sans-serif;color:#000');
        a.href = url;
        a.target = '_top';
        a.addEventListener('click', () => mark('top-nav-click'));
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) document.addEventListener(t, () => mark('top-nav-input-' + t));
        document.body.appendChild(a);
        const r = a.getBoundingClientRect();
        window.parent.postMessage({ kind: 'top-nav-attempt', type: attack, rect: { x: r.x, y: r.y, w: r.width, h: r.height } }, '*');
        return;
      }
      const run = () => {
        mark('top-nav-attempt');
        if (attack === 'top-location') {
          window.top.location = url;
        } else if (attack === 'window-open-top') {
          window.open(url, '_top');
        } else if (attack === 'anchor-top') {
          const a = document.createElement('a');
          a.href = url;
          a.target = '_top';
          document.body.appendChild(a);
          a.click();
        } else if (attack === 'form-top') {
          const f = document.createElement('form');
          f.method = 'get';
          f.action = formAction;
          f.target = '_top';
          const i = document.createElement('input');
          i.name = 'from';
          i.value = 'form-top';
          f.appendChild(i);
          document.body.appendChild(f);
          f.submit();
        } else {
          location.href = url;
        }
      };
      setTimeout(run, ${delay});
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
      RELIC_CLIENT_NAME: 'relic-mcp/top-nav-stress',
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
        clientInfo: { name: 'top-nav-stress', version: '1' },
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
  const token = `top-nav-${randomUUID()}`;
  const now = Date.now();
  await store.putSession({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    email,
    createdAt: now,
    expiresAt: now + 3_600_000,
  });
  return token;
}

function remoteValue(result: Json | undefined): unknown {
  if (result === undefined || result['exceptionDetails'] !== undefined) {
    return undefined;
  }
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

async function prepareChild(
  connection: CdpConnection,
  page: Page,
  sessionId: string,
  waiting: boolean
): Promise<void> {
  try {
    await connection.send('Network.enable', {}, sessionId);
    await connection.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );
    await connection.send('Log.enable', {}, sessionId);
  } catch (error) {
    page.errors.push(
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

// Every CDP event for a page or one of its out-of-process children.
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
      const childId = event.params['sessionId'];
      const info = event.params['targetInfo'] as
        | { readonly targetId?: string; readonly type?: string }
        | undefined;
      if (typeof childId !== 'string' || info?.targetId === undefined) return;
      page.children.set(childId, {
        sessionId: childId,
        targetId: info.targetId,
        type: info.type ?? '',
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
    case 'Network.requestWillBeSent': {
      const requestId = event.params['requestId'];
      if (typeof requestId !== 'string') return;
      const frameId = event.params['frameId'];
      const loaderId = event.params['loaderId'];
      const request = event.params['request'] as
        | { readonly url?: string }
        | undefined;
      page.netMeta.set(requestId, {
        frameId: typeof frameId === 'string' ? frameId : undefined,
        loaderId: typeof loaderId === 'string' ? loaderId : undefined,
      });
      if (
        request?.url === `${usercontentOrigin}/sandbox.html` &&
        page.shimFrameId === undefined &&
        typeof frameId === 'string'
      ) {
        page.shimFrameId = frameId;
      }
      return;
    }
    case 'Network.responseReceived': {
      const response = event.params['response'] as
        | { readonly url?: string; readonly headers?: Record<string, string> }
        | undefined;
      if (response?.url === `${usercontentOrigin}/sandbox.html`) {
        page.shimCsp = response.headers?.['content-security-policy'];
      }
      return;
    }
    case 'Fetch.requestPaused': {
      const requestId = event.params['requestId'];
      if (typeof requestId !== 'string') return;
      const request = event.params['request'] as
        | { readonly url?: string }
        | undefined;
      const url = request?.url ?? '';
      const resourceType = event.params['resourceType'];
      const frameId = event.params['frameId'];
      const networkId = event.params['networkId'];
      const meta =
        typeof networkId === 'string' ? page.netMeta.get(networkId) : undefined;
      page.paused.push({
        scope,
        url,
        resourceType: typeof resourceType === 'string' ? resourceType : '',
        isNavigationRequest: event.params['isNavigationRequest'] === true,
        fetchFrameId: typeof frameId === 'string' ? frameId : undefined,
        networkFrameId: meta?.frameId,
        loaderId: meta?.loaderId,
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
    case 'Page.frameRequestedNavigation':
    case 'Page.frameStartedNavigating': {
      const frameId = event.params['frameId'];
      const url = event.params['url'];
      page.navigations.push({
        event: event.method,
        frameId: typeof frameId === 'string' ? frameId : undefined,
        url: typeof url === 'string' ? url : '',
      });
      return;
    }
    case 'Log.entryAdded': {
      const entry = event.params['entry'] as
        | { readonly text?: string }
        | undefined;
      page.logs.push({ scope, text: entry?.text ?? '' });
      return;
    }
    case 'Page.javascriptDialogOpening':
      void connection
        .send('Page.handleJavaScriptDialog', { accept: true }, sessionId)
        .catch(() => {});
      return;
    default:
      return;
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
  const profile = await mkdtemp(join(tmpdir(), 'relic-top-nav-chrome-'));
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
    connection.onEvent((event) => {
      const sessionId = event.sessionId;
      if (sessionId === undefined) return;
      const page = pages.get(sessionId);
      if (page !== undefined) {
        onPageEvent(connection, pages, page, sessionId, event);
      }
    });
    return {
      send: (method, params, sessionId) =>
        connection.send(method, params, sessionId),
      async open(url, token) {
        const created = await connection.send('Target.createBrowserContext', {
          disposeOnDetach: true,
        });
        const browserContextId = String(created['browserContextId']);
        const target = await connection.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId,
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
          browserContextId,
          children: new Map(),
          netMeta: new Map(),
          paused: [],
          logs: [],
          navigations: [],
          errors: [],
          shimFrameId: undefined,
          shimCsp: undefined,
        };
        pages.set(sessionId, page);
        await connection.send('Page.enable', {}, sessionId);
        await connection.send('Log.enable', {}, sessionId);
        await connection.send('Network.enable', {}, sessionId);
        await connection.send(
          'Network.setCacheDisabled',
          { cacheDisabled: true },
          sessionId
        );
        await connection.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: MARKER_SCRIPT },
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
      async close(page) {
        pages.delete(page.sessionId);
        for (const child of page.children.values()) {
          pages.delete(child.sessionId);
        }
        await connection
          .send('Target.closeTarget', { targetId: page.targetId })
          .catch(() => {});
        await connection
          .send('Target.disposeBrowserContext', {
            browserContextId: page.browserContextId,
          })
          .catch(() => {});
      },
      async shutdown() {
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

// The frame a navigation targets. Chromium reports the target frame's id for a
// navigation, even when the script that started it runs in another frame
// (calibrated: a top-location assignment from the iframe carries the main frame's id).
function classify(
  hit: Paused,
  mainFrameId: string | undefined,
  iframeFrameId: string | undefined
): Classification {
  if (hit.resourceType !== 'Document') return 'other';
  const target = hit.networkFrameId ?? hit.fetchFrameId;
  if (target === undefined) return 'other';
  if (target === mainFrameId) return 'top-frame navigation';
  if (target === iframeFrameId) return 'iframe self-navigation';
  return 'other';
}

// Requests that belong to an attack: the collector, and the self-navigation
// probe. The page's own loads and the shim's first load are not attacks.
function isAttackRequest(url: string): boolean {
  return url.startsWith(EXTERNAL) || url.startsWith(SELF_PROBE);
}

function sameDocument(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

async function frameFacts(
  browser: Browser,
  page: Page
): Promise<{
  sandbox: string | null;
  src: string | null;
  html: string | null;
} | null> {
  const value = await pageRead(
    browser,
    page,
    "(() => { const f = document.querySelector('iframe.usercontent-frame'); return f ? { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), html: f.outerHTML.slice(0, 400) } : null; })()"
  );
  if (value === null || typeof value !== 'object') return null;
  // The viewer's iframe element, read as data; each field is checked.
  const fields = value as Json;
  const { sandbox, src, html } = fields;
  return {
    sandbox: typeof sandbox === 'string' ? sandbox : null,
    src: typeof src === 'string' ? src : null,
    html: typeof html === 'string' ? html : null,
  };
}

// The marks the relic's document has posted to the top window, in order.
async function marksOf(
  browser: Browser,
  page: Page
): Promise<Array<{ kind: string; rect: string | null }>> {
  const value = await pageRead(
    browser,
    page,
    'JSON.stringify((window.__topNavMarks || []).map((mark) => ({ kind: mark.kind, rect: mark.rect ? JSON.stringify(mark.rect) : null })))'
  );
  if (typeof value !== 'string') return [];
  return (
    JSON.parse(value) as Array<{ kind: string; rect: string | null }>
  ).filter((mark) => typeof mark.kind === 'string');
}

// The trusted click on the gesture attack's link, at the frame's top-left corner.
// Returns what the top document has under the point, so a missed click is visible.
async function gestureClick(browser: Browser, page: Page): Promise<string> {
  const rect = await pageRead(
    browser,
    page,
    "(() => { const f = document.querySelector('iframe.usercontent-frame'); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; })()"
  );
  if (rect === null || typeof rect !== 'object') return 'no-frame';
  const point = rect as { readonly x?: unknown; readonly y?: unknown };
  if (typeof point.x !== 'number' || typeof point.y !== 'number') {
    return 'no-frame';
  }
  const x = point.x + 24;
  const y = point.y + 24;
  const under = await pageRead(
    browser,
    page,
    `(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? el.tagName + '.' + String(el.getAttribute('class')) : 'none'; })()`
  );
  await browser.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y },
    page.sessionId
  );
  await browser.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    page.sessionId
  );
  await browser.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    page.sessionId
  );
  return typeof under === 'string' ? under : 'unknown';
}

async function observe(
  browser: Browser,
  page: Page,
  job: Job,
  viewerUrl: string
): Promise<Outcome> {
  const tree = (await browser.send(
    'Page.getFrameTree',
    {},
    page.sessionId
  )) as Json;
  const frameTree = tree['frameTree'] as FrameTree | undefined;
  const mainFrameId = frameTree?.frame.id;
  const started = Date.now();
  let attempts = 0;
  let clicks = 0;
  let clicked = false;
  let clickAt: string | null = null;
  let anchorRect: string | null = null;
  let inputs: string[] = [];
  let attemptAt: number | undefined;
  let facts: Awaited<ReturnType<typeof frameFacts>> = null;
  let topChanged = false;
  let topUrl = viewerUrl;
  while (Date.now() - started < job.delay + 8_000) {
    const info = (await browser
      .send('Target.getTargetInfo', { targetId: page.targetId })
      .catch((): Json => ({}))) as Json;
    const targetInfo = info['targetInfo'] as
      | { readonly url?: string }
      | undefined;
    topUrl = targetInfo?.url ?? viewerUrl;
    if (!sameDocument(topUrl, viewerUrl)) {
      topChanged = true;
      break;
    }
    const marks = await marksOf(browser, page);
    inputs = [
      ...new Set(
        marks
          .map((mark) => mark.kind)
          .filter((kind) => kind.startsWith('top-nav-input-'))
      ),
    ];
    attempts = marks.filter((mark) => mark.kind === 'top-nav-attempt').length;
    clicks = marks.filter((mark) => mark.kind === 'top-nav-click').length;
    anchorRect ??=
      marks.find(
        (mark) => mark.kind === 'top-nav-attempt' && mark.rect !== null
      )?.rect ?? null;
    if (attempts > 0) {
      attemptAt ??= Date.now();
      facts ??= await frameFacts(browser, page);
      if (
        job.attack === 'anchor-top-gesture' &&
        !clicked &&
        Date.now() - attemptAt >= job.delay
      ) {
        clicked = true;
        clickAt = await gestureClick(browser, page);
      }
      const ready = job.attack !== 'anchor-top-gesture' || clicked;
      if (ready && Date.now() - attemptAt >= SETTLE_MS) break;
    }
    await Bun.sleep(50);
  }
  if (topChanged) {
    const latest = (await browser
      .send('Target.getTargetInfo', { targetId: page.targetId })
      .catch((): Json => ({}))) as Json;
    const latestInfo = latest['targetInfo'] as
      | { readonly url?: string }
      | undefined;
    topUrl = latestInfo?.url ?? topUrl;
  }
  const iframeFrameId =
    [...page.children.values()].find((child) => child.type === 'iframe')
      ?.targetId ?? page.shimFrameId;
  const frame: Outcome['frame'] = [...page.children.values()].some(
    (child) => child.type === 'iframe'
  )
    ? 'out-of-process'
    : facts !== null
      ? 'in-process'
      : 'missing';
  const hits: Hit[] = page.paused
    .filter((item) => isAttackRequest(item.url))
    .map((item) => ({
      url: item.url,
      scope: item.scope,
      resourceType: item.resourceType,
      isNavigationRequest: item.isNavigationRequest,
      fetchFrameId: item.fetchFrameId,
      networkFrameId: item.networkFrameId,
      loaderId: item.loaderId,
      classification: classify(item, mainFrameId, iframeFrameId),
    }));
  // A popup is a separate top-level window, so the page session's Fetch events
  // never see its requests. List popups from the browser's target table.
  const targets = (await browser
    .send('Target.getTargets', {})
    .catch((): Json => ({}))) as Json;
  const targetInfos = (targets['targetInfos'] ?? []) as Array<{
    readonly type?: string;
    readonly openerId?: string;
    readonly url?: string;
  }>;
  const popups = targetInfos
    .filter((item) => item.type === 'page' && item.openerId === page.targetId)
    .map((item) => item.url ?? '');
  return {
    mode: job.mode,
    config: job.config,
    attack: job.attack,
    delay: job.delay,
    index: job.index,
    attempts,
    clicks,
    frame,
    sandbox: facts?.sandbox ?? null,
    src: facts?.src ?? null,
    iframeHtml: facts?.html ?? null,
    topChanged,
    topUrl,
    mainFrameId,
    iframeFrameId,
    hits,
    refusals: page.logs
      .filter((line) => REFUSAL.test(line.text))
      .map((line) => line.text.slice(0, 160)),
    logs: page.logs.slice(0, 4).map((line) => line.text.slice(0, 160)),
    inputs,
    navigations: page.navigations,
    popups,
    clickAt,
    anchorRect,
    shimCsp: page.shimCsp ?? null,
    frameTree: topChanged
      ? JSON.stringify(
          (
            await browser
              .send('Page.getFrameTree', {}, page.sessionId)
              .catch((): Json => ({}))
          )['frameTree']
        ).slice(0, 1500)
      : null,
    error: null,
  };
}

function errorOutcome(job: Job, error: unknown): Outcome {
  return {
    mode: job.mode,
    config: job.config,
    attack: job.attack,
    delay: job.delay,
    index: job.index,
    attempts: 0,
    clicks: 0,
    frame: 'missing',
    sandbox: null,
    src: null,
    iframeHtml: null,
    topChanged: false,
    topUrl: '',
    mainFrameId: undefined,
    iframeFrameId: undefined,
    hits: [],
    refusals: [],
    navigations: [],
    popups: [],
    clickAt: null,
    anchorRect: null,
    logs: [],
    inputs: [],
    shimCsp: null,
    frameTree: null,
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
}

async function runJob(
  browser: Browser,
  job: Job,
  urls: Map<string, string>,
  token: string
): Promise<Outcome> {
  const viewerUrl = urls.get(`${job.attack}:${job.delay}`);
  if (viewerUrl === undefined) {
    return errorOutcome(job, new Error('no relic for this attack'));
  }
  let page: Page | undefined;
  try {
    page = await browser.open(viewerUrl, token);
    return await observe(browser, page, job, viewerUrl);
  } catch (error) {
    return errorOutcome(job, error);
  } finally {
    if (page !== undefined) await browser.close(page);
  }
}

// Jobs run in lanes; a lane stops taking work once a stop is requested.
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
  stop: () => boolean
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: concurrency }, async () => {
    while (!stop() && cursor < items.length) {
      const item = items[cursor];
      cursor++;
      if (item === undefined) break;
      await task(item);
    }
  });
  await Promise.all(lanes);
}

function jobsFor(config: Config): Job[] {
  const jobs: Job[] = [];
  const perAttack = config === 'viewer' ? COUNT : CONTROL_COUNT;
  const selfCount = Math.max(
    1,
    Math.floor(perAttack / (config === 'viewer' ? 6 : 2))
  );
  let delayIndex = 0;
  for (const attack of ATTACKS) {
    const count = attack === 'self' ? selfCount : perAttack;
    for (let i = 0; i < count; i++) {
      const delay = DELAYS[delayIndex % DELAYS.length] ?? 0;
      jobs.push({
        mode: 'default',
        config,
        attack,
        delay,
        index: i,
      });
      delayIndex++;
    }
  }
  return jobs;
}

async function main(): Promise<void> {
  activeApp = appFor(viewerDist);
  const token = await session('reader@relic.test');
  const urls = new Map<string, string>();
  for (const attack of ATTACKS) {
    for (const delay of DELAYS) {
      const path = join(scratch, `${attack}-${delay}.svg`);
      await writeFile(path, attackSvg(attack, delay));
      const published = await mcp('relic_publish', { path, cover: false });
      urls.set(`${attack}:${delay}`, String(published['url']));
    }
  }
  console.log(`PUBLISHED ${urls.size} attack relics`);

  // The positive control: a copy of the viewer whose frame may navigate the top.
  const loosenedDist = await mkdtemp(join(tmpdir(), 'relic-top-nav-loosened-'));
  await cp(viewerDist, loosenedDist, { recursive: true });
  const original = 'setAttribute("sandbox","allow-scripts")';
  for (const name of ['main.js', 'viewer.js']) {
    const path = join(loosenedDist, name);
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.split(original).join(`setAttribute("sandbox","${LOOSENED_SANDBOX}")`)
    );
  }

  const outcomes: Outcome[] = [];
  let topEscape: Outcome | undefined;
  const record = async (outcome: Outcome): Promise<void> => {
    outcomes.push(outcome);
    if (OUT !== undefined) {
      await appendFile(OUT, `${JSON.stringify(outcome)}\n`);
    }
    if (
      outcome.config === 'viewer' &&
      (outcome.hits.some(
        (hit) => hit.classification === 'top-frame navigation'
      ) ||
        outcome.popups.some((url) => isAttackRequest(url)))
    ) {
      topEscape ??= outcome;
    }
    if (outcomes.length % 100 === 0) {
      console.log(`PROGRESS ${outcomes.length} iterations`);
    }
  };

  try {
    for (const mode of MODES) {
      const browser = await launchBrowser(mode);
      try {
        for (const config of ['viewer', 'positive-control'] as const) {
          activeApp =
            config === 'viewer' ? appFor(viewerDist) : appFor(loosenedDist);
          const jobs = jobsFor(config).map((job) => ({
            ...job,
            mode: mode.name,
          }));
          console.log(`RUN ${mode.name} ${config} jobs=${jobs.length}`);
          await runPool(
            jobs,
            CONCURRENCY,
            async (job) => {
              await record(await runJob(browser, job, urls, token));
            },
            () => topEscape !== undefined
          );
          if (topEscape !== undefined) break;
        }
      } finally {
        await browser.shutdown();
      }
      if (topEscape !== undefined) break;
    }
  } finally {
    await rm(loosenedDist, { recursive: true, force: true });
  }

  if (topEscape !== undefined) {
    console.log(`TOP_FRAME_ESCAPE ${JSON.stringify(topEscape, null, 1)}`);
    process.exitCode = 3;
  }
  const unattempted = outcomes.filter(
    (outcome) => outcome.config === 'viewer' && outcome.attempts === 0
  ).length;
  if (unattempted > 0) {
    console.log(`UNATTEMPTED viewer jobs=${unattempted}`);
    process.exitCode = 4;
  }
  summarize(outcomes);
}

function summarize(outcomes: readonly Outcome[]): void {
  const groups = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const key = `${outcome.mode} ${outcome.config} ${outcome.attack}`;
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  for (const [key, items] of groups) {
    const count = (predicate: (item: Outcome) => boolean) =>
      items.filter(predicate).length;
    const top = count((item) =>
      item.hits.some((hit) => hit.classification === 'top-frame navigation')
    );
    const self = count((item) =>
      item.hits.some((hit) => hit.classification === 'iframe self-navigation')
    );
    const other = count((item) =>
      item.hits.some((hit) => hit.classification === 'other')
    );
    const unsafe = count((item) =>
      item.refusals.some((line) => /Unsafe attempt/.test(line))
    );
    const sandboxes = [
      ...new Set(items.map((item) => String(item.sandbox))),
    ].join(' | ');
    const frames = [...new Set(items.map((item) => item.frame))].join(',');
    const popupEscapes = count((item) =>
      item.popups.some((url) => isAttackRequest(url))
    );
    const popupTotal = items.reduce((sum, item) => sum + item.popups.length, 0);
    const clickUnder = [
      ...new Set(
        items.map(
          (item) =>
            `${item.clickAt ?? '-'} inputs=${[...new Set(item.inputs)].join('/') || '-'}`
        )
      ),
    ];
    const rects = [...new Set(items.map((item) => item.anchorRect ?? '-'))];
    console.log(
      `SUMMARY ${key}: n=${items.length} attempted=${count((item) => item.attempts > 0)} clicked=${count((item) => item.clicks > 0)} top-frame-jobs=${top} iframe-self-jobs=${self} other-jobs=${other} unsafe-attempt-jobs=${unsafe} top-url-changed=${count((item) => item.topChanged)} popups=${popupTotal} popup-escapes=${popupEscapes} errors=${count((item) => item.error !== null)} sandbox=[${sandboxes}] frame=[${frames}] click-under=[${clickUnder.slice(0, 3).join(' | ')}] anchor-rect=[${rects.slice(0, 2).join(' | ')}]`
    );
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
if (failure !== undefined) {
  console.error(`TOP_NAV_STRESS_FAILED ${failure}`);
  process.exitCode = 1;
}
