import { describe, expect, test } from 'bun:test';
import {
  encodeFragment,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
  HEADER_BYTES,
  SALT_BYTES,
} from '@relic/format';
import { contentFromBytes } from '../src/content.ts';
import { createVersionStore } from '../src/version-store.ts';
import { type ReadyView, type ViewerDeps } from '../src/viewer.ts';

type InjectFailure = (
  stage: 'mint' | 'download',
  attempt: number
) => Response | Error | undefined;

function harness(
  ciphertext: Uint8Array,
  key: Uint8Array,
  length = ciphertext.length,
  injectFailure?: InjectFailure
) {
  const id = generateRelicId();
  const fragment = encodeFragment(key);
  const bytes = new TextEncoder().encode('current\n');
  const boot: ReadyView = {
    filename: 'current.txt',
    declaredMimetype: 'text/plain',
    content: contentFromBytes(bytes),
    document: { bytes, truncated: false },
    route: 'code',
    downgradeNotice: undefined,
    shareUrl: `https://relik.example/${id}#${fragment}`,
    version: 4,
    currentVersion: 4,
    versionDigest: '0'.repeat(64),
  };
  const minted = new Map<number, number>();
  let fetched = 0;
  const deps: ViewerDeps = {
    serviceOrigin: 'https://relik.example',
    locationHref: boot.shareUrl,
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
    fetch: (async (input, init) => {
      if (String(input).endsWith('/mint')) {
        const version = JSON.parse(String(init?.body)).version as number;
        minted.set(version, (minted.get(version) ?? 0) + 1);
        const failure = injectFailure?.('mint', minted.get(version)!);
        if (failure instanceof Error) throw failure;
        if (failure) return failure;
        return Response.json({
          url: `https://storage.example/v${version}`,
          url_expires_at: '2099-01-01T00:00:00Z',
          relic_expires_at: null,
          object_length: length,
          object_crc32c: 'AAAAAA==',
          mints_remaining: 199,
          version,
          current_version: 4,
        });
      }
      fetched++;
      const failure = injectFailure?.('download', fetched);
      if (failure instanceof Error) throw failure;
      if (failure) return failure;
      return new Response(ciphertext as unknown as BodyInit);
    }) as typeof fetch,
  };
  return {
    store: createVersionStore(id, boot, deps),
    boot,
    minted,
    get fetched() {
      return fetched;
    },
  };
}

