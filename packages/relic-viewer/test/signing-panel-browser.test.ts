import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cache = join(process.env['HOME'] ?? '', 'Library/Caches/ms-playwright');
const installed = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
      .map((name) =>
        join(
          cache,
          name,
          'chrome-headless-shell-mac-arm64/chrome-headless-shell'
        )
      )
      .find(existsSync)
  : undefined;
const shell = process.env['RELIC_CHROME_PATH'] ?? installed;

test.skipIf(!shell)(
  'signer consent, digest guard and synchronous passkey click',
  async () => {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, 'signing-panel-cases.ts')],
      target: 'browser',
      format: 'esm',
    });
    if (!build.success) throw new Error(build.logs.map(String).join('\n'));
    const source = await build.outputs[0]!.text();
    const result = Promise.withResolvers<{ error?: string }>();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/case.js')
          return new Response(source, {
            headers: { 'content-type': 'text/javascript' },
          });
        if (url.pathname === '/result') {
          result.resolve(await req.json());
          return new Response('ok');
        }
        return new Response(
          `<script type="module">import {signerCases} from '/case.js'; try {await signerCases(); await fetch('/result',{method:'POST',body:'{}'});} catch(e) {await fetch('/result',{method:'POST',body:JSON.stringify({error:e.stack||String(e)})});}</script>`,
          { headers: { 'content-type': 'text/html' } }
        );
      },
    });
    const profile = join(tmpdir(), `relik-signing-test-${crypto.randomUUID()}`);
    const browser = spawn(
      shell!,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${server.port}/`,
      ],
      { stdio: 'ignore' }
    );
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => timeout.reject(new Error('signer browser did not report')),
      30000
    );
    try {
      const outcome = await Promise.race([result.promise, timeout.promise]);
      if (outcome.error) throw new Error(outcome.error);
      expect(outcome.error).toBeUndefined();
    } finally {
      clearTimeout(timer);
      browser.kill('SIGKILL');
      if (browser.exitCode === null && browser.signalCode === null)
        await once(browser, 'exit');
      server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  60000
);
