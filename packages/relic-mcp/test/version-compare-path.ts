/**
 * Side-by-side version comparison, end to end (B5 spec section 6, S6b).
 *
 * A visitor opens the share URL of a relic with two versions. The stage
 * publishes version 1 with relic_publish and version 2 with relic_republish,
 * both through the built MCP over stdio, then clicks "Compare versions" with
 * real mouse input and reads what the reader sees at 1440x900 and 390x844.
 * Each negative publishes its own relic.
 *
 *   RELIC_CHROME_PATH=<browser> bun packages/relic-mcp/test/version-compare-path.ts
 *
 * RELIC_COMPARE_PATH_SHOTS=<dir> keeps a screenshot of each state. Success
 * ends with VERSION_COMPARE_PATH_OK.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import {
  docxPadded,
  docxV1,
  docxV1CoreOnly,
  docxV2,
  epubV1,
  epubV2,
  epubV2Hostile,
  xlsxV1,
  xlsxV2,
  xlsxV2BidiSheet,
} from './version-compare-fixtures.ts';

export type Format = 'docx' | 'epub' | 'xlsx';
export interface Viewport {
  readonly width: number;
  readonly height: number;
}
export const DESKTOP: Viewport = { width: 1440, height: 900 };
export const PHONE: Viewport = { width: 390, height: 844 };

/** The result line each format shows once its comparison is built. */
export const SUMMARY: Record<Format, string> = {
  docx: '1 added, 1 removed, 2 changed.',
  epub: '2 added, 2 removed, 1 changed.',
  xlsx: '4 cells changed, 1 added, 1 removed. 1 sheet added, 1 removed, 1 renamed.',
};
/** The count on the Changes tab: the report's total. */
export const TOTAL: Record<Format, string> = {
  docx: '4',
  epub: '5',
  xlsx: '9',
};
export const HEADING: Record<Format, string> = {
  docx: 'Document comparison',
  epub: 'Book comparison',
  xlsx: 'Spreadsheet comparison',
};

interface Marks {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}
const NONE: Marks = { added: 0, removed: 0, changed: 0 };
/** The outlines each frame carries: one per changed block, per side. */
const MARKS: Record<
  'docx' | 'epub',
  { readonly before: Marks; readonly after: Marks }
> = {
  docx: {
    before: { added: 0, removed: 1, changed: 2 },
    after: { added: 1, removed: 0, changed: 2 },
  },
  epub: {
    before: { added: 0, removed: 2, changed: 1 },
    after: { added: 2, removed: 0, changed: 1 },
  },
};

const NO_TEXT_CHANGES =
  'No text changes. Formatting, layout and image content are not compared.';
const OVERSIZE =
  'This version is larger than the 16 MiB comparison limit, so Relik cannot show it beside another. Earlier versions can still be opened on their own.';
const MISMATCH =
  'Version 1 and version 2 display differently, so they cannot be shown side by side. Version 1 is open here on its own.';
const HOSTILE = '<img src=x onerror="window.__relicPwned=1">';
/** The sheet name with U+202E, as the strip shows it: a visible escape. */
const ESCAPED_SHEET = 'Sum\\u202emary';
const SHOTS = process.env['RELIC_COMPARE_PATH_SHOTS'];

/** A JSON object from a protocol reply. Its fields are read by name, after a type check. */
type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of a reply, or a failure that names the field. */
function stringField(reply: Json, key: string): string {
  const value = reply[key];
  if (typeof value !== 'string') throw new Error(`reply has no string ${key}`);
  return value;
}

/** The value a Runtime call returned by value. Each read's script returns the shape the read names. */
function resultValue<T>(reply: Json): T {
  const result = reply['result'];
  const value: unknown = isJson(result) ? result['value'] : undefined;
  // Unchecked by design: the caller names the type, and the script shapes it.
  return value as T;
}

/** The objectId of a DOM.resolveNode reply. */
function objectIdOf(reply: Json): string {
  const object = reply['object'];
  const objectId = isJson(object) ? object['objectId'] : undefined;
  if (typeof objectId !== 'string') throw new Error('reply has no objectId');
  return objectId;
}

interface DomNode {
  readonly nodeId: number;
  readonly backendNodeId: number;
  readonly frameId?: string;
  readonly parentId?: number;
  readonly nodeName: string;
  readonly attributes?: readonly string[];
}

function attribute(node: DomNode, name: string): string | undefined {
  const attributes = node.attributes ?? [];
  const index = attributes.indexOf(name);
  return index < 0 ? undefined : attributes[index + 1];
}

function classesOf(node: DomNode): readonly string[] {
  return (attribute(node, 'class') ?? '').split(/\s+/).filter(Boolean);
}

export interface FrameRef {
  readonly frameId: string;
  readonly title: string;
  readonly session: string;
}

interface Recorded {
  readonly url: string;
  readonly frameId: string | undefined;
}

export interface Harness {
  readonly origin: string;
  readonly usercontentOrigin: string;
  readonly repo: string;
  readonly scratch: string;
  stop(): Promise<void>;
}

/**
 * Two loopback servers, as epub-viewer-path.ts runs them: the service, and the
 * origin the sandboxed frames load from.
 */
