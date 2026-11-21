import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);
test('controller holds pending work and releases a detached surface after either post result', async () => {
  if (!shell) throw new Error('A headless Chrome executable is required');
  const id = crypto.randomUUID();
  const entry = join(tmpdir(), `relic-lifecycle-entry-${id}.ts`);
  const profile = join(tmpdir(), `relic-lifecycle-profile-${id}`);
  const controller = resolve(import.meta.dir, '../src/suggest-controller.ts');
  const surface = resolve(import.meta.dir, '../src/suggestion-surface.ts');
  const notebook = resolve(import.meta.dir, '../src/notebook-view.ts');
  await writeFile(
    entry,
    `export { mountSuggestionController } from ${JSON.stringify(controller)}; export { registerSuggestionSurface, suggestionSurfaceFor } from ${JSON.stringify(surface)}; export { mountView as mountNotebook } from ${JSON.stringify(notebook)};`
  );
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const js = await build.outputs[0]!.text();
  const result = Promise.withResolvers<string>();
  const page = `<!doctype html><script type="module">
    import {mountSuggestionController,registerSuggestionSurface,suggestionSurfaceFor,mountNotebook} from '/entry.js';
    const check = (v, message) => { if (!v) throw Error(message); };
    const eventually = async (condition, message) => {
      for (let i=0; i<100 && !condition(); i++) await Promise.resolve();
      check(condition(),message);
    };
    async function exercise(ok) {
      const host = document.createElement('div');
      const owner = document.createElement('div'); owner.className='structured-view';
      const root = document.createElement('div'); root.dataset.seg='0'; root.textContent='a';
      owner.append(root); host.append(owner); const bar = document.createElement('div'); document.body.append(host,bar);
      registerSuggestionSurface(owner,{root,segments:()=>[{text:'a',start:0,end:1,block:0,kind:'text'}],blockKind:()=> 'csv-bare',editable:()=>true,repaint(){}});
      const response = Promise.withResolvers(); let calls=0;
      const fakeFetch = async (_url, init) => { if (init?.method === 'POST') { calls++; return response.promise; } return Response.json([]); };
      const view={route:'code',filename:'x.csv',declaredMimetype:'text/csv',version:1,currentVersion:1,document:{bytes:new TextEncoder().encode('a\\n'),truncated:false}};
      const adapter=mountSuggestionController({view,host,bar,relicId:'fixture',deps:{serviceOrigin:location.origin,fetch:fakeFetch},
        session:()=>({kind:'verified',email:'reader@example.test'}),cipher:()=>({seal:async()=> 'sealed',open:async()=>({body:'',display_name:null,anchor:null})}),
        entries:()=>[],displayName:()=>null,refresh:async()=>{},readCurrentVersion:async()=>1,repaint(){},signIn(){},open(){}});
      check(typeof adapter.hasPendingDraft === 'function','controller has no hasPendingDraft');
      check(!adapter.hasPendingDraft(),'new controller reports pending work');
      adapter.setSuggesting(true);
      const selection=document.getSelection(), range=document.createRange(); range.setStart(root.firstChild,0); range.setEnd(root.firstChild,1); selection.removeAllRanges();selection.addRange(range);
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'b'}));
      check(adapter.draftOpen && adapter.hasPendingDraft(),'unsent draft is not pending');
      adapter.setSuggesting(false);
      await eventually(()=>calls===1,'post did not start');
      check(!adapter.draftOpen && adapter.hasPendingDraft(),'in-flight post is not pending');
      owner.replaceChildren();
      check(adapter.destroy()===false,'in-flight controller was destroyed prematurely');
      response.resolve(ok ? {ok:true,json:async()=>({comment_id:'saved'})} : {ok:false,status:500});
      await eventually(()=>adapter.presenceDocument()===undefined,'detached root is still held after post settled');
      if (!ok) {
        check(host.textContent.includes('Not posted'),'failed post lost retry/discard UI');
        check(adapter.hasPendingDraft(),'failed post lost pending status');
        [...host.querySelectorAll('button')].find(b=>b.textContent==='Discard')?.click();
        check(!adapter.hasPendingDraft(),'discard did not clear the failed post');
      }
      host.remove(); bar.remove();
    }
    async function notebookSwitch(ok) {
      const host=document.createElement('div'), owner=document.createElement('div'), bar=document.createElement('div');
      owner.className='structured-view'; host.append(owner); document.body.append(host,bar);
      const source=JSON.stringify({nbformat:4,cells:[{cell_type:'code',execution_count:7,source:'alpha',outputs:[{output_type:'display_data',data:{'text/html':'<b>unsafe</b>'},metadata:{}}]}]});
      const part=mountNotebook({root:owner,source,filename:'x.ipynb',mimetype:'application/x-ipynb+json',sourceView:()=>document.createElement('pre'),reportUnshown(){}});
      const surface=suggestionSurfaceFor(host); check(surface && surface.root!==owner,'notebook editor root not disposable');
      const response=Promise.withResolvers(); let calls=0;
      const fetcher=async (_url,init)=>{ if(init?.method==='POST'){calls++;return response.promise;} return Response.json([]); };
      const view={route:'notebook',filename:'x.ipynb',version:1,currentVersion:1,document:{bytes:new TextEncoder().encode(source),truncated:false}};
      const editor=mountSuggestionController({view,host,bar,relicId:'fixture',deps:{serviceOrigin:location.origin,fetch:fetcher},session:()=>({kind:'verified',email:'reader@example.test'}),cipher:()=>({seal:async()=> 'sealed',open:async()=>({})}),entries:()=>[],displayName:()=>null,refresh:async()=>{},readCurrentVersion:async()=>1,repaint(){},signIn(){},open(){}});
      const text=surface.root.querySelector('[data-seg]').firstChild, range=document.createRange(), selection=document.getSelection();
      range.setStart(text,0); range.setEnd(text,1); selection.removeAllRanges(); selection.addRange(range);
      editor.setSuggesting(true,range);
      check(selection.anchorNode.parentElement.closest('.nb-src'),'first source character restored into gutter');
      const show=surface.root.querySelector('.nb-show-text'); check(show,'withheld output control missing'); show.click();
      await Promise.resolve(); check(surface.root.querySelector('.nb-text')?.textContent==='<b>unsafe</b>' && editor.suggesting,'output control reverted during suggesting');
      surface.root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'b'}));
      check(editor.draftOpen,'notebook draft missing'); editor.setSuggesting(false);
      await eventually(()=>calls===1,'notebook post did not start');
      part.dispose(); const pre=document.createElement('pre'); pre.textContent=source; owner.replaceChildren(pre);
      check(editor.destroy()===false,'notebook post disposed early');
      response.resolve(ok ? {ok:true,json:async()=>({comment_id:'saved'})} : {ok:false,status:500});
      await eventually(()=>editor.presenceDocument()===undefined,'notebook surface held after post');
      await Promise.resolve(); check(owner.firstChild===pre && pre.textContent===source,'notebook editor restored over Source');
      if(!ok) [...host.querySelectorAll('button')].find(b=>b.textContent==='Discard')?.click();
      host.remove();bar.remove();
    }
    try { await exercise(true); await exercise(false); await notebookSwitch(true); await notebookSwitch(false); await fetch('/result',{method:'POST',body:'ok'}); }
    catch(e) { await fetch('/result',{method:'POST',body:e.stack || String(e)}); }
  </script>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/entry.js')
        return new Response(js, {
          headers: { 'content-type': 'text/javascript' },
        });
      if (path === '/result') {
        result.resolve(await request.text());
        return new Response('ok');
      }
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  const browser = spawn(
    shell,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1280,900',
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.port}/`,
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    }
  );
  try {
    const exited = Promise.withResolvers<never>();
    browser.once('error', exited.reject);
    browser.once('exit', (code) =>
      exited.reject(new Error(`headless browser exited: ${code}`))
    );
    expect(await Promise.race([result.promise, exited.promise])).toBe('ok');
  } finally {
    browser.kill('SIGKILL');
    if (browser.exitCode === null && browser.signalCode === null)
      await once(browser, 'exit');
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
    await rm(entry, { force: true });
  }
}, 60_000);
