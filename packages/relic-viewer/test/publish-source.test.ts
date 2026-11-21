import { describe, expect, test } from 'bun:test';
import { Crc32, openAnyRelic, openFolder, planStoredZip } from '@relic/format';
import {
  BROWSER_PUBLISH_LIMIT_BYTES,
  canExpandZip,
  preparePublishSource,
  PublishSourceFailure,
  type PublishSourceFailureCode,
} from '../src/publish-source.ts';

const encoder = new TextEncoder();
const key = new Uint8Array(16).fill(7);

type TestEntry = readonly [name: string, text: string];

/** Stored entries make the fixture independent of ZIP generators and timestamps. */
function zip(entries: readonly TestEntry[]): Uint8Array {
  const bodies = entries.map(([, text]) => encoder.encode(text));
  const layout = planStoredZip(
    entries.map(([name], index) => ({
      name,
      size: bodies[index]!.length,
      crc32: new Crc32().update(bodies[index]!).value(),
    }))
  );
  const result = new Uint8Array(layout.totalBytes);
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const header = layout.localHeaders[i]!;
    const body = bodies[i]!;
    result.set(header, offset);
    offset += header.length;
    result.set(body, offset);
    offset += body.length;
  }
  result.set(layout.centralDirectory, offset);
  offset += layout.centralDirectory.length;
  result.set(layout.end, offset);
  return result;
}

function selectedFile(bytes: Uint8Array, name = 'bundle.ZIP'): File {
  return new File([bytes as BlobPart], name);
}

/** Set method 8 and claimed sizes without allocating the purported expansion. */
function claimExpandedSizes(bytes: Uint8Array, sizes: readonly number[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let central = view.getUint32(bytes.length - 6, true);
  for (const size of sizes) {
    const local = view.getUint32(central + 42, true);
    view.setUint16(local + 8, 8, true);
    view.setUint32(local + 22, size, true);
    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 24, size, true);
    central +=
      46 +
      view.getUint16(central + 28, true) +
      view.getUint16(central + 30, true) +
      view.getUint16(central + 32, true);
  }
}