export async function startHarness(): Promise<Harness> {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'relic-version-compare-'));
  const routes: {
    app?: { fetch(request: Request): Response | Promise<Response> };
  } = {};
  let handle: (request: Request) => Promise<Response> = async () =>
    new Response('starting', { status: 503 });
  // Bun's default 10 s idle timeout cut a viewer request under load, and the
  // browser saw an empty response. 255 is the largest value Bun accepts.
  const service = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 255,
    fetch: (request) => handle(request),
  });
  const usercontent = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 255,
    fetch: (request) =>
      routes.app?.fetch(request) ?? new Response('starting', { status: 503 }),
  });
  const origin = `http://127.0.0.1:${service.port}`;
  const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
  const storage = new MemoryStorage(`${origin}/__storage`);
  routes.app = createApp({
    config: { serviceOrigin: origin, usercontentOrigin },
    store: new MemoryStore(),
    storage,
    assets: diskAssets(join(repo, 'packages/relic-viewer/dist')),
  });
  handle = async (request) => {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith('/__storage/upload/') &&
      request.method === 'PUT'
    ) {
      storage.put(
        url.pathname.slice('/__storage/upload/'.length),
        new Uint8Array(await request.arrayBuffer())
      );
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
      const bytes = await storage.read(
        url.pathname.slice('/__storage/o/'.length)
      );
      return bytes
        ? new Response(Buffer.from(bytes))
        : new Response('not found', { status: 404 });
    }
    return (
      routes.app?.fetch(request) ?? new Response('starting', { status: 503 })
    );
  };
  return {
    origin,
    usercontentOrigin,
    repo,
    scratch,
    async stop() {
      service.stop(true);
      usercontent.stop(true);
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

interface Upload {
  readonly name: string;
  readonly bytes: Uint8Array;
}
export interface RelicPair {
  readonly relicId: string;
  readonly url: string;
}

/** One MCP tool call over stdio, as a visitor's client makes it. */
async function callTool(h: Harness, name: string, args: Json): Promise<Json> {
  const child = Bun.spawn(
    ['node', join(h.repo, 'packages/relic-mcp/dist/relic-mcp.js')],
    {
      cwd: h.scratch,
      env: {
        ...process.env,
        RELIC_SERVICE_ORIGIN: h.origin,
        RELIC_PUBLISH_STATE: join(h.scratch, 'state.json'),
        RELIC_CHROME_PATH: 'none',
        RELIC_OTIO_CHROME_PATH: 'none',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`
  );
  child.stdin.end();
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(status, 0, err);
  const line = out.trim().split('\n').filter(Boolean).at(-1);
  assert.ok(line, `${name} printed no MCP response`);
  const response: unknown = JSON.parse(line);
  assert.ok(
    isJson(response),
    `${name} replied with something other than an object`
  );
  assert.equal(
    response['error'],
    undefined,
    `${name} returned a protocol error`
  );
  const result = response['result'];
  assert.ok(isJson(result), `${name} replied without a result`);
  assert.notEqual(
    result['isError'],
    true,
    `${name} failed: ${line.slice(0, 500)}`
  );
  const content = result['structuredContent'];
  assert.ok(isJson(content), `${name} returned no structured content`);
  return content;
}

/** Version 1 with relic_publish, version 2 with relic_republish, on one share URL. */
export async function publishPair(
  h: Harness,
  label: string,
  first: Upload,
  second: Upload,
  options: { readonly extra?: Json; readonly publishOnly?: Json } = {}
): Promise<RelicPair> {
  const firstDir = join(h.scratch, label, 'v1');
  const secondDir = join(h.scratch, label, 'v2');
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  const firstPath = join(firstDir, first.name);
  await writeFile(firstPath, first.bytes);
  const created = await callTool(h, 'relic_publish', {
    path: firstPath,
    cover: false,
    ...options.publishOnly,
    ...options.extra,
  });
  assert.equal(
    created['version'],
    1,
    `${label}: the first publish is version 1`
  );
  const relicId = stringField(created, 'relic_id');
  const secondPath = join(secondDir, second.name);
  await writeFile(secondPath, second.bytes);
  const republished = await callTool(h, 'relic_republish', {
    relic_id: relicId,
    path: secondPath,
    cover: false,
    notify: false,
    ...options.extra,
  });
  assert.equal(
    republished['version'],
    2,
    `${label}: the republish is version 2`
  );
  assert.equal(
    republished['relic_id'],
    relicId,
    `${label}: the republish is the same relic`
  );
  // Republish returns no share URL. The first publish's URL carries the key that
  // the republish keeps, so that is the link a visitor opens.
  return { relicId, url: stringField(created, 'url') };
}

/** A headless browser the stage drives over CDP, with frames reached in or out of process. */
export class Browser {
  readonly requests: Recorded[] = [];
  private readonly frameSessions = new Map<
    string,
    { readonly session: string; readonly ready: Promise<void> }
  >();
  private page = '';
  private stopEvents: () => void = () => {};

  private constructor(
    private readonly child: ChildProcess,
    private readonly cdp: CdpConnection,
    private readonly profile: string
  ) {}

  /** Starts the browser named by RELIC_CHROME_PATH, attests that it is headless, and sizes its page. */
  static async open(viewport: Viewport, scratch: string): Promise<Browser> {
    const found = await discoverChrome(process.env['RELIC_CHROME_PATH']);
    if (found.kind !== 'found')
      throw new Error(`Chrome is unavailable: ${found.kind}`);
    const profile = await mkdtemp(join(scratch, 'chrome-'));
    const argv = chromeArgs(found.path, profile)
      .filter((arg) => !arg.startsWith('--proxy-'))
      .map((arg) =>
        arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
      );
    const launch = createBrowserHeadlessLaunch(argv, profile);
    const child = spawn(found.path, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
    });
    // Descriptors 3 and 4 are the pipes requested in stdio above.
    const cdp = connectPipe(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable
    );
    const browser = new Browser(child, cdp, profile);
    try {
      await attestBrowserHeadless(cdp, launch);
      await browser.setup(viewport);
      return browser;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  private async setup(viewport: Viewport): Promise<void> {
    const target = await this.cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await this.cdp.send('Target.attachToTarget', {
      targetId: target['targetId'],
      flatten: true,
    });
    this.page = stringField(attached, 'sessionId');
    for (const domain of ['Page', 'Runtime', 'DOM', 'Network'])
      await this.send(`${domain}.enable`);
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 600,
    });
    this.stopEvents = this.cdp.onEvent((event) => this.observe(event));
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  private send(
    method: string,
    params: Json = {},
    session = this.page
  ): Promise<Json> {
    return this.cdp.send(method, params, session);
  }

  /** Tracks the sessions of out-of-process frames, and records each request with its frame. */
  private observe(event: CdpEvent): void {
    if (event.method === 'Target.attachedToTarget') {
      const info = event.params['targetInfo'];
      const child = event.params['sessionId'];
      const targetId = isJson(info) ? info['targetId'] : undefined;
      if (
        isJson(info) &&
        info['type'] === 'iframe' &&
        typeof targetId === 'string' &&
        typeof child === 'string'
      ) {
        const ready = (async () => {
          try {
            await Promise.all([
              this.cdp.send('DOM.enable', {}, child),
              this.cdp.send('Runtime.enable', {}, child),
              this.cdp.send('Network.enable', {}, child),
            ]);
          } finally {
            if (event.params['waitingForDebugger'] === true)
              await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, child);
          }
        })();
        // A frame can detach before it is selected; a failure surfaces when the
        // frame is read, through inFrame().
        void ready.catch(() => {});
        this.frameSessions.set(targetId, { session: child, ready });
      } else if (
        typeof child === 'string' &&
        event.params['waitingForDebugger'] === true
      ) {
        void this.cdp
          .send('Runtime.runIfWaitingForDebugger', {}, child)
          .catch(() => {});
      }
    } else if (event.method === 'Target.detachedFromTarget') {
      const detached = event.params['sessionId'];
      for (const [id, child] of this.frameSessions)
        if (child.session === detached) this.frameSessions.delete(id);
    }
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params['request'];
      const url = isJson(request) ? request['url'] : undefined;
      const frameId = event.params['frameId'];
      if (typeof url === 'string')
        this.requests.push({
          url,
          frameId: typeof frameId === 'string' ? frameId : undefined,
        });
    }
  }

  async navigate(url: string): Promise<void> {
    const loaded = this.cdp.waitForEvent('Page.loadEventFired', {
      sessionId: this.page,
      timeoutMs: 30_000,
    });
    const navigation = await this.send('Page.navigate', { url });
    assert.equal(navigation['errorText'], undefined, 'the page did not load');
    await loaded;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      response['exceptionDetails'],
      undefined,
      `page expression threw: ${expression.slice(0, 120)}`
    );
    return resultValue<T>(response);
  }

  /** The comparison's own frames, each with the session its document lives in. */
  async frames(): Promise<FrameRef[]> {
    const nodes = await this.nodes(this.page);
    const byId = new Map(nodes.map((node) => [node.nodeId, node] as const));
    const inComparison = (node: DomNode): boolean => {
      let at: DomNode | undefined = node;
      while (at !== undefined) {
        if (classesOf(at).includes('diff-view')) return true;
        at = at.parentId === undefined ? undefined : byId.get(at.parentId);
      }
      return false;
    };
    return nodes
      .filter(
        (node) =>
          node.nodeName === 'IFRAME' &&
          classesOf(node).includes('usercontent-frame') &&
          node.frameId !== undefined &&
          inComparison(node)
      )
      .map((node) => {
        const frameId = node.frameId ?? '';
        return {
          frameId,
          title: attribute(node, 'title') ?? '',
          session: this.frameSessions.get(frameId)?.session ?? this.page,
        };
      });
  }

  private async nodes(session: string): Promise<DomNode[]> {
    const flat = await this.send(
      'DOM.getFlattenedDocument',
      { depth: -1, pierce: true },
      session
    );
    // The DOM.Node fields the reads below use; the rest of each node is not read.
    const nodes = flat['nodes'];
    assert.ok(Array.isArray(nodes), 'the flattened document has no node list');
    return nodes;
  }

  /**
   * The frame's document as a remote object. Out of process, the frame's own
   * session has it as the root. In process, it is the content document of the
   * frame's element on the page.
   */
  private async frameDocumentId(frame: FrameRef): Promise<string> {
    let backendNodeId: unknown;
    if (frame.session === this.page) {
      const nodes = await this.nodes(this.page);
      const element = nodes.find(
        (node) => node.nodeName === 'IFRAME' && node.frameId === frame.frameId
      );
      assert.ok(element, `no frame element for ${frame.title}`);
      const described = await this.send(
        'DOM.describeNode',
        { backendNodeId: element.backendNodeId, depth: 1, pierce: true },
        this.page
      );
      const node = described['node'];
      const content = isJson(node) ? node['contentDocument'] : undefined;
      backendNodeId = isJson(content) ? content['backendNodeId'] : undefined;
    } else {
      const reply = await this.send(
        'DOM.getDocument',
        { depth: 0 },
        frame.session
      );
      const root = reply['root'];
      backendNodeId = isJson(root) ? root['backendNodeId'] : undefined;
    }
    assert.equal(
      typeof backendNodeId,
      'number',
      `${frame.title}: no document node`
    );
    const resolved = await this.send(
      'DOM.resolveNode',
      { backendNodeId },
      frame.session
    );
    return objectIdOf(resolved);
  }

  /** Runs a function with the frame's document as `this`, in the frame's own world. */
  async inFrame<T>(frame: FrameRef, declaration: string): Promise<T> {
    const objectId = await this.frameDocumentId(frame);
    const response = await this.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: declaration,
        returnByValue: true,
        awaitPromise: true,
      },
      frame.session
    );
    assert.equal(
      response['exceptionDetails'],
      undefined,
      `${frame.title}: a frame expression threw`
    );
    return resultValue<T>(response);
  }

  private async center(
    element: string,
    label: string
  ): Promise<{ readonly x: number; readonly y: number }> {
    const point = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = ${element}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    assert.ok(point, `no element for ${label}`);
    return point;
  }

  /** A press and a release at the element's centre, as a reader's mouse makes them. */
  async click(element: string, label: string): Promise<void> {
    const point = await this.center(element, label);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      clickCount: 0,
    });
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
  }

  /**
   * A wheel turn over the element's centre, so it scrolls under the pointer.
   * The pointer moves onto the element first, as a reader's does: Chromium
   * sends a turn to an out-of-process frame only where the pointer has been.
   */
  async wheel(
    element: string,
    label: string,
    deltaX: number,
    deltaY: number
  ): Promise<void> {
    const point = await this.center(element, label);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      clickCount: 0,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
    });
  }

  async screenshot(file: string): Promise<void> {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(stringField(shot, 'data'), 'base64'));
  }

  async close(): Promise<void> {
    this.stopEvents();
    this.cdp.dispose();
    // Only the process this stage started. Never a browser found by name.
    this.child.kill();
    await rm(this.profile, { recursive: true, force: true });
  }
}

/** Polls an expression in the page until `done` accepts its value or the time runs out. */
async function settle<T>(
  b: Browser,
  expression: string,
  done: (value: T) => boolean,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await b.evaluate<T>(expression);
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50);
    value = await b.evaluate<T>(expression);
  }
  return value;
}

const buttonNamed = (text: string) =>
  `[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
const frameElement = (version: 1 | 2) =>
  `[...document.querySelectorAll('.diff-view iframe.usercontent-frame')].find((el) => el.title.startsWith('Version ${version} of '))`;
const SUMMARY_TEXT = `document.querySelector('.diff-view .diff-summary > span')?.textContent?.trim() ?? ''`;
const POSITION = `document.querySelector('.compare-nav-position')?.textContent?.trim() ?? ''`;
const NEXT_CHANGE = `document.querySelector('.compare-nav-next')`;
const TASKBAR_LABEL = `(() => { const el = [...document.querySelectorAll('button')].find((button) => ['Compare versions', 'Earlier versions'].includes(button.textContent.trim())); return el ? el.textContent.trim() : ''; })()`;

/** Opens the share URL as a visitor does, and returns the taskbar's comparison label. */
export async function openRelic(b: Browser, url: string): Promise<string> {
  await b.navigate(url);
  return settle<string>(b, TASKBAR_LABEL, (label) => label !== '');
}

export async function startComparison(b: Browser): Promise<void> {
  await b.click(buttonNamed('Compare versions'), 'Compare versions');
}

export async function text(b: Browser, selector: string): Promise<string> {
  return b.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`
  );
}

export async function settledSummary(b: Browser): Promise<string> {
  return settle<string>(
    b,
    SUMMARY_TEXT,
    (value) =>
      value !== '' && !/^(Rendering|Reading|Loading|Comparing)/.test(value)
  );
}

async function comparisonFrames(
  b: Browser
): Promise<{ readonly before: FrameRef; readonly after: FrameRef }> {
  const frames = await b.frames();
  assert.equal(
    frames.length,
    2,
    `two compare frames expected, saw ${frames.map((frame) => frame.title).join(' | ')}`
  );
  const before = frames.find((frame) =>
    frame.title.startsWith('Version 1 of ')
  );
  const after = frames.find((frame) => frame.title.startsWith('Version 2 of '));
  assert.ok(before && after, 'the frames are titled for versions 1 and 2');
  return { before, after };
}

const COUNT_MARKS = `function () { const counts = { added: 0, removed: 0, changed: 0 }; for (const node of this.querySelectorAll('[data-relic-diff]')) { const kind = node.getAttribute('data-relic-diff'); if (kind === 'added' || kind === 'removed' || kind === 'changed') counts[kind] += 1; } return counts; }`;

/** The outlines in a frame, polled because marks land after the diff. */
async function expectMarks(
  b: Browser,
  frame: FrameRef,
  expected: Marks,
  label: string
): Promise<void> {
  let counts: Marks = NONE;
  for (let attempt = 0; attempt < 400; attempt++) {
    counts = await b.inFrame<Marks>(frame, COUNT_MARKS);
    if (
      counts.added === expected.added &&
      counts.removed === expected.removed &&
      counts.changed === expected.changed
    )
      return;
    await Bun.sleep(50);
  }
  assert.deepEqual(counts, expected, `${label}: marks in ${frame.title}`);
}

async function frameBox(
  b: Browser,
  version: 1 | 2
): Promise<{ readonly width: number; readonly height: number }> {
  const box = await b.evaluate<{ width: number; height: number } | null>(
    `(() => { const el = ${frameElement(version)}; if (!el) return null; const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; })()`
  );
  assert.ok(box, `no frame for version ${version}`);
  return box;
}

/** The sidebar and the Changes tab show the same total as the report. */
export async function expectTotal(
  b: Browser,
  total: string,
  label: string
): Promise<void> {
  const counts = await settle<{
    readonly sidebar: string;
    readonly tab: string;
  }>(
    b,
    `({ sidebar: document.querySelector('.diff-changes-sidebar .thread-toggle .action-count')?.textContent?.trim() ?? '', tab: document.querySelector('.diff-tab .action-count')?.textContent?.trim() ?? '' })`,
    (value) => value.sidebar === total
  );
  assert.deepEqual(
    counts,
    { sidebar: total, tab: total },
    `${label}: the Changes count`
  );
}

interface ChangeListView {
  readonly kinds: readonly string[];
  readonly text: string;
  readonly inserted: readonly string[];
  readonly deleted: readonly string[];
}

/** DOCX rows: four changes, the changed words in ins and del, and no header or footer text. */
async function expectChangeRows(b: Browser, label: string): Promise<void> {
  const list = await settle<ChangeListView | null>(
    b,
    `(() => { const list = document.querySelector('.diff-change-list'); if (!list) return null; return { kinds: [...list.querySelectorAll('.diff-change-kind')].map((node) => node.textContent.trim()).sort(), text: list.textContent, inserted: [...list.querySelectorAll('ins')].map((node) => node.textContent), deleted: [...list.querySelectorAll('del')].map((node) => node.textContent) }; })()`,
    (value) => value !== null
  );
  assert.ok(list, `${label}: the change list is missing`);
  assert.deepEqual(
    [...list.kinds],
    ['added', 'changed', 'changed', 'removed'],
    `${label}: change kinds`
  );
  assert.ok(
    !list.text.includes('Draft') && !list.text.includes('Final'),
    `${label}: header text is in the change list`
  );
  assert.ok(
    list.inserted.some((value) => value.includes('except the north')),
    `${label}: the changed sentence's new words are not marked`
  );
  assert.ok(
    list.inserted.some((value) => value.includes('135')) &&
      list.deleted.some((value) => value.includes('120')),
    `${label}: the changed table cell is not marked 120 to 135`
  );
}

interface ChapterRow {
  readonly kind: string;
  readonly parts: readonly string[];
}

/** EPUB chapters: changed, removed and added in reading order, then the unchanged count. */
async function expectChapters(b: Browser, label: string): Promise<void> {
  const rows = await settle<ChapterRow[]>(
    b,
    `Array.from(document.querySelectorAll('.diff-chapters li')).map((item) => { const row = item.firstElementChild; return { kind: row ? (Array.from(row.classList).find((name) => name.startsWith('diff-chapter-') && name !== 'diff-chapter-row') ?? '') : '', parts: row ? Array.from(row.children).map((node) => node.textContent.trim()) : [] }; })`,
    (value) => value.length === 4
  );
  assert.deepEqual(
    rows.map((row) => ({ kind: row.kind, parts: [...row.parts] })),
    [
      { kind: 'diff-chapter-changed', parts: ['The crossing', '1 change'] },
      { kind: 'diff-chapter-removed', parts: ['Interlude', 'removed'] },
      { kind: 'diff-chapter-added', parts: ['Afterword', 'added'] },
      { kind: 'diff-chapter-unchanged', parts: ['1 unchanged chapter'] },
    ],
    `${label}: chapter rows`
  );
  assert.equal(
    await text(b, '.diff-title-line'),
    '',
    `${label}: the title did not change, so there is no title line`
  );
}

interface Lit {
  readonly text: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
}

const LIT_CHANGES = `function () { return [...this.querySelectorAll('.is-current-change')].map((node) => { const style = this.defaultView.getComputedStyle(node); return { text: (node.textContent || '').trim(), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }; }); }`;

/**
 * The lit change in a frame, polled because the reveal is posted to the frame
 * and answered later.
 */
async function litChange(
  b: Browser,
  frame: FrameRef,
  options: readonly string[]
): Promise<Lit[]> {
  let lit: Lit[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    lit = await b.inFrame<Lit[]>(frame, LIT_CHANGES);
    if (lit.some((node) => options.some((text) => node.text.includes(text))))
      return lit;
    await Bun.sleep(50);
  }
  return lit;
}

interface NavStep {
  readonly side: 'before' | 'after';
  readonly options: readonly string[];
}

/**
 * Each Next change press advances the position, lights one change in the
 * frame of that change's side, and the light has a visible outline.
 */
async function expectNavigation(
  b: Browser,
  frames: { readonly before: FrameRef; readonly after: FrameRef },
  total: string,
  steps: readonly NavStep[],
  label: string
): Promise<void> {
  const initial = await settle<string>(
    b,
    POSITION,
    (value) => value === `${total} changes`
  );
  assert.equal(
    initial,
    `${total} changes`,
    `${label}: the count before navigating`
  );
  for (const [index, step] of steps.entries()) {
    const number = index + 1;
    await b.click(NEXT_CHANGE, 'Next change');
    const position = await settle<string>(
      b,
      POSITION,
      (value) => value === `Change ${number} of ${total}`
    );
    assert.equal(
      position,
      `Change ${number} of ${total}`,
      `${label}: the position`
    );
    const target = step.side === 'before' ? frames.before : frames.after;
    const other = step.side === 'before' ? frames.after : frames.before;
    const lit = await litChange(b, target, step.options);
    assert.equal(
      lit.length,
      1,
      `${label}: change ${number} lights one block in its frame`
    );
    const [current] = lit;
    assert.ok(
      current && step.options.some((option) => current.text.includes(option)),
      `${label}: change ${number} lit ${JSON.stringify(current?.text)}`
    );
    assert.notEqual(
      current.outlineStyle,
      'none',
      `${label}: the lit change has no outline`
    );
    // Computed widths include the page zoom, so this is the width on screen.
    assert.ok(
      Number.parseFloat(current.outlineWidth) >= 2.5,
      `${label}: the lit change's outline is ${current.outlineWidth} on screen, under 2.5px`
    );
    const elsewhere = await b.inFrame<Lit[]>(other, LIT_CHANGES);
    assert.equal(
      elsewhere.length,
      0,
      `${label}: change ${number} also lit the other frame`
    );
  }
}

const SCROLL = `function () { const el = this.scrollingElement || this.documentElement; return { top: el.scrollTop, travel: el.scrollHeight - el.clientHeight }; }`;
interface FrameScroll {
  readonly top: number;
  readonly travel: number;
}

/**
 * A wheel turn over the after frame moves the before frame within two seconds.
 * The turn goes toward the room the frame has, so it always moves it.
 */
async function expectFrameSync(
  b: Browser,
  frames: { readonly before: FrameRef; readonly after: FrameRef },
  label: string
): Promise<void> {
  const before0 = await b.inFrame<FrameScroll>(frames.before, SCROLL);
  const after0 = await b.inFrame<FrameScroll>(frames.after, SCROLL);
  assert.ok(
    before0.travel > 0 && after0.travel > 0,
    `${label}: a frame has nothing to scroll (${JSON.stringify({ before0, after0 })})`
  );
  const deltaY = after0.top < after0.travel ? 300 : -300;
  await b.wheel(frameElement(2), 'the after frame', 0, deltaY);
  let after = after0;
  for (let attempt = 0; attempt < 100 && after.top === after0.top; attempt++) {
    await Bun.sleep(20);
    after = await b.inFrame<FrameScroll>(frames.after, SCROLL);
  }
  assert.notEqual(
    after.top,
    after0.top,
    `${label}: the after frame did not scroll`
  );
  const started = Date.now();
  let before = before0;
  while (before.top === before0.top && Date.now() - started < 2000) {
    await Bun.sleep(50);
    before = await b.inFrame<FrameScroll>(frames.before, SCROLL);
  }
  assert.notEqual(
    before.top,
    before0.top,
    `${label}: scrolling the after frame did not move the before frame within 2 s`
  );
}

/** The URLs the frames requested. The frames' own sandbox document is among them. */
function frameRequests(b: Browser, frames: readonly FrameRef[]): string[] {
  const ids = new Set(frames.map((frame) => frame.frameId));
  return b.requests
    .filter(
      (request) => request.frameId !== undefined && ids.has(request.frameId)
    )
    .map((request) => request.url);
}

/**
 * Negative 5. A frame makes no request beyond its own sandbox document and
 * assets, which the usercontent origin serves. A blob: or data: URL is
 * in-memory, such as the picture docx-preview gives an image, and makes no
 * network request. A request to any other origin fails. Returns how many
 * requests stayed in memory, for the output.
 */
function expectNoExternalFrameRequests(
  h: Harness,
  urls: readonly string[],
  label: string
): number {
  let inMemory = 0;
  for (const url of urls) {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      inMemory += 1;
      continue;
    }
    assert.ok(
      url.startsWith(`${h.usercontentOrigin}/`),
      `${label}: a frame requested ${url}, outside its own origin`
    );
  }
  return inMemory;
}

/** Swipe and side by side both work, and the stage returns to side by side. */
async function layoutRoundTrip(b: Browser, label: string): Promise<void> {
  await b.click(buttonNamed('Swipe'), `${label}: Swipe`);
  await settle<boolean>(
    b,
    `document.querySelector('.compare-stage')?.dataset.layout === 'swipe'`,
    Boolean
  );
  await b.click(buttonNamed('Side by side'), `${label}: Side by side`);
  const layout = await settle<string | undefined>(
    b,
    `document.querySelector('.compare-stage')?.dataset.layout`,
    (value) => value === 'split'
  );
  assert.equal(
    layout,
    'split',
    `${label}: the layout returned to side by side`
  );
}

interface Stack {
  readonly beforeBottom: number;
  readonly currentTop: number;
  readonly scrollWidth: number;
  readonly innerWidth: number;
  readonly tabVisible: boolean;
  readonly tabCount: string;
}

const STACK = `(() => { const before = document.querySelector('.compare-pane-before'); const current = document.querySelector('.compare-pane-current'); if (!before || !current) return null; const tab = document.querySelector('.diff-tab'); const rect = tab ? tab.getBoundingClientRect() : null; const style = tab ? getComputedStyle(tab) : null; return { beforeBottom: before.getBoundingClientRect().bottom, currentTop: current.getBoundingClientRect().top, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, tabVisible: Boolean(rect && rect.width > 0 && rect.height > 0 && style && style.display !== 'none' && style.visibility !== 'hidden'), tabCount: tab?.querySelector('.action-count')?.textContent?.trim() ?? '' }; })()`;

/** At 390 the panes stack, the page does not scroll sideways, and the Changes tab is visible. */
async function expectStacked(
  b: Browser,
  label: string,
  total: string
): Promise<void> {
  const stack = await settle<Stack | null>(b, STACK, (value) => value !== null);
  assert.ok(stack, `${label}: the panes are not in the page`);
  assert.ok(
    stack.beforeBottom <= stack.currentTop + 1,
    `${label}: the panes overlap (${stack.beforeBottom} > ${stack.currentTop})`
  );
  assert.ok(
    stack.scrollWidth <= stack.innerWidth,
    `${label}: the page scrolls sideways (${stack.scrollWidth} > ${stack.innerWidth})`
  );
  assert.equal(
    stack.tabVisible,
    true,
    `${label}: the Changes tab is not visible`
  );
  assert.equal(stack.tabCount, total, `${label}: the Changes tab count`);
  // On a phone the sidebar is a drawer, closed on load. The Changes tab opens it.
  await b.click(
    `document.querySelector('.diff-tab')`,
    `${label}: the Changes tab`
  );
  const drawer = await settle<{
    readonly open: boolean;
    readonly visible: boolean;
  } | null>(
    b,
    `(() => { const sidebar = document.querySelector('.diff-changes-sidebar'); if (!sidebar) return null; const body = sidebar.querySelector('.diff-changes-body'); const rect = body ? body.getBoundingClientRect() : null; return { open: sidebar.classList.contains('is-open'), visible: Boolean(rect && rect.width > 0 && rect.height > 0) }; })()`,
    (value) => value?.open === true && value.visible
  );
  assert.ok(
    drawer?.open && drawer.visible,
    `${label}: the Changes drawer did not open`
  );
}

async function shot(b: Browser, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  await mkdir(SHOTS, { recursive: true });
  await b.screenshot(join(SHOTS, `${name}.png`));
}

const DOCX_STEPS: readonly NavStep[] = [
  { side: 'after', options: ['except the north'] },
  { side: 'after', options: ['135'] },
  { side: 'before', options: ['This sentence is removed in version 2.'] },
  { side: 'after', options: ['Launch in May.'] },
];
const EPUB_STEPS: readonly NavStep[] = [
  { side: 'after', options: ['We crossed at noon.'] },
  {
    side: 'before',
    options: ['Interlude', 'A short pause between crossings.'],
  },
];

/** A DOCX or EPUB comparison at one viewport. */
async function proveDocument(
  h: Harness,
  format: 'docx' | 'epub',
  pair: RelicPair,
  viewport: Viewport
): Promise<void> {
  const label = `${format} ${viewport.width}x${viewport.height}`;
  const b = await Browser.open(viewport, h.scratch);
  try {
    assert.equal(
      await openRelic(b, pair.url),
      'Compare versions',
      `${label}: the taskbar offers Compare versions`
    );
    await startComparison(b);
    assert.equal(
      await settledSummary(b),
      SUMMARY[format],
      `${label}: the result line`
    );
    assert.equal(
      await text(b, '.diff-view .diff-summary > strong'),
      HEADING[format],
      `${label}: the heading`
    );
    const frames = await comparisonFrames(b);
    if (viewport.width === DESKTOP.width) {
      for (const version of [1, 2] as const) {
        const box = await frameBox(b, version);
        assert.ok(
          box.height > 300,
          `${label}: version ${version} frame is ${box.height}px tall; at 1440x900 each frame must be over 300px`
        );
      }
    }
    await expectMarks(b, frames.before, MARKS[format].before, label);
    await expectMarks(b, frames.after, MARKS[format].after, label);
    await expectTotal(b, TOTAL[format], label);
    if (format === 'docx') await expectChangeRows(b, label);
    else await expectChapters(b, label);
    const urls = frameRequests(b, [frames.before, frames.after]);
    const inMemory = expectNoExternalFrameRequests(h, urls, label);
    console.log(
      `VERSION_COMPARE ${label} summary=${JSON.stringify(SUMMARY[format])} frame_requests=${urls.length} in_memory=${inMemory}`
    );
    if (viewport.width === DESKTOP.width) {
      await layoutRoundTrip(b, label);
      // Sync runs first, from the top of both frames. The navigation reveals a
      // change near the end of the EPUB, and a sync after it would leave the
      // after frame at its bottom with nowhere to scroll.
      await expectFrameSync(b, frames, label);
      await expectNavigation(
        b,
        frames,
        TOTAL[format],
        format === 'docx' ? DOCX_STEPS : EPUB_STEPS,
        label
      );
    } else {
      await expectStacked(b, label, TOTAL[format]);
    }
    await shot(b, `${format}-${viewport.width}`);
  } finally {
    await b.close();
  }
}

interface TabView {
  readonly name: string;
  readonly selected: string | null;
  readonly badges: readonly { readonly text: string; readonly tone: string }[];
}

const TABS = `[...document.querySelectorAll('.spreadsheet-tabs [role=tab]')].map((tab) => ({ name: tab.querySelector('span')?.textContent ?? '', selected: tab.getAttribute('aria-selected'), badges: [...tab.querySelectorAll('.dt-sheet-meta')].map((meta) => ({ text: meta.textContent ?? '', tone: [...meta.classList].filter((name) => name !== 'dt-sheet-meta').join(' ') })) }))`;

const EXPECTED_TABS = [
  {
    name: 'Hidden',
    selected: 'false',
    badges: [
      { text: 'hidden', tone: '' },
      { text: '1 change', tone: 'is-changes' },
    ],
  },
  {
    name: 'Old data',
    selected: 'false',
    badges: [{ text: 'removed', tone: 'is-removed' }],
  },
  {
    name: 'Q3 budget',
    selected: 'true',
    badges: [
      { text: 'renamed from Q3', tone: '' },
      { text: '5 changes', tone: 'is-changes' },
    ],
  },
  {
    name: 'Summary',
    selected: 'false',
    badges: [{ text: 'added', tone: 'is-added' }],
  },
];

/** The strip pairs the sheets and badges each one: added, removed, renamed and changed. */
async function expectTabs(b: Browser, label: string): Promise<void> {
  const tabs = await settle<TabView[]>(b, TABS, (value) => value.length === 4);
  const sorted = [...tabs].sort((a, c) => a.name.localeCompare(c.name));
  assert.deepEqual(
    sorted.map((tab) => ({
      name: tab.name,
      selected: tab.selected,
      badges: tab.badges.map((badge) => ({ ...badge })),
    })),
    EXPECTED_TABS,
    `${label}: the sheet strip`
  );
}

interface CellState {
  readonly diff: readonly string[];
  readonly sr: string;
}
interface CellWant {
  readonly diff: string;
  readonly sr: string;
}

const BEFORE_CELLS: Record<string, CellWant> = {
  C3: { diff: 'dt-diff-changed', sr: '(changed)' },
  E2: { diff: 'dt-diff-changed', sr: '(changed)' },
  E3: { diff: 'dt-diff-formula', sr: '(formula changed)' },
  D5: { diff: '', sr: '' },
  B7: { diff: 'dt-diff-removed', sr: '(removed)' },
};
const AFTER_CELLS: Record<string, CellWant> = {
  C3: { diff: 'dt-diff-changed', sr: '(changed)' },
  E2: { diff: 'dt-diff-changed', sr: '(changed)' },
  E3: { diff: 'dt-diff-formula', sr: '(formula changed)' },
  D5: { diff: 'dt-diff-added', sr: '(added)' },
  B7: { diff: '', sr: '' },
};

/** Cells by A1 position: the state class in each grid, and the hidden word a screen reader hears. */
async function expectCells(b: Browser, label: string): Promise<void> {
  const sides = [
    ['before', BEFORE_CELLS],
    ['current', AFTER_CELLS],
  ] as const;
  for (const [side, expected] of sides) {
    const expression = `(() => { const grid = document.querySelector('.compare-pane-${side} [role=grid]'); const out = {}; for (const [name, row, col] of [['C3', 2, 2], ['E2', 1, 4], ['E3', 2, 4], ['D5', 4, 3], ['B7', 6, 1]]) { const cell = grid ? grid.querySelector('.dt-cell[data-r="' + row + '"][data-c="' + col + '"]') : null; out[name] = cell ? { diff: [...cell.classList].filter((cls) => cls.startsWith('dt-diff-')), sr: cell.querySelector('.dt-sr')?.textContent ?? '' } : null; } return out; })()`;
    const states = await settle<Record<string, CellState | null>>(
      b,
      expression,
      (value) => Object.values(value).every((cell) => cell !== null)
    );
    for (const [name, want] of Object.entries(expected)) {
      const got = states[name];
      assert.ok(got, `${label}: ${side} cell ${name} is not drawn`);
      assert.deepEqual(
        [...got.diff],
        want.diff === '' ? [] : [want.diff],
        `${label}: ${side} grid, cell ${name}`
      );
      if (want.sr !== '')
        assert.ok(
          got.sr.includes(want.sr),
          `${label}: ${side} grid, cell ${name} lacks the hidden text ${want.sr}`
        );
    }
  }
}

/** aria-selected on E2 and C3 in each grid. Next change selects a cell in both. */
const SELECTED_E2 = `['before', 'current'].map((side) => { const cell = document.querySelector('.compare-pane-' + side + ' [role=grid] .dt-cell[data-r="1"][data-c="4"]'); return cell ? cell.getAttribute('aria-selected') : null; })`;
const SELECTED_C3 = `['before', 'current'].map((side) => { const cell = document.querySelector('.compare-pane-' + side + ' [role=grid] .dt-cell[data-r="2"][data-c="2"]'); return cell ? cell.getAttribute('aria-selected') : null; })`;

/** Next change walks the changed cells in row order, selecting each in both grids. */
async function expectGridNavigation(b: Browser, label: string): Promise<void> {
  await settle<string>(b, POSITION, (value) => value === '5 changes');
  await b.click(NEXT_CHANGE, 'Next change');
  const first = await settle<string>(
    b,
    POSITION,
    (value) => value === 'Change 1 of 5'
  );
  assert.equal(first, 'Change 1 of 5', `${label}: the first position`);
  // Row order puts E2 first, so both grids select E2.
  const e2 = await settle<(string | null)[]>(b, SELECTED_E2, (value) =>
    value.every((selected) => selected === 'true')
  );
  assert.deepEqual(
    e2,
    ['true', 'true'],
    `${label}: E2 is selected in both grids`
  );
  await b.click(NEXT_CHANGE, 'Next change');
  const second = await settle<string>(
    b,
    POSITION,
    (value) => value === 'Change 2 of 5'
  );
  assert.equal(second, 'Change 2 of 5', `${label}: the second position`);
  const c3 = await settle<(string | null)[]>(b, SELECTED_C3, (value) =>
    value.every((selected) => selected === 'true')
  );
  assert.deepEqual(
    c3,
    ['true', 'true'],
    `${label}: C3 is selected in both grids`
  );
}

interface GridScroll {
  readonly top: number;
  readonly left: number;
  readonly travelY: number;
  readonly travelX: number;
}

const GRID_SCROLL = (side: 'before' | 'current') =>
  `(() => { const grid = document.querySelector('.compare-pane-${side} [role=grid]'); if (!grid) return null; return { top: grid.scrollTop, left: grid.scrollLeft, travelY: grid.scrollHeight - grid.clientHeight, travelX: grid.scrollWidth - grid.clientWidth }; })()`;

/** Both grids take the same scrollTop and scrollLeft after a wheel turn over the after grid. */
async function expectGridMirror(b: Browser, label: string): Promise<void> {
  const after0 = await settle<GridScroll | null>(
    b,
    GRID_SCROLL('current'),
    (value) => value !== null
  );
  assert.ok(after0, `${label}: the after grid is not drawn`);
  assert.ok(
    after0.travelY > 0 || after0.travelX > 0,
    `${label}: the after grid cannot scroll, so the mirror is not exercised (${JSON.stringify(after0)})`
  );
  await b.wheel(
    `document.querySelector('.compare-pane-current [role=grid]')`,
    'the after grid',
    after0.travelX > 0 ? 120 : 0,
    after0.travelY > 0 ? 160 : 0
  );
  const moved = await settle<GridScroll | null>(
    b,
    GRID_SCROLL('current'),
    (value) =>
      value !== null && (value.top !== after0.top || value.left !== after0.left)
  );
  assert.ok(
    moved && (moved.top !== after0.top || moved.left !== after0.left),
    `${label}: the after grid did not scroll`
  );
  const deadline = Date.now() + 2000;
  let before: GridScroll | null = null;
  while (Date.now() < deadline) {
    before = await b.evaluate<GridScroll | null>(GRID_SCROLL('before'));
    if (
      before !== null &&
      before.top === moved.top &&
      before.left === moved.left
    )
      return;
    await Bun.sleep(50);
  }
  assert.deepEqual(
    { top: before?.top, left: before?.left },
    { top: moved.top, left: moved.left },
    `${label}: the before grid does not mirror the after grid within 2 s`
  );
}

/** A workbook pair at one viewport. A spreadsheet comparison draws grids, never frames. */
async function proveSpreadsheet(
  h: Harness,
  pair: RelicPair,
  viewport: Viewport
): Promise<void> {
  const label = `xlsx ${viewport.width}x${viewport.height}`;
  const b = await Browser.open(viewport, h.scratch);
  try {
    assert.equal(
      await openRelic(b, pair.url),
      'Compare versions',
      `${label}: the taskbar offers Compare versions`
    );
    await startComparison(b);
    assert.equal(
      await settledSummary(b),
      SUMMARY.xlsx,
      `${label}: the result line`
    );
    assert.equal(
      await text(b, '.diff-view .diff-summary > strong'),
      HEADING.xlsx,
      `${label}: the heading`
    );
    assert.equal(
      (await b.frames()).length,
      0,
      `${label}: a spreadsheet comparison has no frames`
    );
    await expectTabs(b, label);
    await expectTotal(b, TOTAL.xlsx, label);
    console.log(
      `VERSION_COMPARE ${label} summary=${JSON.stringify(SUMMARY.xlsx)} tabs=ok`
    );
    if (viewport.width === DESKTOP.width) {
      await expectCells(b, label);
      await expectGridNavigation(b, label);
      await layoutRoundTrip(b, label);
      await expectGridMirror(b, label);
    } else {
      await expectStacked(b, label, TOTAL.xlsx);
    }
    await shot(b, `xlsx-${viewport.width}`);
  } finally {
    await b.close();
  }
}

export async function uploadsFor(
  format: Format
): Promise<readonly [Upload, Upload]> {
  switch (format) {
    case 'docx':
      return [
        { name: 'quarterly.docx', bytes: await docxV1() },
        { name: 'quarterly.docx', bytes: await docxV2() },
      ];
    case 'epub':
      return [
        { name: 'crossings.epub', bytes: epubV1() },
        { name: 'crossings.epub', bytes: epubV2() },
      ];
    case 'xlsx':
      return [
        { name: 'budget.xlsx', bytes: xlsxV1() },
        { name: 'budget.xlsx', bytes: xlsxV2() },
      ];
  }
}

/** Negative 1: a version that differs only in core.xml has no text changes and no marks. */
async function negativeCoreOnly(h: Harness): Promise<void> {
  const v1 = await docxV1();
  const pair = await publishPair(
    h,
    'core-only',
    { name: 'quarterly.docx', bytes: v1 },
    { name: 'quarterly-core.docx', bytes: await docxV1CoreOnly(v1) }
  );
  const b = await Browser.open(DESKTOP, h.scratch);
  try {
    assert.equal(await openRelic(b, pair.url), 'Compare versions');
    await startComparison(b);
    assert.equal(
      await settledSummary(b),
      NO_TEXT_CHANGES,
      'core-only: the result line'
    );
    // With no changes, navigation says so and its buttons are off.
    const nav = await settle<{
      readonly position: string;
      readonly next: boolean;
    }>(
      b,
      `({ position: document.querySelector('.compare-nav-position')?.textContent?.trim() ?? '', next: Boolean(document.querySelector('.compare-nav-next')?.disabled) })`,
      (value) => value.position === 'No changes'
    );
    assert.deepEqual(
      nav,
      { position: 'No changes', next: true },
      'core-only: the navigation'
    );
    const frames = await comparisonFrames(b);
    await expectMarks(b, frames.before, NONE, 'core-only');
    await expectMarks(b, frames.after, NONE, 'core-only');
  } finally {
    await b.close();
  }
}

/** Negative 2: a DOCX republished as an EPUB displays differently, so version 1 is shown alone. */
async function negativeMismatch(h: Harness): Promise<void> {
  const pair = await publishPair(
    h,
    'mismatch',
    { name: 'quarterly.docx', bytes: await docxV1() },
    { name: 'crossings.epub', bytes: epubV2() }
  );
  const b = await Browser.open(DESKTOP, h.scratch);
  try {
    assert.equal(await openRelic(b, pair.url), 'Compare versions');
    await startComparison(b);
    const shown = await settle<boolean>(
      b,
      `document.body.textContent.includes(${JSON.stringify(MISMATCH)})`,
      Boolean
    );
    assert.equal(shown, true, 'mismatch: the display-differently copy');
  } finally {
    await b.close();
  }
}

/** Negative 3: a version over 16 MiB gets the notice, and the taskbar offers Earlier versions. */
async function negativeOversize(h: Harness): Promise<void> {
  const pair = await publishPair(
    h,
    'oversize',
    { name: 'quarterly.docx', bytes: await docxV1() },
    { name: 'quarterly-padded.docx', bytes: await docxPadded() }
  );
  const b = await Browser.open(DESKTOP, h.scratch);
  try {
    assert.equal(
      await openRelic(b, pair.url),
      'Earlier versions',
      'oversize: the taskbar offers Earlier versions, not Compare versions'
    );
    const shown = await settle<boolean>(
      b,
      `document.body.textContent.includes(${JSON.stringify(OVERSIZE)})`,
      Boolean
    );
    assert.equal(shown, true, 'oversize: the 16 MiB notice');
  } finally {
    await b.close();
  }
}

const FRAME_STATE = `function () { return { literal: (this.body ? this.body.textContent : '').includes(${JSON.stringify(HOSTILE)}), images: this.querySelectorAll('img').length, pwned: typeof this.defaultView.__relicPwned }; }`;

/**
 * Negative 4: hostile markup in an EPUB reads as text in the sidebar and in the
 * frame, creates no image, and runs nothing. A U+202E sheet name shows as an
 * escape. Negative 5 is checked in the same EPUB run, from the frames' requests.
 */
async function negativeHostileAndBidi(h: Harness): Promise<void> {
  const hostile = await publishPair(
    h,
    'hostile',
    { name: 'crossings.epub', bytes: epubV1() },
    { name: 'crossings-hostile.epub', bytes: epubV2Hostile() }
  );
  const b = await Browser.open(DESKTOP, h.scratch);
  try {
    assert.equal(await openRelic(b, hostile.url), 'Compare versions');
    await startComparison(b);
    assert.equal(
      await settledSummary(b),
      SUMMARY.epub,
      'hostile: the result line'
    );
    // The word diff keeps unchanged spaces between the inserted words, so the
    // markup reads as text in pieces. Each piece must be present as text, and
    // no element or handler may come from it.
    const parent = await settle<{
      readonly pwned: string;
      readonly literal: boolean;
      readonly images: number;
      readonly handlers: number;
    }>(
      b,
      `(() => { const list = document.querySelector('.diff-change-list'); const text = list ? list.textContent : ''; return { pwned: typeof window.__relicPwned, literal: text.includes('<img') && text.includes('src=x') && text.includes('onerror="window.__relicPwned=1">'), images: document.querySelectorAll('.diff-changes-sidebar img').length, handlers: document.querySelectorAll('.diff-changes-sidebar [onerror]').length }; })()`,
      (value) => value.literal
    );
    assert.equal(
      parent.literal,
      true,
      'hostile: the sidebar shows the markup as text'
    );
    assert.equal(
      parent.images,
      0,
      'hostile: an img was created in the sidebar'
    );
    assert.equal(
      parent.handlers,
      0,
      'hostile: an onerror handler was created in the sidebar'
    );
    assert.equal(
      parent.pwned,
      'undefined',
      'hostile: the page ran the onerror handler'
    );
    const frames = await comparisonFrames(b);
    for (const frame of [frames.before, frames.after]) {
      const state = await b.inFrame<{
        literal: boolean;
        images: number;
        pwned: string;
      }>(frame, FRAME_STATE);
      assert.equal(state.images, 0, `hostile: ${frame.title} created an img`);
      assert.equal(
        state.pwned,
        'undefined',
        `hostile: ${frame.title} ran the handler`
      );
      // Only version 2 carries the markup, so only its frame shows it.
      if (frame === frames.after)
        assert.equal(
          state.literal,
          true,
          `hostile: ${frame.title} does not show the markup as text`
        );
    }
    const urls = frameRequests(b, [frames.before, frames.after]);
    const inMemory = expectNoExternalFrameRequests(h, urls, 'hostile');
    console.log(
      `VERSION_COMPARE hostile-epub frame_requests=${urls.length} in_memory=${inMemory}`
    );
  } finally {
    await b.close();
  }
  const bidi = await publishPair(
    h,
    'bidi',
    { name: 'budget.xlsx', bytes: xlsxV1() },
    { name: 'budget-bidi.xlsx', bytes: xlsxV2BidiSheet() }
  );
  const sheets = await Browser.open(DESKTOP, h.scratch);
  try {
    assert.equal(await openRelic(sheets, bidi.url), 'Compare versions');
    await startComparison(sheets);
    assert.equal(
      await settledSummary(sheets),
      SUMMARY.xlsx,
      'bidi: the result line'
    );
    const tabs = await settle<TabView[]>(
      sheets,
      TABS,
      (value) => value.length === 4
    );
    const names = tabs.map((tab) => tab.name);
    assert.ok(
      names.includes(ESCAPED_SHEET),
      `bidi: the strip does not show ${ESCAPED_SHEET} (${JSON.stringify(names)})`
    );
    const added = tabs.find((tab) => tab.name === ESCAPED_SHEET);
    assert.ok(
      added?.badges.some((badge) => badge.text === 'added'),
      'bidi: the escaped sheet is not badged added'
    );
    assert.equal(
      await sheets.evaluate<boolean>(
        `document.body.textContent.includes(String.fromCharCode(8238))`
      ),
      false,
      'bidi: the raw U+202E character reached the page'
    );
  } finally {
    await sheets.close();
  }
}

async function main(): Promise<void> {
  const h = await startHarness();
  const proven = new Set<number>();
  const formats: readonly Format[] = ['docx', 'epub', 'xlsx'];
  const widths = [DESKTOP, PHONE];
  try {
    for (const format of formats) {
      const [first, second] = await uploadsFor(format);
      const pair = await publishPair(h, format, first, second);
      for (const viewport of widths) {
        if (format === 'xlsx') await proveSpreadsheet(h, pair, viewport);
        else await proveDocument(h, format, pair, viewport);
      }
    }
    await negativeCoreOnly(h);
    proven.add(1);
    await negativeMismatch(h);
    proven.add(2);
    await negativeOversize(h);
    proven.add(3);
    await negativeHostileAndBidi(h);
    proven.add(4);
    proven.add(5);
    assert.equal(proven.size, 5, 'all five negatives ran');
    console.log(
      `VERSION_COMPARE_PATH_OK formats=${formats.join(',')} widths=${widths.map((viewport) => viewport.width).join(',')} negatives=${proven.size}`
    );
  } finally {
    await h.stop();
  }
}

if (import.meta.main) await main();
