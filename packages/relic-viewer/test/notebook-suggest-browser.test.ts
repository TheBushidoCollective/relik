import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';
import { notebookSuggestionFixture } from './notebook-suggest-fixture.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);
test('notebook source maps rendered cells but refuses output selections', async () => {
  if (!shell) throw new Error('A headless Chrome executable is required');
  const id = crypto.randomUUID();
  const entry = join(tmpdir(), `relic-nb-entry-${id}.ts`);
  const profile = join(tmpdir(), `relic-nb-profile-${id}`);
  const suggest = resolve(import.meta.dir, '../src/notebook-suggest.ts');
  const editorModule = resolve(import.meta.dir, '../src/suggest-editor.ts');
  const controllerModule = resolve(
    import.meta.dir,
    '../src/suggest-controller.ts'
  );
  const surfaceModule = resolve(
    import.meta.dir,
    '../src/suggestion-surface.ts'
  );
  const notebook = resolve(
    import.meta.dir,
    '../../relic-format/src/notebook.ts'
  );
  await writeFile(
    entry,
    `export { notebookSuggestionSurface, notebookAcceptsSelection } from ${JSON.stringify(suggest)}; export { parseNotebook } from ${JSON.stringify(notebook)}; export { mountSuggestEditor } from ${JSON.stringify(editorModule)}; export { mutateSurfaceUI, registerSuggestionSurface } from ${JSON.stringify(surfaceModule)}; export { mountSuggestionController } from ${JSON.stringify(controllerModule)};`
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
    import {notebookSuggestionSurface, notebookAcceptsSelection, parseNotebook, mountSuggestEditor, mutateSurfaceUI, registerSuggestionSurface, mountSuggestionController} from '/entry.js';
    try {
      const source = ${JSON.stringify(notebookSuggestionFixture)};
      const parsed = parseNotebook(source); if (!parsed.ok) throw Error('fixture refused');
      const root = document.createElement('div');
      root.innerHTML = '<div class="nb-cell" data-cell="0"><div class="nb-box"><article class="prose"></article></div></div><div class="nb-cell" data-cell="1"><div class="nb-box"><pre class="nb-src"></pre></div><div class="nb-out">output</div></div><div class="nb-cell" data-cell="2"><div class="nb-box"><pre class="nb-src"></pre></div></div>';
      document.body.append(root);
      const surface = notebookSuggestionSurface(root, parsed.notebook);
      const segments = surface.segments(source);
      const smile = segments.find(s => s.text === '☺');
      if (!smile || smile.kind !== 'escape' || source.slice(smile.start, smile.end) !== String.raw\x60\\u263a\x60) throw Error('Unicode escape mapping: ' + JSON.stringify({smile,segments}));
      const escapedBidi = String.fromCharCode(92) + 'u202e';
      if (surface.covers(smile.start, smile.end, escapedBidi) || !surface.covers(smile.start, smile.end, 'safe')) throw Error('decoded invisible replacement was admitted');
      const newline = segments.find(s => s.text === '\\n');
      if (!newline || newline.kind !== 'escape') throw Error('newline escape mapping');
      if (root.querySelectorAll('[data-seg]').length !== segments.length) throw Error('segment layout');
      const typed = '\"' + String.fromCharCode(92, 10);
      const insertion = surface.encode(smile.block, typed, smile.start, smile.end);
      if (!insertion.ok) throw Error('source edit refused');
      const changed = source.slice(0, smile.start) + insertion.source + source.slice(smile.end);
      if (JSON.parse(changed).cells[0].source[0] !== 'Hello ' + typed + String.fromCharCode(10)) throw Error('replacement was not JSON escaped');
      const next = segments.find(s => s.text === 'next line');
      if (!next || !surface.covers(smile.start, next.end)) throw Error('cross-string selection not mapped');
      const cross = surface.encode(smile.block, 'x', smile.start, next.end);
      if (!cross.ok || JSON.parse(source.slice(0,smile.start)+cross.source+source.slice(next.end)).cells[0].source.join('') !== 'Hello x') throw Error('cross-string replacement corrupts JSON');
      const outputPos = source.indexOf('output');
      if (surface.covers(outputPos, outputPos+6) || surface.covers(2,3)) throw Error('output or metadata mapped to a cell');
      if (notebookAcceptsSelection(root, root.querySelector('.nb-out').firstChild) === true) throw Error('output accepted');
      if (notebookAcceptsSelection(root, root.querySelector('[data-seg]').firstChild) !== true) throw Error('source refused');
      let refusal = '';
      const chrome = document.createElement('div'); document.body.append(chrome);
      const editor = mountSuggestEditor({root,source,segments,delimiters:[],version:1,reader:'reader@example.test',chrome,surface,onCommit(){},onDraftChange(){},onRefusal(message){refusal=message;}});
      if (!editor.setSuggesting(true)) throw Error('could not start editor');
      mutateSurfaceUI(root, () => { root.querySelector('.nb-out').textContent = 'revealed output'; });
      await Promise.resolve();
      if (root.querySelector('.nb-out').textContent !== 'revealed output' || !editor.suggesting) throw Error('output control reverted');
      const select = node => { const range=document.createRange(); range.selectNodeContents(node); const selection=document.getSelection(); selection.removeAllRanges(); selection.addRange(range); };
      select(root.querySelector('.nb-out'));
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'x'}));
      if (editor.draft || !refusal.includes('Only notebook cell source')) throw Error('output editing was not refused');
      select(root.querySelector('[data-seg=\"' + segments.indexOf(smile) + '\"]'));
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:typed}));
      const prepared=editor.prepare();
      if (prepared.kind !== 'save' || prepared.plaintext.suggestion.replacement !== insertion.source) throw Error('editor did not commit escaped text');
      editor.cancel();
      const crossRange = document.createRange();
      crossRange.setStart(root.querySelector('[data-seg=\"' + segments.indexOf(smile) + '\"]').firstChild,0);
      crossRange.setEnd(root.querySelector('[data-seg=\"' + segments.indexOf(next) + '\"]').firstChild,next.text.length);
      const selection=document.getSelection(); selection.removeAllRanges(); selection.addRange(crossRange);
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'x'}));
      if (editor.prepare().kind !== 'save') throw Error('cross-line edit refused');
      editor.cancel();
      const codeSegment = segments.find(s => s.text === 'print(');
      const textNode = root.querySelector('[data-seg=\"' + segments.indexOf(codeSegment) + '\"]').firstChild;
      const caret = document.createRange(); caret.setStart(textNode, 1); caret.collapse(true); selection.removeAllRanges(); selection.addRange(caret);
      const tab = new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}); root.dispatchEvent(tab);
      if (!tab.defaultPrevented || editor.draft?.inserted !== String.fromCharCode(9)) throw Error('code Tab did not insert');
      editor.cancel();
      select(root.querySelector('[data-seg=\"' + segments.indexOf(codeSegment) + '\"]'));
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'A'}));
      const second=segments.find(s=>s.text==='second');
      const secondNode=root.querySelector('[data-seg=\"'+segments.indexOf(second)+'\"]').firstChild;
      const secondCaret=document.createRange(); secondCaret.setStart(secondNode,1); secondCaret.collapse(true); selection.removeAllRanges(); selection.addRange(secondCaret);
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'Z'}));
      if (editor.draft?.inserted !== 'A\"hi\")'+String.fromCharCode(10)+'sZ') throw Error('draft extension changed untouched source');
      const combined=editor.prepare(), draft=editor.draft;
      if (combined.kind!=='save' || JSON.parse(source.slice(0,draft.start)+combined.plaintext.suggestion.replacement+source.slice(draft.end)).cells[1].source.join('')!=='A\"hi\")'+String.fromCharCode(10)+'sZecond') throw Error('extended edit did not preserve notebook source');
      editor.cancel();
      editor.destroy();
      const owner=document.createElement('div'); owner.className='structured-view'; const host=document.createElement('div'); document.body.append(host); host.append(owner); owner.append(root);
      registerSuggestionSurface(owner,surface);
      const bar=document.createElement('div'); document.body.append(bar);
      const entries=[{kind:'open',id:'metadata-edit',author:'reader@example.test',version:1,createdAt:'2026-01-01T00:00:00Z',body:'test',displayName:null,anchor:{kind:'source',exact:'nbformat'},suggestion:{mode:'replace',replacement:'LEAK'}},{kind:'open',id:'output-edit',author:'reader@example.test',version:1,createdAt:'2026-01-01T00:00:01Z',body:'test',displayName:null,anchor:{kind:'source',exact:'stdout'},suggestion:{mode:'replace',replacement:'OUTPUTLEAK'}},{kind:'open',id:'code-edit',author:'reader@example.test',version:1,createdAt:'2026-01-01T00:00:02Z',body:'test',displayName:null,anchor:{kind:'source',exact:'print('},suggestion:{mode:'replace',replacement:'VALID'}}];
      entries.push({kind:'open',id:'bidi-edit',author:'reader@example.test',version:1,createdAt:'2026-01-01T00:00:03Z',body:'test',displayName:null,anchor:{kind:'source',exact:'hi'},suggestion:{mode:'replace',replacement:escapedBidi}});
      const controller=mountSuggestionController({view:{route:'notebook',filename:'test.ipynb',version:1,currentVersion:1,document:{bytes:new TextEncoder().encode(source),truncated:false}},host,bar,relicId:'test',deps:{serviceOrigin:location.origin,fetch},session:()=>({kind:'verified',email:'reader@example.test'}),cipher:()=>({seal:async()=>'',open:async()=>({})}),entries:()=>entries,displayName:()=>null,refresh:async()=>{},readCurrentVersion:async()=>1,repaint(){},signIn(){},open(){}});
      controller.repaint(()=>{});
      if (root.textContent.includes('LEAK') || !root.textContent.includes('VALID')) throw Error('metadata painted or code suggestion missing');
      if (root.textContent.includes(String.fromCharCode(0x202e))) throw Error('decoded bidi edit painted inline');
      const bidiCard=controller.card(entries[entries.length-1]);
      if (!bidiCard?.textContent.includes(escapedBidi) || entries[entries.length-1].suggestion.replacement !== escapedBidi) throw Error('thread lost the raw suggestion');
      const hi=[...root.querySelectorAll('[data-seg]')].find(node=>node.textContent==='hi');
      const hiRange=document.createRange(); hiRange.selectNodeContents(hi); selection.removeAllRanges(); selection.addRange(hiRange);
      controller.setSuggesting(true,hiRange);
      if (selection.toString()!=='hi') throw Error('selection shifted by earlier tracked insertion: '+selection.toString());
      controller.setSuggesting(false);
      controller.destroy();
      const crlfSource=JSON.stringify({nbformat:4,cells:[{cell_type:'code',source:'one'+String.fromCharCode(13,10)+'two',outputs:[]},{cell_type:'markdown',source:'alpha'+String.fromCharCode(0xa0,10)+'beta'}]});
      const crlfNotebook=parseNotebook(crlfSource); if (!crlfNotebook.ok) throw Error('CRLF fixture refused');
      const another=document.createElement('div'); another.innerHTML='<div class=\"nb-cell\" data-cell=\"0\"><div class=\"nb-box\"><pre class=\"nb-src\"></pre></div></div><div class=\"nb-cell\" data-cell=\"1\"><div class=\"nb-box\"><article class=\"prose\"></article></div></div>';
      const anotherSurface=notebookSuggestionSurface(another,crlfNotebook.notebook); const crlfSegments=anotherSurface.segments(crlfSource);
      const first=crlfSegments.find(s=>s.text==='one'); const last=crlfSegments.find(s=>s.text==='two');
      if (!first || !last || !anotherSurface.covers(first.start,last.end)) throw Error('escaped CRLF cell unavailable');
      document.body.append(another); const crlfEditor=mountSuggestEditor({root:another,source:crlfSource,segments:crlfSegments,delimiters:[],version:1,reader:'reader@example.test',chrome,surface:anotherSurface,onCommit(){},onDraftChange(){},onRefusal(){}});
      crlfEditor.setSuggesting(true); select(another.querySelector('[data-seg=\"'+crlfSegments.indexOf(first)+'\"]'));
      another.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'A'}));
      const lastNode=another.querySelector('[data-seg=\"'+crlfSegments.indexOf(last)+'\"]').firstChild, lastCaret=document.createRange(); lastCaret.setStart(lastNode,1); lastCaret.collapse(true); selection.removeAllRanges(); selection.addRange(lastCaret);
      another.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'Z'}));
      if (crlfEditor.draft?.inserted!=='A'+String.fromCharCode(13,10)+'tZ') throw Error('retained CRLF was refused');
      const crlfDraft=crlfEditor.draft, crlfCommit=crlfEditor.prepare();
      if (crlfCommit.kind!=='save' || JSON.parse(crlfSource.slice(0,crlfDraft.start)+crlfCommit.plaintext.suggestion.replacement+crlfSource.slice(crlfDraft.end)).cells[0].source!=='A'+String.fromCharCode(13,10)+'tZwo') throw Error('retained CRLF changed');
      const crlfIns=another.querySelector('ins[data-sg-draft]'), crlfText=crlfIns.firstChild, imeCaret=document.createRange();
      imeCaret.setStart(crlfText,crlfText.length); imeCaret.collapse(true); selection.removeAllRanges(); selection.addRange(imeCaret);
      another.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      const composition=another.querySelector('ins[data-sg-draft]'); composition.firstChild.nodeValue += '漢';
      await Promise.resolve(); await Promise.resolve();
      if (crlfEditor.draft?.inserted!=='A'+String.fromCharCode(13,10)+'tZ漢') throw Error('IME rejected retained CRLF');
      another.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
      crlfEditor.cancel(); crlfEditor.destroy();
      const alpha=crlfSegments.find(s=>s.text==='alpha'); const beta=crlfSegments.find(s=>s.text==='beta');
      if (!alpha || !beta || !anotherSurface.covers(alpha.start,beta.end)) throw Error('markdown soft break unmapped');
      const emptySource=JSON.stringify({nbformat:4,cells:[{cell_type:'code',source:'prefix',outputs:[]},{cell_type:'code',source:[],outputs:[]}]});
      const emptyNotebook=parseNotebook(emptySource), emptyRoot=document.createElement('div'); emptyRoot.innerHTML='<div class=\"nb-cell\" data-cell=\"0\"><div class=\"nb-box\"><pre class=\"nb-src\"></pre></div></div><div class=\"nb-cell\" data-cell=\"1\"><div class=\"nb-box\"><pre class=\"nb-src\"></pre></div></div>'; document.body.append(emptyRoot);
      const emptySurface=notebookSuggestionSurface(emptyRoot,emptyNotebook.notebook), emptySegments=emptySurface.segments(emptySource);
      if (emptySegments.length!==2) throw Error('empty source array has no edit anchor');
      const emptySegment=emptySegments[1];
      const emptyEditor=mountSuggestEditor({root:emptyRoot,source:emptySource,segments:emptySegments,delimiters:[],version:1,reader:'reader@example.test',chrome,surface:emptySurface,onCommit(){},onDraftChange(){},onRefusal(){}});
      const blankPre=emptyRoot.querySelector('.nb-cell[data-cell=\"1\"] .nb-src'); blankPre.style.cssText='display:block;padding:10px 14px;font:13px/1.6 monospace;white-space:pre'; blankPre.scrollIntoView();
      let trustedInput=false; emptyRoot.addEventListener('beforeinput',event=>{if(event.isTrusted && event.data==='hello \"world\"') trustedInput=true;});
      emptyEditor.setSuggesting(true);
      const blankRect=blankPre.getBoundingClientRect();
      const click=await fetch('/trusted-click?x='+(blankRect.left+15)+'&y='+(blankRect.top+10));
      if(!click.ok) throw Error('trusted blank-cell click failed: '+await click.text());
      if (!trustedInput) throw Error('blank-cell typing did not use a trusted event');
      const emptyCommit=emptyEditor.prepare(); if(emptyCommit.kind!=='save') throw Error('trusted blank-cell typing refused: '+chrome.textContent);
      const emptyPos=emptySegment.start, inserted=emptyCommit.plaintext.suggestion.replacement;
      if (emptyCommit.plaintext.suggestion.mode!=='after' || emptyCommit.plaintext.anchor.exact!=='[' || emptySurface.decode(emptySegment.block,inserted)!=='hello \"world\"') throw Error('empty source anchor or painting decode wrong');
      if (typeof emptySurface.decode(emptySegment.block,'42')!=='string') throw Error('empty array decoder returned non-string');
      if (JSON.parse(emptySource.slice(0,emptyPos)+inserted+emptySource.slice(emptyPos)).cells[1].source[0]!=='hello \"world\"') throw Error('empty source suggestion broke JSON');
      if (emptySurface.covers(emptyPos,emptyPos,'42') || emptySurface.covers(emptyPos,emptyPos,'null') || !emptySurface.covers(emptyPos,emptyPos,inserted)) throw Error('invalid empty array replacement painted');
      if (emptySurface.covers(emptyPos,emptyPos,'\"'+escapedBidi+'\"')) throw Error('escaped invisible empty-cell insertion admitted');
      const tabSource=JSON.stringify({nbformat:4,cells:[{cell_type:'raw',source:'alpha'+String.fromCharCode(9)+'beta'}]});
      const tabNotebook=parseNotebook(tabSource), tabRoot=document.createElement('div'); tabRoot.innerHTML='<div class=\"nb-cell\" data-cell=\"0\"><div class=\"nb-box\"><pre class=\"nb-src\"></pre></div></div>'; document.body.append(tabRoot);
      const tabSurface=notebookSuggestionSurface(tabRoot,tabNotebook.notebook), tabSegments=tabSurface.segments(tabSource);
      const tabEditor=mountSuggestEditor({root:tabRoot,source:tabSource,segments:tabSegments,delimiters:[],version:1,reader:'reader@example.test',chrome,surface:tabSurface,onCommit(){},onDraftChange(){},onRefusal(){}});
      tabEditor.setSuggesting(true); select(tabRoot.querySelector('[data-seg=\"0\"]')); tabRoot.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'A'}));
      const betaPart=tabSegments.find(s=>s.text==='beta'), betaNode=tabRoot.querySelector('[data-seg=\"'+tabSegments.indexOf(betaPart)+'\"]').firstChild, betaCaret=document.createRange();
      betaCaret.setStart(betaNode,1); betaCaret.collapse(true); selection.removeAllRanges(); selection.addRange(betaCaret);
      tabRoot.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'Z'}));
      if (tabEditor.draft?.inserted!=='A'+String.fromCharCode(9)+'bZ') throw Error('retained tab was refused');
      const oldTabDraft=tabEditor.draft.inserted; tabRoot.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:String.fromCharCode(9)}));
      if (tabEditor.draft?.inserted!==oldTabDraft) throw Error('new tab accepted in raw cell'); tabEditor.cancel();tabEditor.destroy();
      emptyEditor.cancel();emptyEditor.destroy();
      const emptyHost=document.createElement('div'), emptyOwner=document.createElement('div'), emptyBar=document.createElement('div');
      emptyOwner.className='structured-view'; emptyHost.append(emptyOwner); emptyOwner.append(emptyRoot); document.body.append(emptyHost,emptyBar);
      registerSuggestionSurface(emptyOwner,emptySurface); let captured;
      const bad=[{kind:'open',id:'source-only',author:'reader@example.test',version:1,createdAt:'2026-01-01T00:00:00Z',body:'test',displayName:null,anchor:{kind:'source',exact:'[',prefix:emptySource.slice(0,emptyPos-1),suffix:emptySource.slice(emptyPos)},suggestion:{mode:'after',replacement:'\"alpha\",\"beta\"'}}];
      const emptyController=mountSuggestionController({view:{route:'notebook',filename:'test.ipynb',version:1,currentVersion:1,document:{bytes:new TextEncoder().encode(emptySource),truncated:false}},host:emptyHost,bar:emptyBar,relicId:'test',deps:{serviceOrigin:location.origin,fetch:async()=>Response.json({comment_id:'x'})},session:()=>({kind:'verified',email:'reader@example.test'}),cipher:()=>({seal:async value=>{captured=value;return 'sealed'},open:async()=>({})}),entries:()=>bad,displayName:()=>null,refresh:async()=>{},readCurrentVersion:async()=>1,repaint(){},signIn(){},open(){}});
      emptyController.repaint(()=>{}); if(emptyRoot.querySelector('ins[data-sg]')) throw Error('incompatible Source suggestion was painted');
      emptyController.setSuggesting(true); select(emptyRoot.querySelector('.nb-cell[data-cell=\"1\"] [data-seg]'));
      emptyRoot.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'X'}));
      for(let i=0;i<20 && !captured;i++) await Promise.resolve();
      if(captured?.suggestion?.replacement!=='\"X\"') throw Error('incompatible Source suggestion reopened as draft: '+JSON.stringify(captured));
      emptyController.setSuggesting(false);emptyController.destroy();
      const bidiSource=JSON.stringify({nbformat:4,cells:[{cell_type:'code',source:'left'+String.fromCharCode(0x202e)+'right',outputs:[]},{cell_type:'code',source:'other',outputs:[]}]});
      const bidiNotebook=parseNotebook(bidiSource), bidiRoot=document.createElement('div');
      bidiRoot.innerHTML='<div class=\"nb-cell\" data-cell=\"0\"><div class=\"nb-box\"><pre class=\"nb-src\">left[U+202E]right</pre></div></div><div class=\"nb-cell\" data-cell=\"1\"><div class=\"nb-box\"><pre class=\"nb-src\"></pre></div></div>';
      document.body.append(bidiRoot); const bidiSurface=notebookSuggestionSurface(bidiRoot,bidiNotebook.notebook); const bidiSegments=bidiSurface.segments(bidiSource);
      const bidiEditor=mountSuggestEditor({root:bidiRoot,source:bidiSource,segments:bidiSegments,delimiters:[],version:1,reader:'reader@example.test',chrome,surface:bidiSurface,onCommit(){},onDraftChange(){},onRefusal(){}});
      bidiEditor.setSuggesting(true); select(bidiRoot.querySelector('.nb-cell[data-cell=\"0\"] pre'));
      bidiRoot.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'x'}));
      if (bidiEditor.draft) throw Error('unmapped cell input changed another cell'); bidiEditor.destroy();
      await fetch('/result',{method:'POST',body:'ok'});
    } catch (error) { await fetch('/result',{method:'POST',body:error.stack || String(error)}); }
  </script>`;
  async function trustedClick(x: number, y: number): Promise<void> {
    const port = (
      await Bun.file(join(profile, 'DevToolsActivePort')).text()
    ).split('\n')[0];
    const targets = (await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((item) => item.type === 'page');
    if (!target) throw new Error('headless page target missing');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error('CDP connection failed'));
    await opened.promise;
    let id = 0;
    const send = (method: string, params: object) => {
      const done = Promise.withResolvers<void>();
      const current = ++id;
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          error?: { message: string };
        };
        if (message.id !== current) return;
        socket.removeEventListener('message', listener);
        if (message.error) done.reject(new Error(message.error.message));
        else done.resolve();
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id: current, method, params }));
      return done.promise;
    };
    try {
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.insertText', { text: 'hello "world"' });
    } finally {
      socket.close();
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/trusted-click') {
        const url = new URL(request.url);
        try {
          await trustedClick(
            Number(url.searchParams.get('x')),
            Number(url.searchParams.get('y'))
          );
          return new Response('ok');
        } catch (error) {
          return new Response(String(error), { status: 500 });
        }
      }
      if (path === '/entry.js')
        return new Response(js, {
          headers: { 'content-type': 'text/javascript' },
        });
      if (path === '/result') {
        result.resolve(await request.text());
        return new Response('ok');
      }
      return new Response(page, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  const browser = spawn(
    shell,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-debugging-port=0',
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
