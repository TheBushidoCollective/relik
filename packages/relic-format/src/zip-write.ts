import { StrictParseError } from './errors.ts';

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
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(12, 33, true);
    lv.setUint32(14, entry.crc32, true);
    lv.setUint32(18, entry.size, true);
    lv.setUint32(22, entry.size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, entry.crc32, true);
    cv.setUint32(20, entry.size, true);
    cv.setUint32(24, entry.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
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
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  return {
    localHeaders,
    centralDirectory,
    end,
    totalBytes: offset + directorySize + end.length,
  };
}
