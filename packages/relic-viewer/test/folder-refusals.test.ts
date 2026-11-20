import { expect, test } from 'bun:test';
import {
  deriveKeys,
  encodeFragment,
  encodeHeader,
  encodeFolderHeader,
  encryptRecord,
  generateRelicId,
  HEADER_BYTES,
  RECORD_SIZE,
  recordCapacity,
} from '@relic/format';
import { load, type ViewerDeps } from '../src/viewer.ts';

const key = new Uint8Array(16).fill(8);
const enc = new TextEncoder();
async function fixture(
  names: string[],
  short = false,
  version = 2
): Promise<Uint8Array> {
  const paths = names.map((name) => enc.encode(name));
  const size = 4 + paths.reduce((n, path) => n + 12 + path.length, 0);
  const manifest = new Uint8Array(size);
  const view = new DataView(manifest.buffer);
  let at = 4;
  for (const path of paths) {
    view.setUint16(at, path.length);
    at += 2;
    manifest.set(path, at);
    at += path.length;
    view.setUint16(at, 0);
    at += 2;
    view.setBigUint64(at, BigInt(short ? 1 : 0));
    at += 8;
  }
  const salt = new Uint8Array(16);
  const keys = await deriveKeys(key, salt);
  const header =
    version === 2
      ? encodeFolderHeader({
          name: '',
          entryCount: names.length,
          manifestLength: size,
          contentLength: size,
        })
      : new Uint8Array([3, 0]);
  const first = await encryptRecord(
    keys,
    0,
    header,
    false,
    recordCapacity(RECORD_SIZE)
  );
  const second = await encryptRecord(keys, 1, manifest, true);
  const result = new Uint8Array(HEADER_BYTES + first.length + second.length);
  result.set(encodeHeader(salt, RECORD_SIZE));
  result.set(first, HEADER_BYTES);
  result.set(second, HEADER_BYTES + first.length);
  return result;
}
async function inspect(bytes: Uint8Array) {
  const id = generateRelicId();
  const fragment = encodeFragment(key);
  const deps: ViewerDeps = {
    serviceOrigin: 'https://example.test',
    locationHref: `https://example.test/${id}#${fragment}`,
    secureContext: () => true,
    fetch: (async () =>
      new Response(bytes as unknown as BodyInit)) as unknown as typeof fetch,
    keyVault: {
      remember() {},
      recall() {
        return undefined;
      },
      forget() {},
    },
  };
  return load(id, deps, undefined, {
    fragment,
    mint: {
      url: 'https://example.test/object',
      url_expires_at: '2999-01-01T00:00:00Z',
      relic_expires_at: null,
      object_length: bytes.length,
      object_crc32c: '',
      mints_remaining: 1,
      version: 1,
      current_version: 1,
    },
  });
}
for (const [label, names, short] of [
  ['non-NFC', ['e\u0301.txt'], false],
  ['case collision', ['A', 'a'], false],
  ['file and directory', ['a', 'a/b'], false],
  ['short length sum', ['a'], true],
] as const) {
  test(`refuses ${label}`, async () => {
    const result = await inspect(await fixture([...names], short));
    expect(result.kind).toBe('dead');
    if (result.kind === 'dead') {
      expect(result.dead.code).toBe('malformed_container');
      expect(result.dead.headline).toBe('This relic could not be read');
    }
  });
}
test('shows newer format copy for version 3', async () => {
  const result = await inspect(await fixture(['a'], false, 3));
  expect(result.kind).toBe('dead');
  if (result.kind === 'dead') {
    expect(result.dead.code).toBe('unsupported_format');
    expect(result.dead.headline).toBe('This relic uses a newer format');
  }
});
