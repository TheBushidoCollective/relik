import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
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

const repo = new URL('../../../', import.meta.url).pathname;
const moduleText = await Bun.file(
  join(repo, 'packages/relic-viewer/dist-frame/frame-epub.frame.js')
).text();
const chrome = await discoverChrome(process.env['RELIC_CHROME_PATH']);
if (chrome.kind !== 'found')
  throw new Error(`No owned headless Chrome: ${chrome.kind}`);
let app: { fetch(request: Request): Promise<Response> };
let contentOrigin = '';
const site = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== '/')
      return new Response('not found', { status: 404 });
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="reader" sandbox="allow-scripts" src="${contentOrigin}/sandbox.html" style="width:100vw;height:100vh;border:0"></iframe><script>
window.states=[];const module=${JSON.stringify(moduleText).replaceAll('<', '\\u003c')};const enc=new TextEncoder();const prose=Array.from({length:80},(_,i)=>'<p>Paragraph '+i+' with enough text to make the chapter scroll.</p>').join('');
const entries=[['one.xhtml',enc.encode('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><h1>Chapter One</h1><a id="jump" href="two.xhtml#target">Jump to chapter two</a><p>A note <a id="note-link" epub:type="noteref" href="#note">1</a></p><aside id="note">The footnote text</aside>'+prose+'</body></html>')],['two.xhtml',enc.encode('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="target">Chapter Two</h1><p>Unique annotation sentence.</p>'+prose+'</body></html>')]];
const book={title:'Proof book',progression:'default',layout:'reflowable',resources:[{path:'one.xhtml',mediaType:'application/xhtml+xml'},{path:'two.xhtml',mediaType:'application/xhtml+xml'}],spine:[{path:'one.xhtml',linear:true},{path:'two.xhtml',linear:true}],toc:[{label:'Chapter One',path:'one.xhtml',depth:0},{label:'Chapter Two',path:'two.xhtml',fragment:'target',depth:0}],pageList:[]};
addEventListener('message',e=>{if(e.source!==document.querySelector('#reader').contentWindow)return;states.push(e.data);if(e.data.type==='relic:sandbox-ready')e.source.postMessage({type:'relic:render-document',format:'epub',module,entries,book},'*')});</script></body>`;
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});
const content = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => app.fetch(request),
});
contentOrigin = `http://127.0.0.1:${content.port}`;
const origin = `http://127.0.0.1:${site.port}`;
app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin: contentOrigin },
  store: new MemoryStore(),
  storage: new MemoryStorage(`${origin}/storage`),
  assets: diskAssets(join(repo, 'packages/relic-viewer/dist')),
});
const profile = await mkdtemp(join(tmpdir(), 'relic-epub-frame-'));
const launch = createBrowserHeadlessLaunch(
  chromeArgs(chrome.path, profile)
    .filter((arg) => !arg.startsWith('--proxy-'))
    .map((arg) =>
      arg === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : arg
    ),
  profile
);
const child = spawn(chrome.path, launch.args, {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
});
const cdp = connectPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
type Node = {
  nodeId: number;
  parentId?: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
};
try {
  await attestBrowserHeadless(cdp, launch);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target['targetId'],
    flatten: true,
  });
  const session = attached['sessionId'] as string;
  await cdp.send('Page.enable', {}, session);
  await cdp.send('Runtime.enable', {}, session);
  await cdp.send('DOM.enable', {}, session);
  await cdp.send('Network.enable', {}, session);
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
  await cdp.send('Page.navigate', { url: origin }, session);
  await loaded;
  const evaluate = async (expression: string) =>
    (
      await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        session
      )
    )['result'] as { value?: unknown };
  for (let i = 0; i < 100; i++) {
    if (
      (
        await evaluate(
          "window.states?.some(s=>s.type==='relic:document-state'&&s.state==='ready')"
        )
      ).value
    )
      break;
    await Bun.sleep(50);
  }
  assert.equal(
    (
      await evaluate(
        "window.states?.some(s=>s.type==='relic:document-state'&&s.state==='ready')"
      )
    ).value,
    true
  );
  const nodes = async () =>
    (
      await cdp.send(
        'DOM.getFlattenedDocument',
        { depth: -1, pierce: true },
        session
      )
    )['nodes'] as Node[];
  const getAttribute = (node: Node, name: string) => {
    const attrs = node.attributes ?? [];
    const i = attrs.indexOf(name);
    return i < 0 ? undefined : attrs[i + 1];
  };
  const named = async (name: string) => {
    const all = await nodes();
    const text = all.find(
      (n) =>
        n.nodeName === '#text' &&
        n.nodeValue === name &&
        all.find((p) => p.nodeId === n.parentId)?.nodeName === 'BUTTON'
    );
    assert.ok(text?.parentId, `Missing button ${name}`);
    return text.parentId;
  };
  const byId = async (id: string) => {
    const found = (await nodes()).find((n) => getAttribute(n, 'id') === id);
    assert.ok(found, `Missing ${id}`);
    return found;
  };
  const click = async (id: number) => {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId: id }, session);
    const { model } = (await cdp.send(
      'DOM.getBoxModel',
      { nodeId: id },
      session
    )) as { model: { content: number[] } };
    const q = model.content;
    const x = (q[0]! + q[2]!) / 2;
    const y = (q[1]! + q[5]!) / 2;
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type, x, y, button: 'left', clickCount: 1 },
        session
      );
  };
  assert.ok((await nodes()).some((n) => n.nodeValue === 'Chapter 1 of 2 · 0%'));
  await click(await named('Contents'));
  await click(await named('Chapter Two'));
  await Bun.sleep(100);
  assert.ok(
    (await nodes()).some((n) => n.nodeValue.startsWith('Chapter 2 of 2 ·'))
  );
  await click(await named('A+'));
  assert.match(
    getAttribute(await byId('relic-document'), 'style') ?? '',
    /zoom:\s*1\.1/
  );
  await click((await byId('ep-0-jump')).nodeId);
  await Bun.sleep(100);
  assert.ok(
    (await nodes()).some((n) => n.nodeValue.startsWith('Chapter 2 of 2 ·'))
  );
  await click((await byId('ep-0-note-link')).nodeId);
  assert.ok((await nodes()).some((n) => n.nodeValue === 'Close'));
  await click(await named('Close'));
  assert.ok(
    (await nodes()).some(
      (n) =>
        n.nodeName === 'ASIDE' &&
        getAttribute(n, 'class') === 'panel' &&
        getAttribute(n, 'hidden') !== undefined
    )
  );
  await evaluate(
    "document.querySelector('#reader').contentWindow.postMessage({type:'relic:paint-mark',mark:{id:'proof-mark',kind:'quote',exact:'Unique annotation sentence.'}},'*')"
  );
  await Bun.sleep(100);
  assert.ok(
    (await nodes()).some(
      (n) =>
        n.nodeName === 'MARK' &&
        getAttribute(n, 'data-comment-id') === 'proof-mark'
    )
  );
  assert.deepEqual(
    requests.filter(
      (url) =>
        !url.startsWith(origin) &&
        !url.startsWith(contentOrigin) &&
        !url.startsWith('blob:')
    ),
    []
  );
  console.log('EPUB_FRAME_PATH_OK');
} finally {
  cdp.dispose();
  child.kill();
  site.stop(true);
  content.stop(true);
  await rm(profile, { recursive: true, force: true });
}
