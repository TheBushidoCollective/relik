import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);
test('structured toggle protects a draft and releases a surface after an in-flight post', async () => {
  if (!shell) throw new Error('A headless Chrome executable is required');
  const id = crypto.randomUUID();
  const entry = join(tmpdir(), `relic-swap-entry-${id}.ts`);
  const profile = join(tmpdir(), `relic-swap-profile-${id}`);
  const controller = resolve(import.meta.dir, '../src/suggest-controller.ts');
  const surface = resolve(import.meta.dir, '../src/suggestion-surface.ts');
  const bridge = resolve(import.meta.dir, '../src/structured-view-bridge.ts');
  await writeFile(
    entry,
    `export {mountSuggestionController} from ${JSON.stringify(controller)}; export {registerSuggestionSurface,guardSurfaceSwap} from ${JSON.stringify(surface)}; export {mountStructuredView} from ${JSON.stringify(bridge)};`
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
    import {mountSuggestionController,registerSuggestionSurface,guardSurfaceSwap,mountStructuredView} from '/entry.js';
    const check=(condition,message)=>{if(!condition)throw Error(message)};
    const eventually=async(condition,message)=>{for(let i=0;i<200&&!condition();i++)await Promise.resolve();check(condition(),message)};
    async function fixture() {
      const host=document.createElement('div'), owner=document.createElement('section'), bar=document.createElement('div'), notice=document.createElement('span');
      notice.setAttribute('role','status');host.append(owner);document.body.append(host,bar,notice);
      let root; const sourceView=()=>{root=document.createElement('div');root.dataset.seg='0';root.textContent='a';return root};
      const handle=mountStructuredView(owner,'tree',{filename:'x.json',mimetype:'application/json',source:'a\\n',sourceView});
      handle.showSource(); const oldRoot=root;
      registerSuggestionSurface(owner,{root,segments:()=>[{text:'a',start:0,end:1,block:0,kind:'text'}],blockKind:()=> 'csv-bare',editable:()=>true,repaint(){}});
      const response=Promise.withResolvers(); let calls=0;
      const fakeFetch=async(_url,init)=>{if(init?.method==='POST'){calls++;return response.promise}return Response.json([])};
      const view={route:'code',filename:'x.csv',declaredMimetype:'text/csv',version:1,currentVersion:1,document:{bytes:new TextEncoder().encode('a\\n'),truncated:false}};
      const adapter=mountSuggestionController({view,host,bar,relicId:'fixture',deps:{serviceOrigin:location.origin,fetch:fakeFetch},session:()=>({kind:'verified',email:'reader@example.test'}),cipher:()=>({seal:async()=> 'sealed',open:async()=>({body:'',display_name:null,anchor:null})}),entries:()=>[],displayName:()=>null,refresh:async()=>{},readCurrentVersion:async()=>1,repaint(){},signIn(){},open(){}});
      host.addEventListener('relic:before-structured-swap',event=>{const reason=guardSurfaceSwap(adapter);if(reason){event.preventDefault();notice.textContent=reason}});
      host.addEventListener('relic:structured-state',()=>adapter.destroy());
      adapter.setSuggesting(true);
      const selection=document.getSelection(),range=document.createRange();range.setStart(root.firstChild,0);range.setEnd(root.firstChild,1);selection.removeAllRanges();selection.addRange(range);
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'b'}));
      check(adapter.draftOpen,'typing did not create a draft');
      return {host,owner,bar,notice,handle,oldRoot,adapter,response,get calls(){return calls}};
    }
    try {
      const first=await fixture();
      first.handle.showSource();
      check(first.owner.contains(first.oldRoot) && first.adapter.draftOpen,'refused swap removed the draft');
      check(first.notice.textContent==='Send or discard your suggestion first','refusal reason missing');
      first.oldRoot.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      await eventually(()=>!first.adapter.hasPendingDraft(),'discard did not settle');
      first.handle.showSource();
      check(!first.owner.contains(first.oldRoot),'swap after discard did not replace the root');
      first.handle.dispose();first.host.remove();first.bar.remove();first.notice.remove();
      const second=await fixture();second.adapter.setSuggesting(false);
      await eventually(()=>second.calls===1,'post did not start');
      second.handle.showSource();
      check(!second.owner.contains(second.oldRoot),'in-flight post blocked the swap');
      check(second.adapter.presenceDocument()?.root===second.oldRoot,'controller released before post settled');
      second.response.resolve({ok:true,json:async()=>({comment_id:'saved'})});
      await eventually(()=>second.adapter.presenceDocument()===undefined,'controller retained the old root after post');
      second.handle.dispose();second.host.remove();second.bar.remove();second.notice.remove();
      await fetch('/result',{method:'POST',body:'ok'});
    } catch(error) {await fetch('/result',{method:'POST',body:error.stack||String(error)})}
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
