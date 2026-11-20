import { expect, test as bunTest } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as Suggestion from '../src/suggest-controller.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';
import { chromeRequired, findHeadlessShell } from './headless-shell.ts';

const shell = findHeadlessShell();
const test = bunTest.skipIf(!shell && !chromeRequired);

async function notebookSourceCase(module: typeof Suggestion): Promise<void> {
  const source = '{"nbformat":4,"cells":[]}';
  const host = document.createElement('div');
  const code = document.createElement('div');
  code.className = 'code';
  const root = document.createElement('pre');
  root.className = 'code-body';
  root.textContent = source;
  code.append(root);
  host.append(code);
  const bar = document.createElement('div');
  document.body.append(host, bar);
  const view = {
    route: 'notebook',
    filename: 'example.ipynb',
    declaredMimetype: 'application/x-ipynb+json',
    version: 1,
    currentVersion: 1,
    document: { bytes: new TextEncoder().encode(source), truncated: false },
  } as unknown as ReadyView;
  const controller = module.mountSuggestionController({
    view,
    host,
    bar,
    relicId: 'notebook-source-test',
    deps: { serviceOrigin: location.origin, fetch } as unknown as ViewerDeps,
    session: () => ({ kind: 'verified', email: 'reader@example.test' }),
    cipher: () => ({
      seal: async () => 'sealed',
      open: async () => ({ body: '', display_name: null, anchor: null }),
    }),
    entries: () => [],
    displayName: () => null,
    refresh: async () => undefined,
    readCurrentVersion: async () => 1,
    repaint() {},
    signIn() {},
    open() {},
  });
  controller.setSuggesting(true);
  if (!controller.suggesting)
    throw new Error('notebook Source cannot enter suggesting mode');
  const text = root.firstChild;
  if (!text) throw new Error('notebook Source text disappeared');
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 4);
  const selection = document.getSelection();
  if (!selection) throw new Error('missing selection');
  selection.removeAllRanges();
  selection.addRange(range);
  const input = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: 'x',
  });
  root.dispatchEvent(input);
  if (!input.defaultPrevented || !controller.draftOpen)
    throw new Error('notebook Source did not create a suggestion draft');
}

test('notebook Source enables suggestion drafts on its code root', async () => {
  if (!shell) throw new Error('A headless Chrome executable is required');
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../src/suggest-controller.ts')],
    target: 'browser',
    format: 'esm',
    splitting: false,
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const js = await build.outputs[0]!.text();
  const result = Promise.withResolvers<{ error?: string }>();
  const page = `<!doctype html><script type="module">
    import * as controller from '/controller.js';
    try { await (${notebookSourceCase.toString()})(controller); await fetch('/result', {method:'POST', body:'{}'}); }
    catch (e) { await fetch('/result', {method:'POST', body:JSON.stringify({error: e?.stack || String(e)})}); }
  </script>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/result') {
        result.resolve((await request.json()) as { error?: string });
        return new Response('ok');
      }
      if (path === '/controller.js')
        return new Response(js, {
          headers: { 'content-type': 'text/javascript' },
        });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  const profile = join(
    tmpdir(),
    `relic-notebook-suggestion-${crypto.randomUUID()}`
  );
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
