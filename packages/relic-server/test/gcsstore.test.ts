import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { ProblemError } from '../src/problems.ts';
import { MemoryStorage } from '../src/storage.ts';
import {
  MemoryStore,
  type PasskeyCredential,
  type RelicRow,
} from '../src/store.ts';

/**
 * A fake GCS that models the one behaviour the store depends on for
 * correctness: every write bumps a generation, and a write carrying
 * `ifGenerationMatch` fails with 412 when it no longer matches.
 *
 * Testing `consumeMint` against a fake without generations would prove
 * nothing, because the race it exists to prevent is invisible without them.
 */
export interface FakeGcs {
  fetch: typeof globalThis.fetch;
  readonly objects: Map<string, { body: string; generation: number }>;
  contendOn(name: string, times: number): void;
}

export function fakeGcs(): FakeGcs {
  const objects = new Map<string, { body: string; generation: number }>();
  const media = new Map<string, Uint8Array>();
  let nextGeneration = 1;
  /**
   * Names to advance one generation just before the next write to them, which
   * is what a competing instance looks like from in here.
   *
   * Modelled by mutating the map directly rather than by driving a second
   * store, because a second store issues writes of its own and those would
   * re-enter this hook and recurse.
   */
  const bumps = new Map<string, number>();

  const competingIncrement = (name: string): void => {
    const remaining = bumps.get(name);
    if (remaining === undefined || remaining === 0) return;
    if (remaining > 0) bumps.set(name, remaining - 1);

    const existing = objects.get(name);
    if (existing === undefined) {
      objects.set(name, {
        body: JSON.stringify({}),
        generation: nextGeneration++,
      });
      return;
    }

    const parsed = JSON.parse(existing.body) as Record<string, unknown>;
    if ('mintsUsed' in parsed) {
      parsed['mintsUsed'] = (Number(parsed['mintsUsed']) || 0) + 1;
    }
    if ('attempts' in parsed) {
      parsed['attempts'] = (Number(parsed['attempts']) || 0) + 1;
    }
    objects.set(name, {
      body: JSON.stringify(parsed),
      generation: nextGeneration++,
    });
  };

  const handler = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';

    if (url.pathname.startsWith('/upload/')) {
      const name = url.searchParams.get('name') ?? '';
      const precondition = url.searchParams.get('ifGenerationMatch');

      competingIncrement(name);

      if (precondition !== null) {
        const existing = objects.get(name);
        const current = existing === undefined ? 0 : existing.generation;
        if (String(current) !== precondition) {
          return new Response('precondition failed', { status: 412 });
        }
      }

      if (init?.body instanceof Uint8Array) {
        media.set(name, init.body);
        objects.set(name, {
          body: '',
          generation: nextGeneration++,
        });
      } else {
        objects.set(name, {
          body: String(init?.body ?? ''),
          generation: nextGeneration++,
        });
      }
      return new Response('{}', { status: 200 });
    }

    // List: /storage/v1/b/{bucket}/o?prefix=
    const listMatch = /^\/storage\/v1\/b\/[^/]+\/o$/.exec(url.pathname);
    if (listMatch !== null && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return Response.json({ items });
    }

    // Single object: /storage/v1/b/{bucket}/o/{name}
    const objectMatch = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
    if (objectMatch?.[1] !== undefined) {
      const name = decodeURIComponent(objectMatch[1]);

      if (method === 'DELETE') {
        const precondition = url.searchParams.get('ifGenerationMatch');
        if (precondition !== null) {
          const existing = objects.get(name);
          const current = existing === undefined ? 0 : existing.generation;
          if (String(current) !== precondition) {
            return new Response('precondition failed', { status: 412 });
          }
        }
        objects.delete(name);
        media.delete(name);
        return new Response('', { status: 204 });
      }

      if (media.has(name)) {
        return new Response(media.get(name) as BodyInit, {
          status: 200,
          headers: { 'x-goog-generation': '1' },
        });
      }

      const found = objects.get(name);
      if (found === undefined) {
        return new Response('not found', { status: 404 });
      }
      return new Response(found.body, {
        status: 200,
        headers: { 'x-goog-generation': String(found.generation) },
      });
    }

    return new Response('unhandled', { status: 500 });
  };

  return {
    fetch: handler as unknown as typeof globalThis.fetch,
    objects,
    /** `times: -1` means every write, for modelling permanent contention. */
    contendOn(name: string, times: number) {
      bumps.set(name, times);
    },
  };
}

export function storeOn(gcs: FakeGcs, casAttempts?: number) {
  return gcsStore({
    bucket: 'relics',
    getAccessToken: async () => 'token',
    host: 'https://gcs.test',
    fetch: gcs.fetch,
    ...(casAttempts === undefined ? {} : { casAttempts }),
  });
}

function row(overrides: Partial<RelicRow> = {}): RelicRow {
  return {
    id: 'gdk6rpv49hftg5216ev7dejesc',
    publishIp: '203.0.113.7',
    grantedAt: 1000,
    expiresAt: 9_000_000,
    rendererClass: 'html',
    publishingClient: 'relic-mcp',
    declaredSizeBytes: 1024,
    version: 1,
    publishTokenHash: 'f'.repeat(64),
    mintsUsed: 0,
    ...overrides,
  };
}

