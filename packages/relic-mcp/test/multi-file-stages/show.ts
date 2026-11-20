import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../../src/files.ts';
import { showRelic } from '../../src/inventory.ts';
import { publish, type PublishDeps } from '../../src/publish.ts';

async function showStage(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'relic-show-folder-'));
  const prior = process.env.RELIC_PUBLISH_STATE;
  process.env.RELIC_PUBLISH_STATE = join(temp, 'state.json');
  try {
    const root = join(temp, 'source');
    await mkdir(root);
    await writeFile(join(root, 'README.md'), 'hello from folder');
    await writeFile(join(root, 'large.bin'), new Uint8Array(3 * 1024 * 1024));
    const storage = new MemoryStorage();
    const app = createApp({ store: new MemoryStore(), storage });
    const origin = 'https://relic.example';
    const ranges: string[] = [];
    const deps: PublishDeps = {
      serviceOrigin: origin,
      relicOrigin: origin,
      files: nodeFiles,
      clientName: 'folder-show-test',
      renderCover: async () => ({
        status: 'skipped',
        reason: 'browser_disabled',
        detail: 'test',
      }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === origin) {
          const headers = new Headers(init?.headers);
          headers.set('x-forwarded-for', '198.51.100.10');
          return app.fetch(new Request(url, { ...init, headers }));
        }
        const object = await storage.read(url.pathname.slice(3));
        if (!object) return new Response(null, { status: 404 });
        const value = new Headers(init?.headers).get('range');
        assert.ok(value, 'folder reads must not download the whole object');
        ranges.push(value);
        const match = /^bytes=(\d+)-(\d+)$/.exec(value);
        assert.ok(match);
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), object.length - 1);
        return new Response(
          object.slice(start, end + 1) as unknown as BodyInit,
          {
            status: 206,
          }
        );
      }) as typeof fetch,
      upload: async (url, _headers, bytes) => {
        storage.put(new URL(url).pathname.replace(/^\/upload\//, ''), bytes);
        return { status: 200 };
      },
    };
    const published = await publish({ path: root, cover: false }, deps);
    const listed = await showRelic(
      { relic_id: published.relic_id, include_content: true },
      deps
    );
    assert.equal(listed.shape, 'folder');
    assert.deepEqual(
      listed.files?.map((file) => file.path),
      ['README.md', 'large.bin']
    );
    const opened = await showRelic(
      {
        relic_id: published.relic_id,
        include_content: true,
        entry: 'README.md',
      },
      deps
    );
    assert.equal(opened.content, 'hello from folder');
    assert.ok(ranges.length >= 4);
    await assert.rejects(
      showRelic(
        {
          relic_id: published.relic_id,
          include_content: true,
          entry: 'missing.md',
        },
        deps
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'file_not_in_version'
    );
    console.log('MULTI_FILE_STAGE show OK');
  } finally {
    if (prior === undefined) delete process.env.RELIC_PUBLISH_STATE;
    else process.env.RELIC_PUBLISH_STATE = prior;
    await rm(temp, { recursive: true, force: true });
  }
}
await showStage();
