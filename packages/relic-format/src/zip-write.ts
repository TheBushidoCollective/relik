import { StrictParseError } from './errors.ts';

const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_BYTES = 22;
const ZIP_UTF8_FILENAME_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_MADE_BY = 0x0014;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021;
/** One entry's header fields, as the writers below serialise them. */
export interface ZipEntryRecord {
  readonly nameBytes: Uint8Array;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function zipView(target: Uint8Array): DataView {
  return new DataView(target.buffer, target.byteOffset, target.byteLength);
}

/** Writes a local file header and its name at `at`. Returns the bytes written. */
export function writeZipLocalHeader(
  target: Uint8Array,
  at: number,
  e: ZipEntryRecord
): number {
  const view = zipView(target);
  view.setUint32(at + 0, 0x04034b50, true);
  view.setUint16(at + 4, ZIP_VERSION, true);
  view.setUint16(at + 6, ZIP_UTF8_FILENAME_FLAG, true);
  view.setUint16(at + 8, e.method, true);
  view.setUint16(at + 10, ZIP_DOS_TIME, true);
  view.setUint16(at + 12, ZIP_DOS_DATE, true);
  view.setUint32(at + 14, e.crc32, true);
  view.setUint32(at + 18, e.compressedSize, true);
  view.setUint32(at + 22, e.uncompressedSize, true);
  view.setUint16(at + 26, e.nameBytes.length, true);
  view.setUint16(at + 28, 0, true);
  target.set(e.nameBytes, at + ZIP_LOCAL_HEADER_BYTES);
  return ZIP_LOCAL_HEADER_BYTES + e.nameBytes.length;
}

/** Writes a central directory record at `at`. Returns the bytes written. */
export function writeZipCentralRecord(
  target: Uint8Array,
  at: number,
  e: ZipEntryRecord
): number {
  const view = zipView(target);
  view.setUint32(at + 0, 0x02014b50, true);
  view.setUint16(at + 4, ZIP_MADE_BY, true);
  view.setUint16(at + 6, ZIP_VERSION, true);
  view.setUint16(at + 8, ZIP_UTF8_FILENAME_FLAG, true);
  view.setUint16(at + 10, e.method, true);
  view.setUint16(at + 12, ZIP_DOS_TIME, true);
  view.setUint16(at + 14, ZIP_DOS_DATE, true);
  view.setUint32(at + 16, e.crc32, true);
  view.setUint32(at + 20, e.compressedSize, true);
  view.setUint32(at + 24, e.uncompressedSize, true);
  view.setUint16(at + 28, e.nameBytes.length, true);
  view.setUint16(at + 30, 0, true);
  view.setUint16(at + 32, 0, true);
  view.setUint16(at + 34, 0, true);
  view.setUint16(at + 36, 0, true);
  view.setUint32(at + 38, 0, true);
  view.setUint32(at + 42, e.localHeaderOffset, true);
  target.set(e.nameBytes, at + ZIP_CENTRAL_HEADER_BYTES);
  return ZIP_CENTRAL_HEADER_BYTES + e.nameBytes.length;
}

/** Writes the end-of-central-directory record at `at`. Returns the bytes written. */
export function writeZipEnd(
  target: Uint8Array,
  at: number,
  end: {
    readonly entryCount: number;
    readonly directorySize: number;
    readonly directoryOffset: number;
    readonly comment: Uint8Array;
  }
): number {
  const view = zipView(target);
  view.setUint32(at + 0, 0x06054b50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, end.entryCount, true);
  view.setUint16(at + 10, end.entryCount, true);
  view.setUint32(at + 12, end.directorySize, true);
  view.setUint32(at + 16, end.directoryOffset, true);
  view.setUint16(at + 20, end.comment.length, true);
  target.set(end.comment, at + ZIP_END_BYTES);
  return ZIP_END_BYTES + end.comment.length;
}

export interface StoredZipEntry {
  readonly name: string;
  readonly size: number;
  readonly crc32: number;
}
export interface StoredZipLayout {
  readonly localHeaders: readonly Uint8Array[];
  readonly centralDirectory: Uint8Array;
  readonly end: Uint8Array;
  readonly totalBytes: number;
}

/** Plan an uncompressed ZIP32 archive without allocating the entry bodies. */
export function planStoredZip(
  entries: readonly StoredZipEntry[]
): StoredZipLayout {
  if (entries.length > 65535)
    throw new StrictParseError('ZIP entry count exceeds ZIP32');
  const encoder = new TextEncoder();
  const localHeaders: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (
      name.length > 65535 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 0xffffffff ||
      !Number.isInteger(entry.crc32) ||
      entry.crc32 < 0 ||
      entry.crc32 > 0xffffffff
    )
      throw new StrictParseError('invalid ZIP entry');
    const record: ZipEntryRecord = {
      nameBytes: name,
      method: 0,
      crc32: entry.crc32,
      compressedSize: entry.size,
      uncompressedSize: entry.size,
      localHeaderOffset: offset,
    };
    const local = new Uint8Array(ZIP_LOCAL_HEADER_BYTES + name.length);
    writeZipLocalHeader(local, 0, record);
    const central = new Uint8Array(ZIP_CENTRAL_HEADER_BYTES + name.length);
    writeZipCentralRecord(central, 0, record);
    localHeaders.push(local);
    records.push(central);
    offset += local.length + entry.size;
    directorySize += central.length;
    if (
      offset > 0xffffffff ||
      directorySize > 0xffffffff ||
      offset + directorySize + 22 > 0xffffffff
    )
      throw new StrictParseError('ZIP archive exceeds ZIP32');
  }
  const centralDirectory = new Uint8Array(directorySize);
  let cursor = 0;
  for (const record of records) {
    centralDirectory.set(record, cursor);
    cursor += record.length;
  }
  const end = new Uint8Array(ZIP_END_BYTES);
  writeZipEnd(end, 0, {
    entryCount: entries.length,
    directorySize,
    directoryOffset: offset,
    comment: new Uint8Array(0),
  });
  return {
    localHeaders,
    centralDirectory,
    end,
    totalBytes: offset + directorySize + end.length,
  };
}
