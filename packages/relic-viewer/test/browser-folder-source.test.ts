import { describe, expect, test } from 'bun:test';
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
    expect(folder.entries[folder.defaultIndex]?.path).toBe('README.md');
    expect(folder.leftOut.map((entry) => [entry.path, entry.reason])).toEqual(
      expect.arrayContaining([
        ['.env', 'gitignore'],
        ['dist', 'gitignore'],
        ['node_modules', 'node_modules'],
        ['.DS_Store', 'os_metadata'],
        ['nested/cache.tmp', 'gitignore'],
      ])
    );
  });
  test('refuses colliding paths before publication', async () => {
    await expect(
      prepareBrowserDirectory([], [picked('a.txt', 'a'), picked('A.txt', 'b')])
    ).rejects.toThrow('collide');
  });
  test('refuses an empty folder', async () => {
    await expect(prepareBrowserDirectory([], [])).rejects.toThrow('empty');
  });
});
