import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { generateRelicId } from '@relic/format';
import { createApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore, type RelicRow } from '../src/store.ts';
import { fakeGcs } from './fake-gcs.ts';

const now = Date.parse('2026-08-02T12:00:00.000Z');
const token = 'publisher-secret';
const request = (path: string, body: unknown, cookie?: string) =>
  new Request(`https://relic.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
async function row(id: string, isPrivate = false): Promise<RelicRow> {
  return {
    id,
    publishIp: '198.51.100.1',
    grantedAt: now,
    expiresAt: isPrivate ? now + 86400000 : undefined,
    rendererClass: 'markdown',
    publishingClient: 'test',
    declaredSizeBytes: 10,
    version: 1,
    publishTokenHash: await sha256Hex(token),
    mintsUsed: 0,
    ...(isPrivate ? { access: 'private' as const } : {}),
  };
}

describe('live settings', () => {
  test('settings history is covered by the private lifecycle rule', async () => {
    const source = await readFile(
      new URL(
        '../../../deploy/terraform/modules/relic/resource.google_storage_bucket.relics.tf',
        import.meta.url
      ),
      'utf8'
    );
    const privateRule = source.match(
      /days_since_custom_time\s*=\s*1\s+matches_prefix\s*=\s*\[([\s\S]*?)\]/
    );
    expect(privateRule?.[1]).toMatch(/\$\{local\.store_prefix\}\/settings\//);
  });

  test('operator deletion removes settings history from fake GCS', async () => {
    const fake = fakeGcs();
    const store = gcsStore({
      bucket: 'relics',
      host: 'https://gcs.test',
      getAccessToken: async () => 'test',
      fetch: fake.fetch,
    });
    const storage = new MemoryStorage();
    const id = generateRelicId();
    await store.putRelic(await row(id));
    storage.put(id, new Uint8Array([1, 2, 3]));
    const app = createApp({
      store,
      storage,
      now: () => now,
      operatorTokens: new Map([['test', 'secret']]),
    });
    expect(
      (
        await app.fetch(
          request(`/api/relics/${id}/settings`, {
            publish_token: token,
            settings: { comments: false },
          })
        )
      ).status
    ).toBe(200);
    const under = `m/settings/${id}/`;
    expect(
      [...fake.objects.keys()].some((name) => name.startsWith(under))
    ).toBe(true);
    const deleted = await app.fetch(
      new Request(`https://relic.example/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer secret' },
      })
    );
    expect(deleted.status).toBe(200);
    expect(
      [...fake.objects.keys()].some((name) => name.startsWith(under))
    ).toBe(false);
  });

  test('a change on one instance immediately closes reader comments on another', async () => {
    const store = new MemoryStore();
    const id = generateRelicId();
    await store.putRelic(await row(id));
    await store.putSession({
      tokenHash: await sha256Hex('reader'),
      email: 'reader@example.test',
      createdAt: now,
      expiresAt: now + 86400000,
    });
    const a = createApp({ store, now: () => now });
    const b = createApp({ store, now: () => now });
    const endpoint = `/api/relics/${id}/settings`;
    expect(
      (
        await a.fetch(
          request(endpoint, {
            publish_token: 'wrong',
            settings: { comments: false },
          })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await a.fetch(
          request(endpoint, {
            publish_token: token,
            settings: { comments: false },
          })
        )
      ).status
    ).toBe(200);
    const denied = await b.fetch(
      request(
        `/api/relics/${id}/comments`,
        { ciphertext: 'abcd' },
        'relic_session=reader'
      )
    );
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as { code: string }).code).toBe(
      'comments_closed'
    );
    expect(
      (
        await b.fetch(
          request(`/api/relics/${id}/comments`, {
            ciphertext: 'abcd',
            publish_token: token,
          })
        )
      ).status
    ).toBe(201);
    expect(
      (
        await a.fetch(
          request(endpoint, {
            publish_token: token,
            settings: { comments: true },
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await b.fetch(
          request(
            `/api/relics/${id}/comments`,
            { ciphertext: 'abcd' },
            'relic_session=reader'
          )
        )
      ).status
    ).toBe(201);
  });

  test('lifetime limits and unknown keys are refused', async () => {
    const store = new MemoryStore();
    const publicId = generateRelicId();
    const privateId = generateRelicId();
    await store.putRelic(await row(publicId));
    await store.putRelic(await row(privateId, true));
    const app = createApp({ store, now: () => now });
    const set = (id: string, settings: unknown) =>
      app.fetch(
        request(`/api/relics/${id}/settings`, {
          publish_token: token,
          settings,
        })
      );
    expect((await set(publicId, { ttl_days: null })).status).toBe(200);
    const privateNull = await set(privateId, { ttl_days: null });
    expect(privateNull.status).toBe(400);
    expect(
      ((await privateNull.json()) as { settings_check: string }).settings_check
    ).toBe('private_lifetime');
    expect((await set(privateId, { ttl_days: 366 })).status).toBe(400);
    expect((await set(publicId, { surprise: true })).status).toBe(400);
  });

  test('settings reads have a separate larger budget from writes', async () => {
    const store = new MemoryStore();
    const id = generateRelicId();
    await store.putRelic(await row(id));
    const app = createApp({ store, now: () => now });
    const endpoint = `/api/relics/${id}/settings`;
    const read = () => app.fetch(request(endpoint, { publish_token: token }));
    const write = () =>
      app.fetch(
        request(endpoint, {
          publish_token: token,
          settings: { comments: false },
        })
      );
    for (let i = 0; i < 60; i++) expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    for (let i = 0; i < 60; i++) expect((await write()).status).toBe(200);
    const limited = await write();
    expect(limited.status).toBe(429);
    const limitedBody = await limited.json();
    expect(limitedBody.code).toBe('settings_rate_limited');
    expect((await read()).status).toBe(200);
  });

  test('GCS extension moves scoped metadata and ciphertext, leaving other reliks alone', async () => {
    const fake = fakeGcs();
    const store = gcsStore({
      bucket: 'relics',
      host: 'https://gcs.test',
      getAccessToken: async () => 'test',
      ciphertextPrefix: 'r',
      fetch: fake.fetch,
    });
    const id = generateRelicId();
    const other = generateRelicId();
    await store.putRelic(await row(id, true));
    const old = new Date(now + 86400000).toISOString();
    const expected = new Date(now + 3 * 86400000).toISOString();
    for (const name of [
      `r/${id}`,
      `r/${id}/v2`,
      `m/wrap/${id}/1/key.json`,
      `m/grant-by-grantee/key/${id}.json`,
      `r/${other}`,
    ])
      fake.objects.set(name, { body: '{}', generation: 1, customTime: old });
    await store.extendPrivateLifetime(id, now + 3 * 86400000);
    for (const name of [
      `r/${id}`,
      `r/${id}/v2`,
      `m/wrap/${id}/1/key.json`,
      `m/grant-by-grantee/key/${id}.json`,
    ])
      expect(fake.objects.get(name)?.customTime).toBe(expected);
    expect(fake.objects.get(`r/${other}`)?.customTime).toBe(old);
    await store.extendPrivateLifetime(id, now + 2 * 86400000);
    expect(fake.objects.get(`r/${id}`)?.customTime).toBe(expected);
  });
  test('a failed GCS sweep leaves the private expiry unchanged', async () => {
    const fake = fakeGcs();
    const id = generateRelicId();
    const failingFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      if (init?.method === 'PATCH')
        return new Response('failure', { status: 500 });
      return fake.fetch(input, init);
    };
    const store = gcsStore({
      bucket: 'relics',
      host: 'https://gcs.test',
      getAccessToken: async () => 'test',
      fetch: failingFetch as typeof fetch,
    });
    await store.putRelic(await row(id, true));
    const app = createApp({ store, now: () => now });
    await expect(
      app.fetch(
        request(`/api/relics/${id}/settings`, {
          publish_token: token,
          settings: { ttl_days: 2 },
        })
      )
    ).rejects.toThrow();
    expect((await store.getRelic(id))?.expiresAt).toBe(now + 86400000);
  });
  test('a second sweep catches an object written after the first sweep', async () => {
    const fake = fakeGcs();
    const id = generateRelicId();
    const old = new Date(now + 86400000).toISOString();
    const expected = new Date(now + 3 * 86400000).toISOString();
    const name = `m/comment/${id}/late.json`;
    let sweeps = 0;
    const hookedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (
        url.searchParams.get('prefix') === `m/comment/${id}/` &&
        ++sweeps === 2
      )
        fake.objects.set(name, { body: '{}', generation: 1, customTime: old });
      return fake.fetch(input, init);
    };
    const store = gcsStore({
      bucket: 'relics',
      host: 'https://gcs.test',
      getAccessToken: async () => 'test',
      fetch: hookedFetch as typeof fetch,
    });
    await store.putRelic(await row(id, true));
    await store.extendPrivateLifetime(id, now + 3 * 86400000);
    fake.objects.set(name, { body: '{}', generation: 1, customTime: old });
    expect(fake.objects.get(name)?.customTime).toBe(old);
    fake.objects.delete(name);
    sweeps = 0;
    const app = createApp({ store, now: () => now });
    const response = await app.fetch(
      request(`/api/relics/${id}/settings`, {
        publish_token: token,
        settings: { ttl_days: 3 },
      })
    );
    expect(response.status).toBe(200);
    expect(sweeps).toBe(2);
    expect(fake.objects.get(name)?.customTime).toBe(expected);
  });

  test('a failed second sweep reports the committed lifetime and retry completes it', async () => {
    const fake = fakeGcs();
    const id = generateRelicId();
    const old = new Date(now + 86400000).toISOString();
    const name = `m/comment/${id}/late.json`;
    let sweeps = 0;
    let fail = true;
    const hookedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (
        url.searchParams.get('prefix') === `m/comment/${id}/` &&
        ++sweeps === 2
      )
        fake.objects.set(name, { body: '{}', generation: 1, customTime: old });
      if (
        fail &&
        init?.method === 'PATCH' &&
        decodeURIComponent(url.pathname).endsWith(name)
      )
        return new Response('failure', { status: 500 });
      return fake.fetch(input, init);
    };
    const store = gcsStore({
      bucket: 'relics',
      host: 'https://gcs.test',
      getAccessToken: async () => 'test',
      fetch: hookedFetch as typeof fetch,
    });
    await store.putRelic(await row(id, true));
    const app = createApp({ store, now: () => now });
    const set = () =>
      app.fetch(
        request(`/api/relics/${id}/settings`, {
          publish_token: token,
          settings: { ttl_days: 3 },
        })
      );
    const response = await set();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { detail: string }).detail).toContain(
      'lifetime was updated'
    );
    expect((await store.getRelic(id))?.expiresAt).toBe(now + 3 * 86400000);
    expect(fake.objects.get(name)?.customTime).toBe(old);
    fail = false;
    expect((await set()).status).toBe(200);
    expect(fake.objects.get(name)?.customTime).toBe(
      new Date(now + 3 * 86400000).toISOString()
    );
  });
});
