import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFolder } from '../src/folder-source.ts';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'relic-folder-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('folder source walk', () => {
  test('applies gitignore outside git and skips reserved entries', async () => {
    await fixture(async (root) => {
      await writeFile(join(root, '.gitignore'), '.env\ndist/\n');
      await writeFile(join(root, '.env'), 'secret');
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'secret'), 'secret');
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, '.DS_Store'), 'metadata');
      await writeFile(join(root, 'visible.txt'), 'visible');
      await symlink('/etc/passwd', join(root, 'link'));
      const result = await walkFolder(root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.files.map((file) => file.path)).toEqual([
        '.gitignore',
        'visible.txt',
      ]);
      expect(result.leftOut.map(({ path, reason }) => [path, reason])).toEqual([
        ['.DS_Store', 'os_metadata'],
        ['.env', 'gitignore'],
        ['dist', 'gitignore'],
        ['link', 'symlink'],
        ['node_modules', 'node_modules'],
      ]);
    });
  });
  test('refuses empty and all-excluded folders', async () => {
    await fixture(async (root) => {
      expect(await walkFolder(root)).toMatchObject({
        ok: false,
        code: 'folder_empty',
      });
      await symlink('/etc/passwd', join(root, 'link'));
      expect(await walkFolder(root)).toMatchObject({
        ok: false,
        code: 'all-excluded',
      });
    });
  });
  test('refuses folded collisions', async () => {
    await fixture(async (root) => {
      await writeFile(join(root, 'ı'), 'a');
      await writeFile(join(root, 'I'), 'b');
      expect(await walkFolder(root)).toMatchObject({
        ok: false,
        code: 'path_collision',
      });
    });
  });
  test('refuses more than 5000 files', async () => {
    await fixture(async (root) => {
      for (let i = 0; i < 5001; i++) await writeFile(join(root, `f${i}`), '');
      expect(await walkFolder(root)).toMatchObject({
        ok: false,
        code: 'too_many_files',
        details: { file_count: 5001, limit: 5000 },
      });
    });
  });
  test('fails closed if gitignore cannot be interpreted', async () => {
    await fixture(async (root) => {
      await writeFile(join(root, '.gitignore'), '*.secret\n');
      const previous = process.env.PATH;
      try {
        process.env.PATH = root;
        expect(await walkFolder(root)).toMatchObject({
          ok: false,
          code: 'gitignore_unavailable',
        });
      } finally {
        process.env.PATH = previous;
      }
    });
  });
  test('keeps tracked files ignored after being added', async () => {
    await fixture(async (root) => {
      execFileSync('git', ['init', '-q', root]);
      await writeFile(join(root, 'tracked'), 'kept');
      execFileSync('git', ['-C', root, 'add', 'tracked']);
      await writeFile(join(root, '.gitignore'), 'tracked\n');
      const result = await walkFolder(root);
      expect(
        result.ok && result.files.some((file) => file.path === 'tracked')
      ).toBe(true);
    });
  });
});
