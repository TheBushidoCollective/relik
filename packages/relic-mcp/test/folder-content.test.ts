import { describe, expect, test } from 'bun:test';
import { PLAINTEXT_CAP_BYTES } from '@relic/format';
import {
  FolderContentError,
  prepareFolderContent,
} from '../src/folder-content.ts';
import type { ConfinedBundleDirectory } from '../src/publish.ts';

describe('folder content sources', () => {
  test('declares manifest size and reads each held file lazily', async () => {
    let opens = 0;
    let closes = 0;
    const root: ConfinedBundleDirectory = {
      async openRegular() {
        opens++;
        return {
          size: 3,
          async readInto(target) {
            target.set([1, 2, 3]);
          },
          async close() {
            closes++;
          },
        };
      },
      async close() {},
    };
    const prepared = await prepareFolderContent(root, [
      { path: 'a.txt', sourcePath: 'a.txt', size: 3 },
    ]);
    expect(prepared.contentLength).toBe(prepared.manifest.length + 3);
    expect(opens).toBe(2);
    const chunks: number[] = [];
    for await (const chunk of prepared.entries[0]!.bytes.chunks())
      chunks.push(...chunk);
    expect(chunks).toEqual([1, 2, 3]);
    expect(opens).toBe(3);
    expect(closes).toBe(3);
  });
  test('refuses when an entry changes before a later stream read', async () => {
    let size = 3;
    const root: ConfinedBundleDirectory = {
      async openRegular() {
        return {
          size,
          async readInto(target) {
            target.fill(1);
          },
          async close() {},
        };
      },
      async close() {},
    };
    const prepared = await prepareFolderContent(root, [
      { path: 'a', sourcePath: 'a', size: 3 },
    ]);
    size = 4;
    try {
      for await (const _chunk of prepared.entries[0]!.bytes.chunks()) {
        /* consume */
      }
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(FolderContentError);
      expect(error).toMatchObject({ code: 'file_changed_during_publish' });
    }
  });
  test('rejects an oversized file before reading it', async () => {
    let reads = 0;
    const root: ConfinedBundleDirectory = {
      async openRegular() {
        return {
          size: PLAINTEXT_CAP_BYTES,
          async readInto() {
            reads++;
          },
          async close() {},
        };
      },
      async close() {},
    };
    await expect(
      prepareFolderContent(root, [
        { path: 'a', sourcePath: 'a', size: PLAINTEXT_CAP_BYTES },
      ])
    ).rejects.toMatchObject({ code: 'local_size_precheck_failed' });
    expect(reads).toBe(0);
  });
  test('rejects a missing default entry', async () => {
    const root: ConfinedBundleDirectory = {
      async openRegular() {
        return { size: 0, async readInto() {}, async close() {} };
      },
      async close() {},
    };
    await expect(
      prepareFolderContent(
        root,
        [{ path: 'a', sourcePath: 'a', size: 0 }],
        'absent'
      )
    ).rejects.toMatchObject({ code: 'open_first_not_found' });
  });
});
