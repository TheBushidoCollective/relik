import { expect, test } from 'bun:test';
import { contentFromBytes } from '../src/content.ts';
import { compareFolderFiles } from '../src/folder-compare.ts';
import {
  comparisonAvailability,
  FOLDER_COMPARE_LIMIT_COPY,
} from '../src/diff.ts';
import type { ReadyView } from '../src/viewer.ts';

const encoder = new TextEncoder();
function file(name: string, text: string, version = 1): ReadyView {
  const bytes = encoder.encode(text);
  return {
    filename: name,
    declaredMimetype: 'text/plain',
    content: contentFromBytes(bytes),
    document: { bytes, truncated: false },
    route: 'code',
    downgradeNotice: undefined,
    shareUrl: '',
    version,
    currentVersion: 2,
    versionDigest: '',
  };
}
function folder(files: Array<[string, string]>, version: number): ReadyView {
  const bytes = encoder.encode(files.map(([, text]) => text).join(''));
  let offset = 0;
  const entries = files.map(([path, text]) => {
    const length = encoder.encode(text).length;
    const entry = { path, mimetype: 'text/plain', offset, length };
    offset += length;
    return entry;
  });
  const whole = contentFromBytes(bytes);
  return {
    ...file(files[0]![0], files[0]![1], version),
    folder: {
      header: {
        version: 2,
        name: 'folder',
        entryCount: entries.length,
        manifestLength: 0,
        contentLength: bytes.length,
      },
      manifest: { defaultIndex: 0, entries },
      whole,
      index: 0,
    },
  };
}

test('compares bytes and reports changed, added, removed, and unchanged files', async () => {
  const before = folder(
    [
      ['a.md', 'before'],
      ['gone', 'x'],
      ['same', 'same'],
    ],
    1
  );
  const after = folder(
    [
      ['a.md', 'after'],
      ['new', 'x'],
      ['same', 'same'],
    ],
    2
  );
  const result = await compareFolderFiles(before, after, (name) => name);
  expect(result.map(({ path, kind }) => [path, kind])).toEqual([
    ['a.md', 'changed'],
    ['gone', 'removed'],
    ['new', 'added'],
    ['same', 'unchanged'],
  ]);
  expect(result.find((item) => item.path === 'a.md')?.beforeIndex).toBe(0);
});

test('compares single and folder shapes and refuses oversized whole folders', async () => {
  const single = file('a.md', 'same');
  const multiple = folder(
    [
      ['a.md', 'same'],
      ['b.md', 'new'],
    ],
    2
  );
  expect(
    (await compareFolderFiles(single, multiple, (name) => name)).map(
      ({ path, kind }) => [path, kind]
    )
  ).toEqual([
    ['a.md', 'unchanged'],
    ['b.md', 'added'],
  ]);
  const large = {
    ...multiple,
    folder: {
      ...multiple.folder!,
      whole: { ...multiple.folder!.whole, size: 120 * 1024 * 1024 },
    },
  };
  const availability = comparisonAvailability(large);
  expect(availability.kind).toBe('unavailable');
  if (availability.kind !== 'unavailable') throw new Error('expected refusal');
  expect(availability.detail).toBe(FOLDER_COMPARE_LIMIT_COPY);
  expect(comparisonAvailability(multiple).kind).toBe('available');
});
