import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { crc32, planStoredZip } from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'relic-epub-viewer-'));
let app: { fetch(request: Request): Promise<Response> };
let handler: (request: Request) => Promise<Response>;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => handler(request),
});
const usercontent = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => app.fetch(request),
});
const origin = `http://127.0.0.1:${service.port}`;
const usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin },
  store: new MemoryStore(),
  storage,
  assets: diskAssets(join(repo, 'packages/relic-viewer/dist')),
});
handler = async (request) => {
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
  return app.fetch(request);
};
function epub(version: 2 | 3): Uint8Array {
  const encoder = new TextEncoder();
  const nav =
    version === 3
      ? '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter#start">Chapter One</a></li><li><a href="second#target">Chapter Two</a></li><li><a href="third#start">Chapter Three</a></li></ol></nav></body></html>'
      : '<ncx><navMap><navPoint><navLabel><text>Chapter One</text></navLabel><content src="chapter#start"/></navPoint><navPoint><navLabel><text>Chapter Two</text></navLabel><content src="second#target"/></navPoint><navPoint><navLabel><text>Chapter Three</text></navLabel><content src="third#start"/></navPoint></navMap></ncx>';
  const navType =
    version === 3 ? 'application/xhtml+xml' : 'application/x-dtbncx+xml';
  const navProps = version === 3 ? ' properties="nav"' : '';
  const source: readonly (readonly [string, string])[] = [
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    ],
    [
      'OPS/book.opf',
      `<package><metadata><title>Viewer proof ${version}</title>${version === 2 ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest><item id="c" href="chapter" media-type="application/xhtml+xml"/><item id="c2" href="second" media-type="image/svg+xml"/><item id="c3" href="third" media-type="application/xhtml+xml"/><item id="nav" href="contents" media-type="${navType}"${navProps}/><item id="cover" href="cover" media-type="image/svg+xml"/><item id="style" href="style" media-type="text/css"/><item id="base" href="base.css" media-type="text/css"/></manifest><spine toc="nav"><itemref idref="c"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`,
    ],
    ['OPS/contents', nav],
    [
      'OPS/style',
      '@import "base.css" layer(book) supports(display: grid) screen and (min-width: 300px);',
    ],
    ['OPS/base.css', 'body#start{background-color:rgb(7, 8, 9)}'],
    [
      'OPS/chapter',
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><link rel="stylesheet" href="style"/><style>body#start{color:rgb(1, 2, 3)}</style><style media="print">body#start{color:red}</style></head><body id="start"><h1>Readable EPUB chapter</h1><p>Unique annotation sentence.</p><a id="jump" href="second#target">Go to chapter two</a><p>Note <a id="noteref" epub:type="noteref" href="#footnote">1</a></p><aside id="footnote">The footnote <a href="#start">Return to chapter</a> <a href="https://example.com/">Read more</a></aside><img id="art" src="cover"/>${'<p>Reader text.</p>'.repeat(90)}</body></html>`,
    ],
    [
      'OPS/second',
      `<svg xmlns="http://www.w3.org/2000/svg" id="target" viewBox="0 0 600 600" width="${version === 2 ? '1200' : '100%'}" height="${version === 2 ? '1200' : '500'}"><text x="10" y="30">Chapter Two Heading</text><rect width="100" height="100" fill="blue"/></svg>`,
    ],
    [
      'OPS/third',
      `<html xmlns="http://www.w3.org/1999/xhtml"><body id="start"><h1 id="heading">The Northern Approach</h1>${'<p>Following chapter text.</p>'.repeat(90)}</body></html>`,
    ],
    [
      'OPS/cover',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="red"/></svg>',
    ],
  ];
  const data = source.map(([name, text]) => ({
    name,
    bytes: encoder.encode(text),
  }));
  const plan = planStoredZip(
    data.map(({ name, bytes }) => ({
      name,
      size: bytes.length,
      crc32: crc32(bytes),
    }))
  );
  const result = new Uint8Array(plan.totalBytes);
  let offset = 0;
  for (let i = 0; i < data.length; i++) {
    const header = plan.localHeaders[i]!;
    result.set(header, offset);
    offset += header.length;
    result.set(data[i]!.bytes, offset);
    offset += data[i]!.bytes.length;
  }
  result.set(plan.centralDirectory, offset);
  offset += plan.centralDirectory.length;
  result.set(plan.end, offset);
  return result;
}
async function publish(version: 2 | 3): Promise<string> {
  const path = join(scratch, `reader-${version}.epub`);
  await writeFile(path, epub(version));
  const child = Bun.spawn(
    ['node', join(repo, 'packages/relic-mcp/dist/relic-mcp.js')],
    {
      cwd: scratch,
      env: {
        ...process.env,
        RELIC_SERVICE_ORIGIN: origin,
        RELIC_PUBLISH_STATE: join(scratch, 'state.json'),
        RELIC_CHROME_PATH: 'none',
        RELIC_OTIO_CHROME_PATH: 'none',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'relic_publish', arguments: { path, title: `EPUB ${version}`, cover: false } } })}\n`
  );
  child.stdin.end();
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(status, 0, err);
  const line = out.trim().split('\n').filter(Boolean).at(-1);
  assert.ok(line, 'no MCP response');
  const response = JSON.parse(line) as {
    result?: { isError?: boolean; structuredContent?: { url?: string } };
    error?: unknown;
  };
  assert.equal(response.error, undefined);
  assert.notEqual(response.result?.isError, true);
  const url = response.result?.structuredContent?.url;
  assert.ok(
    url !== undefined && url.includes('#'),
    'missing encrypted viewer URL'
  );
  return url;
}
type DomNode = {
  nodeId: number;
  backendNodeId: number;
  frameId?: string;
  parentId?: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
};
async function prove(
  url: string,
  width: number,
  height: number,
  fixed: boolean
): Promise<void> {
  const found = await discoverChrome(process.env['RELIC_CHROME_PATH']);
  if (found.kind !== 'found')
    throw new Error('Owned headless shell is unavailable');
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
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  let stopEvents = () => {};
  try {
    await attestBrowserHeadless(cdp, launch);
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target['targetId'],
      flatten: true,
    });
    const session = attached['sessionId'] as string;
    const send = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, session);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    const requests: string[] = [];
    const frameSessions = new Map<
      string,
      { session: string; ready: Promise<void> }
    >();
    stopEvents = cdp.onEvent((event) => {
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
          const ready = (async () => {
            try {
              await Promise.all([
                cdp.send('DOM.enable', {}, child),
                cdp.send('Runtime.enable', {}, child),
                cdp.send('Network.enable', {}, child),
              ]);
            } finally {
              if (event.params['waitingForDebugger'] === true)
                await cdp.send('Runtime.runIfWaitingForDebugger', {}, child);
            }
          })();
          // A frame can detach before it is selected; selected failures still
          // propagate when its readiness promise is awaited below.
          void ready.catch(() => {});
          frameSessions.set(info.targetId, { session: child, ready });
        } else if (
          typeof child === 'string' &&
          event.params['waitingForDebugger'] === true
        ) {
          void cdp
            .send('Runtime.runIfWaitingForDebugger', {}, child)
            .catch(() => {});
        }
      } else if (event.method === 'Target.detachedFromTarget') {
        const detached = event.params['sessionId'];
        for (const [id, child] of frameSessions)
          if (child.session === detached) frameSessions.delete(id);
      }
      if (
        event.method === 'Network.requestWillBeSent' &&
        (event.sessionId === session ||
          [...frameSessions.values()].some(
            (child) => child.session === event.sessionId
          ))
      ) {
        const request = event.params['request'] as { url?: string };
        if (request.url) requests.push(request.url);
      }
    });
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId: session,
      timeoutMs: 30000,
    });
    const navigation = await send('Page.navigate', { url });
    assert.equal(navigation['errorText'], undefined);
    await loaded;
    const nodesIn = async (targetSession: string) =>
      (
        await cdp.send(
          'DOM.getFlattenedDocument',
          { depth: -1, pierce: true },
          targetSession
        )
      )['nodes'] as DomNode[];
    const attr = (node: DomNode, name: string) => {
      const attrs = node.attributes ?? [];
      const i = attrs.indexOf(name);
      return i < 0 ? undefined : attrs[i + 1];
    };
    let all: DomNode[] = [];
    let frame: DomNode | undefined;
    let frameSession = session;
    for (let i = 0; i < 200; i++) {
      const pageNodes = await nodesIn(session);
      frame = pageNodes.find(
        (node) =>
          node.nodeName === 'IFRAME' &&
          (attr(node, 'class') ?? '').includes('usercontent-frame')
      );
      const child =
        (frame?.frameId && frameSessions.get(frame.frameId)) ||
        (frame && frameSessions.size === 1
          ? [...frameSessions.values()][0]
          : undefined);
      if (child) {
        await child.ready;
        frameSession = child.session;
        all = await nodesIn(frameSession);
      } else {
        frameSession = session;
        all = pageNodes;
      }
      if (all.some((node) => node.nodeValue === 'Readable EPUB chapter')) break;
      await Bun.sleep(50);
    }
    assert.ok(
      all.some((node) => node.nodeValue === 'Readable EPUB chapter'),
      'EPUB did not render through viewer'
    );
    assert.ok(frame, 'viewer did not mount a usercontent frame');
    const readerFrame = frame;
    const sendFrame = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, frameSession);
    const nodes = () => nodesIn(frameSession);
    const waitForNodes = async (
      predicate: (current: DomNode[]) => boolean,
      label: string
    ): Promise<DomNode[]> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const current = await nodes();
        if (predicate(current)) return current;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const waitForParent = async (expression: string, label: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = (await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        if (response.result?.value === true) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const box = (await send('DOM.getBoxModel', {
      backendNodeId: readerFrame.backendNodeId,
    })) as {
      model: { width: number; height: number; content: number[] };
    };
    assert.ok(
      box.model.width > width * 0.7 && box.model.height > height * 0.4,
      `reader too small: ${box.model.width}x${box.model.height}`
    );
    const art = all.find(
      (node) => node.nodeName === 'IMG' && attr(node, 'id') === 'ep-0-art'
    );
    assert.ok(
      art && attr(art, 'src')?.startsWith('data:image/svg+xml;base64,'),
      'SVG cover missing'
    );
    assert.ok(art);
    const artObject = (await sendFrame('DOM.resolveNode', {
      backendNodeId: art.backendNodeId,
    })) as { object: { objectId: string } };
    let decoded = false;
    for (let i = 0; i < 100; i++) {
      const status = (await sendFrame('Runtime.callFunctionOn', {
        objectId: artObject.object.objectId,
        functionDeclaration:
          'function(){return this.complete && this.naturalWidth > 0 && this.naturalHeight > 0}',
        returnByValue: true,
      })) as { result: { value?: boolean } };
      if (status.result.value) {
        decoded = true;
        break;
      }
      await Bun.sleep(50);
    }
    assert.ok(decoded, 'SVG cover did not decode');
    assert.ok(
      all.some(
        (node) =>
          node.nodeName.toLowerCase() === 'svg' &&
          attr(node, 'id') === 'ep-1-target'
      ),
      'SVG spine viewport missing'
    );
    if (fixed) {
      const svg = all.find((node) => attr(node, 'id') === 'ep-1-target');
      assert.ok(svg);
      const svgObject = (await sendFrame('DOM.resolveNode', {
        backendNodeId: svg.backendNodeId,
      })) as { object: { objectId: string } };
      const geometry = (await sendFrame('Runtime.callFunctionOn', {
        objectId: svgObject.object.objectId,
        functionDeclaration:
          "function(){const rect=this.getBoundingClientRect();const page=this.closest('article[data-epub-chapter]');return {left:rect.left,right:rect.right,width:rect.width,height:rect.height,viewport:this.ownerDocument.documentElement.clientWidth,zoom:Number.parseFloat(getComputedStyle(page).zoom),intrinsic:this.getAttribute('width')}}",
        returnByValue: true,
      })) as {
        result: {
          value?: {
            left: number;
            right: number;
            width: number;
            height: number;
            viewport: number;
            zoom: number;
            intrinsic: string | null;
          };
        };
      };
      const rect = geometry.result.value;
      assert.ok(rect, 'fixed SVG geometry unavailable');
      assert.equal(
        rect.intrinsic,
        '1200',
        'fixed SVG fixture lost its intrinsic width'
      );
      assert.ok(
        rect.zoom > 0 && rect.zoom < 1,
        `fixed SVG scale is ${rect.zoom}`
      );
      assert.ok(
        rect.width > 0 && rect.left >= -1 && rect.right <= rect.viewport + 1,
        `fixed SVG exceeds reader width: ${JSON.stringify(rect)}`
      );
      assert.ok(
        Math.abs(rect.width - rect.height) <= 2,
        `fixed SVG aspect ratio changed: ${JSON.stringify(rect)}`
      );
    }
    const targetNode = all.find((node) => attr(node, 'id') === 'ep-0-start');
    assert.ok(targetNode, 'body fragment missing');
    const resolved = (await sendFrame('DOM.resolveNode', {
      backendNodeId: targetNode.backendNodeId,
    })) as { object: { objectId: string } };
    const color = (await sendFrame('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: 'function(){return getComputedStyle(this).color}',
      returnByValue: true,
    })) as { result: { value?: string } };
    const shellBackgrounds = (await sendFrame('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration:
        'function(){return [getComputedStyle(this.ownerDocument.documentElement).backgroundColor,getComputedStyle(this.ownerDocument.body).backgroundColor]}',
      returnByValue: true,
    })) as { result: { value?: string[] } };
    assert.deepEqual(
      shellBackgrounds.result.value,
      ['rgb(255, 255, 255)', 'rgb(255, 255, 255)'],
      'sandbox root and body must retain their white defaults'
    );
    assert.equal(
      color.result.value,
      'rgb(1, 2, 3)',
      'chapter-root/ID CSS did not apply'
    );
    const background = (await sendFrame('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration:
        'function(){return getComputedStyle(this).backgroundColor}',
      returnByValue: true,
    })) as { result: { value?: string } };
    assert.equal(
      background.result.value,
      'rgb(7, 8, 9)',
      'layered, conditional stylesheet import did not apply'
    );
    const button = async (label: string) => {
      const current = await nodes();
      const text = current.find(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue === label &&
          current.find((parent) => parent.nodeId === node.parentId)
            ?.nodeName === 'BUTTON'
      );
      const element = current.find((node) => node.nodeId === text?.parentId);
      assert.ok(element, `missing button ${label}`);
      return element.backendNodeId;
    };
    const byId = async (id: string) => {
      const node = (await nodes()).find((item) => attr(item, 'id') === id);
      assert.ok(node, `missing ${id}`);
      return node.backendNodeId;
    };
    const noteLink = async (label: string) => {
      const current = await nodes();
      const byNodeId = new Map(current.map((node) => [node.nodeId, node]));
      for (const text of current) {
        if (text.nodeName !== '#text' || text.nodeValue !== label) continue;
        const link = byNodeId.get(text.parentId ?? 0);
        if (link?.nodeName !== 'A') continue;
        let ancestor: DomNode | undefined = link;
        while (ancestor) {
          if (
            ancestor.nodeName === 'ASIDE' &&
            attr(ancestor, 'class') === 'panel' &&
            attr(ancestor, 'hidden') === undefined
          )
            return link.backendNodeId;
          ancestor = byNodeId.get(ancestor.parentId ?? 0);
        }
      }
      throw new Error(`missing visible footnote link ${label}`);
    };
    const click = async (backendNodeId: number, label: string) => {
      try {
        await sendFrame('DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const buttonBox = (await sendFrame('DOM.getBoxModel', {
          backendNodeId,
        })) as {
          model: { content: number[] };
        };
        const q = buttonBox.model.content;
        const x = (q[0]! + q[2]!) / 2;
        const y = (q[1]! + q[5]!) / 2;
        for (const type of ['mousePressed', 'mouseReleased'])
          await sendFrame('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
      } catch (error) {
        throw new Error(`Could not click ${label}`, { cause: error });
      }
    };
    const hasChapter = (current: DomNode[], chapter: number) =>
      current.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith(`Chapter ${chapter} of 3 ·`)
      );
    const noteIsOpen = (current: DomNode[]) =>
      current.some(
        (node) =>
          node.nodeName === 'ASIDE' &&
          attr(node, 'class') === 'panel' &&
          attr(node, 'hidden') === undefined
      );
    let expectedZoom = 1;
    const clickButton = async (label: string) => {
      await click(await button(label), `button ${label}`);
      if (label === 'Contents') {
        await waitForNodes(
          (current) =>
            current.some(
              (node) =>
                node.nodeName === 'DIV' &&
                attr(node, 'class') === 'panel' &&
                attr(node, 'hidden') === undefined
            ),
          'the contents panel'
        );
      } else if (label === 'Chapter Two' || label === 'Chapter Three') {
        const chapter = label === 'Chapter Two' ? 2 : 3;
        await waitForNodes((current) => hasChapter(current, chapter), label);
      } else if (label === 'A+' || label === 'A−') {
        expectedZoom = Math.min(
          1.5,
          Math.max(
            0.9,
            Math.round((expectedZoom + (label === 'A+' ? 0.1 : -0.1)) * 10) / 10
          )
        );
        await waitForNodes((current) => {
          const root = current.find(
            (node) => attr(node, 'id') === 'relic-document'
          );
          const match = /(?:^|;)\s*zoom:\s*([\d.]+)/.exec(
            root ? (attr(root, 'style') ?? '') : ''
          );
          return Math.abs(Number(match?.[1] ?? '1') - expectedZoom) < 0.001;
        }, `text size ${expectedZoom}`);
      }
    };
    const clickId = async (id: string) => {
      await click(await byId(id), `element ${id}`);
      if (id === 'ep-0-noteref')
        await waitForNodes(noteIsOpen, 'the open footnote');
      if (id === 'ep-0-jump')
        await waitForNodes((current) => hasChapter(current, 2), 'chapter two');
    };
    const clickNoteLink = async (label: string) => {
      await click(await noteLink(label), `footnote link ${label}`);
      if (label === 'Return to chapter')
        await waitForNodes((current) => hasChapter(current, 1), 'chapter one');
    };
    await clickId('ep-0-noteref');
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === 'ASIDE' &&
          attr(node, 'class') === 'panel' &&
          attr(node, 'hidden') === undefined
      ),
      'footnote did not open before navigation'
    );
    const noteContent = all.find(
      (node) => attr(node, 'class') === 'note-content'
    );
    assert.ok(noteContent);
    const noteObject = (await sendFrame('DOM.resolveNode', {
      backendNodeId: noteContent.backendNodeId,
    })) as { object: { objectId: string } };
    const noteContainment = (await sendFrame('Runtime.callFunctionOn', {
      objectId: noteObject.object.objectId,
      functionDeclaration: 'function(){return getComputedStyle(this).contain}',
      returnByValue: true,
    })) as { result: { value?: string } };
    assert.ok(noteContainment.result.value?.includes('paint'));
    await clickButton('Contents');
    await clickButton('Chapter Two');
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 2 of 3 ·')
      ),
      'contents did not navigate'
    );
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === 'ASIDE' &&
          attr(node, 'class') === 'panel' &&
          attr(node, 'hidden') !== undefined
      ),
      'footnote remained visible after chapter navigation'
    );
    const chapterNode = await byId('ep-1-target');
    const chapterObject = (await sendFrame('DOM.resolveNode', {
      backendNodeId: chapterNode,
    })) as { object: { objectId: string } };
    const chapterTop = async (): Promise<number> => {
      const result = (await sendFrame('Runtime.callFunctionOn', {
        objectId: chapterObject.object.objectId,
        functionDeclaration:
          'function(){return this.getBoundingClientRect().top}',
        returnByValue: true,
      })) as { result: { value?: number } };
      assert.equal(typeof result.result.value, 'number');
      return result.result.value!;
    };
    const beforeZoom = await chapterTop();
    for (let i = 0; i < 5; i++) await clickButton('A+');
    const afterZoom = await chapterTop();
    assert.ok(
      Math.abs(afterZoom - beforeZoom) < 40,
      `zoom moved the reading position from ${beforeZoom} to ${afterZoom}`
    );
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 2 of 3 ·')
      ),
      'chapter label went stale after zoom'
    );
    for (let i = 0; i < 5; i++) await clickButton('A−');
    const afterShrink = await chapterTop();
    assert.ok(
      Math.abs(afterShrink - beforeZoom) < 40,
      `shrinking text moved the reading position from ${beforeZoom} to ${afterShrink}`
    );
    await clickButton('Contents');
    await clickButton('Chapter Three');
    const textChapter = await byId('ep-2-start');
    const textObject = (await sendFrame('DOM.resolveNode', {
      backendNodeId: textChapter,
    })) as { object: { objectId: string } };
    const textTop = async (): Promise<number> => {
      const result = (await sendFrame('Runtime.callFunctionOn', {
        objectId: textObject.object.objectId,
        functionDeclaration:
          'function(){return this.getBoundingClientRect().top}',
        returnByValue: true,
      })) as { result: { value?: number } };
      assert.equal(typeof result.result.value, 'number');
      return result.result.value!;
    };
    const headingNode = await byId('ep-2-heading');
    const headingObject = (await sendFrame('DOM.resolveNode', {
      backendNodeId: headingNode,
    })) as { object: { objectId: string } };
    const headingGeometry = async () => {
      const result = (await sendFrame('Runtime.callFunctionOn', {
        objectId: headingObject.object.objectId,
        functionDeclaration:
          'function(){const text=this.firstChild;const whole=this.ownerDocument.createRange();whole.selectNodeContents(this);const first=this.ownerDocument.createRange();first.setStart(text,0);first.setEnd(text,3);return {top:this.getBoundingClientRect().top,firstTop:first.getBoundingClientRect().top,lines:whole.getClientRects().length}}',
        returnByValue: true,
      })) as {
        result: { value?: { top: number; firstTop: number; lines: number } };
      };
      assert.ok(result.result.value);
      return result.result.value;
    };
    const headingBefore = await headingGeometry();
    const textBefore = await textTop();
    for (let i = 0; i < 5; i++) await clickButton('A+');
    const textAfter = await textTop();
    const headingAfter = await headingGeometry();
    assert.ok(
      headingAfter.firstTop >= -1 &&
        Math.abs(headingAfter.top - headingBefore.top) < 4,
      `zoom clipped the chapter heading: ${JSON.stringify({ headingBefore, headingAfter })}`
    );
    if (width < 600)
      assert.ok(headingAfter.lines >= 2, 'mobile heading fixture did not wrap');
    assert.ok(
      Math.abs(textAfter - textBefore) < 40,
      `zoom moved the text chapter from ${textBefore} to ${textAfter}`
    );
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 3 of 3 ·')
      ),
      'text chapter label went stale after zoom'
    );
    for (let i = 0; i < 5; i++) await clickButton('A−');
    const textAfterShrink = await textTop();
    assert.ok(
      Math.abs(textAfterShrink - textBefore) < 40,
      `shrinking moved the text chapter from ${textBefore} to ${textAfterShrink}`
    );
    await clickButton('A+');
    all = await nodes();
    const documentRoot = all.find(
      (node) => attr(node, 'id') === 'relic-document'
    );
    assert.ok(documentRoot);
    const rootObject = (await sendFrame('DOM.resolveNode', {
      backendNodeId: documentRoot.backendNodeId,
    })) as { object: { objectId: string } };
    const rootIsolation = (await sendFrame('Runtime.callFunctionOn', {
      objectId: rootObject.object.objectId,
      functionDeclaration:
        'function(){return getComputedStyle(this).isolation}',
      returnByValue: true,
    })) as { result: { value?: string } };
    assert.equal(rootIsolation.result.value, 'isolate');
    assert.match(
      documentRoot ? (attr(documentRoot, 'style') ?? '') : '',
      /zoom:\s*1\.1/,
      'text size did not change'
    );
    await clickId('ep-0-jump');
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 2 of 3 ·')
      ),
      'internal link did not navigate'
    );
    await clickId('ep-0-noteref');
    all = await nodes();
    assert.ok(
      all.some(
        (node) => node.nodeName === '#text' && node.nodeValue === 'Close'
      ),
      'footnote did not open'
    );
    await clickNoteLink('Return to chapter');
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 1 of 3 ·')
      ),
      'footnote return link did not navigate'
    );
    await clickId('ep-0-noteref');
    await send('Runtime.evaluate', {
      expression:
        "window.__epubLinks=[];window.__epubPoints=0;window.addEventListener('message',e=>{if(e.data?.type==='relic:open-link')window.__epubLinks.push(e.data.href);if(e.data?.type==='relic:frame-point')window.__epubPoints++})",
    });
    const setPointing = async (armed: boolean) => {
      await send('Runtime.evaluate', {
        expression: `document.querySelector('iframe.usercontent-frame').contentWindow.postMessage({type:'relic:arm-pointing',armed:${armed}},'*')`,
      });
      for (let i = 0; i < 100; i++) {
        const current = await nodes();
        const active = current.some(
          (node) =>
            node.nodeName === 'HTML' &&
            (attr(node, 'class') ?? '')
              .split(/\s+/)
              .includes('relic-pointing-active')
        );
        if (active === armed) return;
        await Bun.sleep(10);
      }
      throw new Error(`pointing mode did not become ${armed}`);
    };
    await setPointing(true);
    await clickNoteLink('Read more');
    await waitForParent('window.__epubPoints > 0', 'the pointing event');
    const whilePointing = (await send('Runtime.evaluate', {
      expression: 'window.__epubLinks',
      returnByValue: true,
    })) as { result: { value?: string[] } };
    assert.deepEqual(whilePointing.result.value, []);
    await setPointing(false);
    await clickNoteLink('Read more');
    await waitForParent(
      'window.__epubLinks.length === 1',
      'the external link request'
    );
    const observed = (await send('Runtime.evaluate', {
      expression: 'window.__epubLinks',
      returnByValue: true,
    })) as { result: { value?: string[] } };
    assert.deepEqual(observed.result.value, ['https://example.com/']);
    assert.deepEqual(
      requests.filter(
        (request) =>
          !request.startsWith(origin) &&
          !request.startsWith(usercontentOrigin) &&
          !request.startsWith('blob:') &&
          !request.startsWith('data:') &&
          request !== 'about:blank'
      ),
      []
    );
    console.log(
      `EPUB_VIEWER ${width}x${height} frame=${box.model.width}x${box.model.height} target=${frameSession === session ? 'in-process' : 'oopif'}`
    );
  } finally {
    stopEvents();
    cdp.dispose();
    child.kill();
    await rm(profile, { recursive: true, force: true });
  }
}
try {
  for (const version of [2, 3] as const) {
    const url = await publish(version);
    await prove(url, 1440, 900, version === 2);
    await prove(url, 390, 844, version === 2);
  }
  console.log('EPUB_VIEWER_PATH_OK');
} finally {
  service.stop(true);
  usercontent.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
