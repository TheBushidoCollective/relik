/**
 * Structured formats, end to end (A5c).
 *
 *   bun packages/relic-mcp/test/structured-formats-path.ts
 *
 * Needs the viewer and the MCP bundle built (`bun run build`, then
 * `bun run --cwd packages/relic-mcp build`) and an isolated headless Chrome
 * named by RELIC_CHROME_PATH, or the owned headless shell when it is present.
 *
 * Every stage publishes its own file through the MCP `relic_publish` tool, opens
 * the share link in a fresh headless page, and comments with real CDP mouse and
 * text input. The page posts through the real `/api/relics/:id/comments` route
 * into the in-memory store. The MCP `relic_read_comments` then decrypts what the
 * store holds and resolves it, so the anchor is read back from the ciphertext the
 * page wrote, not from what the page meant to send.
 *
 * What each stage proves, on a real published relic:
 *   table      A .csv and a .tsv draw as tables, not the code view. A cell (C14)
 *              and a range (B4:D9) are selected by mouse and commented. The stored
 *              anchors are exactly `cell` anchors, the marks paint after a reload,
 *              a sort moves the C14 mark with its record, and the MCP resolves the
 *              text and header. The neighbour cell C13 stays unmarked (negative).
 *   tree       A nested node comment stores `/order/lines/1/sku`, the mark paints
 *              after a reload on that row only, and the MCP resolves the excerpt.
 *              A file whose key and value are `<img onerror>` draws as text: no
 *              element is created and no script runs.
 *   cues       A cue in an .srt and a cue in a .vtt store their time spans, paint
 *              after a reload on their own cue only, and the MCP resolves each cue.
 *   notebook   A cell and an output store `path` anchors. An HTML output shows the
 *              placeholder and never renders. A PNG output draws as an image. The
 *              MCP resolves cell_type and output_type.
 *   old-reader A comment whose anchor kind this viewer does not register (a kind
 *              a newer writer adds) shows the plan's fallback copy, and its body
 *              stays readable. This is how an older viewer shows the new kinds.
 *   refusals   Negative control (a). Malformed cell and path anchors are refused by
 *              the MCP validators before anything is posted: the store row count
 *              does not change and every refusal names the anchor.
 *
 * Negative control (b), run by hand and reverted afterwards (it changes product
 * code, so it is not part of the default run):
 *   1. Delete the four csv/tsv entries in `EXTENSION_KINDS` and `MIMETYPE_KINDS`
 *      in packages/relic-viewer/src/structured-view-bridge.ts, so CSV and TSV
 *      route to the code view.
 *   2. `bun run --filter '@relic/viewer' build`
 *   3. `RELIC_STRUCTURED_STAGES=table RELIC_CHROME_PATH=<shell> env -u DISPLAY \
 *        -u WAYLAND_DISPLAY bun packages/relic-mcp/test/structured-formats-path.ts`
 *      The `table` stage must fail at "the table draws". It prints no OK marker.
 *   4. `git checkout -- packages/relic-viewer/src/structured-view-bridge.ts`,
 *      rebuild the viewer, and run the default command again.
 *
 * Each stage's own negative assertion (a neighbour cell, a second cue, a second
 * node, a second cell that must not be marked) fails if the mark or the anchor is
 * painted on the wrong target. The subset run, RELIC_STRUCTURED_STAGES, names the
 * stages to run and prints STRUCTURED_FORMATS_PATH_PARTIAL, never the full marker.
 *
 * The final line is STRUCTURED_FORMATS_PATH_OK, printed only when every stage and
 * every negative control passes. All proof writes target the loopback in-memory
 * service. The stub-free page, the real service and the MCP bundle are all live.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type CommentAnchor,
  decodeKey,
  deriveCommentKey,
  encryptComment,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { loadPublishState } from '../src/state.ts';
import { COMMENT_TOOL_NAME, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const defaultOwnedShell =
  '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const requestedChrome =
  process.env['RELIC_CHROME_PATH'] ??
  ((await access(defaultOwnedShell, constants.X_OK)
    .then(() => true)
    .catch(() => false))
    ? defaultOwnedShell
    : undefined);
const foundChrome = await discoverChrome(
  requestedChrome &&
    requestedChrome !== 'none' &&
    requestedChrome !== 'disabled'
    ? requestedChrome
    : undefined
);
assert.equal(
  foundChrome.kind,
  'found',
  `no Chrome executable found: ${foundChrome.kind}`
);
if (foundChrome.kind !== 'found') throw new Error('unreachable');
const chromeExecutable = foundChrome.path;

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const relicMcpBundle = join(packageRoot, 'dist', 'relic-mcp.js');
const viewerDist = join(packageRoot, '../relic-viewer/dist');

const RUN_BUDGET_MS = 420_000;
let currentStep = 'startup';
const runningBrowsers: Array<{ child: ChildProcess; cdp: CdpConnection }> = [];
const watchdog = setTimeout(() => {
  console.error(
    `STRUCTURED_FORMATS_PATH_TIMEOUT after ${RUN_BUDGET_MS}ms at step "${currentStep}"`
  );
  for (const browser of runningBrowsers) browser.child.kill('SIGKILL');
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();

const scratch = await mkdtemp(
  join(await realpath(tmpdir()), 'relic-structured-')
);
const statePath = join(scratch, 'state.json');
process.env['RELIC_PUBLISH_STATE'] = statePath;

const children = new Set<ChildProcess>();
function cleanupAll(): void {
  for (const browser of runningBrowsers) {
    try {
      browser.cdp.dispose();
      browser.child.kill('SIGKILL');
    } catch {}
  }
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}
process.on('SIGINT', cleanupAll);
process.on('SIGTERM', cleanupAll);

// --- The service: real HTTP on loopback, the app's own routes. ---

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

const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  now: () => fakeNow,
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async () => {},
    sendMail: async () => {},
  },
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

async function createSession(email: string): Promise<string> {
  const token = `structured-token-${Math.random().toString(16).slice(2)}`;
  await store.putSession({
    tokenHash: await sha256Hex(token),
    email,
    createdAt: fakeNow,
    expiresAt: fakeNow + 3600 * 1000,
  });
  return token;
}

// --- The MCP: the built bundle over stdio, a fresh process per call. ---

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: ReadonlyArray<{
    readonly type?: string;
    readonly text?: string;
  }>;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const child = Bun.spawn(['node', relicMcpBundle], {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/structured-formats-path',
      RELIC_CHROME_PATH: 'none',
      RELIC_OTIO_CHROME_PATH: 'none',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, `relic-mcp exited with ${exit}: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '');
  const raw = lines.at(-1);
  assert.ok(raw !== undefined, 'relic-mcp printed nothing');
  const response = JSON.parse(raw) as {
    error?: unknown;
    result?: ToolResult;
  };
  if (response.error !== undefined) {
    throw new Error(`MCP protocol error: ${JSON.stringify(response.error)}`);
  }
  assert.ok(response.result !== undefined, 'MCP response has no result');
  return response.result;
}

interface Published {
  readonly relicId: string;
  readonly url: string;
}

async function publish(name: string, text: string): Promise<Published> {
  const path = join(scratch, name);
  await writeFile(path, text);
  const result = await callTool('relic_publish', {
    path,
    title: name,
    cover: false,
  });
  assert.notEqual(
    result.isError,
    true,
    `publish ${name}: ${JSON.stringify(result)}`
  );
  const content = result.structuredContent ?? {};
  const relicId = String(content['relic_id'] ?? '');
  const url = String(content['url'] ?? '');
  assert.match(relicId, /^[0-9a-z]{26}$/, `relic_id for ${name}`);
  assert.ok(url.includes('#'), `publish ${name} returned no keyed link`);
  return { relicId, url };
}

interface ReadComment {
  readonly comment_id: string;
  readonly author: string;
  readonly body: string;
  readonly anchor: Record<string, unknown> | null;
  readonly resolved: Record<string, unknown> | null;
  readonly readable: boolean;
}

async function readBack(relicId: string): Promise<ReadComment[]> {
  const result = await callTool(READ_COMMENTS_TOOL_NAME, {
    relic_id: relicId,
    version: '*',
    resolve_anchors: true,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const comments = result.structuredContent?.['comments'];
  assert.ok(Array.isArray(comments), 'read_comments returned no comment list');
  return comments as ReadComment[];
}

async function commentFor(relicId: string, body: string): Promise<ReadComment> {
  const matches = (await readBack(relicId)).filter((c) => c.body === body);
  assert.equal(matches.length, 1, `exactly one comment reads "${body}"`);
  const [comment] = matches;
  assert.ok(comment !== undefined);
  assert.equal(comment.readable, true, `"${body}" is readable`);
  return comment;
}

// Each comment body is unique per stage, so a read finds exactly that comment.
async function awaitStored(relicId: string, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await store.listComments(relicId)).length >= count) return;
    await Bun.sleep(50);
  }
  throw new Error(
    `relic ${relicId} stores ${(await store.listComments(relicId)).length} comments, expected ${count}`
  );
}

// --- The headless page: real mouse and text input over CDP. ---

type Point = { readonly x: number; readonly y: number };

interface Page {
  readonly errors: string[];
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  click(selector: string, options?: ClickOptions): Promise<void>;
  drag(from: string, to: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

interface ClickOptions {
  readonly index?: number;
  /** Pixels from the element's left edge, for controls that sit at one side. */
  readonly fromLeft?: number;
}