describe('gcsStore', () => {
  test('a relic survives being written and read back', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row());

    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.id).toBe('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.rendererClass).toBe('html');
  });

  test('a relic title survives being written and read back', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row({ title: 'GCS Title' }));

    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.title).toBe('GCS Title');
  });

  test('rows written without a title key read back with title undefined', async () => {
    const gcs = fakeGcs();
    const legacyRowJson = JSON.stringify({
      id: 'gdk6rpv49hftg5216ev7dejesc',
      publishIp: '203.0.113.7',
      grantedAt: 1000,
      expiresAt: 9_000_000,
      rendererClass: 'html',
      publishingClient: 'relic-mcp',
      declaredSizeBytes: 1024,
      version: 1,
      publishTokenHash: 'f'.repeat(64),
      mintsUsed: 0,
    });
    await gcs.fetch(
      'https://gcs.test/upload/storage/v1/b/relics/o?name=m%2Frelic%2Fgdk6rpv49hftg5216ev7dejesc.json',
      {
        method: 'POST',
        body: legacyRowJson,
      }
    );
    const store = storeOn(gcs);
    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.id).toBe('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.title).toBeUndefined();
  });

  test('beginVersion preserves, clears, or replaces title across generations', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row({ title: 'Original Title' }));

    // Absent titleUpdate leaves stored title unchanged
    const v2 = await store.beginVersion(
      'gdk6rpv49hftg5216ev7dejesc',
      'html',
      2048
    );
    expect(v2?.version).toBe(2);
    expect(v2?.title).toBe('Original Title');

    const readV2 = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(readV2?.title).toBe('Original Title');

    // titleUpdate with title: undefined clears the title
    const v3 = await store.beginVersion(
      'gdk6rpv49hftg5216ev7dejesc',
      'html',
      4096,
      { title: undefined }
    );
    expect(v3?.version).toBe(3);
    expect(v3?.title).toBeUndefined();

    const readV3 = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(readV3?.title).toBeUndefined();

    // titleUpdate with a new title replaces it
    const v4 = await store.beginVersion(
      'gdk6rpv49hftg5216ev7dejesc',
      'html',
      8192,
      { title: 'Replaced Title' }
    );
    expect(v4?.version).toBe(4);
    expect(v4?.title).toBe('Replaced Title');

    const readV4 = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(readV4?.title).toBe('Replaced Title');
  });

  // The whole point of the change: a second reader is a different instance.
  test('a second store over the same bucket sees the relic', async () => {
    const gcs = fakeGcs();
    await storeOn(gcs).putRelic(row());

    const other = storeOn(gcs);
    expect(await other.getRelic('gdk6rpv49hftg5216ev7dejesc')).toBeDefined();
  });

  test('an unknown relic is undefined, not an error', async () => {
    const store = storeOn(fakeGcs());
    expect(await store.getRelic('nope')).toBeUndefined();
  });

  test('markPublished records the object it landed as', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row());
    await store.markPublished('gdk6rpv49hftg5216ev7dejesc', 2000, 4096, 'crc');

    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.publishedAt).toBe(2000);
    expect(found?.objectLength).toBe(4096);
    expect(found?.objectCrc32c).toBe('crc');
  });

  test('consumeMint counts up', async () => {
    const store = storeOn(fakeGcs());
    await store.putRelic(row());

    expect(await store.consumeMint('gdk6rpv49hftg5216ev7dejesc')).toBe(1);
    expect(await store.consumeMint('gdk6rpv49hftg5216ev7dejesc')).toBe(2);
  });

  // Two instances both read 0 and both write 1, and the relic gets a free
  // open. The generation precondition is what stops it.
  test('a mint that loses the race retries against fresh state', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putRelic(row());

    // One competing increment lands between our read and our write.
    gcs.contendOn('m/relic/gdk6rpv49hftg5216ev7dejesc.json', 1);

    const result = await store.consumeMint('gdk6rpv49hftg5216ev7dejesc');

    // Both increments are accounted for. Neither silently overwrote the other,
    // which is exactly what an unconditional write would have done.
    expect(result).toBe(2);
    const found = await store.getRelic('gdk6rpv49hftg5216ev7dejesc');
    expect(found?.mintsUsed).toBe(2);
  });

  test('giving up on a hopelessly contended row raises, never guesses', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs, 2);
    await store.putRelic(row());

    gcs.contendOn('m/relic/gdk6rpv49hftg5216ev7dejesc.json', -1);

    await expect(
      store.consumeMint('gdk6rpv49hftg5216ev7dejesc')
    ).rejects.toThrow(/compare-and-swap/);
  });

  test('minting a relic that is gone does not invent one', async () => {
    const store = storeOn(fakeGcs());
    expect(await store.consumeMint('missing')).toBe(0);
    expect(await store.getRelic('missing')).toBeUndefined();
  });

  test('a tombstone outlives the relic it replaces', async () => {
    const store = storeOn(fakeGcs());
    await store.putTombstone({
      id: 'gdk6rpv49hftg5216ev7dejesc',
      publishIp: '203.0.113.7',
      publishedAt: 2000,
      publishingClient: 'relic-mcp',
      rendererClass: 'html',
      ciphertextHash: 'hash',
      deletedAt: 3000,
      operator: 'jason',
      reasonClass: 'abuse',
      reportReference: undefined,
    });

    const stone = await store.getTombstone('gdk6rpv49hftg5216ev7dejesc');
    expect(stone?.reasonClass).toBe('abuse');
  });

  // A challenge issued on one instance is redeemed on whichever instance the
  // grant reaches, so it cannot live in a per-instance map.
  test('a challenge issued by one instance is redeemable by another', async () => {
    const gcs = fakeGcs();
    const nonce = await storeOn(gcs).issueChallenge('203.0.113.7', 1000);

    expect(await storeOn(gcs).consumeChallenge(nonce, 1500, 60)).toBe(true);
  });

  test('a challenge is single use', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    const nonce = await store.issueChallenge('203.0.113.7', 1000);

    expect(await store.consumeChallenge(nonce, 1500, 60)).toBe(true);
    expect(await store.consumeChallenge(nonce, 1600, 60)).toBe(false);
  });

  test('an expired challenge is refused and not left behind', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    const nonce = await store.issueChallenge('203.0.113.7', 1000);

    expect(await store.consumeChallenge(nonce, 1000 + 61_000, 60)).toBe(false);
    expect(await store.consumeChallenge(nonce, 1000 + 61_000, 60)).toBe(false);
  });

  test('an unknown challenge is refused', async () => {
    const store = storeOn(fakeGcs());
    expect(await store.consumeChallenge('never-issued', 1, 60)).toBe(false);
  });

  test('dedup entries expire out of the window', async () => {
    const store = storeOn(fakeGcs());
    const entry = { url: 'https://signed', urlExpiresAt: 9000, at: 1000 };
    await store.rememberMint('relic', '203.0.113.7', entry);

    expect(await store.recentMint('relic', '203.0.113.7', 1500, 60)).toEqual(
      entry
    );
    expect(
      await store.recentMint('relic', '203.0.113.7', 1000 + 61_000, 60)
    ).toBeUndefined();
  });

  test('dedup is per ip, not per relic', async () => {
    const store = storeOn(fakeGcs());
    await store.rememberMint('relic', '203.0.113.7', {
      url: 'https://signed',
      urlExpiresAt: 9000,
      at: 1000,
    });

    expect(
      await store.recentMint('relic', '198.51.100.2', 1500, 60)
    ).toBeUndefined();
  });

  test('the dedup key never spells out the ip', async () => {
    const gcs = fakeGcs();
    await storeOn(gcs).rememberMint('relic', '203.0.113.7', {
      url: 'https://signed',
      urlExpiresAt: 9000,
      at: 1000,
    });

    expect([...gcs.objects.keys()].join('\n')).not.toContain('203.0.113.7');
  });

  test('the blocklist persists', async () => {
    const gcs = fakeGcs();
    await storeOn(gcs).blocklist('deadbeef');

    expect(await storeOn(gcs).isBlocklisted('deadbeef')).toBe(true);
    expect(await storeOn(gcs).isBlocklisted('cafe')).toBe(false);
  });

  test('the mint log accumulates and reads back in time order', async () => {
    const store = storeOn(fakeGcs());
    const base = {
      relicId: 'relic',
      ip: '203.0.113.7',
      endpoint: 'mint',
      outcome: 'granted' as const,
      code: undefined,
      countedAsOpen: true,
      dropReason: undefined,
      consumedCap: true,
      capRemaining: 199,
      occurrenceId: 'occ',
    };

    await store.appendMintLog({ ...base, at: 3000 });
    await store.appendMintLog({ ...base, at: 1000 });
    await store.appendMintLog({ ...base, at: 2000 });

    expect((await store.readMintLog()).map((e) => e.at)).toEqual([
      1000, 2000, 3000,
    ]);
  });

  test('abuse reports accumulate rather than overwrite', async () => {
    const store = storeOn(fakeGcs());
    const base = {
      relicId: 'relic',
      category: 'phishing' as const,
      description: 'looks like a bank',
      contact: undefined,
      authority: undefined,
      reference: undefined,
    };

    await store.putAbuseReport({ ...base, receivedAt: 2000 });
    await store.putAbuseReport({ ...base, receivedAt: 1000 });

    const reports = await store.readAbuseReports();
    expect(reports.map((r) => r.receivedAt)).toEqual([1000, 2000]);
  });

  test('two reports in the same millisecond both survive', async () => {
    const store = storeOn(fakeGcs());
    const base = {
      relicId: 'relic',
      category: 'other' as const,
      description: 'x',
      contact: undefined,
      authority: undefined,
      reference: undefined,
      receivedAt: 1000,
    };

    await store.putAbuseReport(base);
    await store.putAbuseReport(base);

    expect((await store.readAbuseReports()).length).toBe(2);
  });

  test('comments land one object each and list oldest first', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'b',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 2000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'a',
      relicId: 'relic',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'ZGVjZA',
    });

    const listed = await store.listComments('relic');
    expect(listed.map((c) => c.id)).toEqual(['a', 'b']);
    expect(await store.getComment('relic', 'a')).toMatchObject({
      author: 'reader@example.com',
    });
    expect(await store.listComments('other')).toEqual([]);
  });

  test('deleting one comment leaves the rest, and deleting the relic takes all of them', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'one',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 1,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'two',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 2,
      ciphertext: 'ZGVjZA',
    });

    await store.deleteComment('relic', 'one');
    expect((await store.listComments('relic')).map((c) => c.id)).toEqual([
      'two',
    ]);

    expect(await store.deleteCommentsForRelic('relic')).toBe(1);
    expect(await store.listComments('relic')).toEqual([]);
  });
  test('a legacy comment row with no version key in the bucket reads back with version undefined', async () => {
    const gcs = fakeGcs();
    gcs.objects.set('m/comment/relic/legacy.json', {
      body: JSON.stringify({
        id: 'legacy',
        relicId: 'relic',
        author: 'reader@example.com',
        createdAt: 500,
        ciphertext: 'YWJjZA',
      }),
      generation: 1,
    });
    const store = storeOn(gcs);
    const comment = await store.getComment('relic', 'legacy');
    expect(comment).toBeDefined();
    expect(comment?.version).toBeUndefined();

    const listed = await store.listComments('relic');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('legacy');
    expect(listed[0]?.version).toBeUndefined();
  });

  test('a comment with an explicit version persists and reads back with that version', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putComment({
      id: 'v2comment',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 600,
      ciphertext: 'YWJjZA',
      version: 2,
    });

    const rawBody = gcs.objects.get('m/comment/relic/v2comment.json')?.body;
    expect(rawBody).toBeDefined();
    const parsed = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
    expect(parsed['version']).toBe(2);

    const comment = await store.getComment('relic', 'v2comment');
    expect(comment?.version).toBe(2);

    const listed = await store.listComments('relic');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.version).toBe(2);
  });

  test('a comment without a version key omits the version property from the stored GCS document', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putComment({
      id: 'unversioned',
      relicId: 'relic',
      author: 'publisher',
      createdAt: 700,
      ciphertext: 'YWJjZA',
    });

    const rawBody = gcs.objects.get('m/comment/relic/unversioned.json')?.body;
    expect(rawBody).toBeDefined();
    const parsed = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
    expect('version' in parsed).toBe(false);

    const comment = await store.getComment('relic', 'unversioned');
    expect(comment?.version).toBeUndefined();
  });

  test('a magic link is spent on first consume, so a replay finds nothing', async () => {
    const store = storeOn(fakeGcs());
    await store.putAuthLink({
      tokenHash: 'abc',
      email: 'reader@example.com',
      expiresAt: 9_000_000,
      returnTo: '/',
    });

    const first = await store.consumeAuthLink('abc');
    expect(first?.email).toBe('reader@example.com');
    expect(await store.consumeAuthLink('abc')).toBeUndefined();
  });

  test('a session reads back by the hash of the secret, never the secret', async () => {
    const store = storeOn(fakeGcs());
    await store.putSession({
      tokenHash: 'hashed',
      email: 'reader@example.com',
      createdAt: 1000,
      expiresAt: 9_000_000,
    });
    expect((await store.getSession('hashed'))?.email).toBe(
      'reader@example.com'
    );
    expect(await store.getSession('the-secret')).toBeUndefined();
  });

  test('via survives a round trip, and a legacy row reads back with via undefined', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);

    await store.putSession({
      tokenHash: 'hash-link',
      email: 'link@example.com',
      createdAt: 1000,
      expiresAt: 9_000_000,
      via: 'link',
    });
    await store.putSession({
      tokenHash: 'hash-passkey',
      email: 'passkey@example.com',
      createdAt: 1000,
      expiresAt: 9_000_000,
      via: 'passkey',
    });
    await store.putSession({
      tokenHash: 'hash-code',
      email: 'code@example.com',
      createdAt: 1000,
      expiresAt: 9_000_000,
      via: 'code',
    });

    expect((await store.getSession('hash-link'))?.via).toBe('link');
    expect((await store.getSession('hash-passkey'))?.via).toBe('passkey');
    expect((await store.getSession('hash-code'))?.via).toBe('code');

    // Legacy row written without via (e.g. manually or before this field)
    await store.putSession({
      tokenHash: 'hash-legacy',
      email: 'legacy@example.com',
      createdAt: 1000,
      expiresAt: 9_000_000,
    });
    const legacy = await store.getSession('hash-legacy');
    expect(legacy).toBeDefined();
    expect(legacy?.via).toBeUndefined();
  });

  test('listCommentedRelics returns relics an author commented on, ordered by most recent engagement first', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'c1',
      relicId: 'relic1',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'c2',
      relicId: 'relic2',
      author: 'reader@example.com',
      createdAt: 2000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'c3',
      relicId: 'relic1',
      author: 'reader@example.com',
      createdAt: 3000,
      ciphertext: 'YWJjZA',
    });
    // Second author comments on relic 3
    await store.putComment({
      id: 'c4',
      relicId: 'relic3',
      author: 'other@example.com',
      createdAt: 4000,
      ciphertext: 'YWJjZA',
    });

    const readerRelics = await store.listCommentedRelics('reader@example.com');
    expect(readerRelics).toEqual([
      { relicId: 'relic1', lastCommentAt: 3000 },
      { relicId: 'relic2', lastCommentAt: 2000 },
    ]);

    const otherRelics = await store.listCommentedRelics('other@example.com');
    expect(otherRelics).toEqual([{ relicId: 'relic3', lastCommentAt: 4000 }]);
  });

  test('a failed index write in gcsStore does not lose the comment', async () => {
    const gcs = fakeGcs();
    const originalFetch = gcs.fetch;
    gcs.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const name = url.searchParams.get('name') ?? '';
      if (
        url.pathname.startsWith('/upload/') &&
        name.includes('author_relic')
      ) {
        return new Response('index write error', { status: 500 });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    const store = storeOn(gcs);

    await store.putComment({
      id: 'c1',
      relicId: 'relic1',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });

    const comments = await store.listComments('relic1');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe('c1');
  });

  test('an edit stamps the row and a cleared resolution omits its keys from the document', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putComment({
      id: 'c1',
      relicId: 'relic',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });

    const edited = await store.updateComment('relic', 'c1', {
      ciphertext: 'ZWRpdGVk',
      editedAt: 2000,
      resolved: { at: 2000, by: 'reader@example.com' },
    });
    expect(edited?.ciphertext).toBe('ZWRpdGVk');
    expect(edited?.editedAt).toBe(2000);
    expect(edited?.resolvedAt).toBe(2000);
    expect(edited?.resolvedBy).toBe('reader@example.com');

    const rawBody = gcs.objects.get('m/comment/relic/c1.json')?.body;
    const parsed = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
    expect(parsed['editedAt']).toBe(2000);
    expect(parsed['resolvedAt']).toBe(2000);
    expect(parsed['resolvedBy']).toBe('reader@example.com');

    const cleared = await store.updateComment('relic', 'c1', {
      resolved: null,
    });
    expect(cleared?.editedAt).toBe(2000);
    expect(cleared?.ciphertext).toBe('ZWRpdGVk');
    expect(cleared?.resolvedAt).toBeUndefined();
    expect(cleared?.resolvedBy).toBeUndefined();

    const clearedBody = JSON.parse(
      gcs.objects.get('m/comment/relic/c1.json')?.body ?? '{}'
    ) as Record<string, unknown>;
    expect('resolvedAt' in clearedBody).toBe(false);
    expect('resolvedBy' in clearedBody).toBe(false);
    expect(clearedBody['editedAt']).toBe(2000);
  });

  test('a patch that loses the race retries against fresh state', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs);
    await store.putComment({
      id: 'c1',
      relicId: 'relic',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });

    // One competing write lands between our read and our write.
    gcs.contendOn('m/comment/relic/c1.json', 1);

    const updated = await store.updateComment('relic', 'c1', {
      ciphertext: 'ZWRpdGVk',
      editedAt: 2000,
    });
    expect(updated?.ciphertext).toBe('ZWRpdGVk');

    // A second store reads what actually landed, not a lost overwrite.
    const other = storeOn(gcs);
    expect((await other.getComment('relic', 'c1'))?.ciphertext).toBe(
      'ZWRpdGVk'
    );
  });

  test('a hopelessly contended comment raises rather than overwriting on stale state', async () => {
    const gcs = fakeGcs();
    const store = storeOn(gcs, 2);
    await store.putComment({
      id: 'c1',
      relicId: 'relic',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });

    gcs.contendOn('m/comment/relic/c1.json', -1);

    await expect(
      store.updateComment('relic', 'c1', { ciphertext: 'ZQ', editedAt: 2000 })
    ).rejects.toThrow(/compare-and-swap/);
  });

  test('patching a comment that is gone is undefined, not an invention', async () => {
    const store = storeOn(fakeGcs());
    expect(
      await store.updateComment('relic', 'ghost', { resolved: null })
    ).toBeUndefined();
  });

  describe('cover operations', () => {
    test('putCover stores object, updates row.cover via CAS, and deletes older objects under prefix', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const r = row({ id: 'r1', version: 1 });
      await store.putRelic(r);

      const bytesA = new Uint8Array([1, 2, 3, 4]);
      const coverA = {
        version: 1,
        sha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        type: 'image/png' as const,
        kind: 'markdown' as const,
        bytes: 4,
        uploadedAt: 1000,
      };

      const resultA = await store.putCover('r1', coverA, bytesA);
      expect(resultA).toBe('stored');
      expect(gcs.objects.has(`m/cover/r1/${coverA.sha256}`)).toBe(true);

      const updatedRow = await store.getRelic('r1');
      expect(updatedRow?.cover).toEqual(coverA);

      const fetchedBytesA = await store.getCoverBytes('r1', coverA.sha256);
      expect(fetchedBytesA).toEqual(bytesA);

      const bytesB = new Uint8Array([5, 6, 7, 8]);
      const coverB = {
        version: 1,
        sha256:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        type: 'image/png' as const,
        kind: 'code' as const,
        bytes: 4,
        uploadedAt: 2000,
      };

      const resultB = await store.putCover('r1', coverB, bytesB);
      expect(resultB).toBe('stored');
      expect(gcs.objects.has(`m/cover/r1/${coverB.sha256}`)).toBe(true);
      // Old cover object deleted
      expect(gcs.objects.has(`m/cover/r1/${coverA.sha256}`)).toBe(false);

      const coversList = await store.listCovers('r1');
      expect(coversList).toEqual([coverB.sha256]);
    });

    test('putCover deletes just-written object and returns stale_version when version mismatches', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const r = row({ id: 'r2', version: 2 });
      await store.putRelic(r);

      const bytes = new Uint8Array([1, 2, 3]);
      const cover = {
        version: 1,
        sha256:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        type: 'image/png' as const,
        kind: 'html' as const,
        bytes: 3,
        uploadedAt: 1000,
      };

      const res = await store.putCover('r2', cover, bytes);
      expect(res).toBe('stale_version');
      expect(gcs.objects.has(`m/cover/r2/${cover.sha256}`)).toBe(false);

      const rAfter = await store.getRelic('r2');
      expect(rAfter?.cover).toBeUndefined();
    });

    test('putCover deletes just-written object and returns not_found when row does not exist', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);

      const bytes = new Uint8Array([1, 2, 3]);
      const cover = {
        version: 1,
        sha256:
          'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        type: 'image/png' as const,
        kind: 'image' as const,
        bytes: 3,
        uploadedAt: 1000,
      };

      const res = await store.putCover('ghost', cover, bytes);
      expect(res).toBe('not_found');
      expect(gcs.objects.has(`m/cover/ghost/${cover.sha256}`)).toBe(false);
    });

    test('deleteCovers lists m/cover/{id}/, issues a DELETE per object, and clears row.cover by CAS', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const r = row({ id: 'r3', version: 1 });
      await store.putRelic(r);

      const coverA = {
        version: 1,
        sha256:
          '1111111111111111111111111111111111111111111111111111111111111111',
        type: 'image/png' as const,
        kind: 'pdf' as const,
        bytes: 4,
        uploadedAt: 1000,
      };
      await store.putCover('r3', coverA, new Uint8Array([1, 2, 3, 4]));

      // Add an extra object under the prefix to verify all are deleted
      gcs.objects.set('m/cover/r3/orphan', { body: 'orphan', generation: 99 });

      expect(gcs.objects.has(`m/cover/r3/${coverA.sha256}`)).toBe(true);
      expect(gcs.objects.has('m/cover/r3/orphan')).toBe(true);

      const deletedCount = await store.deleteCovers('r3');
      expect(deletedCount).toBe(2);
      expect(gcs.objects.has(`m/cover/r3/${coverA.sha256}`)).toBe(false);
      expect(gcs.objects.has('m/cover/r3/orphan')).toBe(false);

      const rAfter = await store.getRelic('r3');
      expect(rAfter?.cover).toBeUndefined();
    });

    test('beginVersion clears row.cover', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const r = row({ id: 'r4', version: 1 });
      await store.putRelic(r);

      const cover = {
        version: 1,
        sha256:
          '2222222222222222222222222222222222222222222222222222222222222222',
        type: 'image/png' as const,
        kind: 'video' as const,
        bytes: 4,
        uploadedAt: 1000,
      };
      await store.putCover('r4', cover, new Uint8Array([1, 2, 3, 4]));
      expect((await store.getRelic('r4'))?.cover).toBeDefined();

      const v2 = await store.beginVersion('r4', 'media', 100);
      expect(v2?.version).toBe(2);
      expect(v2?.cover).toBeUndefined();
      expect((await store.getRelic('r4'))?.cover).toBeUndefined();
    });
  });

  test('deleteCommentsForRelic removes the author_relic entries', async () => {
    const store = storeOn(fakeGcs());
    await store.putComment({
      id: 'c1',
      relicId: 'r1',
      author: 'reader@example.com',
      createdAt: 1000,
      ciphertext: 'YWJjZA',
    });
    await store.putComment({
      id: 'c2',
      relicId: 'r2',
      author: 'reader@example.com',
      createdAt: 2000,
      ciphertext: 'YWJjZA',
    });

    const before = await store.listCommentedRelics('reader@example.com');
    expect(before).toHaveLength(2);

    await store.deleteCommentsForRelic('r1');

    const after = await store.listCommentedRelics('reader@example.com');
    expect(after).toEqual([{ relicId: 'r2', lastCommentAt: 2000 }]);
  });

  describe('change notices, sharing, and opt-outs', () => {
    test('putShare is create-only, and the object key is a sha256, not the address', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const email = 'alice@example.com';
      const emailHash = await sha256Hex(email);

      const first = await store.putShare({
        relicId: 'r1',
        email,
        addedAt: 1000,
        sharedBy: 'publisher',
      });
      expect(first).toBe(true);

      const expectedKey = `m/share/r1/${emailHash}.json`;
      expect(gcs.objects.has(expectedKey)).toBe(true);
      for (const key of gcs.objects.keys()) {
        expect(key).not.toContain(email);
      }

      const second = await store.putShare({
        relicId: 'r1',
        email,
        addedAt: 2000,
        sharedBy: 'reader',
      });
      expect(second).toBe(false);
      const rawStored = gcs.objects.get(expectedKey);
      expect(rawStored).toBeDefined();
      const stored = JSON.parse(rawStored?.body ?? '{}');
      expect(stored.addedAt).toBe(1000);
      expect(stored.sharedBy).toBe('publisher');
    });

    test('listShares and deleteSharesForRelic work', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      await store.putShare({
        relicId: 'r1',
        email: 'bob@example.com',
        addedAt: 2000,
        sharedBy: 'reader',
      });
      await store.putShare({
        relicId: 'r1',
        email: 'alice@example.com',
        addedAt: 1000,
        sharedBy: 'publisher',
      });

      const shares = await store.listShares('r1');
      expect(shares).toEqual([
        {
          relicId: 'r1',
          email: 'alice@example.com',
          addedAt: 1000,
          sharedBy: 'publisher',
        },
        {
          relicId: 'r1',
          email: 'bob@example.com',
          addedAt: 2000,
          sharedBy: 'reader',
        },
      ]);

      const deleted = await store.deleteSharesForRelic('r1');
      expect(deleted).toBe(2);
      expect(await store.listShares('r1')).toEqual([]);
    });
    test('SHARE-001: concurrent authorized shares in gcsStore never exceed 50-per-relic cap', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const storage = new MemoryStorage();
      const token = 'pub-token-12345';
      const tokenHash = await sha256Hex(token);
      const relicId = 'gdk6rpv49hftg5216ev7dejesc';
      await store.putRelic(
        row({
          id: relicId,
          version: 1,
          publishTokenHash: tokenHash,
          expiresAt: undefined,
        })
      );
      const app = createApp({ store, storage });

      const batch1 = Array.from(
        { length: 20 },
        (_, i) => `g1_${i}@example.com`
      );
      const batch2 = Array.from(
        { length: 20 },
        (_, i) => `g2_${i}@example.com`
      );
      const batch3 = Array.from(
        { length: 20 },
        (_, i) => `g3_${i}@example.com`
      );

      const reqShare = (emails: string[]) =>
        new Request(`https://relic.example/api/relics/${relicId}/share`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '198.51.100.10',
          },
          body: JSON.stringify({ publish_token: token, emails }),
        });

      const responses = await Promise.all([
        app.fetch(reqShare(batch1)),
        app.fetch(reqShare(batch2)),
        app.fetch(reqShare(batch3)),
      ]);

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 409]);

      const storedShares = await store.listShares(relicId);
      expect(storedShares.length).toBeLessThanOrEqual(50);
      expect(storedShares.length).toBe(40);
    });

    test('putOptOut keeps the first record; listOptOuts reads names only; deleteOptOutsForRelic works', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      await store.putOptOut({ relicId: 'r1', addressHash: 'hash1', at: 1000 });
      await store.putOptOut({ relicId: 'r1', addressHash: 'hash1', at: 2000 });
      const rawOptOut = gcs.objects.get('m/optout/r1/hash1.json');
      expect(rawOptOut).toBeDefined();
      const stored = JSON.parse(rawOptOut?.body ?? '{}');
      expect(stored.at).toBe(1000);
      expect(await store.isOptedOut('r1', 'hash1')).toBe(true);
      expect(await store.isOptedOut('r1', 'nonexistent')).toBe(false);
      await store.putOptOut({ relicId: 'r1', addressHash: 'hash2', at: 3000 });
      const optOuts = await store.listOptOuts('r1');
      expect([...optOuts].sort()).toEqual(['hash1', 'hash2']);

      const deleted = await store.deleteOptOutsForRelic('r1');
      expect(deleted).toBe(2);
      expect(await store.listOptOuts('r1')).toEqual([]);
      expect(await store.isOptedOut('r1', 'hash1')).toBe(false);
    });

    test('reserveShares and releaseShares advance and release capacity with CAS', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      await store.putRelic(
        row({ id: 'r_cap', version: 1, expiresAt: undefined })
      );

      const res1 = await store.reserveShares('r_cap', 30, 50);
      expect(res1.allowed).toBe(true);
      expect(res1.currentCount).toBe(30);

      const res2 = await store.reserveShares('r_cap', 25, 50);
      expect(res2.allowed).toBe(false);
      expect(res2.currentCount).toBe(30);

      const res3 = await store.reserveShares('r_cap', 20, 50);
      expect(res3.allowed).toBe(true);
      expect(res3.currentCount).toBe(50);

      await store.releaseShares('r_cap', 10);
      const rowAfterRelease = await store.getRelic('r_cap');
      expect(rowAfterRelease?.sharesCount).toBe(40);

      await store.deleteSharesForRelic('r_cap');
      const rowAfterDelete = await store.getRelic('r_cap');
      expect(rowAfterDelete?.sharesCount).toBe(0);
    });

    test('claimVersionNotice: claims once, returns undefined on a version mismatch, retries a lost race, and throws under hopeless contention', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const r = row({ id: 'r1', version: 2, noticePending: true });
      await store.putRelic(r);

      expect(await store.claimVersionNotice('r1', 1)).toBeUndefined();
      expect((await store.getRelic('r1'))?.noticePending).toBe(true);

      const claimed = await store.claimVersionNotice('r1', 2);
      expect(claimed?.version).toBe(2);
      expect(claimed?.noticePending).toBeUndefined();
      expect((await store.getRelic('r1'))?.noticePending).toBeUndefined();

      expect(await store.claimVersionNotice('r1', 2)).toBeUndefined();

      await store.putRelic(row({ id: 'r2', version: 3, noticePending: true }));
      gcs.contendOn('m/relic/r2.json', 1);
      const claimedAfterRace = await store.claimVersionNotice('r2', 3);
      expect(claimedAfterRace?.version).toBe(3);
      expect(claimedAfterRace?.noticePending).toBeUndefined();

      await store.putRelic(row({ id: 'r3', version: 4, noticePending: true }));
      gcs.contendOn('m/relic/r3.json', -1);
      await expect(store.claimVersionNotice('r3', 4)).rejects.toThrow(
        'lost 5 compare-and-swap races'
      );
    });

    test('beginVersion sets and clears noticePending, and a legacy row without the key reads back as undefined', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      await store.putRelic(row({ id: 'r1', version: 1 }));

      const v2 = await store.beginVersion(
        'r1',
        'code',
        100,
        undefined,
        undefined,
        true
      );
      expect(v2?.noticePending).toBe(true);
      expect((await store.getRelic('r1'))?.noticePending).toBe(true);

      const v3 = await store.beginVersion(
        'r1',
        'code',
        100,
        undefined,
        undefined,
        false
      );
      expect(v3?.noticePending).toBeUndefined();
      expect((await store.getRelic('r1'))?.noticePending).toBeUndefined();

      const legacyRow = row({ id: 'legacy', version: 1 });
      const { noticePending: _p, ...withoutPending } = legacyRow;
      gcs.objects.set('m/relic/legacy.json', {
        body: JSON.stringify(withoutPending),
        generation: 1,
      });
      const readLegacy = await store.getRelic('legacy');
      expect(readLegacy?.noticePending).toBeUndefined();
    });

    test('unsubscribeKey returns the same bytes from two stores on one bucket, and the second store never overwrites it', async () => {
      const gcs = fakeGcs();
      const store1 = storeOn(gcs);
      const store2 = storeOn(gcs);

      const key1 = await store1.unsubscribeKey();
      expect(key1.byteLength).toBe(32);

      const key2 = await store2.unsubscribeKey();
      expect(key2).toEqual(key1);

      const storedSecret = gcs.objects.get('m/secret/unsubscribe-key.json');
      expect(storedSecret).toBeDefined();
      expect(storedSecret?.generation).toBe(1);
    });

    test('legacy relics backfill commenter index once and write completion marker', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);

      // Simulate legacy comments existing before the commenter index was introduced
      const email = 'legacy-author@example.com';
      const emailHash = await sha256Hex(email);
      gcs.objects.set('m/comment/r_legacy/c1.json', {
        body: JSON.stringify({
          id: 'c1',
          relicId: 'r_legacy',
          author: email,
          createdAt: 1000,
          ciphertext: 'dGVzdA',
        }),
        generation: 1,
      });

      expect(gcs.objects.has('m/commenter/r_legacy/_complete.json')).toBe(
        false
      );
      expect(gcs.objects.has(`m/commenter/r_legacy/${emailHash}.json`)).toBe(
        false
      );

      // First call backfills and writes marker
      const first = await store.listCommenters('r_legacy');
      expect(first).toEqual([email]);
      expect(gcs.objects.has('m/commenter/r_legacy/_complete.json')).toBe(true);
      expect(gcs.objects.has(`m/commenter/r_legacy/${emailHash}.json`)).toBe(
        true
      );

      // Second call reads index without backfilling (marker remains generation 1)
      const markerGenBefore = gcs.objects.get(
        'm/commenter/r_legacy/_complete.json'
      )?.generation;
      const second = await store.listCommenters('r_legacy');
      expect(second).toEqual([email]);
      const markerGenAfter = gcs.objects.get(
        'm/commenter/r_legacy/_complete.json'
      )?.generation;
      expect(markerGenAfter).toBe(markerGenBefore);
    });

    test('deleteCommentsForRelic sweeps the commenter index and marker', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);

      await store.putComment({
        id: 'c1',
        relicId: 'r_sweep',
        author: 'reader@example.com',
        createdAt: 1000,
        ciphertext: 'dGVzdA',
      });

      // Initialize and complete commenter index
      await store.listCommenters('r_sweep');

      const authorHash = await sha256Hex('reader@example.com');
      expect(gcs.objects.has(`m/commenter/r_sweep/${authorHash}.json`)).toBe(
        true
      );
      expect(gcs.objects.has('m/commenter/r_sweep/_complete.json')).toBe(true);

      await store.deleteCommentsForRelic('r_sweep');

      expect(gcs.objects.has(`m/commenter/r_sweep/${authorHash}.json`)).toBe(
        false
      );
      expect(gcs.objects.has('m/commenter/r_sweep/_complete.json')).toBe(false);
      expect(await store.listCommenters('r_sweep')).toEqual([]);
    });
  });
  describe('decisions, passkeys, and challenges', () => {
    test('recordVersionDigest records and preserves first writer', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      await store.putRelic(row({ id: 'r_dig' }));

      const d1 = await store.recordVersionDigest('r_dig', 1, 'sha_first');
      expect(d1).toBe('sha_first');

      const d2 = await store.recordVersionDigest('r_dig', 1, 'sha_second');
      expect(d2).toBe('sha_first');

      const readBack = await store.getRelic('r_dig');
      expect(readBack?.versionDigests?.['1']).toBe('sha_first');
    });

    test('appendDecision, listDecisions, and deleteDecisionsForRelic', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);

      await store.appendDecision({
        id: 'dec2',
        relicId: 'r_dec',
        version: 1,
        verdict: 'approve',
        author: 'a@example.com',
        createdAt: 2000,
        versionDigest: 'sha1',
        credentialId: 'cred1',
      });

      await store.appendDecision({
        id: 'dec1',
        relicId: 'r_dec',
        version: 1,
        verdict: 'reject',
        author: 'b@example.com',
        createdAt: 1000,
        versionDigest: 'sha1',
        credentialId: 'cred2',
      });

      // Duplicate decision id throws
      await expect(
        store.appendDecision({
          id: 'dec1',
          relicId: 'r_dec',
          version: 1,
          verdict: 'approve',
          author: 'b@example.com',
          createdAt: 3000,
          versionDigest: 'sha1',
          credentialId: 'cred2',
        })
      ).rejects.toThrow();

      // Ordered by createdAt, then id
      const list = await store.listDecisions('r_dec');
      expect(list.map((d) => d.id)).toEqual(['dec1', 'dec2']);

      const deleted = await store.deleteDecisionsForRelic('r_dec');
      expect(deleted).toBe(2);
      expect(await store.listDecisions('r_dec')).toEqual([]);
    });

    test('listDecisions caps fan-out concurrency to 16 with > 16 decisions and preserves ordering', async () => {
      const gcs = fakeGcs();
      let activeGets = 0;
      let maxActiveGets = 0;
      const origFetch = gcs.fetch.bind(gcs);
      gcs.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        const url = new URL(
          typeof input === 'string' ? input : input.toString()
        );
        const isObjectGet =
          !url.pathname.startsWith('/upload/') &&
          !url.pathname.endsWith('/o') &&
          (init?.method === undefined || init.method === 'GET');
        if (isObjectGet) {
          activeGets++;
          if (activeGets > maxActiveGets) maxActiveGets = activeGets;
          await Promise.resolve();
          try {
            return await origFetch(input, init);
          } finally {
            activeGets--;
          }
        }
        return origFetch(input, init);
      }) as unknown as typeof fetch;

      const store = storeOn(gcs);
      for (let i = 25; i >= 1; i--) {
        await store.appendDecision({
          id: `dec_${String(i).padStart(2, '0')}`,
          relicId: 'r_many',
          version: 1,
          verdict: 'approve',
          author: `user${i}@example.com`,
          createdAt: i * 1000,
          versionDigest: 'sha1',
          credentialId: `cred${i}`,
        });
      }

      const list = await store.listDecisions('r_many');
      expect(list.length).toBe(25);
      expect(maxActiveGets).toBe(16);
      for (let i = 0; i < 25; i++) {
        expect(list[i]?.createdAt).toBe((i + 1) * 1000);
        expect(list[i]?.id).toBe(`dec_${String(i + 1).padStart(2, '0')}`);
      }
    });

    test('createPasskeys TOFU and updatePasskeys counter check', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);

      const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
      const cred0: PasskeyCredential = {
        credentialId: 'cred1',
        publicKeyJwk: jwk,
        alg: -7,
        signCount: 1,
        createdAt: 1000,
      };
      const firstPasskey = {
        email: 'user@example.com',
        userHandle: 'handle1',
        credentials: [cred0],
      };

      expect(await store.createPasskeys(firstPasskey)).toBe(true);
      // Second createPasskeys with same email fails TOFU
      expect(await store.createPasskeys(firstPasskey)).toBe(false);

      const readBack = await store.getPasskeys('USER@example.com');
      expect(readBack?.userHandle).toBe('handle1');

      let counterError: ProblemError | undefined;
      try {
        await store.updatePasskeys('user@example.com', (curr) => ({
          ...curr,
          credentials: [{ ...cred0, signCount: 0 }],
        }));
      } catch (err) {
        if (err instanceof ProblemError) {
          counterError = err;
        }
      }
      expect(counterError?.code).toBe('passkey_verification_failed');
      expect(counterError?.options.passkey_check).toBe('counter');

      // Update with advancing counter succeeds
      const updated = await store.updatePasskeys(
        'user@example.com',
        (curr) => ({
          ...curr,
          credentials: [{ ...cred0, signCount: 2 }],
        })
      );
      expect(updated?.credentials[0]?.signCount).toBe(2);
    });

    test('two concurrent createPasskeys calls return exactly one true', async () => {
      const gcs = fakeGcs();
      const store1 = storeOn(gcs);
      const store2 = storeOn(gcs);

      const record = {
        email: 'race@example.com',
        userHandle: 'h_race',
        credentials: [],
      };

      const [r1, r2] = await Promise.all([
        store1.createPasskeys(record),
        store2.createPasskeys(record),
      ]);

      expect(r1 !== r2).toBe(true);
      expect(r1 === true || r2 === true).toBe(true);
    });

    test('two concurrent consumeWebauthnChallenge calls return exactly one row', async () => {
      const gcs = fakeGcs();
      const store1 = storeOn(gcs);
      const store2 = storeOn(gcs);

      const challengeRow = {
        challengeHash: 'hash123',
        email: 'test@example.com',
        purpose: 'register' as const,
        expiresAt: Date.now() + 60_000,
      };

      await store1.putWebauthnChallenge(challengeRow);

      const [c1, c2] = await Promise.all([
        store1.consumeWebauthnChallenge('hash123'),
        store2.consumeWebauthnChallenge('hash123'),
      ]);

      const count = (c1 !== undefined ? 1 : 0) + (c2 !== undefined ? 1 : 0);
      expect(count).toBe(1);
      const winner = c1 ?? c2;
      expect(winner?.challengeHash).toBe('hash123');
    });
    test('14. Index written on create', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const email = 'alice@example.com';
      const userHandle = 'handle_alice_123';
      const record = {
        email,
        userHandle,
        credentials: [],
      };
      const created = await store.createPasskeys(record);
      expect(created).toBe(true);

      const handleHash = await sha256Hex(userHandle);
      const emailHash = await sha256Hex(email);
      const indexObj = gcs.objects.get(`m/passkey-handle/${handleHash}.json`);
      expect(indexObj).toBeDefined();
      const indexData = JSON.parse(indexObj!.body) as {
        emailHash: string;
        createdAt: number;
      };
      expect(indexData.emailHash).toBe(emailHash);
      expect(typeof indexData.createdAt).toBe('number');

      const found = await store.getPasskeysByUserHandle(userHandle);
      expect(found).toBeDefined();
      expect(found?.email).toBe(email);
    });

    test('15. A seeded legacy record heals on update', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const email = 'legacy@example.com';
      const userHandle = 'handle_legacy_456';
      const emailHash = await sha256Hex(email);
      const handleHash = await sha256Hex(userHandle);

      gcs.objects.set(`m/passkey/${emailHash}.json`, {
        body: JSON.stringify({
          email,
          userHandle,
          credentials: [],
        }),
        generation: 1,
      });

      expect(gcs.objects.has(`m/passkey-handle/${handleHash}.json`)).toBe(
        false
      );
      expect(await store.getPasskeysByUserHandle(userHandle)).toBeUndefined();

      const updated = await store.updatePasskeys(email, (curr) => ({
        ...curr,
        credentials: [
          {
            credentialId: 'cred_new',
            publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
            alg: -7,
            signCount: 1,
            createdAt: 1000,
          },
        ],
      }));
      expect(updated).toBeDefined();

      expect(gcs.objects.has(`m/passkey-handle/${handleHash}.json`)).toBe(true);
      const found = await store.getPasskeysByUserHandle(userHandle);
      expect(found).toBeDefined();
      expect(found?.email).toBe(email);
    });

    test('16. A stale index entry resolves to nothing', async () => {
      const gcs = fakeGcs();
      const store = storeOn(gcs);
      const userHandle = 'handle_stale_789';
      const handleHash = await sha256Hex(userHandle);

      const fakeEmailHash =
        '0000000000000000000000000000000000000000000000000000000000000000';
      gcs.objects.set(`m/passkey-handle/${handleHash}.json`, {
        body: JSON.stringify({ emailHash: fakeEmailHash, createdAt: 1000 }),
        generation: 1,
      });
      expect(await store.getPasskeysByUserHandle(userHandle)).toBeUndefined();

      const realEmail = 'other@example.com';
      const realEmailHash = await sha256Hex(realEmail);
      gcs.objects.set(`m/passkey/${realEmailHash}.json`, {
        body: JSON.stringify({
          email: realEmail,
          userHandle: 'different_handle',
          credentials: [],
        }),
        generation: 1,
      });
      gcs.objects.set(`m/passkey-handle/${handleHash}.json`, {
        body: JSON.stringify({ emailHash: realEmailHash, createdAt: 1000 }),
        generation: 2,
      });
      expect(await store.getPasskeysByUserHandle(userHandle)).toBeUndefined();
    });

    test("17. An index write that returns 500 doesn't fail the create", async () => {
      const gcs = fakeGcs();
      const customFetch = async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const url = new URL(
          typeof input === 'string' ? input : input.toString()
        );
        if (url.searchParams.get('name')?.includes('passkey-handle')) {
          return new Response('Internal error', { status: 500 });
        }
        return gcs.fetch(input, init);
      };
      const store = gcsStore({
        bucket: 'relics',
        getAccessToken: async () => 'token',
        host: 'https://gcs.test',
        fetch: customFetch as typeof globalThis.fetch,
      });
      const created = await store.createPasskeys({
        email: 'fail@example.com',
        userHandle: 'h_fail',
        credentials: [],
      });
      expect(created).toBe(true);
    });

    test('18. The decoy key is created once under contention', async () => {
      const gcs = fakeGcs();
      const store1 = storeOn(gcs);
      const store2 = storeOn(gcs);

      const [key1, key2] = await Promise.all([
        store1.passkeyDecoyKey(),
        store2.passkeyDecoyKey(),
      ]);
      expect(key1.byteLength).toBe(32);
      expect(key2).toEqual(key1);

      const stored = gcs.objects.get('m/secret/passkey-decoy-key.json');
      expect(stored).toBeDefined();
      expect(stored?.generation).toBe(1);
    });

    test('versionDigests survives beginVersion, markPublished, consumeMint, claimVersionNotice, reserveShares, and putCover in both stores', async () => {
      const stores = [storeOn(fakeGcs()), new MemoryStore()];

      for (const store of stores) {
        const r = row({ id: 'r_surv', version: 1, noticePending: true });
        await store.putRelic(r);
        await store.recordVersionDigest('r_surv', 1, 'digest_v1');

        // markPublished
        await store.markPublished('r_surv', 2000, 100, 'crc');
        let cur = await store.getRelic('r_surv');
        expect(cur?.versionDigests?.['1']).toBe('digest_v1');

        // consumeMint
        await store.consumeMint('r_surv');
        cur = await store.getRelic('r_surv');
        expect(cur?.versionDigests?.['1']).toBe('digest_v1');

        // claimVersionNotice
        await store.claimVersionNotice('r_surv', 1);
        cur = await store.getRelic('r_surv');
        expect(cur?.versionDigests?.['1']).toBe('digest_v1');

        // reserveShares
        await store.reserveShares('r_surv', 1, 10);
        cur = await store.getRelic('r_surv');
        expect(cur?.versionDigests?.['1']).toBe('digest_v1');

        // putCover
        await store.putCover(
          'r_surv',
          {
            version: 1,
            sha256: 'cover_sha',
            type: 'image/png',
            kind: 'image',
            bytes: 3,
            uploadedAt: 1000,
          },
          new Uint8Array([1, 2, 3])
        );
        cur = await store.getRelic('r_surv');
        expect(cur?.versionDigests?.['1']).toBe('digest_v1');

        // beginVersion
        await store.beginVersion('r_surv', 'markdown', 200);
        cur = await store.getRelic('r_surv');
        expect(cur?.version).toBe(2);
        expect(cur?.versionDigests?.['1']).toBe('digest_v1');
      }
    });
    test('two instances racing consumeAuthLink give exactly one row', async () => {
      const gcs = fakeGcs();
      const store1 = storeOn(gcs);
      const store2 = storeOn(gcs);

      await store1.putAuthLink({
        tokenHash: 'race-token-1',
        email: 'racer@example.com',
        expiresAt: 9_000_000,
        returnTo: '/relic-race',
      });

      const [res1, res2] = await Promise.all([
        store1.consumeAuthLink('race-token-1'),
        store2.consumeAuthLink('race-token-1'),
      ]);

      const wins = [res1, res2].filter((r) => r !== undefined);
      expect(wins).toHaveLength(1);
      expect(wins[0]?.email).toBe('racer@example.com');
    });

    test('twelve concurrent reservations across two storeOn(gcs, 32) instances with limit 10 give exactly 10 true, and the row reads attempts: 12', async () => {
      const gcs = fakeGcs();
      const store1 = storeOn(gcs, 32);
      const store2 = storeOn(gcs, 32);

      const now = 10_000;
      const windowMs = 86_400_000;
      const limit = 10;
      const addressHash = 'addr-concurrent-12';

      const tasks = Array.from({ length: 12 }, (_, i) => {
        const store = i % 2 === 0 ? store1 : store2;
        return store.reserveSignInCodeAttempt(
          addressHash,
          now,
          limit,
          windowMs
        );
      });

      const results = await Promise.all(tasks);
      const trueCount = results.filter((r) => r === true).length;
      const falseCount = results.filter((r) => r === false).length;

      expect(trueCount).toBe(10);
      expect(falseCount).toBe(2);

      const object = gcs.objects.get(
        `m/challenge/sign-in-code-budget/${addressHash}.json`
      );
      expect(object).toBeDefined();
      const parsed = JSON.parse(object!.body) as {
        attempts: number;
        windowStart: number;
      };
      expect(parsed.attempts).toBe(12);
    });

    test('a both-stores conformance test covers the new methods', async () => {
      const stores = [storeOn(fakeGcs()), new MemoryStore()];

      for (const store of stores) {
        const codeRow = {
          requestHash: 'req-hash-1',
          codeMac: 'mac-1',
          linkTokenHash: 'link-hash-1',
          addressHash: 'addr-hash-1',
          expiresAt: 5000,
        };

        // putSignInCode and getSignInCode
        await store.putSignInCode(codeRow);
        const fetched = await store.getSignInCode('req-hash-1');
        expect(fetched).toEqual(codeRow);

        // deleteSignInCode
        await store.deleteSignInCode('req-hash-1');
        expect(await store.getSignInCode('req-hash-1')).toBeUndefined();

        // reserveSignInCodeAttempt
        const now = 1000;
        const windowMs = 60_000;
        const limit = 2;

        const res1 = await store.reserveSignInCodeAttempt(
          'addr-1',
          now,
          limit,
          windowMs
        );
        expect(res1).toBe(true);

        const res2 = await store.reserveSignInCodeAttempt(
          'addr-1',
          now + 10,
          limit,
          windowMs
        );
        expect(res2).toBe(true);

        // Third attempt exceeds limit
        const res3 = await store.reserveSignInCodeAttempt(
          'addr-1',
          now + 20,
          limit,
          windowMs
        );
        expect(res3).toBe(false);

        // Beyond windowMs, opens a new window
        const res4 = await store.reserveSignInCodeAttempt(
          'addr-1',
          now + windowMs + 1,
          limit,
          windowMs
        );
        expect(res4).toBe(true);
      }
    });
  });
});
