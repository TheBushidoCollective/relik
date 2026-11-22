import { expect, test } from 'bun:test';
import { Crc32, planStoredZip } from '@relic/format';
import { prepareBrowserZip } from '../src/browser-zip-source.ts';

function storedZip(entries: readonly (readonly [string, string])[]): File {
  const encoder = new TextEncoder();
  const bodies = entries.map(([, text]) => encoder.encode(text));
  const layout = planStoredZip(
    entries.map(([name], index) => ({
      name,
      size: bodies[index]!.length,
      crc32: new Crc32().update(bodies[index]!).value(),
    }))
  );
  const bytes = new Uint8Array(layout.totalBytes);
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const header = layout.localHeaders[i]!;
    const body = bodies[i]!;
    bytes.set(header, offset);
    offset += header.length;
    bytes.set(body, offset);
    offset += body.length;
  }
  bytes.set(layout.centralDirectory, offset);
  offset += layout.centralDirectory.length;
  bytes.set(layout.end, offset);
  return new File([bytes as BlobPart], 'project.zip');
}

test('names an archive that the browser cannot read', async () => {
  const file = new File([new Uint8Array(22)], 'cloud.zip');
  Object.defineProperty(file, 'slice', {
    value: () => {
      throw new Error('not available');
    },
  });
  await expect(prepareBrowserZip(file)).rejects.toThrow(
    'Could not read cloud.zip'
  );
});

test('omits reserved ZIP segments case-insensitively and keeps gitignore as content', async () => {
  const folder = await prepareBrowserZip(
    storedZip([
      ['README.md', 'readme'],
      ['.gitignore', 'keep.txt\n'],
      ['keep.txt', 'not filtered by archived rules'],
      ['.git/config', 'secret'],
      ['.GIT/', ''],
      ['.GIT/objects/1', 'secret'],
      ['nested/.GiT/config', 'secret'],
      ['nested/NoDe_MoDuLeS/pkg', 'secret'],
      ['nested/__MacOsX/noise', 'noise'],
      ['nested/.Ds_StOrE', 'noise'],
      ['nested/._Finder', 'noise'],
      ['my.git/safe.txt', 'kept'],
    ])
  );
  expect(folder.entries.map((entry) => entry.path)).toEqual([
    '.gitignore',
    'README.md',
    'keep.txt',
    'my.git/safe.txt',
  ]);
  expect(folder.omissions).toEqual(
    expect.arrayContaining([
      { path: '.git/config', reason: 'git_metadata' },
      { path: '.GIT/objects/1', reason: 'git_metadata' },
      { path: '.GIT', reason: 'git_metadata' },
      { path: 'nested/.GiT/config', reason: 'git_metadata' },
      { path: 'nested/NoDe_MoDuLeS/pkg', reason: 'node_modules' },
      { path: 'nested/__MacOsX/noise', reason: 'os_metadata' },
      { path: 'nested/.Ds_StOrE', reason: 'os_metadata' },
      { path: 'nested/._Finder', reason: 'os_metadata' },
    ])
  );
});

test('preserves cancellation during ZIP indexing and content preflight', async () => {
  for (const phase of ['index', 'content'] as const) {
    const controller = new AbortController();
    const reason = new Error(`stop ${phase}`);
    const file = storedZip([['README.md', '1234567']]);
    const slice = file.slice.bind(file);
    let cancelled = false;
    Object.defineProperty(file, 'slice', {
      value(start: number, end: number) {
        const blob = slice(start, end);
        return {
          async arrayBuffer() {
            if (phase === 'index' || end - start === 7) {
              cancelled = true;
              controller.abort(reason);
            }
            return blob.arrayBuffer();
          },
        };
      },
    });
    await expect(
      prepareBrowserZip(file, { signal: controller.signal })
    ).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  }
});

test('does not turn an AbortError from a ZIP read into zip_invalid', async () => {
  const file = storedZip([['README.md', 'data']]);
  const reason = new DOMException('Cancelled', 'AbortError');
  Object.defineProperty(file, 'slice', {
    value: () => ({
      async arrayBuffer() {
        throw reason;
      },
    }),
  });
  await expect(prepareBrowserZip(file)).rejects.toBe(reason);
});

test('aborts ZIP indexing and entry reads that never settle', async () => {
  for (const phase of ['index', 'content'] as const) {
    const controller = new AbortController();
    const reason = new Error(`stop pending ${phase}`);
    const file = storedZip([['README.md', '1234567']]);
    const slice = file.slice.bind(file);
    const started = Promise.withResolvers<void>();
    const never = Promise.withResolvers<ArrayBuffer>();
    Object.defineProperty(file, 'slice', {
      value(start: number, end: number) {
        const blob = slice(start, end);
        return {
          arrayBuffer() {
            if (phase === 'index' || end - start === 7) {
              started.resolve();
              return never.promise;
            }
            return blob.arrayBuffer();
          },
        };
      },
    });
    const pending = prepareBrowserZip(file, { signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  }
});
