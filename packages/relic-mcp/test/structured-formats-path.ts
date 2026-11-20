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
 *   layout     The viewer's own stylesheet, measured. At 390 px with touch, no view
 *              makes the page scroll sideways and every control it draws is at
 *              least 44 px. At 1440 px the table inspector is on screen, ArrowUp
 *              never leaves the active cell under the sticky head, a notebook
 *              output's Comment control covers none of its text, the notebook
 *              and tree composers open on screen, a cue list has one View
 *              source, and a refused table's notice is styled and lines up.
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
import { decodeKey, deriveCommentKey } from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { loadPublishState } from '../src/state.ts';
import {
  COMMENT_TOOL_NAME,
  READ_COMMENTS_TOOL_NAME,
  REPUBLISH_TOOL_NAME,
} from '../src/server.ts';
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
  /** Three real presses in one place: selects the whole line or cue text, as a reader does. */
  tripleClick(selector: string, options?: ClickOptions): Promise<void>;
  /** A real pointer move over an element, for controls that appear on hover. */
  hover(selector: string, options?: ClickOptions): Promise<void>;
  drag(
    from: string,
    to: string,
    fromOptions?: ClickOptions,
    toOptions?: ClickOptions
  ): Promise<void>;
  escape(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

interface ClickOptions {
  readonly index?: number;
  /** Measure where the element is now, without scrolling it into view first. */
  readonly noScroll?: boolean;
  /** Pixels from the element's left edge, for controls that sit at one side. */
  readonly fromLeft?: number;
  /** Pixels in from the element's right edge, for a drag that ends at a line's end. */
  readonly fromRight?: number;
}

interface Viewport {
  readonly width: number;
  readonly height: number;
  /** A phone: mobile layout metrics and touch input. */
  readonly phone: boolean;
}

const DESKTOP: Viewport = { width: 1440, height: 900, phone: false };
const PHONE: Viewport = { width: 390, height: 844, phone: true };

/** The last real drag on each page, so a selection that was lost can be redone. */
const lastDrags = new WeakMap<
  object,
  [string, string, ClickOptions, ClickOptions]
>();

async function openPage(
  url: string,
  token: string,
  view: Viewport = DESKTOP
): Promise<Page> {
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
      width: view.width,
      height: view.height,
      deviceScaleFactor: 1,
      mobile: view.phone,
    });
    if (view.phone) {
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
      });
    }
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
      const found = await evaluate<{
        x: number;
        y: number;
        hit: boolean;
        tag: string;
      } | null>(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${options.index ?? 0}];
        if (!(el instanceof HTMLElement)) return null;
        if (${options.noScroll === true ? 'false' : 'true'}) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const x = ${options.fromRight !== undefined ? `r.right - ${options.fromRight}` : options.fromLeft === undefined ? 'r.left + r.width / 2' : `r.left + ${options.fromLeft}`};
        const y = r.top + r.height / 2;
        const under = document.elementFromPoint(x, y);
        return { x, y, hit: el.contains(under), tag: under ? under.outerHTML.slice(0, 160) : 'none' };
      })()`);
      if (found === null) throw new Error(`no visible element for ${selector}`);
      if (!found.hit)
        throw new Error(
          `the pointer at ${found.x},${found.y} would land on ${found.tag}, not ${selector}`
        );
      return { x: found.x, y: found.y };
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
        button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left',
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
      async tripleClick(selector, options = {}) {
        currentStep = `triple-click ${selector}`;
        const at = await point(selector, options);
        await mouse('mouseMoved', at, 0);
        for (let count = 1; count <= 3; count++) {
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: at.x,
            y: at.y,
            button: 'left',
            buttons: 1,
            clickCount: count,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: at.x,
            y: at.y,
            button: 'left',
            buttons: 0,
            clickCount: count,
          });
        }
      },
      async hover(selector, options = {}) {
        currentStep = `hover ${selector}`;
        await mouse('mouseMoved', await point(selector, options), 0);
      },
      async drag(from, to, fromOptions = {}, toOptions = {}) {
        currentStep = `drag ${from} to ${to}`;
        lastDrags.set(page, [from, to, fromOptions, toOptions]);
        // Both ends into view, then the start measured again where it now is:
        // bringing the end into view can scroll the page under the start.
        await point(from, fromOptions);
        const end = await point(to, toOptions);
        const start = await point(from, { ...fromOptions, noScroll: true });
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
      async escape() {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
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

/**
 * A selection's own Comment control, once the offer has appeared. A real drag
 * can be lost while a page is still settling (fonts, layout), so the page's
 * last drag is redone up to twice before the wait gives up. A product that
 * never offers a Comment still fails after the third attempt.
 */
async function commentOnSelection(page: Page): Promise<void> {
  const offer = `document.querySelector('.popover-comment') !== null`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const redo = lastDrags.get(page);
    const last = attempt === 2 || redo === undefined;
    try {
      await page.waitFor(
        offer,
        'the selection offer opens',
        last ? 15_000 : 4_000
      );
      break;
    } catch (error) {
      if (last || redo === undefined) throw error;
      console.log(
        `RETRY the selection offer did not open (attempt ${attempt + 1}); drag again`
      );
      await page.drag(redo[0], redo[1], redo[2], redo[3]);
    }
  }
  await page.click('.popover-comment');
}

const cellSel = (record: number, column: number): string =>
  `.dt-cell[data-r="${record}"][data-c="${column}"]`;

const stages = new Set(
  (
    process.env['RELIC_STRUCTURED_STAGES'] ??
    'table,tree,cues,notebook,old-reader,versions,refusals,layout'
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
    await commentOnSelection(page);
    await composeAndPost(page, 'C14 is the rivet quantity');
    await awaitStored(csv.relicId, 1);
    await page.escape();
    await page.waitFor(
      `document.querySelector('.popover-card[data-comment-id]') === null`,
      'the posted card is dismissed'
    );

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
    const itemIndex = await page.evaluate<number>(
      `[...document.querySelectorAll('.jt-row')].findIndex((row) => row.textContent.startsWith('1:'))`
    );
    assert.ok(itemIndex >= 0, 'the second line item is drawn');
    await page.click('.jt-twist', { index: itemIndex });
    await page.waitFor(
      `[...document.querySelectorAll('.jt-row')].some((row) => row.textContent.includes('NUT-12'))`,
      'the second line expands to its sku'
    );
    const rowIndex = await page.evaluate<number>(
      `[...document.querySelectorAll('.jt-row')].findIndex((row) => row.textContent.includes('NUT-12'))`
    );
    assert.ok(rowIndex >= 0, 'the sku row for NUT-12 is drawn');
    await page.click('.jt-row', { index: rowIndex });
    await page.waitFor(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Comment' && !b.disabled)`,
      'the Comment control enables for the node'
    );
    const commentIndex = await page.evaluate<number>(
      `[...document.querySelectorAll('button')].findIndex((b) => b.textContent.trim() === 'Comment' && !b.disabled)`
    );
    await page.click('button', { index: commentIndex });
    await composeAndPost(page, 'Check this node');
    await awaitStored(order.relicId, 1);
    const stored = await commentFor(order.relicId, 'Check this node');
    assert.deepEqual(stored.anchor, {
      kind: 'path',
      pointer: '/order/lines/1/sku',
    });
    assert.equal(stored.resolved?.['status'], 'resolved');
    assert.match(String(stored.resolved?.['excerpt']), /NUT-12/);

    await page.reload();
    await page.waitFor(
      `document.querySelector('.jt-row') !== null`,
      'the tree redraws after a reload'
    );
    const reopen = await page.evaluate<number>(
      `[...document.querySelectorAll('.jt-row')].findIndex((row) => row.textContent.startsWith('1:'))`
    );
    assert.ok(reopen >= 0, 'the second line item is drawn after a reload');
    await page.click('.jt-twist', { index: reopen });
    await page.waitFor(
      `document.querySelector('.jt-row .jt-mark') !== null`,
      'the node mark paints after a reload'
    );
    const markedRows = await page.evaluate<string[]>(
      `[...document.querySelectorAll('.jt-row')].filter((row) => row.querySelector('.jt-mark') !== null).map((row) => row.textContent)`
    );
    assert.equal(markedRows.length, 1, 'exactly one node is marked');
    assert.match(markedRows[0] ?? '', /NUT-12/, 'the mark is on the sku row');
    assertNoPageErrors(page, 'tree');
  } finally {
    await page.close();
  }

  // A key and a value that are HTML draw as text. No element is created and
  // the attribute's script never runs.
  const hostile = await publish('hostile.json', HOSTILE_JSON);
  const hostilePage = await openPage(hostile.url, reader);
  try {
    await hostilePage.waitFor(
      `document.querySelector('.jt-row') !== null`,
      'the hostile tree draws'
    );
    const probe = await hostilePage.evaluate<{
      elements: number;
      ran: boolean;
      shown: boolean;
    }>(`({
      elements: document.querySelectorAll('.jt-rows img, .jt-rows script, .jt-rows iframe').length,
      ran: window.__relicTreePwned !== undefined,
      shown: (document.querySelector('.jt-rows')?.textContent ?? '').includes('<img src=x'),
    })`);
    assert.deepEqual(
      probe,
      { elements: 0, ran: false, shown: true },
      'hostile keys draw as text, not elements'
    );
    assertNoPageErrors(hostilePage, 'hostile tree');
  } finally {
    await hostilePage.close();
  }
});

