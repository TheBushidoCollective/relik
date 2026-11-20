// Each version is published through the in-memory service before the viewer opens it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { compareFolderFiles } from '../../../relic-viewer/src/folder-compare.ts';
import { createVersionStore } from '../../../relic-viewer/src/version-store.ts';
import { load, type ViewerDeps } from '../../../relic-viewer/src/viewer.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, type PublishDeps } from '../../src/publish.ts';
import { republish } from '../../src/republish.ts';

const temp = await mkdtemp(join(tmpdir(), 'relic-shape-switch-'));
const prior = process.env.RELIC_PUBLISH_STATE;
process.env.RELIC_PUBLISH_STATE = join(temp, 'state.json');
try {
  const first = join(temp, 'a.md');
  const root = join(temp, 'folder');
  await mkdir(root);
  await writeFile(first, '# first\n');
  await writeFile(join(root, 'a.md'), '# second\n');
  await writeFile(join(root, 'b.md'), 'added\n');
  const storage = new MemoryStorage();
  const app = createApp({ store: new MemoryStore(), storage });
  const origin = 'https://relic.example';
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.origin === origin) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url, { ...init, headers }));
    }
    if (url.hostname === 'storage.invalid' && url.pathname.startsWith('/o/')) {
      const object = await storage.read(url.pathname.slice(3));
      return object
        ? new Response(object as unknown as BodyInit)
        : new Response(null, { status: 404 });
    }
    throw new Error('unexpected fixture request');
  }) as typeof fetch;
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
      storage.put(new URL(url).pathname.replace(/^\/upload\//, ''), bytes);
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
  console.log('MULTI_FILE_STAGE shape-switch OK');
} finally {
  if (prior === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = prior;
  await rm(temp, { recursive: true, force: true });
}
