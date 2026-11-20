import { describe, expect, test } from 'bun:test';
import { droppedFrom } from '../src/drop-anywhere.ts';
import { isFileDrag } from '../src/file-drag.ts';

describe('which drags the page takes', () => {
  test('takes a drag that carries files, whatever else it carries', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(['text/plain', 'Files'])).toBe(true);
  });

  test('leaves a text selection, a link and a page element alone', () => {
    // These are the drags the comment composer, the divider and the timeline
    // already use. Taking one would break them.
    expect(isFileDrag(['text/plain'])).toBe(false);
    expect(isFileDrag(['text/uri-list', 'text/html'])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });

  test('a drag with no data transfer is not a file drag', () => {
    expect(isFileDrag(null)).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});

describe('what a drop carried', () => {
  const file = (name: string) => new File(['x'], name);

  test('reports a folder from its entry, since a folder arrives as an unreadable file', () => {
    const transfer = {
      files: [file('reports')],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
    } as unknown as DataTransfer;

    expect(droppedFrom(transfer).isFolder).toBe(true);
  });

  test('reports an ordinary file as not a folder, and keeps every file that was dropped', () => {
    const transfer = {
      files: [file('a.md'), file('b.md')],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    } as unknown as DataTransfer;

    const dropped = droppedFrom(transfer);
    expect(dropped.isFolder).toBe(false);
    expect(dropped.files.map((f) => f.name)).toEqual(['a.md', 'b.md']);
  });

  test('captures every entry synchronously, including a folder after a file', () => {
    const entries = [{ isDirectory: false }, { isDirectory: true }];
    const transfer = {
      files: [file('a.md'), file('reports')],
      items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
    } as unknown as DataTransfer;
    const dropped = droppedFrom(transfer);
    expect(dropped.isFolder).toBe(true);
    expect(dropped.entries.map((entry) => entry.isDirectory)).toEqual([
      false,
      true,
    ]);
  });

  test('copes with a browser that has no entry API', () => {
    const transfer = { files: [file('a.md')] } as unknown as DataTransfer;

    expect(droppedFrom(transfer)).toEqual({
      files: [transfer.files[0] as File],
      isFolder: false,
      entries: [],
    });
  });
});
