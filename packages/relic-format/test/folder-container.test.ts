import { expect, test } from 'bun:test';
import {
  encryptFolder,
  openAnyRelic,
  openFolder,
} from '../src/folder-container.ts';
import { StrictParseError } from '../src/errors.ts';
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
