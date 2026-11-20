import { expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { crc32, indexOtioZip, OtioZipError } from '../src/otio-zip.ts';

type Part = {
  name: string;
  data?: string | Uint8Array;
  flags?: number;
  method?: number;
  mode?: number;
};
const encoder = new TextEncoder();
function zip(parts: Part[]): Uint8Array {
  const local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = encoder.encode(part.name),
      data =
        typeof part.data === 'string'
          ? encoder.encode(part.data)
          : (part.data ?? new Uint8Array()),
      crc = crc32(data);
    const l = new Uint8Array(30 + name.length + data.length),
      lv = new DataView(l.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, part.flags ?? 0, true);
    lv.setUint16(8, part.method ?? 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    l.set(name, 30);
    l.set(data, 30 + name.length);
    const c = new Uint8Array(46 + name.length),
      cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, part.flags ?? 0, true);
    cv.setUint16(10, part.method ?? 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (part.mode ?? 0) * 65536, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    local.push(l);
    central.push(c);
    offset += l.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0),
    result = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const chunk of [...local, ...central]) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  const ev = new DataView(result.buffer, pos);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return result;
}
const reserved: Part[] = [
  { name: 'version.txt', data: '1.0.0' },
  { name: 'content.otio', data: '{}' },
];
function fixture(parts: Part[] = []): Uint8Array {
  return zip([...parts, ...reserved]);
}
function cdOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer).getUint32(bytes.length - 6, true);
}
async function assertFailure(
  bytes: Uint8Array,
  code: OtioZipError['code'],
  message: string,
  options?: Parameters<typeof indexOtioZip>[1]
): Promise<void> {
  try {
    await indexOtioZip(bytes, options);
    throw new Error('archive was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(OtioZipError);
    expect((error as OtioZipError).code).toBe(code);
    expect((error as Error).message).toBe(message);
  }
}

test('legacy parse refusal messages match baseline source', async () => {
  await assertFailure(
    new Uint8Array([1]),
    'corrupt-archive',
    'End of Central Directory record not found'
  );
  await assertFailure(
    fixture([{ name: 'a', flags: 1 }]),
    'unsupported-zip',
    'Encrypted ZIP entries are strictly prohibited'
  );
  await assertFailure(
    fixture([{ name: 'a', method: 99 }]),
    'unsupported-zip',
    'Unsupported compression method: 99 (only 0 STORED and 8 DEFLATE allowed)'
  );
  await assertFailure(
    fixture([{ name: 'a' }, { name: 'a' }]),
    'corrupt-archive',
    'Duplicate entry name: a'
  );
  await assertFailure(
    fixture([{ name: '../a' }]),
    'corrupt-archive',
    'Path traversal (..) prohibited: ../a'
  );
  await assertFailure(
    fixture([{ name: '/a' }]),
    'corrupt-archive',
    'Absolute paths in archive prohibited: /a'
  );
  await assertFailure(
    fixture([{ name: 'a\0b' }]),
    'corrupt-archive',
    'NUL in ZIP entry name prohibited'
  );
  await assertFailure(
    fixture([{ name: 'link', mode: 0o120777 }]),
    'corrupt-archive',
    'Non-regular file type in ZIP entry prohibited: link'
  );
  await assertFailure(
    fixture([{ name: '../link', mode: 0o120777 }]),
    'corrupt-archive',
    'Non-regular file type in ZIP entry prohibited: ../link'
  );
  const invalidName = fixture([{ name: 'a' }]);
  invalidName[cdOffset(invalidName) + 46] = 255;
  await assertFailure(
    invalidName,
    'corrupt-archive',
    'ZIP entry name is not valid UTF-8 in central directory'
  );
  const zip64 = fixture();
  new DataView(zip64.buffer).setUint16(zip64.length - 12, 0xffff, true);
  await assertFailure(
    zip64,
    'unsupported-zip',
    'ZIP64 sentinel in the end of central directory is not supported'
  );
  const disk = fixture();
  new DataView(disk.buffer).setUint16(disk.length - 18, 1, true);
  await assertFailure(
    disk,
    'unsupported-zip',
    'Multi-disk ZIP archives are not supported'
  );
  const sig = fixture([{ name: 'a' }]);
  new DataView(sig.buffer).setUint32(cdOffset(sig), 0, true);
  await assertFailure(
    sig,
    'corrupt-archive',
    'Invalid central directory signature at 0'
  );
  const localSig = fixture([{ name: 'a' }]);
  new DataView(localSig.buffer).setUint32(0, 0, true);
  await assertFailure(
    localSig,
    'corrupt-archive',
    'Invalid local header signature'
  );
  const flag = fixture([{ name: 'a' }]);
  new DataView(flag.buffer).setUint16(6, 8, true);
  await assertFailure(
    flag,
    'corrupt-archive',
    'Mismatched flags in local header: a'
  );
  const method = fixture([{ name: 'a' }]);
  new DataView(method.buffer).setUint16(8, 8, true);
  await assertFailure(
    method,
    'corrupt-archive',
    'Mismatched compression method in local header: a'
  );
  const localCrc = fixture([{ name: 'a', data: 'x' }]);
  new DataView(localCrc.buffer).setUint32(14, 0, true);
  await assertFailure(
    localCrc,
    'corrupt-archive',
    'Mismatched CRC in local header: a'
  );
  const localSize = fixture([{ name: 'a', data: 'x' }]);
  new DataView(localSize.buffer).setUint32(18, 2, true);
  await assertFailure(
    localSize,
    'corrupt-archive',
    'Mismatched compressed size in local header: a'
  );
  const localExpanded = fixture([{ name: 'a', data: 'x' }]);
  new DataView(localExpanded.buffer).setUint32(22, 2, true);
  await assertFailure(
    localExpanded,
    'corrupt-archive',
    'Mismatched uncompressed size in local header: a'
  );
  const localName = fixture([{ name: 'a' }]);
  localName[30] = 'b'.charCodeAt(0);
  await assertFailure(
    localName,
    'corrupt-archive',
    'Local and central directory filenames disagree: a'
  );
  await assertFailure(
    fixture([{ name: 'a', data: 'x' }]),
    'decompression-limit',
    'Aggregate uncompressed size 1 exceeds cap of 0 bytes',
    { maxExpandedBytes: 0, maxArchiveBytes: 10000 }
  );
  await assertFailure(
    fixture([{ name: 'a', data: 'x', method: 8 }]),
    'decompression-limit',
    'Aggregate DEFLATE size 1 exceeds cap of 0 bytes',
    { maxInflatedBytes: 0 }
  );
});

test('legacy read CRC message matches baseline source', async () => {
  const bytes = fixture([{ name: 'a', data: 'x' }]);
  bytes[31] = 'y'.charCodeAt(0);
  const index = await indexOtioZip(bytes);
  try {
    await index.readEntry('a');
    throw new Error('entry was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(OtioZipError);
    expect((error as OtioZipError).code).toBe('corrupt-archive');
    expect((error as Error).message).toBe(
      `CRC32 mismatch on a: expected ${crc32(encoder.encode('x')).toString(16)}, got ${crc32(encoder.encode('y')).toString(16)}`
    );
  }
});

test('legacy ZIP boundary and sentinel messages match baseline', async () => {
  const brokenDirectory = fixture();
  new DataView(brokenDirectory.buffer).setUint32(
    brokenDirectory.length - 6,
    brokenDirectory.length + 1,
    true
  );
  await assertFailure(
    brokenDirectory,
    'corrupt-archive',
    'Central directory points beyond end of archive'
  );
  const wrongExtent = fixture();
  const wv = new DataView(wrongExtent.buffer);
  wv.setUint32(
    wrongExtent.length - 10,
    wv.getUint32(wrongExtent.length - 10, true) - 1,
    true
  );
  await assertFailure(
    wrongExtent,
    'corrupt-archive',
    'Central directory extent does not end at the end of central directory record'
  );
  const badLength = fixture([{ name: 'a' }]);
  new DataView(badLength.buffer).setUint16(
    cdOffset(badLength) + 28,
    0xffff,
    true
  );
  await assertFailure(
    badLength,
    'corrupt-archive',
    'Central directory entry extends past declared extent'
  );
  const badOffset = fixture([{ name: 'a' }]);
  new DataView(badOffset.buffer).setUint32(
    cdOffset(badOffset) + 42,
    0xfffffffe,
    true
  );
  await assertFailure(
    badOffset,
    'corrupt-archive',
    'Local header offset beyond archive'
  );
  const storedSize = fixture([{ name: 'a', data: 'x' }]);
  new DataView(storedSize.buffer).setUint32(cdOffset(storedSize) + 24, 2, true);
  await assertFailure(
    storedSize,
    'corrupt-archive',
    'STORED entry sizes disagree: a'
  );
  for (const [field, offset] of [
    ['compressed size', 20],
    ['uncompressed size', 24],
    ['local header offset', 42],
  ] as const) {
    const bytes = fixture([{ name: 'a' }]);
    new DataView(bytes.buffer).setUint32(
      cdOffset(bytes) + offset,
      0xffffffff,
      true
    );
    await assertFailure(
      bytes,
      'unsupported-zip',
      `ZIP64 sentinel ${field} is not supported`
    );
  }
  for (const [field, offset] of [
    ['local compressed size', 18],
    ['local uncompressed size', 22],
  ] as const) {
    const bytes = fixture([{ name: 'a' }]);
    new DataView(bytes.buffer).setUint32(offset, 0xffffffff, true);
    await assertFailure(
      bytes,
      'unsupported-zip',
      `ZIP64 sentinel ${field} is not supported`
    );
  }
  await assertFailure(
    fixture([{ name: './' }]),
    'corrupt-archive',
    'Invalid ZIP entry path: ./'
  );
  const oversized = fixture([{ name: 'content.otio', method: 8, data: 'x' }]);
  const ov = new DataView(oversized.buffer);
  ov.setUint32(22, 104857601, true);
  ov.setUint32(cdOffset(oversized) + 24, 104857601, true);
  await assertFailure(
    oversized,
    'decompression-limit',
    'content.otio exceeds 104857600 bytes',
    { maxExpandedBytes: 200 * 1024 * 1024, maxInflatedBytes: 200 * 1024 * 1024 }
  );
});

test('legacy census, ZIP64 locator and version messages match baseline', async () => {
  const source = zip([{ name: 'a' }]);
  const originalCd = cdOffset(source);
  const short = new Uint8Array(originalCd + 10 + 22);
  short.set(source.subarray(0, originalCd + 10));
  short.set(source.subarray(source.length - 22), originalCd + 10);
  new DataView(short.buffer).setUint32(short.length - 10, 10, true);
  await assertFailure(
    short,
    'corrupt-archive',
    'Truncated central directory entry'
  );
  const census = fixture();
  const cv = new DataView(census.buffer);
  cv.setUint16(census.length - 14, 0, true);
  cv.setUint16(census.length - 12, 0, true);
  await assertFailure(
    census,
    'corrupt-archive',
    'Central directory census did not consume the declared extent'
  );
  const base = fixture();
  const locator = new Uint8Array(base.length + 20);
  locator.set(base.subarray(0, base.length - 22));
  locator.set(base.subarray(base.length - 22), base.length - 2);
  new DataView(locator.buffer).setUint32(base.length - 22, 0x07064b50, true);
  await assertFailure(
    locator,
    'unsupported-zip',
    'ZIP64 end of central directory locator is not supported'
  );
  await assertFailure(
    zip([
      { name: 'version.txt', data: '2.0.0' },
      { name: 'content.otio', data: '{}' },
    ]),
    'corrupt-archive',
    'Invalid version.txt content: 2.0.0 (expected 1.0.0)'
  );
});

test('legacy decompressed size and missing-entry messages match baseline', async () => {
  const index = await indexOtioZip(
    fixture([{ name: 'a', data: 'x', method: 8 }])
  );
  try {
    await index.readEntry('a', () => new Uint8Array(2));
    throw new Error('entry was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(OtioZipError);
    expect((error as OtioZipError).code).toBe('corrupt-archive');
    expect((error as Error).message).toBe(
      'Decompressed length 2 does not match expected 1'
    );
  }
  try {
    await index.readEntry('missing');
    throw new Error('entry was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(OtioZipError);
    expect((error as OtioZipError).code).toBe('corrupt-archive');
    expect((error as Error).message).toBe(
      'Entry not found in archive: missing'
    );
  }
});

test('legacy local extents and invalid local names match baseline', async () => {
  const badUtf8 = fixture([{ name: 'a' }]);
  badUtf8[30] = 255;
  await assertFailure(
    badUtf8,
    'corrupt-archive',
    'ZIP entry name is not valid UTF-8 in local header'
  );
  const longName = fixture([{ name: 'a' }]);
  new DataView(longName.buffer).setUint16(26, 0xffff, true);
  await assertFailure(
    longName,
    'corrupt-archive',
    'Local header name extends beyond archive: a'
  );
  const longExtra = fixture([{ name: 'a' }]);
  const lv = new DataView(longExtra.buffer);
  lv.setUint16(28, cdOffset(longExtra) - 30, true);
  await assertFailure(
    longExtra,
    'corrupt-archive',
    'Local header extends beyond archive: a'
  );
  const beyond = fixture([{ name: 'a' }]);
  const bv = new DataView(beyond.buffer),
    bcd = cdOffset(beyond);
  for (const offset of [18, 22, bcd + 20, bcd + 24])
    bv.setUint32(offset, 10000, true);
  await assertFailure(
    beyond,
    'corrupt-archive',
    'File data extends beyond archive: a'
  );
  const overlap = fixture([{ name: 'a' }]);
  const ov = new DataView(overlap.buffer),
    ocd = cdOffset(overlap),
    length = ocd - 31 + 1;
  for (const offset of [18, 22, ocd + 20, ocd + 24])
    ov.setUint32(offset, length, true);
  await assertFailure(
    overlap,
    'corrupt-archive',
    'File data overlaps central directory: a'
  );
});

test('legacy short source and directory size messages match baseline', async () => {
  const incomplete = {
    size: 22,
    async read(start: number, end: number) {
      return new Uint8Array(Math.max(0, end - start - 1));
    },
  };
  await expect(indexOtioZip(incomplete)).rejects.toMatchObject({
    name: 'OtioZipError',
    code: 'corrupt-archive',
    message: 'ZIP source returned an incomplete range',
  });
  const size = 16 * 1024 * 1024 + 1;
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint32(12, size, true);
  const source = {
    size: size + 22,
    async read(start: number, end: number) {
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
    name: 'OtioZipError',
    code: 'unsupported-zip',
    message: 'Central directory exceeds the size limit',
  });
});

test('legacy extra-field and overlapping-entry messages match baseline', async () => {
  for (const [extra, code, message] of [
    [
      new Uint8Array([1, 0, 0, 0]),
      'unsupported-zip',
      'ZIP64 extended information is not supported: a',
    ],
    [new Uint8Array([1]), 'corrupt-archive', 'Truncated extra field: a'],
  ] as const) {
    const original = zip([{ name: 'a' }]),
      cd = cdOffset(original),
      insert = cd + 47;
    const modified = new Uint8Array(original.length + extra.length);
    modified.set(original.subarray(0, insert));
    modified.set(extra, insert);
    modified.set(original.subarray(insert), insert + extra.length);
    const view = new DataView(modified.buffer);
    view.setUint16(cd + 30, extra.length, true);
    view.setUint32(modified.length - 10, 47 + extra.length, true);
    await assertFailure(modified, code, message);
  }
  const inner = zip([{ name: 'b' }]).subarray(0, 31);
  const data = Array.from(inner, (byte) => String.fromCharCode(byte)).join('');
  const overlap = zip([{ name: 'a', data }, { name: 'b' }]);
  new DataView(overlap.buffer).setUint32(cdOffset(overlap) + 47 + 42, 31, true);
  await assertFailure(overlap, 'corrupt-archive', 'ZIP entries overlap: b');
});

test('legacy invalid limits and archive cap messages match baseline', async () => {
  const bytes = fixture();
  await expect(
    indexOtioZip(bytes, { maxExpandedBytes: -1 })
  ).rejects.toMatchObject({
    name: 'OtioZipError',
    code: 'corrupt-archive',
    message: 'Invalid ZIP size or limits',
  });
  await expect(
    indexOtioZip(bytes, { maxArchiveBytes: 0 })
  ).rejects.toMatchObject({
    name: 'ContentTooLargeError',
    message: `content is ${bytes.length} bytes, over the 0 cap`,
  });
});

test('legacy inflater refusal and stored-scan messages match baseline', async () => {
  const bytes = fixture([
    { name: 'a', method: 8, data: deflateRawSync(new Uint8Array(1024)) },
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(22, 1, true);
  view.setUint32(cdOffset(bytes) + 24, 1, true);
  const index = await indexOtioZip(bytes);
  await expect(index.readEntry('a')).rejects.toMatchObject({
    name: 'OtioZipError',
    code: 'decompression-limit',
    message: 'Streamed decompressed bytes exceeded limit of 1',
  });
  await expect(index.verifyStoredEntry('a')).rejects.toMatchObject({
    name: 'OtioZipError',
    code: 'unsupported-zip',
    message: 'Entry is not STORED: a',
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'DecompressionStream'
  );
  try {
    Object.defineProperty(globalThis, 'DecompressionStream', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const other = await indexOtioZip(bytes);
    await expect(other.readEntry('a')).rejects.toMatchObject({
      name: 'OtioZipError',
      code: 'unsupported-zip',
      message:
        'No DecompressionStream available; caller must supply a custom inflater',
    });
    class BrokenStream {
      readable = new ReadableStream({
        start(controller) {
          controller.error(new Error('fixture failure'));
        },
      });
      writable = new WritableStream();
    }
    Object.defineProperty(globalThis, 'DecompressionStream', {
      configurable: true,
      writable: true,
      value: BrokenStream,
    });
    const broken = await indexOtioZip(bytes);
    await expect(broken.readEntry('a')).rejects.toMatchObject({
      name: 'OtioZipError',
      code: 'corrupt-archive',
      message: 'Browser DecompressionStream failed: Error: fixture failure',
    });
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, 'DecompressionStream', descriptor);
    else Reflect.deleteProperty(globalThis, 'DecompressionStream');
  }
});

test('legacy ranged materialization cap message matches baseline', async () => {
  const bytes = zip([...reserved, { name: 'media/large.bin', data: 'x' }]);
  const view = new DataView(bytes.buffer);
  const cd = cdOffset(bytes);
  let local = 0;
  for (let i = 0; i < 2; i++)
    local +=
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true) +
      view.getUint32(local + 18, true);
  let central = cd;
  for (let i = 0; i < 2; i++)
    central +=
      46 +
      view.getUint16(central + 28, true) +
      view.getUint16(central + 30, true) +
      view.getUint16(central + 32, true);
  const dataStart = local + 30 + view.getUint16(local + 26, true);
  const size = 100 * 1024 * 1024 + 1;
  view.setUint32(local + 18, size, true);
  view.setUint32(local + 22, size, true);
  view.setUint32(central + 20, size, true);
  view.setUint32(central + 24, size, true);
  const prefix = bytes.slice(0, dataStart),
    suffix = bytes.slice(cd),
    end = dataStart + size;
  new DataView(suffix.buffer).setUint32(suffix.length - 6, end, true);
  const source = {
    size: end + suffix.length,
    async read(start: number, finish: number) {
      const out = new Uint8Array(finish - start);
      if (start < prefix.length)
        out.set(prefix.subarray(start, Math.min(finish, prefix.length)));
      if (finish > end) {
        const from = Math.max(start, end);
        out.set(suffix.subarray(from - end, finish - end), from - start);
      }
      return out;
    },
  };
  const index = await indexOtioZip(source);
  await expect(index.readEntry('media/large.bin')).rejects.toMatchObject({
    name: 'OtioZipError',
    code: 'decompression-limit',
    message: 'Entry media/large.bin is too large to materialize',
  });
});
