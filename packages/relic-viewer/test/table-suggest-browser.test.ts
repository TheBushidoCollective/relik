import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';
import type { CommentEntry } from '../src/comments.ts';
import type * as Csv from '@relic/format/csv';
import type * as Table from '../src/data-table.ts';
import type * as Source from '../src/table-source.ts';
import type * as Controller from '../src/suggest-controller.ts';
import type * as Views from '../src/suggestion-views.ts';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);

async function exercise(
  module: typeof Csv &
    typeof Table &
    typeof Source &
    typeof Controller &
    typeof Views
): Promise<void> {
  const source =
    'name,note\r\nZoe,quick fox\r\nAda,other\r\n' +
    Array.from({ length: 80 }, (_, i) => `User ${i},item ${i}\r\n`).join('');
  const parsed = module.parseTable(source, { delimiter: ',' });
  if (!parsed.ok) throw new Error('parse failed');
  const host = document.createElement('div');
  const tableRoot = document.createElement('div');
  tableRoot.className = 'structured-view structured-table';
  host.append(tableRoot);
  const bar = document.createElement('div');
  document.body.append(host, bar);
  const part = module.mountDataTable(
    tableRoot,
    module.csvTableSource(parsed.table),
    { filename: 'test.csv' }
  );
  const stylesheet =
    document.querySelector<HTMLLinkElement>('link[data-dt-css]')!;
  if (!stylesheet.sheet) {
    const loaded = Promise.withResolvers<void>();
    stylesheet.addEventListener('load', () => loaded.resolve(), { once: true });
    stylesheet.addEventListener(
      'error',
      () => loaded.reject(new Error('table CSS did not load')),
      { once: true }
    );
    await loaded.promise;
  }
  const view = {
    route: 'code',
    filename: 'test.csv',
    declaredMimetype: 'text/csv',
    version: 1,
    currentVersion: 1,
    document: { bytes: new TextEncoder().encode(source), truncated: false },
  } as unknown as ReadyView;
  let entries: CommentEntry[] = [];
  const controller = module.mountSuggestionController({
    view,
    host,
    bar,
    relicId: 'test',
    deps: { serviceOrigin: location.origin, fetch } as unknown as ViewerDeps,
    session: () => ({ kind: 'verified', email: 'reader@example.test' }),
    cipher: () => ({
      seal: async () => 'sealed',
      open: async () => ({ body: '', display_name: null, anchor: null }),
    }),
    entries: () => entries,
    displayName: () => null,
    refresh: async () => undefined,
    readCurrentVersion: async () => 1,
    repaint() {},
    signIn() {},
    open() {},
  });
  entries = ['rapid', 'fast'].map((replacement, index) => ({
    kind: 'open',
    id: `change-${index}`,
    author: `person-${index}@example.test`,
    version: 1,
    createdAt: `2026-01-0${index + 1}T00:00:00Z`,
    body: '',
    displayName: null,
    anchor: { kind: 'source', exact: 'quick' },
    suggestion: { v: 1, mode: 'replace', replacement },
  }));
  entries.push({
    kind: 'open',
    id: 'other-cell',
    author: 'other@example.test',
    version: 1,
    createdAt: '2026-01-03T00:00:00Z',
    body: '',
    displayName: null,
    anchor: { kind: 'source', exact: 'other' },
    suggestion: { v: 1, mode: 'replace', replacement: 'wrong-cell' },
  });
  let observed = '';
  tableRoot.addEventListener('relic:table-suggestion-views', (event) => {
    observed = JSON.stringify((event as CustomEvent).detail?.paint);
  });
  controller.sync();
  const grid = tableRoot.querySelector('.dt-grid') as HTMLElement;
  const cell = () =>
    tableRoot.querySelector('[data-r="1"][data-c="1"]') as HTMLElement;
  if (!cell()?.querySelector('.sg-chip'))
    throw new Error(`conflict badge missing: ${observed}`);
  cell().dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 })
  );
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  (tableRoot.querySelector('.dt-suggest') as HTMLButtonElement).click();
  controller.setSuggesting(true);
  const editor = tableRoot.querySelector('.dt-suggest-text') as HTMLElement;
  if (
    !editor ||
    !controller.suggesting ||
    !editor.textContent?.includes('fox') ||
    !editor.querySelector('.sg-chip')
  )
    throw new Error('editor did not open on selected cell');
  if (editor.textContent?.includes('wrong-cell'))
    throw new Error('another cell painted inside the editor');
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let text: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes('fox')) {
      text = node;
      break;
    }
  }
  if (!text) throw new Error('missing mapped text');
  const range = document.createRange();
  const start = text.textContent!.indexOf('fox');
  range.setStart(text, start);
  range.setEnd(text, start + 3);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const input = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: 'swift',
  });
  editor.dispatchEvent(input);
  if (!input.defaultPrevented || !controller.draftOpen)
    throw new Error('cell edit did not create draft');
  const header = tableRoot.querySelector(
    '[data-r="0"][data-c="0"]'
  ) as HTMLElement;
  header.click();
  grid.scrollTop = grid.scrollHeight;
  grid.dispatchEvent(new Event('scroll'));
  const firstFrame = Promise.withResolvers<void>();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => firstFrame.resolve())
  );
  await firstFrame.promise;
  if (!editor.isConnected || !editor.textContent?.includes('swift'))
    throw new Error('draft lost on sort or scroll');
  const original = tableRoot.querySelector('[data-r="1"][data-c="1"]');
  if (!original?.querySelector('.sg-chip'))
    throw new Error('badge missing from original cell after sort and scroll');
  grid.scrollTop = 0;
  grid.dispatchEvent(new Event('scroll'));
  const secondFrame = Promise.withResolvers<void>();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => secondFrame.resolve())
  );
  await secondFrame.promise;
  part.dispose();
  controller.destroy();
}

