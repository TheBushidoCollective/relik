import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createDeflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';
import type { InflaterFn } from '../src/otio-types.ts';
import {
  crc32,
  indexOtioZip,
  isOtioz,
  isOtiozSource,
  isRawOtio,
  MAX_EXPANDED_ZIP_BYTES,
  MAX_INFLATED_ZIP_BYTES,
  MAX_ZIP_DIRECTORY_BYTES,
  OTIO_DOCUMENT_MAX_BYTES,
  OtioZipError,
  otioBundleEntry,
  otioBundleEntryFor,
  otioBundleMediaIndex,
  sanitizeOtioBundlePath,
} from '../src/otio-zip.ts';

interface ZipFileDef {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  externalAttr?: number;
  corruptCrc?: boolean;
  uncompressedSize?: number;
  crc32?: number;
}

function createZipBuffer(files: ZipFileDef[]): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let currentOffset = 0;

  for (const f of files) {
    offsets.push(currentOffset);
    const nameBytes = new TextEncoder().encode(f.name);
    const dataBytes = f.data;
    const method = f.method ?? 0;
    const flags = f.flags ?? 0;
    const fileCrc =
      f.crc32 !== undefined
        ? f.crc32 >>> 0
        : f.corruptCrc
          ? (crc32(dataBytes) ^ 0x12345678) >>> 0
          : crc32(dataBytes);
    const uncompressedSize = f.uncompressedSize ?? dataBytes.length;

    // Local header: 30 bytes + name + data
    const localBuf = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const lView = new DataView(localBuf.buffer);
    lView.setUint32(0, 0x04034b50, true);
    lView.setUint16(4, 20, true);
    lView.setUint16(6, flags, true);
    lView.setUint16(8, method, true);
    lView.setUint16(10, 0, true);
    lView.setUint16(12, 0, true);
    lView.setUint32(14, fileCrc, true);
    lView.setUint32(18, dataBytes.length, true);
    lView.setUint32(22, uncompressedSize, true);
    lView.setUint16(26, nameBytes.length, true);
    lView.setUint16(28, 0, true); // extra length
    localBuf.set(nameBytes, 30);
    localBuf.set(dataBytes, 30 + nameBytes.length);

    localChunks.push(localBuf);
    currentOffset += localBuf.length;
  }

  const cdStart = currentOffset;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as ZipFileDef;
    const localOffset = offsets[i] as number;
    const nameBytes = new TextEncoder().encode(f.name);
    const dataBytes = f.data;
    const method = f.method ?? 0;
    const flags = f.flags ?? 0;
    const fileCrc =
      f.crc32 !== undefined
        ? f.crc32 >>> 0
        : f.corruptCrc
          ? (crc32(dataBytes) ^ 0x12345678) >>> 0
          : crc32(dataBytes);
    const uncompressedSize = f.uncompressedSize ?? dataBytes.length;
    const extAttr = f.externalAttr ?? 0;

    // CD header: 46 bytes + name
    const cdBuf = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(cdBuf.buffer);
    cView.setUint32(0, 0x02014b50, true);
    cView.setUint16(4, 20, true);
    cView.setUint16(6, 20, true);
    cView.setUint16(8, flags, true);
    cView.setUint16(10, method, true);
    cView.setUint16(12, 0, true);
    cView.setUint16(14, 0, true);
    cView.setUint32(16, fileCrc, true);
    cView.setUint32(20, dataBytes.length, true);
    cView.setUint32(24, uncompressedSize, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint16(30, 0, true); // extra length
    cView.setUint16(32, 0, true); // comment length
    cView.setUint16(34, 0, true); // disk num
    cView.setUint16(36, 0, true); // internal attr
    cView.setUint32(38, extAttr, true); // external attr
    cView.setUint32(42, localOffset, true);
    cdBuf.set(nameBytes, 46);

    cdChunks.push(cdBuf);
    currentOffset += cdBuf.length;
  }

  const cdSize = currentOffset - cdStart;

  // EOCD: 22 bytes
  const eocdBuf = new Uint8Array(22);
  const eView = new DataView(eocdBuf.buffer);
  eView.setUint32(0, 0x06054b50, true);
  eView.setUint16(4, 0, true);
  eView.setUint16(6, 0, true);
  eView.setUint16(8, files.length, true);
  eView.setUint16(10, files.length, true);
  eView.setUint32(12, cdSize, true);
  eView.setUint32(16, cdStart, true);
  eView.setUint16(20, 0, true);

  const totalLength = currentOffset + 22;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of localChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  for (const chunk of cdChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  out.set(eocdBuf, pos);
  return out;
}
function findZipHeader(
  zip: Uint8Array,
  name: string,
  headerSig: number,
  headerLen: number
): number {
  const nameBytes = new TextEncoder().encode(name);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = headerLen; i + nameBytes.length <= zip.length; i++) {
    let match = true;
    for (let j = 0; j < nameBytes.length; j++) {
      if (zip[i + j] !== nameBytes[j]) {
        match = false;
        break;
      }
    }
    if (match && view.getUint32(i - headerLen, true) === headerSig) {
      return i - headerLen;
    }
  }
  throw new Error(`header not found for ${name}`);
}

