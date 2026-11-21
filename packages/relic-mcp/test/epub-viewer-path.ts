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
      ? '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter#start">Chapter One</a></li><li><a href="second#target">Chapter Two</a></li></ol></nav></body></html>'
      : '<ncx><navMap><navPoint><navLabel><text>Chapter One</text></navLabel><content src="chapter#start"/></navPoint><navPoint><navLabel><text>Chapter Two</text></navLabel><content src="second#target"/></navPoint></navMap></ncx>';
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
      `<package><metadata><title>Viewer proof ${version}</title></metadata><manifest><item id="c" href="chapter" media-type="application/xhtml+xml"/><item id="c2" href="second" media-type="image/svg+xml"/><item id="nav" href="contents" media-type="${navType}"${navProps}/><item id="cover" href="cover" media-type="image/svg+xml"/><item id="style" href="style" media-type="text/css"/><item id="base" href="base.css" media-type="text/css"/></manifest><spine toc="nav"><itemref idref="c"/><itemref idref="c2"/></spine></package>`,
    ],
    ['OPS/contents', nav],
    [
      'OPS/style',
      '@import "base.css" layer(book) supports(display: grid) screen and (min-width: 300px);',
    ],
    ['OPS/base.css', 'body#start{background-color:rgb(7, 8, 9)}'],
    [
      'OPS/chapter',
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><link rel="stylesheet" href="style"/><style>body#start{color:rgb(1, 2, 3)}</style></head><body id="start"><h1>Readable EPUB chapter</h1><p>Unique annotation sentence.</p><a id="jump" href="second#target">Go to chapter two</a><p>Note <a id="noteref" epub:type="noteref" href="#footnote">1</a></p><aside id="footnote">The footnote <a href="#start">Return to chapter</a> <a href="https://example.com/">Read more</a></aside><img id="art" src="cover"/>${'<p>Reader text.</p>'.repeat(90)}</body></html>`,
    ],
    [
      'OPS/second',
      '<svg xmlns="http://www.w3.org/2000/svg" id="target" viewBox="0 0 600 600" width="100%" height="500"><text x="10" y="30">Chapter Two Heading</text><rect width="100" height="100" fill="blue"/></svg>',
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
  assert.ok(url?.includes('#'), 'missing encrypted viewer URL');
  return url;
}
type DomNode = {
  nodeId: number;
  parentId?: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
};
async function prove(
  url: string,
  width: number,
  height: number
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
    cdp.onEvent((event) => {
      if (
        event.sessionId === session &&
        event.method === 'Network.requestWillBeSent'
      ) {
        const request = event.params['request'] as { url?: string };
        if (request.url) requests.push(request.url);
      }
    });
    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId: session,
      timeoutMs: 30000,
    });
    const navigation = await send('Page.navigate', { url });
    assert.equal(navigation['errorText'], undefined);
    await loaded;
    const nodes = async () =>
      (await send('DOM.getFlattenedDocument', { depth: -1, pierce: true }))[
        'nodes'
      ] as DomNode[];
    const attr = (node: DomNode, name: string) => {
      const attrs = node.attributes ?? [];
      const i = attrs.indexOf(name);
      return i < 0 ? undefined : attrs[i + 1];
    };
    let all: DomNode[] = [];
    for (let i = 0; i < 200; i++) {
      all = await nodes();
      if (all.some((node) => node.nodeValue === 'Readable EPUB chapter')) break;
      await Bun.sleep(50);
    }
    assert.ok(
      all.some((node) => node.nodeValue === 'Readable EPUB chapter'),
      'EPUB did not render through viewer'
    );
    const frame = all.find(
      (node) =>
        node.nodeName === 'IFRAME' &&
        (attr(node, 'class') ?? '').includes('usercontent-frame')
    );
    assert.ok(frame, 'viewer did not mount a usercontent frame');
    const box = (await send('DOM.getBoxModel', { nodeId: frame.nodeId })) as {
      model: { width: number; height: number };
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
    const artObject = (await send('DOM.resolveNode', {
      nodeId: art.nodeId,
    })) as { object: { objectId: string } };
    let decoded = false;
    for (let i = 0; i < 100; i++) {
      const status = (await send('Runtime.callFunctionOn', {
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
    const targetNode = all.find((node) => attr(node, 'id') === 'ep-0-start');
    assert.ok(targetNode, 'body fragment missing');
    const resolved = (await send('DOM.resolveNode', {
      nodeId: targetNode.nodeId,
    })) as { object: { objectId: string } };
    const color = (await send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: 'function(){return getComputedStyle(this).color}',
      returnByValue: true,
    })) as { result: { value?: string } };
    const shellBackgrounds = (await send('Runtime.callFunctionOn', {
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
    const background = (await send('Runtime.callFunctionOn', {
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
      assert.ok(text?.parentId, `missing button ${label}`);
      return text.parentId;
    };
    const byId = async (id: string) => {
      const node = (await nodes()).find((item) => attr(item, 'id') === id);
      assert.ok(node, `missing ${id}`);
      return node.nodeId;
    };
    const click = async (nodeId: number) => {
      await send('DOM.scrollIntoViewIfNeeded', { nodeId });
      const buttonBox = (await send('DOM.getBoxModel', { nodeId })) as {
        model: { content: number[] };
      };
      const q = buttonBox.model.content;
      const x = (q[0]! + q[2]!) / 2;
      const y = (q[1]! + q[5]!) / 2;
      for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
    };
    await click(await button('Contents'));
    await click(await button('Chapter Two'));
    await Bun.sleep(100);
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 2 of 2 ·')
      ),
      'contents did not navigate'
    );
    await click(await button('A+'));
    all = await nodes();
    const documentRoot = all.find(
      (node) => attr(node, 'id') === 'relic-document'
    );
    assert.match(
      documentRoot ? (attr(documentRoot, 'style') ?? '') : '',
      /zoom:\s*1\.1/,
      'text size did not change'
    );
    await click(await byId('ep-0-jump'));
    await Bun.sleep(100);
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 2 of 2 ·')
      ),
      'internal link did not navigate'
    );
    await click(await byId('ep-0-noteref'));
    all = await nodes();
    assert.ok(
      all.some(
        (node) => node.nodeName === '#text' && node.nodeValue === 'Close'
      ),
      'footnote did not open'
    );
    const returnLink = all
      .filter(
        (node) =>
          node.nodeName === '#text' && node.nodeValue === 'Return to chapter'
      )
      .at(-1);
    assert.ok(returnLink?.parentId, 'footnote return link missing');
    await click(returnLink.parentId);
    await Bun.sleep(100);
    all = await nodes();
    assert.ok(
      all.some(
        (node) =>
          node.nodeName === '#text' &&
          node.nodeValue.startsWith('Chapter 1 of 2 ·')
      ),
      'footnote return link did not navigate'
    );
    await click(await byId('ep-0-noteref'));
    await send('Runtime.evaluate', {
      expression:
        "window.__epubLinks=[];window.addEventListener('message',e=>{if(e.data?.type==='relic:open-link')window.__epubLinks.push(e.data.href)})",
    });
    all = await nodes();
    const externalLink = all
      .filter(
        (node) => node.nodeName === '#text' && node.nodeValue === 'Read more'
      )
      .at(-1);
    assert.ok(externalLink?.parentId, 'footnote external link missing');
    await click(externalLink.parentId);
    await Bun.sleep(100);
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
      `EPUB_VIEWER ${width}x${height} frame=${box.model.width}x${box.model.height}`
    );
  } finally {
    cdp.dispose();
    child.kill();
    await rm(profile, { recursive: true, force: true });
  }
}
try {
  for (const version of [2, 3] as const) {
    const url = await publish(version);
    await prove(url, 1440, 900);
    await prove(url, 390, 844);
  }
  console.log('EPUB_VIEWER_PATH_OK');
} finally {
  service.stop(true);
  usercontent.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
