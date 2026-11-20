// Each version is published through the in-memory service before the viewer opens it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  chromeRequired,
  findHeadlessShell,
} from '../../../relic-viewer/test/headless-shell.ts';
import { compareFolderFiles } from '../../../relic-viewer/src/folder-compare.ts';
import { createVersionStore } from '../../../relic-viewer/src/version-store.ts';
import { load, type ViewerDeps } from '../../../relic-viewer/src/viewer.ts';
import { connectPipe } from '../../src/cover/cdp.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, type PublishDeps } from '../../src/publish.ts';
import { republish } from '../../src/republish.ts';

const temp = await mkdtemp(join(tmpdir(), 'relic-shape-switch-'));
const prior = process.env.RELIC_PUBLISH_STATE;
process.env.RELIC_PUBLISH_STATE = join(temp, 'state.json');
const chrome = findHeadlessShell();
if (!chrome) {
  if (chromeRequired) throw new Error('Headless Chrome is required');
  throw new Error('Headless Chrome is unavailable for shape-switch proof');
}
const calls: string[] = [];
let handler: ((request: Request) => Promise<Response>) | undefined;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) =>
    handler ? handler(request) : new Response('not ready', { status: 503 }),
});
const origin = `http://127.0.0.1:${server.port}`;
try {
  const first = join(temp, 'a.md');
  const root = join(temp, 'folder');
  await mkdir(root);
  await writeFile(first, '# first\n');
  await writeFile(join(root, 'a.md'), '# second\n');
  await writeFile(join(root, 'b.md'), 'added\n');
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
    calls.push(`${request.method} ${path}`);
    if (path.startsWith('/__storage/o/')) {
      const object = await storage.read(path.slice('/__storage/o/'.length));
      return object
        ? new Response(object as unknown as BodyInit)
        : new Response(null, { status: 404 });
    }
    return app.fetch(request);
  };
  const fetcher = globalThis.fetch;
  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    clientName: 'shape-switch-test',
    fetch: fetcher,
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
  const initial = await publish({ path: first, cover: false }, deps);
  assert.equal(initial.shape, 'file');
  const middle = await republish(
    { relic_id: initial.relic_id, path: root, cover: false, notify: false },
    deps
  );
  assert.equal(middle.shape, 'folder');
  await writeFile(first, '# third\n');
  const latest = await republish(
    { relic_id: initial.relic_id, path: first, cover: false, notify: false },
    deps
  );
  assert.equal(latest.shape, 'file');
  const fragment = new URL(initial.url).hash;
  const viewer: ViewerDeps = {
    serviceOrigin: origin,
    locationHref: initial.url,
    fetch: fetcher,
    secureContext: () => true,
    takeFragment: () => fragment,
    stripFragment() {},
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
  };
  const opened = await load(initial.relic_id, viewer);
  if (opened.kind !== 'ready')
    throw new Error(`latest failed: ${opened.dead.code}`);
  assert.equal(opened.view.version, 3);
  assert.equal(opened.view.folder, undefined);
  const versions = createVersionStore(initial.relic_id, opened.view, viewer);
  const one = await versions.get(1);
  const two = await versions.get(2);
  assert.equal(one.kind, 'ready');
  assert.equal(two.kind, 'ready');
  if (one.kind !== 'ready' || two.kind !== 'ready')
    throw new Error('history failed');
  assert.equal(one.view.folder, undefined);
  assert.ok(two.view.folder);
  assert.equal(two.view.folder.manifest.entries.length, 2);
  assert.deepEqual(
    (await compareFolderFiles(one.view, two.view, (name) => name)).map(
      ({ path, kind }) => [path, kind]
    ),
    [
      ['a.md', 'changed'],
      ['b.md', 'added'],
    ]
  );
  assert.deepEqual(
    (await compareFolderFiles(two.view, opened.view, (name) => name)).map(
      ({ path, kind }) => [path, kind]
    ),
    [
      ['a.md', 'changed'],
      ['b.md', 'removed'],
    ]
  );
  assert.equal(versions.shapeOf(1), 'file');
  assert.equal(versions.shapeOf(2), 'folder');
  assert.equal(versions.shapeOf(3), 'file');
  assert.ok(calls.some((path) => path.endsWith('/mint')));
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
    async function until(expression: string): Promise<void> {
      assert.equal(
        await evaluate(
          `(async()=>{for(let i=0;i<750;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,20))}return false})()`
        ),
        true,
        expression
      );
    }
    await until(
      "document.querySelector('.doc')?.textContent.includes('third') && document.querySelector('.version-trigger')"
    );
    const mintCount = (): number =>
      calls.filter((line) => line.endsWith('/mint')).length;
    const beforeList = mintCount();
    const unopened = await evaluate(
      `(()=>{document.querySelector('.version-trigger').click();return [...document.querySelectorAll('.version-option')].map(x=>x.textContent)})()`
    );
    assert.deepEqual(unopened, [
      'Version 3, current, file',
      'Version 2',
      'Version 1',
    ]);
    assert.equal(
      mintCount(),
      beforeList,
      'rendering unopened labels must not mint'
    );
    await evaluate(
      `(document.querySelector('.version-option[data-version="2"]').click(), true)`
    );
    await until(
      "document.querySelector('.folder-row[title=\"a.md\"]') && document.querySelector('.doc')?.textContent.includes('second')"
    );
    const afterTwo = mintCount();
    const knownTwo = await evaluate(
      `(()=>{document.querySelector('.version-trigger').click();return [...document.querySelectorAll('.version-option')].map(x=>x.textContent)})()`
    );
    assert.deepEqual(knownTwo, [
      'Version 3, current, file',
      'Version 2, folder',
      'Version 1',
    ]);
    assert.equal(mintCount(), afterTwo, 'rendering known labels must not mint');
    await evaluate(
      `(document.querySelector('.version-option[data-version="1"]').click(), true)`
    );
    await until(
      "!document.querySelector('.folder-row') && document.querySelector('.doc')?.textContent.includes('first')"
    );
    const afterOne = mintCount();
    const knownAll = await evaluate(
      `(()=>{document.querySelector('.version-trigger').click();return [...document.querySelectorAll('.version-option')].map(x=>x.textContent)})()`
    );
    assert.deepEqual(knownAll, [
      'Version 3, current, file',
      'Version 2, folder',
      'Version 1, file',
    ]);
    assert.equal(
      mintCount(),
      afterOne,
      'rendering the complete list must not mint'
    );
    await evaluate(
      `(document.querySelector('.version-option[data-version="3"]').click(), true)`
    );
    await until(
      "!document.querySelector('.folder-row') && document.querySelector('.doc')?.textContent.includes('third')"
    );
    await evaluate(
      `(()=>{[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Compare versions')).click();return true})()`
    );
    await until(
      "document.querySelector('.diff-result')?.textContent.includes('removed: b.md')"
    );
    const changes = await evaluate(
      `[...document.querySelectorAll('.diff-result li')].map(x=>x.textContent)`
    );
    assert.deepEqual(changes, ['changed: a.md', 'removed: b.md']);
  } finally {
    cdp.dispose();
    child.kill();
  }
  console.log('MULTI_FILE_STAGE shape-switch OK');
} finally {
  server.stop(true);
  if (prior === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = prior;
  await rm(temp, { recursive: true, force: true });
}