test('table suggestions stay attached to source cells through sort and scroll', async () => {
  if (!shell) throw new Error('headless shell required');
  const src = resolve(import.meta.dir, '../src');
  const driver = `export {parseTable} from '${src}/../../relic-format/src/csv.ts'; export {mountDataTable} from '${src}/data-table.ts'; export {csvTableSource} from '${src}/table-source.ts'; export {mountSuggestionController} from '${src}/suggest-controller.ts'; export {buildSuggestionViews} from '${src}/suggestion-views.ts';`;
  const build = await Bun.build({
    entrypoints: ['table-test-entry'],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'entry',
        setup(builder) {
          builder.onResolve({ filter: /^table-test-entry$/ }, () => ({
            path: 'entry',
            namespace: 'table-test',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'table-test' }, () => ({
            contents: driver,
            loader: 'ts',
            resolveDir: src,
          }));
        },
      },
    ],
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const js = await build.outputs[0]!.text();
  const css = await Bun.file(resolve(src, 'data-table.css')).text();
  const result = Promise.withResolvers<{ error?: string }>();
  const page = `<!doctype html><script type="module">import * as m from '/test.js';try { await (${exercise.toString()})(m); await fetch('/result',{method:'POST',body:'{}'}); } catch(e) { await fetch('/result',{method:'POST',body:JSON.stringify({error:e?.stack||String(e)})}); }</script>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/result') {
        result.resolve((await request.json()) as { error?: string });
        return new Response('ok');
      }
      if (path === '/assets/data-table.css')
        return new Response(css, { headers: { 'content-type': 'text/css' } });
      if (path === '/test.js')
        return new Response(js, {
          headers: { 'content-type': 'text/javascript' },
        });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  const profile = join(tmpdir(), `relic-table-suggest-${crypto.randomUUID()}`);
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
      exited.reject(new Error(`browser exited: ${code}`))
    );
    const outcome = await Promise.race([result.promise, exited.promise]);
    expect(outcome.error).toBeUndefined();
  } finally {
    browser.kill('SIGKILL');
    if (browser.exitCode === null && browser.signalCode === null)
      await once(browser, 'exit');
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}, 60_000);
