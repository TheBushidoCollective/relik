import { describe, expect, test } from 'bun:test';
import type { OtioZipEntryInfo, OtioZipIndex } from '@relic/format';
import {
  createOtioMediaResolver,
  inferMediaMimeType,
} from '../src/otio-media.ts';

describe('otio-media', () => {
  describe('inferMediaMimeType', () => {
    test('identifies video formats', () => {
      expect(inferMediaMimeType('video.mp4')).toBe('video/mp4');
      expect(inferMediaMimeType('clip.m4v')).toBe('video/mp4');
      expect(inferMediaMimeType('movie.webm')).toBe('video/webm');
      expect(inferMediaMimeType('take.mov')).toBe('video/quicktime');
    });

    test('identifies audio formats', () => {
      expect(inferMediaMimeType('track.mp3')).toBe('audio/mpeg');
      expect(inferMediaMimeType('sound.wav')).toBe('audio/wav');
      expect(inferMediaMimeType('voice.aac')).toBe('audio/aac');
      expect(inferMediaMimeType('music.ogg')).toBe('audio/ogg');
      expect(inferMediaMimeType('audio.oga')).toBe('audio/ogg');
    });

    test('identifies image formats and unsupported formats', () => {
      expect(inferMediaMimeType('frame.png')).toBe('image/png');
      expect(inferMediaMimeType('photo.jpg')).toBe('image/jpeg');
      expect(inferMediaMimeType('image.jpeg')).toBe('image/jpeg');
      expect(inferMediaMimeType('anim.webp')).toBe('image/webp');
      expect(inferMediaMimeType('icon.gif')).toBe('image/gif');
      expect(inferMediaMimeType('vector.svg')).toBe('image/svg+xml');
      expect(inferMediaMimeType('plate.exr')).toBe('image/x-exr');
      expect(inferMediaMimeType('scan.dpx')).toBe('image/x-dpx');
      expect(inferMediaMimeType('unknown.xyz')).toBe(
        'application/octet-stream'
      );
    });
  });

  describe('createOtioMediaResolver', () => {
    function makeMockZipIndex(
      entriesMap: Record<string, { size: number; bytes: Uint8Array }>
    ): OtioZipIndex {
      const entries = new Map<string, OtioZipEntryInfo>();
      for (const [name, info] of Object.entries(entriesMap)) {
        entries.set(name, {
          name,
          method: 0,
          compressedSize: info.size,
          uncompressedSize: info.size,
          crc32: 0,
          dataOffset: 0,
          isDirectory: false,
        });
      }

      return {
        entries,
        versionText: '1.0.0',
        contentOtioBytes: new Uint8Array([123, 125]),
        contentSha256: 'mocksha',
        async readEntry(name: string): Promise<Uint8Array> {
          const entry = entriesMap[name];
          if (!entry) throw new Error(`Entry not found: ${name}`);
          return entry.bytes;
        },
      };
    }

    test('resolves blob and checks existence', async () => {
      const videoBytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]);
      const zip = makeMockZipIndex({
        'media/video.mp4': { size: videoBytes.length, bytes: videoBytes },
      });

      const resolver = createOtioMediaResolver(zip);
      expect(resolver.hasEntry('media/video.mp4')).toBe(true);
      expect(resolver.hasEntry('video.mp4')).toBe(true); // Finds via media/ prefix
      expect(resolver.hasEntry('media/nonexistent.mp4')).toBe(false);

      const blob = await resolver.resolveBlob('media/video.mp4');
      expect(blob).not.toBeNull();
      expect(blob?.size).toBe(videoBytes.length);
      expect(blob?.type).toBe('video/mp4');

      expect(resolver.getDecompressedBytes()).toBe(videoBytes.length);
      resolver.dispose();
    });

    test('copies shared backing before constructing a Blob', async () => {
      if (typeof SharedArrayBuffer === 'undefined') return;
      const bytes = new Uint8Array(new SharedArrayBuffer(4));
      bytes.set([1, 2, 3, 4]);
      const resolver = createOtioMediaResolver(
        makeMockZipIndex({
          'media/shared.mp4': { size: bytes.length, bytes },
        })
      );

      const blob = await resolver.resolveBlob('media/shared.mp4');
      if (blob === null) throw new Error('expected shared media Blob');
      expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
        1, 2, 3, 4,
      ]);
      resolver.dispose();
    });

    test('enforces aggregate decompression limit', async () => {
      const largeBytes = new Uint8Array(2000);
      const zip = makeMockZipIndex({
        'media/large.mp4': { size: largeBytes.length, bytes: largeBytes },
      });

      // Limit to 1000 bytes
      const resolver = createOtioMediaResolver(zip, {
        maxDecompressedBytes: 1000,
      });
      expect(resolver.resolveBlob('media/large.mp4')).rejects.toThrow();
      resolver.dispose();
    });

    test('dispose cleans up and invalidates resolver', async () => {
      const imgBytes = new Uint8Array([137, 80, 78, 71]);
      const zip = makeMockZipIndex({
        'media/img.png': { size: imgBytes.length, bytes: imgBytes },
      });

      const resolver = createOtioMediaResolver(zip);
      const blob = await resolver.resolveBlob('media/img.png');
      expect(blob).not.toBeNull();

      resolver.dispose();
      expect(resolver.hasEntry('media/img.png')).toBe(false);
      expect(await resolver.resolveBlob('media/img.png')).toBeNull();
    });

    test('shares one inflation across canonical media aliases', async () => {
      let reads = 0;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const indexed = makeMockZipIndex({
        'media/clip.mp4': { size: bytes.length, bytes },
      });
      const zip: OtioZipIndex = {
        ...indexed,
        readEntry: async (name: string) => {
          reads += 1;
          await Promise.resolve();
          return indexed.readEntry(name);
        },
      };
      const resolver = createOtioMediaResolver(zip);
      const [bare, dotted, file, encoded] = await Promise.all([
        resolver.resolveBlob('clip.mp4'),
        resolver.resolveBlob('media/./clip.mp4'),
        resolver.resolveBlob('file:media/clip.mp4'),
        resolver.resolveBlob('media/clip%2Emp4'),
      ]);
      expect(reads).toBe(1);
      expect(dotted).toBe(bare);
      expect(file).toBe(bare);
      expect(encoded).toBe(bare);
      expect(resolver.getDecompressedBytes()).toBe(bytes.length);
      resolver.dispose();
    });
    test('does not resolve root archive entries outside media', async () => {
      const resolver = createOtioMediaResolver(
        makeMockZipIndex({
          'clip.mp4': { size: 4, bytes: new Uint8Array([1, 2, 3, 4]) },
        })
      );

      expect(resolver.hasEntry('clip.mp4')).toBe(false);
      expect(await resolver.resolveBlob('clip.mp4')).toBeNull();
      resolver.dispose();
    });

    test('does not inflate a failed entry again', async () => {
      let reads = 0;
      const indexed = makeMockZipIndex({
        'media/bad.mp4': { size: 4, bytes: new Uint8Array(4) },
      });
      const zip: OtioZipIndex = {
        ...indexed,
        readEntry: async () => {
          reads += 1;
          throw new Error('corrupt entry');
        },
      };
      const resolver = createOtioMediaResolver(zip);
      await expect(resolver.resolveBlob('media/bad.mp4')).rejects.toThrow();
      await expect(resolver.resolveBlob('media/bad.mp4')).rejects.toThrow();
      expect(reads).toBe(1);
      resolver.dispose();
    });

    test('reserves bytes before a second entry can pass the cap', async () => {
      let reads = 0;
      const firstBytes = new Uint8Array(800);
      const secondBytes = new Uint8Array(800);
      const indexed = makeMockZipIndex({
        'media/a.mp4': { size: firstBytes.length, bytes: firstBytes },
        'media/b.mp4': { size: secondBytes.length, bytes: secondBytes },
      });
      const zip: OtioZipIndex = {
        ...indexed,
        readEntry: async (name: string) => {
          reads += 1;
          await Promise.resolve();
          return indexed.readEntry(name);
        },
      };
      const resolver = createOtioMediaResolver(zip, {
        maxDecompressedBytes: 1000,
      });
      const results = await Promise.allSettled([
        resolver.resolveBlob('media/a.mp4'),
        resolver.resolveBlob('media/b.mp4'),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled'
      );
      expect(fulfilled).toHaveLength(1);
      expect(reads).toBe(1);
      expect(resolver.getDecompressedBytes()).toBe(800);
      resolver.dispose();
    });
  });
});
