import { describe, expect, test } from 'bun:test';
import {
  otioBundleEntryName,
  type OtioBundleEntryName,
  type OtioZipEntryInfo,
  type OtioZipIndex,
} from '@relic/format';
import {
  createOtioMediaResolver,
  inferMediaMimeType,
} from '../src/otio-media.ts';

function entryName(name: string): OtioBundleEntryName {
  return otioBundleEntryName(name);
}

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
      expect(inferMediaMimeType('media/%_1001.png')).toBe('image/png');
      expect(inferMediaMimeType('media/?_1001.png')).toBe('image/png');
      expect(inferMediaMimeType('media/#_1001.png')).toBe('image/png');
      expect(inferMediaMimeType('media/frame.png?preview')).toBe(
        'application/octet-stream'
      );
      expect(inferMediaMimeType('unknown.xyz')).toBe(
        'application/octet-stream'
      );
    });
  });

  describe('createOtioMediaResolver', () => {
    type MockZipEntry = {
      readonly size: number;
      readonly bytes: Uint8Array;
      readonly isDirectory?: boolean;
    };

    function makeMockZipIndex(
      entriesMap: Record<string, MockZipEntry>
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
          isDirectory: info.isDirectory ?? false,
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

    test('resolves exact canonical entries and checks existence', async () => {
      const videoBytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]);
      const videoEntry = entryName('media/video.mp4');
      const zip = makeMockZipIndex({
        'media/video.mp4': { size: videoBytes.length, bytes: videoBytes },
      });

      const resolver = createOtioMediaResolver(zip);
      expect(resolver.hasEntry(videoEntry)).toBe(true);
      expect(resolver.hasEntry(entryName('media/nonexistent.mp4'))).toBe(false);

      const blob = await resolver.resolveBlob(videoEntry);
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

      const blob = await resolver.resolveBlob(entryName('media/shared.mp4'));
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
      expect(
        resolver.resolveBlob(entryName('media/large.mp4'))
      ).rejects.toThrow();
      resolver.dispose();
    });

    test('dispose cleans up and invalidates resolver', async () => {
      const imgBytes = new Uint8Array([137, 80, 78, 71]);
      const zip = makeMockZipIndex({
        'media/img.png': { size: imgBytes.length, bytes: imgBytes },
      });

      const resolver = createOtioMediaResolver(zip);
      const imageEntry = entryName('media/img.png');
      const blob = await resolver.resolveBlob(imageEntry);
      expect(blob).not.toBeNull();

      resolver.dispose();
      expect(resolver.hasEntry(imageEntry)).toBe(false);
      expect(await resolver.resolveBlob(imageEntry)).toBeNull();
    });

    test('keeps encoded and reserved image entry names distinct', async () => {
      const percentQuestionBytes = new Uint8Array([1]);
      const questionBytes = new Uint8Array([2]);
      const percentSpaceBytes = new Uint8Array([3]);
      const spaceBytes = new Uint8Array([4]);
      const percentBytes = new Uint8Array([5]);
      const sequenceQuestionBytes = new Uint8Array([6]);
      const sequenceFragmentBytes = new Uint8Array([7]);
      const resolver = createOtioMediaResolver(
        makeMockZipIndex({
          'media/%3F.png': {
            size: percentQuestionBytes.length,
            bytes: percentQuestionBytes,
          },
          'media/?.png': { size: questionBytes.length, bytes: questionBytes },
          'media/a%20b.png': {
            size: percentSpaceBytes.length,
            bytes: percentSpaceBytes,
          },
          'media/a b.png': { size: spaceBytes.length, bytes: spaceBytes },
          'media/%_1001.png': {
            size: percentBytes.length,
            bytes: percentBytes,
          },
          'media/?_1001.png': {
            size: sequenceQuestionBytes.length,
            bytes: sequenceQuestionBytes,
          },
          'media/#_1001.png': {
            size: sequenceFragmentBytes.length,
            bytes: sequenceFragmentBytes,
          },
        })
      );
      const expected = [
        [entryName('media/%3F.png'), percentQuestionBytes],
        [entryName('media/?.png'), questionBytes],
        [entryName('media/a%20b.png'), percentSpaceBytes],
        [entryName('media/a b.png'), spaceBytes],
        [entryName('media/%_1001.png'), percentBytes],
        [entryName('media/?_1001.png'), sequenceQuestionBytes],
        [entryName('media/#_1001.png'), sequenceFragmentBytes],
      ] as const;

      for (const [entry, bytes] of expected) {
        const blob = await resolver.resolveBlob(entry);
        if (!blob) throw new Error(`expected media blob for ${entry}`);
        expect(blob.type).toBe('image/png');
        expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(
          Array.from(bytes)
        );
      }
      resolver.dispose();
    });

    test('does not resolve directory media entries', async () => {
      const directory = entryName('media/stills/');
      const resolver = createOtioMediaResolver(
        makeMockZipIndex({
          'media/stills/': {
            size: 0,
            bytes: new Uint8Array(),
            isDirectory: true,
          },
        })
      );

      expect(resolver.hasEntry(directory)).toBe(false);
      expect(await resolver.resolveBlob(directory)).toBeNull();
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
      await expect(
        resolver.resolveBlob(entryName('media/bad.mp4'))
      ).rejects.toThrow();
      await expect(
        resolver.resolveBlob(entryName('media/bad.mp4'))
      ).rejects.toThrow();
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
        resolver.resolveBlob(entryName('media/a.mp4')),
        resolver.resolveBlob(entryName('media/b.mp4')),
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
