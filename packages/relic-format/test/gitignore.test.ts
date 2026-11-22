import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createIgnoreMatcher,
  MAX_IGNORE_PATTERN_BYTES,
  MAX_IGNORE_RULES,
} from '../src/gitignore.ts';

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
    ['[^a-c].txt\n', 'z.txt', false, true],
    ['[^a-c].txt\n', 'b.txt', false, false],
    ['/foo\n', 'a/foo', false, false],
    ['foo\n', 'a/foo', false, true],
    ['foo\\*\n', 'foo*', false, true],
    ['?\n', 'é', false, false],
    ['??\n', 'é', false, true],
    ['[[:digit:]].txt\n', '1.txt', false, true],
    ['[z-a]\n', 'z', false, true],
    ['foo[\n', 'foo[', false, false],
    ['foo\n', 'foo\n', false, false],
    ['**/foo\n', 'a\nb/foo', false, true],
    ['back\\\n', 'back\\', false, false],
  ];
  test.each(cases)(
    '%p matches %p (directory %p) as %p',
    async (text, path, dir, expected) => {
      const files = [{ dir: '', text }];
      expect(createIgnoreMatcher(files)(path, dir)).toBe(expected);
      const asyncMatch = createIgnoreMatcher(files, { pauseWork: 5 });
      expect(
        await asyncMatch.matchAsync(path, dir, () => Promise.resolve())
      ).toBe(expected);
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

  test('handles adversarial alternating stars without regexp backtracking', () => {
    const pattern = `${'*a'.repeat(160)}b`;
    const match = createIgnoreMatcher([{ dir: '', text: `${pattern}\n` }]);
    expect(match(`${'a'.repeat(300)}c`, false)).toBe(false);
    expect(match(`${'a'.repeat(300)}b`, false)).toBe(true);
    expect(match(`nested/${'a'.repeat(300)}b`, false)).toBe(true);
  });

  test('bounds cumulative glob work and fails closed', () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*a*a*a*a*b\n' }], {
      maxWork: 250,
    });
    expect(match('aaaab', false)).toBe(true);
    expect(() => match('a'.repeat(50), false)).toThrow(
      'Ignore rules are too complex to review safely'
    );
    expect(() => createIgnoreMatcher([], { maxWork: -1 })).toThrow(
      'nonnegative safe integer'
    );
  });

  test('matches bracket classes, directory globstars, and UTF-8 as bytes', () => {
    const match = createIgnoreMatcher([
      {
        dir: '',
        text: 'a/**/file[[:digit:]].txt\n[!a-c]??\n',
      },
    ]);
    expect(match('a/file1.txt', false)).toBe(true);
    expect(match('a/x/y/file9.txt', false)).toBe(true);
    expect(match('a/x/y/fileA.txt', false)).toBe(false);
    expect(match('zé', false)).toBe(true);
    expect(match('bé', false)).toBe(false);
  });

  test('malformed long bracket expressions do not match', () => {
    const match = createIgnoreMatcher([
      { dir: '', text: `[${'[:'.repeat(400)}\n` },
    ]);
    expect(match('anything', false)).toBe(false);
    const closed = createIgnoreMatcher([
      { dir: '', text: `[${'[:'.repeat(400)}x]\n` },
    ]);
    expect(closed('z', false)).toBe(false);
  });

  test('bounds each UTF-8 pattern and the total rules per matcher', () => {
    const atPatternLimit = createIgnoreMatcher([
      { dir: '', text: 'a'.repeat(MAX_IGNORE_PATTERN_BYTES) },
    ]);
    expect(atPatternLimit('a'.repeat(MAX_IGNORE_PATTERN_BYTES), false)).toBe(
      true
    );
    expect(() =>
      createIgnoreMatcher([{ dir: '', text: 'é'.repeat(513) }])
    ).toThrow(`${MAX_IGNORE_PATTERN_BYTES}-byte limit`);

    const match = createIgnoreMatcher([
      { dir: '', text: 'x\n'.repeat(MAX_IGNORE_RULES) },
    ]);
    expect(() => match.add({ dir: 'nested', text: 'another\n' })).toThrow(
      'Too many ignore rules'
    );
    expect(() => match('other', false)).toThrow('Too many ignore rules');
  });

  test('invalidates cached ancestor decisions when nested rules are added', () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*.txt\n' }]);
    expect(match('nested/keep.txt', false)).toBe(true);
    match.add({ dir: 'nested', text: '!keep.txt\n' });
    expect(match('nested/keep.txt', false)).toBe(false);
    expect(match('nested/drop.txt', false)).toBe(true);
  });

  test('reviews 50,000 realistic paths and 20 rules within a tenth of the budget', () => {
    const rules = [
      '*-*.log',
      '*-*.tmp',
      '*-*.cache',
      '*-*.bak',
      '*-*.swp',
      '*-*.pyc',
      '*-*.class',
      '*-*.map',
      '*-*.env',
      '*-*.orig',
      '*.min.*',
      '*.test-??.js',
      '*.bundle.*',
      '*.[oa]',
      '*~*',
      'test-??*.js',
      'debug-*.json',
      'config-*.local',
      '*.generated.*',
      '*-backup-*.txt',
    ];
    const maxWork = 2_000_000_000;
    const match = createIgnoreMatcher([{ dir: '', text: rules.join('\n') }], {
      maxWork,
      maxMatchWork: 1_000_000,
    });
    for (let i = 0; i < 50_000; i++) {
      const path = `src/features/module-${String(i % 100).padStart(3, '0')}/file-${String(i).padStart(5, '0')}.txt`;
      expect(match(path, false)).toBe(false);
    }
    expect(match.work * 10).toBeLessThan(maxWork);
  });

  test('refuses an adversarial single glob before excessive matching work', () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*a'.repeat(512) }], {
      maxWork: 2_000_000_000,
      maxMatchWork: 1_000_000,
    });
    expect(() => match('a'.repeat(1024), false)).toThrow(
      'Ignore rules are too complex to review safely'
    );
  });

  test('validates path and pause work limits like existing work limits', () => {
    for (const option of ['maxPathWork', 'pauseWork'] as const) {
      for (const value of [
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(() => createIgnoreMatcher([], { [option]: value })).toThrow(
          'nonnegative safe integer'
        );
      }
    }
    const match = createIgnoreMatcher([], { maxPathWork: 0, pauseWork: 0 });
    expect(match('anything', false)).toBe(false);
  });

  test('limits work across rules and directory prefixes for one path', async () => {
    const files = [{ dir: '', text: '*a*\n*a*\n' }];
    const options = { maxMatchWork: 17, maxPathWork: 33 };
    const sync = createIgnoreMatcher(files, options);
    expect(() => sync('bbb', false)).toThrow('work limit is 33');
    expect(() => sync('anything', false)).toThrow('work limit is 33');

    const asyncMatch = createIgnoreMatcher(files, options);
    await expect(
      asyncMatch.matchAsync('bbb', false, () => Promise.resolve())
    ).rejects.toMatchObject({ kind: 'work', limit: 33 });
    expect(() => asyncMatch('anything', false)).toThrow('work limit is 33');

    const prefixes = createIgnoreMatcher([{ dir: '', text: '*z*' }], {
      maxMatchWork: 29,
      maxPathWork: 53,
    });
    expect(() => prefixes('parent/child', false)).toThrow('work limit is 53');
  });

  test('pauses by accumulated work across paths and between rules', async () => {
    const files = [{ dir: '', text: '*a*\n' }];
    const match = createIgnoreMatcher(files, {
      maxPathWork: 17,
      pauseWork: 30,
    });
    let pauses = 0;
    const pause = async () => {
      pauses++;
    };
    expect(await match.matchAsync('bbb', false, pause)).toBe(false);
    expect(await match.matchAsync('ccc', false, pause)).toBe(false);
    expect(pauses).toBe(0);
    expect(await match.matchAsync('ddd', false, pause)).toBe(false);
    expect(pauses).toBe(1);
    expect(match.work).toBe(51);

    const singlePath = createIgnoreMatcher(
      [{ dir: '', text: '*a*\n*a*\n*a*\n' }],
      { pauseWork: 30 }
    );
    pauses = 0;
    expect(await singlePath.matchAsync('bbb', false, pause)).toBe(false);
    expect(pauses).toBe(1);

    const defaults = createIgnoreMatcher([
      { dir: '', text: '*a*\n*a*\n*a*\n' },
    ]);
    pauses = 0;
    expect(await defaults.matchAsync('bbb', false, pause)).toBe(false);
    expect(pauses).toBe(0);
  });

  test('preserves aggregate exhaustion across async paths', async () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*a*\n' }], {
      maxMatchWork: 16,
      maxPathWork: 17,
      maxWork: 50,
      pauseWork: 20,
    });
    const pause = () => Promise.resolve();
    expect(await match.matchAsync('bbb', false, pause)).toBe(false);
    expect(await match.matchAsync('ccc', false, pause)).toBe(false);
    await expect(match.matchAsync('ddd', false, pause)).rejects.toMatchObject({
      kind: 'work',
      limit: 50,
    });
    expect(() => match('eee', false)).toThrow('work limit is 50');
  });

  test('discards interrupted directory decisions and releases the add guard', async () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*z*' }], {
      pauseWork: 20,
    });
    const reason = new Error('stop matching');
    const { promise, reject } = Promise.withResolvers<void>();
    const pending = match.matchAsync('parent/child', false, () => promise);
    expect(match.work).toBe(29);
    expect(() => match.add({ dir: '', text: 'parent/' })).toThrow(
      'Cannot add ignore rules while matching'
    );
    reject(reason);
    await expect(pending).rejects.toBe(reason);
    expect(match('parent', true)).toBe(false);
    expect(match.work).toBe(58);
    match.add({ dir: '', text: 'parent/' });
    expect(match('parent/child', false)).toBe(true);
  });

  test('keeps rules immutable until every pending async match finishes', async () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*z*' }], {
      pauseWork: 0,
    });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const pendingFirst = match.matchAsync('one', false, () => first.promise);
    const pendingSecond = match.matchAsync('two', false, () => second.promise);
    first.resolve();
    expect(await pendingFirst).toBe(false);
    expect(() => match.add({ dir: '', text: 'two' })).toThrow(
      'Cannot add ignore rules while matching'
    );
    const reason = new Error('stop second match');
    second.reject(reason);
    await expect(pendingSecond).rejects.toBe(reason);
    match.add({ dir: '', text: 'two' });
    expect(match('two', false)).toBe(true);
  });

  test('a suspended match observes another match exhausting the budget', async () => {
    const match = createIgnoreMatcher([{ dir: '', text: '*z*' }], {
      maxWork: 0,
      pauseWork: 0,
    });
    const pause = Promise.withResolvers<void>();
    const pending = match.matchAsync('one', false, () => pause.promise);
    let failure: unknown;
    try {
      match('two', false);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: 'work', limit: 0 });
    pause.resolve();
    await expect(pending).rejects.toBe(failure);
  });

  test('keeps async nested-rule and directory-cache decisions in parity', async () => {
    const files = [{ dir: '', text: '*.txt\nsecret/\n' }];
    const sync = createIgnoreMatcher(files);
    const asyncMatch = createIgnoreMatcher(files, { pauseWork: 1 });
    const pause = () => Promise.resolve();
    for (const [path, directory] of [
      ['nested/keep.txt', false],
      ['secret/key', false],
    ] as const) {
      expect(await asyncMatch.matchAsync(path, directory, pause)).toBe(
        sync(path, directory)
      );
    }
    const nested = { dir: 'nested', text: '!keep.txt\n' };
    sync.add(nested);
    asyncMatch.add(nested);
    expect(await asyncMatch.matchAsync('nested/keep.txt', false, pause)).toBe(
      sync('nested/keep.txt', false)
    );
    expect(await asyncMatch.matchAsync('nested/drop.txt', false, pause)).toBe(
      sync('nested/drop.txt', false)
    );
  });

  (gitAvailable ? test : test.skip)(
    'differential against git check-ignore (requires git)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'relic-ignore-'));
      let state = seed;
      const random = (n: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
      };
      const dirs = ['a', 'a/b', 'a/x', 'foo', 'foo/bar', 'secret', 'z'];
      for (let i = 0; i < 5; i++) {
        const parent = `generated-${i}-${random(1000)}`;
        dirs.push(parent);
        let current = parent;
        const depth = 1 + random(3);
        for (let level = 0; level < depth; level++) {
          current += `/d${random(1000)}`;
          dirs.push(current);
        }
      }
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
        '[^a-c].txt',
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
          const files = [
            { dir: '', text: rootRules },
            { dir: 'a', text: nestedRules },
          ];
          const match = createIgnoreMatcher(files);
          const asyncMatch = createIgnoreMatcher(files, { pauseWork: 10_000 });
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
          for (const [i, item] of paths.entries()) {
            const pattern = fields[i * 4 + 2];
            const expected = !!pattern && !pattern.startsWith('!');
            const actual = match(item.path, item.directory);
            const asyncActual = await asyncMatch.matchAsync(
              item.path,
              item.directory,
              () => Promise.resolve()
            );
            if (actual !== expected || asyncActual !== expected) {
              throw new Error(
                `seed=${seed} round=${round} path=${JSON.stringify(item)} git=${JSON.stringify(pattern)} expected=${expected} actual=${actual} async=${asyncActual}\nroot:\n${rootRules}\na/:\n${nestedRules}`
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