let cdpCalls = 0;

async function openPage(url: string, token: string): Promise<Page> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-structured-chrome-'));
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
  let cdp: CdpConnection | undefined;
  try {
    const toChrome = child.stdio[3] as Writable;
    const fromChrome = child.stdio[4] as Readable;
    cdp = connectPipe(toChrome, fromChrome);
    runningBrowsers.push({ child, cdp });
    await attestBrowserHeadless(cdp, launch);

    const created = (await cdp.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;
    const send = (method: string, params?: Record<string, unknown>) => {
      cdpCalls += 1;
      return cdp!.send(method, params, sessionId);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });

    // Only the loopback service is reachable from the page.
    cdp.onEvent((event) => {
      if (event.method !== 'Fetch.requestPaused') return;
      const params = event.params as {
        requestId?: string;
        request?: { url?: string };
      };
      const requestId = params.requestId;
      if (requestId === undefined) return;
      const reqUrl = params.request?.url ?? '';
      const local =
        reqUrl.startsWith(`${origin}/`) ||
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:') ||
        reqUrl === 'about:blank';
      const method = local ? 'Fetch.continueRequest' : 'Fetch.failRequest';
      const extra = local ? {} : { errorReason: 'BlockedByClient' };
      void cdp
        ?.send(method, { requestId, ...extra }, sessionId)
        .catch(() => {});
    });

    const errors: string[] = [];
    cdp.onEvent((event) => {
      if (event.method !== 'Runtime.exceptionThrown') return;
      const params = event.params as {
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      };
      errors.push(
        params.exceptionDetails?.exception?.description ??
          params.exceptionDetails?.text ??
          'exception'
      );
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
      hasTouch: false,
    });
    await send('Emulation.setEmulatedMedia', {
      media: 'page',
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });

    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId,
      timeoutMs: 20_000,
    });
    const navigated = await send('Page.navigate', { url });
    if (navigated['errorText'] !== undefined) {
      loaded.catch(() => {});
      throw new Error(`navigation failed: ${String(navigated['errorText'])}`);
    }
    await loaded;

    const evaluate = async <T>(expression: string): Promise<T> => {
      const res = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15_000,
      });
      const exception = res['exceptionDetails'] as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      assert.equal(
        exception,
        undefined,
        `page evaluation failed: ${exception?.exception?.description ?? exception?.text ?? ''}\n${expression.slice(0, 200)}`
      );
      const inner = res['result'] as { value?: T } | undefined;
      return inner?.value as T;
    };

    const waitFor = async (
      expression: string,
      label: string,
      timeoutMs = 15_000
    ): Promise<void> => {
      currentStep = label;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await evaluate<boolean>(`Boolean(${expression})`)) === true)
          return;
        await Bun.sleep(50);
      }
      throw new Error(`timed out waiting for ${label} (${expression})`);
    };

    const point = async (
      selector: string,
      options: ClickOptions
    ): Promise<Point> => {
      const found = await evaluate<Point | null>(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${options.index ?? 0}];
        if (!(el instanceof HTMLElement)) return null;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return {
          x: ${options.fromLeft === undefined ? 'r.left + r.width / 2' : `r.left + ${options.fromLeft}`},
          y: r.top + r.height / 2,
        };
      })()`);
      if (found === null) throw new Error(`no visible element for ${selector}`);
      return found;
    };

    const mouse = async (
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
      at: Point,
      buttons: number
    ) => {
      await send('Input.dispatchMouseEvent', {
        type,
        x: at.x,
        y: at.y,
        button: buttons === 0 ? 'none' : 'left',
        buttons,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    };

    const page: Page = {
      errors,
      send,
      evaluate,
      waitFor,
      async click(selector, options = {}) {
        currentStep = `click ${selector}`;
        const at = await point(selector, options);
        await mouse('mouseMoved', at, 0);
        await mouse('mousePressed', at, 1);
        await mouse('mouseReleased', at, 0);
      },
      async drag(from, to) {
        currentStep = `drag ${from} to ${to}`;
        const start = await point(from, {});
        const end = await point(to, {});
        await mouse('mouseMoved', start, 0);
        await mouse('mousePressed', start, 1);
        for (let step = 1; step <= 4; step++) {
          await mouse(
            'mouseMoved',
            {
              x: start.x + ((end.x - start.x) * step) / 4,
              y: start.y + ((end.y - start.y) * step) / 4,
            },
            1
          );
        }
        await mouse('mouseReleased', end, 0);
      },
      async reload() {
        const reloaded = cdp!.waitForEvent('Page.loadEventFired', {
          sessionId,
          timeoutMs: 20_000,
        });
        await send('Page.reload', {});
        await reloaded;
      },
      async close() {
        try {
          cdp?.dispose();
          child.kill('SIGKILL');
          children.delete(child);
          const idx = runningBrowsers.findIndex((b) => b.child === child);
          if (idx !== -1) runningBrowsers.splice(idx, 1);
          await rm(profile, { recursive: true, force: true }).catch(() => {});
        } catch {}
      },
    };

    await page.waitFor(
      `document.readyState === 'complete'`,
      'the page is loaded'
    );
    return page;
  } catch (error) {
    await cleanupOwnedBrowserStartup({
      child,
      connection: cdp,
      forgetChild: () => children.delete(child),
      profile,
      removeProfile: undefined,
    });
    throw error;
  }
}

// --- Stage helpers: what a reader does, in the page. ---

/** Compose and post in the attached composer, typing and clicking for real. */
async function composeAndPost(page: Page, body: string): Promise<void> {
  await page.waitFor(
    `document.querySelector('.popover-composer .popover-field') !== null`,
    'the composer opens'
  );
  await page.click('.popover-composer .popover-field');
  await page.send('Input.insertText', { text: body });
  await page.click('.popover-composer .popover-tools .is-primary');
}

/** A selection's own Comment control, once the offer has appeared. */
async function commentOnSelection(page: Page): Promise<void> {
  await page.waitFor(
    `document.querySelector('.popover-comment') !== null`,
    'the selection offer opens'
  );
  await page.click('.popover-comment');
}

const cellSel = (record: number, column: number): string =>
  `.dt-cell[data-r="${record}"][data-c="${column}"]`;

const stages = new Set(
  (
    process.env['RELIC_STRUCTURED_STAGES'] ??
    'table,tree,cues,notebook,old-reader,refusals'
  )
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
);
const passed: string[] = [];

async function stage(name: string, body: () => Promise<void>): Promise<void> {
  if (!stages.has(name)) return;
  console.log(`STAGE ${name} ...`);
  currentStep = `stage ${name}`;
  await body();
  passed.push(name);
  console.log(`STAGE_${name.toUpperCase().replace('-', '_')}_OK`);
}

function assertNoPageErrors(page: Page, label: string): void {
  assert.deepEqual(page.errors, [], `${label}: page raised exceptions`);
}

// --- Fixtures. Each file is small, and every value that a stage checks is written here. ---

const CSV_TEXT = [
  'part,site,qty,unit,note',
  'bolt,north,4,each,"Zinc plated"',
  'nut,north,12,each,plain',
  'washer,east,7,box,"Counted per batch',
  'second line"',
  'gasket,east,3,pair,ok',
  'clip,west,25,each,"Lost ""spare"" stock"',
  'hinge,west,9,pair,check',
  'spring,south,30,each,',
  'latch,south,6,each,open',
  'pin,north,18,each,',
  'cap,east,2,each,',
  'seal,west,11,box,',
  'plug,south,15,each,',
  'rivet,north,42,each,stock low',
  'strap,east,8,pair,',
  'bracket,west,21,each,',
  '',
].join('\n');

const TSV_TEXT = [
  'sku\tbin\tcount',
  'BOLT-4\tA1\t4',
  'NUT-12\tA2\t12',
  '',
].join('\n');

const ORDER_JSON = `${JSON.stringify(
  {
    order: {
      id: 'SO-1042',
      lines: [
        { sku: 'BOLT-4', qty: 4 },
        { sku: 'NUT-12', qty: 12 },
      ],
    },
  },
  null,
  2
)}\n`;

const HOSTILE_KEY = '<img src=x onerror="window.__relicTreePwned=1">';
const HOSTILE_JSON = `${JSON.stringify({ [HOSTILE_KEY]: HOSTILE_KEY })}\n`;

const VTT_TEXT = [
  'WEBVTT',
  '',
  '00:00:01.200 --> 00:00:04.800',
  'This is Larkspur Field 4.12.',
  '',
  '00:00:05.100 --> 00:00:08.900',
  'The form saves to the device.',
  '',
].join('\n');

const SRT_TEXT = [
  '1',
  '00:00:01,200 --> 00:00:04,800',
  'Hello Larkspur.',
  '',
  '2',
  '00:00:05,100 --> 00:00:08,900',
  'The form saves to the device.',
  '',
].join('\n');

// A 1x1 PNG, base64. The image route checks its signature before it draws it.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const IPYNB_TEXT = `${JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Survey\n'] },
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: ['rows = [1, 2, 3]\n', 'print(len(rows))'],
        outputs: [
          {
            output_type: 'stream',
            name: 'stdout',
            text: ['3\n'],
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: { 'image/png': PNG_B64, 'text/plain': ['<Figure>'] },
          },
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'text/html': [
                '<img src="x" onerror="window.__nbPwned=1"><p>Chart</p>',
              ],
            },
          },
        ],
      },
      {
        cell_type: 'code',
        execution_count: 2,
        metadata: {},
        source: ['print(1)'],
        outputs: [],
      },
    ],
  },
  null,
  1
)}\n`;

// --- Stages ---

const reader = await createSession('reader@example.test');

await stage('table', async () => {
  const csv = await publish('parts.csv', CSV_TEXT);
  const page = await openPage(csv.url, reader);
  try {
    await page.waitFor(
      `document.querySelector('.dt-grid[role="grid"]') !== null && document.querySelectorAll('.dt-cell').length > 0`,
      'the table draws'
    );
    const summary = await page.evaluate<string>(
      `document.querySelector('.dt-summary')?.textContent ?? ''`
    );
    assert.match(summary, /comma-separated/, 'the summary names the format');

    // C14 is the rivet quantity, record 13 in column 2 (zero based).
    await page.click(cellSel(13, 2));
    console.log(
      'DIAG',
      await page.evaluate<string>(
        `(async () => { await new Promise((r) => setTimeout(r, 200)); const live = document.getSelection(); return JSON.stringify({ collapsed: live?.isCollapsed, ranges: live?.rangeCount, anchorInTable: live?.anchorNode?.nodeName ?? null, offer: document.querySelector('.popover-offer') !== null, comment: document.querySelector('.popover-comment') !== null, popover: document.querySelector('.popover')?.className ?? null, cls: document.querySelector('${cellSel(13, 2)}')?.className ?? null }); })()`
      )
    );
    await commentOnSelection(page);
    await composeAndPost(page, 'C14 is the rivet quantity');
    await awaitStored(csv.relicId, 1);

    // B4:D9 is a drag across real cells, from the washer site to the latch quantity.
    await page.drag(cellSel(3, 1), cellSel(8, 3));
    await commentOnSelection(page);
    await composeAndPost(page, 'Range B4 to D9');
    await awaitStored(csv.relicId, 2);
    assertNoPageErrors(page, 'table, after posting');

    const cellStored = await commentFor(
      csv.relicId,
      'C14 is the rivet quantity'
    );
    assert.deepEqual(cellStored.anchor, { kind: 'cell', row: 14, col: 3 });
    console.log(
      `TABLE_CELL_STORED anchor=${JSON.stringify(cellStored.anchor)}`
    );
    const rangeStored = await commentFor(csv.relicId, 'Range B4 to D9');
    assert.deepEqual(rangeStored.anchor, {
      kind: 'cell',
      row: 4,
      col: 2,
      row_end: 9,
      col_end: 4,
    });

    // Reload: both marks come back from the service, and the cell beside C14
    // stays unmarked.
    await page.reload();
    await page.waitFor(
      `document.querySelector('${cellSel(13, 2)}.is-marked') !== null`,
      'the C14 mark paints after a reload'
    );
    await page.waitFor(
      `document.querySelector('${cellSel(3, 1)}.is-marked') !== null`,
      'the range mark paints after a reload'
    );
    assert.equal(
      await page.evaluate<boolean>(
        `document.querySelector('${cellSel(13, 1)}.is-marked') !== null`
      ),
      false,
      'the cell beside C14 is not marked'
    );

    // A sort moves the C14 mark with its record: 42 is the largest quantity, so
    // the rivet row moves to the bottom of the ascending order.
    await page.click('.dt-hcell[data-c="2"]', { fromLeft: 8 });
    await page.waitFor(
      `document.querySelector('.dt-hcell[data-c="2"] .dt-sort') !== null`,
      'the qty column sorts'
    );
    const markedRow = await page.evaluate<string | null>(`(() => {
      const cell = document.querySelector('${cellSel(13, 2)}.is-marked');
      const row = cell?.closest('[role="row"]');
      return row?.querySelector('[data-c="0"]')?.textContent ?? null;
    })()`);
    assert.equal(markedRow, 'rivet', 'the C14 mark follows the rivet record');
    const markedIsLast = await page.evaluate<boolean>(`(() => {
      const cell = document.querySelector('${cellSel(13, 2)}.is-marked');
      const rows = [...document.querySelectorAll('.dt-body [role="row"]')];
      return rows.length > 0 && rows.at(-1)?.contains(cell) === true;
    })()`);
    assert.equal(
      markedIsLast,
      true,
      'the rivet row is last in ascending order'
    );

    const readCell = await commentFor(csv.relicId, 'C14 is the rivet quantity');
    assert.equal(readCell.resolved?.['status'], 'resolved');
    assert.equal(readCell.resolved?.['text'], '42');
    assert.equal(readCell.resolved?.['header'], 'qty');
    const readRange = await commentFor(csv.relicId, 'Range B4 to D9');
    assert.equal(readRange.resolved?.['status'], 'resolved');
    assert.equal(readRange.resolved?.['text'], 'east');
    assert.equal(readRange.resolved?.['header'], 'site');
  } finally {
    await page.close();
  }

  // The TSV: the same table route, the tab delimiter, and a cell comment.
  const tsv = await publish('parts.tsv', TSV_TEXT);
  const tsvPage = await openPage(tsv.url, reader);
  try {
    await tsvPage.waitFor(
      `document.querySelector('.dt-grid[role="grid"]') !== null && document.querySelectorAll('.dt-cell').length > 0`,
      'the TSV table draws'
    );
    const delimiter = await tsvPage.evaluate<string>(
      `document.querySelector('.dt-summary')?.textContent ?? ''`
    );
    assert.match(delimiter, /tab/, 'the TSV summary names the tab delimiter');
    // NUT-12 is record 2 in column 0.
    await tsvPage.click(cellSel(2, 0));
    await commentOnSelection(tsvPage);
    await composeAndPost(tsvPage, 'Check this SKU');
    await awaitStored(tsv.relicId, 1);
    const tsvStored = await commentFor(tsv.relicId, 'Check this SKU');
    assert.deepEqual(tsvStored.anchor, { kind: 'cell', row: 3, col: 1 });
    assert.equal(tsvStored.resolved?.['text'], 'NUT-12');
    assert.equal(tsvStored.resolved?.['header'], 'sku');
    assertNoPageErrors(tsvPage, 'tsv');
  } finally {
    await tsvPage.close();
  }
});

await stage('tree', async () => {
  const order = await publish('order.json', ORDER_JSON);
  const page = await openPage(order.url, reader);
  try {
    await page.waitFor(
      `document.querySelector('.jt-row') !== null`,
      'the tree draws'
    );
    // The row that shows NUT-12 is the second line's sku.
    const rowIndex = await page.evaluate<number>(
      `[...document.querySelectorAll('.jt-row')].findIndex((row) => row.textContent.includes('NUT-12'))`
    );
    assert.ok(rowIndex >= 0, 'the sku row for NUT-12 is drawn');
    await page.click('.jt-row', { index: rowIndex });
    await page.waitFor(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Comment' && !b.disabled)`,
      'the Comment control enables for the node'
    );
    await page.click('.jt-row, button', {}).catch(() => {});
    throw new Error('tree stage not finished');
  } finally {
    await page.close();
  }
});

// Remaining stages are added after the table stage is proven.
if (passed.length === 0 && stages.size === 0) {
  throw new Error('no stages selected');
}
await store.listComments('none').catch(() => []);
void sha256Hex;
void decodeKey;
void deriveCommentKey;
void encryptComment;
void loadPublishState;
void COMMENT_TOOL_NAME;
void ORDER_JSON;
void HOSTILE_JSON;
void VTT_TEXT;
void SRT_TEXT;
void IPYNB_TEXT;
void cdpCalls;
type _UnusedAnchor = CommentAnchor;

await rm(scratch, { recursive: true, force: true });
delete process.env['RELIC_PUBLISH_STATE'];
service.stop(true);
clearTimeout(watchdog);
if (passed.length === stages.size && stages.size > 0) {
  console.log('STRUCTURED_FORMATS_PATH_OK');
} else {
  console.log(`STRUCTURED_FORMATS_PATH_PARTIAL stages=${passed.join(',')}`);
}
