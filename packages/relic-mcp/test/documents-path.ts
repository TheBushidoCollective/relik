/**
 * Documents, end to end: a spreadsheet cell, a Word quote and an EPUB quote.
 *
 *   bun packages/relic-mcp/test/documents-path.ts
 *
 * Needs the viewer and the MCP bundle built (`bun run build`, then
 * `bun run --cwd packages/relic-mcp build`) and an isolated headless Chrome
 * named by RELIC_CHROME_PATH, or the owned headless shell when it is present.
 *
 * Each file is published through the MCP `relic_publish` tool and opened in a
 * fresh headless page. A cell is commented with real CDP mouse input. A word in
 * the Word or EPUB frame is double-clicked inside the frame, and the comment is
 * typed and posted. The page posts through the real `/api/relics/:id/comments`
 * route into the in-memory store, and `relic_read_comments` then decrypts what
 * the store holds and resolves it through the built MCP. The assertions read the
 * resolved context back, so they check what was stored, not what the page meant
 * to send.
 *
 * What each stage proves:
 *   xlsx    C14 on "Q3 budget" and B2 on the second sheet are commented. The
 *           resolution names the sheet, the A1 address, the displayed value and
 *           the column header, and reads the right sheet.
 *   docx    The word "Harbor" in the Word frame is commented. The resolution
 *           gives the quote, its paragraph line and the words before it.
 *   epub    The word "washers" in the EPUB frame is commented. The resolution
 *           gives the quote and decodes the &amp; in the words before it.
 *   control Negative control (a), always run: the checker rejects a wrong
 *           expectation, so a passing stage is not a vacuous one.
 *
 * Negative control (b), run by hand and reverted afterwards (it changes product
 * code, so it is not part of the default run):
 *   1. In packages/relic-mcp/src/resolve-workbook.ts, return the header's value
 *      in place of the cell's value (`text` from `valueAt(1, anchor.col)`).
 *   2. `bun run --cwd packages/relic-mcp build`
 *   3. `env -u DISPLAY -u WAYLAND_DISPLAY RELIC_CHROME_PATH=<shell> bun packages/relic-mcp/test/documents-path.ts`
 *      The xlsx stage must fail at "the cell reads its value". It prints no OK line.
 *   4. `git checkout -- packages/relic-mcp/src/resolve-workbook.ts`, rebuild, and run again.
 *
 * The final line is DOCUMENTS_PATH_OK, printed only when every stage and the
 * negative control pass. All proof writes target the loopback in-memory service.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import { READ_COMMENTS_TOOL_NAME } from '../src/server.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import { type FixtureEntry, zipFixture } from './zip-fixture.ts';

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
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const relicMcpBundle = join(packageRoot, 'dist', 'relic-mcp.js');
const viewerDist = join(repo, 'packages/relic-viewer/dist');

const RUN_BUDGET_MS = 600_000;
let currentStep = 'startup';
const children = new Set<ChildProcess>();
const watchdog = setTimeout(() => {
  console.error(
    `DOCUMENTS_PATH_TIMEOUT after ${RUN_BUDGET_MS}ms at step "${currentStep}"`
  );
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
}, RUN_BUDGET_MS);
watchdog.unref?.();

const scratch = await mkdtemp(
  join(await realpath(tmpdir()), 'relic-documents-')
);
const statePath = join(scratch, 'state.json');
const runningBrowsers: Array<{ child: ChildProcess; cdp: CdpConnection }> = [];
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

// --- The service and the usercontent origin: real HTTP on loopback. ---

const store = new MemoryStore();
const fakeNow = Date.now();
let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    handler ? handler(request) : new Response('Not ready', { status: 503 }),
});
let app: { fetch(request: Request): Promise<Response> } | undefined;
const usercontent = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    app ? app.fetch(request) : new Response('Not ready', { status: 503 }),
});
const origin = `http://127.0.0.1:${service.port}`;
const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin },
  store,
  storage,
  now: () => fakeNow,
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
  return app!.fetch(request);
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
  const token = `documents-token-${Math.random().toString(16).slice(2)}`;
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
      RELIC_CLIENT_NAME: 'relic-mcp/documents-path',
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

async function publish(name: string, bytes: Uint8Array): Promise<Published> {
  const path = join(scratch, name);
  await writeFile(path, bytes);
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

interface DomNode {
  readonly nodeId: number;
  readonly parentId?: number;
  readonly backendNodeId: number;
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly attributes?: string[];
  readonly frameId?: string;
}

interface Page {
  readonly errors: string[];
  evaluate<T>(expression: string): Promise<T>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  click(selector: string, index?: number): Promise<void>;
  /** Double-clicks the first occurrence of a word inside the page's frames, with real mouse input. */
  doubleClickInFrame(word: string): Promise<void>;
  /** Waits until the page's frame shows the word as text. */
  waitForFrameText(word: string): Promise<void>;
  escape(): Promise<void>;
  /** Types text into the focused field, as the keyboard would. */
  insertText(text: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

const STYLES_LOADED = `Array.from(document.querySelectorAll('link[rel="stylesheet"]')).every((link) => link.sheet !== null)`;

/** Measures a word's centre inside the element it sits in, in that frame's own viewport. */
const FIND_WORD = `function (word) {
  const walker = this.ownerDocument.createTreeWalker(this, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const at = node.nodeValue.indexOf(word);
    if (at === -1) continue;
    const range = this.ownerDocument.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + word.length);
    const box = range.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  return null;
}`;

async function openPage(url: string, token: string): Promise<Page> {
  const profile = await mkdtemp(join(tmpdir(), 'relic-documents-chrome-'));
  const shared = chromeArgs(chromeExecutable, profile)
    .filter((arg) => !arg.startsWith('--proxy-'))
    .map((arg) =>
      arg === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : arg
    );
  const launch = createBrowserHeadlessLaunch(
    [...shared, '--autoplay-policy=no-user-gesture-required'],
    profile
  );
  const child = spawn(chromeExecutable, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
  });
  children.add(child);
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  runningBrowsers.push({ child, cdp });
  const closeBrowser = async (): Promise<void> => {
    cdp.dispose();
    child.kill('SIGKILL');
    children.delete(child);
    const index = runningBrowsers.findIndex((b) => b.child === child);
    if (index !== -1) runningBrowsers.splice(index, 1);
    await rm(profile, { recursive: true, force: true });
  };
  try {
    await attestBrowserHeadless(cdp, launch);
    const created = (await cdp.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;
    const send = (method: string, params?: Record<string, unknown>) =>
      cdp.send(method, params, sessionId);

    // A frame that Chrome isolates in its own process is attached here, so its
    // nodes and mouse input can be reached through its own session.
    const frameSessions = new Map<string, string>();
    cdp.onEvent((event) => {
      if (event.method === 'Target.attachedToTarget') {
        const info = event.params['targetInfo'] as
          | { type?: unknown; targetId?: unknown }
          | undefined;
        const child = event.params['sessionId'];
        if (
          info?.type === 'iframe' &&
          typeof info.targetId === 'string' &&
          typeof child === 'string'
        ) {
          frameSessions.set(info.targetId, child);
        }
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Network.enable');
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });

    // Only the loopback service and its usercontent origin are reachable.
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
        reqUrl.startsWith(`${usercontentOrigin}/`) ||
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:') ||
        reqUrl === 'about:blank';
      const method = local ? 'Fetch.continueRequest' : 'Fetch.failRequest';
      const extra = local ? {} : { errorReason: 'BlockedByClient' };
      void cdp.send(method, { requestId, ...extra }, sessionId).catch(() => {});
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

    const nodesIn = async (targetSession: string): Promise<DomNode[]> =>
      (
        await cdp.send(
          'DOM.getFlattenedDocument',
          { depth: -1, pierce: true },
          targetSession
        )
      )['nodes'] as DomNode[];

    /** The frame's session and its node list, once the frame is on the page. */
    const frameNodes = async (
      pageNodes: DomNode[]
    ): Promise<
      { session: string; nodes: DomNode[]; isolated: boolean } | undefined
    > => {
      const iframe = pageNodes.find(
        (node) =>
          node.nodeName === 'IFRAME' &&
          (node.attributes ?? []).some(
            (value, index, all) =>
              all[index - 1] === 'class' && value.includes('usercontent-frame')
          )
      );
      if (!iframe) return undefined;
      const isolatedSession =
        iframe.frameId === undefined
          ? undefined
          : frameSessions.get(iframe.frameId);
      if (isolatedSession === undefined) {
        return { session: sessionId, nodes: pageNodes, isolated: false };
      }
      await cdp.send('DOM.enable', {}, isolatedSession);
      return {
        session: isolatedSession,
        nodes: await nodesIn(isolatedSession),
        isolated: true,
      };
    };

    const page: Page = {
      errors,
      evaluate,
      waitFor,
      async click(selector, index = 0) {
        currentStep = `click ${selector}`;
        await waitFor(STYLES_LOADED, 'the view stylesheets are loaded');
        const at = await evaluate<Point | null>(`(() => {
          const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
          if (!(el instanceof HTMLElement)) return null;
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (at === null) throw new Error(`no visible element for ${selector}`);
        for (const [type, buttons, clickCount] of [
          ['mouseMoved', 0, 0],
          ['mousePressed', 1, 1],
          ['mouseReleased', 0, 1],
        ] as const) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: at.x,
            y: at.y,
            button: type === 'mouseMoved' ? 'none' : 'left',
            buttons,
            clickCount,
          });
        }
      },
      async doubleClickInFrame(word) {
        currentStep = `double-click "${word}" in the frame`;
        const deadline = Date.now() + 20_000;
        let target:
          | { session: string; backendNodeId: number; isolated: boolean }
          | undefined;
        while (Date.now() < deadline && target === undefined) {
          const frame = await frameNodes(await nodesIn(sessionId));
          const text = frame?.nodes.find(
            (node) =>
              node.nodeName === '#text' && (node.nodeValue ?? '').includes(word)
          );
          const parent = frame?.nodes.find(
            (node) => node.nodeId === text?.parentId
          );
          if (frame && parent) {
            target = {
              session: frame.session,
              backendNodeId: parent.backendNodeId,
              isolated: frame.isolated,
            };
          } else {
            await Bun.sleep(100);
          }
        }
        if (target === undefined) {
          throw new Error(`the frame never showed "${word}"`);
        }
        const inFrame = (method: string, params: Record<string, unknown>) =>
          cdp.send(method, params, target!.session);
        await inFrame('DOM.scrollIntoViewIfNeeded', {
          backendNodeId: target.backendNodeId,
        });
        const resolved = (await inFrame('DOM.resolveNode', {
          backendNodeId: target.backendNodeId,
        })) as { object: { objectId: string } };
        const measured = (await inFrame('Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          functionDeclaration: FIND_WORD,
          arguments: [{ value: word }],
          returnByValue: true,
        })) as { result: { value?: Point | null } };
        const local = measured.result.value;
        if (!local) throw new Error(`"${word}" has no box in the frame`);
        // An in-process frame reports its box in its own viewport, so the
        // page's frame offset is added. An isolated frame is its own target,
        // and its input takes its own coordinates.
        const offset = target.isolated
          ? { x: 0, y: 0 }
          : await evaluate<Point>(`(() => {
              const r = document.querySelector('iframe.usercontent-frame').getBoundingClientRect();
              return { x: r.left, y: r.top };
            })()`);
        const at = { x: local.x + offset.x, y: local.y + offset.y };
        const inputTarget = target.isolated ? target.session : sessionId;
        await cdp.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseMoved',
            x: at.x,
            y: at.y,
            button: 'none',
            buttons: 0,
            clickCount: 0,
          },
          inputTarget
        );
        for (const clickCount of [1, 2]) {
          for (const [type, buttons] of [
            ['mousePressed', 1],
            ['mouseReleased', 0],
          ] as const) {
            await cdp.send(
              'Input.dispatchMouseEvent',
              { type, x: at.x, y: at.y, button: 'left', buttons, clickCount },
              inputTarget
            );
          }
        }
      },
      async waitForFrameText(word) {
        await waitFor(
          `document.querySelector('iframe.usercontent-frame') !== null`,
          `the frame for "${word}" mounts`,
          20_000
        );
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const frame = await frameNodes(await nodesIn(sessionId));
          if (
            frame?.nodes.some(
              (node) =>
                node.nodeName === '#text' &&
                (node.nodeValue ?? '').includes(word)
            )
          ) {
            return;
          }
          await Bun.sleep(100);
        }
        const shown = await evaluate<string>(
          `document.body.innerText.slice(0, 400)`
        );
        throw new Error(
          `the frame never showed "${word}"; the page shows: ${JSON.stringify(shown)}`
        );
      },
      async insertText(value) {
        await send('Input.insertText', { text: value });
      },
      async escape() {
        for (const type of ['keyDown', 'keyUp'] as const) {
          await send('Input.dispatchKeyEvent', {
            type,
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
          });
        }
      },
      async reload() {
        const reloaded = cdp.waitForEvent('Page.loadEventFired', {
          sessionId,
          timeoutMs: 20_000,
        });
        await send('Page.reload', {});
        await reloaded;
      },
      close: closeBrowser,
    };
    return page;
  } catch (error) {
    await closeBrowser().catch(() => {});
    throw error;
  }
}

// --- Driving the viewer's own comment controls, as a reader does. ---

/** Compose and post in the attached composer, typing and clicking for real. */
async function composeAndPost(page: Page, body: string): Promise<void> {
  await page.waitFor(
    `document.querySelector('.popover-composer .popover-field') !== null`,
    'the composer opens'
  );
  await page.click('.popover-composer .popover-field');
  await page.insertText(body);
  await page.click('.popover-composer .popover-tools .is-primary');
}

const cellSel = (record: number, column: number): string =>
  `.dt-cell[data-r="${record}"][data-c="${column}"]`;

// --- The fixtures: real Office and EPUB packages, deflated as their writers do. ---

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const text = (ref: string, value: string): string =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const number = (ref: string, value: number): string =>
  `<c r="${ref}"><v>${value}</v></c>`;
const row = (index: number, cells: string): string =>
  `<row r="${index}">${cells}</row>`;

function budgetWorkbook(): Uint8Array {
  const sheets = [
    {
      name: 'Q3 budget',
      rows:
        row(1, text('A1', 'Item') + text('B1', 'Plan') + text('C1', 'Q3')) +
        row(
          14,
          text('A14', 'Travel') +
            text('B14', 'Plan value') +
            number('C14', 1200)
        ),
    },
    {
      name: 'Notes',
      rows:
        row(1, text('A1', 'Topic') + text('B1', 'Detail')) +
        row(2, text('A2', 'Shipments') + text('B2', 'Confirmed by ops')),
    },
  ];
  const entries: FixtureEntry[] = [
    { name: '[Content_Types].xml', text: '<Types/>' },
    {
      name: 'xl/workbook.xml',
      text: `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${sheets
        .map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
        )
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `<Relationships xmlns="${PACKAGE_REL_NS}">${sheets
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
        )
        .join('')}</Relationships>`,
    },
  ];
  sheets.forEach((sheet, index) => {
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      text: `<worksheet xmlns="${SHEET_NS}"><sheetData>${sheet.rows}</sheetData></worksheet>`,
      deflate: true,
    });
  });
  return zipFixture(entries);
}

const wordRun = (value: string): string =>
  `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
const wordParagraph = (runs: string): string => `<w:p>${runs}</w:p>`;

function reportDocx(): Uint8Array {
  return zipFixture([
    {
      name: '[Content_Types].xml',
      text: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      text: `<w:document xmlns:w="${WORD_NS}"><w:body>${wordParagraph(
        wordRun('The northern ') +
          wordRun('depot receives shipments on Tuesdays.')
      )}${wordParagraph(
        wordRun('Harbor office holds the spare rivets.')
      )}</w:body></w:document>`,
      deflate: true,
    },
  ]);
}

function yardEpub(): Uint8Array {
  const chapter =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Yard</title></head><body>' +
    '<h1>Yard notes</h1><p>Rivets &amp; washers ship&mdash;slowly from the yard.</p>' +
    '</body></html>';
  return zipFixture([
    { name: 'mimetype', text: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      text: '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OPS/book.opf',
      text: '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Yard</dc:title></metadata><manifest><item id="yard" href="yard.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="yard"/></spine></package>',
    },
    { name: 'OPS/yard.xhtml', text: chapter, deflate: true },
  ]);
}

// --- The stages. ---

const reader = await createSession('reader@example.test');
const passed: string[] = [];
async function stage(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`STAGE ${name} ...`);
  currentStep = `stage ${name}`;
  await body();
  passed.push(name);
  console.log(`STAGE_${name.toUpperCase()}_OK`);
}

try {
  let budget: Published | undefined;
  let budgetCell: ReadComment | undefined;
  let budgetNote: ReadComment | undefined;

  await stage('xlsx', async () => {
    budget = await publish('budget.xlsx', budgetWorkbook());
    const page = await openPage(budget.url, reader);
    try {
      await page.waitFor(
        `document.querySelector('.dt-grid[role="grid"]') !== null && document.querySelector('${cellSel(13, 2)}') !== null`,
        'the workbook grid draws'
      );
      assert.equal(
        await page.evaluate<string>(
          `document.querySelector('${cellSel(13, 2)}')?.textContent`
        ),
        '1200',
        'the viewer draws C14 as 1200'
      );

      // C14 on the first sheet: a single cell, selected and commented.
      await page.click(cellSel(13, 2));
      await commentOnSelection(page);
      await composeAndPost(page, 'C14 is the travel budget');
      await awaitStored(budget.relicId, 1);
      await page.escape();
      await page.waitFor(
        `document.querySelector('.popover-card[data-comment-id]') === null`,
        'the posted card is dismissed'
      );

      // B2 on the second sheet: the anchor must name that sheet.
      await page.click('.spreadsheet-tabs button:nth-child(2)');
      await page.waitFor(
        `document.querySelector('${cellSel(1, 1)}')?.textContent === 'Confirmed by ops'`,
        'the second sheet draws'
      );
      await page.click(cellSel(1, 1));
      await commentOnSelection(page);
      await composeAndPost(page, 'B2 on Notes is confirmed');
      await awaitStored(budget.relicId, 2);
      assertNoPageErrors(page, 'xlsx, after posting');
    } finally {
      await page.close();
    }

    budgetCell = await commentFor(budget.relicId, 'C14 is the travel budget');
    assert.deepEqual(budgetCell.anchor, {
      kind: 'cell',
      sheet: 'Q3 budget',
      row: 14,
      col: 3,
    });
    const cellResolved = budgetCell.resolved;
    assert.equal(
      cellResolved?.['status'],
      'resolved',
      JSON.stringify(cellResolved)
    );
    assert.equal(
      cellResolved?.['sheet'],
      'Q3 budget',
      'the cell names its sheet'
    );
    assert.equal(
      cellResolved?.['address'],
      'C14',
      'the cell names its A1 address'
    );
    assert.equal(cellResolved?.['text'], '1200', 'the cell reads its value');
    assert.equal(
      cellResolved?.['header'],
      'Q3',
      'the cell reads its column header'
    );

    budgetNote = await commentFor(budget.relicId, 'B2 on Notes is confirmed');
    assert.deepEqual(budgetNote.anchor, {
      kind: 'cell',
      sheet: 'Notes',
      row: 2,
      col: 2,
    });
    assert.equal(
      budgetNote.resolved?.['sheet'],
      'Notes',
      'the second sheet is read'
    );
    assert.equal(budgetNote.resolved?.['address'], 'B2');
    assert.equal(budgetNote.resolved?.['text'], 'Confirmed by ops');
    assert.equal(budgetNote.resolved?.['header'], 'Detail');
    console.log(
      `XLSX_CELL_RESOLVED ${JSON.stringify(budgetCell.resolved)} ${JSON.stringify(budgetNote.resolved)}`
    );
  });

  let report: Published | undefined;
  let reportQuote: ReadComment | undefined;
  await stage('docx', async () => {
    report = await publish('report.docx', reportDocx());
    const page = await openPage(report.url, reader);
    try {
      await page.waitForFrameText('Harbor');
      await page.doubleClickInFrame('Harbor');
      await commentOnSelection(page);
      await composeAndPost(page, 'Harbor office note');
      await awaitStored(report.relicId, 1);
      assertNoPageErrors(page, 'docx, after posting');
    } finally {
      await page.close();
    }
    reportQuote = await commentFor(report.relicId, 'Harbor office note');
    assert.equal(reportQuote.anchor?.['kind'], 'quote');
    const resolved = reportQuote.resolved;
    assert.equal(resolved?.['kind'], 'quote', JSON.stringify(resolved));
    assert.equal(resolved?.['status'], 'resolved', JSON.stringify(resolved));
    assert.equal(resolved?.['exact'], 'Harbor');
    assert.equal(resolved?.['line'], 2, 'the quote is in the second paragraph');
    assert.match(
      String(resolved?.['context_before'] ?? ''),
      /shipments on Tuesdays\.\s*$/,
      'the words before the quote are the first paragraph'
    );
    console.log(`DOCX_QUOTE_RESOLVED ${JSON.stringify(resolved)}`);
  });

  let yard: Published | undefined;
  let yardQuote: ReadComment | undefined;
  await stage('epub', async () => {
    yard = await publish('yard.epub', yardEpub());
    const page = await openPage(yard.url, reader);
    try {
      await page.waitForFrameText('washers');
      await page.doubleClickInFrame('washers');
      await commentOnSelection(page);
      await composeAndPost(page, 'washers note');
      await awaitStored(yard.relicId, 1);
      assertNoPageErrors(page, 'epub, after posting');
    } finally {
      await page.close();
    }
    yardQuote = await commentFor(yard.relicId, 'washers note');
    const resolved = yardQuote.resolved;
    assert.equal(resolved?.['kind'], 'quote', JSON.stringify(resolved));
    assert.equal(resolved?.['status'], 'resolved', JSON.stringify(resolved));
    assert.equal(resolved?.['exact'], 'washers');
    assert.equal(
      resolved?.['line'],
      2,
      'the quote is in the paragraph after the heading'
    );
    assert.match(
      String(resolved?.['context_before'] ?? ''),
      /Rivets & $/,
      'the &amp; in the words before the quote reads as &'
    );
    console.log(`EPUB_QUOTE_RESOLVED ${JSON.stringify(resolved)}`);
  });

  await stage('control', async () => {
    // A wrong expectation must fail. A checker that cannot fail proves nothing.
    const refuses = (check: () => void): boolean => {
      try {
        check();
        return false;
      } catch {
        return true;
      }
    };
    assert.equal(
      refuses(() =>
        assert.equal(budgetCell?.resolved?.['text'], 'NOT-THE-VALUE')
      ),
      true,
      'negative control: a wrong expected value must fail the check'
    );
    assert.equal(
      refuses(() => assert.equal(reportQuote?.resolved?.['line'], 1)),
      true,
      'negative control: a wrong expected paragraph must fail the check'
    );
  });

  console.log('DOCUMENTS_PATH_OK');
} finally {
  for (const browser of runningBrowsers) {
    try {
      browser.cdp.dispose();
      browser.child.kill('SIGKILL');
    } catch {}
  }
  for (const child of children) child.kill('SIGKILL');
  service.stop(true);
  usercontent.stop(true);
  await rm(scratch, { recursive: true, force: true });
}

function assertNoPageErrors(page: Page, label: string): void {
  assert.deepEqual(page.errors, [], `page errors during ${label}`);
}

/**
 * A selection's own Comment control, once the offer has appeared. The offer is
 * drawn after the mouse-up that ends a selection, so it is waited for, not sent.
 */
async function commentOnSelection(page: Page): Promise<void> {
  await page.waitFor(
    `document.querySelector('.popover-comment') !== null`,
    'the selection offer opens',
    15_000
  );
  await page.click('.popover-comment');
}
