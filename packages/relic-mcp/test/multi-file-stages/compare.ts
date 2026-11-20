import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  findHeadlessShell,
  chromeRequired,
} from '../../../relic-viewer/test/headless-shell.ts';
import { connectPipe } from '../../src/cover/cdp.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, type PublishDeps } from '../../src/publish.ts';
import { republish } from '../../src/republish.ts';

const chrome = findHeadlessShell();
if (!chrome) {
  if (chromeRequired) throw new Error('Headless Chrome is required');
  console.log('MULTI_FILE_STAGE compare SKIP (headless shell missing)');
} else {
  const temp = await mkdtemp(join(tmpdir(), 'relic-compare-path-'));
  const prior = process.env.RELIC_PUBLISH_STATE;
  process.env.RELIC_PUBLISH_STATE = join(temp, 'state.json');
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      handler ? handler(request) : new Response('not ready', { status: 503 }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const storage = new MemoryStorage(`${origin}/__storage`);
  const app = createApp({
    config: {
      serviceOrigin: origin,
      usercontentOrigin: `http://localhost:${server.port}`,
    },
    store: new MemoryStore(),
    storage,
    assets: diskAssets(
      new URL('../../../relic-viewer/dist', import.meta.url).pathname
    ),
  });
  handler = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__storage/o/')) {
      const bytes = await storage.read(path.slice('/__storage/o/'.length));
      return bytes
        ? new Response(bytes as unknown as BodyInit)
        : new Response(null, { status: 404 });
    }
    return app.fetch(request);
  };
  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    clientName: 'compare-path',
    files: nodeFiles,
    fetch: globalThis.fetch,
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test',
    }),
    upload: async (url, _headers, bytes) => {
      storage.put(
        new URL(url).pathname.replace(/^\/__storage\/upload\//, ''),
        bytes
      );
      return { status: 200 };
    },
  };
  const child = spawn(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--remote-debugging-pipe',
      `--user-data-dir=${join(temp, 'profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  try {
    const root = join(temp, 'files');
    await mkdir(root);
    await writeFile(join(root, 'a.md'), '# Before\n\nOriginal passage.\n');
    await writeFile(join(root, 'removed.txt'), 'removed');
    await writeFile(join(root, 'same.txt'), 'same');
    const initial = await publish({ path: root, cover: false }, deps);
    await writeFile(join(root, 'a.md'), '# After\n\nChanged passage.\n');
    await rm(join(root, 'removed.txt'));
    await writeFile(join(root, 'added.txt'), 'added');
    await republish(
      { relic_id: initial.relic_id, path: root, cover: false, notify: false },
      deps
    );
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
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      session
    );
    await cdp.send('Page.navigate', { url: initial.url }, session);
    async function evaluate(expression: string): Promise<unknown> {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        session
      );
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      const value = result.result;
      if (!value || typeof value !== 'object' || !('value' in value))
        throw new Error('CDP returned no value');
      return value.value;
    }
    const opened = await evaluate(
      `(async()=>{for(let i=0;i<500;i++){if(document.querySelector('.folder-row')) return true;await new Promise(r=>setTimeout(r,20))}return false})()`
    );
    assert.equal(opened, true, 'folder opens');
    const clicked = await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Compare versions'));if(!b)return false;b.click();return true})()`
    );
    assert.equal(clicked, true, 'comparison button exists');
    const list = await evaluate(
      `(async()=>{for(let i=0;i<500;i++){const r=document.querySelector('.diff-result');if(r?.querySelector('button'))return [...r.querySelectorAll('li')].map(x=>x.textContent);await new Promise(r=>setTimeout(r,20))}return null})()`
    );
    assert.deepEqual(list, [
      'changed: a.md',
      'added: added.txt',
      'removed: removed.txt',
      'unchanged: same.txt',
    ]);
    const diff = await evaluate(
      `(async()=>{const b=[...document.querySelectorAll('.diff-result button')].find(x=>x.textContent==='changed: a.md');b.click();for(let i=0;i<500;i++){if(document.querySelector('.diff-view-markdown'))return document.querySelector('.diff-view-markdown').innerText;await new Promise(r=>setTimeout(r,20))}return ''})()`
    );
    assert.ok(
      typeof diff === 'string' &&
        diff.includes('Rendered comparison') &&
        diff.includes('Original passage') &&
        diff.includes('Changed passage')
    );
    assert.equal(
      await evaluate(`document.querySelector('.diff-result details').open`),
      false,
      'unchanged files begin collapsed'
    );
    const largeRoot = join(temp, 'large-files');
    await mkdir(largeRoot);
    await writeFile(join(largeRoot, 'a.md'), '# Small entry\n');
    const bulk = await open(join(largeRoot, 'bulk.bin'), 'w');
    const chunk = new Uint8Array(1024 * 1024);
    try {
      for (let i = 0; i < 99; i++) await bulk.write(chunk);
    } finally {
      await bulk.close();
    }
    const large = await publish(
      { path: largeRoot, cover: false, open_first: 'a.md' },
      deps
    );
    const extra = await open(join(largeRoot, 'bulk.bin'), 'a');
    try {
      for (let i = 0; i < 21; i++) await extra.write(chunk);
    } finally {
      await extra.close();
    }
    await republish(
      {
        relic_id: large.relic_id,
        path: largeRoot,
        cover: false,
        notify: false,
        open_first: 'a.md',
      },
      deps
    );
    await cdp.send('Page.navigate', { url: large.url }, session);
    assert.equal(
      await evaluate(
        `(async()=>{for(let i=0;i<3000;i++){document.querySelector('[data-large-open-accept]')?.click();if(document.body?.innerText.includes('100 MiB folder comparison limit'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
      ),
      true,
      '120 MiB folder shows the limit'
    );
    assert.equal(
      await evaluate(
        `(async()=>{document.querySelector('.version-trigger')?.click();document.querySelector('.version-option[data-version="1"]')?.click();for(let i=0;i<3000;i++){document.querySelector('[data-large-open-accept]')?.click();if(document.querySelector('.folder-row') && document.querySelector('.version-long')?.textContent.includes('Version 1'))return !document.body.innerText.includes('100 MiB folder comparison limit');await new Promise(r=>setTimeout(r,20))}return false})()`
      ),
      true,
      '99 MiB folder has no limit notice'
    );
    console.log('MULTI_FILE_STAGE compare OK');
  } finally {
    cdp.dispose();
    child.kill();
    server.stop(true);
    if (prior === undefined) delete process.env.RELIC_PUBLISH_STATE;
    else process.env.RELIC_PUBLISH_STATE = prior;
    await rm(temp, { recursive: true, force: true });
  }
}
