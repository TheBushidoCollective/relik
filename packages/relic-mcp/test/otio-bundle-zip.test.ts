import { describe, expect, test } from 'bun:test';
import {
  assembleZipArchive,
  buildZipArchive,
  measureZipArchive,
  prepareZipArchive,
} from '../src/otio-bundle.ts';
import { PublishError } from '../src/publish.ts';

const ENCODER = new TextEncoder();

type Entries = Parameters<typeof buildZipArchive>[0];

const SETS: Record<string, Entries> = {
  empty: [],
  storedOnly: [
    { name: 'media/a.mp4', data: ENCODER.encode('stored media'), method: 0 },
  ],
  deflatedOnly: [
    {
      name: 'content.otio',
      data: ENCODER.encode('{"OTIO_SCHEMA":"Timeline.1"}'.repeat(50)),
      method: 8,
    },
  ],
  mixed: [
    {
      name: 'content.otio',
      data: ENCODER.encode('{"OTIO_SCHEMA":"Timeline.1"}'.repeat(20)),
      method: 8,
    },
    { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
    { name: 'media/clip.mp4', data: new Uint8Array(4096).fill(3), method: 0 },
  ],
  unicodeName: [
    { name: 'media/ünïcode-名前.mp4', data: ENCODER.encode('x'), method: 0 },
  ],
};

describe('ZIP prepare and assemble', () => {
  for (const [label, entries] of Object.entries(SETS)) {
    test(`${label}: assembling a prepared archive equals buildZipArchive`, () => {
      const prepared = prepareZipArchive(entries);
      const assembled = assembleZipArchive(prepared);
      expect(assembled.length).toBe(prepared.totalSize);
      expect(assembled).toEqual(buildZipArchive(entries));
    });

    test(`${label}: measureZipArchive reports the built size without an archive`, () => {
      expect(measureZipArchive(entries)).toBe(buildZipArchive(entries).length);
    });

    test(`${label}: assembly is deterministic`, () => {
      const prepared = prepareZipArchive(entries);
      expect(assembleZipArchive(prepared)).toEqual(
        assembleZipArchive(prepared)
      );
    });
  }

  test('the exact size is accepted and one byte less is refused by both paths', () => {
    const size = measureZipArchive(SETS['mixed']!);
    expect(prepareZipArchive(SETS['mixed']!, size).totalSize).toBe(size);
    expect(() => buildZipArchive(SETS['mixed']!, size)).not.toThrow();

    const refusedPrepare = (() => {
      try {
        prepareZipArchive(SETS['mixed']!, size - 1);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const refusedBuild = (() => {
      try {
        buildZipArchive(SETS['mixed']!, size - 1);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusedPrepare).toBeInstanceOf(PublishError);
    expect(refusedBuild).toBeInstanceOf(PublishError);
    expect((refusedPrepare as PublishError).code).toBe(
      'local_size_precheck_failed'
    );
    expect((refusedBuild as PublishError).code).toBe(
      'local_size_precheck_failed'
    );
  });

  test('too many entries is refused by prepare and build alike', () => {
    const tooMany: Entries = Array.from({ length: 0xffff }, (_, i) => ({
      name: `m/${i}`,
      data: new Uint8Array(0),
      method: 0 as const,
    }));
    expect(() => prepareZipArchive(tooMany)).toThrow(PublishError);
    expect(() => buildZipArchive(tooMany)).toThrow(PublishError);
  });
});
