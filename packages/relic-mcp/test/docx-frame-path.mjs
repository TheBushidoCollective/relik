import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { Document, Packer, Paragraph, ImageRun, Table, TableRow, TableCell } from '../../relic-viewer/node_modules/docx/dist/index.mjs';
import JSZip from '../../relic-viewer/node_modules/jszip/lib/index.js';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs } from '../src/cover/chrome.ts';
import { attestBrowserHeadless, createBrowserHeadlessLaunch } from './browser-headless.ts';

const root = new URL('../../../', import.meta.url).pathname;
const chrome = process.env.RELIC_CHROME_PATH;
if (!chrome) throw new Error('Set RELIC_CHROME_PATH to the owned headless shell');
const moduleText = await Bun.file(`${root}packages/relic-viewer/dist-frame/frame-docx.frame.js`).text();
const hostBuild = await Bun.build({ entrypoints: [`${root}packages/relic-viewer/test/docx-frame-proof-host.ts`], target: 'browser', format: 'esm' });
if (!hostBuild.success) throw new Error('DOCX proof host build failed');
const hostScript = await hostBuild.outputs[0].text();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function packageEntries(children) {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(new Document({ sections: [{ children }] })));
  return Promise.all(Object.values(zip.files).filter((entry) => !entry.dir).map(async (entry) => [entry.name, Array.from(await entry.async('uint8array'))]));
}
const imageEntries = await packageEntries([new Paragraph({ children: [new ImageRun({ data: png, type: 'png', transformation: { width: 20, height: 20 } })] }), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('DOCX table cell')] })] })] })]);
const largeEntries = await packageEntries(Array.from({ length: 300 }, (_, i) => new Paragraph({ text: `Page ${i + 1}`, pageBreakBefore: i > 0 })));
const decode = new TextDecoder();
const encode = new TextEncoder();
function entriesFor(kind) {
  if (kind === 'large') return largeEntries;
  return (kind === 'links' ? largeEntries : imageEntries).map(([name, bytes]) => {
    if (name !== 'word/document.xml' && name !== 'word/_rels/document.xml.rels' && name !== '[Content_Types].xml') return [name, bytes];
    let text = decode.decode(new Uint8Array(bytes));
    if (['emf', 'wmf'].includes(kind) && name === '[Content_Types].xml') text = text.replace('ContentType="image/png" Extension="png"', `ContentType="image/x-${kind}" Extension="png"`);
    if (kind === 'links' && name.endsWith('.rels')) text = text.replace('</Relationships>', '<Relationship Id="rIdSafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/document" TargetMode="External"/></Relationships>');
    if (kind === 'links' && name === 'word/document.xml') {
      text = text.replace('<w:body>', '<w:body><w:p><w:hyperlink r:id="rIdSafe"><w:r><w:t>External link</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="target"><w:r><w:t>Go to bookmark</w:t></w:r></w:hyperlink></w:p>');
      text = text.replace('</w:body>', '<w:p><w:bookmarkStart w:id="42" w:name="target"/><w:r><w:t>Bookmark destination</w:t></w:r><w:bookmarkEnd w:id="42"/></w:p></w:body>');
    }
    return [name, Array.from(encode.encode(text))];
  });
}
let app;
let usercontentOrigin = '';
const service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  if (new URL(request.url).pathname === '/proof-host.js') return new Response(hostScript, { headers: { 'content-type': 'text/javascript' } });
  const entries = entriesFor(new URL(request.url).searchParams.get('kind'));
  return new Response(`<!doctype html><style>body{margin:0}iframe{border:0;width:100%;height:850px}</style><iframe src="${usercontentOrigin}/sandbox.html" sandbox="allow-scripts"></iframe><script>window.results=[];addEventListener('message',e=>results.push(e.data));window.begin=()=>document.querySelector('iframe').contentWindow.postMessage({type:'relic:render-document',format:'docx',module:${JSON.stringify(moduleText)},entries:${JSON.stringify(entries)}.map(([p,b])=>[p,new Uint8Array(b)])},'*')</script><script type="module" src="/proof-host.js"></script>`, { headers: { 'content-type': 'text/html' } });
} });
const usercontent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
const origin = `http://127.0.0.1:${service.port}`;
usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
app = createApp({ config: { serviceOrigin: origin, usercontentOrigin }, store: new MemoryStore(), storage: new MemoryStorage(`${origin}/storage`), assets: diskAssets(`${root}packages/relic-viewer/dist`) });
const profile = await mkdtemp(join(tmpdir(), 'relic-docx-frame-'));
const args = chromeArgs(chrome, profile).filter((arg) => !arg.startsWith('--proxy-')).map((arg) => arg === '--host-resolver-rules=MAP * ~NOTFOUND' ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1' : arg);
const launch = createBrowserHeadlessLaunch(args, profile);
const child = spawn(chrome, launch.args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' } });
const cdp = connectPipe(child.stdio[3], child.stdio[4]);
try {
  await attestBrowserHeadless(cdp, launch);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  const requests = [];
  const off = cdp.onEvent((event) => { if (event.sessionId === sessionId && event.method === 'Network.requestWillBeSent') requests.push(event.params.request.url); });
  async function evaluate(expression, contextId) {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId === undefined ? {} : { contextId }) }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  for (const kind of ['embedded', 'emf', 'wmf', 'large', 'links']) {
    requests.length = 0;
    const loaded = cdp.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs: 30000 });
    await cdp.send('Page.navigate', { url: `${origin}/?kind=${kind}` }, sessionId);
    await loaded;
    await evaluate(`(async()=>{while(!window.results.some(x=>x.type==='relic:sandbox-ready')) await new Promise(r=>setTimeout(r,10));return true})()`);
    const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const childFrame = tree.frameTree.childFrames[0].frame.id;
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: childFrame, worldName: 'docx-proof' }, sessionId);
    await evaluate(`window.violations=[];document.addEventListener('securitypolicyviolation',e=>window.violations.push(e.violatedDirective));true`, executionContextId);
    const start = performance.now();
    await evaluate('window.begin();true');
    const state = await evaluate(`(async()=>{const end=Date.now()+30000;while(Date.now()<end){let x=window.results.find(x=>x.type==='relic:document-state');if(x)return x;await new Promise(r=>setTimeout(r,10))}throw Error('document timeout')})()`);
    const elapsed = performance.now() - start;
    const frame = await evaluate(`({violations:window.violations,text:document.body.innerText,pages:document.querySelectorAll('.docx-wrapper>section.docx').length,elements:document.getElementsByTagName('*').length,images:[...document.images].map(x=>x.getAttribute('src'))})`, executionContextId);
    assert.equal(state.state, 'ready', kind);
    assert.deepEqual(frame.violations, [], kind);
    assert.equal(requests.filter((url) => !url.startsWith(origin) && !url.startsWith(usercontentOrigin) && !url.startsWith('blob:') && !url.startsWith('data:')).length, 0, kind);
    assert.equal(requests.filter((url) => url.startsWith(usercontentOrigin) && url !== `${usercontentOrigin}/sandbox.html`).length, 0, kind);
    if (kind === 'embedded') {
      const imagePoint = await evaluate(`(async()=>{for(let i=0;i<100;i++){let img=document.querySelector('#relic-document img'),b=img?.getBoundingClientRect();if(b&&b.width&&b.height&&document.querySelector('.relic-image-control'))return {x:b.x+b.width/2,y:b.y+b.height/2};await new Promise(r=>setTimeout(r,10))}throw Error('image control unavailable')})()`, executionContextId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: imagePoint.x, y: imagePoint.y }, sessionId);
      const button = await evaluate(`(async()=>{for(let i=0;i<100;i++){let b=document.querySelector('.relic-image-control.is-shown');if(b){let r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}await new Promise(r=>setTimeout(r,10))}throw Error('image control not shown')})()`, executionContextId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y, button: 'left', clickCount: 1 }, sessionId);
      const imageComment = await evaluate(`(async()=>{for(let i=0;i<100;i++){let x=window.results.find(x=>x.type==='relic:frame-image');if(x)return x;await new Promise(r=>setTimeout(r,10))}return null})()`);
      assert.equal(imageComment?.anchor?.kind, 'image');
    }
    if (kind === 'embedded') assert.match(frame.text, /DOCX table cell/);
    if (kind === 'embedded') assert.match(frame.images[0], /^data:image\/png/);
    if (kind === 'emf' || kind === 'wmf') assert.match(frame.text, /Unsupported EMF or WMF image/);
    if (kind === 'large') {
      assert.equal(frame.pages, 300);
      for (const width of [390, 1440]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
        await evaluate(`new Promise(r=>setTimeout(r,100))`);
        const size = await evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})`, executionContextId);
        assert.ok(size.scroll <= size.width, `frame overflow at ${width}: ${JSON.stringify(size)}`);
        const parentSize = await evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})`);
        assert.ok(parentSize.scroll <= parentSize.width, `host overflow at ${width}: ${JSON.stringify(parentSize)}`);
      }
    }
    if (kind === 'links') {
      const links = await evaluate(`[...document.querySelectorAll('#relic-document a')].map(a=>({text:a.textContent,href:a.getAttribute('href')}))`, executionContextId);
      assert.equal(links.find((x) => x.text === 'Go to bookmark')?.href, '#target');
      async function clickLink(text) {
        const point = await evaluate(`(()=>{const a=[...document.querySelectorAll('#relic-document a')].find(x=>x.textContent===${JSON.stringify(text)});a.scrollIntoView({block:'center'});const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, executionContextId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
      }
      await clickLink('External link');
      const linkRequest = await evaluate(`(async()=>{for(let i=0;i<100;i++){let x=window.results.find(x=>x.type==='relic:open-link');if(x)return x;await new Promise(r=>setTimeout(r,10))}return null})()`);
      assert.equal(linkRequest?.href, 'https://example.invalid/document');
      const bar = await evaluate(`(async()=>{for(let i=0;i<100;i++){const el=document.querySelector('.link-confirm');if(el&&!el.hidden)return {text:el.textContent,hidden:el.hidden};await new Promise(r=>setTimeout(r,10))}return null})()`);
      assert.ok(bar && !bar.hidden && bar.text.includes('example.invalid'), 'link confirmation bar did not open');
      const cancel = await evaluate(`(()=>{const b=[...document.querySelectorAll('.link-confirm button')].find(x=>x.textContent==='Cancel');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cancel.x, y: cancel.y, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cancel.x, y: cancel.y, button: 'left', clickCount: 1 }, sessionId);
      await clickLink('Go to bookmark');
      const scrolled = await evaluate(`(async()=>{for(let i=0;i<100;i++){if(scrollY>500)return scrollY;await new Promise(r=>setTimeout(r,10))}return scrollY})()`, executionContextId);
      assert.ok(scrolled > 500, `bookmark did not scroll: ${scrolled}`);
    }
    console.log(`DOCX_FRAME ${kind} ready_ms=${elapsed.toFixed(1)} elements=${frame.elements} pages=${frame.pages} violations=${frame.violations.length}`);
  }
  off();
  console.log('DOCX_FRAME_PATH_OK');
} finally {
  cdp.dispose();
  child.kill();
  service.stop(true);
  usercontent.stop(true);
  await rm(profile, { recursive: true, force: true });
}
