import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { Document, Packer, Paragraph, TextRun, ImageRun, Header, FootnoteReferenceRun, EndnoteReferenceRun, Table, TableRow, TableCell } from '../../relic-viewer/node_modules/docx/dist/index.mjs';
import JSZip from '../../relic-viewer/node_modules/jszip/lib/index.js';
import { LINK_COOLDOWN_MS } from '../../relic-viewer/src/open-link-confirm.ts';
import { connectPipe } from '../src/cover/cdp.ts';
import { nodeFiles } from '../src/files.ts';
import { publish } from '../src/publish.ts';
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
const notePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAA1BMVEUAAP+KeNJXAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==', 'base64');
const image = (data) => new ImageRun({ data, type: 'png', transformation: { width: 20, height: 20 } });
async function packageEntries(children, options = {}) {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(new Document({
    footnotes: options.footnotes,
    endnotes: options.endnotes,
    fonts: options.fonts,
    sections: [{ children, headers: options.headers }],
  })));
  return Promise.all(Object.values(zip.files).filter((entry) => !entry.dir).map(async (entry) => [entry.name, Array.from(await entry.async('uint8array'))]));
}
const fontBytes = Buffer.from(await Bun.file(`${root}packages/relic-viewer/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf`).arrayBuffer());
const fontEntries = await packageEntries(
  [new Paragraph({ children: [new TextRun({ text: 'Embedded font', font: 'DOCX Fixture' })] })],
  { fonts: [{ name: 'DOCX Fixture', data: fontBytes }] }
);
const imageEntries = await packageEntries([new Paragraph({ children: [image(png)] }), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('DOCX table cell')] })] })] })]);
const largeEntries = await packageEntries(
  Array.from({ length: 300 }, (_, i) => new Paragraph({
    children: i === 0
      ? [new TextRun('Page 1'), new FootnoteReferenceRun(1), new EndnoteReferenceRun(1)]
      : [new TextRun(`Page ${i + 1}`)],
    pageBreakBefore: i > 0,
  })),
  {
    headers: { default: new Header({ children: [new Paragraph({ children: [image(png)] })] }) },
    footnotes: { 1: { children: [new Paragraph({ children: [image(notePng)] })] } },
    endnotes: { 1: { children: [new Paragraph({ children: [image(notePng)] })] } },
  }
);
const decode = new TextDecoder();
const encode = new TextEncoder();
function metafile(kind) {
  if (kind === 'wmf') {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt16LE(1, 0);
    bytes.writeUInt16LE(9, 2);
    bytes.writeUInt16LE(0x300, 4);
    bytes.writeUInt32LE(12, 6);
    bytes.writeUInt32LE(3, 12);
    bytes.writeUInt32LE(3, 18);
    return bytes;
  }
  const bytes = Buffer.alloc(108);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(88, 4);
  bytes.writeUInt32LE(0x464d4520, 40);
  bytes.writeUInt32LE(0x10000, 44);
  bytes.writeUInt32LE(108, 48);
  bytes.writeUInt32LE(2, 52);
  bytes.writeUInt16LE(1, 56);
  for (const offset of [72, 76, 80, 84]) bytes.writeUInt32LE(1, offset);
  bytes.writeUInt32LE(14, 88);
  bytes.writeUInt32LE(20, 92);
  bytes.writeUInt32LE(20, 104);
  return bytes;
}
function entriesFor(kind) {
  if (kind === 'large') return largeEntries;
  const mediaPath = imageEntries.find(([name]) => name.startsWith('word/media/') && name.endsWith('.png'))?.[0];
  return (kind === 'links' ? largeEntries : kind === 'font' ? fontEntries : imageEntries).map(([name, bytes]) => {
    if (name === mediaPath && ['emf', 'wmf'].includes(kind)) return [name, Array.from(metafile(kind))];
    if (!['word/document.xml', 'word/_rels/document.xml.rels', 'word/header1.xml', 'word/_rels/header1.xml.rels', '[Content_Types].xml'].includes(name)) return [name, bytes];
    let text = decode.decode(new Uint8Array(bytes));
    if (['emf', 'wmf'].includes(kind) && name === '[Content_Types].xml') {
      assert.ok(mediaPath);
      text = text.replace('</Types>', `<Override PartName="/${mediaPath}" ContentType="image/x-${kind}"/></Types>`);
    }
    if (kind === 'links' && name.endsWith('.rels')) {
      const destination = name.includes('header1') ? 'header' : 'document';
      text = text.replace('</Relationships>', `<Relationship Id="rIdSafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/${destination}" TargetMode="External"/></Relationships>`);
    }
    if (kind === 'links' && name === 'word/header1.xml') {
      text = text.replace(/(<w:hdr\b[^>]*>)/, '$1<w:p><w:hyperlink r:id="rIdSafe"><w:r><w:t>Header link</w:t></w:r></w:hyperlink></w:p>');
    }
    if (kind === 'links' && name === 'word/document.xml') {
      text = text.replace('<w:body>', '<w:body><w:p><w:hyperlink r:id="rIdSafe"><w:r><w:t>External link</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="target"><w:r><w:t>Go to bookmark</w:t></w:r></w:hyperlink></w:p>');
      text = text.replace('</w:body>', '<w:p><w:bookmarkStart w:id="42" w:name="target"/><w:r><w:t>Bookmark destination</w:t></w:r><w:bookmarkEnd w:id="42"/></w:p></w:body>');
    }
    return [name, Array.from(encode.encode(text))];
  });
}
let app;
let storage;
let usercontentOrigin = '';
const service = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/proof-host.js') return new Response(hostScript, { headers: { 'content-type': 'text/javascript' } });
  if (url.pathname.startsWith('/__storage/o/')) {
    const bytes = await storage.read(url.pathname.slice('/__storage/o/'.length));
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  }
  if (url.pathname !== '/' || !url.searchParams.has('kind')) return app.fetch(request);
  const entries = entriesFor(url.searchParams.get('kind'));
  return new Response(`<!doctype html><style>body{margin:0}iframe{border:0;width:100%;height:850px}</style><iframe src="${usercontentOrigin}/sandbox.html" sandbox="allow-scripts"></iframe><script>window.results=[];addEventListener('message',e=>results.push(e.data));window.begin=()=>document.querySelector('iframe').contentWindow.postMessage({type:'relic:render-document',format:'docx',module:${JSON.stringify(moduleText)},entries:${JSON.stringify(entries)}.map(([p,b])=>[p,new Uint8Array(b)])},'*')</script><script type="module" src="/proof-host.js"></script>`, { headers: { 'content-type': 'text/html' } });
} });
const usercontent = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
const origin = `http://127.0.0.1:${service.port}`;
usercontentOrigin = `http://127.0.0.1:${usercontent.port}`;
storage = new MemoryStorage(`${origin}/__storage`);
app = createApp({ config: { serviceOrigin: origin, usercontentOrigin }, store: new MemoryStore(), storage, assets: diskAssets(`${root}packages/relic-viewer/dist`) });
const profile = await mkdtemp(join(tmpdir(), 'relic-docx-frame-'));
const priorPublishState = process.env.RELIC_PUBLISH_STATE;
process.env.RELIC_PUBLISH_STATE = join(profile, 'publish-state.json');
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
  for (const kind of ['embedded', 'font', 'emf', 'wmf', 'large', 'links']) {
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
    if (kind === 'font') {
      const font = await evaluate(`(async()=>{const loaded=await document.fonts.load('12px \"DOCX Fixture\"');return {count:loaded.length,status:loaded[0]?.status,css:[...document.querySelectorAll('style')].map(style=>style.textContent).join('\\n')}})()`, executionContextId);
      assert.equal(font.count, 1);
      assert.equal(font.status, 'loaded');
      assert.match(font.css, /data:/);
    }
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
    if (kind === 'embedded') {
      assert.match(frame.images[0], /^blob:/);
      const decoded = await evaluate(`(async()=>{const image=document.querySelector('#relic-document img');await image.decode();return [image.naturalWidth,image.naturalHeight]})()`, executionContextId);
      assert.deepEqual(decoded, [1, 1]);
    }
    if (kind === 'emf' || kind === 'wmf') assert.match(frame.text, /Unsupported EMF or WMF image/);
    if (kind === 'large') {
      assert.equal(frame.pages, 300);
      const scopedImages = await evaluate(`(async()=>{const headers=[...document.querySelectorAll('#relic-document header img')];const notes=[...document.querySelectorAll('#relic-document ol img')];await Promise.all([...headers,...notes].map(image=>image.decode()));return {headers:headers.map(image=>image.src),notes:notes.map(image=>({src:image.src,width:image.naturalWidth,height:image.naturalHeight}))}})()`, executionContextId);
      assert.equal(scopedImages.headers.length, 300);
      assert.equal(new Set(scopedImages.headers).size, 1);
      assert.equal(scopedImages.notes.length, 2);
      assert.ok(scopedImages.notes.every((image) => image.width === 2 && image.height === 1));
      assert.notEqual(scopedImages.notes[0].src, scopedImages.headers[0]);
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
      assert.equal(links.find((x) => x.text === 'External link')?.href, 'https://example.invalid/document');
      assert.equal(links.find((x) => x.text === 'Header link')?.href, 'https://example.invalid/header');
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
      await new Promise((resolve) => setTimeout(resolve, LINK_COOLDOWN_MS));
      await clickLink('Header link');
      const headerRequest = await evaluate(`(async()=>{for(let i=0;i<100;i++){let x=window.results.find(x=>x.type==='relic:open-link'&&x.href==='https://example.invalid/header');if(x)return x;await new Promise(r=>setTimeout(r,10))}return null})()`);
      assert.equal(headerRequest?.href, 'https://example.invalid/header');
      const headerBar = await evaluate(`(async()=>{for(let i=0;i<100;i++){const el=document.querySelector('.link-confirm');if(el&&!el.hidden&&el.textContent.includes('/header'))return el.textContent;await new Promise(r=>setTimeout(r,10))}return null})()`);
      assert.ok(headerBar?.includes('example.invalid'), 'header confirmation bar did not show its destination');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cancel.x, y: cancel.y, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cancel.x, y: cancel.y, button: 'left', clickCount: 1 }, sessionId);
      await clickLink('Go to bookmark');
      const scrolled = await evaluate(`(async()=>{for(let i=0;i<100;i++){if(scrollY>500)return scrollY;await new Promise(r=>setTimeout(r,10))}return scrollY})()`, executionContextId);
      assert.ok(scrolled > 500, `bookmark did not scroll: ${scrolled}`);
    }
    console.log(`DOCX_FRAME ${kind} ready_ms=${elapsed.toFixed(1)} elements=${frame.elements} pages=${frame.pages} violations=${frame.violations.length}`);
  }
  // Exercise the real reader using only an in-memory loopback service.
  const publishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    clientName: 'docx-reader-proof',
    files: nodeFiles,
    fetch: globalThis.fetch,
    renderCover: async () => ({ status: 'skipped', reason: 'browser_disabled', detail: 'test' }),
    upload: async (url, _headers, bytes) => {
      storage.put(new URL(url).pathname.replace(/^\/__storage\/upload\//, ''), bytes);
      return { status: 200 };
    },
  };
  async function publishEntries(filename, entries) {
    const zip = new JSZip();
    for (const [name, bytes] of entries) zip.file(name, bytes, { createFolders: false, compression: 'STORE' });
    const path = join(profile, filename);
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    return (await publish({ path, cover: false }, publishDeps)).url;
  }
  const utf16Entries = imageEntries.map(([name, bytes]) => {
    if (!['[Content_Types].xml', 'word/_rels/document.xml.rels', 'word/document.xml'].includes(name)) return [name, new Uint8Array(bytes)];
    let xml = decode.decode(new Uint8Array(bytes)).replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
    if (name === '[Content_Types].xml') xml = xml.replace('</Types>', '<Default Extension="html" ContentType="text/html"/></Types>');
    if (name === 'word/_rels/document.xml.rels') xml = xml.replace('</Relationships>', '<Relationship Id="rIdEmbedded" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/></Relationships>');
    if (name === 'word/document.xml') xml = xml.replace('</w:body>', '<w:altChunk r:id="rIdEmbedded"/></w:body>');
    return [name, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])];
  });
  utf16Entries.push(['word/chunk.html', encode.encode('<p>Additional document section</p>')]);
  const readerUrl = await publishEntries('reader-utf16.docx', utf16Entries);
  const badEntries = imageEntries.map(([name, bytes]) => [
    name,
    name === '[Content_Types].xml' ? encode.encode('<Types') : new Uint8Array(bytes),
  ]);
  const badUrl = await publishEntries('reader-invalid.docx', badEntries);
  const imagePath = imageEntries.find(([name]) => name.startsWith('word/media/') && name.endsWith('.png'))?.[0];
  assert.ok(imagePath);
  const unknownImageEntries = imageEntries.map(([name, bytes]) => {
    if (name === imagePath) return [name, encode.encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>')];
    if (name === '[Content_Types].xml') {
      const xml = decode.decode(new Uint8Array(bytes)).replace('</Types>', `<Override PartName="/${imagePath}" ContentType="image/svg+xml"/></Types>`);
      return [name, encode.encode(xml)];
    }
    return [name, new Uint8Array(bytes)];
  });
  const unknownImageUrl = await publishEntries('reader-unknown-image.docx', unknownImageEntries);
  const epubUrl = await publishEntries('reader.epub', [
    ['mimetype', encode.encode('application/epub+zip')],
    ['META-INF/container.xml', encode.encode('<container/>')],
  ]);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__docxStates=[];new MutationObserver(()=>{const stage=document.querySelector('.stage-sandboxed-document');if(stage){const state=stage.dataset.renderState;if(state&&window.__docxStates.at(-1)!==state)window.__docxStates.push(state)}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-render-state']})` }, sessionId);
  async function openReader(url, expectedState) {
    const loaded = cdp.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs: 30000 });
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    return evaluate(`(async()=>{const end=Date.now()+30000;while(Date.now()<end){const stage=document.querySelector('.stage-sandboxed-document');if(stage?.dataset.renderState===${JSON.stringify(expectedState)}){const frame=stage.querySelector('iframe.usercontent-frame');const wrap=stage.closest('.stage-wrap');const s=stage.getBoundingClientRect(),f=frame?.getBoundingClientRect();return {state:stage.dataset.renderState,busy:wrap?.getAttribute('aria-busy'),text:stage.innerText,frame:!!frame,stageHeight:s.height,frameHeight:f?.height??0,stageBottom:s.bottom,frameBottom:f?.bottom??0,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,states:window.__docxStates}}await new Promise(r=>setTimeout(r,10))}throw Error('reader state timeout: '+document.body.innerText)})()`);
  }
  for (const width of [1440, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const shown = await openReader(readerUrl, 'ready');
    assert.equal(shown.busy, 'false');
    assert.ok(shown.states.includes('rendering'));
    assert.ok(shown.frame && shown.frameHeight > 200);
    assert.ok(Math.abs(shown.stageBottom - shown.frameBottom) <= 1, JSON.stringify(shown));
    assert.ok(shown.scrollWidth <= shown.clientWidth, JSON.stringify(shown));
    const readerTree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const readerFrame = readerTree.frameTree.childFrames[0].frame.id;
    const world = await cdp.send('Page.createIsolatedWorld', { frameId: readerFrame, worldName: 'docx-reader-proof' }, sessionId);
    const readerText = await evaluate('document.body.innerText', world.executionContextId);
    assert.match(readerText, /DOCX table cell/);
    assert.match(readerText, /Embedded content was not shown/);
    const broken = await openReader(badUrl, 'error');
    assert.equal(broken.frame, false);
    assert.match(broken.text, /Download/);
    const unknownImage = await openReader(unknownImageUrl, 'error');
    assert.equal(unknownImage.frame, false);
    assert.match(unknownImage.text, /image whose dimensions could not be checked/);
    assert.match(unknownImage.text, /Download/);
    const epub = await openReader(epubUrl, 'ready');
    assert.equal(epub.frame, false);
    assert.match(epub.text, /Download/);
  }
  console.log('DOCX_READER_PATH_OK');
  off();
  console.log('DOCX_FRAME_PATH_OK');
} finally {
  if (priorPublishState === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = priorPublishState;
  cdp.dispose();
  child.kill();
  service.stop(true);
  usercontent.stop(true);
  await rm(profile, { recursive: true, force: true });
}
