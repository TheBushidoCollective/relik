import { deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import {
  crc32,
  indexOtioZip,
  type OtioBundleEntryName,
  type OtioZipIndex,
  otioBundleEntryName,
} from '@relic/format';
import {
  createOtioMediaResolver,
  inferMediaMimeType,
} from '../src/otio-media.ts';

const encoder = new TextEncoder();
const MIB = 1024 * 1024;

interface FixtureEntry {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly method?: 0 | 8;
  readonly checksum?: number;
  readonly declaredSize?: number;
}

/** Build an actual OTIOZ, retaining each payload as a separate Blob part. */
function archive(entries: readonly FixtureEntry[]): Blob {
  const files: FixtureEntry[] = [
    { name: 'version.txt', bytes: encoder.encode('1.0.0\n') },
    {
      name: 'content.otio',
      bytes: encoder.encode('{"OTIO_SCHEMA":"Timeline.1"}'),
    },
    ...entries,
  ];
  const locals: BlobPart[] = [];
  const directories: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of files) {
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 0;
    const compressed =
      method === 8 ? Uint8Array.from(deflateRawSync(entry.bytes)) : entry.bytes;
    const checksum = entry.checksum ?? crc32(entry.bytes);
    const size = entry.declaredSize ?? entry.bytes.length;
    const header = new Uint8Array(30 + name.length);
    const local = new DataView(header.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, checksum >>> 0, true);
    local.setUint32(18, compressed.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    header.set(name, 30);
    locals.push(header, compressed);

    const central = new Uint8Array(46 + name.length);
    const directory = new DataView(central.buffer);
    directory.setUint32(0, 0x02014b50, true);
    directory.setUint16(4, 20, true);
    directory.setUint16(6, 20, true);
    directory.setUint16(10, method, true);
    directory.setUint32(16, checksum >>> 0, true);
    directory.setUint32(20, compressed.length, true);
    directory.setUint32(24, size, true);
    directory.setUint16(28, name.length, true);
    directory.setUint32(42, offset, true);
    central.set(name, 46);
    directories.push(central);
    offset += header.length + compressed.length;
  }
  const directoryOffset = offset;
  const directoryBytes = directories.reduce(
    (sum, part) => sum + part.length,
    0
  );
  const footer = new Uint8Array(22);
  const end = new DataView(footer.buffer);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directoryBytes, true);
  end.setUint32(16, directoryOffset, true);
  return new Blob([...locals, ...directories, footer]);
}

async function indexed(entries: readonly FixtureEntry[]): Promise<{
  readonly bundle: Blob;
  readonly zip: OtioZipIndex;
  readonly reads: Array<readonly [number, number]>;
}> {
  const bundle = archive(entries);
  const reads: Array<readonly [number, number]> = [];
  const zip = await indexOtioZip({
    size: bundle.size,
    async read(start, end) {
      reads.push([start, end]);
      return new Uint8Array(await bundle.slice(start, end).arrayBuffer());
    },
  });
  return { bundle, zip, reads };
}

function entryName(name: string): OtioBundleEntryName {
  return otioBundleEntryName(name);
}

