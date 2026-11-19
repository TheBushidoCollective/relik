import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// The notebook view, driven in an isolated headless browser: a throwaway profile,
// the page served over loopback, and the browser stopped afterwards. The cases
// (notebook-view-cases.ts) run as a module the page imports, through the
// structured-view bridge the route uses, so the anchor a reader gets is the one a
// comment is written with. Nothing here is Jason's browser.

function findHeadlessShell(): string | undefined {
  const configured = process.env['RELIC_CHROME_PATH'];
  if (configured && existsSync(configured)) return configured;
  const base = join(process.env['HOME'] ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const version of versions) {
      const path = join(
        base,
        version,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell'
      );
      if (existsSync(path)) return path;
    }
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
}

const shell = findHeadlessShell();
describe('the notebook view in the browser', () => {
  test.skipIf(!shell)(
    'draws cells and outputs, paints marks, and refuses hostile markup',
    async () => {
      const build = await Bun.build({
        entrypoints: [
          resolve(import.meta.dir, '../src/structured-view-bridge.ts'),
          resolve(import.meta.dir, '../src/notebook-view.ts'),
          resolve(import.meta.dir, './notebook-view-cases.ts'),
        ],
        target: 'browser',
        format: 'esm',
        splitting: false,
      });
      if (!build.success) throw new Error(build.logs.map(String).join('\n'));
      const modules = new Map<string, string>();
      for (const output of build.outputs)
        modules.set(`/${output.path.split('/').at(-1)}`, await output.text());
      const css = readFileSync(
        resolve(import.meta.dir, '../src/notebook-view.css'),
        'utf8'
      );
      const seen: string[] = [];
      const started: string[] = [];
      const stderr = { tail: '' };
      const { promise, resolve: report } = Promise.withResolvers<{
        passed?: string[];
        error?: string;
      }>();
      const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/notebook-view.css"><script type="module">
      import * as bridge from '/structured-view-bridge.js';
      import { browserCases, fixtures } from '/notebook-view-cases.js';
      try { const passed = await browserCases(bridge, fixtures, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {})); await fetch('/result', {method: 'POST', body: JSON.stringify({passed})}); }
      catch (error) { await fetch('/result', {method: 'POST', body: JSON.stringify({error: error && (error.stack || error.message) || String(error)})}); }
    </script>`;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          seen.push(`${request.method} ${url.pathname}`);
          if (url.pathname === '/progress') {
            started.push(await request.text());
            return new Response('ok');
          }
          if (url.pathname === '/result') {
            report(
              (await request.json()) as { passed?: string[]; error?: string }
            );
            return new Response('ok');
          }
          if (url.pathname === '/assets/notebook-view.css')
            return new Response(css, {
              headers: { 'content-type': 'text/css' },
            });
          const module = modules.get(url.pathname);
          if (module !== undefined)
            return new Response(module, {
              headers: { 'content-type': 'text/javascript' },
            });
          return new Response(page, {
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      const profile = join(
        tmpdir(),
        `relic-notebook-view-${crypto.randomUUID()}`
      );
      const browser = spawn(
        shell!,
        [
          basename(shell!).includes('headless-shell')
            ? '--headless'
            : '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--mute-audio',
          `http://127.0.0.1:${server.port}/`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      browser.stderr?.on('data', (chunk: Buffer) => {
        stderr.tail = (stderr.tail + chunk.toString('utf8')).slice(-4096);
      });
      try {
        const exited = Promise.withResolvers<never>();
        browser.once('error', exited.reject);
        browser.once('exit', (code) =>
          exited.reject(
            new Error(`headless browser exited before reporting: ${code}`)
          )
        );
        const stalled = Promise.withResolvers<never>();
        // A real timer on purpose: this drives a real browser, and a hang has no event to await.
        const stallTimer = setTimeout(() => {
          stalled.reject(
            new Error(
              `the page did not report within 60 s. requests seen: ${JSON.stringify(seen)}; ` +
                `cases started: ${JSON.stringify(started)}; stderr tail: ${JSON.stringify(stderr.tail)}`
            )
          );
        }, 60_000);
        let result: { passed?: string[]; error?: string };
        try {
          result = await Promise.race([
            promise,
            exited.promise,
            stalled.promise,
          ]);
        } finally {
          clearTimeout(stallTimer);
        }
        for (const line of started.filter((name) => name.startsWith('timing:')))
          console.log(line);
        if (result.error) throw new Error(result.error);
        expect(result.passed).toHaveLength(12);
      } finally {
        browser.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null) {
          await once(browser, 'exit');
        }
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    90000
  );
});