async function refusal(
  file: File,
  code: PublishSourceFailureCode,
  options?: Parameters<typeof preparePublishSource>[1]
): Promise<PublishSourceFailure> {
  const error: unknown = await preparePublishSource(file, options).then(
    () => {
      throw new Error('Expected the source to be refused');
    },
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(PublishSourceFailure);
  if (!(error instanceof PublishSourceFailure)) throw error;
  expect(error.code).toBe(code);
  return error;
}

const archiveEntries: readonly TestEntry[] = [
  ['docs/report.txt', 'A report'],
  ['README.md', '# Contents'],
  ['.gitignore', 'local.txt'],
  ['.git/config', 'not published'],
  ['node_modules/package/index.js', 'not published'],
  ['__MACOSX/._report', 'not published'],
  ['.DS_Store', 'not published'],
];

describe('browser publish sources', () => {
  test('raw ZIP bytes and the expanded chosen entry both survive encryption', async () => {
    const original = zip(archiveEntries);
    const file = selectedFile(original);
    expect(canExpandZip(file)).toBe(true);

    const raw = await preparePublishSource(file, {
      expand: false,
      filename: '',
    });
    if (raw.shape !== 'file') throw new Error('Expected the raw ZIP');
    expect(raw.filename).toBe('');
    expect(raw.rendererClass).toBe('archive');
    expect(raw.plaintextLength).toBe(original.length);
    expect(raw.preview.name).toBe('bundle.ZIP');
    const rawOpened = await openAnyRelic(await raw.encrypt(key), key, {
      admitted: [1, 2],
    });
    expect(rawOpened.envelope.version).toBe(1);
    if (!('entries' in rawOpened.envelope))
      throw new Error('Expected file envelope');
    expect(rawOpened.envelope.entries[0]!.filename).toBe('');
    expect(rawOpened.content).toEqual(original);

    const folder = await preparePublishSource(file);
    if (folder.shape !== 'folder') throw new Error('Expected expanded ZIP');
    expect(folder.filename).toBe('bundle');
    expect(folder.rendererClass).toBe('folder');
    expect(folder.entries.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'README.md',
      'docs/report.txt',
    ]);
    expect(folder.defaultEntry).toBe('README.md');
    expect(folder.omissions).toEqual([
      { path: '.git/config', reason: 'git_metadata' },
      { path: 'node_modules/package/index.js', reason: 'node_modules' },
      { path: '__MACOSX/._report', reason: 'os_metadata' },
      { path: '.DS_Store', reason: 'os_metadata' },
    ]);

    const selected = folder.withSelection('', 'docs/report.txt');
    expect(selected.filename).toBe('');
    expect(selected.defaultEntry).toBe('docs/report.txt');
    const ciphertext = await selected.encrypt(key);
    const opened = await openAnyRelic(
      new Uint8Array(await ciphertext.arrayBuffer()),
      key,
      { admitted: [1, 2] }
    );
    const decoded = openFolder(opened);
    expect(decoded.header.name).toBe('');
    expect(decoded.header.contentLength).toBe(selected.plaintextLength);
    expect(opened.content.length).toBe(selected.plaintextLength);
    expect(decoded.manifest.entries[decoded.manifest.defaultIndex]!.path).toBe(
      'docs/report.txt'
    );
    const expected = new Map(archiveEntries.slice(0, 3));
    for (const [index, entry] of decoded.manifest.entries.entries()) {
      expect(decoded.entryBytes(index)).toEqual(
        encoder.encode(expected.get(entry.path)!)
      );
    }
  });

  test('automatic selection prefers a root README, then a renderable file, then the first file', async () => {
    const cases: Array<{ entries: TestEntry[]; expected: string }> = [
      {
        entries: [
          ['a.txt', 'a'],
          ['README.md', 'readme'],
        ],
        expected: 'README.md',
      },
      {
        entries: [
          ['a.bin', '\0'],
          ['b.txt', 'text'],
        ],
        expected: 'b.txt',
      },
      {
        entries: [
          ['b.bin', '\0'],
          ['a.bin', '\0'],
        ],
        expected: 'a.bin',
      },
    ];
    for (const item of cases) {
      const reviewed = await preparePublishSource(
        selectedFile(zip(item.entries))
      );
      if (reviewed.shape !== 'folder') throw new Error('Expected expanded ZIP');
      expect(reviewed.defaultEntry).toBe(item.expected);
    }
  });
  test('ZIP record limit counts records even when their files will be omitted', async () => {
    const excluded = (count: number): TestEntry[] =>
      Array.from({ length: count }, (_, index) => [
        `.git/objects/${index}`,
        '',
      ]);
    const atLimit = selectedFile(
      zip([['README.md', 'ok'], ...excluded(4_999)])
    );
    const reviewed = await preparePublishSource(atLimit);
    if (reviewed.shape !== 'folder') throw new Error('Expected expanded ZIP');
    expect(reviewed.entries.map((entry) => entry.path)).toEqual(['README.md']);
    expect(reviewed.omissions).toHaveLength(4_999);
    const tooMany = selectedFile(
      zip([['README.md', 'ok'], ...excluded(5_000)])
    );
    const error = await refusal(tooMany, 'zip_invalid');
    expect(error.details['reason']).toBe('too-many-entries');
  });
  test('retains ZIP directory omissions and treats an archived gitignore as ordinary content', async () => {
    const folder = await preparePublishSource(
      selectedFile(
        zip([
          ['empty/', ''],
          ['.gitignore', 'notes.txt\n'],
          ['notes.txt', 'still included'],
        ])
      )
    );
    if (folder.shape !== 'folder') throw new Error('Expected expanded ZIP');
    expect(folder.source).toBe('zip');
    expect(folder.omissions).toContainEqual({
      path: 'empty',
      reason: 'directory',
    });
    expect(folder.entries.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'notes.txt',
    ]);
  });

  test('uses the selected filename before validating the expanded ZIP name', async () => {
    const longName = `${'a'.repeat(1025)}.zip`;
    const folder = await preparePublishSource(
      selectedFile(zip([['README.md', 'text']]), longName),
      { filename: 'chosen', openFirst: 'README.md' }
    );
    if (folder.shape !== 'folder') throw new Error('Expected expanded ZIP');
    expect(folder.filename).toBe('chosen');
    expect(folder.defaultEntry).toBe('README.md');
  });

  test('a renamed document container is never expanded based on its new name or ZIP magic', async () => {
    const cases: Array<{
      name: string;
      entries: TestEntry[];
      rendererClass: 'document' | 'spreadsheet';
    }> = [
      {
        name: 'document.docx',
        entries: [
          ['[Content_Types].xml', ''],
          ['word/document.xml', ''],
        ],
        rendererClass: 'document',
      },
      {
        name: 'workbook.xlsx',
        entries: [
          ['[Content_Types].xml', ''],
          ['xl/workbook.xml', ''],
        ],
        rendererClass: 'spreadsheet',
      },
      {
        name: 'book.epub',
        entries: [
          ['mimetype', 'application/epub+zip'],
          ['META-INF/container.xml', ''],
        ],
        rendererClass: 'document',
      },
    ];
    for (const item of cases) {
      const file = selectedFile(zip(item.entries), item.name);
      expect(canExpandZip(file)).toBe(false);
      const reviewed = await preparePublishSource(file, {
        filename: 'renamed.zip',
      });
      expect(reviewed.shape).toBe('file');
      expect(reviewed.rendererClass).toBe(item.rendererClass);
      await refusal(file, 'zip_not_supported', {
        filename: 'renamed.zip',
        expand: true,
      });
    }
  });

  test('selection rejects a missing entry and an overlong UTF-8 filename', async () => {
    const folder = await preparePublishSource(
      selectedFile(zip([['README.md', 'text']]))
    );
    if (folder.shape !== 'folder') throw new Error('Expected expanded ZIP');
    expect(() => folder.withSelection('x', 'missing')).toThrow(
      'The selected default entry is not in this ZIP.'
    );
    expect(() => folder.withSelection('é'.repeat(513))).toThrow(
      '1026 UTF-8 bytes'
    );
  });

  test('selection changes reuse the validated index and preview checks its size before reading', async () => {
    const original = selectedFile(zip(archiveEntries));
    let reads = 0;
    const tracked = {
      name: original.name,
      size: original.size,
      slice(start?: number, end?: number, type?: string) {
        reads++;
        return original.slice(start, end, type);
      },
      async arrayBuffer() {
        reads++;
        return original.arrayBuffer();
      },
    } as unknown as File;
    const reviewed = await preparePublishSource(tracked);
    if (reviewed.shape !== 'folder') throw new Error('Expected expanded ZIP');
    const readsAfterReview = reads;
    const selected = reviewed.withSelection('renamed', 'docs/report.txt');
    expect(reads).toBe(readsAfterReview);
    expect(selected.preview.name).toBe('docs/report.txt');
    expect(selected.preview.mimetype).toBe('text/plain');
    expect(
      await selected.preview.read(selected.preview.size - 1)
    ).toBeUndefined();
    expect(reads).toBe(readsAfterReview);
    const preview = await selected.preview.read(selected.preview.size);
    expect(await preview?.text()).toBe('A report');
    expect(reads).toBeGreaterThan(readsAfterReview);
    expect(() => selected.withSelection('renamed', 'missing.txt')).toThrow(
      'The selected default entry is not in this ZIP.'
    );
    expect(selected.withSelection('renamed').defaultEntry).toBe('README.md');
  });

  test('rejects unsafe, normalized-colliding, and corrupt entries before returning a reviewed folder', async () => {
    const unsafe = await refusal(
      selectedFile(zip([['../bad.txt', 'x']])),
      'zip_invalid'
    );
    expect(unsafe.details['reason']).toBe('unsafe-name');

    const normalized = await refusal(
      selectedFile(
        zip([
          ['e\u0301.txt', 'a'],
          ['é.txt', 'b'],
        ])
      ),
      'path_collision'
    );
    expect(normalized.details['rule']).toBe('duplicate');
    const folded = await refusal(
      selectedFile(
        zip([
          ['A.txt', 'a'],
          ['a.txt', 'b'],
        ])
      ),
      'path_collision'
    );
    expect(folded.details['rule']).toBe('fold_collision');
    const nesting = await refusal(
      selectedFile(
        zip([
          ['a', 'a'],
          ['a/b', 'b'],
        ])
      ),
      'path_collision'
    );
    expect(nesting.details['rule']).toBe('file_and_directory');

    const corrupt = zip([['x', 'abc']]);
    corrupt[31] = corrupt[31]! ^ 1;
    const crc = await refusal(selectedFile(corrupt), 'zip_invalid');
    expect(crc.details['reason']).toBe('crc-mismatch');
  });

  test('rejects compressed-input and advertised expansion limits before allocating the data', async () => {
    let reads = 0;
    const huge = {
      name: 'huge.zip',
      size: BROWSER_PUBLISH_LIMIT_BYTES + 1,
      slice() {
        reads++;
        throw new Error('Oversized input was read');
      },
      async arrayBuffer() {
        reads++;
        throw new Error('Oversized input was read');
      },
    } as unknown as File;
    await refusal(huge, 'size_over_cap');
    await refusal(huge, 'size_over_cap', { expand: false });
    expect(reads).toBe(0);

    const single = zip([['bomb', 'x']]);
    claimExpandedSizes(single, [BROWSER_PUBLISH_LIMIT_BYTES + 1]);
    const entry = await refusal(selectedFile(single), 'zip_invalid');
    expect(entry.details['reason']).toBe('entry-too-large');

    const aggregate = zip([
      ['a', 'x'],
      ['b', 'x'],
    ]);
    claimExpandedSizes(aggregate, [60_000_000, 60_000_000]);
    const total = await refusal(selectedFile(aggregate), 'zip_invalid');
    expect(total.details['reason']).toBe('total-too-large');
  });

  test('propagates cancellation through raw and expanded source review', async () => {
    const rawController = new AbortController();
    const rawReason = new Error('stop raw review');
    const raw = new File(['document'], 'document.txt');
    Object.defineProperty(raw, 'arrayBuffer', {
      value: async () => {
        rawController.abort(rawReason);
        return new Uint8Array().buffer;
      },
    });
    await expect(
      preparePublishSource(raw, { signal: rawController.signal })
    ).rejects.toBe(rawReason);

    const zipController = new AbortController();
    const zipReason = new Error('stop ZIP review');
    const expanded = selectedFile(zip([['README.md', 'content']]));
    Object.defineProperty(expanded, 'slice', {
      value: () => ({
        async arrayBuffer() {
          zipController.abort(zipReason);
          return new Uint8Array().buffer;
        },
      }),
    });
    await expect(
      preparePublishSource(expanded, { signal: zipController.signal })
    ).rejects.toBe(zipReason);
  });

  test('aborts a raw file read that never settles', async () => {
    const controller = new AbortController();
    const reason = new Error('stop pending raw read');
    const { promise } = Promise.withResolvers<ArrayBuffer>();
    const file = new File(['document'], 'document.txt');
    let started = false;
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        started = true;
        return promise;
      },
    });
    const pending = preparePublishSource(file, { signal: controller.signal });
    expect(started).toBe(true);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test('review and its failures make no network requests', async () => {
    const savedFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error('Review attempted a network request');
    }) as unknown as typeof globalThis.fetch;
    try {
      const reviewed = await preparePublishSource(
        selectedFile(zip(archiveEntries))
      );
      if (reviewed.shape !== 'folder') throw new Error('Expected expanded ZIP');
      const selected = reviewed.withSelection('folder', 'docs/report.txt');
      expect(await (await selected.preview.read(100))?.text()).toBe('A report');
      await refusal(selectedFile(zip([['../bad', 'x']])), 'zip_invalid');
      await refusal(selectedFile(zip(archiveEntries)), 'open_first_not_found', {
        openFirst: 'missing.txt',
      });
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