await stage('cues', async () => {
  // The VTT cue 1 (1.2 to 4.8 seconds) and the SRT cue 2 (5.1 to 8.9 seconds).
  const cueCases = [
    {
      file: 'talk.vtt',
      text: VTT_TEXT,
      index: 0,
      body: 'Quote check',
      anchor: { kind: 'time', t: 1.2, t_end: 4.8 },
      cue: 'This is Larkspur Field 4.12.',
    },
    {
      file: 'talk.srt',
      text: SRT_TEXT,
      index: 1,
      body: 'Save note',
      anchor: { kind: 'time', t: 5.1, t_end: 8.9 },
      cue: 'The form saves to the device.',
    },
  ];
  for (const item of cueCases) {
    const cues = await publish(item.file, item.text);
    const page = await openPage(cues.url, reader);
    try {
      await page.waitFor(
        `document.querySelectorAll('.cue-text').length > ${item.index}`,
        `the ${item.file} cue list draws`
      );
      await page.drag(
        '.structured-cues .cue',
        '.structured-cues .cue-text',
        { index: item.index, fromLeft: 2 },
        { index: item.index, fromRight: 1 }
      );
      await commentOnSelection(page);
      await composeAndPost(page, item.body);
      await awaitStored(cues.relicId, 1);

      const stored = await commentFor(cues.relicId, item.body);
      assert.deepEqual(stored.anchor, item.anchor, `${item.file} span`);
      assert.equal(stored.resolved?.['kind'], 'time');
      const resolvedCues = stored.resolved?.['cues'] as
        | Array<{ text: string }>
        | undefined;
      assert.deepEqual(
        resolvedCues?.map((c) => c.text),
        [item.cue],
        `${item.file} resolves to its one cue`
      );

      await page.reload();
      await page.waitFor(
        `document.querySelector('.cue.is-commented') !== null`,
        `the ${item.file} cue mark paints after a reload`
      );
      const marked = await page.evaluate<string[]>(
        `[...document.querySelectorAll('.cue.is-commented .cue-text')].map((el) => el.textContent)`
      );
      assert.deepEqual(marked, [item.cue], 'only the commented cue is marked');
      assertNoPageErrors(page, item.file);
    } finally {
      await page.close();
    }
  }
});

