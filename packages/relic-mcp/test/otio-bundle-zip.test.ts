import { describe, expect, test } from 'bun:test';
import { crc32 } from '@relic/format';
import { deflateRawSync } from 'node:zlib';
import {
  buildZipArchive,
  MAX_ZIP_ENTRY_COUNT,
  planZipLayout,
  writeZipCentralRecord,
  writeZipEnd,
  writeZipLocalHeader,
  ZIP_END_BYTES,
  ZIP_LOCAL_HEADER_BYTES,
  type ZipEntryRecord,
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

/** The planner's total for these entries, computed from sizes alone. */
function plannedTotal(entries: Entries): number {
  return planZipLayout(
    entries.map((entry) => ({
      name: entry.name,
      nameBytes: ENCODER.encode(entry.name),
      method: entry.method,
      compressedSize:
        entry.method === 8
          ? deflateRawSync(entry.data, { level: 9 }).length
          : entry.data.length,
      uncompressedSize: entry.data.length,
    })),
    Number.MAX_SAFE_INTEGER
  ).totalSize;
}

/** Composes a stored-only archive from the public writers, without buildZipArchive. */
function composeStored(entries: Entries): Uint8Array {
  const nameBytes = entries.map((entry) => ENCODER.encode(entry.name));
  const layout = planZipLayout(
    entries.map((entry, index) => ({
      name: entry.name,
      nameBytes: nameBytes[index]!,
      method: 0 as const,
      compressedSize: entry.data.length,
      uncompressedSize: entry.data.length,
    })),
    Number.MAX_SAFE_INTEGER
  );
  const archive = new Uint8Array(layout.totalSize);
  const records: ZipEntryRecord[] = entries.map((entry, index) => {
    const record: ZipEntryRecord = {
      nameBytes: nameBytes[index]!,
      method: 0,
      crc32: crc32(entry.data),
      compressedSize: entry.data.length,
      uncompressedSize: entry.data.length,
      localHeaderOffset: layout.localHeaderOffsets[index]!,
    };
    writeZipLocalHeader(archive, record.localHeaderOffset, record);
    archive.set(
      entry.data,
      record.localHeaderOffset +
        ZIP_LOCAL_HEADER_BYTES +
        record.nameBytes.length
    );
    return record;
  });
  let cursor = layout.directoryOffset;
  for (const record of records) {
    cursor += writeZipCentralRecord(archive, cursor, record);
  }
  writeZipEnd(archive, cursor, {
    entryCount: records.length,
    directorySize: layout.directorySize,
    directoryOffset: layout.directoryOffset,
    comment: new Uint8Array(0),
  });
  return archive;
}

/** The PublishError code thrown by run, or undefined when it returns. */
function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof PublishError ? error.code : undefined;
  }
  return undefined;
}

describe('ZIP layout and writers', () => {
  for (const [label, entries] of Object.entries(SETS)) {
    test(`${label}: the planned total equals the built archive size`, () => {
      expect(plannedTotal(entries)).toBe(buildZipArchive(entries).length);
    });

    test(`${label}: buildZipArchive is deterministic`, () => {
      expect(buildZipArchive(entries)).toEqual(buildZipArchive(entries));
    });
  }

  for (const label of ['storedOnly', 'unicodeName'] as const) {
    test(`${label}: the public writers compose the same bytes as buildZipArchive`, () => {
      expect(composeStored(SETS[label]!)).toEqual(
        buildZipArchive(SETS[label]!)
      );
    });
  }

  test('the local header reports its name length and marks the name UTF-8', () => {
    const name = ENCODER.encode('media/café.mov');
    const target = new Uint8Array(ZIP_LOCAL_HEADER_BYTES + name.length);
    const written = writeZipLocalHeader(target, 0, {
      nameBytes: name,
      method: 0,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      localHeaderOffset: 0,
    });
    const view = new DataView(target.buffer);
    expect(written).toBe(ZIP_LOCAL_HEADER_BYTES + name.length);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(target.slice(ZIP_LOCAL_HEADER_BYTES)).toEqual(name);
  });

  test('the end record writes its comment and reports the bytes it wrote', () => {
    const comment = ENCODER.encode('hello');
    const target = new Uint8Array(ZIP_END_BYTES + comment.length);
    const written = writeZipEnd(target, 0, {
      entryCount: 3,
      directorySize: 7,
      directoryOffset: 11,
      comment,
    });
    const view = new DataView(target.buffer);
    expect(written).toBe(ZIP_END_BYTES + comment.length);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
    expect(view.getUint16(8, true)).toBe(3);
    expect(view.getUint16(10, true)).toBe(3);
    expect(view.getUint32(12, true)).toBe(7);
    expect(view.getUint32(16, true)).toBe(11);
    expect(view.getUint16(20, true)).toBe(comment.length);
    expect(target.slice(ZIP_END_BYTES)).toEqual(comment);
  });

  test('the exact size is accepted and one byte less is refused by both paths', () => {
    const entries = SETS['mixed']!;
    const size = plannedTotal(entries);
    expect(
      planZipLayout(
        entries.map((entry) => ({
          name: entry.name,
          nameBytes: ENCODER.encode(entry.name),
          method: entry.method,
          compressedSize:
            entry.method === 8
              ? deflateRawSync(entry.data, { level: 9 }).length
              : entry.data.length,
          uncompressedSize: entry.data.length,
        })),
        size
      ).totalSize
    ).toBe(size);
    expect(buildZipArchive(entries, size).length).toBe(size);

    expect(
      refusalCode(() =>
        planZipLayout(
          entries.map((entry) => ({
            name: entry.name,
            nameBytes: ENCODER.encode(entry.name),
            method: entry.method,
            compressedSize:
              entry.method === 8
                ? deflateRawSync(entry.data, { level: 9 }).length
                : entry.data.length,
            uncompressedSize: entry.data.length,
          })),
          size - 1
        )
      )
    ).toBe('local_size_precheck_failed');
    expect(refusalCode(() => buildZipArchive(entries, size - 1))).toBe(
      'local_size_precheck_failed'
    );
  });

  test('too many entries is refused by the planner and by build alike', () => {
    const tooMany: Entries = Array.from(
      { length: MAX_ZIP_ENTRY_COUNT },
      (_, i) => ({
        name: `m/${i}`,
        data: new Uint8Array(0),
        method: 0 as const,
      })
    );
    expect(
      refusalCode(() =>
        planZipLayout(
          tooMany.map((entry) => ({
            name: entry.name,
            nameBytes: ENCODER.encode(entry.name),
            method: entry.method,
            compressedSize: 0,
            uncompressedSize: 0,
          })),
          Number.MAX_SAFE_INTEGER
        )
      )
    ).toBe('otio_bundle_invalid');
    expect(refusalCode(() => buildZipArchive(tooMany))).toBe(
      'otio_bundle_invalid'
    );
  });
});
