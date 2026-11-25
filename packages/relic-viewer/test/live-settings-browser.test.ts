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
  await writeFile(
    entry,
    `export {renderReady, buildThread} from ${JSON.stringify(main)}; export {contentFromBytes} from ${JSON.stringify(content)};`
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
    import {renderReady,buildThread,contentFromBytes} from '/entry.js';
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