describe('otio-media', () => {
  test('infers MIME types from media entry names', () => {
    expect(inferMediaMimeType('clip.MP4')).toBe('video/mp4');
    expect(inferMediaMimeType('clip.webm')).toBe('video/webm');
    expect(inferMediaMimeType('clip.mov')).toBe('video/quicktime');
    expect(inferMediaMimeType('song.mp3')).toBe('audio/mpeg');
    expect(inferMediaMimeType('song.wav')).toBe('audio/wav');
    expect(inferMediaMimeType('song.aac')).toBe('audio/aac');
    expect(inferMediaMimeType('song.oga')).toBe('audio/ogg');
    expect(inferMediaMimeType('image.png')).toBe('image/png');
    expect(inferMediaMimeType('image.jpeg')).toBe('image/jpeg');
    expect(inferMediaMimeType('image.webp')).toBe('image/webp');
    expect(inferMediaMimeType('image.gif')).toBe('image/gif');
    expect(inferMediaMimeType('image.svg')).toBe('image/svg+xml');
    expect(inferMediaMimeType('image.exr')).toBe('image/x-exr');
    expect(inferMediaMimeType('image.dpx')).toBe('image/x-dpx');
    expect(inferMediaMimeType('unknown')).toBe('application/octet-stream');
  });

  test('verifies a stored entry once in bounded reads, without charging the inflation budget', async () => {
    const bytes = new Uint8Array(8 * MIB + 257);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const { bundle, zip, reads } = await indexed([
      { name: 'media/clip.mp4', bytes },
    ]);
    const resolver = createOtioMediaResolver(zip, bundle, {
      maxInflatedBytes: 0,
    });
    const name = entryName('media/clip.mp4');
    const entry = zip.entries.get(name);
    if (!entry) throw new Error('expected ZIP entry');
    reads.length = 0;
    const [first, second] = await Promise.all([
      resolver.resolveBlob(name),
      resolver.resolveBlob(name),
    ]);
    if (!first || !second) throw new Error('expected media Blob');
    expect(first).toBe(second);
    expect(first.type).toBe('video/mp4');
    expect(first.size).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(await first.arrayBuffer()), bytes)).toBe(
      0
    );
    expect(resolver.getDecompressedBytes()).toBe(0);
    const mediaReads = reads.filter(([start]) => start >= entry.dataOffset);
    expect(mediaReads.length).toBe(2);
    expect(mediaReads.every(([start, end]) => end - start <= 8 * MIB)).toBe(
      true
    );
    await resolver.resolveBlob(name);
    expect(reads.length).toBe(2);
    resolver.dispose();
  });

  test('inflates and charges DEFLATE output rather than archive bytes', async () => {
    const bytes = new Uint8Array(8192).fill(42);
    const { zip, bundle, reads } = await indexed([
      { name: 'media/compressed.mp4', bytes, method: 8 },
    ]);
    const name = entryName('media/compressed.mp4');
    const entry = zip.entries.get(name);
    if (!entry) throw new Error('expected ZIP entry');
    expect(entry.compressedSize).toBeLessThan(bytes.length);
    const indexedReads = reads.length;
    const refused = createOtioMediaResolver(zip, bundle, {
      maxInflatedBytes: bytes.length - 1,
    });
    await expect(refused.resolveBlob(name)).rejects.toThrow(
      'Decompression limit'
    );
    expect(refused.getDecompressedBytes()).toBe(0);
    refused.dispose();

    const resolver = createOtioMediaResolver(zip, bundle, {
      maxInflatedBytes: bytes.length,
    });
    const blob = await resolver.resolveBlob(name);
    if (!blob) throw new Error('expected decompressed Blob');
    expect(Buffer.compare(Buffer.from(await blob.arrayBuffer()), bytes)).toBe(
      0
    );
    expect(resolver.getDecompressedBytes()).toBe(bytes.length);
    expect(reads.length).toBe(indexedReads);
    resolver.dispose();
  });

  test('assembles DEFLATE output across multiple Blob batches', async () => {
    const bytes = new Uint8Array(8 * MIB + 17).fill(73);
    const { zip, bundle } = await indexed([
      { name: 'media/long.mp4', bytes, method: 8 },
    ]);
    const resolver = createOtioMediaResolver(zip, bundle);
    const blob = await resolver.resolveBlob(entryName('media/long.mp4'));
    if (!blob) throw new Error('expected decompressed Blob');
    expect(blob.size).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(await blob.arrayBuffer()), bytes)).toBe(
      0
    );
    expect(resolver.getDecompressedBytes()).toBe(bytes.length);
    resolver.dispose();
  });

  test('reserves DEFLATE output before concurrent entries can exceed the budget', async () => {
    const bytes = new Uint8Array(800).fill(7);
    const { zip, bundle } = await indexed([
      { name: 'media/a.mp4', bytes, method: 8 },
      { name: 'media/b.mp4', bytes, method: 8 },
    ]);
    const resolver = createOtioMediaResolver(zip, bundle, {
      maxInflatedBytes: 1000,
    });
    const results = await Promise.allSettled([
      resolver.resolveBlob(entryName('media/a.mp4')),
      resolver.resolveBlob(entryName('media/b.mp4')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect(resolver.getDecompressedBytes()).toBe(800);
    resolver.dispose();
  });

  test('rejects a corrupt stored entry once and remembers its failure', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { zip, bundle } = await indexed([
      { name: 'media/bad.mp4', bytes, checksum: crc32(bytes) ^ 1 },
    ]);
    let verifications = 0;
    const tracked: OtioZipIndex = {
      ...zip,
      async verifyStoredEntry(name) {
        verifications++;
        await zip.verifyStoredEntry(name);
      },
    };
    const resolver = createOtioMediaResolver(tracked, bundle);
    const name = entryName('media/bad.mp4');
    await expect(resolver.resolveBlob(name)).rejects.toThrow();
    await expect(resolver.resolveBlob(name)).rejects.toThrow();
    expect(verifications).toBe(1);
    expect(resolver.getDecompressedBytes()).toBe(0);
    resolver.dispose();
  });

  test('does not return a stored Blob when disposed during verification', async () => {
    const { zip, bundle } = await indexed([
      { name: 'media/pending.mp4', bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const deferred: OtioZipIndex = {
      ...zip,
      async verifyStoredEntry(name) {
        await gate;
        await zip.verifyStoredEntry(name);
      },
    };
    const resolver = createOtioMediaResolver(deferred, bundle);
    const name = entryName('media/pending.mp4');
    const pending = resolver.resolveBlob(name);
    resolver.dispose();
    release();
    await expect(pending).rejects.toThrow('resolver disposed');
    expect(await resolver.resolveBlob(name)).toBeNull();
  });

  test('rejects corrupt and wrongly sized inflated media without keeping its charge', async () => {
    const bytes = new Uint8Array(64).fill(7);
    for (const options of [
      { checksum: crc32(bytes) ^ 1 },
      { declaredSize: bytes.length - 1 },
      { declaredSize: bytes.length + 1 },
    ]) {
      const { zip, bundle } = await indexed([
        { name: 'media/bad.mp4', bytes, method: 8, ...options },
      ]);
      const resolver = createOtioMediaResolver(zip, bundle);
      await expect(
        resolver.resolveBlob(entryName('media/bad.mp4'))
      ).rejects.toThrow();
      expect(resolver.getDecompressedBytes()).toBe(0);
      resolver.dispose();
    }
  });

  test('keeps encoded and reserved entry names distinct', async () => {
    const names = [
      '%3F.png',
      '?.png',
      'a%20b.png',
      'a b.png',
      '%_1001.png',
      '?_1001.png',
      '#_1001.png',
    ];
    const fixtures = names.map((name, index) => ({
      name: `media/${name}`,
      bytes: new Uint8Array([index + 1]),
    }));
    const { zip, bundle } = await indexed(fixtures);
    const resolver = createOtioMediaResolver(zip, bundle);
    for (const [index, name] of names.entries()) {
      const blob = await resolver.resolveBlob(entryName(`media/${name}`));
      if (!blob) throw new Error('expected image Blob');
      expect(blob.type).toBe('image/png');
      expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
        index + 1,
      ]);
    }
    resolver.dispose();
  });

  test('shares an object URL and revokes it on disposal', async () => {
    const { zip, bundle } = await indexed([
      { name: 'media/img.png', bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const createDescriptor = Object.getOwnPropertyDescriptor(
      URL,
      'createObjectURL'
    );
    const revokeDescriptor = Object.getOwnPropertyDescriptor(
      URL,
      'revokeObjectURL'
    );
    const revoked: string[] = [];
    let created = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:otio-${++created}`,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const resolver = createOtioMediaResolver(zip, bundle);
      const name = entryName('media/img.png');
      expect(
        await Promise.all([
          resolver.resolveUrl(name),
          resolver.resolveUrl(name),
        ])
      ).toEqual(['blob:otio-1', 'blob:otio-1']);
      resolver.dispose();
      expect(created).toBe(1);
      expect(revoked).toEqual(['blob:otio-1']);
    } finally {
      if (createDescriptor)
        Object.defineProperty(URL, 'createObjectURL', createDescriptor);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeDescriptor)
        Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  test('does not resolve non-media, absent, or disposed entries', async () => {
    const { zip, bundle } = await indexed([
      { name: 'media/img.png', bytes: new Uint8Array([137, 80, 78, 71]) },
      { name: 'media/stills/', bytes: new Uint8Array() },
    ]);
    const resolver = createOtioMediaResolver(zip, bundle);
    const image = entryName('media/img.png');
    expect(resolver.hasEntry(image)).toBe(true);
    expect(resolver.hasEntry(entryName('media/missing.png'))).toBe(false);
    expect(resolver.hasEntry(entryName('media/stills'))).toBe(false);
    expect(await resolver.resolveBlob(entryName('media/stills'))).toBeNull();
    expect(
      await resolver.resolveBlob(entryName('media/missing.png'))
    ).toBeNull();
    expect(resolver.hasEntry('version.txt' as OtioBundleEntryName)).toBe(false);
    expect(await resolver.resolveBlob(image)).not.toBeNull();
    resolver.dispose();
    expect(resolver.hasEntry(image)).toBe(false);
    expect(await resolver.resolveBlob(image)).toBeNull();
  });
});
