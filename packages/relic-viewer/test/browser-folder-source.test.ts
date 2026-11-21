import { describe, expect, test } from 'bun:test';
import { openAnyRelic, openFolder } from '@relic/format';
import { prepareBrowserDirectory } from '../src/browser-folder-source.ts';

function picked(path: string, content: string): File {
  const file = new File([content], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', {
    value: `project/${path}`,
  });
  return file;
}

describe('browser folder preflight', () => {
  test('applies nested ignore rules and reports excluded directories', async () => {
    const folder = await prepareBrowserDirectory(
      [],
      [
        picked('README.md', '# Read me'),
        picked('.gitignore', '.env\ndist/\n'),
        picked('.env', 'secret'),
        picked('dist/out.js', 'generated'),
        picked('node_modules/pkg/index.js', 'dependency'),
        picked('.DS_Store', 'metadata'),
        picked('nested/.gitignore', '*.tmp\n'),
        picked('nested/cache.tmp', 'ignored'),
        picked('nested/data.json', '{"ok":true}'),
      ]
    );
    expect(folder.entries.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'README.md',
      'nested/.gitignore',
      'nested/data.json',
    ]);
    expect(folder.defaultEntry).toBe('README.md');
    expect(folder.omissions.map((entry) => [entry.path, entry.reason])).toEqual(
      expect.arrayContaining([
        ['.env', 'gitignore'],
        ['dist', 'gitignore'],
        ['node_modules', 'node_modules'],
        ['.DS_Store', 'os_metadata'],
        ['nested/cache.tmp', 'gitignore'],
      ])
    );
  });
  test('renames and selects a directory entry without re-reading the folder', async () => {
    const readme = picked('README.md', '# Project');
    const notes = picked('nested/notes.txt', 'selected notes');
    let reads = 0;
    const readNotes = notes.arrayBuffer.bind(notes);
    Object.defineProperty(notes, 'arrayBuffer', {
      value: async () => {
        reads++;
        return readNotes();
      },
    });
    const folder = await prepareBrowserDirectory(
      [],
      [
        readme,
        notes,
        picked('.gitignore', 'secret.txt\n'),
        picked('secret.txt', 'omitted'),
      ]
    );
    expect(folder.shape).toBe('folder');
    expect(folder.source).toBe('directory');
    expect(folder.filename).toBe('project');
    expect(folder.defaultEntry).toBe('README.md');
    expect(folder.omissions).toContainEqual({
      path: 'secret.txt',
      reason: 'gitignore',
    });
    const initialReads = reads;
    const selected = folder.withSelection('renamed', 'nested/notes.txt');
    expect(reads).toBe(initialReads);
    expect(selected.preview.name).toBe('nested/notes.txt');
    expect(
      await selected.preview.read(selected.preview.size - 1)
    ).toBeUndefined();
    expect(reads).toBe(initialReads);
    expect(
      await (await selected.preview.read(selected.preview.size))?.text()
    ).toBe('selected notes');
    expect(reads).toBe(initialReads + 1);
    const key = new Uint8Array(16).fill(7);
    const encrypted = await selected.encrypt(key);
    const opened = await openAnyRelic(
      new Uint8Array(await encrypted.arrayBuffer()),
      key,
      { admitted: [1, 2] }
    );
    const decoded = openFolder(opened);
    expect(decoded.header.name).toBe('renamed');
    expect(decoded.header.contentLength).toBe(selected.plaintextLength);
    expect(decoded.manifest.entries[decoded.manifest.defaultIndex]?.path).toBe(
      'nested/notes.txt'
    );
    const contents = decoded.manifest.entries.map((entry, index) => [
      entry.path,
      new TextDecoder().decode(decoded.entryBytes(index)),
    ]);
    expect(contents).toEqual([
      ['.gitignore', 'secret.txt\n'],
      ['README.md', '# Project'],
      ['nested/notes.txt', 'selected notes'],
    ]);
    expect(() => selected.withSelection('renamed', 'secret.txt')).toThrow(
      'The selected default entry is not in this folder.'
    );
  });
  test('refuses colliding paths before publication', async () => {
    await expect(
      prepareBrowserDirectory([], [picked('a.txt', 'a'), picked('A.txt', 'b')])
    ).rejects.toThrow('collide');
  });
  test('refuses unsafe file names and names the rule', async () => {
    await expect(
      prepareBrowserDirectory([], [picked('bad\u202ename.txt', 'x')])
    ).rejects.toThrow('forbidden_character');
  });
  test('reports when all files were excluded', async () => {
    await expect(
      prepareBrowserDirectory([], [picked('.DS_Store', 'noise')])
    ).rejects.toThrow('All files were excluded');
  });
  test('refuses an empty folder', async () => {
    await expect(prepareBrowserDirectory([], [])).rejects.toThrow('empty');
  });
});
