import { describe, expect, test } from 'bun:test';
import type {
  OtioMediaReference,
  OtioRationalTime,
  OtioZipEntryInfo,
  OtioZipIndex,
} from '@relic/format';
import {
  createOtioMediaResolver,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  inferMediaMimeType,
  resolveImageSequenceFramePath,
  sanitizeBundlePath,
} from '../src/otio-media.ts';

describe('otio-media', () => {
  describe('sanitizeBundlePath', () => {
    test('normalizes clean relative paths', () => {
      expect(sanitizeBundlePath('media/video.mp4')).toBe('media/video.mp4');
      expect(sanitizeBundlePath('clips/scene_01.webm')).toBe('clips/scene_01.webm');
      expect(sanitizeBundlePath('./media/sub/../clip.mov')).toBe('media/clip.mov');
    });

    test('performs single-pass percent-decoding safely', () => {
      expect(sanitizeBundlePath('media/my%20video.mp4')).toBe('media/my video.mp4');
      expect(sanitizeBundlePath('media%2Fclip%2Epng')).toBe('media/clip.png');
    });

    test('strips relative file: prefix', () => {
      expect(sanitizeBundlePath('file:media/audio.wav')).toBe('media/audio.wav');
      expect(sanitizeBundlePath('file:clip.mp4')).toBe('clip.mp4');
    });

    test('strips query strings and fragments', () => {
      expect(sanitizeBundlePath('media/clip.mp4?v=123#t=10')).toBe('media/clip.mp4');
    });

    test('rejects remote URL schemes', () => {
      expect(() => sanitizeBundlePath('http://evil.com/video.mp4')).toThrow(/Forbidden remote/);
      expect(() => sanitizeBundlePath('https://evil.com/video.mp4')).toThrow(/Forbidden remote/);
      expect(() => sanitizeBundlePath('ftp://host/file.mp4')).toThrow(/Forbidden remote/);
      expect(() => sanitizeBundlePath('data:text/plain;base64,abc')).toThrow(/Forbidden remote/);
      expect(() => sanitizeBundlePath('blob:https://example.com/uuid')).toThrow(/Forbidden remote/);
      expect(() => sanitizeBundlePath('javascript:alert(1)')).toThrow(/Forbidden remote/);
    });

    test('rejects absolute or authority file URIs', () => {
      expect(() => sanitizeBundlePath('file:///etc/passwd')).toThrow(/Forbidden absolute/);
      expect(() => sanitizeBundlePath('file://localhost/clip.mp4')).toThrow(/Forbidden absolute/);
    });

    test('rejects absolute paths and drive letters', () => {
      expect(() => sanitizeBundlePath('/var/media/video.mp4')).toThrow(/Forbidden absolute/);
      expect(() => sanitizeBundlePath('\\Windows\\Media\\clip.mp4')).toThrow(/Forbidden absolute/);
      expect(() => sanitizeBundlePath('C:/media/clip.mp4')).toThrow(/Forbidden absolute/);
      expect(() => sanitizeBundlePath('D:\\clips\\video.mov')).toThrow(/Forbidden absolute/);
    });

    test('rejects path traversal escaping bundle root', () => {
      expect(() => sanitizeBundlePath('../outside.mp4')).toThrow(/Path traversal escape/);
      expect(() => sanitizeBundlePath('media/../../outside.mp4')).toThrow(/Path traversal escape/);
      expect(() => sanitizeBundlePath('media/sub/../../../etc')).toThrow(/Path traversal escape/);
    });

    test('rejects control characters and NUL bytes', () => {
      expect(() => sanitizeBundlePath('media/\0clip.mp4')).toThrow(/control character/);
      expect(() => sanitizeBundlePath('media/\x1Fclip.mp4')).toThrow(/control character/);
      expect(() => sanitizeBundlePath('media/%00clip.mp4')).toThrow(/control character/);
    });

    test('rejects empty paths', () => {
      expect(() => sanitizeBundlePath('')).toThrow(/non-empty/);
      expect(() => sanitizeBundlePath('   ')).toThrow(/non-empty/);
      expect(() => sanitizeBundlePath('.')).toThrow(/Empty normalized/);
    });
  });

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
      expect(inferMediaMimeType('unknown.xyz')).toBe('application/octet-stream');
    });
  });

  describe('resolveImageSequenceFramePath', () => {
    test('formats zero-padded frame numbers accurately', () => {
      const ref: OtioMediaReference = {
        schema: 'ImageSequenceReference.1',
        target_url_base: 'media/seq/',
        name_prefix: 'shot_',
        name_suffix: '.png',
        start_frame: 1001,
        frame_step: 1,
        rate: 24,
        frame_zero_padding: 4,
      };

      // 0 seconds -> frame 1001
      const t0: OtioRationalTime = { value: 0, rate: 24 };
      expect(resolveImageSequenceFramePath(ref, t0)).toBe('media/seq/shot_1001.png');

      // 1 second (24 frames) -> frame 1025
      const t1: OtioRationalTime = { value: 24, rate: 24 };
      expect(resolveImageSequenceFramePath(ref, t1)).toBe('media/seq/shot_1025.png');

      // 0.5 seconds (12 frames) with frame_step=2
      const stepRef: OtioMediaReference = {
        ...ref,
        frame_step: 2,
      };
      const tMid: OtioRationalTime = { value: 12, rate: 24 };
      expect(resolveImageSequenceFramePath(stepRef, tMid)).toBe('media/seq/shot_1025.png');
    });

    test('handles unpadded frames', () => {
      const ref: OtioMediaReference = {
        schema: 'ImageSequenceReference',
        target_url_base: 'frames/',
        name_prefix: 'f',
        name_suffix: '.jpg',
        start_frame: 1,
        frame_step: 1,
        rate: 30,
        frame_zero_padding: 0,
      };

      const t: OtioRationalTime = { value: 15, rate: 30 }; // 0.5s -> frame 15, total = 1 + 15 = 16
      expect(resolveImageSequenceFramePath(ref, t)).toBe('frames/f16.jpg');
    });

    test('returns null for non-image-sequence schema', () => {
      const ref: OtioMediaReference = {
        schema: 'ExternalReference.1',
        target_url: 'media/video.mp4',
      };
      expect(resolveImageSequenceFramePath(ref, { value: 0, rate: 24 })).toBeNull();
    });
  });

  describe('createOtioMediaResolver', () => {
    function makeMockZipIndex(entriesMap: Record<string, { size: number; bytes: Uint8Array }>): OtioZipIndex {
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

    test('enforces aggregate decompression limit', async () => {
      const largeBytes = new Uint8Array(2000);
      const zip = makeMockZipIndex({
        'media/large.mp4': { size: largeBytes.length, bytes: largeBytes },
      });

      // Limit to 1000 bytes
      const resolver = createOtioMediaResolver(zip, { maxDecompressedBytes: 1000 });
      expect(resolver.resolveBlob('media/large.mp4')).rejects.toThrow(/Decompression limit exceeded/);
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
  });
});
