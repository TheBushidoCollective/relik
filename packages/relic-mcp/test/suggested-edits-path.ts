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
import {
  type CommentPlaintext,
  decryptComment,
  deriveCommentKey,
  parseFragment,
} from '@relic/format';
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
            return (result['result'] as { value?: T }).value as T;
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
          "document.querySelector('article.prose, pre.code-body') && document.querySelector('textarea.compose-textarea')",
          'document and authenticated session'
        );
        return page;
      },
      async close() {
        connection.dispose();
        child.kill('SIGKILL');
        await rm(profile, { recursive: true, force: true });
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

async function click(page: Page, selector: string): Promise<void> {
  const box = await page.evaluate<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('missing element ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', inline: 'center' });
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
  await browserInstance.cdp.send('Target.activateTarget', {
    targetId: other.target,
  });
  await browserInstance.cdp.send('Target.activateTarget', {
    targetId: page.target,
  });
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
async function step(number: number, action: () => Promise<string>): Promise<void> {
  try {
    const evidence = await action();
    results.set(number, evidence);
    console.log(`STEP ${number} PROVEN ${evidence}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.set(number, message);
    console.error(`STEP ${number} NOT_PROVEN ${message}`);
  }
}
function needs(...numbers: number[]): void {
  for (const number of numbers) {
    if (!results.has(number)) throw new Error(`depends on unproven step ${number}`);
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
  await suggesting(page);
  await select(page, selector, selected);
  await input(page, replacement);
  await page.wait("document.querySelector('ins[data-sg-draft]')", 'open draft');
  await leave(page);
  await until(async () => writesFor(id, 'POST') === before + 1, 'suggestion POST');
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
  const b = await browserInstance.open(md.url, tokenB);
  assert.notEqual(a.context, b.context, 'reader sessions must use isolated contexts');
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
    await a.wait("document.querySelector('del.sg-del.is-draft') && document.querySelector('ins.sg-ins.is-draft')", 'draft diff');
    const draft = await a.evaluate<{ struck: string; inserted: string }>(`({
      struck: document.querySelector('del.sg-del.is-draft')?.textContent,
      inserted: document.querySelector('ins.sg-ins.is-draft')?.textContent,
    })`);
    assert.deepEqual(draft, { struck: 'hours at a time', inserted: 'CANARY-A1' });
    assert.equal(await b.evaluate<boolean>("document.body.textContent.includes('CANARY-A1')"), false);
    assert.equal(writesFor(md.id, 'POST'), 0);
    return 'A saw the struck bold source and CANARY-A1 insertion; B and the server saw no draft';
  });

  await step(2, async () => {
    needs(1);
    await leave(a);
    await until(async () => writesFor(md.id, 'POST') === 1, 'one posted suggestion');
    const rows = await plaintextRows(md.id, md.key);
    assert.equal(rows.length, 1);
    const first = rows[0]!;
    assert.equal(first.plain.anchor?.kind, 'source');
    if (first.plain.anchor?.kind !== 'source') throw new Error('missing source anchor');
    assert.equal(first.plain.anchor.exact, 'hours at a time');
    assert.equal(first.plain.suggestion?.replacement, 'CANARY-A1');
    firstId = first.row.comment_id;
    // Activity refresh is deliberately throttled for ten seconds.
    await Bun.sleep(10_100);
    await refresh(browserInstance, b, a);
    await b.wait("document.body.textContent.includes('CANARY-A1')", 'B sees suggestion after refocus');
    assert.equal(writesFor(md.id, 'POST'), 1);
    return 'one POST decrypted to source exact \"hours at a time\"; B saw CANARY-A1 after refocus';
  });

  await step(3, async () => {
    needs(2);
    await a.wait(`document.querySelector(${JSON.stringify(`ins[data-sg="${firstId}"]`)})`, 'A posted suggestion paint');
    await suggesting(a);
    await select(a, `ins[data-sg="${firstId}"]`, 'CANARY-A1');
    // Place the caret at the end of the existing insertion.
    await key(a, 'ArrowRight', 'ArrowRight', 39);
    await input(a, '-EDIT');
    await leave(a);
    await until(async () => writesFor(md.id, 'PATCH') === 1, 'one suggestion PATCH');
    assert.equal(writesFor(md.id, 'POST'), 1);
    const rows = await plaintextRows(md.id, md.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.plain.suggestion?.replacement, 'CANARY-A1-EDIT');
    await a.wait(`document.querySelector(${JSON.stringify(`[data-sg-id="${firstId}"]`)})`, 'edited mark');
    await click(a, `[data-sg-id="${firstId}"]`);
    await a.wait("document.querySelector('.popover-card')", 'suggestion card');
    assert.match((await a.evaluate<string>("document.querySelector('.popover-card').textContent")).toLowerCase(), /edited/);
    return 'one PATCH, no additional POST, and the card showed edited';
  });

  await step(4, async () => {
    needs(3);
    const hostile = '<script>alert(1)</script> ** </span><b>x</b> <img src=x>';
    await writeSuggestion(a, md.id, 'article.prose', 'Hostile target', hostile);
    const rows = await plaintextRows(md.id, md.key);
    const posted = rows.find((entry) => entry.plain.suggestion?.replacement === hostile);
    assert.ok(posted);
    hostileId = posted.row.comment_id;
    await a.wait(`document.querySelector(${JSON.stringify(`[data-sg-id="${hostileId}"]`)})`, 'hostile mark');
    const rendered = await a.evaluate<{ text: string; unsafe: number }>(`(() => {
      const root = document.querySelector(${JSON.stringify(`[data-sg-id="${hostileId}"]`)});
      return { text: root.textContent, unsafe: root.querySelectorAll('script, img, b').length };
    })()`);
    assert.ok(rendered.text.includes(hostile), 'hostile text did not render literally');
    assert.equal(rendered.unsafe, 0, 'hostile text created elements');
    await Bun.sleep(10_100);
    await refresh(browserInstance, b, a);
    await b.wait(`document.querySelector(${JSON.stringify(`[data-sg-id="${hostileId}"]`)})`, 'B sees hostile suggestion');
    await click(b, `[data-sg-id="${hostileId}"]`);
    await b.wait("document.querySelector('.popover-reply')", 'reply button');
    await click(b, '.popover-reply');
    await b.wait("document.querySelector('textarea.popover-field')", 'reply editor');
    await click(b, 'textarea.popover-field');
    await input(b, 'Reader B reply');
    await click(b, '.popover-card .popover-action.is-primary');
    await until(async () => (await plaintextRows(md.id, md.key)).some((entry) => entry.plain.addresses === hostileId && entry.plain.body === 'Reader B reply'), 'stored reply');
    await Bun.sleep(10_100);
    await refresh(browserInstance, a, b);
    await click(a, `[data-sg-id="${hostileId}"]`);
    await a.wait("document.querySelector('.popover-card')?.textContent.includes('Reader B reply')", 'A sees reply');
    return 'hostile markup stayed text without script, img or b elements; B replied and A saw it';
  });

  await step(5, async () => {
    needs(2);
    await b.wait(`document.querySelector(${JSON.stringify(`[data-sg-id="${firstId}"] del.sg-del`)})`, 'B sees original strike');
    await writeSuggestion(b, md.id, `[data-sg-id="${firstId}"] del.sg-del`, 'hours at a time', 'Reader B alternative');
    const rows = await plaintextRows(md.id, md.key);
    const conflict = rows.find((entry) => entry.plain.suggestion?.replacement === 'Reader B alternative');
    assert.ok(conflict);
    conflictId = conflict.row.comment_id;
    await b.wait("document.querySelector('.sg-chg.is-conflict .sg-chip')?.textContent === '2'", 'conflict badge');
    await click(b, '.sg-chg.is-conflict');
    await b.wait("document.querySelectorAll('.popover-card .card-member').length === 2", 'conflict card');
    const card = await b.evaluate<string>("document.querySelector('.popover-card').textContent");
    assert.ok(card.includes('CANARY-A1'));
    assert.ok(card.includes('Reader B alternative'));
    return 'overlapping edits showed badge 2 and both alternatives in the card';
  });

  await step(6, async () => {
    needs(3, 4, 5);
    await writeSuggestion(a, md.id, 'article.prose', 'Link target', '[link title](https://example.test)');
    let rows = await plaintextRows(md.id, md.key);
    const link = rows.find((entry) => entry.plain.suggestion?.replacement === '[link title](https://example.test)');
    assert.ok(link);
    linkId = link.row.comment_id;
    await writeSuggestion(a, md.id, 'article.prose', 'Deferred target', 'deferred replacement');
    rows = await plaintextRows(md.id, md.key);
    const deferred = rows.find((entry) => entry.plain.suggestion?.replacement === 'deferred replacement');
    assert.ok(deferred);
    deferredId = deferred.row.comment_id;
    const inputs: SuggestionInput[] = rows.flatMap(({ row, plain }) => {
      if (!plain.suggestion || plain.anchor?.kind !== 'source') return [];
      return [{
        id: row.comment_id, created_at: row.created_at,
        exact: plain.anchor.exact, prefix: plain.anchor.prefix,
        suffix: plain.anchor.suffix, suggestion: plain.suggestion,
      }];
    });
    const merged = mergeSuggestions(markdown, resolveSuggestions(markdown, inputs), inputs, 'defaults');
    const expectedHtml = renderMarkdown(merged.text);
    await click(a, '[data-sg-applied]');
    await a.wait("document.querySelector('[data-sg-applied][aria-checked=true]')", 'applied view');
    const applied = await a.evaluate<{ expected: string; actual: string; href: string | null; link: boolean }>(`(() => {
      const expected = new DOMParser().parseFromString(${JSON.stringify(expectedHtml)}, 'text/html').body.textContent;
      const root = document.querySelector('article.prose:not([hidden])');
      const link = Array.from(root.querySelectorAll('a')).find(a => a.textContent === 'link title');
      return { expected, actual: root.textContent, href: link?.getAttribute('href') ?? null, link: !!link };
    })()`);
    assert.equal(applied.actual, applied.expected, 'applied DOM differs from rendered mergeSuggestions(defaults)');
    assert.equal(applied.link, true, 'inserted link was not rendered');
    assert.equal(applied.href, null, 'inserted link has an active href');
    await select(a, 'article.prose:not([hidden]) [data-sg]', 'CANARY-A1');
    await a.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', x: 20, y: 20, clickCount: 1 });
    await a.wait("document.querySelector('.popover-offer')", 'applied selection offer');
    const verbs = await a.evaluate<string[]>("Array.from(document.querySelectorAll('.popover-offer button:not(.popover-cancel)'), b => b.textContent.trim()).sort()");
    assert.deepEqual(verbs, ['Copy text', 'Reply']);
    return 'applied text matched the default merge; edited selection offered Reply and Copy text; inserted link had no href';
  });

