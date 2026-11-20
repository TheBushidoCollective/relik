import { expect, test } from 'bun:test';
import {
  encryptFolder,
  openAnyRelic,
  openFolder,
  reencryptFolder,
} from '../src/folder-container.ts';
import { StrictParseError, VersionMismatchError } from '../src/errors.ts';
import { decodeEnvelope } from '../src/envelope.ts';
import {
  decodeHeader,
  decryptRecord,
  deriveKeys,
  HEADER_BYTES,
} from '../src/rfc8188.ts';
import golden from './folder-golden.json';
import { MAX_ENTRIES } from '../src/multi.ts';

const key = new Uint8Array(16).fill(7);
for (const count of [1, MAX_ENTRIES])
  test(`opens ${count} folder entries`, async () => {
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `${String(i).padStart(5, '0')}.txt`,
      mimetype: 'text/plain',
      bytes: new Uint8Array([i % 256]),
    }));
    const encrypted = await encryptFolder({
      name: 'folder',
      defaultIndex: 0,
      entries,
      key,
      salt: new Uint8Array(16),
    });
    const opened = openFolder(
      await openAnyRelic(encrypted, key, { admitted: [1, 2] })
    );
    expect(opened.header.entryCount).toBe(count);
    expect(opened.entryBytes(count - 1)).toEqual(entries[count - 1]!.bytes);
  });
test('refuses 5001 entries', async () => {
  const entries = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({
    path: `${String(i).padStart(5, '0')}`,
    mimetype: '',
    bytes: new Uint8Array(),
  }));
  await expect(
    encryptFolder({ name: '', defaultIndex: 0, entries, key })
  ).rejects.toBeInstanceOf(StrictParseError);
});

test('fixed vector opens, reencrypts identically and fails closed in the old reader', async () => {
  const key = Uint8Array.from(Buffer.from(golden.key, 'hex'));
  const salt = Uint8Array.from(Buffer.from(golden.salt, 'hex'));
  const bytes = Uint8Array.from(Buffer.from(golden.object, 'hex'));
  const opened = await openAnyRelic(bytes, key, { admitted: [1, 2] });
  const folder = openFolder(opened);
  expect(folder.header).toEqual({
    version: 2,
    name: 'Example',
    entryCount: 3,
    manifestLength: 108,
    contentLength: 116,
  });
  expect(folder.manifest).toEqual({
    defaultIndex: 0,
    entries: [
      { path: 'README.md', mimetype: 'text/markdown', offset: 108, length: 6 },
      {
        path: 'data/a.json',
        mimetype: 'application/json',
        offset: 114,
        length: 2,
      },
      { path: 'empty.txt', mimetype: 'text/plain', offset: 116, length: 0 },
    ],
  });
  expect(
    await reencryptFolder({
      header: folder.header,
      parts: [opened.content],
      key,
      salt,
      rs: golden.rs,
    })
  ).toEqual(bytes);
  const framing = decodeHeader(bytes);
  const first = await decryptRecord(
    await deriveKeys(key, framing.salt),
    0,
    bytes.subarray(HEADER_BYTES, HEADER_BYTES + framing.rs)
  );
  // This is the unchanged v1-only decoder from main, not a substitute implementation.
  expect(() => decodeEnvelope(first.data, 1)).toThrow(VersionMismatchError);
});