function localDataOffset(view: DataView, localHeader: number): number {
  return (
    localHeader +
    30 +
    view.getUint16(localHeader + 26, true) +
    view.getUint16(localHeader + 28, true)
  );
}

function localEntryEnd(view: DataView, localHeader: number): number {
  return (
    localDataOffset(view, localHeader) + view.getUint32(localHeader + 18, true)
  );
}

function withEocdComment(zip: Uint8Array, comment: Uint8Array): Uint8Array {
  const out = new Uint8Array(zip.length + comment.length);
  out.set(zip, 0);
  out.set(comment, zip.length);
  const view = new DataView(out.buffer);
  view.setUint16(zip.length - 2, comment.length, true);
  return out;
}

function deflateZeros(total: number): Promise<Uint8Array> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  const chunks: Buffer[] = [];
  const encoder = createDeflateRaw({ level: 9 });
  encoder.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  encoder.on('error', reject);
  encoder.on('end', () => {
    resolve(new Uint8Array(Buffer.concat(chunks)));
  });
  const block = Buffer.alloc(1024 * 1024, 0);
  const blocks = Math.floor(total / block.length);
  for (let i = 0; i < blocks; i++) encoder.write(block);
  const rem = total % block.length;
  if (rem > 0) encoder.write(Buffer.alloc(rem, 0));
  encoder.end();
  return promise;
}

async function expectZipFailure(
  archive: Uint8Array,
  code: OtioZipError['code']
): Promise<void> {
  for (const source of [
    archive,
    {
      size: archive.length,
      async read(start: number, end: number) {
        return archive.subarray(start, end);
      },
    },
  ]) {
    try {
      await indexOtioZip(source);
    } catch (err) {
      expect(err).toBeInstanceOf(OtioZipError);
      expect(err).not.toBeInstanceOf(ReferenceError);
      const zipErr = err as OtioZipError;
      expect(zipErr.name).toBe('OtioZipError');
      expect(zipErr.code).toBe(code);
      continue;
    }
    throw new Error(`indexOtioZip accepted an archive that must fail ${code}`);
  }
}