describe('version store', () => {
  test('concurrent readers share one mint and one authenticated download', async () => {
    const key = generateKey();
    const ciphertext = await encryptRelic({
      content: new TextEncoder().encode('historical\n'),
      filename: 'notes.txt',
      mimetype: 'text/plain',
      key,
    });
    const f = harness(ciphertext, key);
    const phases: string[] = [];
    const [first, second] = await Promise.all([
      f.store.get(2, { onProgress: (progress) => phases.push(progress.phase) }),
      f.store.get(2),
    ]);
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    expect(phases[0]).toBe('opening');
    expect(f.minted.get(2)).toBe(1);
    expect(f.fetched).toBe(1);
    expect((await f.store.get(2)).kind).toBe('ready');
    expect(f.minted.get(2)).toBe(1);
  });

  const retryableFailures: ReadonlyArray<{
    name: string;
    stage: 'mint' | 'download';
    code: string;
    failure: (ciphertext: Uint8Array) => Response | Error;
  }> = [
    {
      name: 'the mint service is unreachable',
      stage: 'mint',
      code: 'service_unreachable',
      failure: () => new Error('network unavailable'),
    },
    {
      name: 'the storage service is unreachable',
      stage: 'download',
      code: 'version_fetch_failed',
      failure: () => new Error('network unavailable'),
    },
    {
      name: 'the signed download returns an error',
      stage: 'download',
      code: 'version_fetch_failed',
      failure: () => new Response('unavailable', { status: 503 }),
    },
    {
      name: 'the signed download has no body',
      stage: 'download',
      code: 'version_truncated',
      failure: () => new Response(null),
    },
    {
      name: 'the signed download ends early',
      stage: 'download',
      code: 'version_truncated',
      failure: (ciphertext) =>
        new Response(
          ciphertext.subarray(0, ciphertext.length - 1) as unknown as BodyInit
        ),
    },
    {
      name: 'the download stream fails after its first chunk',
      stage: 'download',
      code: 'version_truncated',
      failure: (ciphertext) => {
        let started = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (started) {
                controller.error(new Error('connection lost'));
              } else {
                started = true;
                controller.enqueue(ciphertext.subarray(0, HEADER_BYTES));
              }
            },
          })
        );
      },
    },
    ...[
      { code: 'mint_rate_limited', status: 429 },
      { code: 'service_paused', status: 503 },
      { code: 'relic_not_yet_published', status: 409 },
      { code: 'invalid_relic_version', status: 400 },
      { code: 'upstream_overloaded', status: 503 },
    ].map(({ code, status }) => ({
      name: `mint returns ${code}`,
      stage: 'mint' as const,
      code,
      failure: () => Response.json({ code }, { status }),
    })),
    {
      name: 'the service signs a different version',
      stage: 'mint',
      code: 'version_mismatch',
      failure: () => Response.json({ version: 3, current_version: 4 }),
    },
    {
      name: 'the downloaded header is malformed',
      stage: 'download',
      code: 'malformed_container',
      failure: (ciphertext) => {
        const damaged = ciphertext.slice();
        damaged.fill(0, SALT_BYTES, SALT_BYTES + 4);
        return new Response(damaged as unknown as BodyInit);
      },
    },
    {
      name: 'a later encrypted record is damaged',
      stage: 'download',
      code: 'version_decrypt_failed',
      failure: (ciphertext) => {
        const damaged = ciphertext.slice();
        damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
        return new Response(damaged as unknown as BodyInit);
      },
    },
    {
      name: 'the first encrypted record cannot be decrypted',
      stage: 'download',
      code: 'version_decrypt_failed',
      failure: (ciphertext) => {
        const damaged = ciphertext.slice();
        damaged[HEADER_BYTES] = damaged[HEADER_BYTES]! ^ 1;
        return new Response(damaged as unknown as BodyInit);
      },
    },
  ];

  for (const failure of retryableFailures) {
    test(`retries after ${failure.name} and caches the recovered view`, async () => {
      const key = generateKey();
      const ciphertext = await encryptRelic({
        content: new TextEncoder().encode('historical\n'),
        filename: 'notes.txt',
        mimetype: 'text/plain',
        key,
      });
      const f = harness(ciphertext, key, undefined, (stage, attempt) =>
        stage === failure.stage && attempt === 1
          ? failure.failure(ciphertext)
          : undefined
      );

      const [first, concurrent] = await Promise.all([
        f.store.get(2),
        f.store.get(2),
      ]);
      expect(first).toBe(concurrent);
      expect(first.kind).toBe('unavailable');
      if (first.kind !== 'unavailable') throw new Error('expected failure');
      expect(first.code).toBe(failure.code);
      expect(f.minted.get(2)).toBe(1);
      expect(f.fetched).toBe(failure.stage === 'mint' ? 0 : 1);

      const recovered = await f.store.get(2);
      expect(recovered.kind).toBe('ready');
      if (recovered.kind !== 'ready') throw new Error('expected recovery');
      expect(
        new TextDecoder().decode(
          await recovered.view.content.blob('').arrayBuffer()
        )
      ).toBe('historical\n');
      expect(f.minted.get(2)).toBe(2);
      expect(f.fetched).toBe(failure.stage === 'mint' ? 1 : 2);
      expect(await f.store.get(2)).toBe(recovered);
      expect(f.minted.get(2)).toBe(2);
      expect(f.fetched).toBe(failure.stage === 'mint' ? 1 : 2);
    });
  }

  for (const { code, status } of [
    { code: 'invalid_relic_id', status: 400 },
    { code: 'relic_not_found', status: 404 },
    { code: 'relic_expired', status: 410 },
    { code: 'relic_removed', status: 410 },
    { code: 'relic_never_published', status: 410 },
    { code: 'download_cap_exhausted', status: 410 },
  ]) {
    test(`caches the permanent ${code} response`, async () => {
      const f = harness(
        new Uint8Array(),
        generateKey(),
        undefined,
        (stage, attempt) =>
          stage === 'mint' && attempt === 1
            ? Response.json({ code }, { status })
            : undefined
      );
      const first = await f.store.get(2);
      expect(first.kind === 'unavailable' && first.code).toBe(code);
      expect(await f.store.get(2)).toBe(first);
      expect(f.minted.get(2)).toBe(1);
      expect(f.fetched).toBe(0);
    });
  }

  test('caches an invalid historical version without contacting the service', async () => {
    const f = harness(new Uint8Array(), generateKey());
    const first = await f.store.get(0);
    expect(first.kind === 'unavailable' && first.code).toBe('version_invalid');
    expect(await f.store.get(0)).toBe(first);
    expect(f.minted.size).toBe(0);
    expect(f.fetched).toBe(0);
  });

  test('refuses an oversized comparison after mint and remembers that refusal without fetching or minting again', async () => {
    const f = harness(
      new Uint8Array(),
      generateKey(),
      encryptedSize(32 * 1024 * 1024)
    );
    const a = await f.store.get(2, { maxBytes: 16 * 1024 * 1024 });
    const b = await f.store.get(2, { maxBytes: 16 * 1024 * 1024 });
    expect(a.kind === 'unavailable' && a.code).toBe('version_too_large');
    expect(b.kind === 'unavailable' && b.code).toBe('version_too_large');
    expect(f.minted.get(2)).toBe(1);
    expect(f.fetched).toBe(0);
    const boot = await f.store.get(4, { maxBytes: 1 });
    expect(boot.kind === 'unavailable' && boot.code).toBe('version_too_large');
    expect((await f.store.get(4)).kind).toBe('ready');
  });

  test('a comparison refusal does not prevent opening the version alone', async () => {
    const key = generateKey();
    const bytes = new Uint8Array(17 * 1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    const ciphertext = await encryptRelic({
      content: bytes,
      filename: 'image.png',
      mimetype: 'image/png',
      key,
    });
    const f = harness(ciphertext, key);
    const refused = await f.store.get(2, { maxBytes: 16 * 1024 * 1024 });
    expect(refused.kind === 'unavailable' && refused.code).toBe(
      'version_too_large'
    );
    expect(f.fetched).toBe(0);
    expect((await f.store.get(2)).kind).toBe('ready');
    expect(f.fetched).toBe(1);
    expect(f.minted.get(2)).toBe(2);
  });

  test('evicts least recently used unpinned versions and preserves pinned versions', async () => {
    const key = generateKey();
    const bytes = new Uint8Array(24 * 1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    const ciphertext = await encryptRelic({
      content: bytes,
      filename: 'image.png',
      mimetype: 'image/png',
      key,
    });
    const f = harness(ciphertext, key);
    expect((await f.store.get(1)).kind).toBe('ready');
    expect((await f.store.get(2)).kind).toBe('ready');
    expect((await f.store.get(1)).kind).toBe('ready');
    expect((await f.store.get(3)).kind).toBe('ready');
    expect((await f.store.get(1)).kind).toBe('ready');
    expect(f.minted.get(1)).toBe(1);
    expect((await f.store.get(2)).kind).toBe('ready');
    expect(f.minted.get(2)).toBe(2);
    f.store.pin(2);
    f.store.pin(2);
    f.store.unpin(2);
    expect((await f.store.get(3)).kind).toBe('ready');
    expect((await f.store.get(1)).kind).toBe('ready');
    expect((await f.store.get(2)).kind).toBe('ready');
    expect(f.minted.get(2)).toBe(2);
    f.store.unpin(2);
    expect((await f.store.get(4)).kind).toBe('ready');
  }, 30000);
});
