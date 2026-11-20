import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createIgnoreMatcher } from '../src/gitignore.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const seed = 0x73a219cb;

describe('gitignore', () => {
  const cases: Array<[string, string, boolean, boolean]> = [
    ['secret/\n!secret/key\n', 'secret/key', false, true],
    ['secret/*\n!secret/key\n', 'secret/key', false, false],
    ['**/foo\n', 'a/b/foo', false, true],
    ['foo/**\n', 'foo', true, false],
    ['foo/**\n', 'foo/a', false, true],
    ['a/**/b\n', 'a/b', false, true],
    ['a/**/b\n', 'a/x/y/b', false, true],
    ['foo/\n', 'foo', false, false],
    ['foo/\n', 'foo', true, true],
    ['\\#name\n\\!name\n', '#name', false, true],
    ['\\#name\n\\!name\n', '!name', false, true],
    ['name   \n', 'name', false, true],
    ['name\\ \n', 'name ', false, true],
    ['[!a-c].txt\n', 'z.txt', false, true],
    ['[!a-c].txt\n', 'b.txt', false, false],
    ['/foo\n', 'a/foo', false, false],
    ['foo\n', 'a/foo', false, true],
    ['foo\\*\n', 'foo*', false, true],
    ['?\n', 'é', false, false],
    ['??\n', 'é', false, true],
    ['[[:digit:]].txt\n', '1.txt', false, true],
    ['[z-a]\n', 'z', false, true],
    ['foo[\n', 'foo[', false, false],
  ];
  test.each(cases)(
    '%p matches %p (directory %p) as %p',
    (text, path, dir, expected) => {
      expect(createIgnoreMatcher([{ dir: '', text }])(path, dir)).toBe(
        expected
      );
    }
  );
  test('nested rules override parent unless the directory is excluded', () => {
    expect(
      createIgnoreMatcher([
        { dir: 'a', text: '!secret\n' },
        { dir: '', text: 'secret\n' },
      ])('a/secret', false)
    ).toBe(false);
    expect(
      createIgnoreMatcher([
        { dir: '', text: 'a/\n' },
        { dir: 'a', text: '!secret\n' },
      ])('a/secret', false)
    ).toBe(true);
  });

  (gitAvailable ? test : test.skip)(
    'differential against git check-ignore (requires git)',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'relic-ignore-'));
      let state = seed;
      const random = (n: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
      };
      const dirs = ['a', 'a/b', 'a/x', 'foo', 'foo/bar', 'secret', 'z'];
      const names = [
        'foo',
        'b',
        'key',
        'secret',
        'a.txt',
        'z.txt',
        '.env',
        '#name',
        '!name',
        'name ',
        'foo*',
        'é',
        '1.txt',
      ];
      const paths = [
        ...dirs.map((path) => ({ path, directory: true })),
        ...['', ...dirs]
          .flatMap((dir) =>
            names.map((name) => ({
              path: dir ? `${dir}/${name}` : name,
              directory: false,
            }))
          )
          .filter(({ path }) => !dirs.includes(path)),
      ];
      const patterns = [
        '#comment',
        '',
        'foo',
        '/foo',
        'foo/',
        'foo/**',
        '**/foo',
        'a/**/b',
        '*.txt',
        '!a.txt',
        '/a/b',
        'a/*/key',
        '?oo',
        '[a-z].txt',
        '[!a-c].txt',
        '[[:digit:]].txt',
        '??',
        '[z-a]',
        'foo[',
        'secret/',
        '!secret/',
        'secret/*',
        '!secret/key',
        '.env',
        '\\#name',
        '\\!name',
        'name   ',
        'name\\ ',
        'foo\\*',
        'a/**',
        '!a/b/',
        '**/key',
      ];
      try {
        const init = spawnSync('git', ['init', '-q', root], {
          encoding: 'utf8',
        });
        if (init.status !== 0)
          throw new Error(`git init failed: ${init.stderr}`);
        for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
        for (const item of paths) {
          if (item.directory) continue;
          const filename = join(root, item.path);
          mkdirSync(dirname(filename), { recursive: true });
          writeFileSync(filename, '');
        }
        for (let round = 0; round < 50; round++) {
          const rootRules = Array.from(
            { length: 12 },
            () => patterns[random(patterns.length)]
          ).join('\n');
          const nestedRules = Array.from(
            { length: 8 },
            () => patterns[random(patterns.length)]
          ).join('\n');
          writeFileSync(join(root, '.gitignore'), rootRules);
          writeFileSync(join(root, 'a', '.gitignore'), nestedRules);
          const match = createIgnoreMatcher([
            { dir: '', text: rootRules },
            { dir: 'a', text: nestedRules },
          ]);
          const git = spawnSync(
            'git',
            [
              '-c',
              'core.excludesFile=/dev/null',
              '-c',
              'core.ignoreCase=false',
              'check-ignore',
              '--no-index',
              '-v',
              '-z',
              '--non-matching',
              '--stdin',
            ],
            {
              cwd: root,
              input: `${paths.map(({ path }) => path).join('\0')}\0`,
              encoding: 'utf8',
            }
          );
          if (git.status !== 0 && git.status !== 1)
            throw new Error(`git check-ignore failed: ${git.stderr}`);
          const fields = git.stdout.split('\0');
          for (let i = 0; i < paths.length; i++) {
            const pattern = fields[i * 4 + 2];
            const expected = !!pattern && !pattern.startsWith('!');
            const item = paths[i];
            const actual = match(item.path, item.directory);
            if (actual !== expected) {
              throw new Error(
                `seed=${seed} round=${round} path=${JSON.stringify(item)} git=${JSON.stringify(pattern)} expected=${expected} actual=${actual}\nroot:\n${rootRules}\na/:\n${nestedRules}`
              );
            }
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
