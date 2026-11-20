import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('thread guards the actual structured-view toggle and recovers after a post', async () => {
  const shell = process.env['RELIC_CHROME_PATH'];
  if (!shell) throw new Error('RELIC_CHROME_PATH is required');
  const id = crypto.randomUUID();
  const entry = join(tmpdir(), `relic-thread-swap-${id}.ts`);
  const profile = join(tmpdir(), `relic-thread-profile-${id}`);
  const main = resolve(import.meta.dir, '../src/main.ts');
  const surface = resolve(import.meta.dir, '../src/suggestion-surface.ts');
  const bridge = resolve(import.meta.dir, '../src/structured-view-bridge.ts');
  const format = resolve(import.meta.dir, '../../relic-format/src/index.ts');
  await writeFile(
    entry,
    `export {buildThread} from ${JSON.stringify(main)}; export {registerSuggestionSurface} from ${JSON.stringify(surface)}; export {mountStructuredView} from ${JSON.stringify(bridge)}; export {encodeKey} from ${JSON.stringify(format)};`
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
    import {buildThread,registerSuggestionSurface,mountStructuredView,encodeKey} from '/entry.js';
    const check=(value,message)=>{if(!value)throw Error(message)};
    const eventually=async(condition,message)=>{for(let i=0;i<300&&!condition();i++)await Promise.resolve();check(condition(),message)};
    async function fixture() {
      const host=document.createElement('div'),owner=document.createElement('section');host.append(owner);
      let root,draws=0;const sourceView=()=>{const wrap=document.createElement('div');wrap.className='code';root=document.createElement('pre');root.className='code-body';root.dataset.seg='0';root.textContent=draws++<2?'a':'a\\n';wrap.append(root);return wrap};
      const handle=mountStructuredView(owner,'tree',{filename:'x.json',mimetype:'application/json',source:'a\\n',sourceView});handle.showSource();
      const oldRoot=root;
      registerSuggestionSurface(owner,{root,segments:()=>[{text:'a',start:0,end:1,block:0,kind:'text'}],blockKind:()=> 'csv-bare',editable:()=>true,repaint(){}});
      const response=Promise.withResolvers();let posts=0,deletes=0;
      const fakeFetch=async(input,init)=>{const url=String(input);if(url.endsWith('/api/auth/session'))return Response.json({email:'reader@example.test'});if(init?.method==='POST'&&url.includes('/comments')){posts++;return response.promise}if(init?.method==='DELETE'){deletes++;return new Response(null,{status:204})}return Response.json([])};
      const relicId='aaaaaaaaaaaaaaaaaaaaaaaaaa';const fragment='#r1'+encodeKey(new Uint8Array(16).fill(3));
      const view={route:'code',filename:'x.csv',declaredMimetype:'text/csv',version:1,currentVersion:1,versionDigest:'0'.repeat(64),shareUrl:location.origin+'/'+relicId+fragment,content:{size:2},document:{bytes:new TextEncoder().encode('a\\n'),truncated:false}};
      const deps={serviceOrigin:location.origin,fetch:fakeFetch,takeFragment:()=>fragment,stripFragment(){},locationHref:location.href,keyVault:{remember(){},recall(){},forget(){}}};
      const thread=buildThread(view,relicId,deps,()=>{});document.body.replaceChildren(host,thread.element,thread.suggestionBar);
      await thread.ready;thread.attach(host);
      const button=thread.suggestionBar.querySelector('[data-sg-suggesting]');
      check(button&&!button.disabled,'suggestion button unavailable');
      const frame=()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(resolve);return promise};await frame();await frame();
      const rect=button.getBoundingClientRect(), hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      check(hit===button||button.contains(hit),'suggestion button is occluded');button.click();
      await eventually(()=>root.getAttribute('contenteditable')==='true','suggesting did not start');
      const selection=document.getSelection(),range=document.createRange();range.setStart(root.firstChild,0);range.setEnd(root.firstChild,1);selection.removeAllRanges();selection.addRange(range);
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'b'}));
      check(root.querySelector('ins[data-sg-draft]'),'typing did not create a draft');
      return {host,owner,thread,handle,oldRoot,response,get root(){return root},get posts(){return posts},get deletes(){return deletes}};
    }
    try {
      const a=await fixture();a.handle.showSource();
      check(a.owner.contains(a.oldRoot)&&a.oldRoot.querySelector('ins[data-sg-draft]'),'real thread failed to protect draft');
      check(a.thread.suggestionBar.textContent.includes('Send or discard your suggestion first'),'real thread did not show refusal');
      await a.handle.ready;a.handle.showStructured();check(a.owner.contains(a.oldRoot)&&a.oldRoot.querySelector('ins[data-sg-draft]'),'structured redraw replaced the draft');
      a.oldRoot.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      await eventually(()=>!a.oldRoot.querySelector('ins[data-sg-draft]'),'discard did not clear draft');
      await Promise.resolve();a.handle.showSource();check(!a.owner.contains(a.oldRoot),'discarded draft blocked swap');a.handle.dispose();a.thread.dispose();
      const b=await fixture();b.thread.suggestionBar.querySelector('[data-sg-reading]').click();
      await eventually(()=>b.posts===1,'post did not start');b.handle.showSource();
      check(!b.owner.contains(b.oldRoot),'in-flight post blocked swap');
      b.response.resolve({ok:true,json:async()=>({comment_id:'saved'})});
      for(let i=0;i<200;i++)await Promise.resolve();
      check(b.host.querySelector('.sg-receipt:not(.is-failed)'),'successful post lost its receipt during swap');
      const undo=[...b.host.querySelectorAll('.sg-receipt button')].find(button=>button.textContent==='Undo');check(undo,'receipt has no Undo');undo.click();await eventually(()=>b.deletes===1,'Undo did not send the withdrawal');
      const reopen=b.thread.suggestionBar.querySelector('[data-sg-suggesting]');check(!reopen.disabled,'thread stayed disabled');reopen.click();
      for(let i=0;i<300&&b.root.getAttribute('contenteditable')!=='true';i++)await Promise.resolve();check(b.root.getAttribute('contenteditable')==='true','thread stale: '+b.thread.suggestionBar.outerHTML+' host='+b.host.outerHTML);
      b.handle.dispose();b.thread.dispose();
      const c=await fixture();c.thread.suggestionBar.querySelector('[data-sg-reading]').click();await eventually(()=>c.posts===1,'failed post did not start');
      c.handle.showSource();c.response.resolve({ok:false,status:500});await eventually(()=>c.host.textContent.includes('Not posted'),'failed post lost its controls');
      const current=c.root;c.handle.showSource();check(c.root===current&&c.thread.suggestionBar.textContent.includes('Send or discard your suggestion first'),'failed post did not block a further swap');
      const discard=[...c.host.querySelectorAll('button')].find(button=>button.textContent==='Discard');check(discard,'missing Discard');discard.click();
      const again=c.thread.suggestionBar.querySelector('[data-sg-suggesting]');check(!again.disabled,'discard did not restore suggesting');again.click();await eventually(()=>c.root.getAttribute('contenteditable')==='true','discard did not release the failed controller');
      c.handle.dispose();c.thread.dispose();await fetch('/result',{method:'POST',body:'ok'});
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
