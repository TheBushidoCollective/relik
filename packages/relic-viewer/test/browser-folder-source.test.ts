import { describe, expect, test } from 'bun:test';
import { MAX_PATH_DEPTH, openAnyRelic, openFolder } from '@relic/format';
import {
  MAX_BROWSER_DIRECTORY_ENTRIES,
  MAX_BROWSER_IGNORE_BYTES,
  MAX_BROWSER_IGNORE_RULES,
  prepareBrowserDirectory,
} from '../src/browser-folder-source.ts';

function picked(path: string, content: string): File {
  const file = new File([content], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', {
    value: `project/${path}`,
  });
  return file;
}

function dropFile(name: string, content = 'data'): FileSystemFileEntry {
  const file = new File([content], name);
  return {
    name,
    isDirectory: false,
    isFile: true,
    file(resolve: (file: File) => void) {
      resolve(file);
    },
  } as unknown as FileSystemFileEntry;
}

function dropDirectory(
  name: string,
  entries: FileSystemEntry[],
  onList?: () => void
): FileSystemDirectoryEntry {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader() {
      onList?.();
      let finished = false;
      return {
        readEntries(resolve: (entries: FileSystemEntry[]) => void) {
          resolve(finished ? [] : entries);
          finished = true;
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function withRoot(file: File, path: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
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

  test.each(['.git', '.GIT'])(
    'refuses selected reserved root %s without listing or reading it',
    async (rootName) => {
      let listings = 0;
      const root = dropDirectory(
        rootName,
        [dropFile('config')],
        () => listings++
      );
      await expect(prepareBrowserDirectory([root], [])).rejects.toMatchObject({
        code: 'folder_empty',
        details: { omissions: [{ path: rootName, reason: 'git_metadata' }] },
      });
      expect(listings).toBe(0);

      let reads = 0;
      const file = withRoot(
        new File(['secret'], 'config'),
        `${rootName}/config`
      );
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => {
          reads++;
          throw new Error('Reserved root must not be read');
        },
      });
      await expect(prepareBrowserDirectory([], [file])).rejects.toMatchObject({
        code: 'folder_empty',
        details: { omissions: [{ path: rootName, reason: 'git_metadata' }] },
      });
      expect(reads).toBe(0);
    }
  );

  test('uses the same case-folded reserved segments for drops and pickers', async () => {
    let excludedListings = 0;
    const excluded = ['.gIt', 'NoDe_MoDuLeS', '__MacOsX'].map((name) =>
      dropDirectory(name, [dropFile('secret')], () => excludedListings++)
    );
    const root = dropDirectory('project', [
      dropFile('README.md'),
      ...excluded,
      dropDirectory('nested', [
        dropDirectory('.git', [dropFile('config')], () => excludedListings++),
        dropDirectory('.GIT', [dropFile('config')], () => excludedListings++),
      ]),
      dropFile('.Ds_StOrE'),
      dropFile('._Apple'),
      dropDirectory('my.git', [dropFile('safe.txt')]),
    ]);
    const dropped = await prepareBrowserDirectory([root], []);
    expect(excludedListings).toBe(0);
    expect(dropped.entries.map((entry) => entry.path)).toEqual([
      'README.md',
      'my.git/safe.txt',
    ]);
    const omissions = [
      { path: '.gIt', reason: 'git_metadata' },
      { path: 'nested/.git', reason: 'git_metadata' },
      { path: 'nested/.GIT', reason: 'git_metadata' },
      { path: 'NoDe_MoDuLeS', reason: 'node_modules' },
      { path: '__MacOsX', reason: 'os_metadata' },
      { path: '.Ds_StOrE', reason: 'os_metadata' },
      { path: '._Apple', reason: 'os_metadata' },
    ];
    expect(dropped.omissions).toEqual(expect.arrayContaining(omissions));
    const selected = await prepareBrowserDirectory(
      [],
      [
        picked('README.md', 'data'),
        picked('.gIt/config', 'secret'),
        picked('nested/.git/config', 'secret'),
        picked('nested/.GIT/config', 'secret'),
        picked('NoDe_MoDuLeS/pkg', 'secret'),
        picked('__MacOsX/noise', 'secret'),
        picked('.Ds_StOrE', 'noise'),
        picked('._Apple', 'noise'),
        picked('my.git/safe.txt', 'data'),
      ]
    );
    expect(selected.omissions).toEqual(expect.arrayContaining(omissions));
    expect(selected.entries.map((entry) => entry.path)).toEqual([
      'README.md',
      'my.git/safe.txt',
    ]);
  });

  test('refuses an oversized directory batch before file reads or another listing', async () => {
    let listings = 0;
    let reads = 0;
    const file = {
      ...dropFile('file'),
      file() {
        reads++;
      },
    } as unknown as FileSystemFileEntry;
    const root = {
      name: 'project',
      isDirectory: true,
      isFile: false,
      createReader() {
        return {
          readEntries(resolve: (entries: FileSystemEntry[]) => void) {
            listings++;
            resolve(Array(MAX_BROWSER_DIRECTORY_ENTRIES + 1).fill(file));
          },
        };
      },
    } as unknown as FileSystemDirectoryEntry;
    await expect(prepareBrowserDirectory([root], [])).rejects.toMatchObject({
      code: 'too_many_files',
    });
    expect(listings).toBe(1);
    expect(reads).toBe(0);

    await expect(
      prepareBrowserDirectory(
        [],
        Array(MAX_BROWSER_DIRECTORY_ENTRIES + 1).fill(picked('a', 'x'))
      )
    ).rejects.toMatchObject({ code: 'too_many_files' });
  });

  test('accepts exactly 50,000 listed names, including ignored entries', async () => {
    let ignoredReads = 0;
    const ignored = {
      name: 'skip',
      isDirectory: false,
      isFile: true,
      file() {
        ignoredReads++;
      },
    } as unknown as FileSystemFileEntry;
    const root = dropDirectory('project', [
      dropFile('README.md'),
      dropFile('.gitignore', 'skip\n'),
      ...Array(MAX_BROWSER_DIRECTORY_ENTRIES - 2).fill(ignored),
    ]);
    const folder = await prepareBrowserDirectory([root], []);
    expect(folder.entries.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'README.md',
    ]);
    expect(folder.omissions).toContainEqual({
      path: 'skip',
      reason: 'gitignore',
    });
    expect(ignoredReads).toBe(0);
  });

  test('does not list ignored directories or read and validate ignored files', async () => {
    let excludedListings = 0;
    let ignoredReads = 0;
    const ignoredFile = (name: string) =>
      ({
        name,
        isDirectory: false,
        isFile: true,
        file() {
          ignoredReads++;
        },
      }) as unknown as FileSystemFileEntry;
    const dist = dropDirectory(
      'dist',
      Array(60_000).fill(ignoredFile('file.txt')),
      () => excludedListings++
    );
    const root = dropDirectory('project', [
      dist,
      ignoredFile('bad\u202ename.txt'),
      ignoredFile('secret.txt'),
      dropFile('.gitignore', 'dist/\nbad*\nsecret*\n'),
      dropFile('README.md'),
    ]);
    const folder = await prepareBrowserDirectory([root], []);
    expect(folder.entries.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'README.md',
    ]);
    expect(folder.omissions).toEqual(
      expect.arrayContaining([
        { path: 'dist', reason: 'gitignore' },
        { path: 'bad\u202ename.txt', reason: 'gitignore' },
        { path: 'secret.txt', reason: 'gitignore' },
      ])
    );
    expect(excludedListings).toBe(0);
    expect(ignoredReads).toBe(0);

    const pickedFolder = await prepareBrowserDirectory(
      [],
      [
        picked('dist/very/deep/ignored.txt', 'skip'),
        picked('bad\u202ename.txt', 'skip'),
        picked('.gitignore', 'dist/\nbad*\n'),
        picked('README.md', 'keep'),
      ]
    );
    expect(pickedFolder.entries.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'README.md',
    ]);
  });

  test('loads an ignored gitignore as rules, but omits it as content', async () => {
    const folder = await prepareBrowserDirectory(
      [
        dropDirectory('project', [
          dropFile('secret.txt'),
          dropFile('README.md'),
          dropFile('.gitignore', '.gitignore\nsecret.txt\n'),
        ]),
      ],
      []
    );
    expect(folder.entries.map((entry) => entry.path)).toEqual(['README.md']);
    expect(folder.omissions).toEqual(
      expect.arrayContaining([
        { path: '.gitignore', reason: 'gitignore' },
        { path: 'secret.txt', reason: 'gitignore' },
      ])
    );
  });

  test('allows an empty directory at the depth limit but does not open one beyond it', async () => {
    let deepestListings = 0;
    let child: FileSystemDirectoryEntry = dropDirectory('deep', [], () => {
      deepestListings++;
    });
    for (let i = 1; i < MAX_PATH_DEPTH; i++)
      child = dropDirectory(`d${i}`, [child]);
    const folder = await prepareBrowserDirectory(
      [dropDirectory('project', [dropFile('README.md'), child])],
      []
    );
    expect(folder.entries.map((entry) => entry.path)).toEqual(['README.md']);
    expect(deepestListings).toBe(1);

    let overLimitListings = 0;
    let overLimit: FileSystemDirectoryEntry = dropDirectory(
      'too-deep',
      [],
      () => {
        overLimitListings++;
      }
    );
    for (let i = 0; i < MAX_PATH_DEPTH; i++)
      overLimit = dropDirectory(`d${i}`, [overLimit]);
    await expect(
      prepareBrowserDirectory([dropDirectory('project', [overLimit])], [])
    ).rejects.toThrow('nested too deeply');
    expect(overLimitListings).toBe(0);

    const deepPath = `${Array(MAX_PATH_DEPTH).fill('d').join('/')}/file.txt`;
    let fileReads = 0;
    const deepFile = picked(deepPath, 'x');
    Object.defineProperty(deepFile, 'arrayBuffer', {
      value: async () => {
        fileReads++;
        return new ArrayBuffer(0);
      },
    });
    await expect(prepareBrowserDirectory([], [deepFile])).rejects.toThrow(
      'nested too deeply'
    );
    expect(fileReads).toBe(0);
  });

  test('checks total ignore-file bytes before reading the file that exceeds the limit', async () => {
    const firstText = `#${'x'.repeat(MAX_BROWSER_IGNORE_BYTES / 2 - 1)}`;
    const first = picked('.gitignore', firstText);
    const second = picked(
      'nested/.gitignore',
      'y'.repeat(MAX_BROWSER_IGNORE_BYTES / 2 + 1)
    );
    let firstReads = 0;
    let secondReads = 0;
    Object.defineProperty(first, 'text', {
      value: async () => {
        firstReads++;
        return firstText;
      },
    });
    Object.defineProperty(second, 'text', {
      value: async () => {
        secondReads++;
        return '';
      },
    });
    await expect(prepareBrowserDirectory([], [first, second])).rejects.toThrow(
      'ignore files exceed'
    );
    expect(firstReads).toBe(1);
    expect(secondReads).toBe(0);
  });

  test('stops before reading another ignore file when the rule limit is exceeded', async () => {
    const first = picked(
      '.gitignore',
      'x\n'.repeat(MAX_BROWSER_IGNORE_RULES / 2)
    );
    const second = picked(
      'nested/.gitignore',
      'y\n'.repeat(MAX_BROWSER_IGNORE_RULES / 2 + 1)
    );
    const third = picked('nested/deeper/.gitignore', '*.tmp');
    let reads = 0;
    Object.defineProperty(third, 'text', {
      value: async () => {
        reads++;
        return '*.tmp';
      },
    });
    await expect(
      prepareBrowserDirectory([], [first, second, third])
    ).rejects.toThrow('Too many ignore rules');
    expect(reads).toBe(0);
  });

  test('preserves cancellation during directory enumeration and file callbacks', async () => {
    const listing = new AbortController();
    const listingReason = new Error('stop listing');
    const root = {
      name: 'project',
      isDirectory: true,
      isFile: false,
      createReader() {
        return {
          readEntries(resolve: (entries: FileSystemEntry[]) => void) {
            listing.abort(listingReason);
            resolve([]);
          },
        };
      },
    } as unknown as FileSystemDirectoryEntry;
    await expect(
      prepareBrowserDirectory([root], [], { signal: listing.signal })
    ).rejects.toBe(listingReason);

    const reading = new AbortController();
    const readingReason = new Error('stop file callback');
    const entry = {
      name: 'README.md',
      isDirectory: false,
      isFile: true,
      file(resolve: (file: File) => void) {
        reading.abort(readingReason);
        resolve(new File(['data'], 'README.md'));
      },
    } as unknown as FileSystemFileEntry;
    await expect(
      prepareBrowserDirectory([entry], [], { signal: reading.signal })
    ).rejects.toBe(readingReason);
  });

  test('preserves cancellation during ignore-file text reads', async () => {
    const controller = new AbortController();
    const reason = new Error('stop ignore read');
    const file = picked('.gitignore', '*.tmp');
    Object.defineProperty(file, 'text', {
      value: async () => {
        controller.abort(reason);
        return '*.tmp';
      },
    });
    await expect(
      prepareBrowserDirectory([], [file], { signal: controller.signal })
    ).rejects.toBe(reason);
  });

  test('aborts directory and file callbacks that never return', async () => {
    const listing = new AbortController();
    const listingReason = new Error('stop pending listing');
    let listingStarted = false;
    const root = {
      name: 'project',
      isDirectory: true,
      isFile: false,
      createReader() {
        return {
          readEntries() {
            listingStarted = true;
          },
        };
      },
    } as unknown as FileSystemDirectoryEntry;
    const pendingListing = prepareBrowserDirectory([root], [], {
      signal: listing.signal,
    });
    expect(listingStarted).toBe(true);
    listing.abort(listingReason);
    await expect(pendingListing).rejects.toBe(listingReason);

    const reading = new AbortController();
    const readingReason = new Error('stop pending file callback');
    let readingStarted = false;
    const entry = {
      name: 'file.txt',
      isDirectory: false,
      isFile: true,
      file() {
        readingStarted = true;
      },
    } as unknown as FileSystemFileEntry;
    const pendingFile = prepareBrowserDirectory([entry], [], {
      signal: reading.signal,
    });
    expect(readingStarted).toBe(true);
    reading.abort(readingReason);
    await expect(pendingFile).rejects.toBe(readingReason);
  });

  test('aborts an ignore-file text read that never settles', async () => {
    const controller = new AbortController();
    const reason = new Error('stop pending ignore read');
    const { promise } = Promise.withResolvers<string>();
    const file = picked('.gitignore', '*.tmp');
    let started = false;
    Object.defineProperty(file, 'text', {
      value: () => {
        started = true;
        return promise;
      },
    });
    const pending = prepareBrowserDirectory([], [file], {
      signal: controller.signal,
    });
    expect(started).toBe(true);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test('reports pattern and matching work limits as source failures', async () => {
    await expect(
      prepareBrowserDirectory(
        [],
        [picked('.gitignore', 'x'.repeat(1025)), picked('README.md', 'ok')]
      )
    ).rejects.toMatchObject({
      code: 'source_unreadable',
      details: { limit: 1024, kind: 'pattern_bytes' },
    });

    const segment = 'x'.repeat(253);
    const path = `root/${segment}/${segment}/${segment}/${segment}`;
    await expect(
      prepareBrowserDirectory(
        [],
        [picked('.gitignore', `root/${'*a'.repeat(509)}`), picked(path, 'data')]
      )
    ).rejects.toMatchObject({
      code: 'source_unreadable',
      details: { limit: 1_000_000, kind: 'work' },
    });
  });

  test('yields during large directory enumeration so cancellation can run', async () => {
    const controller = new AbortController();
    const reason = new Error('stop yielded traversal');
    let reads = 0;
    const file = {
      name: 'file',
      isDirectory: false,
      isFile: true,
      file() {
        reads++;
      },
    } as unknown as FileSystemFileEntry;
    const root = dropDirectory('project', Array(2000).fill(file));
    // A real timer turn proves traversal yields to browser events, not just microtasks.
    setTimeout(() => controller.abort(reason), 0);
    await expect(
      prepareBrowserDirectory([root], [], { signal: controller.signal })
    ).rejects.toBe(reason);
    expect(reads).toBe(0);
  });
});
