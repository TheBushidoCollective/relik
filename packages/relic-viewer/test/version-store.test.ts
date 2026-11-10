import { describe, expect, test } from 'bun:test';
import {
  encodeFragment,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import { contentFromBytes } from '../src/content.ts';
import { createVersionStore } from '../src/version-store.ts';
import { type ReadyView, type ViewerDeps } from '../src/viewer.ts';

function harness(
  ciphertext: Uint8Array,
  key: Uint8Array,
  length = ciphertext.length
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
  });
});
