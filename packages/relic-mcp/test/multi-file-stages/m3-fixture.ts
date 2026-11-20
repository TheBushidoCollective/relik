import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, type PublishDeps } from '../../src/publish.ts';

export async function withM3Fixture(
  run: (fixture: {
    root: string;
    relicId: string;
    deps: PublishDeps;
  }) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'relic-m3-'));
  const prior = process.env.RELIC_PUBLISH_STATE;
  process.env.RELIC_PUBLISH_STATE = join(temp, 'state.json');
  try {
    const root = join(temp, 'source');
    await mkdir(root);
    await writeFile(join(root, 'a.md'), 'first original text\n');
    await writeFile(join(root, 'b.md'), 'second original text\n');
    const storage = new MemoryStorage();
    const app = createApp({ store: new MemoryStore(), storage });
    const origin = 'https://relic.example';
    const deps: PublishDeps = {
      serviceOrigin: origin,
      relicOrigin: origin,
      files: nodeFiles,
      clientName: 'm3-test',
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
        const range = new Headers(init?.headers).get('range');
        if (!range) return new Response(object as unknown as BodyInit);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) throw new Error('invalid range');
        return new Response(
          object.slice(
            Number(match[1]),
            Math.min(Number(match[2]) + 1, object.length)
          ) as unknown as BodyInit,
          { status: 206 }
        );
      }) as typeof fetch,
      upload: async (url, _headers, bytes) => {
        storage.put(new URL(url).pathname.replace(/^\/upload\//, ''), bytes);
        return { status: 200 };
      },
    };
    const published = await publish({ path: root, cover: false }, deps);
    await run({ root, relicId: published.relic_id, deps });
  } finally {
    if (prior === undefined) delete process.env.RELIC_PUBLISH_STATE;
    else process.env.RELIC_PUBLISH_STATE = prior;
    await rm(temp, { recursive: true, force: true });
  }
}