describe('otio-zip security indexing and subtype detection', () => {
  const validVersionTxt = new TextEncoder().encode('1.0.0\n');
  const validContentOtio = new TextEncoder().encode(
    '{"OTIO_SCHEMA": "Timeline.1", "name": "Test"}'
  );

  test('detects valid .otioz archive bytes via isOtioz', () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/test.mp4', data: new Uint8Array([1, 2, 3]) },
    ]);

    expect(isOtioz(zip)).toBe(true);
  });

  test('rejects generic zip without content.otio via isOtioz', () => {
    const genericZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'data.csv', data: new TextEncoder().encode('id,name\n1,test') },
    ]);

    expect(isOtioz(genericZip)).toBe(false);
  });

  test('detects raw OTIO JSON via isRawOtio', () => {
    expect(isRawOtio(validContentOtio)).toBe(true);
    expect(
      isRawOtio(new TextEncoder().encode('<html><body>Not OTIO</body></html>'))
    ).toBe(false);
  });

  test('indexes valid .otioz and reads content.otio and version.txt', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      {
        name: 'media/video.mp4',
        data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      },
    ]);

    const index = await indexOtioZip(zip);
    expect(index.versionText).toBe('1.0.0');
    expect(index.entries.has('version.txt')).toBe(true);
    expect(index.entries.has('content.otio')).toBe(true);
    expect(index.entries.has('media/video.mp4')).toBe(true);

    const mediaBytes = await index.readEntry('media/video.mp4');
    expect(Array.from(mediaBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test('rejects path traversal (..) in ZIP entries', async () => {
    const hostileZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: '../../etc/passwd', data: new TextEncoder().encode('evil') },
    ]);

    await expect(indexOtioZip(hostileZip)).rejects.toThrow(OtioZipError);
  });

  test('rejects absolute paths (/root.txt) in ZIP entries', async () => {
    const hostileZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: '/root.txt', data: new TextEncoder().encode('evil') },
    ]);

    await expect(indexOtioZip(hostileZip)).rejects.toThrow(OtioZipError);
  });

  test('rejects encrypted ZIP entries', async () => {
    const encryptedZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt, flags: 0x0001 },
      { name: 'content.otio', data: validContentOtio },
    ]);

    await expect(indexOtioZip(encryptedZip)).rejects.toThrow(OtioZipError);
  });

  test('rejects symlink entries in ZIP', async () => {
    const symlinkZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      // Unix mode 0120000 in upper 16 bits of external attributes
      {
        name: 'media/link',
        data: new TextEncoder().encode('/target'),
        externalAttr: 0o120777 << 16,
      },
    ]);

    await expectZipFailure(symlinkZip, 'corrupt-archive');
  });

  test('rejects duplicate canonical entry names', async () => {
    const duplicateZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: './content.otio', data: validContentOtio },
    ]);

    await expect(indexOtioZip(duplicateZip)).rejects.toThrow(OtioZipError);
  });

  test('rejects archive when CRC32 does not match', async () => {
    const corruptZip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio, corruptCrc: true },
    ]);

    await expect(indexOtioZip(corruptZip)).rejects.toThrow(OtioZipError);
  });

  test('rejects archive when version.txt is missing or invalid', async () => {
    const badVersionZip = createZipBuffer([
      { name: 'version.txt', data: new TextEncoder().encode('2.0.0\n') },
      { name: 'content.otio', data: validContentOtio },
    ]);

    await expect(indexOtioZip(badVersionZip)).rejects.toThrow(OtioZipError);
  });

  test('rejects archive when aggregate uncompressed size exceeds max limit', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/huge.bin', data: new Uint8Array(1024) },
    ]);

    // Pass tight limit of 500 bytes
    await expect(
      indexOtioZip(zip, { maxExpandedBytes: 500 })
    ).rejects.toThrow();
  });

  test('rejects a wrapped EOCD count that leaves the directory unconsumed', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/hidden.bin', data: new Uint8Array([9]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    // 65538 entries store as 2 in these uint16 fields.
    view.setUint16(eocd + 8, 2, true);
    view.setUint16(eocd + 10, 2, true);
    await expectZipFailure(zip, 'corrupt-archive');
  });

  test('rejects the ZIP64 entry-count sentinel before using it as a limit', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    view.setUint16(eocd + 8, 0xffff, true);
    view.setUint16(eocd + 10, 0xffff, true);
    await expectZipFailure(zip, 'unsupported-zip');
  });

  test('rejects a ZIP64 size sentinel before the aggregate cap', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/huge.bin', data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const cd = findZipHeader(zip, 'media/huge.bin', 0x02014b50, 46);
    new DataView(zip.buffer, zip.byteOffset, zip.byteLength).setUint32(
      cd + 24,
      0xffffffff,
      true
    );
    await expectZipFailure(zip, 'unsupported-zip');
  });

  test('rejects crossing entry extents', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      {
        name: 'media/a.bin',
        data: new Uint8Array([1, 2, 3, 4]),
        method: 8,
        uncompressedSize: 4,
        crc32: crc32(new Uint8Array([1, 2, 3, 4])),
      },
      { name: 'media/b.bin', data: new Uint8Array([5, 6, 7, 8]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const aLocal = findZipHeader(zip, 'media/a.bin', 0x04034b50, 30);
    const aCd = findZipHeader(zip, 'media/a.bin', 0x02014b50, 46);
    const bLocal = findZipHeader(zip, 'media/b.bin', 0x04034b50, 30);
    const crossingSize = bLocal - localDataOffset(view, aLocal) + 1;
    const bEnd = localEntryEnd(view, bLocal);

    view.setUint32(aLocal + 18, crossingSize, true);
    view.setUint32(aCd + 20, crossingSize, true);

    expect(localEntryEnd(view, aLocal)).toBeGreaterThan(bLocal);
    expect(localEntryEnd(view, aLocal)).toBeLessThan(bEnd);
    await expectZipFailure(zip, 'corrupt-archive');
  });

  test('rejects a nested entry extent', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/outer.bin', data: new Uint8Array([1]) },
      { name: 'media/inner.bin', data: new Uint8Array([2]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const outerLocal = findZipHeader(zip, 'media/outer.bin', 0x04034b50, 30);
    const outerCd = findZipHeader(zip, 'media/outer.bin', 0x02014b50, 46);
    const innerLocal = findZipHeader(zip, 'media/inner.bin', 0x04034b50, 30);
    const nestedSize =
      localEntryEnd(view, innerLocal) - localDataOffset(view, outerLocal);

    view.setUint32(outerLocal + 18, nestedSize, true);
    view.setUint32(outerLocal + 22, nestedSize, true);
    view.setUint32(outerCd + 20, nestedSize, true);
    view.setUint32(outerCd + 24, nestedSize, true);

    expect(localEntryEnd(view, outerLocal)).toBe(
      localEntryEnd(view, innerLocal)
    );
    await expectZipFailure(zip, 'corrupt-archive');
  });

  test('allows local entry extents that touch at a boundary', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/a.bin', data: new Uint8Array([1, 2, 3]) },
      { name: 'media/b.bin', data: new Uint8Array([4, 5, 6]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const aLocal = findZipHeader(zip, 'media/a.bin', 0x04034b50, 30);
    const bLocal = findZipHeader(zip, 'media/b.bin', 0x04034b50, 30);

    expect(localEntryEnd(view, aLocal)).toBe(bLocal);
    const index = await indexOtioZip(zip);
    expect(index.entries.has('media/b.bin')).toBe(true);
  });

  test('indexes the largest accepted non-overlapping entry census', async () => {
    const maxEntryCount = 0xffff - 1;
    const empty = new Uint8Array();
    const files: ZipFileDef[] = [
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
    ];
    for (let i = files.length; i < maxEntryCount; i++) {
      files.push({ name: `media/${i.toString(36)}.bin`, data: empty });
    }

    const zip = createZipBuffer(files);
    expect(zip.byteLength).toBeLessThan(MAX_EXPANDED_ZIP_BYTES);

    const index = await indexOtioZip(zip);
    const lastName = `media/${(maxEntryCount - 1).toString(36)}.bin`;
    expect(index.entries.size).toBe(maxEntryCount);
    expect(index.entries.has(lastName)).toBe(true);
  });

  test('rejects an EOCD whose comment length ignores trailing bytes', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
    ]);
    const trailed = new Uint8Array(zip.length + 1);
    trailed.set(zip, 0);
    await expectZipFailure(trailed, 'corrupt-archive');
  });

  test('accepts an EOCD comment that contains a ZIP signature', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/ok.bin', data: new Uint8Array([1]) },
    ]);
    const comment = new Uint8Array(30);
    comment.set([0x50, 0x4b, 0x05, 0x06], 0);
    comment.fill(0x41, 4);
    const commented = withEocdComment(zip, comment);
    expect(isOtioz(commented)).toBe(true);
    const index = await indexOtioZip(commented);
    expect(index.versionText).toBe('1.0.0');
    expect(index.entries.has('media/ok.bin')).toBe(true);
  });

  test('rejects a NUL in an entry name', async () => {
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/bad\0.bin', data: new Uint8Array([1]) },
    ]);
    await expectZipFailure(zip, 'corrupt-archive');
  });

  test('indexes method 0 and 8 without extracting unread media', async () => {
    const payload = new TextEncoder().encode('frame-bytes');
    const compressed = new Uint8Array(deflateRawSync(payload));
    let calls = 0;
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      {
        name: 'media/frame.bin',
        data: compressed,
        method: 8,
        uncompressedSize: payload.length,
        crc32: crc32(payload),
      },
    ]);
    const blocking: InflaterFn = () => {
      calls += 1;
      throw new OtioZipError('corrupt-archive', 'extracted during index');
    };
    const index = await indexOtioZip(zip, { inflater: blocking });
    expect(calls).toBe(0);
    expect(index.versionText).toBe('1.0.0');
    expect(payload.length).toBeLessThan(MAX_EXPANDED_ZIP_BYTES);
    const bytes = await index.readEntry('media/frame.bin', () => payload);
    expect(calls).toBe(0);
    expect(Array.from(bytes)).toEqual(Array.from(payload));
    expect(await index.readEntry('media/frame.bin')).toBe(bytes);
  });

  test('inflates ordinary and SharedArrayBuffer-backed entry windows', async () => {
    const payload = new TextEncoder().encode('shared frame bytes');
    const compressed = new Uint8Array(deflateRawSync(payload));
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      {
        name: 'media/frame.bin',
        data: compressed,
        method: 8,
        uncompressedSize: payload.length,
        crc32: crc32(payload),
      },
    ]);
    const shared = new Uint8Array(new SharedArrayBuffer(zip.byteLength));
    shared.set(zip);

    for (const archive of [zip, shared]) {
      const index = await indexOtioZip(archive);
      const bytes = await index.readEntry('media/frame.bin');
      expect(Array.from(bytes)).toEqual(Array.from(payload));
    }
  });

  test('caps a lazy one-byte entry before a near-100MiB inflate', async () => {
    const expanded = 99 * 1024 * 1024;
    expect(expanded).toBeLessThan(MAX_EXPANDED_ZIP_BYTES);
    const compressed = await deflateZeros(expanded);
    expect(compressed.byteLength).toBeLessThan(1024 * 1024);
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      {
        name: 'media/bomb.bin',
        data: compressed,
        method: 8,
        uncompressedSize: 1,
        crc32: crc32(new Uint8Array([0])),
      },
    ]);
    const index = await indexOtioZip(zip);
    expect(index.entries.get('media/bomb.bin')?.uncompressedSize).toBe(1);
    // The overflow aborts the stream mid-write; nothing it leaves behind may
    // reject unhandled, because that terminates a Node host.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const first = await index.readEntry('media/bomb.bin').catch((err) => err);
      const second = await index
        .readEntry('media/bomb.bin')
        .catch((err) => err);
      expect(first).toBeInstanceOf(OtioZipError);
      expect((first as OtioZipError).code).toBe('decompression-limit');
      expect(second).toBe(first);
      // Proving an absence has no signal to await; one real event-loop turn
      // lets the runtime report any rejection the overflow left unhandled.
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('does not reinflate a permanent corrupt entry', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      {
        name: 'media/bomb.bin',
        data: payload,
        method: 8,
        uncompressedSize: 1,
        crc32: 0,
      },
    ]);
    const index = await indexOtioZip(zip);
    let calls = 0;
    const failing: InflaterFn = (_data, uncompressedSize, maxBytes) => {
      calls += 1;
      expect(uncompressedSize).toBe(1);
      expect(maxBytes).toBe(1);
      throw new OtioZipError(
        'decompression-limit',
        `Streamed decompressed bytes exceeded limit of ${maxBytes}`
      );
    };
    const later: InflaterFn = () => {
      calls += 1;
      return new Uint8Array(99 * 1024 * 1024);
    };
    const first = await index
      .readEntry('media/bomb.bin', failing)
      .catch((err) => err);
    const second = await index
      .readEntry('media/bomb.bin', later)
      .catch((err) => err);
    expect(calls).toBe(1);
    expect(first).toBeInstanceOf(OtioZipError);
    expect((first as OtioZipError).code).toBe('decompression-limit');
    expect(second).toBe(first);
  });

  test('retries a capability failure with a later inflater', async () => {
    const payload = new Uint8Array([8, 9, 10]);
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/a.bin', data: payload, method: 8 },
    ]);
    const index = await indexOtioZip(zip);
    let calls = 0;
    const missing: InflaterFn = () => {
      calls += 1;
      throw new OtioZipError(
        'unsupported-zip',
        'No DecompressionStream available'
      );
    };
    const working: InflaterFn = (data, _size, maxBytes) => {
      calls += 1;
      expect(maxBytes).toBe(payload.length);
      return data;
    };
    const failed = await index
      .readEntry('media/a.bin', missing)
      .catch((err) => err);
    expect((failed as OtioZipError).code).toBe('unsupported-zip');
    const bytes = await index.readEntry('media/a.bin', working);
    expect(calls).toBe(2);
    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });

  test('deduplicates concurrent reads of one canonical entry', async () => {
    const payload = new Uint8Array([4, 5, 6, 7]);
    const zip = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/a.bin', data: payload, method: 8 },
    ]);
    const index = await indexOtioZip(zip);
    let calls = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } =
      Promise.withResolvers<void>();
    const inflater: InflaterFn = async (data, _size, maxBytes) => {
      calls += 1;
      markStarted();
      expect(maxBytes).toBe(payload.length);
      await gate;
      return data;
    };
    const first = index.readEntry('media/a.bin', inflater);
    const second = index.readEntry('media/a.bin', inflater);
    await started;
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(Array.from(a)).toEqual([4, 5, 6, 7]);
  });

  test('uses the shared single-decode media path model', () => {
    expect(sanitizeOtioBundlePath('media/video.mp4')).toBe('media/video.mp4');
    expect(sanitizeOtioBundlePath('clips/scene_01.webm')).toBe(
      'clips/scene_01.webm'
    );
    expect(sanitizeOtioBundlePath('media%2Fclip%2Epng')).toBe('media/clip.png');
    expect(sanitizeOtioBundlePath('file:media/audio.wav')).toBe(
      'media/audio.wav'
    );
    expect(sanitizeOtioBundlePath('media/clip.mov?v=1#t=1')).toBe(
      'media/clip.mov'
    );
    expect(sanitizeOtioBundlePath('media\\x.png')).toBe('media/x.png');

    for (const path of [
      'http://example.test/clip.mov',
      'https://example.test/clip.mov',
      'ftp://example.test/clip.mov',
      'data:text/plain,clip',
      'blob:https://example.test/clip',
      'javascript:alert(1)',
      'C:/media/clip.mov',
      'D:\\media\\clip.mov',
    ]) {
      expect(() => sanitizeOtioBundlePath(path)).toThrow(
        /^Prohibited URL scheme/
      );
    }
    for (const path of [
      '/var/media/clip.mov',
      '\\Windows\\Media\\clip.mov',
      'file:///etc/passwd',
      'file://localhost/clip.mov',
    ]) {
      expect(() => sanitizeOtioBundlePath(path)).toThrow(/^Absolute path/);
    }
    for (const path of [
      '../outside.mov',
      'media/../../outside.mov',
      './media/sub/../clip.mov',
    ]) {
      expect(() => sanitizeOtioBundlePath(path)).toThrow(/^Path traversal/);
    }
    for (const path of [
      'media/\0clip.mov',
      'media/\x1fclip.mov',
      'media/%00clip.mov',
    ]) {
      expect(() => sanitizeOtioBundlePath(path)).toThrow(/^Control character/);
    }
    for (const path of ['', '   ', '.']) {
      expect(() => sanitizeOtioBundlePath(path)).toThrow(
        /^Empty media reference path/
      );
    }
    expect(() => sanitizeOtioBundlePath('media/%')).toThrow(
      /^Malformed percent-encoding/
    );

    expect<string | null>(otioBundleEntry('media/%253F.png')).toBe(
      'media/%3F.png'
    );
    expect<string | null>(otioBundleEntry('media/%3F.png')).toBe('media/?.png');
    expect<string | null>(otioBundleEntry('media/a%2520b.png')).toBe(
      'media/a%20b.png'
    );
    expect<string | null>(otioBundleEntry('media/a%20b.png')).toBe(
      'media/a b.png'
    );
    expect<string | null>(otioBundleEntry('media/x.png?v=1')).toBe(
      'media/x.png'
    );
    expect<string | null>(otioBundleEntry('media/x.png#t=1')).toBe(
      'media/x.png'
    );
    expect<string | null>(
      otioBundleEntryFor(
        'file:media/clip.mov',
        (name) => name === 'media/clip.mov'
      )
    ).toBe('media/clip.mov');
  });

  test('builds a null-prototype media index in canonical lexical order', async () => {
    const archive = createZipBuffer([
      { name: 'version.txt', data: validVersionTxt },
      { name: 'content.otio', data: validContentOtio },
      { name: 'media/z.bin', data: new Uint8Array([3]) },
      { name: 'media/empty/', data: new Uint8Array() },
      { name: 'media/a.bin', data: new Uint8Array([1, 2]) },
      { name: 'outside.bin', data: new Uint8Array([4]) },
    ]);
    const indexed = await indexOtioZip(archive);
    const reads: string[] = [];
    const media = await otioBundleMediaIndex(
      {
        ...indexed,
        digestEntry: async (name) => {
          reads.push(name);
          return indexed.digestEntry(name);
        },
      },
      { digests: true }
    );

    expect(Object.getPrototypeOf(media)).toBeNull();
    expect(Object.keys(media)).toEqual(['media/a.bin', 'media/z.bin']);
    expect(reads).toEqual(['media/a.bin', 'media/z.bin']);
    expect(media['media/a.bin']?.bundle_path).toBe('media/a.bin');
    expect(media['media/a.bin']?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(media['media/z.bin']?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('range-backed OTIO ZIP', () => {
  const version = new TextEncoder().encode('1.0.0\n');
  const document = new TextEncoder().encode('{"OTIO_SCHEMA":"Timeline.1"}');

  function sparseStoredSource(mediaSize: number) {
    const zip = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      { name: 'media/large.bin', data: new Uint8Array([0]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cdStart = view.getUint32(zip.length - 22 + 16, true);
    const local = findZipHeader(zip, 'media/large.bin', 0x04034b50, 30);
    const central = findZipHeader(zip, 'media/large.bin', 0x02014b50, 46);
    const dataStart = localDataOffset(view, local);
    view.setUint32(local + 18, mediaSize, true);
    view.setUint32(local + 22, mediaSize, true);
    view.setUint32(central + 20, mediaSize, true);
    view.setUint32(central + 24, mediaSize, true);
    const prefix = zip.slice(0, dataStart);
    const suffix = zip.slice(cdStart);
    const suffixView = new DataView(
      suffix.buffer,
      suffix.byteOffset,
      suffix.byteLength
    );
    const mediaEnd = dataStart + mediaSize;
    suffixView.setUint32(suffix.length - 22 + 16, mediaEnd, true);
    const reads: Array<[number, number]> = [];
    return {
      reads,
      size: mediaEnd + suffix.length,
      async read(start: number, end: number): Promise<Uint8Array> {
        reads.push([start, end]);
        const result = new Uint8Array(end - start);
        if (start < prefix.length) {
          const prefixEnd = Math.min(end, prefix.length);
          result.set(prefix.subarray(start, prefixEnd), 0);
        }
        if (end > mediaEnd) {
          const suffixStart = Math.max(start, mediaEnd);
          result.set(
            suffix.subarray(suffixStart - mediaEnd, end - mediaEnd),
            suffixStart - start
          );
        }
        return result;
      },
    };
  }

  test('indexes stored and deflated members identically from arrays and range sources', async () => {
    const payload = new TextEncoder().encode('compressed media contents');
    const compressed = deflateRawSync(payload);
    const archive = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      { name: 'media/stored.bin', data: new Uint8Array([1, 2, 3]) },
      {
        name: 'media/deflated.bin',
        data: compressed,
        method: 8,
        uncompressedSize: payload.length,
        crc32: crc32(payload),
      },
    ]);
    const source = {
      size: archive.length,
      async read(start: number, end: number) {
        return archive.subarray(start, end);
      },
    };
    const inflater: InflaterFn = (data) => new Uint8Array(inflateRawSync(data));
    expect(isOtioz(archive)).toBe(true);
    expect(await isOtiozSource(source)).toBe(true);
    const memory = await indexOtioZip(archive, { inflater });
    const ranged = await indexOtioZip(source, { inflater });
    expect([...ranged.entries]).toEqual([...memory.entries]);
    expect(ranged.contentOtioBytes).toEqual(memory.contentOtioBytes);
    expect(ranged.contentSha256).toBe(memory.contentSha256);
    for (const name of ['media/stored.bin', 'media/deflated.bin']) {
      expect(await ranged.readEntry(name)).toEqual(
        await memory.readEntry(name)
      );
      expect(await ranged.digestEntry(name)).toBe(
        await memory.digestEntry(name)
      );
    }
  });

  test('uses bounded reads for materialization, verification, and media digests', async () => {
    const payload = new Uint8Array(8 * 1024 * 1024 + 1);
    payload[0] = 19;
    payload[payload.length - 1] = 7;
    const archive = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      { name: 'media/large.bin', data: payload },
    ]);
    let largest = 0;
    const source = {
      size: archive.length,
      async read(start: number, end: number) {
        largest = Math.max(largest, end - start);
        if (end - start > 8 * 1024 * 1024) throw new Error('unbounded range');
        return archive.slice(start, end);
      },
    };
    const zip = await indexOtioZip(source);
    expect(await zip.readEntry('media/large.bin')).toEqual(payload);
    await zip.verifyStoredEntry('media/large.bin');
    const digest = createHash('sha256').update(payload).digest('hex');
    expect(await zip.digestEntry('media/large.bin')).toBe(digest);
    expect(
      (await otioBundleMediaIndex(zip, { digests: true }))['media/large.bin']
        ?.sha256
    ).toBe(digest);
    expect(largest).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test('refuses to materialize oversized stored media without requesting its data', async () => {
    const source = sparseStoredSource(OTIO_DOCUMENT_MAX_BYTES + 1);
    const zip = await indexOtioZip(source);
    const before = source.reads.length;
    await expect(zip.readEntry('media/large.bin')).rejects.toMatchObject({
      code: 'decompression-limit',
    });
    expect(source.reads.length).toBe(before);
  });

  test('rejects a directory beyond 16 MiB before requesting it', async () => {
    const size = MAX_ZIP_DIRECTORY_BYTES + 1;
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint32(12, size, true);
    const source = {
      size: size + eocd.length,
      async read(start: number, end: number) {
        if (end - start > 65557) throw new Error('directory was read');
        const result = new Uint8Array(end - start);
        if (end > size)
          result.set(
            eocd.subarray(Math.max(0, start - size), end - size),
            Math.max(0, size - start)
          );
        return result;
      },
    };
    await expect(indexOtioZip(source)).rejects.toMatchObject({
      code: 'unsupported-zip',
    });
  });

  test('rejects inflated aggregate and oversized content.otio declarations', async () => {
    expect(MAX_INFLATED_ZIP_BYTES).toBe(100 * 1024 * 1024);
    const deflated = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      {
        name: 'media/a',
        data: new Uint8Array([0]),
        method: 8,
        uncompressedSize: 7,
      },
      {
        name: 'media/b',
        data: new Uint8Array([0]),
        method: 8,
        uncompressedSize: 7,
      },
    ]);
    const range = {
      size: deflated.length,
      async read(start: number, end: number) {
        return deflated.subarray(start, end);
      },
    };
    for (const source of [deflated, range]) {
      await expect(
        indexOtioZip(source, { maxInflatedBytes: 13 })
      ).rejects.toMatchObject({ code: 'decompression-limit' });
    }
    const oversizedDocument = createZipBuffer([
      { name: 'version.txt', data: version },
      {
        name: 'content.otio',
        data: new Uint8Array([0]),
        method: 8,
        uncompressedSize: OTIO_DOCUMENT_MAX_BYTES + 1,
      },
    ]);
    await expect(
      indexOtioZip(oversizedDocument, {
        maxExpandedBytes: 200 * 1024 * 1024,
        maxInflatedBytes: 200 * 1024 * 1024,
      })
    ).rejects.toThrow('content.otio exceeds');
  });

  test('refuses corrupt stored media, short source reads, and mismatched header flags', async () => {
    const archive = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      {
        name: 'media/bad.bin',
        data: new Uint8Array([1, 2, 3]),
        corruptCrc: true,
      },
    ]);
    const source = {
      size: archive.length,
      async read(start: number, end: number) {
        return archive.subarray(start, end);
      },
    };
    const zip = await indexOtioZip(source);
    await expect(zip.verifyStoredEntry('media/bad.bin')).rejects.toMatchObject({
      code: 'corrupt-archive',
    });
    await expect(zip.digestEntry('media/bad.bin')).rejects.toMatchObject({
      code: 'corrupt-archive',
    });
    const short = {
      size: archive.length,
      async read(start: number, end: number) {
        return archive.subarray(start, Math.max(start, end - 1));
      },
    };
    await expect(indexOtioZip(short)).rejects.toMatchObject({
      code: 'corrupt-archive',
    });

    const badFlags = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
    ]);
    const local = findZipHeader(badFlags, 'content.otio', 0x04034b50, 30);
    new DataView(badFlags.buffer).setUint16(local + 6, 0x0008, true);
    await expectZipFailure(badFlags, 'corrupt-archive');
  });
});