await stage('notebook', async () => {
  const nb = await publish('survey.ipynb', IPYNB_TEXT);
  const page = await openPage(nb.url, reader);
  try {
    await page.waitFor(
      `document.querySelector('.nb-comment[data-pointer="/cells/1"]') !== null`,
      'the notebook draws'
    );
    await page.hover('.nb-cell[data-cell="1"] .nb-box');
    await page.click('.nb-comment[data-pointer="/cells/1"]');
    await composeAndPost(page, 'Why print here');
    await awaitStored(nb.relicId, 1);
    // The posted card opens beside its control now; close it, as a reader would,
    // before reaching for the output's control next to it.
    await page.escape();
    await page.waitFor(
      `document.querySelector('.popover-card[data-comment-id]') === null`,
      'the posted notebook card is dismissed'
    );
    await page.hover('.nb-cell[data-cell="1"] .nb-out.is-stream');
    await page.click('.nb-comment[data-pointer="/cells/1/outputs/0"]');
    await composeAndPost(page, 'Stream line');
    await awaitStored(nb.relicId, 2);

    const cell = await commentFor(nb.relicId, 'Why print here');
    assert.deepEqual(cell.anchor, { kind: 'path', pointer: '/cells/1' });
    assert.equal(cell.resolved?.['type'], 'cell');
    assert.equal(cell.resolved?.['cell_type'], 'code');
    const output = await commentFor(nb.relicId, 'Stream line');
    assert.deepEqual(output.anchor, {
      kind: 'path',
      pointer: '/cells/1/outputs/0',
    });
    assert.equal(output.resolved?.['type'], 'output');
    assert.equal(output.resolved?.['cell_type'], 'code');
    assert.equal(output.resolved?.['output_type'], 'stream');

    // The HTML output shows its placeholder. Its markup never becomes an element
    // and its onerror never runs. The PNG output draws as an image.
    const probe = await page.evaluate<{
      placeholder: boolean;
      frames: number;
      rogueImages: number;
      ran: boolean;
      png: boolean;
    }>(`({
      placeholder: document.body.textContent.includes('This output is HTML (or a widget) and is not run here.'),
      frames: document.querySelectorAll('.nb iframe, .nb script').length,
      rogueImages: document.querySelectorAll('.nb img[src="x"]').length,
      ran: window.__nbPwned !== undefined,
      png: document.querySelector('.nb img[alt="Image output, PNG"]') !== null,
    })`);
    assert.deepEqual(
      probe,
      { placeholder: true, frames: 0, rogueImages: 0, ran: false, png: true },
      'HTML is never rendered; the PNG draws'
    );
    assertNoPageErrors(page, 'notebook');
  } finally {
    await page.close();
  }
});

