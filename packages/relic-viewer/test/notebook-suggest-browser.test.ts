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
  const notebook = resolve(
    import.meta.dir,
    '../../relic-format/src/notebook.ts'
  );
  await writeFile(
    entry,
    `export { notebookSuggestionSurface, notebookAcceptsSelection } from ${JSON.stringify(suggest)}; export { parseNotebook } from ${JSON.stringify(notebook)}; export { mountSuggestEditor } from ${JSON.stringify(editorModule)};`
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
    import {notebookSuggestionSurface, notebookAcceptsSelection, parseNotebook, mountSuggestEditor} from '/entry.js';
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
      const newline = segments.find(s => s.text === '\\n');
      if (!newline || newline.kind !== 'escape') throw Error('newline escape mapping');
      if (root.querySelectorAll('[data-seg]').length !== segments.length) throw Error('segment layout');
      const typed = '\"' + String.fromCharCode(92, 10);
      const insertion = surface.encode(smile.block, typed, smile.start, smile.end);
      if (!insertion.ok) throw Error('source edit refused');
      const changed = source.slice(0, smile.start) + insertion.source + source.slice(smile.end);
      if (JSON.parse(changed).cells[0].source[0] !== 'Hello ' + typed + String.fromCharCode(10)) throw Error('replacement was not JSON escaped');
      const next = segments.find(s => s.text === 'next line');
      if (!next || surface.encode(smile.block, 'x', smile.start, next.end).ok) throw Error('cross-string edit accepted');
      if (notebookAcceptsSelection(root, root.querySelector('.nb-out').firstChild) === true) throw Error('output accepted');
      if (notebookAcceptsSelection(root, root.querySelector('[data-seg]').firstChild) !== true) throw Error('source refused');
      let refusal = '';
      const chrome = document.createElement('div'); document.body.append(chrome);
      const editor = mountSuggestEditor({root,source,segments,delimiters:[],version:1,reader:'reader@example.test',chrome,surface,onCommit(){},onDraftChange(){},onRefusal(message){refusal=message;}});
      if (!editor.setSuggesting(true)) throw Error('could not start editor');
      const select = node => { const range=document.createRange(); range.selectNodeContents(node); const selection=document.getSelection(); selection.removeAllRanges(); selection.addRange(range); };
      select(root.querySelector('.nb-out'));
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'x'}));
      if (editor.draft || !refusal.includes('Only notebook cell source')) throw Error('output editing was not refused');
      select(root.querySelector('[data-seg=\"' + segments.indexOf(smile) + '\"]'));
      root.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:typed}));
      const prepared=editor.prepare();
      if (prepared.kind !== 'save' || prepared.plaintext.suggestion.replacement !== insertion.source) throw Error('editor did not commit escaped text');
      editor.destroy();
      await fetch('/result',{method:'POST',body:'ok'});
    } catch (error) { await fetch('/result',{method:'POST',body:error.stack || String(error)}); }
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
