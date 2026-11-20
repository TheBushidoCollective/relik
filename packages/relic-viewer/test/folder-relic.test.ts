import { describe, expect, test } from 'bun:test';
import { encryptFolder, streamAnyRelicContent } from '@relic/format';
import { contentFromBytes } from '../src/content.ts';
import { entryView, openFolderRelic } from '../src/folder-relic.ts';
import type { ReadyView } from '../src/viewer.ts';

const encode = new TextEncoder();
describe('folder entry views', () => {
  test.each([
    { paths: ['README.md', 'data/a.json'], index: 1, selected: 'data/a.json' },
    { paths: ['README.md', 'data/a.json'], index: 0, selected: 'README.md' },
    { paths: ['a.txt', 'b.txt'], index: 0, selected: 'a.txt' },
  ])(
    'opens publisher default $selected',
    async ({ paths, index, selected }) => {
      const key = new Uint8Array(16).fill(3);
      const encrypted = await encryptFolder({
        key,
        name: 'folder',
        defaultIndex: index,
        entries: paths.map((path) => ({
          path,
          mimetype: 'text/plain',
          bytes: encode.encode(path),
        })),
      });
      const parts: Uint8Array[] = [];
      const header = await streamAnyRelicContent(
        new Blob([encrypted as BlobPart]).stream(),
        key,
        {
          objectLength: encrypted.length,
          onContent: (chunk) => {
            parts.push(chunk);
          },
        }
      );
      if ('entries' in header) throw new Error('expected folder');
      const whole = contentFromBytes(
        new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
      );
      const folder = await openFolderRelic(header, whole);
      expect(folder.manifest.entries[folder.index]?.path).toBe(selected);
    }
  );
  test('opens and routes authenticated entry slices without changing the shared content', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const entries = [
      {
        path: 'README.md',
        mimetype: 'text/markdown',
        bytes: encode.encode('# Folder'),
      },
      {
        path: 'data/a.json',
        mimetype: 'application/json',
        bytes: encode.encode('{"ok":true}'),
      },
      { path: 'img/p.png', mimetype: 'image/png', bytes: png },
    ];
    const key = new Uint8Array(16).fill(42);
    const encrypted = await encryptFolder({
      key,
      name: 'folder',
      defaultIndex: 0,
      entries,
    });
    const parts: Uint8Array[] = [];
    const header = await streamAnyRelicContent(
      new Blob([encrypted as BlobPart]).stream(),
      key,
      {
        objectLength: encrypted.length,
        onContent: (chunk) => {
          parts.push(chunk);
        },
      }
    );
    if ('entries' in header) throw new Error('expected folder');
    const bytes = new Uint8Array(
      await new Blob(parts as BlobPart[]).arrayBuffer()
    );
    const whole = contentFromBytes(bytes);
    const folder = await openFolderRelic(header, whole);
    const base: ReadyView = {
      filename: '',
      declaredMimetype: '',
      content: whole,
      document: undefined,
      route: 'download',
      downgradeNotice: undefined,
      shareUrl: '',
      version: 1,
      currentVersion: 1,
      versionDigest: '',
      folder,
    };
    for (let index = 0; index < entries.length; index++) {
      const view = await entryView(base, index);
      expect(await view.content.readWhole(1024)).toEqual(entries[index]!.bytes);
      expect(view.route).toBe((['markdown', 'code', 'image'] as const)[index]!);
      expect(view.folder?.whole).toBe(whole);
    }
    await expect(entryView(base, 3)).rejects.toBeInstanceOf(RangeError);
  });
});