await stage('old-reader', async () => {
  // A comment whose anchor kind this viewer does not register. Sealed with the
  // relic's own key, as a newer writer would seal it, and posted with the
  // publish token the way the MCP posts.
  const csv = await publish('legacy.csv', CSV_TEXT);
  const state = await loadPublishState(csv.relicId);
  assert.ok(state, 'the publish state holds the relic');
  const key = await deriveCommentKey(decodeKey(state.key));
  // The format writer refuses an anchor it would read as unsupported, which is the
  // right rule for writers. This seal skips that guard on purpose, to play the
  // newer writer. The envelope is the one encryptComment builds: 12 random bytes,
  // then AES-GCM over the JSON, base64url. The reader under test is the viewer's.
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      body: 'Written by a newer reader',
      display_name: null,
      anchor: { kind: 'cell-v2', row: 2, col: 1 },
    })
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext)
  );
  const framed = new Uint8Array(nonce.length + sealed.length);
  framed.set(nonce, 0);
  framed.set(sealed, nonce.length);
  const ciphertext = Buffer.from(framed).toString('base64url');
  const seeded = await fetch(`${origin}/api/relics/${csv.relicId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publish_token: state.publish_token,
      ciphertext,
    }),
  });
  assert.equal(seeded.status, 201, `seeding the comment: ${seeded.status}`);

  const page = await openPage(csv.url, reader);
  try {
    await page.waitFor(
      `document.querySelector('.dt-grid[role="grid"]') !== null`,
      'the table draws'
    );
    await page.waitFor(
      `document.body.textContent.includes('Written by a newer reader')`,
      'the newer comment is listed'
    );
    const copy = await page.evaluate<{ note: boolean; body: boolean }>(`({
      note: document.body.textContent.includes('This comment points at part of the document that this page cannot show.'),
      body: document.body.textContent.includes('Written by a newer reader'),
    })`);
    assert.deepEqual(
      copy,
      { note: true, body: true },
      'the plan unplaceable note shows, and the body stays readable'
    );
    assertNoPageErrors(page, 'old reader');
  } finally {
    await page.close();
  }
});

await stage('versions', async () => {
  // Version one carries a comment on the rivet quantity (record 14, column 3).
  // Version two inserts one record above it, so the same grid position now
  // holds another record. A version one comment must not paint on version two.
  const csv = await publish('versions.csv', CSV_TEXT);
  const page = await openPage(csv.url, reader);
  const path = join(scratch, 'versions.csv');
  try {
    await page.waitFor(
      `document.querySelector('.dt-grid[role="grid"]') !== null && document.querySelectorAll('.dt-cell').length > 0`,
      'the version one table draws'
    );
    await page.click(cellSel(13, 2));
    await commentOnSelection(page);
    await composeAndPost(page, 'Version one: rivet quantity');
    await awaitStored(csv.relicId, 1);
    await page.escape();
    await page.waitFor(
      `document.querySelector('.popover-card[data-comment-id]') === null`,
      'the version one card is dismissed'
    );
    const v1Comment = await commentFor(
      csv.relicId,
      'Version one: rivet quantity'
    );
    assert.deepEqual(v1Comment.anchor, { kind: 'cell', row: 14, col: 3 });

    const [header, ...records] = CSV_TEXT.split('\n');
    await writeFile(
      path,
      [header, 'extra,north,0,each,added', ...records].join('\n')
    );
    const republished = await callTool(REPUBLISH_TOOL_NAME, {
      relic_id: csv.relicId,
      path,
      cover: false,
      notify: false,
      addresses: [
        {
          comment_id: v1Comment.comment_id,
          note: 'Record moved on version two.',
        },
      ],
    });
    assert.notEqual(republished.isError, true, JSON.stringify(republished));

    // The share link opens the current version, which is now version two.
    await page.reload();
    await page.waitFor(
      `document.querySelector('.dt-grid[role="grid"]') !== null && document.querySelectorAll('.dt-cell').length > 0`,
      'the version two table draws'
    );
    // Positive control: a version two comment on a cell that exists on version
    // two. Its mark proves the version two thread has loaded before the
    // negative check below reads the grid.
    await page.click(cellSel(1, 2));
    await commentOnSelection(page);
    await composeAndPost(page, 'Version two: added record quantity');
    await awaitStored(csv.relicId, 3);
    await page.escape();
    await page.waitFor(
      `document.querySelector('.popover-card[data-comment-id]') === null`,
      'the version two card is dismissed'
    );
    await page.reload();
    await page.waitFor(
      `document.querySelector('${cellSel(1, 2)}.is-marked') !== null`,
      'the version two comment paints on version two'
    );
    assert.equal(
      await page.evaluate<boolean>(
        `document.querySelector('${cellSel(13, 2)}.is-marked') !== null`
      ),
      false,
      'the version one comment is not drawn on version two'
    );

    // Version one, from the version control: its comment paints on its own
    // record, and the version two comment does not.
    await page.click('.version-trigger');
    await page.click('.version-option[data-version="1"]');
    await page.waitFor(
      `document.querySelector('${cellSel(13, 2)}.is-marked') !== null`,
      'the version one comment paints on version one'
    );
    assert.equal(
      await page.evaluate<boolean>(
        `document.querySelector('${cellSel(1, 2)}.is-marked') !== null`
      ),
      false,
      'the version two comment is not drawn on version one'
    );
    assertNoPageErrors(page, 'versions');
  } finally {
    await page.close();
  }
});

await stage('refusals', async () => {
  // Negative control (a): every malformed anchor is refused by the MCP before
  // anything reaches the service.
  const csv = await publish('refusals.csv', CSV_TEXT);
  const before = (await store.listComments(csv.relicId)).length;
  const malformed: Array<{ label: string; anchor: Record<string, unknown> }> = [
    { label: 'row zero', anchor: { kind: 'cell', row: 0, col: 1 } },
    {
      label: 'column past the Excel width',
      anchor: { kind: 'cell', row: 2, col: 16385 },
    },
    {
      label: 'unknown field',
      anchor: { kind: 'cell', row: 2, col: 2, bogus: true },
    },
    {
      label: 'range ending before it starts',
      anchor: { kind: 'cell', row: 4, col: 2, row_end: 3, col_end: 4 },
    },
    {
      label: 'pointer without a slash',
      anchor: { kind: 'path', pointer: 'name' },
    },
    {
      label: 'pointer with a bad escape',
      anchor: { kind: 'path', pointer: '/a~2' },
    },
  ];
  for (const { label, anchor } of malformed) {
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: csv.relicId,
      body: `refused: ${label}`,
      anchor,
    });
    assert.equal(result.isError, true, `${label} is refused`);
    assert.equal(
      result.structuredContent?.['code'],
      'local_comment_anchor_invalid',
      `${label} is refused by the anchor validator`
    );
  }
  const after = (await store.listComments(csv.relicId)).length;
  assert.equal(after, before, 'no refused comment reached the service');
});

// --- Layout, measured on the real viewer stylesheet (UX review). ---

/** In the page: the view's own controls a finger must hit, as rects. */
const SMALL_TARGETS = `(() => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const scope = [...document.querySelectorAll('.structured-view, .toggle-row')];
  const controls = scope.flatMap((root) => [...root.querySelectorAll('button, input, select, label')]);
  return controls
    .filter(shown)
    .filter((el) => !(el.tagName === 'INPUT' && el.closest('label') !== null))
    .filter((el) => !el.closest('.dt-grid'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { what: (el.className || el.tagName) + ' ' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) };
    })
    .filter((t) => t.w < 44 || t.h < 44);
})()`;

/** In the page: the page itself scrolls sideways (a wide grid scrolls inside its own box). */
const PAGE_OVERFLOW = `document.documentElement.scrollWidth - window.innerWidth`;

/** In the page: a rect, as [left, top, right, bottom], or null. */
const rectOf = (selector: string): string =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null; })()`;

