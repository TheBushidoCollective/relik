/**
 * ZIP archives for the document and workbook tests. Entries are written in the
 * order given, each stored or deflated as the entry asks, so a test can build a
 * real XLSX, DOCX or EPUB whose parts are compressed the way Office writes them.
 */

import { deflateRawSync } from 'node:zlib';
import {
  writeZipCentralRecord,
  writeZipEnd,
  writeZipLocalHeader,
  type ZipEntryRecord,
} from '@relic/format';
import { crc32 } from '@relic/format/zip-index';

export interface FixtureEntry {
  readonly name: string;
  readonly text: string;
  readonly deflate?: boolean;
}

export function zipFixture(entries: readonly FixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = entries.map((entry) => {
    const bytes = encoder.encode(entry.text);
    return {
      name: encoder.encode(entry.name),
      bytes,
      packed: entry.deflate === true ? deflateRawSync(bytes) : bytes,
      method: entry.deflate === true ? (8 as const) : (0 as const),
    };
  });
  const records: ZipEntryRecord[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const part of parts) {
    records.push({
      nameBytes: part.name,
      method: part.method,
      crc32: crc32(part.bytes),
      compressedSize: part.packed.length,
      uncompressedSize: part.bytes.length,
      localHeaderOffset: offset,
    });
    offset += 30 + part.name.length + part.packed.length;
    directorySize += 46 + part.name.length;
  }
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  parts.forEach((part, index) => {
    at += writeZipLocalHeader(out, at, records[index]!);
    out.set(part.packed, at);
    at += part.packed.length;
  });
  const directoryOffset = at;
  for (const record of records) at += writeZipCentralRecord(out, at, record);
  writeZipEnd(out, at, {
    entryCount: records.length,
    directorySize,
    directoryOffset,
    comment: new Uint8Array(),
  });
  return out;
}
