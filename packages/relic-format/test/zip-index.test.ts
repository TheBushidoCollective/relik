import { describe, expect, test } from 'bun:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from '../src/otio-zip.ts';
import { zipContainerKind, zipContainerKindSync } from '../src/containers.ts';
import { indexZip, type ZipLimits } from '../src/zip-index.ts';

const limits: ZipLimits = {
  maxArchiveBytes: 100000,
  maxEntries: 20,
  maxEntryBytes: 10000,
  maxTotalBytes: 10000,
};
type File = {
  name: string;
  data?: string;
  flags?: number;
  mode?: number;
  dosAttrs?: number;
  madeBy?: number;
  extra?: Uint8Array;
  comment?: string;
  descriptor?: boolean;
  deflated?: boolean;
};
function zip(files: File[], archiveComment = ''): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name),
      data = encoder.encode(file.data ?? ''),
      extra = file.extra ?? new Uint8Array(),
      comment = encoder.encode(file.comment ?? '');
    const compressed = file.deflated ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = new Uint8Array(
        30 +
          name.length +
          extra.length +
          compressed.length +
          (file.descriptor ? 16 : 0)
      ),
      lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, (file.flags ?? 0) | (file.descriptor ? 8 : 0), true);
    lv.setUint16(8, file.deflated ? 8 : 0, true);
    lv.setUint32(14, file.descriptor ? 0 : checksum, true);
    lv.setUint32(18, file.descriptor ? 0 : compressed.length, true);
    lv.setUint32(22, file.descriptor ? 0 : data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, extra.length, true);
    local.set(name, 30);
    local.set(extra, 30 + name.length);
    local.set(compressed, 30 + name.length + extra.length);
    if (file.descriptor) {
      const start = 30 + name.length + extra.length + compressed.length;
      lv.setUint32(start, 0x08074b50, true);
      lv.setUint32(start + 4, checksum, true);
      lv.setUint32(start + 8, compressed.length, true);
      lv.setUint32(start + 12, data.length, true);
    }
    const cd = new Uint8Array(46 + name.length + extra.length + comment.length),
      cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, file.madeBy ?? 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, (file.flags ?? 0) | (file.descriptor ? 8 : 0), true);
    cv.setUint16(10, file.deflated ? 8 : 0, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint16(32, comment.length, true);
    cv.setUint32(38, (file.mode ?? 0) * 65536 + (file.dosAttrs ?? 0), true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    cd.set(extra, 46 + name.length);
    cd.set(comment, 46 + name.length + extra.length);
    locals.push(local);
    central.push(cd);
    offset += local.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const archiveCommentBytes = encoder.encode(archiveComment);
  const out = new Uint8Array(offset + size + 22 + archiveCommentBytes.length);
  let pos = 0;
  for (const chunk of [...locals, ...central]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  const end = new DataView(out.buffer, pos);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, archiveCommentBytes.length, true);
  out.set(archiveCommentBytes, pos + 22);
  return out;
}
async function reason(bytes: Uint8Array, custom = limits) {
  const result = await indexZip(bytes, custom);
  return result.ok ? 'accepted' : result.reason;
}
describe('general ZIP index', () => {
  test('recognizes office ZIPs from Python, DOS and macOS metadata', async () => {
    for (const metadata of [
      { mode: 0o600, madeBy: 0x0314 },
      { mode: 0o600, madeBy: 20 },
      { mode: 0, madeBy: 20 },
      { mode: 0o100644, madeBy: 0x031e },
    ]) {
      const bytes = zip([
        { name: '[Content_Types].xml', data: '<Types/>', ...metadata },
        { name: 'xl/', dosAttrs: 0x10, madeBy: 20 },
        { name: 'xl/workbook.xml', data: '<workbook/>', ...metadata },
      ]);
      const indexed = await indexZip(bytes, limits);
      expect(indexed.ok).toBe(true);
      if (!indexed.ok) continue;
      expect(indexed.index.entries.get('xl')?.kind).toBe('directory');
      expect(await indexed.index.read('xl/workbook.xml')).toEqual({
        ok: true,
        bytes: new TextEncoder().encode('<workbook/>'),
      });
      expect(zipContainerKindSync(bytes)).toBe('xlsx');
      expect(
        await zipContainerKind({
          size: bytes.length,
          async read(start, end) {
            return bytes.subarray(start, end);
          },
        })
      ).toBe('xlsx');
    }
  });
  test('accepts data descriptors, unknown extra fields and ZIP comments', async () => {
    const bytes = zip(
      [
        {
          name: '[Content_Types].xml',
          data: '<Types/>',
          descriptor: true,
          extra: new Uint8Array([0xfe, 0xca, 2, 0, 5, 6]),
          comment: 'entry comment',
          madeBy: 0xff14,
        },
        { name: 'word/document.xml', data: '<document/>', descriptor: true },
      ],
      'archive comment'
    );
    const result = await indexZip(bytes, limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.index.read('word/document.xml')).toEqual({
      ok: true,
      bytes: new TextEncoder().encode('<document/>'),
    });
    expect(zipContainerKindSync(bytes)).toBe('docx');
    expect(
      await zipContainerKind({
        size: bytes.length,
        async read(start, end) {
          return bytes.subarray(start, end);
        },
      })
    ).toBe('docx');
  });
  test('still refuses ZIP64 size sentinels and extra fields', async () => {
    const sentinel = zip([
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml' },
    ]);
    const view = new DataView(sentinel.buffer);
    const central = view.getUint32(sentinel.length - 6, true);
    view.setUint32(central + 20, 0xffffffff, true);
    expect(await reason(sentinel)).toBe('zip64');
    expect(zipContainerKindSync(sentinel)).toBe('archive');
    const extra = zip([
      { name: '[Content_Types].xml', extra: new Uint8Array([1, 0, 0, 0]) },
      { name: 'word/document.xml' },
    ]);
    expect(await reason(extra)).toBe('zip64');
    expect(zipContainerKindSync(extra)).toBe('archive');
    const combined = extra.slice();
    const combinedView = new DataView(combined.buffer);
    const combinedCentral = combinedView.getUint32(combined.length - 6, true);
    combinedView.setUint32(combinedCentral + 20, 0xffffffff, true);
    combinedView.setUint32(combinedCentral + 24, 0xffffffff, true);
    expect(await reason(combined)).toBe('zip64');
    expect(zipContainerKindSync(combined)).toBe('archive');
  });
  test('reads a regular file', async () => {
    const result = await indexZip(
      zip([{ name: 'a.txt', data: 'hello' }]),
      limits
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.entries.get('a.txt')?.kind).toBe('file');
    expect(await result.index.read('a.txt')).toEqual({
      ok: true,
      bytes: new TextEncoder().encode('hello'),
    });
  });
  test('stops indexing after an aborted source read', async () => {
    const bytes = zip([
      { name: 'a.txt', data: 'hello' },
      { name: 'b.txt', data: 'world' },
    ]);
    const active = new AbortController();
    const complete = await indexZip(bytes, limits, undefined, active.signal);
    expect(complete.ok).toBe(true);
    if (complete.ok) {
      expect(await complete.index.read('a.txt')).toEqual({
        ok: true,
        bytes: new TextEncoder().encode('hello'),
      });
    }
    const aborted = new AbortController();
    aborted.abort();
    let reads = 0;
    const source = {
      size: bytes.length,
      async read(start: number, end: number) {
        reads++;
        return bytes.subarray(start, end);
      },
    };
    expect(await indexZip(source, limits, undefined, aborted.signal)).toEqual({
      ok: false,
      reason: 'corrupt',
      message: 'ZIP operation aborted',
    });
    expect(reads).toBe(0);

    for (const heldRead of [1, 2, 3, 4, 5, 6]) {
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      reads = 0;
      const result = indexZip(
        {
          size: bytes.length,
          async read(start, end) {
            reads++;
            if (reads === heldRead) {
              started.resolve();
              await release.promise;
            }
            return bytes.subarray(start, end);
          },
        },
        limits,
        undefined,
        controller.signal
      );
      await started.promise;
      controller.abort();
      release.resolve();
      expect(await result).toEqual({
        ok: false,
        reason: 'corrupt',
        message: 'ZIP operation aborted',
      });
      expect(reads).toBe(heldRead);
    }
  });

  test('stops a read aborted while its inflater is running', async () => {
    const archive = zip([{ name: 'a.txt', data: 'hello', deflated: true }]);
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const indexed = await indexZip(
      archive,
      limits,
      async (compressed) => {
        started.resolve();
        await release.promise;
        return new Uint8Array(inflateRawSync(compressed));
      },
      controller.signal
    );
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;
    const read = indexed.index.read('a.txt');
    await started.promise;
    controller.abort();
    release.resolve();
    expect(await read).toEqual({
      ok: false,
      reason: 'corrupt',
      message: 'ZIP operation aborted',
    });
  });

  test('recognizes a suffix-free DOS directory without overriding explicit file types', async () => {
    const bytes = zip([
      { name: 'folder', mode: 0o600, dosAttrs: 0x10 },
      { name: 'folder/child.txt', data: 'child', mode: 0o600 },
      { name: 'normal.txt', data: 'normal', mode: 0o100644, dosAttrs: 0x10 },
      { name: 'link', data: 'target', mode: 0o120777, dosAttrs: 0x10 },
    ]);
    const result = await indexZip(bytes, limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.entries.get('folder')?.kind).toBe('directory');
    expect(result.index.entries.get('folder/child.txt')?.kind).toBe('file');
    expect(result.index.entries.get('normal.txt')?.kind).toBe('file');
    expect(result.index.entries.get('link')?.kind).toBe('symlink');
    expect(await result.index.read('folder/child.txt')).toEqual({
      ok: true,
      bytes: new TextEncoder().encode('child'),
    });
    for (const name of ['folder', 'link']) {
      const read = await result.index.read(name);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toBe('not-a-file');
    }
  });

  test('indexes symlinks but refuses reading them', async () => {
    const result = await indexZip(
      zip([{ name: 'link', data: 'target', mode: 0o120777 }]),
      limits
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.entries.get('link')?.kind).toBe('symlink');
    const read = await result.index.read('link');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('not-a-file');
  });
  test('refuses encryption, ZIP64 and duplicate names', async () => {
    expect(await reason(zip([{ name: 'a', flags: 1 }]))).toBe('encrypted');
    const zip64 = zip([{ name: 'a' }]);
    new DataView(zip64.buffer).setUint16(zip64.length - 12, 0xffff, true);
    expect(await reason(zip64)).toBe('zip64');
    expect(await reason(zip([{ name: 'a' }, { name: 'a' }]))).toBe('duplicate');
  });
  test.each(['/a', '../a', 'a/../b', 'a\\b', 'a\0b', 'C:/a'])(
    'refuses unsafe path %p',
    async (name) => {
      expect(await reason(zip([{ name }]))).toBe('unsafe-name');
    }
  );
  test('rejects aggregate expanded size before reading entries', async () => {
    expect(
      await reason(
        zip([
          { name: 'a', data: 'abc' },
          { name: 'b', data: 'def' },
        ]),
        { ...limits, maxTotalBytes: 5 }
      )
    ).toBe('total-too-large');
  });
  test('rejects non UTF-8 names', async () => {
    const bytes = zip([{ name: 'a' }]);
    bytes[30] = 255;
    const cdOffset = new DataView(bytes.buffer).getUint32(
      bytes.length - 6,
      true
    );
    bytes[cdOffset + 46] = 255;
    expect(await reason(bytes)).toBe('bad-name-encoding');
  });
  test('returns a named CRC refusal on read', async () => {
    const bytes = zip([{ name: 'a', data: 'x' }]);
    bytes[31] = 121;
    const result = await indexZip(bytes, limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = await result.index.read('a');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('crc-mismatch');
  });
  test('refuses per-entry, entry-count, and directory limits', async () => {
    expect(
      await reason(zip([{ name: 'a', data: 'abc' }]), {
        ...limits,
        maxEntryBytes: 2,
      })
    ).toBe('entry-too-large');
    expect(
      await reason(zip([{ name: 'a' }]), { ...limits, maxEntries: 0 })
    ).toBe('too-many-entries');
    const bytes = zip([]);
    new DataView(bytes.buffer).setUint32(
      bytes.length - 10,
      16 * 1024 * 1024 + 1,
      true
    );
    expect(await reason(bytes)).toBe('directory-too-large');
  });
  test('refuses multi-disk, unsupported methods, size mismatches and corruption', async () => {
    const disk = zip([]);
    new DataView(disk.buffer).setUint16(4, 1, true);
    expect(await reason(disk)).toBe('multi-disk');
    const method = zip([{ name: 'a' }]);
    const mv = new DataView(method.buffer);
    const cd = mv.getUint32(method.length - 6, true);
    mv.setUint16(cd + 10, 99, true);
    expect(await reason(method)).toBe('unsupported-method');
    const size = zip([{ name: 'a', data: 'x' }]);
    new DataView(size.buffer).setUint32(18, 2, true);
    expect(await reason(size)).toBe('size-mismatch');
    expect(await reason(new Uint8Array([1, 2, 3]))).toBe('corrupt');
  });
  test('rejects special types and does not read directories', async () => {
    for (const mode of [0o010644, 0o020644, 0o060644, 0o140644]) {
      expect(await reason(zip([{ name: 'special', mode }]))).toBe('corrupt');
    }
    const result = await indexZip(
      zip([{ name: 'folder/', mode: 0o040755 }]),
      limits
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.entries.get('folder')?.kind).toBe('directory');
    const read = await result.index.read('folder');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('not-a-file');
  });
});