const LONG_CSV = [
  'part,qty',
  ...Array.from({ length: 400 }, (_, i) => `part-${i},${i}`),
  '',
].join('\n');

const LONG_STREAM = 'Loaded 1,284 rows from 8 sites; '.repeat(8).trim();
const LAYOUT_IPYNB = `${JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Survey\n'] },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      source: ['print(summary)'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: [LONG_STREAM] }],
    },
  ],
})}\n`;

await stage('layout', async () => {
  // Every measurement is taken before any verdict, so one run names every
  // layout rule that fails, not only the first.
  const failures: string[] = [];
  const check = (ok: unknown, label: string): void => {
    if (!ok) failures.push(label);
  };
  const cases = [
    { name: 'layout-table.csv', text: CSV_TEXT, ready: '.dt-cell' },
    { name: 'layout-tree.json', text: ORDER_JSON, ready: '.jt-row' },
    { name: 'layout-cues.vtt', text: VTT_TEXT, ready: '.cue-text' },
    { name: 'layout-notebook.ipynb', text: LAYOUT_IPYNB, ready: '.nb-cell' },
  ];
  const published = new Map<string, Published>();
  for (const item of cases) {
    published.set(item.name, await publish(item.name, item.text));
  }

  // On a phone: the page never scrolls sideways, and every control the view
  // draws is at least 44 by 44 px.
  for (const item of cases) {
    const page = await openPage(published.get(item.name)!.url, reader, PHONE);
    try {
      await page.waitFor(
        `document.querySelector('${item.ready}') !== null`,
        `${item.name} draws on a phone`
      );
      if (item.ready === '.dt-cell') {
        await page.click(cellSel(2, 0));
        await page.waitFor(
          `document.querySelector('.dt-cellbar .dt-copy') !== null`,
          'the inspector opens on a phone'
        );
      }
      // A chosen node shows its breadcrumb; a chosen notebook cell its Comment.
      if (item.ready === '.jt-row') {
        await page.click('.jt-row', { index: 1 });
      }
      if (item.ready === '.nb-cell') {
        await page.click('.nb-cell[data-cell="1"] .nb-box');
        try {
          await page.waitFor(
            `document.querySelector('.nb-comment[data-pointer="/cells/1"]')?.getBoundingClientRect().height > 0`,
            'the chosen cell shows its Comment on a phone'
          );
        } catch (error) {
          const seen = await page.evaluate<string>(
            `(() => { const box = document.querySelector('.nb-cell[data-cell="1"] .nb-box'); if (!box) return 'no box'; const r = box.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return JSON.stringify({ classes: box.className, rect: [r.left, r.top, r.width, r.height], hit: hit ? hit.className || hit.tagName : null, inner: [innerWidth, innerHeight], narrow: matchMedia('(max-width: 40rem)').matches, selected: document.querySelectorAll('.is-selected').length, tools: getComputedStyle(box.querySelector('.nb-tools')).display }); })()`
          );
          throw new Error(`${String(error)} | seen=${seen}`);
        }
      }
      const overflow = await page.evaluate<number>(PAGE_OVERFLOW);
      const small = await page.evaluate<unknown[]>(SMALL_TARGETS);
      console.log(
        `LAYOUT_PHONE ${item.name} overflow=${overflow} small=${JSON.stringify(small)}`
      );
      check(
        overflow <= 0,
        `${item.name}: the page scrolls ${overflow} px sideways at 390 px`
      );
      check(small.length === 0, `${item.name}: controls under 44 px at 390 px`);
      assertNoPageErrors(page, `${item.name} on a phone`);
    } finally {
      await page.close();
    }
  }

  // A table on a desktop: the inspector is on screen when a cell is chosen, and
  // moving up past the top row never leaves the active cell under the sticky head.
  const long = await publish('layout-long.csv', LONG_CSV);
  const tablePage = await openPage(long.url, reader);
  try {
    await tablePage.waitFor(
      `document.querySelector('.dt-cell') !== null`,
      'the long table draws'
    );
    await tablePage.evaluate(
      `(() => { const g = document.querySelector('.dt-grid'); g.scrollTop = 2000; g.dispatchEvent(new Event('scroll')); })()`
    );
    await Bun.sleep(200);
    const first = await tablePage.evaluate<number>(`(() => {
      const head = document.querySelector('.dt-head').getBoundingClientRect().bottom;
      const cells = [...document.querySelectorAll('.dt-cell[data-c="0"]')];
      const top = cells.filter((c) => c.getBoundingClientRect().top >= head).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      return Number(top?.dataset.r ?? -1);
    })()`);
    assert.ok(first > 2, 'a row below the head is drawn');
    // A press where the cell already is: the shared click helper centres its
    // target first, which would scroll the grid away from the head.
    const at = await tablePage.evaluate<{ x: number; y: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(cellSel(first, 0))}).getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`
    );
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await tablePage.send('Input.dispatchMouseEvent', {
        type,
        x: at.x,
        y: at.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
    for (const _ of [1, 2]) {
      await tablePage.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'ArrowUp',
        code: 'ArrowUp',
        windowsVirtualKeyCode: 38,
      });
      await tablePage.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowUp',
        code: 'ArrowUp',
        windowsVirtualKeyCode: 38,
      });
      await Bun.sleep(100);
    }
    const active = await tablePage.evaluate<
      [number, number, number, number] | null
    >(rectOf('.dt-cell.is-active'));
    const head = await tablePage.evaluate<
      [number, number, number, number] | null
    >(rectOf('.dt-head'));
    const value = await tablePage.evaluate<
      [number, number, number, number] | null
    >(rectOf('.dt-cellbar'));
    const height = await tablePage.evaluate<number>('window.innerHeight');
    console.log(
      `LAYOUT_TABLE active=${JSON.stringify(active)} head=${JSON.stringify(head)} value=${JSON.stringify(value)} viewport=${height}`
    );
    check(
      active && head && active[1] >= head[3] - 1,
      'the active cell is hidden under the sticky head after ArrowUp'
    );
    check(
      value && value[1] >= 0 && value[3] <= height,
      'the inspector is not wholly on screen'
    );
    assertNoPageErrors(tablePage, 'long table');
  } finally {
    await tablePage.close();
  }

  // A notebook on a desktop: an output's Comment control never covers the
  // output's text, and the composer opens on screen beside its control.
  const nbPage = await openPage(
    published.get('layout-notebook.ipynb')!.url,
    reader
  );
  try {
    await nbPage.waitFor(
      `document.querySelector('.nb-out.is-stream') !== null`,
      'the notebook draws'
    );
    await nbPage.hover('.nb-cell[data-cell="1"] .nb-out.is-stream');
    const covered = await nbPage.evaluate<{
      tool: number[] | null;
      hits: number;
    }>(`(() => {
      const out = document.querySelector('.nb-cell[data-cell="1"] .nb-out.is-stream');
      const tool = out.querySelector('.nb-tools');
      const t = tool?.getBoundingClientRect();
      if (!t || t.width === 0) return { tool: null, hits: 0 };
      const walker = document.createTreeWalker(out, NodeFilter.SHOW_TEXT);
      let hits = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (tool.contains(node) || node.parentElement.closest('.nb-out-kind')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.right > t.left && r.left < t.right && r.bottom > t.top && r.top < t.bottom) hits++;
        }
      }
      return { tool: [t.left, t.top, t.right, t.bottom].map(Math.round), hits };
    })()`);
    console.log(`LAYOUT_NOTEBOOK_TOOL ${JSON.stringify(covered)}`);
    check(covered.tool !== null, 'the output Comment control shows on hover');
    check(covered.hits === 0, 'the output Comment control covers output text');

    await nbPage.hover('.nb-cell[data-cell="1"] .nb-box');
    await nbPage.click('.nb-comment[data-pointer="/cells/1"]');
    await nbPage.waitFor(
      `document.querySelector('.popover-composer .popover-field') !== null`,
      'the notebook composer opens'
    );
    await Bun.sleep(300);
    type Rect = [number, number, number, number];
    const composer = await nbPage.evaluate<Rect | null>(
      rectOf('.popover-composer')
    );
    const box = await nbPage.evaluate<Rect | null>(
      rectOf('.nb-cell[data-cell="1"] .nb-box')
    );
    const height = await nbPage.evaluate<number>('window.innerHeight');
    console.log(
      `LAYOUT_NOTEBOOK_COMPOSER cell=${JSON.stringify(box)} composer=${JSON.stringify(composer)} viewport=${height}`
    );
    check(
      composer && composer[1] >= 0 && composer[3] <= height,
      'the notebook composer opens off screen'
    );
    // Beside its cell: the gap between the cell box and the composer, above or
    // below, is at most 24 px.
    check(
      composer &&
        box &&
        Math.max(composer[1] - box[3], box[1] - composer[3]) <= 24,
      'the notebook composer opens away from its cell'
    );
    assertNoPageErrors(nbPage, 'layout notebook');
  } finally {
    await nbPage.close();
  }

  // A tree on a desktop: the composer opens on screen; a cue list has one View source.
  const treePage = await openPage(
    published.get('layout-tree.json')!.url,
    reader
  );
  try {
    await treePage.waitFor(
      `document.querySelector('.jt-row') !== null`,
      'the tree draws'
    );
    await treePage.click('.jt-row', { index: 1 });
    const index = await treePage.evaluate<number>(
      `[...document.querySelectorAll('button')].findIndex((b) => b.textContent.trim() === 'Comment' && !b.disabled)`
    );
    await treePage.click('button', { index });
    await treePage.waitFor(
      `document.querySelector('.popover-composer .popover-tools .is-primary') !== null`,
      'the tree composer opens'
    );
    await Bun.sleep(300);
    const post = await treePage.evaluate<number[] | null>(
      rectOf('.popover-composer .popover-tools .is-primary')
    );
    const field = await treePage.evaluate<number[] | null>(
      rectOf('.popover-composer .popover-field')
    );
    const hit = await treePage.evaluate<boolean>(
      `(() => { const p = document.querySelector('.popover-composer .popover-tools .is-primary').getBoundingClientRect(); const at = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2); return at !== null && at.closest('.popover-composer') !== null; })()`
    );
    console.log(
      `LAYOUT_TREE_COMPOSER field=${JSON.stringify(field)} post=${JSON.stringify(post)} hit=${hit}`
    );
    check(hit, 'the tree composer Post button is covered or off screen');
    assertNoPageErrors(treePage, 'layout tree');
  } finally {
    await treePage.close();
  }

  const cuePage = await openPage(published.get('layout-cues.vtt')!.url, reader);
  try {
    await cuePage.waitFor(
      `document.querySelector('.cue-text') !== null`,
      'the cues draw'
    );
    const sources = await cuePage.evaluate<number>(
      `[...document.querySelectorAll('button')].filter((b) => /View source/.test(b.textContent) || b.getAttribute('aria-label') === 'View source').length`
    );
    console.log(`LAYOUT_CUES view_source_controls=${sources}`);
    check(sources === 1, 'a cue list shows one View source control');
  } finally {
    await cuePage.close();
  }

  // A refused table: the reason is styled and lines up with the source under it.
  const broken = await publish('layout-broken.csv', 'part,qty\nbolt,"4\n');
  const brokenPage = await openPage(broken.url, reader);
  try {
    await brokenPage.waitFor(
      `document.querySelector('.structured-notice') !== null`,
      'the refusal notice shows'
    );
    const notice = await brokenPage.evaluate<{
      border: string;
      noticeLeft: number;
      sourceLeft: number | null;
    }>(`(() => {
      const n = document.querySelector('.structured-notice');
      const s = n.nextElementSibling ?? n.parentElement.querySelector('pre');
      return { border: getComputedStyle(n).borderLeftWidth, noticeLeft: Math.round(n.getBoundingClientRect().left), sourceLeft: s ? Math.round(s.getBoundingClientRect().left) : null };
    })()`);
    console.log(`LAYOUT_NOTICE ${JSON.stringify(notice)}`);
    check(notice.border === '3px', 'the refusal notice is unstyled');
    check(
      notice.sourceLeft !== null &&
        Math.abs(notice.noticeLeft - notice.sourceLeft) <= 1,
      'the refusal notice does not line up with its source'
    );
  } finally {
    await brokenPage.close();
  }
  assert.deepEqual(failures, [], 'layout rules that fail');
});

await rm(scratch, { recursive: true, force: true });
delete process.env['RELIC_PUBLISH_STATE'];
service.stop(true);
clearTimeout(watchdog);
const allStages = [
  'table',
  'tree',
  'cues',
  'notebook',
  'old-reader',
  'refusals',
  'layout',
];
if (allStages.every((name) => passed.includes(name))) {
  console.log('STRUCTURED_FORMATS_PATH_OK');
} else {
  console.log(`STRUCTURED_FORMATS_PATH_PARTIAL stages=${passed.join(',')}`);
}
