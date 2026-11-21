/**
 * Reader suggestion path against the built viewer, MCP bundle and loopback service.
 *
 *   mise exec -- bun run --cwd packages/relic-viewer build
 *   mise exec -- bun run --cwd packages/relic-mcp build
 *   RELIC_CHROME_PATH=<headless-shell> RELIC_SUGGEST_MAIN_DIST=<efa3afee dist> \
 *     mise exec -- bun packages/relic-mcp/test/suggested-edits-path.ts
 *
 * The two readers use separate Chrome browser contexts and authenticated sessions.
 * No request made by this proof is allowed outside its loopback service.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { decryptComment, deriveCommentKey, parseFragment } from '@relic/format';
import {
  type SuggestionInput,
  mergeSuggestions,
  resolveSuggestions,
} from '@relic/format/suggestions';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { renderMarkdown } from '../../relic-viewer/src/markdown.ts';
import { TABLE_SUGGEST_PATH_CRLF } from '../../relic-viewer/test/table-suggest-fixture.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const viewerDist = join(root, 'packages/relic-viewer/dist');
const bundle = join(root, 'packages/relic-mcp/dist/relic-mcp.js');
const legacyDist = process.env['RELIC_SUGGEST_MAIN_DIST'];
const scratch = await mkdtemp(join(tmpdir(), 'relic-suggested-edits-path-'));
const statePath = join(scratch, 'state.json');
const store = new MemoryStore();
const writes: Array<{ method: string; path: string; status: number }> = [];
let handler: ((request: Request) => Promise<Response>) | undefined;
let heldComment:
  | {
      id: string;
      entered: () => void;
      resume: Promise<void>;
    }
  | undefined;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    handler?.(request) ?? new Response('Not ready', { status: 503 }),
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
function appFor(dist: string) {
  return createApp({
    config: { serviceOrigin: origin },
    store,
    storage,
    assets: diskAssets(dist),
    now: () => Date.now(),
    operatorTokens,
    mailer: { send: async () => {}, sendMail: async () => {} },
  });
}
let app = appFor(viewerDist);
handler = async (request) => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const id = url.pathname.slice('/__storage/upload/'.length);
    storage.put(id, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const id = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(id);
    return bytes === undefined
      ? new Response('Not found', { status: 404 })
      : new Response(Buffer.from(bytes), {
          headers: { 'content-type': 'application/octet-stream' },
        });
  }
  if (
    heldComment &&
    request.method === 'POST' &&
    url.pathname === `/api/relics/${heldComment.id}/comments`
  ) {
    heldComment.entered();
    await heldComment.resume;
  }
  const response = await app.fetch(request);
  if (
    /\/comments(?:\/[^/]+)?$/.test(url.pathname) &&
    ['POST', 'PATCH', 'DELETE'].includes(request.method)
  ) {
    writes.push({
      method: request.method,
      path: url.pathname,
      status: response.status,
    });
  }
  return response;
};

interface ToolResult {
  readonly isError: boolean;
  readonly structuredContent: Record<string, unknown>;
}
async function mcp(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['node', bundle], {
    cwd: scratch,
    env: {
      ...process.env,
      RELIC_MCP_HTTP: '0',
      RELIC_SERVICE_ORIGIN: origin,
      RELIC_ORIGIN: origin,
      RELIC_PUBLISH_STATE: statePath,
      RELIC_CLIENT_NAME: 'relic-mcp/suggested-edits-path',
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
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  const receive = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        assert.equal(message['id'], id, `${name}: unexpected RPC id`);
        assert.equal(
          message['error'],
          undefined,
          `${name}: ${JSON.stringify(message['error'])}`
        );
        assert.ok(message['result'], `${name}: missing RPC result`);
        return message['result'] as Record<string, unknown>;
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
        clientInfo: { name: 'suggested-edits-path', version: '1' },
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
    const result = (await receive(2)) as unknown as ToolResult;
    child.stdin.end();
    const exit = await child.exited;
    const errors = await stderr;
    assert.equal(exit, 0, `${name}: MCP exit ${exit}: ${errors}`);
    assert.equal(
      result.isError,
      false,
      `${name}: ${JSON.stringify(result.structuredContent)}`
    );
    assert.ok(result.structuredContent, `${name}: no structured response`);
    return result.structuredContent;
  } finally {
    clearTimeout(timer);
    child.kill();
    reader.releaseLock();
  }
}
async function session(email: string): Promise<string> {
  const token = `suggested-edits-${randomUUID()}`;
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
  timeout = 30_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type FetchTrace = { url: string; method: string; keepalive: boolean };
interface Page {
  readonly target: string;
  readonly id: string;
  readonly context: string;
  readonly trace: FetchTrace[];
  blocked: boolean;
  blockedWrites: number;
  send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  wait(expression: string, label: string): Promise<void>;
}
interface Browser {
  readonly child: ChildProcess;
  readonly cdp: CdpConnection;
  readonly profile: string;
  readonly pages: Page[];
  open(url: string, token: string): Promise<Page>;
  close(): Promise<void>;
}
async function browser(): Promise<Browser> {
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
  const profile = await mkdtemp(join(tmpdir(), 'relic-suggestions-chrome-'));
  const launch = createBrowserHeadlessLaunch(
    chromeArgs(found.path, profile).map((arg) =>
      arg === '--proxy-bypass-list=<-loopback>'
        ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${service.port}`
        : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
    ),
    profile
  );
  const child = spawn(found.path, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  child.stderr?.resume();
  let cdp: CdpConnection | undefined;
  const pages: Page[] = [];
  try {
    cdp = connectPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    await attestBrowserHeadless(cdp, launch);
    const connection = cdp;
    cdp.onEvent((event) => {
      const page = pages.find((item) => item.id === event.sessionId);
      if (!page) return;
      if (
        event.method === 'Runtime.bindingCalled' &&
        event.params['name'] === '__relicTraceFetch'
      ) {
        try {
          page.trace.push(
            JSON.parse(String(event.params['payload'])) as FetchTrace
          );
        } catch {
          /* ignored malformed instrumentation */
        }
      }
      if (event.method === 'Page.javascriptDialogOpening') {
        void page
          .send('Page.handleJavaScriptDialog', { accept: true })
          .catch(() => {});
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
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url === 'about:blank';
      const blocked =
        page.blocked &&
        request?.method === 'POST' &&
        /\/comments(?:\?|$)/.test(url);
      if (blocked) page.blockedWrites++;
      void page
        .send(
          local && !blocked ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local && !blocked
            ? { requestId }
            : { requestId, errorReason: 'BlockedByClient' }
        )
        .catch(() => {});
    });
    const result: Browser = {
      child,
      cdp: connection,
      profile,
      pages,
      async open(url, token) {
        const createdContext = await connection.send(
          'Target.createBrowserContext',
          { disposeOnDetach: true }
        );
        const context = String(createdContext['browserContextId']);
        const created = await connection.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: context,
        });
        const target = String(created['targetId']);
        const attached = await connection.send('Target.attachToTarget', {
          targetId: target,
          flatten: true,
        });
        const id = String(attached['sessionId']);
        const page: Page = {
          target,
          id,
          context,
          trace: [],
          blocked: false,
          blockedWrites: 0,
          send(method, params) {
            return connection.send(method, params, id);
          },
          async evaluate<T>(expression: string): Promise<T> {
            const result = await connection.send(
              'Runtime.evaluate',
              {
                expression,
                awaitPromise: true,
                returnByValue: true,
                timeout: 20_000,
              },
              id
            );
            assert.equal(
              result['exceptionDetails'],
              undefined,
              `browser evaluation: ${JSON.stringify(result['exceptionDetails'])}\n${expression.slice(0, 400)}`
            );
            const value = result['result'];
            if (!value || typeof value !== 'object' || !('value' in value))
              return undefined as T;
            return value.value as T;
          },
          async wait(expression, label) {
            await until(
              () => page.evaluate<boolean>(`Boolean(${expression})`),
              label
            );
          },
        };
        pages.push(page);
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Network.enable');
        await page.send('Network.setCacheDisabled', { cacheDisabled: true });
        await page.send('Runtime.addBinding', { name: '__relicTraceFetch' });
        await page.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(() => {
          window.__relicProofFocusEvents = [];
          for (const name of ['focus', 'blur'])
            window.addEventListener(name, () => window.__relicProofFocusEvents.push(name));
          document.addEventListener('visibilitychange', () => window.__relicProofFocusEvents.push(document.visibilityState));
          const original = window.fetch;
          window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : input.url;
            const method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
            const keepalive = Boolean((init && init.keepalive) || (typeof input !== 'string' && input.keepalive));
            window.__relicTraceFetch(JSON.stringify({url: String(url), method, keepalive}));
            return original.apply(this, arguments);
          };
        })()`,
        });
        await page.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
        await page.send('Network.setCookie', {
          name: 'relic_session',
          value: token,
          url: origin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        });
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const loaded = connection.waitForEvent('Page.loadEventFired', {
          sessionId: id,
          timeoutMs: 45_000,
        });
        const navigation = await page.send('Page.navigate', { url });
        assert.equal(
          navigation['errorText'],
          undefined,
          `navigation failed: ${navigation['errorText']}`
        );
        await loaded;
        await page.wait(
          "document.querySelector('article.prose, pre.code-body, .structured-table .dt-grid') && document.querySelector('textarea.compose-textarea')",
          'document and authenticated session'
        );
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
    return result;
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

async function click(
  page: Page,
  selector: string,
  scroll = true
): Promise<void> {
  const box = await page.evaluate<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('missing element ' + ${JSON.stringify(selector)});
    if (${scroll}) element.scrollIntoView({ block: 'center', inline: 'center' });
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error('element is not visible: ' + ${JSON.stringify(selector)});
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...box,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...box,
  });
}
async function key(
  page: Page,
  keyName: string,
  code: string,
  virtual: number,
  text?: string
): Promise<void> {
  const fields = {
    key: keyName,
    code,
    windowsVirtualKeyCode: virtual,
    nativeVirtualKeyCode: virtual,
  };
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...fields,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
}
async function input(page: Page, text: string): Promise<void> {
  await page.send('Input.insertText', { text });
}
async function select(
  page: Page,
  selector: string,
  startText: string,
  endText = startText
): Promise<void> {
  await page.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!(root instanceof HTMLElement)) throw new Error('selection root not found');
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('[hidden], [data-sg-decoration]')) nodes.push(node);
    }
    const start = nodes.find(node => node.data.includes(${JSON.stringify(startText)}));
    const end = nodes.find(node => node.data.includes(${JSON.stringify(endText)}));
    if (!start || !end) throw new Error('selection text not found: ' + ${JSON.stringify(startText)} + ' / ' + ${JSON.stringify(endText)});
    root.closest('[contenteditable]')?.focus();
    const range = document.createRange();
    range.setStart(start, start.data.indexOf(${JSON.stringify(startText)}));
    range.setEnd(end, end.data.indexOf(${JSON.stringify(endText)}) + ${JSON.stringify(endText)}.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
}
async function suggesting(page: Page): Promise<void> {
  await page.wait(
    "document.querySelector('[data-sg-suggesting]:not([disabled])')",
    'Suggesting available'
  );
  await click(page, '[data-sg-suggesting]');
  await page.wait(
    "document.querySelector('[data-sg-suggesting][aria-pressed=true]') && document.querySelector('[contenteditable=true]')",
    'Suggesting enabled'
  );
}
async function refresh(
  browserInstance: Browser,
  page: Page,
  other: Page
): Promise<void> {
  const windowInfo = await browserInstance.cdp.send(
    'Browser.getWindowForTarget',
    {
      targetId: page.target,
    }
  );
  const windowId = windowInfo['windowId'];
  assert.equal(typeof windowId, 'number', 'target window was not available');
  await browserInstance.cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'minimized' },
  });
  await Bun.sleep(100);
  await browserInstance.cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal' },
  });
  await browserInstance.cdp.send('Target.activateTarget', {
    targetId: other.target,
  });
  await browserInstance.cdp.send('Target.activateTarget', {
    targetId: page.target,
  });
  await page.send('Page.bringToFront');
}
function writesFor(id: string, method: string): number {
  return writes.filter(
    (row) =>
      row.method === method &&
      row.path.startsWith(`/api/relics/${id}/comments`) &&
      row.status >= 200 &&
      row.status < 300
  ).length;
}
async function plaintextRows(id: string, key: CryptoKey) {
  const rows = await store.listComments(id);
  return Promise.all(
    rows.map(async (row) => ({
      row,
      plain: await decryptComment(key, row.ciphertext),
    }))
  );
}
async function publish(path: string, source: string) {
  await writeFile(path, source);
  const result = await mcp('relic_publish', { path, cover: false });
  assert.equal(typeof result['url'], 'string');
  assert.equal(typeof result['relic_id'], 'string');
  const url = new URL(result['url'] as string);
  assert.equal(url.origin, origin);
  return {
    id: result['relic_id'] as string,
    url: url.href,
    key: await deriveCommentKey(parseFragment(url.hash).key),
  };
}

const results = new Map<number, string>();
const failures = new Map<number, string>();
async function step(
  number: number,
  action: () => Promise<string>
): Promise<void> {
  try {
    const evidence = await action();
    results.set(number, evidence);
    console.log(`STEP ${number} PROVEN ${evidence}`);
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    failures.set(number, message);
    console.error(`STEP ${number} NOT_PROVEN ${message}`);
  }
}
function needs(...numbers: number[]): void {
  for (const number of numbers) {
    if (!results.has(number))
      throw new Error(`depends on unproven step ${number}`);
  }
}
async function leave(page: Page): Promise<void> {
  await click(page, '[data-sg-reading]');
}
async function writeSuggestion(
  page: Page,
  id: string,
  selector: string,
  selected: string,
  replacement: string
): Promise<void> {
  const before = writesFor(id, 'POST');
  const beforeCount = await page.evaluate<number>(
    "Number.parseInt(document.querySelector('[data-sg-count]').textContent, 10)"
  );
  assert.ok(Number.isInteger(beforeCount), 'suggestion count is unavailable');
  await suggesting(page);
  await select(page, selector, selected);
  await input(page, replacement);
  await page.wait("document.querySelector('ins[data-sg-draft]')", 'open draft');
  await leave(page);
  await until(
    async () => writesFor(id, 'POST') === before + 1,
    'suggestion POST'
  );
  await page.wait(
    `Number.parseInt(document.querySelector('[data-sg-count]').textContent, 10) === ${beforeCount + 1}`,
    'posted suggestion reflected in the count before the next edit'
  );
}

let ownedBrowser: Browser | undefined;
let negative = 'skipped';
try {
  const tokenA = await session('reader-a@example.test');
  const tokenB = await session('reader-b@example.test');
  const markdown =
    '# Review\n\nUpdate **hours at a time** safely.\n\n' +
    'Hostile target remains ordinary text.\n\n' +
    'Link target remains ordinary text.\n\n' +
    'Deferred target remains ordinary text.\n';
  const markdownPath = join(scratch, 'review.md');
  const md = await publish(markdownPath, markdown);
  ownedBrowser = await browser();
  const browserInstance = ownedBrowser;
  const a = await browserInstance.open(md.url, tokenA);
  await step(0, async () => {
    await a.wait(
      "document.querySelector('.presence-stage')",
      'presence startup'
    );
    assert.equal((await store.listComments(md.id)).length, 0);
    assert.equal(
      await a.evaluate<number>(
        "document.querySelectorAll('article.prose [data-seg]').length"
      ),
      0,
      'presence startup mapped the document before a peer or suggestion existed'
    );
    return 'one signed-in reader with no peers or comments kept the original markdown DOM';
  });
  const b = await browserInstance.open(md.url, tokenB);
  assert.notEqual(
    a.context,
    b.context,
    'reader sessions must use isolated contexts'
  );
  let firstId = '';
  let conflictId = '';
  let hostileId = '';
  let linkId = '';
  let deferredId = '';

  await step(1, async () => {
    await suggesting(b);
    await leave(b);
    await suggesting(a);
    await select(a, 'article.prose strong', 'hours at a time');
    await input(a, 'CANARY-A1');
    await a.wait(
      "document.querySelector('del.sg-del.is-draft') && document.querySelector('ins.sg-ins.is-draft')",
      'draft diff'
    );
    const draft = await a.evaluate<{ struck: string; inserted: string }>(`({
      struck: document.querySelector('del.sg-del.is-draft')?.textContent,
      inserted: document.querySelector('ins.sg-ins.is-draft')?.textContent,
    })`);
    assert.deepEqual(draft, {
      struck: 'hours at a time',
      inserted: 'CANARY-A1',
    });
    assert.equal(
      await b.evaluate<boolean>(
        "document.body.textContent.includes('CANARY-A1')"
      ),
      false
    );
    assert.equal(writesFor(md.id, 'POST'), 0);
    return 'A saw the struck bold source and CANARY-A1 insertion; B and the server saw no draft';
  });

  await step(2, async () => {
    needs(1);
    await leave(a);
    await until(
      async () => writesFor(md.id, 'POST') === 1,
      'one posted suggestion'
    );
    const rows = await plaintextRows(md.id, md.key);
    assert.equal(rows.length, 1);
    const first = rows[0]!;
    assert.equal(first.plain.anchor?.kind, 'source');
    if (first.plain.anchor?.kind !== 'source')
      throw new Error('missing source anchor');
    assert.equal(first.plain.anchor.exact, 'hours at a time');
    assert.equal(first.plain.suggestion?.replacement, 'CANARY-A1');
    firstId = first.row.id;
    // Activity refresh is deliberately throttled for ten seconds.
    await Bun.sleep(10_100);
    await refresh(browserInstance, b, a);
    try {
      await b.wait(
        "document.body.textContent.includes('CANARY-A1')",
        'B sees suggestion after refocus'
      );
    } catch (error) {
      const observed = await b.evaluate(`({
        focus: document.hasFocus(),
        visibility: document.visibilityState,
        events: window.__relicProofFocusEvents,
        count: document.querySelector('[data-sg-count]')?.textContent
      })`);
      throw new Error(
        `${String(error)}; refocus=${JSON.stringify(observed)}; fetches=${JSON.stringify(b.trace)}`
      );
    }
    assert.equal(writesFor(md.id, 'POST'), 1);
    return 'one POST decrypted to source exact \"hours at a time\"; B saw CANARY-A1 after refocus';
  });

  await step(3, async () => {
    needs(1);
    assert.ok(firstId, 'the first suggestion was not stored');
    await a.wait(
      `document.querySelector(${JSON.stringify(`ins[data-sg="${firstId}"]`)})`,
      'A posted suggestion paint'
    );
    await suggesting(a);
    await select(a, `ins[data-sg="${firstId}"]`, 'CANARY-A1');
    // Place the caret at the end of the existing insertion.
    await key(a, 'ArrowRight', 'ArrowRight', 39);
    await input(a, '-EDIT');
    await leave(a);
    await until(
      async () => writesFor(md.id, 'PATCH') === 1,
      'one suggestion PATCH'
    );
    assert.equal(writesFor(md.id, 'POST'), 1);
    const rows = await plaintextRows(md.id, md.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.plain.suggestion?.replacement, 'CANARY-A1-EDIT');
    await a.wait(
      `document.querySelector(${JSON.stringify(`ins[data-sg="${firstId}"]`)})?.textContent === 'CANARY-A1-EDIT'`,
      'edited insertion repainted'
    );
    await click(a, `[data-sg-id="${firstId}"]`);
    await a.wait("document.querySelector('.popover-card')", 'suggestion card');
    await a.wait(
      "document.querySelector('.popover-card .comment-badge-edited')",
      'edited badge'
    );
    assert.match(
      (
        await a.evaluate<string>(
          "document.querySelector('.popover-card').textContent"
        )
      ).toLowerCase(),
      /edited/
    );
    return 'one PATCH, no additional POST, and the card showed edited';
  });

  await step(4, async () => {
    needs(3);
    const hostile = '<script>alert(1)</script> ** </span><b>x</b> <img src=x>';
    await writeSuggestion(a, md.id, 'article.prose', 'Hostile target', hostile);
    const rows = await plaintextRows(md.id, md.key);
    const posted = rows.find(
      (entry) => entry.plain.suggestion?.replacement === hostile
    );
    assert.ok(posted);
    hostileId = posted.row.id;
    await a.wait(
      `document.querySelector(${JSON.stringify(`[data-sg-id="${hostileId}"]`)})`,
      'hostile mark'
    );
    const rendered = await a.evaluate<{
      text: string;
      unsafe: number;
    }>(`(() => {
      const root = document.querySelector(${JSON.stringify(`ins[data-sg="${hostileId}"]`)});
      return { text: root.textContent, unsafe: root.querySelectorAll('script, img, b').length };
    })()`);
    assert.ok(
      rendered.text.includes(hostile),
      'hostile text did not render literally'
    );
    assert.equal(rendered.unsafe, 0, 'hostile text created elements');
    await Bun.sleep(10_100);
    await refresh(browserInstance, b, a);
    await b.wait(
      `document.querySelector(${JSON.stringify(`[data-sg-id="${hostileId}"]`)})`,
      'B sees hostile suggestion'
    );
    await click(b, `[data-sg-id="${hostileId}"]`);
    await b.wait("document.querySelector('.popover-reply')", 'reply button');
    await click(b, '.popover-reply');
    await b.wait(
      "document.querySelector('textarea.popover-field')",
      'reply editor'
    );
    await click(b, 'textarea.popover-field');
    await input(b, 'Reader B reply');
    await click(b, '.popover-card .popover-action.is-primary');
    await until(
      async () =>
        (await plaintextRows(md.id, md.key)).some(
          (entry) =>
            entry.plain.addresses === hostileId &&
            entry.plain.body === 'Reader B reply'
        ),
      'stored reply'
    );
    await Bun.sleep(10_100);
    await refresh(browserInstance, a, b);
    await click(a, `[data-sg-id="${hostileId}"]`);
    await a.wait(
      "document.querySelector('.popover-card')?.textContent.includes('Reader B reply')",
      'A sees reply'
    );
    return 'hostile markup stayed text without script, img or b elements; B replied and A saw it';
  });

  await step(5, async () => {
    needs(2);
    await b.wait(
      `document.querySelector(${JSON.stringify(`[data-sg-id="${firstId}"] del.sg-del`)})`,
      'B sees original strike'
    );
    await writeSuggestion(
      b,
      md.id,
      `[data-sg-id="${firstId}"] del.sg-del`,
      'hours at a time',
      'Reader B alternative'
    );
    const rows = await plaintextRows(md.id, md.key);
    const conflict = rows.find(
      (entry) => entry.plain.suggestion?.replacement === 'Reader B alternative'
    );
    assert.ok(conflict);
    conflictId = conflict.row.id;
    await b.wait(
      "document.querySelector('.sg-chg.is-conflict .sg-chip')?.textContent === '2'",
      'conflict badge'
    );
    await click(b, '.sg-chg.is-conflict');
    await b.wait(
      "document.querySelectorAll('.popover-card .card-member').length === 2",
      'conflict card'
    );
    const card = await b.evaluate<string>(
      "document.querySelector('.popover-card').textContent"
    );
    assert.ok(card.includes('CANARY-A1'));
    assert.ok(card.includes('Reader B alternative'));
    return 'overlapping edits showed badge 2 and both alternatives in the card';
  });

  await step(6, async () => {
    needs(3, 4, 5);
    await Bun.sleep(10_100);
    await refresh(browserInstance, a, b);
    await a.wait(
      "document.querySelector('.sg-chg.is-conflict .sg-chip')?.textContent === '2'",
      'A sees the conflicting suggestion'
    );
    await writeSuggestion(
      a,
      md.id,
      'article.prose',
      'Link target',
      '[link title](https://example.test)'
    );
    let rows = await plaintextRows(md.id, md.key);
    const link = rows.find(
      (entry) =>
        entry.plain.suggestion?.replacement ===
        '[link title](https://example.test)'
    );
    assert.ok(link);
    linkId = link.row.id;
    await writeSuggestion(
      a,
      md.id,
      'article.prose',
      'Deferred target',
      'deferred replacement'
    );
    rows = await plaintextRows(md.id, md.key);
    const deferred = rows.find(
      (entry) => entry.plain.suggestion?.replacement === 'deferred replacement'
    );
    assert.ok(deferred);
    deferredId = deferred.row.id;
    const inputs: SuggestionInput[] = rows.flatMap(({ row, plain }) => {
      if (!plain.suggestion || plain.anchor?.kind !== 'source') return [];
      return [
        {
          id: row.id,
          created_at: new Date(row.createdAt).toISOString(),
          exact: plain.anchor.exact,
          ...(plain.anchor.prefix === undefined
            ? {}
            : { prefix: plain.anchor.prefix }),
          ...(plain.anchor.suffix === undefined
            ? {}
            : { suffix: plain.anchor.suffix }),
          suggestion: plain.suggestion,
        },
      ];
    });
    const merged = mergeSuggestions(
      markdown,
      resolveSuggestions(markdown, inputs),
      inputs,
      'defaults'
    );
    const expectedHtml = renderMarkdown(merged.text);
    await click(a, '[data-sg-applied]');
    await a.wait(
      "document.querySelector('[data-sg-applied][aria-checked=true]')",
      'applied view'
    );
    const applied = await a.evaluate<{
      expected: string;
      actual: string;
      href: string | null;
      link: boolean;
    }>(`(() => {
      const expected = new DOMParser().parseFromString(${JSON.stringify(expectedHtml)}, 'text/html').body.textContent;
      const root = document.querySelector('article.prose:not([hidden])');
      const link = Array.from(root.querySelectorAll('a')).find(a => a.textContent === 'link title');
      return { expected, actual: root.textContent, href: link?.getAttribute('href') ?? null, link: !!link };
    })()`);
    assert.equal(
      applied.actual,
      applied.expected,
      'applied DOM differs from rendered mergeSuggestions(defaults)'
    );
    assert.equal(applied.link, true, 'inserted link was not rendered');
    assert.equal(applied.href, null, 'inserted link has an active href');
    await select(a, 'article.prose:not([hidden]) [data-sg]', 'CANARY-A1');
    const selectionBox = await a.evaluate<{ x: number; y: number }>(`(() => {
      const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await a.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      ...selectionBox,
      clickCount: 1,
    });
    await a.wait(
      "document.querySelector('.popover-offer')",
      'applied selection offer'
    );
    const verbs = await a.evaluate<string[]>(
      "Array.from(document.querySelectorAll('.popover-offer button:not(.popover-cancel)'), b => b.textContent.trim()).sort()"
    );
    assert.deepEqual(verbs, ['Copy text', 'Reply']);
    return 'applied text matched the default merge; edited selection offered Reply and Copy text; inserted link had no href';
  });

  await step(7, async () => {
    const repeated = `${'R'.repeat(160)}repeatphrase${'R'.repeat(160)}`;
    const longText = 'L'.repeat(513);
    const source =
      '# Refusals\n\nEscape target.\n\nCross **formatting** boundary.\n\n' +
      `First paragraph.\n\nSecond paragraph.\n\n${longText}\n\n${repeated}\n\n${repeated}\n`;
    const fixture = await publish(join(scratch, 'refusals.md'), source);
    const page = await browserInstance.open(fixture.url, tokenA);
    await suggesting(page);
    const baseline = writes.length;
    await select(page, 'article.prose', 'Escape target');
    await input(page, 'cancelled');
    await page.wait(
      "document.querySelector('ins.is-draft')",
      'draft to cancel'
    );
    await key(page, 'Escape', 'Escape', 27);
    await page.wait(
      "!document.querySelector('ins.is-draft')",
      'cancelled draft'
    );
    assert.equal(writes.length, baseline, 'Escape wrote a comment');
    const refuse = async (
      start: string,
      end: string,
      replacement: string,
      code: string
    ) => {
      await select(page, 'article.prose', start, end);
      await input(page, replacement);
      await page.wait(
        `document.querySelector('.sg-refusal-code')?.textContent.includes(${JSON.stringify(code)})`,
        `${code} refusal`
      );
      assert.equal(writes.length, baseline, `${code} sent a write`);
    };
    await refuse('Cross ', 'formatting', 'no', 'crosses-formatting');
    await refuse('First paragraph', 'Second paragraph', 'no', 'crosses-blocks');
    await refuse(longText, longText, 'no', 'quote-too-long');
    await refuse(
      'Escape target',
      'Escape target',
      'X'.repeat(2049),
      'too-long'
    );
    await select(page, 'article.prose', 'repeatphrase');
    await input(page, 'ambiguous');
    await leave(page);
    await page.wait(
      "document.querySelector('.sg-refusal-code')?.textContent.includes('repeats')",
      'repeated passage refusal'
    );
    assert.equal(writes.length, baseline, 'repeated passage sent a write');
    await page.evaluate("document.querySelector('article.prose').focus()");
    await key(page, 'Escape', 'Escape', 27);
    assert.equal(writes.length, baseline);
    return 'Escape and formatting, paragraph, 513-byte strike, 2049-byte insertion and repeated-source refusals sent no writes';
  });

  await step(8, async () => {
    const fixture = await publish(
      join(scratch, 'lifecycle.md'),
      '# Lifecycle\n\nClose target.\n\nRetry target.\n\nHide target.\n'
    );
    const prior = writesFor(fixture.id, 'POST');
    const retry = await browserInstance.open(fixture.url, tokenA);
    await suggesting(retry);
    await select(retry, 'article.prose', 'Retry target');
    await input(retry, 'retry replacement');
    retry.blocked = true;
    await leave(retry);
    await retry.wait(
      "document.querySelector('.sg-receipt.is-failed')",
      'failed suggestion receipt'
    );
    assert.equal(retry.blockedWrites, 1, 'blocked write was not observed');
    assert.equal(
      writesFor(fixture.id, 'POST'),
      prior,
      'blocked request reached store'
    );
    retry.blocked = false;
    await click(retry, '.sg-receipt.is-failed .popover-action');
    await until(
      async () => writesFor(fixture.id, 'POST') === prior + 1,
      'successful retry'
    );
    const saved = await plaintextRows(fixture.id, fixture.key);
    assert.equal(
      saved.filter(
        (entry) => entry.plain.suggestion?.replacement === 'retry replacement'
      ).length,
      1
    );
    console.log(
      'STEP 8 RETRY PROVEN one blocked request, one stored comment after Retry'
    );
    // The viewer's pagehide handler must send the pre-sealed draft as one
    // keepalive POST. Dispatch the event in the live page so the fetch trace
    // binding is still delivered; a page being torn down cannot report itself.
    const hiding = await browserInstance.open(fixture.url, tokenA);
    await suggesting(hiding);
    await select(hiding, 'article.prose', 'Hide target');
    await input(hiding, 'hide replacement');
    await hiding.wait("document.querySelector('ins.is-draft')", 'hide draft');
    await hiding.evaluate(
      "window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })), true"
    );
    await until(
      async () => writesFor(fixture.id, 'POST') === prior + 2,
      'pagehide POST'
    );
    const hidden = hiding.trace.filter(
      (entry) =>
        entry.method === 'POST' &&
        entry.url.includes(`/api/relics/${fixture.id}/comments`)
    );
    assert.equal(hidden.length, 1, 'pagehide sent more than one POST');
    assert.equal(hidden[0]?.keepalive, true, 'pagehide POST was not keepalive');
    console.log(
      'STEP 8 PAGEHIDE PROVEN one keepalive POST from the pagehide handler, one stored comment'
    );

    // The real lifecycle. The harness pauses every request over the page's own
    // DevTools session (Fetch.enable), and Page.close destroys that session, so
    // a keepalive request sent while the page closes would sit paused and be
    // dropped by a real Chrome. Turn interception off for this page first. The
    // server is the witness: it must store exactly one comment.
    const closing = await browserInstance.open(fixture.url, tokenA);
    await suggesting(closing);
    await select(closing, 'article.prose', 'Close target');
    await input(closing, 'close replacement');
    await closing.wait("document.querySelector('ins.is-draft')", 'close draft');
    await closing.send('Fetch.disable');
    await closing.send('Page.close');
    await until(
      async () => writesFor(fixture.id, 'POST') === prior + 3,
      'page-close POST'
    );
    await Bun.sleep(1500);
    assert.equal(
      writesFor(fixture.id, 'POST'),
      prior + 3,
      'closing stored more than one comment'
    );
    const closed = await plaintextRows(fixture.id, fixture.key);
    assert.equal(
      closed.filter(
        (entry) => entry.plain.suggestion?.replacement === 'close replacement'
      ).length,
      1
    );
    return 'pagehide sent one keepalive POST; a real Page.close stored exactly one comment; an intercepted failure retried to exactly one stored comment';
  });

  await step(9, async () => {
    const fixture = await publish(
      join(scratch, 'program.ts'),
      'const first = 1;\nconst insertHere = 2;\nconst last = 3;\n'
    );
    const page = await browserInstance.open(fixture.url, tokenA);
    await suggesting(page);
    await select(page, 'pre.code-body', 'insertHere');
    await input(page, 'draft');
    await key(page, 'Enter', 'Enter', 13, '\r');
    await key(page, 'Tab', 'Tab', 9);
    await input(page, 'next');
    const state = await page.evaluate<{
      insertion: string;
      gutter: string;
      expectedLines: number;
      topDelta: number;
    }>(`(() => {
      const code = document.querySelector('pre.code-body');
      const gutter = code.parentElement.querySelector('pre.gutter');
      return {
        insertion: code.querySelector('ins[data-sg-draft]')?.textContent,
        gutter: gutter.textContent,
        expectedLines: code.textContent.split('\\n').length,
        topDelta: Math.abs(code.getBoundingClientRect().top - gutter.getBoundingClientRect().top),
      };
    })()`);
    assert.equal(state.insertion, 'draft\n\tnext');
    assert.equal(
      state.gutter.split('\n').length,
      state.expectedLines,
      'gutter row count differs from code'
    );
    assert.ok(
      state.gutter.split('\n').includes('+'),
      'inserted line has no gutter marker'
    );
    assert.ok(
      state.topDelta <= 2,
      `gutter is vertically misaligned by ${state.topDelta}px`
    );
    await leave(page);
    await until(
      async () => writesFor(fixture.id, 'POST') === 1,
      'one multiline code POST'
    );
    const rows = await plaintextRows(fixture.id, fixture.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.plain.suggestion?.replacement, 'draft\n\tnext');
    return `Enter and Tab posted once; gutter rows matched code and top offset was ${state.topDelta}px`;
  });

  if (!legacyDist) console.log('STEP 12 SKIPPED no RELIC_SUGGEST_MAIN_DIST');
  else
    await step(12, async () => {
      needs(1);
      assert.ok(firstId, 'the first suggestion was not stored');
      assert.equal(
        await Bun.file(join(legacyDist, 'viewer.js')).exists(),
        true,
        'legacy viewer.js missing'
      );
      app = appFor(legacyDist);
      try {
        const legacy = await browserInstance.open(md.url, tokenB);
        assert.equal(
          await legacy.evaluate<boolean>(
            "!!document.querySelector('[data-sg-suggesting]')"
          ),
          false
        );
        const before = await legacy.evaluate<string>(
          "document.querySelector('article.prose strong').textContent"
        );
        await select(legacy, 'article.prose strong', 'hours at a time');
        await input(legacy, 'CANARY-LEGACY');
        assert.equal(
          await legacy.evaluate<string>(
            "document.querySelector('article.prose strong').textContent"
          ),
          before
        );
        assert.equal(
          await legacy.evaluate<boolean>(
            "document.body.textContent.includes('CANARY-LEGACY')"
          ),
          false
        );
        await legacy.wait(
          "document.body.textContent.includes('Suggested edit:') && document.body.textContent.includes('cannot show')",
          'legacy fallback and unplaceable note'
        );
        negative = 'ran';
        return 'efa3afee could not enter Suggesting or type the draft, and displayed the fallback body and cannot show note';
      } finally {
        app = appFor(viewerDist);
      }
    });

  await step(10, async () => {
    needs(3, 4, 5, 6);
    const written = await mcp('relic_apply_suggestions', {
      relic_id: md.id,
      path: markdownPath,
      accept: [firstId],
      write: true,
    });
    assert.equal(written['written'], true);
    const republished = await mcp('relic_republish', {
      relic_id: md.id,
      path: markdownPath,
      cover: false,
      notify: false,
      addresses: [
        { comment_id: firstId, outcome: 'accepted', note: 'Applied.' },
        {
          comment_id: conflictId,
          outcome: 'superseded',
          note: 'Another edit was applied.',
        },
        {
          comment_id: hostileId,
          outcome: 'declined',
          note: 'Not taking this edit.',
        },
        {
          comment_id: linkId,
          outcome: 'declined',
          note: 'Not taking this edit.',
        },
        {
          comment_id: deferredId,
          outcome: 'deferred',
          note: 'Seen for later.',
        },
      ],
    });
    assert.equal(republished['version'], 2);
    assert.equal((await store.getRelic(md.id))?.version, 2);
    const rows = await plaintextRows(md.id, md.key);
    for (const [id, outcome] of [
      [firstId, 'accepted'],
      [conflictId, 'superseded'],
      [hostileId, 'declined'],
      [deferredId, 'deferred'],
    ] as const) {
      assert.equal(
        rows.filter(
          (entry) =>
            entry.row.author === 'publisher' &&
            entry.plain.addresses === id &&
            entry.plain.suggestion_outcome === outcome
        ).length,
        1,
        `missing ${outcome} outcome`
      );
    }
    return 'MCP applied the selected edit and republished v2 with accepted, superseded, declined and deferred outcomes';
  });

  await step(11, async () => {
    needs(10);
    const page = await browserInstance.open(md.url, tokenA);
    await click(page, '[data-sg-applied]');
    await page.wait(
      "document.querySelector('[data-sg-applied][aria-checked=true]')",
      'v2 applied view'
    );
    assert.equal(
      await page.evaluate<string>(
        "document.querySelector('[data-sg-count]').textContent"
      ),
      '0 suggestions'
    );
    assert.equal(
      await page.evaluate<number>(
        "document.querySelectorAll('[data-sg-id]').length"
      ),
      0,
      'v2 has suggestion marks'
    );
    await click(page, '[data-sg-applied]');
    await page.wait(
      "document.querySelector('[data-sg-applied][aria-checked=false]')",
      'v2 reading view'
    );
    await click(page, '.version-trigger');
    await click(page, '.version-option[data-version="1"]');
    await page.wait(
      "document.querySelector('.version-long')?.textContent.includes('1')",
      'v1 version selection'
    );
    await click(page, '.action-comments');
    await page.wait(
      "document.querySelector('.thread.is-open')",
      'v1 comments open'
    );
    for (const [id, label] of [
      [firstId, 'Accepted in v2'],
      [conflictId, 'Superseded'],
      [hostileId, 'Not taken'],
      [deferredId, 'Seen by the publisher'],
    ] as const) {
      const row = `.comment[data-comment-id="${id}"]`;
      await page.wait(
        `document.querySelector(${JSON.stringify(row)})?.textContent.includes(${JSON.stringify(label)})`,
        label
      );
      assert.equal(
        await page.evaluate<boolean>(`(() => {
          const row = document.querySelector(${JSON.stringify(row)});
          return !!row && row.getClientRects().length > 0;
        })()`),
        true,
        `${label} was not visible in the open comments panel`
      );
    }
    return 'v1 displayed Accepted in v2, Superseded, Not taken and Seen by the publisher; v2 had no suggestion marks';
  });

  await step(13, async () => {
    const fixture = await publish(
      join(scratch, 'cell-crlf.csv'),
      TABLE_SUGGEST_PATH_CRLF
    );
    const page = await browserInstance.open(fixture.url, tokenA);
    await page.wait(
      'document.querySelector(\'.structured-table [data-r="2"][data-c="1"]\')',
      'second repeated CSV cell'
    );
    await click(page, '.structured-table [data-r="2"][data-c="1"]');
    await click(page, '.dt-cellbar .dt-suggest');
    await page.wait(
      "document.querySelector('.dt-suggest-text[contenteditable=true]')",
      'table editor activated through inspector'
    );
    await select(page, '.dt-suggest-text', 'repeat');
    await input(page, 'nice "one"');
    await page.wait(
      "document.querySelector('.dt-suggest-text ins[data-sg-draft]')",
      'CSV draft'
    );

    let entered = false;
    const resume = Promise.withResolvers<void>();
    heldComment = {
      id: fixture.id,
      entered: () => {
        entered = true;
      },
      resume: resume.promise,
    };
    try {
      await leave(page);
      await until(async () => entered, 'CSV POST entered hold');
      await click(page, '.structured-table [data-r="1"][data-c="1"]');
      await click(page, '.dt-cellbar .dt-suggest');
      assert.equal(
        await page.evaluate<boolean>(
          "document.querySelector('.dt-suggest-title')?.textContent.includes('B3') === true"
        ),
        true,
        'switching cells while posting removed the active editor'
      );
      await page.wait(
        "document.querySelector('[data-sg-notice]')?.textContent.includes('finish sending')",
        'in-flight swap refusal'
      );
      await click(page, '.structured-wrap .toggle-row button');
      await page.wait(
        "document.querySelector('.structured-wrap .toggle-row button')?.textContent.includes('View table')",
        'View source remains available while posting'
      );
      await click(page, '.structured-wrap .toggle-row button');
      await page.wait(
        "document.querySelector('.structured-table .dt-grid')",
        'table remounted while posting'
      );
      await click(page, '.structured-table [data-r="1"][data-c="1"]');
      await click(page, '.dt-cellbar .dt-suggest');
      assert.equal(
        await page.evaluate<boolean>(
          "!!document.querySelector('.dt-suggest-editor')"
        ),
        false,
        'a new editor opened while another table post was in flight'
      );
      await page.wait(
        "document.querySelector('[data-sg-notice]')?.textContent.includes('finish sending')",
        'remounted table swap refusal'
      );
      await click(page, '.structured-wrap .toggle-row button');
      await page.wait(
        "document.querySelector('.structured-wrap .toggle-row button')?.textContent.includes('View table')",
        'return to source during held post'
      );
    } finally {
      heldComment = undefined;
      resume.resolve();
    }
    await until(
      async () => writesFor(fixture.id, 'POST') === 1,
      'CSV suggestion posted'
    );
    await page.wait(
      "document.querySelector('[data-sg-count]')?.textContent.includes('1 suggestion')",
      'CSV post reflected in viewer'
    );
    await click(page, '.structured-wrap .toggle-row button');
    await page.wait(
      "document.querySelector('.structured-table .dt-grid')",
      'table after post and source view'
    );
    await click(page, '.structured-table [data-r="1"][data-c="1"]');
    await click(page, '.dt-cellbar .dt-suggest');
    await page.wait(
      "document.querySelector('.dt-suggest-title')?.textContent.includes('B2') && document.querySelector('.dt-suggest-text[contenteditable=true]')",
      'second cell editable after in-flight post settles'
    );
    const stored = await plaintextRows(fixture.id, fixture.key);
    assert.equal(stored.length, 1);
    const saved = stored[0]!;
    const anchor = saved.plain.anchor;
    const suggestion = saved.plain.suggestion;
    assert.ok(anchor && anchor.kind === 'source' && suggestion);
    assert.equal(anchor.exact, 'repeat');
    assert.equal(suggestion.mode, 'replace');
    assert.equal(suggestion.replacement, 'nice ""one""');
    const normalized = TABLE_SUGGEST_PATH_CRLF.slice(1).replaceAll(
      '\r\n',
      '\n'
    );
    const located = resolveSuggestions(normalized, [
      {
        id: saved.row.id,
        created_at: '2026-01-01T00:00:00Z',
        exact: anchor.exact,
        ...(anchor.prefix === undefined ? {} : { prefix: anchor.prefix }),
        ...(anchor.suffix === undefined ? {} : { suffix: anchor.suffix }),
        suggestion,
      },
    ])[0];
    assert.equal(located?.status, 'resolved');
    if (located?.status !== 'resolved')
      throw new Error('CSV anchor did not resolve');
    assert.equal(located.start, normalized.lastIndexOf('repeat'));
    assert.equal(
      located.end,
      normalized.lastIndexOf('repeat') + 'repeat'.length
    );
    const otherReader = await browserInstance.open(fixture.url, tokenB);
    for (const [writer, record, selected, replacement, count] of [
      [page, 3, 'FIRST', 'first replacement', 2],
      [otherReader, 3, 'SECOND', 'second replacement', 3],
      [page, 4, 'ONLY', 'only replacement', 4],
    ] as const) {
      await click(writer, `.structured-table [data-r="${record}"][data-c="1"]`);
      await click(writer, '.dt-cellbar .dt-suggest');
      await writer.wait(
        "document.querySelector('.dt-suggest-text[contenteditable=true]')",
        'clipped cell editor'
      );
      await select(writer, '.dt-suggest-text', selected);
      await input(writer, replacement);
      await leave(writer);
      await until(
        async () => writesFor(fixture.id, 'POST') === count,
        'clipped cell suggestion posted'
      );
      await writer.wait(
        `Number.parseInt(document.querySelector('[data-sg-count]')?.textContent, 10) >= ${count}`,
        'clipped suggestion refresh'
      );
    }
    const allSaved = await plaintextRows(fixture.id, fixture.key);
    const mediumRows = allSaved.filter(
      (row) =>
        row.plain.suggestion?.replacement === 'first replacement' ||
        row.plain.suggestion?.replacement === 'second replacement'
    );
    assert.equal(mediumRows.length, 2);
    const solo = allSaved.find(
      (row) => row.plain.suggestion?.replacement === 'only replacement'
    );
    assert.ok(solo, 'single clipped suggestion not stored');

    const reopened = await browserInstance.open(fixture.url, tokenA);
    const mark = `.structured-table [data-r="2"][data-c="1"] [data-comment-id="${saved.row.id}"]`;
    await reopened.wait(
      `document.querySelector(${JSON.stringify(mark)})`,
      'reopened CSV mark on original cell'
    );
    await click(reopened, '.structured-table .dt-hcell[data-c="0"]');
    await click(reopened, '.structured-table .dt-hcell[data-c="0"]');
    await reopened.evaluate(
      `(() => { const grid = document.querySelector('.dt-grid'); grid.scrollTop = grid.scrollHeight; grid.dispatchEvent(new Event('scroll')); })()`
    );
    await reopened.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
    await reopened.wait(
      `document.querySelector(${JSON.stringify(mark)})`,
      'CSV mark after sort and scroll'
    );
    await reopened.evaluate(`(() => {
      const mark = document.querySelector(${JSON.stringify(mark)});
      const grid = document.querySelector('.dt-grid');
      const item = mark.getBoundingClientRect();
      const viewport = grid.getBoundingClientRect();
      grid.scrollTop += item.top - (viewport.top + viewport.height / 2);
    })()`);
    await reopened.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
    await reopened.wait(
      `(() => {
        const mark = document.querySelector(${JSON.stringify(mark)});
        if (!mark) return false;
        const rect = mark.getBoundingClientRect();
        return mark.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })()`,
      'visible, unobstructed CSV suggestion'
    );
    await click(reopened, mark, false);
    await reopened.wait(
      "document.querySelector('.popover-card')",
      'CSV suggestion thread opened'
    );
    assert.equal(
      await reopened.evaluate<string>(
        "document.querySelector('.popover-card')?.getAttribute('data-comment-id')"
      ),
      saved.row.id,
      'opened suggestion card does not match the clicked mark'
    );
    await click(reopened, '.structured-wrap .toggle-row button');
    await reopened.wait(
      "document.querySelector('.structured-wrap .toggle-row button')?.textContent.includes('View table')",
      'CSV source view'
    );
    await click(reopened, '.structured-wrap .toggle-row button');
    await reopened.wait(
      `document.querySelector(${JSON.stringify(mark)})`,
      'CSV mark after table remount'
    );
    const indicator =
      '.structured-table [data-r="3"][data-c="1"] .dt-suggestion-indicator';
    await reopened.wait(
      `(() => {
        const button = document.querySelector(${JSON.stringify(indicator)});
        if (!button) return false;
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })()`,
      'clipped cell indicator is visible'
    );
    await click(reopened, indicator, false);
    for (const row of mediumRows) {
      await reopened.wait(
        `document.querySelector(${JSON.stringify(`.popover-member[data-member-id="${row.row.id}"]`)})`,
        'clipped cell suggestion offered in cluster'
      );
    }
    await click(
      reopened,
      `.popover-member[data-member-id="${mediumRows[1]!.row.id}"]`
    );
    await reopened.wait(
      `document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${mediumRows[1]!.row.id}"]`)})`,
      'second clipped suggestion opened'
    );
    await reopened.evaluate(`new Promise((resolve) => {
      const indicator = document.querySelector(${JSON.stringify(indicator)});
      const observer = new IntersectionObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      });
      observer.observe(indicator);
    })`);
    const secondCard = await reopened.evaluate<{
      visible: boolean;
      hit: boolean;
      concealment: string | null;
    }>(`(() => {
      const card = document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${mediumRows[1]!.row.id}"]`)});
      if (!card) return { visible: false, hit: false, concealment: 'missing' };
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0,
        hit: !!hit && card.contains(hit),
        concealment: card.getAttribute('data-concealed'),
      };
    })()`);
    assert.deepEqual(
      secondCard,
      { visible: true, hit: true, concealment: null },
      'second cluster card was concealed after observation'
    );
    const assertNearIndicator = async (
      selector: string,
      id: string
    ): Promise<void> => {
      await reopened.evaluate(`new Promise((resolve) => {
        const marker = document.querySelector(${JSON.stringify(selector)});
        const observer = new IntersectionObserver(() => {
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        });
        observer.observe(marker);
      })`);
      const state = await reopened.evaluate<{
        visible: boolean;
        hit: boolean;
        gap: number;
      }>(`(() => {
        const marker = document.querySelector(${JSON.stringify(selector)});
        const card = document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${id}"]`)});
        if (!marker || !card) return { visible: false, hit: false, gap: Infinity };
        const a = marker.getBoundingClientRect(), b = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        const target = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const dx = Math.max(0, a.left - b.right, b.left - a.right);
        const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
        return {
          visible: !card.hasAttribute('data-concealed') && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
          hit: !!target && card.contains(target),
          gap: Math.hypot(dx, dy),
        };
      })()`);
      assert.equal(state.visible, true, `card ${id} was concealed`);
      assert.equal(state.hit, true, `card ${id} was not hit-testable`);
      assert.ok(
        state.gap <= 80,
        `card ${id} was ${state.gap}px from its visible indicator`
      );
    };
    await assertNearIndicator(indicator, mediumRows[1]!.row.id);
    await click(reopened, '.popover-card .popover-dismiss');
    await click(reopened, indicator, false);
    await click(
      reopened,
      `.popover-member[data-member-id="${mediumRows[0]!.row.id}"]`
    );
    await reopened.wait(
      `document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${mediumRows[0]!.row.id}"]`)})`,
      'first clipped suggestion opened'
    );
    await assertNearIndicator(indicator, mediumRows[0]!.row.id);
    await click(reopened, '.popover-card .popover-dismiss');
    const singleIndicator =
      '.structured-table [data-r="4"][data-c="1"] .dt-suggestion-indicator';
    await reopened.wait(
      `document.querySelector(${JSON.stringify(singleIndicator)})`,
      'single clipped suggestion indicator'
    );
    await click(reopened, singleIndicator, false);
    await reopened.wait(
      `document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${solo.row.id}"]`)})`,
      'single clipped suggestion opened'
    );
    await assertNearIndicator(singleIndicator, solo.row.id);
    await click(reopened, '.popover-card .popover-reply');
    await reopened.wait(
      "document.querySelector('.popover-card .popover-field')",
      'reply draft field'
    );
    await input(reopened, 'Keep this unsent draft');
    await reopened.wait(
      "document.querySelector('.popover-card .popover-field')?.value === 'Keep this unsent draft'",
      'reply draft entered'
    );
    await reopened.evaluate(
      "window.__tableProofCard = document.querySelector('.popover-card')"
    );
    const gridPoint = await reopened.evaluate<{
      x: number;
      y: number;
    }>(`(() => {
      const rect = document.querySelector('.dt-grid').getBoundingClientRect();
      return { x: rect.right - 10, y: rect.top + rect.height / 2 };
    })()`);
    await reopened.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...gridPoint,
      deltaX: 0,
      deltaY: 380,
    });
    await reopened.wait(
      `!document.querySelector(${JSON.stringify(singleIndicator)})`,
      'unselected indicator unmounted after scrolling'
    );
    await reopened.wait(
      `document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${solo.row.id}"]`)})?.getAttribute('data-concealed') === 'offscreen'`,
      'card concealed while its virtualized indicator is absent'
    );
    const absentCard = await reopened.evaluate<{
      inert: boolean;
      underlying: boolean;
      focusBlocked: boolean;
      draft: string;
      same: boolean;
      diagnostic: string;
    }>(`(() => {
      const card = document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${solo.row.id}"]`)});
      const field = card.querySelector('.popover-field');
      const rect = card.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      field.focus({ preventScroll: true });
      return {
        inert: card.inert,
        underlying: !!hit && !card.contains(hit),
        focusBlocked: !card.contains(document.activeElement),
        draft: field.value,
        same: card === window.__tableProofCard,
        diagnostic: JSON.stringify({ rect: rect.toJSON(), hit: hit?.outerHTML?.slice(0, 300), width: innerWidth, height: innerHeight }),
      };
    })()`);
    assert.equal(absentCard.inert, true, absentCard.diagnostic);
    assert.equal(absentCard.underlying, true, absentCard.diagnostic);
    assert.equal(absentCard.focusBlocked, true, absentCard.diagnostic);
    assert.equal(absentCard.draft, 'Keep this unsent draft');
    assert.equal(absentCard.same, true);
    await reopened.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...gridPoint,
      deltaX: 0,
      deltaY: -380,
    });
    await reopened.wait(
      `document.querySelector(${JSON.stringify(singleIndicator)})`,
      'indicator restored after scrolling back'
    );
    await reopened.wait(
      `document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${solo.row.id}"]`)}) && !document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${solo.row.id}"]`)}).hasAttribute('data-concealed')`,
      'card restored after its indicator returns'
    );
    const restoredDraft = await reopened.evaluate<{
      inert: boolean;
      draft: string;
      same: boolean;
    }>(`(() => {
      const card = document.querySelector(${JSON.stringify(`.popover-card[data-comment-id="${solo.row.id}"]`)});
      return {
        inert: card.inert,
        draft: card.querySelector('.popover-field').value,
        same: card === window.__tableProofCard,
      };
    })()`);
    assert.deepEqual(restoredDraft, {
      inert: false,
      draft: 'Keep this unsent draft',
      same: true,
    });
    await assertNearIndicator(singleIndicator, solo.row.id);
    const sniff = await publish(
      join(scratch, 'sniff.csv'),
      'a,b;c\r\nrow;target\r\n'
    );
    const sniffPage = await browserInstance.open(sniff.url, tokenA);
    await click(sniffPage, '.structured-table [data-r="1"][data-c="1"]');
    await click(sniffPage, '.dt-cellbar .dt-suggest');
    await sniffPage.wait(
      "document.querySelector('.dt-suggest-text[contenteditable=true]')",
      'auto-detected CSV editor'
    );
    await select(sniffPage, '.dt-suggest-text', 'target');
    await input(sniffPage, 'x,y');
    await sniffPage.wait(
      "document.querySelector('.sg-refusal-code')?.textContent.includes('delimiter-in-cell')",
      'delimiter sniff change refusal'
    );
    assert.equal(
      writesFor(sniff.id, 'POST'),
      0,
      'rejected delimiter change posted'
    );
    return 'double-BOM/CRLF edit kept its exact anchor; Source worked during a held post; clipped suggestion cards stayed adjacent and the virtualized card became inert without losing its draft; delimiter-changing input was refused';
  });
} finally {
  await ownedBrowser?.close();
  await service.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
if (failures.size > 0) {
  throw new Error(
    `Suggestion path failed steps ${[...failures.keys()].sort((a, b) => a - b).join(', ')}`
  );
}
console.log(`SUGGESTED_EDITS_PATH_OK classes=2 negative=${negative}`);
console.log(
  'HEADLESS_LIMITS OS IME, real clipboard and drag and drop were not exercised'
);
