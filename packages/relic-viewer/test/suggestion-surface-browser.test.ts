import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);
test('controller uses the registered structured suggestion surface', async () => {
  if (!shell) throw new Error('A headless Chrome executable is required');
  const id = crypto.randomUUID();
  const entry = join(tmpdir(), `relic-surface-entry-${id}.ts`);
  const profile = join(tmpdir(), `relic-surface-profile-${id}`);
  const controller = resolve(import.meta.dir, '../src/suggest-controller.ts');
  const surface = resolve(import.meta.dir, '../src/suggestion-surface.ts');
  const cues = resolve(import.meta.dir, '../src/cue-view.ts');
  const editorModule = resolve(import.meta.dir, '../src/suggest-editor.ts');
  const draftModule = resolve(import.meta.dir, '../src/suggest-draft.ts');
  await writeFile(
    entry,
    `export { mountSuggestionController } from ${JSON.stringify(controller)}; export { registerSuggestionSurface, suggestionSurfaceFor } from ${JSON.stringify(surface)}; export { mountView as mountCues } from ${JSON.stringify(cues)}; export { mountSuggestEditor } from ${JSON.stringify(editorModule)}; export { SuggestDraftModel } from ${JSON.stringify(draftModule)};`
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
    import { mountSuggestionController, registerSuggestionSurface, suggestionSurfaceFor, mountCues, mountSuggestEditor, SuggestDraftModel } from '/entry.js';
    try {
      const host = document.createElement('div');
      const owner = document.createElement('div'); owner.className = 'structured-view';
      const root = document.createElement('div');
      const segment = document.createElement('span'); segment.setAttribute('data-seg','0'); segment.textContent = 'a';
      const output = document.createElement('span'); output.textContent = 'output';
      root.append(segment, output); owner.append(root); host.append(owner); document.body.append(host);
      let allowed = false, paints = 0;
      registerSuggestionSurface(owner, {
        root, segments: source => {
          if (source !== 'a\\n') throw Error('source was not normalized');
          return [{text:'a', start:0, end:1, block:4, kind:'text'}];
        }, blockKind: block => block === 4 ? 'csv-bare' : 'paragraph',
        editable: () => allowed || {kind:'refused', code:'not-editable', message:'Not editable'},
        acceptsSelection: node => output.contains(node) ? {kind:'refused',code:'not-editable',message:'Output is not editable'} : true,
        repaint: () => paints++,
      });
      const view = {route:'code', filename:'data.csv', declaredMimetype:'text/csv', version:1, currentVersion:1, document:{bytes:new TextEncoder().encode('a\\r\\n'), truncated:false}};
      const bar = document.createElement('div'); document.body.append(bar);
      const editor = mountSuggestionController({view, host, bar, relicId:'fixture', deps:{serviceOrigin:location.origin,fetch},
        session:()=>({kind:'verified',email:'reader@example.test'}), cipher:()=>({seal:async()=>'',open:async()=>({body:'',display_name:null,anchor:null})}),
        entries:()=>[], displayName:()=>null, refresh:async()=>{}, readCurrentVersion:async()=>1, repaint(){}, signIn(){}, open(){} });
      editor.setSuggesting(true);
      if (!editor.suggesting) throw Error('surface could not enter suggesting');
      editor.repaint(()=>{}); if (!paints) throw Error('surface repaint was not called');
      const range = document.createRange(); range.setStart(output.firstChild,0); range.collapse(true);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const type = text => root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));
      type('b'); if (editor.draftOpen || !host.textContent.includes('Output is not editable')) throw Error('output selection snapped into source');
      root.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      if (editor.draftOpen) throw Error('composition started in output');
      range.setStart(segment.firstChild,0); range.setEnd(segment.firstChild,1); sel.removeAllRanges(); sel.addRange(range);
      type('b'); if (editor.draftOpen || !host.textContent.includes('Not editable')) throw Error('surface refusal ignored');
      allowed = true; type('b'); if (!editor.draftOpen) throw Error('editable surface did not create a draft');
      const cueSource = 'WEBVTT\\r\\n\\r\\n00:00:01.000 --> 00:00:02.000\\r\\nA &amp; <b>B</b>\\r\\n';
      const cueHost = document.createElement('div');
      const cueOwner = document.createElement('section'); cueOwner.className = 'structured-view';
      cueHost.append(cueOwner); document.body.append(cueHost);
      const cuePart = mountCues({root:cueOwner, source:cueSource, filename:'test.vtt', mimetype:'text/vtt', sourceView:()=>document.createElement('pre'), reportUnshown(){}});
      const cueSurface = suggestionSurfaceFor(cueHost);
      const cueNormalized = cueSource.split('\\r\\n').join('\\n');
      const at = cueNormalized.indexOf('B</b>');
      const encoded = cueSurface.encode(1, '<C>&', at, at + 1);
      if (!encoded.ok || encoded.source !== '&lt;C&gt;&amp;') throw Error('VTT replacement was not escaped');
      if (cueSurface.decode(1, encoded.source) !== '<C>&') throw Error('VTT replacement did not decode');
      const model = new SuggestDraftModel({source:cueNormalized, segments:cueSurface.segments(cueNormalized), delimiters:[], version:1, reader:'reader@example.test', crlf:true, encode:cueSurface.encode, decode:cueSurface.decode});
      if (model.replace(at, at + 1, '<C>&', 'cue').kind !== 'changed') throw Error('escaped VTT draft rejected');
      const prepared = model.commit(null);
      if (prepared.kind !== 'save' || prepared.plaintext.suggestion.replacement !== '&lt;C&gt;&amp;') throw Error('VTT saved payload was not encoded');
      const cueView = {route:'code', filename:'test.vtt', declaredMimetype:'text/vtt', version:1, currentVersion:1, document:{bytes:new TextEncoder().encode(cueSource), truncated:false}};
      const cueBar = document.createElement('div'); document.body.append(cueBar);
      let cueSealed;
      const cueEditor = mountSuggestionController({view:cueView, host:cueHost, bar:cueBar, relicId:'cue-fixture', deps:{serviceOrigin:location.origin,fetch},
        session:()=>({kind:'verified',email:'reader@example.test'}), cipher:()=>({seal:async value=>{ cueSealed=value; return ''; },open:async()=>({body:'',display_name:null,anchor:null})}),
        entries:()=>[], displayName:()=>null, refresh:async()=>{}, readCurrentVersion:async()=>1, repaint(){}, signIn(){}, open(){} });
      cueEditor.setSuggesting(true);
      if (!cueEditor.suggesting) throw Error('cue surface could not enter suggesting');
      const time = cueOwner.querySelector('.cue-time').firstChild;
      const timeRange = document.createRange(); timeRange.selectNodeContents(time);
      sel.removeAllRanges(); sel.addRange(timeRange);
      const invalid = new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'x'});
      time.parentElement.dispatchEvent(invalid);
      if (!invalid.defaultPrevented || cueEditor.draftOpen) throw Error('cue timing was editable');
      const cueText = cueOwner.querySelector('strong [data-seg]').firstChild;
      const cueRange = document.createRange(); cueRange.selectNodeContents(cueText);
      sel.removeAllRanges(); sel.addRange(cueRange);
      cueText.parentElement.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'<C>'}));
      if (!cueEditor.draftOpen) throw Error('cue edit did not create a draft');
      await Promise.resolve();
      if (cueSealed?.anchor?.exact !== 'B' || cueSealed?.suggestion?.replacement !== '&lt;C&gt;') throw Error('CRLF cue selected wrong source: ' + JSON.stringify(cueSealed));
      cuePart.dispose();
      editor.destroy();
      for (const [source, crlf, hasSurface, shouldEnable] of [
        ['a\\r\\nb', true, true, true],
        ['a\\rb', true, true, false],
        ['a\\r\\nb', false, true, false],
        ['a\\r\\nb', true, false, false],
      ]) {
        const r = document.createElement('div');
        const seg = document.createElement('span'); seg.setAttribute('data-seg', '0'); seg.textContent = 'a'; r.append(seg);
        const c = document.createElement('div'); document.body.append(r, c);
        const segments = [{text:'a', start:0, end:1, block:0, kind:'text'}];
        const s = {root:r,segments:()=>segments,blockKind:()=>'cue',editable:()=>true,repaint:()=>{}};
        const e = mountSuggestEditor({root:r,chrome:c,source,segments,delimiters:[],version:1,reader:'x',crlf,surface:hasSurface?s:undefined,onCommit(){},onRefusal(){},onDraftChange(){}});
        if (e.setSuggesting(true) !== shouldEnable) throw Error('CRLF availability incorrect');
        e.destroy(); r.remove(); c.remove();
      }
      await fetch('/result',{method:'POST',body:'ok'});
    } catch (e) { await fetch('/result',{method:'POST',body:e.stack || String(e)}); }
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
