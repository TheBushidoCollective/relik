import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { connectPipe } from '../../relic-mcp/src/cover/cdp.ts';

const chrome = process.env.RELIC_CHROME_PATH;
const available =
  !!chrome &&
  (process.platform !== 'darwin' || chrome.includes('headless-shell')) &&
  existsSync(chrome);

test.skipIf(!available)(
  'an old worker serves the new versioned viewer but the old unversioned viewer',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'relic-stale-worker-'));
    let generation = 'N';
    const oldWorker = `
    const shell = ['/assets/viewer.js'];
    self.addEventListener('install', event => event.waitUntil(caches.open('relic-shell-N').then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', event => {
      const url = new URL(event.request.url);
      if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || !shell.includes(url.pathname)) return;
      event.respondWith(caches.match(event.request).then(hit => hit ?? fetch(event.request)));
    });`;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const headers = { 'cache-control': 'no-store' };
        if (url.pathname === '/sw.js')
          return new Response(oldWorker, {
            headers: { ...headers, 'content-type': 'text/javascript' },
          });
        if (url.pathname === '/assets/viewer.js')
          return new Response(
            `window.generation = ${JSON.stringify(generation)}`,
            { headers: { ...headers, 'content-type': 'text/javascript' } }
          );
        if (url.pathname === '/setup')
          return new Response(
            '<body><script>navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => document.body.dataset.ready = "yes")</script></body>',
            { headers: { ...headers, 'content-type': 'text/html' } }
          );
        return new Response(
          `<script src="/assets/viewer.js${url.search ? '?v=N2' : ''}"></script>`,
          { headers: { ...headers, 'content-type': 'text/html' } }
        );
      },
    });
    const child = spawn(
      chrome!,
      [
        '--headless',
        '--no-sandbox',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    );
    const cdp = connectPipe(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable
    );
    try {
      const target = await cdp.send('Target.createTarget', {
        url: 'about:blank',
      });
      const attached = await cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      const session = attached.sessionId as string;
      await cdp.send('Page.enable', {}, session);
      await cdp.send('Runtime.enable', {}, session);
      async function navigate(path: string) {
        const loaded = cdp.waitForEvent('Page.loadEventFired', {
          sessionId: session,
          timeoutMs: 15000,
        });
        await cdp.send(
          'Page.navigate',
          { url: `http://127.0.0.1:${server.port}${path}` },
          session
        );
        await loaded;
      }
      async function evaluate(expression: string) {
        const result = await cdp.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          session
        );
        if (result.exceptionDetails)
          throw new Error(JSON.stringify(result.exceptionDetails));
        const value = result.result;
        if (!value || typeof value !== 'object' || !('value' in value)) {
          throw new Error('CDP returned no evaluation value');
        }
        return value.value;
      }
      await navigate('/setup');
      expect(
        await evaluate(
          `(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })); return true; })()`
        )
      ).toBe(true);
      generation = 'N2';
      await navigate('/aaaaaaaaaaaaaaaaaaaaaaaaaa?versioned');
      expect(
        await evaluate(
          'navigator.serviceWorker.controller !== null && window.generation'
        )
      ).toBe('N2');
      await navigate('/aaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(
        await evaluate(
          'navigator.serviceWorker.controller !== null && window.generation'
        )
      ).toBe('N');
    } finally {
      cdp.dispose();
      child.kill();
      server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  30000
);
