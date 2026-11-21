import { describe, expect, test } from 'bun:test';
import { encodeManifest } from '@relic/format';
import {
  BROWSER_PUBLISH_LIMIT_BYTES,
  prepareBrowserFolder,
  type BrowserFolderFile,
} from '../src/browser-folder-preflight.ts';

const encoder = new TextEncoder();

describe('shared browser folder preflight', () => {
  test('uses the format manifest for the selected entry and exact plaintext size', async () => {
    const content = encoder.encode('content');
    const file: BrowserFolderFile = {
      path: 'document.txt',
      size: content.length,
      async read() {
        return content;
      },
      async *chunks() {
        yield content;
      },
    };
    const folder = await prepareBrowserFolder(
      'folder',
      'directory',
      [file],
      []
    );
    const selected = folder.withSelection('renamed', 'document.txt');
    const entry = selected.entries[0]!;
    const manifest = encodeManifest(0, [
      { path: entry.path, mimetype: entry.mimetype, length: entry.size },
    ]);
    expect(selected.plaintextLength).toBe(manifest.length + content.length);
    expect(selected.entries[0]?.rendererClass).toBe('code');
  });

  test('refuses an over-cap minimum manifest before reading a file', async () => {
    let reads = 0;
    const file: BrowserFolderFile = {
      path: 'a.txt',
      size: BROWSER_PUBLISH_LIMIT_BYTES - 20,
      async read() {
        reads++;
        throw new Error('Must not read an oversized folder');
      },
      async *chunks() {
        yield await Promise.reject(
          new Error('Must not encrypt an oversized folder')
        );
      },
    };
    await expect(
      prepareBrowserFolder('folder', 'directory', [file], [])
    ).rejects.toMatchObject({ code: 'size_over_cap' });
    expect(reads).toBe(0);
  });

  test('refuses a file list over the format manifest limit before reading entries', async () => {
    let reads = 0;
    const suffix = 'x'.repeat(250);
    const files: BrowserFolderFile[] = Array.from(
      { length: 4_200 },
      (_, index) => ({
        path: `${String(index).padStart(4, '0')}${'x'.repeat(246)}/${suffix}/${suffix}/${suffix}`,
        size: 0,
        async read() {
          reads++;
          return new Uint8Array();
        },
        async *chunks() {
          yield new Uint8Array();
        },
      })
    );
    await expect(
      prepareBrowserFolder('folder', 'directory', files, [])
    ).rejects.toMatchObject({ code: 'manifest_too_large' });
    expect(reads).toBe(0);
  });

  test('rejects a file that changes length during review or streaming encryption', async () => {
    const changed: BrowserFolderFile = {
      path: 'file.txt',
      size: 3,
      async read() {
        return encoder.encode('ab');
      },
      async *chunks() {
        yield encoder.encode('abc');
      },
    };
    await expect(
      prepareBrowserFolder('folder', 'directory', [changed], [])
    ).rejects.toMatchObject({ code: 'source_unreadable' });
    const shortStream: BrowserFolderFile = {
      ...changed,
      async read() {
        return encoder.encode('abc');
      },
      async *chunks() {
        yield encoder.encode('ab');
      },
    };
    const folder = await prepareBrowserFolder(
      'folder',
      'directory',
      [shortStream],
      []
    );
    await expect(folder.encrypt(new Uint8Array(16))).rejects.toThrow(
      'entry-size-mismatch'
    );
  });

  test('preserves cancellation before and during preflight entry reads', async () => {
    const controller = new AbortController();
    const reason = new Error('stop preflight');
    let reads = 0;
    const file: BrowserFolderFile = {
      path: 'document.txt',
      size: 1,
      async read() {
        reads++;
        controller.abort(reason);
        return encoder.encode('x');
      },
      async *chunks() {
        yield encoder.encode('x');
      },
    };
    await expect(
      prepareBrowserFolder('folder', 'directory', [file], [], {
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(reads).toBe(1);
    await expect(
      prepareBrowserFolder('folder', 'directory', [file], [], {
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(reads).toBe(1);
  });

  test('does not translate a read AbortError into a source failure', async () => {
    const reason = new DOMException('Cancelled', 'AbortError');
    const file: BrowserFolderFile = {
      path: 'document.txt',
      size: 1,
      async read() {
        throw reason;
      },
      async *chunks() {
        yield encoder.encode('x');
      },
    };
    await expect(
      prepareBrowserFolder('folder', 'directory', [file], [])
    ).rejects.toBe(reason);
  });

  test('aborts a preflight read that never settles', async () => {
    const controller = new AbortController();
    const reason = new Error('stop pending preflight');
    const { promise } = Promise.withResolvers<Uint8Array>();
    let reads = 0;
    const file: BrowserFolderFile = {
      path: 'document.txt',
      size: 1,
      read() {
        reads++;
        return promise;
      },
      async *chunks() {
        yield encoder.encode('x');
      },
    };
    const pending = prepareBrowserFolder('folder', 'directory', [file], [], {
      signal: controller.signal,
    });
    expect(reads).toBe(1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
