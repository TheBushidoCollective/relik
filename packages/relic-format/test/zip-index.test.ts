import { describe, expect, test } from 'bun:test';
import { crc32 } from '../src/otio-zip.ts';
import { indexZip, type ZipLimits } from '../src/zip-index.ts';

const limits: ZipLimits = {
  maxArchiveBytes: 100000,
  maxEntries: 20,
  maxEntryBytes: 10000,
  maxTotalBytes: 10000,
};
type File = { name: string; data?: string; flags?: number; mode?: number };
function zip(files: File[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name),
      data = encoder.encode(file.data ?? '');
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length),
      lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, file.flags ?? 0, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const cd = new Uint8Array(46 + name.length),
      cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, file.flags ?? 0, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (file.mode ?? 0) * 65536, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    locals.push(local);
    central.push(cd);
    offset += local.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(offset + size + 22);
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
  return out;
}
async function reason(bytes: Uint8Array, custom = limits) {
  const result = await indexZip(bytes, custom);
  return result.ok ? 'accepted' : result.reason;
}
describe('general ZIP index', () => {
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
    expect(await reason(zip([{ name: 'pipe', mode: 0o010644 }]))).toBe(
      'corrupt'
    );
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