describe('central directory facts and raw names', () => {
  const version = new TextEncoder().encode('1.0.0');
  const document = new TextEncoder().encode('{"OTIO_SCHEMA":"Timeline.1"}');
  const names = [
    'version.txt',
    'content.otio',
    'media/',
    'media\\clip.mp4',
  ] as const;

  function archiveFiles(): Uint8Array {
    return createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      { name: 'media/', data: new Uint8Array(0) },
      { name: 'media\\clip.mp4', data: new Uint8Array([1, 2, 3]) },
    ]);
  }

  /** Appends an EOCD comment; the EOCD is the last 22 bytes of `zip`. */
  function withComment(zip: Uint8Array, comment: Uint8Array): Uint8Array {
    const out = new Uint8Array(zip.length + comment.length);
    out.set(zip);
    out.set(comment, zip.length);
    new DataView(out.buffer).setUint16(zip.length - 2, comment.length, true);
    return out;
  }

  test('the directory is what the end record declares, with and without a comment', async () => {
    const plain = archiveFiles();
    const cdSize = names.reduce(
      (sum, name) => sum + 46 + new TextEncoder().encode(name).length,
      0
    );
    const plainIndex = await indexOtioZip(plain);
    expect(plainIndex.directory).toEqual({
      offset: plain.length - 22 - cdSize,
      size: cdSize,
      entryCount: names.length,
      commentLength: 0,
    });

    const comment = new TextEncoder().encode('archive comment');
    const archive = withComment(plain, comment);
    const index = await indexOtioZip(archive);
    const { offset, size, entryCount, commentLength } = index.directory;
    expect({ offset, size, entryCount, commentLength }).toEqual({
      offset: plain.length - 22 - cdSize,
      size: cdSize,
      entryCount: names.length,
      commentLength: comment.length,
    });
    expect(offset + size + 22 + commentLength).toBe(archive.length);
  });

  test('rawName keeps the decoded central-directory name beside the normalized key', async () => {
    const index = await indexOtioZip(archiveFiles());
    expect(index.entries.get('media/clip.mp4')?.rawName).toBe(
      'media\\clip.mp4'
    );
    expect(index.entries.get('media/')?.rawName).toBe('media/');
    expect(index.entries.get('media/')?.isDirectory).toBe(true);
    expect(index.entries.get('content.otio')?.rawName).toBe('content.otio');
  });

  test('a digest is computed once per index and entry, including concurrent callers', async () => {
    const media = Uint8Array.from(
      { length: 3 * 1024 * 1024 + 7 },
      (_, i) => (i * 7) & 0xff
    );
    const zip = createZipBuffer([
      { name: 'version.txt', data: version },
      { name: 'content.otio', data: document },
      { name: 'media/clip.mp4', data: media },
    ]);
    const expected = createHash('sha256').update(media).digest('hex');

    const makeSource = () => {
      const reads: number[] = [];
      return {
        reads,
        source: {
          size: zip.length,
          async read(start: number, end: number) {
            reads.push(end - start);
            return zip.subarray(start, end);
          },
        },
      };
    };

    const single = makeSource();
    const indexed = await indexOtioZip(single.source);
    const singleBase = single.reads.length;
    expect(await indexed.digestEntry('media/clip.mp4')).toBe(expected);
    const singleCost = single.reads.length - singleBase;
    expect(singleCost).toBeGreaterThan(0);
    const afterFirst = single.reads.length;
    expect(await indexed.digestEntry('media/clip.mp4')).toBe(expected);
    expect(single.reads.length).toBe(afterFirst);

    const concurrent = makeSource();
    const other = await indexOtioZip(concurrent.source);
    const concurrentBase = concurrent.reads.length;
    const [a, b] = await Promise.all([
      other.digestEntry('media/clip.mp4'),
      other.digestEntry('media/clip.mp4'),
    ]);
    expect(a).toBe(expected);
    expect(b).toBe(expected);
    expect(concurrent.reads.length - concurrentBase).toBe(singleCost);
  });
});
