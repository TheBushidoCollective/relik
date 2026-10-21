import { describe, expect, test } from 'bun:test';
import { createDeflateRaw, deflateRawSync } from 'node:zlib';
import type { InflaterFn } from '../src/otio-types.ts';
import {
  crc32,
  indexOtioZip,
  isOtioz,
  isRawOtio,
  MAX_EXPANDED_ZIP_BYTES,
  OtioZipError,
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
  try {
    await indexOtioZip(archive);
  } catch (err) {
    expect(err).toBeInstanceOf(OtioZipError);
    expect(err).not.toBeInstanceOf(ReferenceError);
    const zipErr = err as OtioZipError;
    expect(zipErr.name).toBe('OtioZipError');
    expect(zipErr.code).toBe(code);
    return;
  }
  throw new Error(`indexOtioZip accepted an archive that must fail ${code}`);
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

  test('rejects overlapping entry extents', async () => {
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
    const local = findZipHeader(zip, 'media/a.bin', 0x04034b50, 30);
    const cd = findZipHeader(zip, 'media/a.bin', 0x02014b50, 46);
    view.setUint32(local + 18, 40, true);
    view.setUint32(cd + 20, 40, true);
    await expectZipFailure(zip, 'corrupt-archive');
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
    const first = await index.readEntry('media/bomb.bin').catch((err) => err);
    const second = await index.readEntry('media/bomb.bin').catch((err) => err);
    expect(first).toBeInstanceOf(OtioZipError);
    expect((first as OtioZipError).code).toBe('decompression-limit');
    expect(second).toBe(first);
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
    const inflater: InflaterFn = async (data, _size, maxBytes) => {
      calls += 1;
      expect(maxBytes).toBe(payload.length);
      await gate;
      return data;
    };
    const first = index.readEntry('media/a.bin', inflater);
    const second = index.readEntry('media/a.bin', inflater);
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(Array.from(a)).toEqual([4, 5, 6, 7]);
  });
});
