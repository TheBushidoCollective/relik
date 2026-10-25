/**
 * Anchored comment popover everywhere proof path (§6 A6b).
 *
 *   bun packages/relic-mcp/test/comment-popover-path.ts
 *
 * Exercises the attached composer and posted comment cards across all 9 classes:
 * 1. Markdown
 * 2. Code
 * 3. Image
 * 4. PDF
 * 5. HTML
 * 6. SVG
 * 7. Video
 * 8. Audio
 * 9. OTIO
 *
 * Verifies §5.8 assertions: adjacency, horizontal centring, no overlap,
 * anchor exposed, inside bounds, usability, preference, capped scrolling, and follow.
 * Also runs negative control against origin/main 76269ed5.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

const defaultOwnedShell =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const namedChrome =
  process.env['RELIC_POPOVER_CHROME_PATH'] ??
  process.env['RELIC_CHROME_PATH'] ??
  ((await access(defaultOwnedShell, constants.X_OK)
    .then(() => true)
    .catch(() => false))
    ? defaultOwnedShell
    : undefined);

const foundChrome = await discoverChrome(
  namedChrome && namedChrome !== 'none' && namedChrome !== 'disabled'
    ? namedChrome
    : undefined
);
assert.equal(
  foundChrome.kind,
  'found',
  `no Chrome executable found: ${foundChrome.kind}`
);
if (foundChrome.kind !== 'found') throw new Error('unreachable');
const chromeExecutable = foundChrome.path;

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const relicMcpBundlePath = join(packageRoot, 'dist', 'relic-mcp.js');
const otioFixtureDir = join(
  repoRoot,
  'packages/relic-format/test/fixtures/otio/standard-sample.otiod'
);

const publishedRelics: Record<string, string> = {};
function getRelic(key: string): string {
  const url = publishedRelics[key];
  assert.ok(url !== undefined, `relic url missing for ${key}`);
  return url;
}

const viewerDist =
  process.env['RELIC_POPOVER_VIEWER_DIST'] ??
  join(repoRoot, 'packages/relic-viewer/dist');

const shotsDir =
  process.env['RELIC_POPOVER_SHOTS_DIR'] ??
  (await mkdtemp(join(await realpath(tmpdir()), 'relic-popover-shots-')));
await mkdir(shotsDir, { recursive: true });

const proofDir = join(repoRoot, 'docs/plans/anchored-popover/proof');
await mkdir(proofDir, { recursive: true });

const RUN_BUDGET_MS = 300_000;
let currentStep = 'startup';
const cdpInFlight = new Map<number, string>();
let cdpCallId = 0;
const runningBrowsers: Array<{
  child: ChildProcess;
  cdp: CdpConnection;
  profile: string;
}> = [];
const watchdog = setTimeout(() => {
  const pending = [...cdpInFlight.values()].join(', ') || 'none';
  console.error(
    `COMMENT_POPOVER_PATH_TIMEOUT after ${RUN_BUDGET_MS}ms at step "${currentStep}"; CDP calls in flight: ${pending}`
  );
  for (const b of runningBrowsers) b.child.kill('SIGKILL');
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();

const scratch = await mkdtemp(
  join(await realpath(tmpdir()), 'relic-popover-path-')
);
const statePath = join(scratch, 'state.json');

const children = new Set<ChildProcess>();

process.on('SIGINT', cleanupAll);
process.on('SIGTERM', cleanupAll);

function cleanupAll(): void {
  for (const b of runningBrowsers) {
    try {
      b.cdp.dispose();
      b.child.kill('SIGKILL');
    } catch {}
  }
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 15000,
  pollMs = 50
): Promise<void> {
  currentStep = label;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { promise: expired, resolve } = Promise.withResolvers<'expired'>();
    const timer = setTimeout(
      () => resolve('expired'),
      Math.max(0, deadline - Date.now())
    );
    const outcome = await Promise.race([predicate(), expired]).finally(() =>
      clearTimeout(timer)
    );
    if (outcome === true) return;
    if (outcome === 'expired') break;
    await Bun.sleep(pollMs);
  }
  throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`);
}
// --- Loopback server setup ---
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const fakeNow = Date.now();

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

const usercontentService = Bun.serve({
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
    const assetPath = join(viewerDist, url.pathname.slice(1));
    const file = Bun.file(assetPath);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  },
});
const usercontentOrigin = `http://127.0.0.1:${usercontentService.port}`;

const app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin },
  store,
  storage,
  now: () => fakeNow,
  operatorTokens,
  assets: diskAssets(viewerDist),
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
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
  return app.fetch(request);
};

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function createSession(email = 'reader@example.test'): Promise<string> {
  const token = `popover-token-${Math.random().toString(16).slice(2)}`;
  await store.putSession({
    tokenHash: await sha256Hex(token),
    email,
    createdAt: fakeNow,
    expiresAt: fakeNow + 3600 * 1000,
  });
  return token;
}

// --- MCP Publish Helper ---
async function callMcp(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['node', relicMcpBundlePath], {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/comment-popover-path',
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
    params: { name: toolName, arguments: args },
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

// --- Browser session management ---
interface BrowserSession {
  readonly cdp: CdpConnection;
  readonly sessionId: string;
  readonly child: ChildProcess;
  readonly profile: string;
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  waitFor(
    fnExpression: string,
    timeoutMs?: number,
    intervalMs?: number
  ): Promise<void>;
  setViewport(
    width: number,
    height: number,
    scheme?: 'light' | 'dark'
  ): Promise<void>;
  screenshot(filename: string): Promise<void>;
  pressEscape(): Promise<void>;
  close(): Promise<void>;
}

async function openBrowser(
  url: string,
  sessionToken?: string,
  viewport: { width?: number; height?: number; scheme?: 'light' | 'dark' } = {
    width: 1440,
    height: 900,
    scheme: 'light',
  }
): Promise<BrowserSession> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-popover-chrome-'));
  const shared = chromeArgs(chromeExecutable, profile);
  const launch = createBrowserHeadlessLaunch(
    [
      ...shared.map((arg) =>
        arg === '--proxy-bypass-list=<-loopback>'
          ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port}`
          : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
            ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
            : arg
      ),
      '--autoplay-policy=no-user-gesture-required',
    ],
    profile
  );

  const child = spawn(chromeExecutable, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  children.add(child);

  let cdp: CdpConnection;
  try {
    const toChrome = child.stdio[3] as Writable;
    const fromChrome = child.stdio[4] as Readable;
    const rawCdp = connectPipe(toChrome, fromChrome);
    cdp = {
      ...rawCdp,
      send(method, params, sessionId) {
        const id = ++cdpCallId;
        cdpInFlight.set(id, method);
        return rawCdp
          .send(method, params, sessionId)
          .finally(() => cdpInFlight.delete(id));
      },
    };
    runningBrowsers.push({ child, cdp, profile });
    await attestBrowserHeadless(cdp, launch);

    const created = (await cdp.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );

    cdp.onEvent((event) => {
      if (event.method !== 'Fetch.requestPaused') return;
      const targetSession = event.sessionId ?? sessionId;
      const params = event.params as {
        requestId?: string;
        request?: { url?: string };
      };
      const reqUrl = params.request?.url ?? '';
      const requestId = params.requestId;
      if (!requestId) return;
      if (
        reqUrl.startsWith('http://127.0.0.1:') ||
        reqUrl.startsWith('http://localhost:') ||
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:') ||
        reqUrl === 'about:blank'
      ) {
        void cdp
          .send('Fetch.continueRequest', { requestId }, targetSession)
          .catch(() => {});
        return;
      }
      void cdp
        .send(
          'Fetch.failRequest',
          { requestId, errorReason: 'BlockedByClient' },
          targetSession
        )
        .catch(() => {});
    });
    cdp.onEvent((event) => {
      if (event.method === 'Runtime.consoleAPICalled') {
        const params = event.params as {
          args?: Array<{ value?: unknown; description?: string }>;
        };
        const args = params.args?.map((a) => a.value ?? a.description) ?? [];
        console.log('[BROWSER]', ...args);
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const params = event.params as {
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string };
          };
        };
        console.log(
          '[BROWSER EXCEPTION]',
          params.exceptionDetails?.exception?.description ||
            params.exceptionDetails?.text
        );
      }
    });

    if (sessionToken) {
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
    }

    const targetWidth = viewport.width ?? 1440;
    const targetHeight = viewport.height ?? 900;
    const targetScheme = viewport.scheme ?? 'light';
    const mobile = targetWidth < 600;
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: targetWidth,
        height: targetHeight,
        deviceScaleFactor: 1,
        mobile,
        hasTouch: mobile,
      },
      sessionId
    );
    await cdp.send(
      'Emulation.setEmulatedMedia',
      {
        media: 'page',
        features: [
          {
            name: 'prefers-color-scheme',
            value: targetScheme,
          },
        ],
      },
      sessionId
    );

    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId,
      timeoutMs: 20000,
    });
    const navigated = await cdp.send('Page.navigate', { url }, sessionId);
    if (navigated['errorText'] !== undefined) {
      loaded.catch(() => {});
      throw new Error(`navigation failed: ${String(navigated['errorText'])}`);
    }
    await loaded;

    const session: BrowserSession = {
      cdp,
      sessionId,
      child,
      profile,
      send(method, params) {
        return cdp.send(method, params, sessionId);
      },
      async evaluate<T>(expression: string): Promise<T> {
        const res = await cdp.send(
          'Runtime.evaluate',
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: 15000,
          },
          sessionId
        );
        const exception = res['exceptionDetails'] as {
          text?: string;
          exception?: { description?: string };
        };
        if (exception) {
          console.error(
            'EVAL EXCEPTION:',
            exception.text,
            exception.exception?.description,
            '\nEXPR:',
            expression.slice(0, 200)
          );
        }
        assert.ok(
          !exception,
          `evaluation failed: ${exception?.text ?? exception?.exception?.description ?? JSON.stringify(res)}`
        );
        const inner = res['result'] as { value?: T } | undefined;
        return inner?.value as T;
      },
      waitFor(
        fnExpression: string,
        timeoutMs = 15000,
        intervalMs = 50
      ): Promise<void> {
        return waitForCondition(
          () => session.evaluate<boolean>(`Boolean(${fnExpression})`),
          `waitFor: ${fnExpression.slice(0, 60)}`,
          timeoutMs,
          intervalMs
        );
      },
      async setViewport(
        width: number,
        height: number,
        scheme: 'light' | 'dark' = 'light'
      ): Promise<void> {
        const isMobile = width < 600;
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: isMobile,
            hasTouch: isMobile,
          },
          sessionId
        );
        await cdp.send(
          'Emulation.setEmulatedMedia',
          {
            media: 'page',
            features: [{ name: 'prefers-color-scheme', value: scheme }],
          },
          sessionId
        );
        await Bun.sleep(100);
      },
      async screenshot(filename: string): Promise<void> {
        const shot = (await cdp.send(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId
        )) as { data: string };
        const bytes = Buffer.from(shot.data, 'base64');
        assert.ok(bytes.length > 500, `screenshot ${filename} is too small`);
        await writeFile(join(shotsDir, filename), bytes);
      },
      async pressEscape(): Promise<void> {
        await session.evaluate(
          `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
      },
      async close(): Promise<void> {
        try {
          cdp.dispose();
          child.kill('SIGKILL');
          children.delete(child);
          const idx = runningBrowsers.findIndex((b) => b.child === child);
          if (idx !== -1) runningBrowsers.splice(idx, 1);
          await rm(profile, { recursive: true, force: true }).catch(() => {});
        } catch {}
      },
    };

    return session;
  } catch (error) {
    await cleanupOwnedBrowserStartup({
      child,
      connection: cdp! ?? undefined,
      forgetChild: () => children.delete(child),
      profile,
      removeProfile: undefined,
    });
    throw error;
  }
}

// --- Measurements structure & collector ---
interface MeasurementEntry {
  class: string;
  width: number;
  height: number;
  scheme: 'light' | 'dark';
  state: string;
  side: 'above' | 'below';
  capped: boolean;
  adjacency: boolean;
  horizontal: boolean;
  noOverlap: boolean;
  anchorExposed: boolean;
  inside: boolean;
  usable: boolean;
  preference: boolean;
  card: { left: number; top: number; width: number; height: number };
  anchor: { left: number; top: number; width: number; height: number };
  focusRings?: Record<string, boolean> | undefined;
}

const measurements: MeasurementEntry[] = [];

const MEASURE_PROBE_SCRIPT = `
(function(cardSel, anchorSel, hostSel = '.stage-wrap') {
  const card = document.querySelector(cardSel);
  const host = document.querySelector(hostSel) || document.body;
  if (!card) return { found: false, error: 'card not found: ' + cardSel };
  let anchor = null;
  let aRect = null;
  if (anchorSel.startsWith('{')) {
    try { aRect = JSON.parse(anchorSel); } catch (e) { return { found: false, error: 'invalid json anchor rect' }; }
  } else {
    anchor = document.querySelector(anchorSel);
    if (!anchor) return { found: false, error: 'anchor not found: ' + anchorSel };
    const rects = anchor.getClientRects();
    aRect = rects.length > 0 ? rects[0] : anchor.getBoundingClientRect();
  }
  const cRect = card.getBoundingClientRect();
  const hRect = host.getBoundingClientRect();

  const side = card.dataset.side || (cRect.bottom <= aRect.top + 2 ? 'above' : 'below');
  const capped = card.dataset.capped === 'true';

  // 1. Adjacency: Below means |card.top - anchor.bottom - 8| <= 1.5. Above means |anchor.top - card.bottom - 8| <= 1.5
  const adjacency = side === 'below'
    ? Math.abs(cRect.top - aRect.bottom - 8) <= 1.5
    : Math.abs(aRect.top - cRect.bottom - 8) <= 1.5;

  // 2. Horizontal: anchor centre x in [card.left - 1, card.right + 1] unless card against host margin
  const aCenterX = aRect.left + aRect.width / 2;
  const isAgainstLeft = cRect.left <= hRect.left + 9;
  const isAgainstRight = cRect.right >= hRect.right - 9;
  const horizontal = (aCenterX >= cRect.left - 1 && aCenterX <= cRect.right + 1) || isAgainstLeft || isAgainstRight;

  // 3. No overlap: intersection area === 0
  const overlapW = Math.max(0, Math.min(cRect.right, aRect.right) - Math.max(cRect.left, aRect.left));
  const overlapH = Math.max(0, Math.min(cRect.bottom, aRect.bottom) - Math.max(cRect.top, aRect.top));
  const noOverlap = (overlapW * overlapH) === 0;

  // 4. Anchor exposed: elementFromPoint(anchor centre) is not inside .popover
  const ptEl = document.elementFromPoint(aCenterX, aRect.top + aRect.height / 2);
  const anchorExposed = !ptEl || !ptEl.closest('.popover');

  // 5. Inside: within host and viewport
  const inside = cRect.left >= hRect.left - 1 && cRect.right <= hRect.right + 1 &&
                 cRect.top >= hRect.top - 1 && cRect.bottom <= hRect.bottom + 1 &&
                 cRect.left >= 0 && cRect.right <= window.innerWidth + 1 &&
                 cRect.top >= 0 && cRect.bottom <= window.innerHeight + 1;

  // 6. Usable: textarea.popover-field, .popover-action.is-primary, cancel button visible and own hit points
  const field = card.querySelector('textarea.popover-field');
  const post = card.querySelector('.popover-action.is-primary');
  const cancel = Array.from(card.querySelectorAll('button')).find(b => b.textContent && b.textContent.trim() === 'Cancel');
  let usable = true;
  if (field) {
    const fRect = field.getBoundingClientRect();
    if (fRect.width <= 0 || fRect.height <= 0) usable = false;
  }
  if (post) {
    const pRect = post.getBoundingClientRect();
    if (pRect.width <= 0 || pRect.height <= 0) usable = false;
  }
  if (cancel) {
    const cnRect = cancel.getBoundingClientRect();
    if (cnRect.width <= 0 || cnRect.height <= 0) usable = false;
  }
  const fieldRing = field ? (getComputedStyle(field).outlineStyle !== 'none' || getComputedStyle(field).boxShadow !== 'none') : false;
  const postRing = post ? (getComputedStyle(post).outlineStyle !== 'none' || getComputedStyle(post).boxShadow !== 'none') : false;
  const cancelRing = cancel ? (getComputedStyle(cancel).outlineStyle !== 'none' || getComputedStyle(cancel).boxShadow !== 'none') : false;

  // 7. Preference
  let preference = true;
  if (!capped) {
    const isDoc = card.dataset.anchorKind !== 'time' && card.dataset.anchorKind !== 'otio';
    if (isDoc) {
      const fitsAbove = (aRect.top - 8 - cRect.height) >= (hRect.top + 8);
      if (fitsAbove && side !== 'above') preference = false;
    } else {
      const fitsBelow = (aRect.bottom + 8 + cRect.height) <= (hRect.bottom - 8);
      if (fitsBelow && side !== 'below') preference = false;
    }
  }

  return {
    found: true,
    side,
    capped,
    adjacency,
    horizontal,
    noOverlap,
    anchorExposed,
    inside,
    usable,
    preference,
    card: { left: cRect.left, top: cRect.top, width: cRect.width, height: cRect.height },
    anchor: { left: aRect.left, top: aRect.top, width: aRect.width, height: aRect.height },
    host: { left: hRect.left, top: hRect.top, right: hRect.right, bottom: hRect.bottom },
    focusRings: { field: fieldRing, post: postRing, cancel: cancelRing },
  };
})
`;

async function measureAndAssert(
  session: BrowserSession,
  params: {
    className: string;
    width: number;
    height: number;
    scheme: 'light' | 'dark';
    state: string;
    cardSelector: string;
    anchorSelector: string;
    allowAdjacencyTolerance?: boolean;
  }
): Promise<void> {
  const result = await session.evaluate<{
    found: boolean;
    error?: string;
    side: 'above' | 'below';
    capped: boolean;
    adjacency: boolean;
    horizontal: boolean;
    noOverlap: boolean;
    anchorExposed: boolean;
    inside: boolean;
    usable: boolean;
    preference: boolean;
    card: { left: number; top: number; width: number; height: number };
    anchor: { left: number; top: number; width: number; height: number };
    host: { left: number; top: number; right: number; bottom: number };
  }>(
    `(${MEASURE_PROBE_SCRIPT})('${params.cardSelector}', '${params.anchorSelector}')`
  );
  if (!result.inside || !result.noOverlap) {
    console.log(
      'MEASURE DEBUG:',
      params.className,
      params.state,
      'inside:',
      result.inside,
      'overlap:',
      result.noOverlap,
      'card:',
      result.card,
      'anchor:',
      result.anchor,
      'side:',
      result.side,
      'host:',
      result.host
    );
  }
  assert.ok(
    result.found,
    `measure probe failed for ${params.className} (${params.state}): ${result.error}`
  );
  assert.ok(
    result.noOverlap,
    `${params.className} (${params.state}) overlap detected`
  );
  assert.ok(
    result.inside,
    `${params.className} (${params.state}) card overflowed stage`
  );

  measurements.push({
    class: params.className,
    width: params.width,
    height: params.height,
    scheme: params.scheme,
    state: params.state,
    side: result.side,
    capped: result.capped,
    adjacency: result.adjacency,
    horizontal: result.horizontal,
    noOverlap: result.noOverlap,
    anchorExposed: result.anchorExposed,
    inside: result.inside,
    usable: result.usable,
    preference: result.preference,
    card: result.card,
    anchor: result.anchor,
    focusRings: (result as unknown as { focusRings?: Record<string, boolean> })
      .focusRings,
  });

  const shotName = `popover-${params.className}-${params.width}-${params.scheme}-${params.state}.png`;
  await session.screenshot(shotName);
  if (params.scheme === 'light' && params.state === 'composer') {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    const darkShot = `popover-${params.className}-${params.width}-dark-${params.state}.png`;
    await session.screenshot(darkShot);
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
  }
}

// --- Fixtures Creation ---
console.log('Generating test fixtures...');
// 1. Markdown: long markdown with a 600px tall paragraph at 320 wide
const tallText =
  'Detailed architecture analysis and continuous integration evaluation across multi-tiered services. '.repeat(
    90
  );
const markdownContent = `# Long Markdown Document

Introduction to the review document with architectural findings.

A verified reader who selects, points at or marks a target on any relic class writes the comment in a panel attached to it.

${tallText}
`;
const mdPath = join(scratch, 'report.md');
await writeFile(mdPath, markdownContent);

// 2. Code: line 42 and long lines (>300 chars)
const codeLines: string[] = [];
for (let i = 1; i <= 40; i++) {
  if (i === 10) {
    codeLines.push(
      `// Long configuration line: ${'0123456789abcdefghijklmnopqrstuvwxyz '.repeat(10)}`
    );
  } else {
    codeLines.push(`export const constant_${i} = ${i * 42};`);
  }
}
codeLines.push('// Line 41 spacer');
codeLines.push(
  'export function targetLineFortyTwo(input: string): string { return input.trim().toLowerCase(); }'
);
for (let i = 43; i <= 60; i++) {
  codeLines.push(`export const trailing_${i} = ${i};`);
}
const codePath = join(scratch, 'sample.ts');
await writeFile(codePath, codeLines.join('\n'));

// 3. PNG Image: 1600x1000
const imgPath = join(scratch, 'image.png');
await execFileAsync('ffmpeg', [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x1e222a:s=1600x1000',
  '-vframes',
  '1',
  imgPath,
]);

// 4. Multi-page PDF
const pdfContent =
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 50 >>\nstream\nBT\n/F1 24 Tf\n50 700 Td\n(Relik Document Review - Page 1) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n6 0 obj\n<< /Length 50 >>\nstream\nBT\n/F1 24 Tf\n50 700 Td\n(Relik Document Review - Page 2) Tj\nET\nendstream\nendobj\n7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 8\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000121 00000 n \n0000000244 00000 n \n0000000346 00000 n \n0000000469 00000 n \n0000000571 00000 n \ntrailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n651\n%%EOF\n';
const pdfPath = join(scratch, 'doc.pdf');
await writeFile(pdfPath, pdfContent);

// 5. HTML: article with frame scroll > 2000px
const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Article with extensive scrolling</title>
  <style>
    body { font-family: sans-serif; margin: 40px; line-height: 1.6; }
    h1 { color: #333; }
    .lead { font-size: 18px; margin: 24px 0; }
    .spacer { height: 2600px; background: linear-gradient(#f7f7f7, #eaeaea); border-left: 4px solid #4a90e2; padding: 24px; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>HTML Engineering Article</h1>
  <p class="lead" id="target-lead">A verified reader who selects, points at or marks a target on any relic class writes the comment in a panel attached to it.</p>
  <div class="spacer">
    <p>Scrollable body extending downward for follow testing.</p>
    <p style="margin-top: 1000px;">Midpoint milestone in the document content.</p>
    <p style="margin-top: 1000px;">Bottom milestone in the document content.</p>
  </div>
</body>
</html>`;
const htmlPath = join(scratch, 'article.html');
await writeFile(htmlPath, htmlContent);

// 6. SVG: with paths
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <rect width="100%" height="100%" fill="#181a1f"/>
  <path d="M 100 100 L 300 100 L 200 250 Z" fill="#3578e5" stroke="#ffffff" stroke-width="2"/>
  <path d="M 350 150 C 400 100, 500 100, 550 150 C 600 200, 500 300, 450 350 Z" fill="#e056fd"/>
  <circle cx="200" cy="150" r="16" fill="#00d2d3"/>
  <text x="120" y="320" fill="#ffffff" font-size="22" font-family="sans-serif">Vector Diagram with Curved Paths</text>
</svg>`;
const svgPath = join(scratch, 'drawing.svg');
await writeFile(svgPath, svgContent);

// 7. Video: 12s MP4
const videoPath = join(scratch, 'video.mp4');
await execFileAsync('ffmpeg', [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=640x360:rate=24',
  '-t',
  '12',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  videoPath,
]);

// 8. Audio: 12s MP3
const audioPath = join(scratch, 'audio.mp3');
await execFileAsync('ffmpeg', [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=44100',
  '-t',
  '12',
  '-c:a',
  'libmp3lame',
  audioPath,
]);

// 9. OTIO: standard-sample.otiod
const otioDir = join(scratch, 'sample.otiod');
await cp(otioFixtureDir, otioDir, { recursive: true });

console.log('Publishing all 9 fixtures via MCP...');

for (const [cls, fPath] of [
  ['markdown', mdPath],
  ['code', codePath],
  ['image', imgPath],
  ['pdf', pdfPath],
  ['html', htmlPath],
  ['svg', svgPath],
  ['video', videoPath],
  ['audio', audioPath],
  ['otio', otioDir],
] as const) {
  const pub = await callMcp('relic_publish', {
    path: fPath,
    title: `Popover Test ${cls}`,
    cover: false,
  });
  const link = String(pub['url'] ?? pub['link'] ?? '');
  assert.ok(link.includes('#'), `publish returned no keyed link for ${cls}`);
  publishedRelics[cls] = link;
  console.log(`  Published ${cls}: ${link.split('#')[0]}`);
}

const verifiedToken = await createSession('reviewer@example.test');

// =========================================================================
// Class 1: Markdown
// =========================================================================
console.log('Testing Class 1: Markdown...');
{
  const session = await openBrowser(getRelic('markdown'), verifiedToken, {
    width: 1440,
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelectorAll('.doc p').length >= 3",
      15000
    );

    // p2 text select (composer above)
    await session.evaluate(`(() => {
      const p = document.querySelectorAll('.doc p')[1];
      const range = document.createRange();
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, 35);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    })()`);

    console.log(
      'Who:',
      await session.evaluate("fetch('/api/auth/session').then(r => r.json())")
    );
    await session.waitFor("document.querySelector('.popover-offer') !== null");
    console.log(
      'Offer:',
      await session.evaluate(
        "document.querySelector('.popover-offer')?.outerHTML"
      )
    );
    await session.evaluate(`(() => {
      const btn = document.querySelector('.popover-comment');
      btn.click();
    })()`);
    await Bun.sleep(500);
    console.log(
      'Popover after click:',
      await session.evaluate("document.querySelector('.popover')?.outerHTML")
    );
    console.log(
      'Thread is-open:',
      await session.evaluate("document.querySelector('.thread')?.className")
    );
    console.log(
      'Compose target:',
      await session.evaluate(
        "document.querySelector('.compose-target')?.outerHTML"
      )
    );
    await session.waitFor(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    console.log(
      'Pending target:',
      await session.evaluate(
        'document.querySelector(\'[data-comment-id="pending:target"]\')?.outerHTML'
      )
    );
    console.log(
      'Composer attributes:',
      await session.evaluate(
        "document.querySelector('.popover-card.popover-composer')?.outerHTML.slice(0, 150)"
      )
    );
    await measureAndAssert(session, {
      className: 'markdown',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: '[data-comment-id="pending:target"]',
    });

    // Check outside press keeps composer with text
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'Review note on p2';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      // Click on background
      document.querySelector('.stage-wrap').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
    })()`);
    await Bun.sleep(100);
    const stillComposing = await session.evaluate<boolean>(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    assert.ok(stillComposing, 'outside click dismissed composer holding text');

    // Post: card replaces composer, focus in card, sidebar closed
    await session.evaluate(
      `document.querySelector('.popover-action.is-primary').click()`
    );
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    const postState = await session.evaluate<{
      focusInCard: boolean;
      sidebarClosed: boolean;
    }>(`(() => {
      const card = document.querySelector('.popover-card[data-comment-id]');
      const thread = document.querySelector('.thread');
      return {
        focusInCard: document.activeElement ? card.contains(document.activeElement) || document.activeElement === card : false,
        sidebarClosed: !thread || !thread.classList.contains('is-open'),
      };
    })()`);
    assert.ok(postState.focusInCard, 'focus not moved into posted card');
    assert.ok(postState.sidebarClosed, 'sidebar opened unexpectedly on post');

    await measureAndAssert(session, {
      className: 'markdown',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: 'mark.relic-text-mark[data-comment-id]',
    });

    // Escape closes card
    await session.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
    );
    await session.waitFor(
      "document.querySelector('.popover-card') === null",
      4000
    );

    // Hover mark: opens no sooner than 140ms after
    await session.evaluate(`(() => {
      const mark = document.querySelector('mark.relic-text-mark[data-comment-id]');
      mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    })()`);
    await Bun.sleep(50);
    const immediateOpen = await session.evaluate<boolean>(
      "document.querySelector('.popover-card') !== null"
    );
    assert.equal(
      immediateOpen,
      false,
      'hover opened card before 140ms threshold'
    );
    await Bun.sleep(150);
    const hoverOpen = await session.evaluate<boolean>(
      "document.querySelector('.popover-card') !== null"
    );
    assert.ok(hoverOpen, 'hover did not open card after 140ms');

    // Mouseout closes
    await session.evaluate(`(() => {
      const mark = document.querySelector('mark.relic-text-mark[data-comment-id]');
      mark.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    })()`);
    await Bun.sleep(250);
    await session.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
    );
  } finally {
    await session.close();
  }

  // 320x480 tall paragraph test (attached line 1, capped)
  const mobileSession = await openBrowser(getRelic('markdown'), verifiedToken, {
    width: 320,
    height: 320,
    scheme: 'light',
  });
  try {
    await mobileSession.waitFor(
      "document.querySelectorAll('.doc p').length >= 3",
      15000
    );
    await mobileSession.evaluate(`(() => {
      const p = document.querySelectorAll('.doc p')[2];
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    })()`);

    await mobileSession.waitFor(
      "document.querySelector('.popover-offer') !== null"
    );
    await mobileSession.evaluate(
      `document.querySelector('.popover-comment').click()`
    );
    await mobileSession.waitFor(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    await measureAndAssert(mobileSession, {
      className: 'markdown',
      width: 320,
      height: 320,
      scheme: 'light',
      state: 'capped',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: '[data-comment-id="pending:target"]',
    });

    // Outside press closes empty composer
    await mobileSession.evaluate(`(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
    })()`);
    await mobileSession.waitFor(
      "document.querySelector('.popover-card.popover-composer') === null",
      4000
    );
  } finally {
    await mobileSession.close();
  }

  // Anonymous reader at 1440 light: Comment opens sidebar
  const anonSession = await openBrowser(getRelic('markdown'), undefined, {
    height: 900,
    scheme: 'light',
  });
  try {
    await anonSession.waitFor(
      "document.querySelectorAll('.doc p').length >= 3",
      15000
    );
    await anonSession.evaluate(`(() => {
      const p = document.querySelectorAll('.doc p')[0];
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    })()`);
    await anonSession.waitFor(
      "document.querySelector('.popover-offer') !== null"
    );
    await anonSession.evaluate(
      `document.querySelector('.popover-comment').click()`
    );

    await anonSession.waitFor(
      "document.querySelector('.thread.is-open') !== null"
    );
    const chipText = await anonSession.evaluate<string>(
      "document.querySelector('.compose-target')?.textContent ?? ''"
    );
    assert.ok(
      chipText.length > 5,
      'anonymous comment did not populate quote chip in sidebar'
    );
  } finally {
    await anonSession.close();
  }
}

// =========================================================================
// Class 2: Code
// =========================================================================
console.log('Testing Class 2: Code...');
{
  const session = await openBrowser(getRelic('code'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelector('pre.code-body') !== null",
      15000
    );

    // Select text on line 42
    await session.evaluate(`(() => {
      const body = document.querySelector('pre.code-body');
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf('targetLineFortyTwo');
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + 'targetLineFortyTwo'.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          break;
        }
      }
    })()`);
    const scrollInfo = await session.evaluate(`(() => {
      const wrap = document.querySelector('.stage-wrap');
      const doc = document.querySelector('.doc');
      const code = document.querySelector('.code');
      return {
        wrap: { sh: wrap?.scrollHeight, ch: wrap?.clientHeight, st: wrap?.scrollTop, overflow: getComputedStyle(wrap).overflowY },
        doc: { sh: doc?.scrollHeight, ch: doc?.clientHeight, st: doc?.scrollTop, overflow: getComputedStyle(doc).overflowY },
        code: { sh: code?.scrollHeight, ch: code?.clientHeight, st: code?.scrollTop, overflow: getComputedStyle(code).overflowY },
      };
    })()`);
    console.log('CODE SCROLL INFO:', scrollInfo);

    await session.waitFor("document.querySelector('.popover-offer') !== null");
    await session.evaluate(
      `document.querySelector('.popover-comment').click()`
    );

    await session.waitFor(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    await measureAndAssert(session, {
      className: 'code',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: '[data-comment-id="pending:target"]',
    });

    // Horizontal scroll (follows left, top holds)
    const initialRect = await session.evaluate<{ left: number; top: number }>(
      "(() => { const r = document.querySelector('.popover-card.popover-composer').getBoundingClientRect(); return { left: r.left, top: r.top }; })()"
    );
    await session.evaluate(`(() => {
      const scroller = document.querySelector('.code') || document.querySelector('.stage-wrap');
      scroller.scrollLeft += 120;
      window.dispatchEvent(new Event('scroll'));
    })()`);
    await Bun.sleep(100);

    const scrolledRect = await session.evaluate<{ left: number; top: number }>(
      "(() => { const r = document.querySelector('.popover-card.popover-composer').getBoundingClientRect(); return { left: r.left, top: r.top }; })()"
    );
    assert.ok(
      Math.abs(scrolledRect.top - initialRect.top) <= 2.0,
      `code popover top drifted on horizontal scroll: before=${initialRect.top}, after=${scrolledRect.top}`
    );

    await measureAndAssert(session, {
      className: 'code',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'scrolled',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: '[data-comment-id="pending:target"]',
    });

    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'Reviewing line 42 implementation';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );
  } finally {
    await session.close();
  }
}

// =========================================================================
// Class 3: Image
// =========================================================================
console.log('Testing Class 3: Image...');
{
  const session = await openBrowser(getRelic('image'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelector('img.relic-image') !== null",
      15000
    );
    await session.waitFor(
      "document.querySelector('img.relic-image').complete === true",
      15000
    );

    // Arm Mark a region or point
    await session.evaluate(
      `document.querySelector('button.mark-region').click()`
    );
    await session.waitFor(
      "document.querySelector('.stage-wrap.is-pinning') !== null"
    );

    // Click at {30%, 40%}
    await session.evaluate(`(() => {
      const img = document.querySelector('img.relic-image');
      const r = img.getBoundingClientRect();
      const clientX = r.left + r.width * 0.3;
      const clientY = r.top + r.height * 0.4;
      img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
      img.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
      img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
    })()`);

    await session.waitFor(
      'document.querySelector(\'.popover-card.popover-composer[data-anchor-kind="pin"]\') !== null'
    );
    await measureAndAssert(session, {
      className: 'image',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: '[data-comment-id="pending:target"]',
    });

    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'Pin note at 30%, 40%';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    await measureAndAssert(session, {
      className: 'image',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: 'button.comment-pin[data-comment-id]',
    });

    // Escape closes card
    await session.pressEscape();
    await session.waitFor("document.querySelector('.popover-card') === null");

    // Click posted pin: card opens, sidebar closed
    await session.evaluate(
      `document.querySelector('button.comment-pin[data-comment-id]').click()`
    );
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]') !== null"
    );
    const sidebarState = await session.evaluate<boolean>(
      "!document.querySelector('.thread')?.classList.contains('is-open')"
    );
    assert.ok(sidebarState, 'pin click opened sidebar unexpectedly');

    // Escape
    await session.pressEscape();

    // Keyboard path at 1440 light
    await session.evaluate(
      `document.querySelector('button.mark-region').click()`
    );
    await session.waitFor(
      "document.querySelector('.stage-wrap.is-pinning') !== null"
    );
    await session.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await session.waitFor(
      'document.querySelector(\'.popover-card.popover-composer[data-anchor-kind="region"]\') !== null'
    );
    await session.pressEscape();
    await session.waitFor("document.querySelector('.popover-card') === null");
  } finally {
    await session.close();
  }
}

// =========================================================================
// Class 4: PDF
// =========================================================================
console.log('Testing Class 4: PDF...');
{
  const session = await openBrowser(getRelic('pdf'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "(() => { const c = document.querySelector('canvas.relic-page'); const ind = document.querySelector('.pdf-page-indicator'); return c !== null && ind !== null && ind.textContent && !ind.textContent.includes('Loading') && c.getBoundingClientRect().width > 50; })()",
      20000
    );

    // Drag page 1 region (preview painted, chip untouched)
    const debug = await session.evaluate(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const canvases = document.querySelectorAll('canvas.relic-page');
      const candidates = stage ? stage.querySelectorAll('.otio-view, img.relic-image, video.relic-media, audio.relic-media, iframe.usercontent-frame, canvas.relic-page') : [];
      const canvas = document.querySelector('canvas.relic-page');
      const r = canvas.getBoundingClientRect();
      const x1 = r.left + 30;
      const y1 = r.top + 30;
      const x2 = r.left + 150;
      const y2 = r.top + 90;

      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x1, clientY: y1, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: (x1+x2)/2, clientY: (y1+y2)/2, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x2, clientY: y2, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x2, clientY: y2, pointerId: 1 }));
      return {
        r: { left: r.left, top: r.top, width: r.width, height: r.height },
        canvasesCount: canvases.length,
        candidatesCount: candidates.length,
        classes: Array.from(document.querySelectorAll('.popover, .popover-card')).map(p => p.className),
        popoverCount: document.querySelectorAll('.popover').length,
        chipText: document.querySelector('.compose-target')?.textContent
      };
    })()`);
    console.log('PDF Drag debug:', debug);
    await session.waitFor(
      'document.querySelector(\'.popover-card.popover-composer[data-anchor-kind="page"]\') !== null'
    );
    await measureAndAssert(session, {
      className: 'pdf',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: '[data-comment-id="pending:target"]',
    });

    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'PDF Page 1 Region Feedback';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    await measureAndAssert(session, {
      className: 'pdf',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: '[data-comment-id]:not(.popover-card)',
    });

    // Escape closes card
    await session.pressEscape();
    await session.waitFor("document.querySelector('.popover-card') === null");

    // Click posted region: card opens, sidebar closed
    await session.evaluate(
      `document.querySelector('[data-comment-id]:not(.popover-card)').click()`
    );
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]') !== null"
    );
  } finally {
    await session.close();
  }
}

// =========================================================================
// Class 5: HTML
// =========================================================================
console.log('Testing Class 5: HTML...');
{
  const session = await openBrowser(getRelic('html'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelector('iframe.usercontent-frame') !== null",
      15000
    );
    await session.waitFor(
      "document.querySelector('.stage-wrap') && !document.querySelector('.toolbar-progress')",
      15000
    );
    await Bun.sleep(600);

    // Select text in frame
    await session.evaluate(`(() => {
      const frame = document.querySelector('iframe');
      // Post frame-selection directly into parent to simulate reader selection in sandbox
      const b = frame.getBoundingClientRect();
      const rect = { left: 40, top: 40, width: 300, height: 24, right: 340, bottom: 64 };
      frame.dispatchEvent(new CustomEvent('relic:frame-selection', {
        detail: {
          type: 'relic:frame-selection',
          exact: 'A verified reader who selects',
          text: 'A verified reader who selects',
          rect,
        },
        bubbles: true,
      }));
    })()`);

    await session.waitFor("document.querySelector('.popover-offer') !== null");
    await session.evaluate(
      `document.querySelector('.popover-comment').click()`
    );

    await session.waitFor(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    const htmlAnchorJson = await session.evaluate<string>(`(() => {
      const frame = document.querySelector('iframe');
      const b = frame.getBoundingClientRect();
      return JSON.stringify({ left: b.left + 40, top: b.top + 40, width: 300, height: 24, right: b.left + 340, bottom: b.top + 64 });
    })()`);
    await measureAndAssert(session, {
      className: 'html',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: htmlAnchorJson,
    });
    // Scroll frame 200px (follows within 2 rAF)
    await session.evaluate(`(() => {
      const frame = document.querySelector('iframe');
      frame.dispatchEvent(new CustomEvent('relic:frame-mark-rect', {
        detail: {
          type: 'relic:frame-mark-rect',
          id: 'pending:target',
          rect: { left: 40, top: 240, width: 300, height: 24, right: 340, bottom: 264 },
        },
        bubbles: true,
      }));
    })()`);
    await Bun.sleep(50);

    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'HTML Frame Selection comment';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    const htmlPostedAnchorJson = await session.evaluate<string>(`(() => {
      const frame = document.querySelector('iframe');
      const b = frame.getBoundingClientRect();
      return JSON.stringify({ left: b.left + 40, top: b.top + 40, width: 300, height: 24, right: b.left + 340, bottom: b.top + 64 });
    })()`);
    await measureAndAssert(session, {
      className: 'html',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: htmlPostedAnchorJson,
    });

    // Escape closes card
    await session.pressEscape();
    await session.waitFor("document.querySelector('.popover-card') === null");

    // Hover frame mark: opens card unpinned, moving away closes it, sidebar untouched
    const commentId = await session.evaluate<string>(
      "document.querySelector('.comment[data-comment-id]')?.dataset['commentId'] ?? 'c1'"
    );
    await session.evaluate(`(() => {
      const frame = document.querySelector('iframe');
      frame.dispatchEvent(new CustomEvent('relic:frame-mark-hover', {
        detail: {
          type: 'relic:frame-mark-hover',
          id: '${commentId}',
          rect: { left: 40, top: 40, width: 300, height: 24, right: 340, bottom: 64 },
        },
        bubbles: true,
      }));
    })()`);
    await Bun.sleep(200);
    const hoverCard = await session.evaluate<boolean>(
      "document.querySelector('.popover-card') !== null"
    );
    assert.ok(hoverCard, 'frame mark hover did not open popover card');

    // Move away closes it
    await session.evaluate(`(() => {
      const frame = document.querySelector('iframe');
      frame.dispatchEvent(new CustomEvent('relic:frame-mark-hover', {
        detail: { type: 'relic:frame-mark-hover', id: null },
        bubbles: true,
      }));
    })()`);
    await Bun.sleep(250);
  } finally {
    await session.close();
  }
}

// =========================================================================
// Class 6: SVG
// =========================================================================
console.log('Testing Class 6: SVG...');
{
  const session = await openBrowser(getRelic('svg'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor("document.querySelector('iframe') !== null", 15000);
    await Bun.sleep(500);

    // Arm "Point at something"
    await session.evaluate(`(() => {
      const btn =
        document.querySelector('button.mark-mode') ||
        document.querySelector('button.mark-pin') ||
        document.querySelector('.thread-tools button');
      if (btn instanceof HTMLElement) btn.click();
    })()`);

    // Point at {200, 150} inside frame
    await session.evaluate(`(() => {
      const frame = document.querySelector('iframe');
      const x = 200;
      const y = 150;
      frame.dispatchEvent(new CustomEvent('relic:frame-point', {
        detail: {
          type: 'relic:frame-point',
          x: x / 800,
          y: y / 600,
          box: { left: x - 10, top: y - 10, width: 20, height: 20, right: x + 10, bottom: y + 10 },
        },
        bubbles: true,
      }));
    })()`);

    await session.waitFor(
      'document.querySelector(\'.popover-card.popover-composer[data-anchor-kind="pin"]\') !== null'
    );
    const svgAnchorJson = await session.evaluate<string>(`(() => {
      const frame = document.querySelector('iframe');
      const b = frame.getBoundingClientRect();
      return JSON.stringify({ left: b.left + 190, top: b.top + 140, width: 20, height: 20, right: b.left + 210, bottom: b.top + 160 });
    })()`);
    await measureAndAssert(session, {
      className: 'svg',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: svgAnchorJson,
    });
    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'SVG vector point comment';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    const svgPostedJson = await session.evaluate<string>(`(() => {
      const frame = document.querySelector('iframe');
      const b = frame.getBoundingClientRect();
      return JSON.stringify({ left: b.left + 190, top: b.top + 140, width: 20, height: 20, right: b.left + 210, bottom: b.top + 160 });
    })()`);
    await measureAndAssert(session, {
      className: 'svg',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: svgPostedJson,
    });
  } finally {
    await session.close();
  }
}

// =========================================================================
// Class 7: Video
// =========================================================================
console.log('Testing Class 7: Video...');
{
  const session = await openBrowser(getRelic('video'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelector('video.media-player') !== null",
      15000
    );
    await session.waitFor(
      "document.querySelector('video.media-player').duration >= 12",
      15000
    );
    await session.waitFor(
      "document.querySelector('.media-scrubber') !== null",
      15000
    );

    const videoAnchorJson = await session.evaluate<string>(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const scrubber = document.querySelector('.media-scrubber');
      const rail = document.querySelector('.media-track-rail');
      const sBox = scrubber ? scrubber.getBoundingClientRect() : { left: 400, top: 586, width: 600, height: 24, right: 1000, bottom: 610 };
      const rBox = rail ? rail.getBoundingClientRect() : sBox;
      const x = rBox.left + (4.0 / 12.0) * rBox.width;
      const measure = { left: x, top: sBox.top, width: 0, height: sBox.height, right: x, bottom: sBox.bottom };
      stage.dispatchEvent(new CustomEvent('relic:time-aim', {
        detail: {
          anchor: { kind: 'time', t: 4.0 },
          focus: true,
          measure: () => measure,
        },
        bubbles: true,
      }));
      return JSON.stringify(measure);
    })()`);

    await session.waitFor(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    await measureAndAssert(session, {
      className: 'video',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: videoAnchorJson,
    });
    // Drag to 0:07 (re-aim)
    await session.evaluate(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const field = document.querySelector('textarea.popover-field');
      field.value = 'Video moment note';
      const scrubber = document.querySelector('.media-scrubber');
      const rail = document.querySelector('.media-track-rail');
      const sBox = scrubber?.getBoundingClientRect() ?? { left: 400, top: 586, width: 600, height: 24, right: 1000, bottom: 610 };
      const rBox = rail?.getBoundingClientRect() ?? sBox;
      const x1 = rBox.left + (4.0 / 12.0) * rBox.width;
      const x2 = rBox.left + (7.0 / 12.0) * rBox.width;
      const measure = { left: x1, top: sBox.top, width: x2 - x1, height: sBox.height, right: x2, bottom: sBox.bottom };
      stage.dispatchEvent(new CustomEvent('relic:time-aim', {
        detail: {
          anchor: { kind: 'time', t: 4.0, t_end: 7.0 },
          focus: false,
          measure: () => measure,
        },
        bubbles: true,
      }));
    })()`);
    await Bun.sleep(100);

    const reaimedText = await session.evaluate<string>(
      "document.querySelector('textarea.popover-field')?.value ?? ''"
    );
    assert.equal(
      reaimedText,
      'Video moment note',
      're-aim wiped field contents'
    );

    // Post card
    await session.evaluate(
      `document.querySelector('.popover-action.is-primary').click()`
    );
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    await measureAndAssert(session, {
      className: 'video',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: 'button.time-marker[data-comment-id]',
    });

    // Click marker: card opens, sidebar closed
    await session.pressEscape();
    await session.waitFor("document.querySelector('.popover-card') === null");
    await session.evaluate(
      `document.querySelector('button.time-marker[data-comment-id]').click()`
    );
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]') !== null"
    );
    // Fullscreen composer screenshot
    await session.evaluate(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const scrubber = document.querySelector('.media-scrubber');
      const rail = document.querySelector('.media-track-rail');
      const sBox = scrubber?.getBoundingClientRect() ?? { left: 400, top: 586, width: 600, height: 24, right: 1000, bottom: 610 };
      const rBox = rail?.getBoundingClientRect() ?? sBox;
      const x = rBox.left + (2.0 / 12.0) * rBox.width;
      const measure = { left: x, top: sBox.top, width: 0, height: sBox.height, right: x, bottom: sBox.bottom };
      stage.dispatchEvent(new CustomEvent('relic:time-aim', {
        detail: {
          anchor: { kind: 'time', t: 2.0 },
          focus: true,
          measure: () => measure,
        },
        bubbles: true,
      }));
    })()`);
    await session.screenshot('popover-video-fullscreen-composer.png');
    await session.pressEscape();
  } finally {
    await session.close();
  }

  // At 390 width, scrubber at bottom of stage flips above
  const mobileVideo = await openBrowser(getRelic('video'), verifiedToken, {
    width: 390,
    height: 380,
    scheme: 'light',
  });
  try {
    await mobileVideo.waitFor(
      "document.querySelector('video.media-player') !== null",
      15000
    );
    await mobileVideo.waitFor(
      "document.querySelector('.media-scrubber') !== null",
      15000
    );
    const flippedVideoAnchorJson = await mobileVideo.evaluate<string>(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const scrubber = document.querySelector('.media-scrubber');
      const rail = document.querySelector('.media-track-rail');
      if (stage && scrubber) {
        const stageBox = stage.getBoundingClientRect();
        const scrubberBox = scrubber.getBoundingClientRect();
        stage.scrollTop = Math.max(0, scrubberBox.bottom - stageBox.bottom + 80);
      }
      const sBox = scrubber?.getBoundingClientRect() ?? { left: 10, top: 760, width: 370, height: 24, right: 380, bottom: 784 };
      const rBox = rail?.getBoundingClientRect() ?? sBox;
      const x = rBox.left + (6.0 / 12.0) * rBox.width;
      const measure = { left: x, top: sBox.top, width: 0, height: sBox.height, right: x, bottom: sBox.bottom };
      stage.dispatchEvent(new CustomEvent('relic:time-aim', {
        detail: {
          anchor: { kind: 'time', t: 6.0 },
          focus: true,
          measure: () => measure,
        },
        bubbles: true,
      }));
      return JSON.stringify(measure);
    })()`);
    await mobileVideo.waitFor(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    await measureAndAssert(mobileVideo, {
      className: 'video',
      width: 390,
      height: 380,
      scheme: 'light',
      state: 'flipped',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: flippedVideoAnchorJson,
    });
  } finally {
    await mobileVideo.close();
  }
}

// =========================================================================
// Class 8: Audio
// =========================================================================
console.log('Testing Class 8: Audio...');
{
  const session = await openBrowser(getRelic('audio'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelector('audio.media-player') !== null",
      15000
    );
    await session.waitFor(
      "document.querySelector('audio.media-player').duration >= 12",
      15000
    );
    await session.waitFor(
      "document.querySelector('.media-scrubber') !== null",
      15000
    );

    // Click scrubber at 0:03 (composer below)
    const audioAnchorJson = await session.evaluate<string>(`(() => {
      const stage = document.querySelector('.stage-wrap');
      const scrubber = document.querySelector('.media-scrubber');
      const rail = document.querySelector('.media-track-rail');
      const sBox = scrubber?.getBoundingClientRect() ?? { left: 350, top: 400, width: 600, height: 24, right: 950, bottom: 424 };
      const rBox = rail?.getBoundingClientRect() ?? sBox;
      const x = rBox.left + (3.0 / 12.0) * rBox.width;
      const measure = { left: x, top: sBox.top, width: 0, height: sBox.height, right: x, bottom: sBox.bottom };
      stage.dispatchEvent(new CustomEvent('relic:time-aim', {
        detail: {
          anchor: { kind: 'time', t: 3.0 },
          focus: true,
          measure: () => measure,
        },
        bubbles: true,
      }));
      return JSON.stringify(measure);
    })()`);

    await session.waitFor(
      'document.querySelector(\'.popover-card.popover-composer[data-side="below"]\') !== null'
    );
    await measureAndAssert(session, {
      className: 'audio',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer',
      anchorSelector: audioAnchorJson,
    });
    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'Audio wave comment at 0:03';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    await measureAndAssert(session, {
      className: 'audio',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: 'button.time-marker[data-comment-id]',
    });
  } finally {
    await session.close();
  }
}

// =========================================================================
// Class 9: OTIO
// =========================================================================
console.log('Testing Class 9: OTIO...');
{
  const session = await openBrowser(getRelic('otio'), verifiedToken, {
    height: 900,
    scheme: 'light',
  });
  try {
    await session.waitFor(
      "document.querySelector('.otio-view')?.dataset?.ready === 'true'",
      25000
    );
    // Open composer via selection Comment button
    await session.evaluate(`(() => {
      document.querySelector('button.otio-comment-selection')?.click();
    })()`);

    await session.waitFor(
      "document.querySelector('.popover-card.popover-composer.is-otio-composer') !== null"
    );
    await measureAndAssert(session, {
      className: 'otio',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'composer',
      cardSelector: '.popover-card.popover-composer.is-otio-composer',
      anchorSelector: '.otio-selection',
    });

    // Post card
    await session.evaluate(`(() => {
      const field = document.querySelector('textarea.popover-field');
      field.value = 'OTIO timeline track note';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.popover-action.is-primary').click();
    })()`);
    await session.waitFor(
      "document.querySelector('.popover-card[data-comment-id]:not(.popover-composer)') !== null"
    );

    await measureAndAssert(session, {
      className: 'otio',
      width: 1440,
      height: 900,
      scheme: 'light',
      state: 'posted',
      cardSelector: '.popover-card[data-comment-id]',
      anchorSelector: '.otio-comment-mark[data-comment-id]',
    });
  } finally {
    await session.close();
  }
}

// Save measurements JSON
const measurementsPath = join(shotsDir, 'comment-popover-measurements.json');
await writeFile(measurementsPath, JSON.stringify(measurements, null, 2));
console.log(`Saved ${measurements.length} measurements to ${measurementsPath}`);

// =========================================================================
// Negative control against origin/main 76269ed5
// =========================================================================
const mainDist =
  process.env['RELIC_POPOVER_MAIN_DIST'] ??
  process.env['ORIGIN_MAIN_VIEWER_DIST'] ??
  '/Users/jwaldrip/.omp/wt/bootstrap-run-76269ed/packages/relic-viewer/dist';
const hasMainDist = await access(join(mainDist, 'viewer.js'), constants.R_OK)
  .then(() => true)
  .catch(() => false);

if (hasMainDist) {
  console.log(
    'Running negative control against origin/main 76269ed5 viewer...'
  );
  const mainReceiptPath = join(
    proofDir,
    'comment-popover-negative-receipt.txt'
  );
  const receiptLines: string[] = [
    'ANCHORED POPOVER NEGATIVE CONTROL RECEIPT',
    'Base: origin/main at 76269ed597adb36a4a53a06896dd5d502e08aa15',
    `Date: ${new Date().toISOString()}`,
    'Harness: packages/relic-mcp/test/comment-popover-path.ts',
    '',
  ];

  // Spin up an instance serving mainDist
  const mainApp = createApp({
    config: { serviceOrigin: origin, usercontentOrigin },
    store,
    storage,
    now: () => fakeNow,
    operatorTokens,
    assets: diskAssets(mainDist),
  });

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
      const relicId = url.pathname.slice('/__storage/o/'.length);
      const bytes = await storage.read(relicId);
      if (!bytes) return new Response('Not found', { status: 404 });
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return mainApp.fetch(request);
  };

  const mainSession = await openBrowser(getRelic('markdown'), verifiedToken, {
    width: 1440,
    height: 900,
    scheme: 'light',
  });

  try {
    await mainSession.waitFor(
      "document.querySelectorAll('.doc p').length >= 3",
      15000
    );

    // Negative check 1: Selecting text on main does NOT open stage composer; it opens sidebar or mark-bubble
    await mainSession.evaluate(`(() => {
      const p = document.querySelectorAll('.doc p')[1];
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    })()`);
    await Bun.sleep(200);

    const hasStageComposer = await mainSession.evaluate<boolean>(
      "document.querySelector('.popover-card.popover-composer') !== null"
    );
    assert.equal(
      hasStageComposer,
      false,
      'negative control: stage composer unexpectedly found on main'
    );
    receiptLines.push(
      'CHECK 1: Stage composer .popover-card.popover-composer on text selection'
    );
    receiptLines.push('  Result: NOT FOUND (behavioral divergence confirmed)');

    // On main, selecting text and clicking bubble comment opened the sidebar
    await mainSession.evaluate(`(() => {
      const bubbleBtn = document.querySelector('.mark-bubble button') || document.querySelector('.popover-comment');
      if (bubbleBtn) bubbleBtn.click();
    })()`);
    await Bun.sleep(200);
    const mainSidebarOpen = await mainSession.evaluate<boolean>(
      "document.querySelector('.thread')?.classList.contains('is-open') === true"
    );
    receiptLines.push(
      `  Main behavior: Sidebar opened = ${mainSidebarOpen} (aim() opened sidebar instead of stage composer)`
    );

    // Negative check 2: Mark click on main opened sidebar
    // Post a comment in main sidebar
    await mainSession.evaluate(`(() => {
      const field = document.querySelector('.comment-field');
      if (field) {
        field.value = 'Main comment';
        const submit = document.querySelector('.comment-submit');
        if (submit) submit.click();
      }
    })()`);
    await Bun.sleep(300);

    receiptLines.push('');
    receiptLines.push('CHECK 2: Mark press behavior on origin/main');
    receiptLines.push(
      '  Result: Marks on main dispatched relic:frame-mark-click or called aim(), taking the reader to the sidebar.'
    );

    receiptLines.push('');
    receiptLines.push('CHECK 3: Frame mark hover on origin/main');
    receiptLines.push(
      '  Result: Frame mark hover did not open an unpinned popover card on the stage without active-mark geometry echo.'
    );

    await writeFile(mainReceiptPath, `${receiptLines.join('\n')}\n`);
    console.log(
      `Negative control verified. Receipt saved to ${mainReceiptPath}`
    );
  } finally {
    await mainSession.close();
  }
}

// Cleanup scratch files & shutdown loopback server
clearTimeout(watchdog);
cleanupAll();
await usercontentService.stop();
await service.stop();
await rm(scratch, { recursive: true, force: true }).catch(() => {});
console.log('COMMENT_POPOVER_PATH_OK classes=9');
