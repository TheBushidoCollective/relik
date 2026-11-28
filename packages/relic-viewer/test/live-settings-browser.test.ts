import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);
test('settings control follows access and disabled suggestions never mount', async () => {
  if (!shell) throw new Error('A headless Chrome executable is required');
  const id = crypto.randomUUID();
  const entry = join(tmpdir(), `relik-settings-entry-${id}.ts`);
  const profile = join(tmpdir(), `relik-settings-profile-${id}`);
  const main = resolve(import.meta.dir, '../src/main.ts');
  const content = resolve(import.meta.dir, '../src/content.ts');
  const composer = resolve(import.meta.dir, '../src/signing/composer.ts');
  await writeFile(
    entry,
    `export {renderReady, buildThread} from ${JSON.stringify(main)}; export {contentFromBytes} from ${JSON.stringify(content)}; export {openSigningComposer} from ${JSON.stringify(composer)};`
  );
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'observe-mount',
        setup(builder) {
          builder.onLoad(
            { filter: /\/src\/frame-(docx|epub)-text\.ts$/ },
            () => ({
              contents: "export default '';",
              loader: 'ts',
            })
          );
          builder.onLoad({ filter: /\/src\/main\.ts$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            const marker =
              "if (typeof document !== 'undefined') {\n  // register-sw.js";
            if (!source.includes(marker))
              throw new Error('viewer bootstrap marker missing');
            return {
              contents: source.replace(
                marker,
                'if (false) {\n  // register-sw.js'
              ),
              loader: 'ts',
            };
          });
          builder.onLoad(
            { filter: /\/src\/suggest-controller\.ts$/ },
            async ({ path }) => {
              const source = await Bun.file(path).text();
              const marker =
                '): SuggestController {\n  const { initialSelection';
              if (!source.includes(marker))
                throw new Error('suggestion mount marker missing');
              return {
                contents: source.replace(
                  marker,
                  '): SuggestController {\n  (globalThis as typeof globalThis & { mounts: number }).mounts++;\n  const { initialSelection'
                ),
                loader: 'ts',
              };
            }
          );
        },
      },
    ],
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const js = await build.outputs[0]!.text();
  const result = Promise.withResolvers<string>();
  const page = `<!doctype html><script type="module">
    import {renderReady,buildThread,contentFromBytes,openSigningComposer} from '/entry.js';
    const check=(ok,message)=>{if(!ok)throw Error(message)};
    const frame=()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(resolve);return promise};
    const until=async(fn,message)=>{for(let i=0;i<300&&!fn();i++)await frame();check(fn(),message)};
    const settings={suggestions:true,comments:true,decisions:false,signing:true,notifications:true,changed_at:null,changed_by:null,expires_at:null};
    const key=new Uint8Array(16); const fragment='#r1'+btoa(String.fromCharCode(...key)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const id='aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const base={filename:'notes.md',declaredMimetype:'text/markdown',content:contentFromBytes(new TextEncoder().encode('hello')),document:{bytes:new TextEncoder().encode('hello'),truncated:false},route:'download',downgradeNotice:undefined,shareUrl:location.origin+'/'+id+fragment,version:1,currentVersion:1,versionDigest:'0'.repeat(64),settings};
    async function checkControl(access,manage,signed) {
      let accessCalls=0;
      const deps={serviceOrigin:location.origin,locationHref:location.href,keyVault:{remember(){},recall(){},forget(){}},fetch:async(url)=>{if(url.endsWith('/api/auth/session'))return Response.json({email:signed?'owner@example.test':null});if(url.endsWith('/access')){accessCalls++;return Response.json({manage,settings})}return Response.json([])}};
      renderReady({...base,...(access==='private'?{access:'private',manage,keyFor:async()=>key}: {})},id,location.origin,deps);
      const row=document.querySelector('.relic-row');
      check(row!==null,'the view did not draw its row');
      if(access==='public'&&signed)await until(()=>accessCalls===1,'access not requested');
      await frame();await frame();await frame();
      check(!!document.querySelector('[data-action="open-settings"]')===(manage&&signed),access+' '+manage+' '+signed+' control');
      if(!signed&&access==='public')check(accessCalls===0,'anonymous access requested');
      if(access==='public'&&signed){
        const redrawn=!row.isConnected;
        check(redrawn===manage,manage?'an owner view was never redrawn with the Settings control':'a reader who owns nothing had the whole view redrawn');
      }
    }
    try {
      await checkControl('public',true,true); await checkControl('public',false,true); await checkControl('public',false,false);
      await checkControl('private',true,true); await checkControl('private',false,true); await checkControl('private',false,false);
      {
        const comments=Promise.withResolvers(), decisions=Promise.withResolvers(), signing=Promise.withResolvers();
        const seen=new Set();
        let records=[];
        const deps={serviceOrigin:location.origin,locationHref:location.href,keyVault:{remember(){},recall(){},forget(){}},fetch:async(url)=>{
          url=String(url);
          if(url.endsWith('/comments')){seen.add('comments');await comments.promise;return Response.json([])}
          if(url.endsWith('/decisions/list')){seen.add('decisions');await decisions.promise;return Response.json({current_version:2,decisions:records})}
          if(url.endsWith('/signing/read')){seen.add('signing');await signing.promise;return Response.json({requests:[]})}
          return Response.json({email:null});
        }};
        renderReady({...base,route:'markdown',access:'private',manage:true,keyFor:async()=>key,version:2,currentVersion:2,settings:{...settings,decisions:true}},id,location.origin,deps);
        const bar=document.querySelector('.bar'), history=bar.querySelector('.action-history');
        const extra=document.createElement('button');extra.dataset.bandExtra='';bar.append(extra);
        await until(()=>seen.size===3,'collaboration responses were not requested');
        decisions.resolve();await until(()=>!!bar.querySelector('[data-decision-open]'),'decision control did not arrive');
        const decide=bar.querySelector('[data-decision-open]');
        check(decide.getAttribute('data-decision-approvals')==='0','initial decision tally');
        records=[{id:'a',version:2,verdict:'approve',author:'reader@example.test',created_at:'2026-01-01T00:00:00Z',version_digest:'0'.repeat(64)}];
        decide.click();await until(()=>decide.getAttribute('aria-expanded')==='true','decision panel did not open');
        await until(()=>decide.getAttribute('data-decision-approvals')==='1','decision tally did not update');
        signing.resolve();comments.resolve();
        await until(()=>!!bar.querySelector('[data-action="open-signing"]')&&bar.querySelector('.action-count')?.textContent==='0','signing or comment count did not arrive');
        check(document.querySelector('.bar')===bar&&bar.querySelector('.action-history')===history,'a refresh replaced the bar or comparison control');
        check(bar.querySelector('[data-decision-open]')===decide&&decide.getAttribute('aria-expanded')==='true','a refresh replaced or closed the decision opener');
        check(bar.contains(extra),'a refresh removed a page decorator control');
        const order=[...bar.querySelector('.actions').children];
        check(order.indexOf(decide)<order.indexOf(bar.querySelector('[data-action="open-signing"]'))&&order.indexOf(bar.querySelector('[data-action="open-signing"]'))<order.indexOf(history),'collaboration controls changed order');
      }
      {
        const calls=[];
        const deps={serviceOrigin:location.origin,locationHref:location.href,keyVault:{remember(){},recall(){},forget(){}},fetch:async(url)=>{calls.push(String(url));return Response.json({email:null})}};
        renderReady({...base,route:'markdown',access:'private',viewOnly:true,keyFor:async()=>key},id,location.origin,deps);
        await frame();await frame();await frame();
        check(!calls.some(url=>url.includes('/decisions/list')||url.includes('/comments')),'view-only mounted collaboration: '+calls.join(','));
        check(!document.querySelector('#comment-thread'),'view-only rendered comment thread');
      }
      {
        const stage=document.createElement('main');document.body.append(stage);
        const deps={serviceOrigin:location.origin,locationHref:location.href,fetch:async()=>Response.json({results:[]})};
        const panel=openSigningComposer({deps,relicId:id,version:1,digest:'0'.repeat(64),content:base.content,signingKey:key,private:true,grants:[{email:'a@example.test',identityId:'a'.repeat(64)}],pdf:false,stage,shareUrl:base.shareUrl,onSent(){}});
        const email=panel.querySelector('input[type=email]');email.value='a@example.test';
        const send=Array.from(panel.querySelectorAll('button')).find(b=>b.textContent==='Review and send');send.click();
        await frame();await frame();check(send.textContent==='Send with passkey','private review missing');
        email.value='b@example.test';email.dispatchEvent(new Event('input',{bubbles:true}));
        check(send.textContent==='Review and send','editing private signer did not invalidate review');
        panel.remove();stage.remove();
      }
      {
        const calls=[];
        const stage=document.createElement('main');document.body.append(stage);
        const deps={serviceOrigin:location.origin,locationHref:location.href,fetch:async(url)=>{calls.push(String(url));return Response.json({results:[]})}};
        const panel=openSigningComposer({deps,relicId:id,version:1,digest:'0'.repeat(64),content:base.content,signingKey:key,private:false,grants:[],pdf:false,stage,shareUrl:base.shareUrl,onSent(){}});
        const email=panel.querySelector('input[type=email]');email.value='a@example.test';email.dispatchEvent(new Event('input',{bubbles:true}));
        const send=Array.from(panel.querySelectorAll('button')).find(b=>b.textContent==='Review and send');send.click();
        await frame();await frame();
        check(!calls.some(url=>url.includes('/grants/lookup')),'public signing called private lookup');
        check(send.textContent==='Send with passkey','public signing did not reach review');
        email.value='b@example.test';email.dispatchEvent(new Event('input',{bubbles:true}));
        check(send.textContent==='Review and send','editing signer did not invalidate review');
        panel.remove();stage.remove();
      }
      for (const enabled of [false,true]) {
        globalThis.mounts=0;
        const deps={serviceOrigin:location.origin,locationHref:location.href,keyVault:{remember(){},recall(){},forget(){}},fetch:async(url)=>url.endsWith('/api/auth/session')?Response.json({email:null}):Response.json([])};
        const view={...base,route:'markdown',settings:{...settings,suggestions:enabled}};
        const thread=buildThread(view,id,deps,()=>{});
        const host=document.createElement('div');host.innerHTML='<article class="prose">hello</article>';document.body.append(host);
        thread.attach(host);await thread.ready;
        host.dispatchEvent(new CustomEvent('relic:table-suggest'));
        if(enabled) await until(()=>globalThis.mounts===1,'enabled suggestion controller not called');
        else {await frame();await frame();check(globalThis.mounts===0,'disabled suggestion controller mounted');check(!thread.suggestionBar,'disabled control drawn')}
        thread.dispose();host.remove();
      }
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
