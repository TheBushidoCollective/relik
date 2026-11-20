import { expect, test } from 'bun:test';
import { contentFromBlob, contentFromBytes } from '../src/content.ts';
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

test('compares past the first 8 MiB chunk and stops at the first difference', async () => {
  const size = 8 * 1024 * 1024 + 2;
  const a = new Uint8Array(size);
  const b = new Uint8Array(size);
  b[size - 1] = 1;
  const reads: number[] = [];
  const tracked = (bytes: Uint8Array) => {
    const content = contentFromBytes(bytes);
    return {
      ...content,
      read: async (start: number, end: number) => {
        reads.push(end - start);
        return content.read(start, end);
      },
    };
  };
  const before = { ...file('large.txt', ''), content: tracked(a) };
  const after = { ...file('large.txt', '', 2), content: tracked(b) };
  const result = await compareFolderFiles(before, after, (name) => name);
  expect(result[0]?.kind).toBe('changed');
  expect(reads).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 2, 2]);
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
  const chunk = new Uint8Array(1024 * 1024);
  const whole = await contentFromBlob(new Blob(Array(120).fill(chunk)));
  const large = {
    ...multiple,
    folder: {
      ...multiple.folder!,
      whole,
    },
  };
  const availability = comparisonAvailability(large);
  expect(availability.kind).toBe('unavailable');
  if (availability.kind !== 'unavailable') throw new Error('expected refusal');
  expect(availability.detail).toBe(FOLDER_COMPARE_LIMIT_COPY);
  expect(comparisonAvailability(multiple).kind).toBe('available');
});
