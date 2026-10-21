import { describe, expect, test } from 'bun:test';
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
    const fileCrc = f.corruptCrc
      ? (crc32(dataBytes) ^ 0x12345678) >>> 0
      : crc32(dataBytes);

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
    lView.setUint32(18, dataBytes.length, true); // compressed size
    lView.setUint32(22, dataBytes.length, true); // uncompressed size
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
    const fileCrc = f.corruptCrc
      ? (crc32(dataBytes) ^ 0x12345678) >>> 0
      : crc32(dataBytes);
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
    cView.setUint32(24, dataBytes.length, true);
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

    await expect(indexOtioZip(symlinkZip)).rejects.toThrow(OtioZipError);
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
});
