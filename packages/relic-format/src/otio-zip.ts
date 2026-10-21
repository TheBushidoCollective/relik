/**
 * OpenTimelineIO dependency-free ZIP indexer and subtype detector.
 *
 * Implements:
 * - Pure byte-level ZIP EOCD and Central Directory traversal.
 * - Strict security checks: path traversal (..), absolute paths, symlinks,
 *   encrypted entries, duplicate normalized names, ZIP64 sentinels, exact
 *   central-directory census, entry overlap, decompression caps (<= 100 MiB).
 * - Supported compression methods: 0 (STORED) and 8 (DEFLATE).
 * - Pluggable bounded inflater (node:zlib or DecompressionStream).
 * - Validation of standard .otioz archive layout: content.otio and version.txt (1.0.0).
 */

import { ContentTooLargeError, RelicFormatError } from './errors.ts';
import type {
  InflaterFn,
  OtioBundleEntryName,
  OtioMediaEntry,
  OtioZipEntryInfo,
  OtioZipIndex,
} from './otio-types.ts';

export const MAX_EXPANDED_ZIP_BYTES = 100 * 1024 * 1024; // 100 MiB safety limit

/**
 * Standard OTIOZ reserves three ZIP entries for `content.otio`,
 * `version.txt`, and the end-of-central-directory sentinel.
 */
export const MAX_OTIO_BUNDLE_MEDIA_ENTRIES = 0xffff - 3;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Normalizes a relative OTIO media reference into the one path model used by
 * packing, playback, and continuity hashing.
 */
export function sanitizeOtioBundlePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim().length === 0) {
    throw new Error('Empty media reference path');
  }
  if (hasControlCharacter(raw)) {
    throw new Error(`Control character in media reference path: ${raw}`);
  }

  let path = raw.trim();
  const suffixStart = path.search(/[?#]/);
  if (suffixStart >= 0) path = path.slice(0, suffixStart);
  if (path.length === 0) throw new Error('Empty media reference path');

  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(path);
  if (scheme) {
    if (scheme[0].toLowerCase() !== 'file:') {
      throw new Error(`Prohibited URL scheme in media reference path: ${raw}`);
    }
    path = path.slice(scheme[0].length);
    if (path.startsWith('/') || path.startsWith('\\')) {
      throw new Error(`Absolute path in media reference: ${raw}`);
    }
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error(
      `Malformed percent-encoding in media reference path: ${raw}`
    );
  }
  if (hasControlCharacter(path)) {
    throw new Error(`Control character in media reference path: ${raw}`);
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Absolute path in media reference: ${raw}`);
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new Error(`Prohibited URL scheme in media reference path: ${raw}`);
  }

  const segments: string[] = [];
  for (const segment of path.split(/[/\\]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new Error(`Path traversal in media reference: ${raw}`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error('Empty media reference path');
  return segments.join('/');
}

/** Converts an already-sanitized reference path into its OTIOZ entry name. */
export function otioBundleEntryName(relativePath: string): OtioBundleEntryName {
  return (
    relativePath.startsWith('media/') ? relativePath : `media/${relativePath}`
  ) as OtioBundleEntryName;
}

/** Returns the canonical archive entry for a reference, or null on refusal. */
export function otioBundleEntry(reference: string): OtioBundleEntryName | null {
  try {
    return otioBundleEntryName(sanitizeOtioBundlePath(reference));
  } catch {
    return null;
  }
}

/**
 * Resolves a reference only when its canonical archive entry exists in the
 * caller's index.
 */
export function otioBundleEntryFor(
  reference: string,
  isEntry: (name: OtioBundleEntryName) => boolean
): OtioBundleEntryName | null {
  const entry = otioBundleEntry(reference);
  return entry !== null && isEntry(entry) ? entry : null;
}
const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class OtioZipError extends RelicFormatError {
  override readonly name = 'OtioZipError';
  constructor(
    readonly code:
      | 'corrupt-archive'
      | 'unsupported-zip'
      | 'decompression-limit',
    message: string
  ) {
    super(message);
  }
}

/** Standard CRC32 table and computation. */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Fast synchronous check whether raw bytes represent an OTIOZ archive.
 * Looks for ZIP magic and central directory entries containing content.otio.
 */
export function isOtioz(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  // Check ZIP signature PK\x03\x04
  if (
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return false;
  }

  try {
    const eocdOffset = findEocdOffset(bytes);
    if (eocdOffset < 0) return false;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdCount = view.getUint16(eocdOffset + 10, true);
    if (
      cdOffset === ZIP64_U32 ||
      cdCount === ZIP64_U16 ||
      cdOffset > bytes.length
    ) {
      return false;
    }

    let cursor = cdOffset;
    let foundContentOtio = false;
    let foundVersionTxt = false;

    for (let i = 0; i < cdCount && cursor + 46 <= bytes.length; i++) {
      const sig = view.getUint32(cursor, true);
      if (sig !== CD_SIG) break;

      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      if (cursor + 46 + nameLen > bytes.length) break;

      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
      const name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);

      if (name === 'content.otio') foundContentOtio = true;
      if (name === 'version.txt') foundVersionTxt = true;

      cursor += 46 + nameLen + extraLen + commentLen;
    }

    return foundContentOtio && foundVersionTxt;
  } catch {
    return false;
  }
}

/**
 * Fast synchronous check whether raw bytes represent an uncompressed OTIO JSON document.
 */
export function isRawOtio(bytes: Uint8Array): boolean {
  if (bytes.length < 15) return false;
  const headLimit = Math.min(bytes.length, 1024);
  const head = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, headLimit)
  );
  const trimmed = head.trimStart();
  if (!trimmed.startsWith('{')) return false;
  return (
    head.includes('"OTIO_SCHEMA"') ||
    head.includes('"Timeline.') ||
    head.includes('"SerializableCollection.')
  );
}

function findEocdOffset(bytes: Uint8Array): number {
  if (bytes.length < 22) return -1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxSearch = Math.min(bytes.length, 65535 + 22);
  const start = bytes.length - 22;
  const end = bytes.length - maxSearch;

  for (let i = start; i >= end && i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === bytes.length) return i;
    }
  }
  return -1;
}

function decodeZipName(bytes: Uint8Array, where: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OtioZipError(
      'corrupt-archive',
      `ZIP entry name is not valid UTF-8 in ${where}`
    );
  }
}

function assertNoZip64Extra(extra: Uint8Array, label: string): void {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = (extra[i] as number) | ((extra[i + 1] as number) << 8);
    const size = (extra[i + 2] as number) | ((extra[i + 3] as number) << 8);
    const next = i + 4 + size;
    if (next > extra.length) {
      throw new OtioZipError(
        'corrupt-archive',
        `Truncated extra field: ${label}`
      );
    }
    if (id === ZIP64_EXTRA_ID) {
      throw new OtioZipError(
        'unsupported-zip',
        `ZIP64 extended information is not supported: ${label}`
      );
    }
    i = next;
  }
  if (i !== extra.length) {
    throw new OtioZipError(
      'corrupt-archive',
      `Truncated extra field: ${label}`
    );
  }
}

function assertSafeZipPath(rawName: string): string {
  if (rawName.includes('\0')) {
    throw new OtioZipError(
      'corrupt-archive',
      'NUL in ZIP entry name prohibited'
    );
  }
  if (
    rawName.startsWith('/') ||
    rawName.startsWith('\\') ||
    /^[a-zA-Z]:/.test(rawName)
  ) {
    throw new OtioZipError(
      'corrupt-archive',
      `Absolute paths in archive prohibited: ${rawName}`
    );
  }
  const parts = rawName.split(/[/\\]/);
  if (parts.includes('..')) {
    throw new OtioZipError(
      'corrupt-archive',
      `Path traversal (..) prohibited: ${rawName}`
    );
  }
  const normName = parts.filter((p) => p !== '' && p !== '.').join('/');
  if (normName === '') {
    throw new OtioZipError(
      'corrupt-archive',
      `Invalid ZIP entry path: ${rawName}`
    );
  }
  return normName;
}

function rejectZip64Sentinel(
  value: number,
  sentinel: number,
  field: string
): void {
  if (value === sentinel) {
    throw new OtioZipError(
      'unsupported-zip',
      `ZIP64 sentinel ${field} is not supported`
    );
  }
}

function isArrayBufferBacked(
  bytes: Uint8Array
): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

function toDomWritableChunk(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (isArrayBufferBacked(bytes)) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Default environment inflater using DecompressionStream.
 * `maxBytes` is the caller's hard output cap. Overflow cancels the stream
 * before the overflowing chunk is retained or the result buffer is allocated.
 */
async function defaultInflater(
  compressedData: Uint8Array,
  uncompressedSize: number,
  maxBytes: number
): Promise<Uint8Array> {
  if (
    !Number.isFinite(uncompressedSize) ||
    uncompressedSize < 0 ||
    !Number.isFinite(maxBytes) ||
    maxBytes < 0
  ) {
    throw new OtioZipError('corrupt-archive', 'Invalid inflation bounds');
  }
  if (uncompressedSize > maxBytes) {
    throw new OtioZipError(
      'decompression-limit',
      `Decompressed size ${uncompressedSize} exceeds max limit of ${maxBytes} bytes`
    );
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new OtioZipError(
      'unsupported-zip',
      'No DecompressionStream available; caller must supply a custom inflater'
    );
  }

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let settled = false;
  const cancelStream = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await reader.cancel();
    } catch {
      // The bound or corruption error is the one that must surface.
    }
    try {
      await writer.abort();
    } catch {
      // Writer may already be closed.
    }
  };

  try {
    const writeDone = writer.write(toDomWritableChunk(compressedData)).then(
      () => writer.close(),
      () => undefined
    );
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (total > maxBytes - value.length) {
        await cancelStream();
        throw new OtioZipError(
          'decompression-limit',
          `Streamed decompressed bytes exceeded limit of ${maxBytes}`
        );
      }
      chunks.push(value);
      total += value.length;
    }
    await writeDone.catch(() => undefined);
    if (total > maxBytes) {
      await cancelStream();
      throw new OtioZipError(
        'decompression-limit',
        `Streamed decompressed bytes exceeded limit of ${maxBytes}`
      );
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    settled = true;
    return result;
  } catch (err) {
    await cancelStream();
    if (err instanceof OtioZipError) throw err;
    throw new OtioZipError(
      'corrupt-archive',
      `Browser DecompressionStream failed: ${String(err)}`
    );
  }
}

function isPermanentArchiveFailure(err: unknown): err is OtioZipError {
  return (
    err instanceof OtioZipError &&
    (err.code === 'corrupt-archive' || err.code === 'decompression-limit')
  );
}

/**
 * Parse and index an OTIOZ ZIP archive.
 */
export async function indexOtioZip(
  archiveBytes: Uint8Array,
  options?: {
    readonly maxExpandedBytes?: number;
    readonly inflater?: InflaterFn;
  }
): Promise<OtioZipIndex> {
  const maxLimit = options?.maxExpandedBytes ?? MAX_EXPANDED_ZIP_BYTES;
  const inflater = options?.inflater ?? defaultInflater;

  if (archiveBytes.length > maxLimit) {
    throw new ContentTooLargeError(archiveBytes.length, maxLimit);
  }

  const eocdOffset = findEocdOffset(archiveBytes);
  if (eocdOffset < 0) {
    throw new OtioZipError(
      'corrupt-archive',
      'End of Central Directory record not found'
    );
  }

  const view = new DataView(
    archiveBytes.buffer,
    archiveBytes.byteOffset,
    archiveBytes.byteLength
  );

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdDisk = view.getUint16(eocdOffset + 6, true);
  const cdRecordsOnDisk = view.getUint16(eocdOffset + 8, true);
  const cdTotalRecords = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const eocdSig = view.getUint32(eocdOffset, true);
  if (eocdSig !== EOCD_SIG) {
    throw new OtioZipError(
      'corrupt-archive',
      'End of Central Directory record not found'
    );
  }

  // 0xFFFF / 0xFFFFFFFF are ZIP64 sentinels, not limits. Reject before any
  // count, size, or offset is used as a bound. A uint16 entry count of 65535
  // is the sentinel; the publisher owns any lower entry-count policy.
  if (
    diskNumber === ZIP64_U16 ||
    cdDisk === ZIP64_U16 ||
    cdRecordsOnDisk === ZIP64_U16 ||
    cdTotalRecords === ZIP64_U16 ||
    cdSize === ZIP64_U32 ||
    cdOffset === ZIP64_U32
  ) {
    throw new OtioZipError(
      'unsupported-zip',
      'ZIP64 sentinel in the end of central directory is not supported'
    );
  }

  if (diskNumber !== 0 || cdDisk !== 0 || cdRecordsOnDisk !== cdTotalRecords) {
    throw new OtioZipError(
      'unsupported-zip',
      'Multi-disk ZIP archives are not supported'
    );
  }

  if (
    cdOffset > archiveBytes.length ||
    cdSize > archiveBytes.length - cdOffset
  ) {
    throw new OtioZipError(
      'corrupt-archive',
      'Central directory points beyond end of archive'
    );
  }
  if (
    eocdOffset >= 20 &&
    cdOffset + cdSize === eocdOffset - 20 &&
    view.getUint32(eocdOffset - 20, true) === ZIP64_EOCD_LOCATOR
  ) {
    throw new OtioZipError(
      'unsupported-zip',
      'ZIP64 end of central directory locator is not supported'
    );
  }
  if (cdOffset + cdSize !== eocdOffset) {
    throw new OtioZipError(
      'corrupt-archive',
      'Central directory extent does not end at the end of central directory record'
    );
  }

  const entries = new Map<string, OtioZipEntryInfo>();
  const normalizedNames = new Set<string>();
  const extents: Array<{ start: number; end: number; name: string }> = [];
  let aggregateUncompressed = 0;
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let i = 0; i < cdTotalRecords; i++) {
    if (cursor + 46 > cdEnd) {
      throw new OtioZipError(
        'corrupt-archive',
        'Truncated central directory entry'
      );
    }

    const sig = view.getUint32(cursor, true);
    if (sig !== CD_SIG) {
      throw new OtioZipError(
        'corrupt-archive',
        `Invalid central directory signature at ${cursor}`
      );
    }

    const flags = view.getUint16(cursor + 8, true);
    if (flags & 0x0001) {
      throw new OtioZipError(
        'unsupported-zip',
        'Encrypted ZIP entries are strictly prohibited'
      );
    }

    const method = view.getUint16(cursor + 10, true);
    if (method !== 0 && method !== 8) {
      throw new OtioZipError(
        'unsupported-zip',
        `Unsupported compression method: ${method} (only 0 STORED and 8 DEFLATE allowed)`
      );
    }

    const crcVal = view.getUint32(cursor + 16, true);
    const compSize = view.getUint32(cursor + 20, true);
    const uncompSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const extAttr = view.getUint32(cursor + 38, true);
    const entryEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (entryEnd > cdEnd) {
      throw new OtioZipError(
        'corrupt-archive',
        'Central directory entry extends past declared extent'
      );
    }

    rejectZip64Sentinel(compSize, ZIP64_U32, 'compressed size');
    rejectZip64Sentinel(uncompSize, ZIP64_U32, 'uncompressed size');
    rejectZip64Sentinel(localHeaderOffset, ZIP64_U32, 'local header offset');

    const rawNameBytes = archiveBytes.subarray(
      cursor + 46,
      cursor + 46 + nameLen
    );
    const rawName = decodeZipName(rawNameBytes, 'central directory');
    const extraStart = cursor + 46 + nameLen;
    assertNoZip64Extra(
      archiveBytes.subarray(extraStart, extraStart + extraLen),
      rawName
    );

    // Filename is decoded before this check. A symlink must be OtioZipError,
    // never a ReferenceError from using the name too early.
    const unixMode = extAttr >>> 16;
    if (unixMode !== 0) {
      const fileType = unixMode & 0o170000;
      if (fileType !== 0o100000 && fileType !== 0o040000) {
        throw new OtioZipError(
          'corrupt-archive',
          `Non-regular file type in ZIP entry prohibited: ${rawName}`
        );
      }
    }

    const normName = assertSafeZipPath(rawName);
    if (normalizedNames.has(normName)) {
      throw new OtioZipError(
        'corrupt-archive',
        `Duplicate entry name: ${normName}`
      );
    }
    normalizedNames.add(normName);

    if (method === 0 && compSize !== uncompSize) {
      throw new OtioZipError(
        'corrupt-archive',
        `STORED entry sizes disagree: ${rawName}`
      );
    }

    aggregateUncompressed += uncompSize;
    if (aggregateUncompressed > maxLimit) {
      throw new OtioZipError(
        'decompression-limit',
        `Aggregate uncompressed size ${aggregateUncompressed} exceeds cap of ${maxLimit} bytes`
      );
    }

    if (
      localHeaderOffset + 30 > archiveBytes.length ||
      localHeaderOffset >= cdOffset
    ) {
      throw new OtioZipError(
        'corrupt-archive',
        'Local header offset beyond archive'
      );
    }
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== LOCAL_SIG) {
      throw new OtioZipError(
        'corrupt-archive',
        'Invalid local header signature'
      );
    }

    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    const localCrc = view.getUint32(localHeaderOffset + 14, true);
    const localCompSize = view.getUint32(localHeaderOffset + 18, true);
    const localUncompSize = view.getUint32(localHeaderOffset + 22, true);
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);

    rejectZip64Sentinel(localCompSize, ZIP64_U32, 'local compressed size');
    rejectZip64Sentinel(localUncompSize, ZIP64_U32, 'local uncompressed size');

    if (localMethod !== method) {
      throw new OtioZipError(
        'corrupt-archive',
        `Mismatched compression method in local header: ${rawName}`
      );
    }
    if ((localFlags & 0x0008) === 0) {
      if (localCrc !== crcVal) {
        throw new OtioZipError(
          'corrupt-archive',
          `Mismatched CRC in local header: ${rawName}`
        );
      }
      if (localCompSize !== compSize) {
        throw new OtioZipError(
          'corrupt-archive',
          `Mismatched compressed size in local header: ${rawName}`
        );
      }
      if (localUncompSize !== uncompSize) {
        throw new OtioZipError(
          'corrupt-archive',
          `Mismatched uncompressed size in local header: ${rawName}`
        );
      }
    }

    if (localHeaderOffset + 30 + localNameLen > archiveBytes.length) {
      throw new OtioZipError(
        'corrupt-archive',
        `Local header name extends beyond archive: ${rawName}`
      );
    }
    const localNameBytes = archiveBytes.subarray(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localNameLen
    );
    const localName = decodeZipName(localNameBytes, 'local header');
    if (localName !== rawName) {
      throw new OtioZipError(
        'corrupt-archive',
        `Local and central directory filenames disagree: ${rawName}`
      );
    }

    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (
      dataOffset < localHeaderOffset + 30 ||
      dataOffset > archiveBytes.length ||
      compSize > archiveBytes.length - dataOffset
    ) {
      throw new OtioZipError(
        'corrupt-archive',
        `File data extends beyond archive: ${rawName}`
      );
    }
    const localExtra = archiveBytes.subarray(
      localHeaderOffset + 30 + localNameLen,
      dataOffset
    );
    assertNoZip64Extra(localExtra, rawName);

    const dataEnd = dataOffset + compSize;
    if (dataEnd > cdOffset) {
      throw new OtioZipError(
        'corrupt-archive',
        `File data overlaps central directory: ${rawName}`
      );
    }
    extents.push({ start: localHeaderOffset, end: dataEnd, name: rawName });

    const isDir = rawName.endsWith('/') || rawName.endsWith('\\');

    const entryInfo: OtioZipEntryInfo = {
      name: normName,
      method,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      crc32: crcVal,
      dataOffset,
      isDirectory: isDir,
    };

    entries.set(normName, entryInfo);
    cursor = entryEnd;
  }

  // A wrapped uint16 count (65538 entries stored as 2) leaves the rest of
  // the central directory unconsumed. The declared extent must be exactly
  // the entries the EOCD counted. No second runtime byte counter lives here.
  if (cursor !== cdEnd) {
    throw new OtioZipError(
      'corrupt-archive',
      'Central directory census did not consume the declared extent'
    );
  }

  // A single sort keeps extent validation bounded for every accepted
  // non-ZIP64 entry count, including a 65,534-entry archive.
  extents.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < extents.length; i++) {
    const previous = extents[i - 1]!;
    const current = extents[i]!;
    if (current.start < previous.end) {
      throw new OtioZipError(
        'corrupt-archive',
        `ZIP entries overlap: ${current.name}`
      );
    }
  }

  const successByEntry = new Map<string, Uint8Array>();
  const permanentFailureByEntry = new Map<string, OtioZipError>();
  const inflightByEntry = new Map<string, Promise<Uint8Array>>();

  async function loadEntry(
    entry: OtioZipEntryInfo,
    customInflater: InflaterFn | undefined
  ): Promise<Uint8Array> {
    if (
      entry.dataOffset > archiveBytes.length ||
      entry.compressedSize > archiveBytes.length - entry.dataOffset
    ) {
      throw new OtioZipError(
        'corrupt-archive',
        `Entry data is outside the archive: ${entry.name}`
      );
    }
    const slice = archiveBytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize
    );

    let decompressed: Uint8Array;
    if (entry.method === 0) {
      if (slice.length !== entry.uncompressedSize) {
        throw new OtioZipError(
          'corrupt-archive',
          `STORED length ${slice.length} does not match expected ${entry.uncompressedSize}`
        );
      }
      decompressed = slice;
    } else {
      const inf = customInflater ?? inflater;
      // Declared expanded size is the inflater cap. The index already
      // bounded the sum of declarations, so no second aggregate counter
      // is kept on the read path.
      const produced = await inf(
        slice,
        entry.uncompressedSize,
        entry.uncompressedSize
      );
      decompressed = produced;
    }

    if (decompressed.length !== entry.uncompressedSize) {
      throw new OtioZipError(
        'corrupt-archive',
        `Decompressed length ${decompressed.length} does not match expected ${entry.uncompressedSize}`
      );
    }

    const computedCrc = crc32(decompressed);
    if (computedCrc !== entry.crc32) {
      throw new OtioZipError(
        'corrupt-archive',
        `CRC32 mismatch on ${entry.name}: expected ${entry.crc32.toString(16)}, got ${computedCrc.toString(16)}`
      );
    }

    return decompressed;
  }

  async function readEntryData(
    name: string,
    customInflater?: InflaterFn
  ): Promise<Uint8Array> {
    const entry = entries.get(name);
    if (!entry) {
      throw new OtioZipError(
        'corrupt-archive',
        `Entry not found in archive: ${name}`
      );
    }
    const key = entry.name;
    const cached = successByEntry.get(key);
    if (cached) return cached;
    const failed = permanentFailureByEntry.get(key);
    if (failed) throw failed;
    const pending = inflightByEntry.get(key);
    if (pending) return pending;

    const promise = loadEntry(entry, customInflater);
    inflightByEntry.set(key, promise);
    try {
      const bytes = await promise;
      successByEntry.set(key, bytes);
      return bytes;
    } catch (err) {
      if (isPermanentArchiveFailure(err)) {
        permanentFailureByEntry.set(key, err);
      }
      throw err;
    } finally {
      inflightByEntry.delete(key);
    }
  }

  // Read and verify version.txt
  const versionBytes = await readEntryData('version.txt');
  const versionText = new TextDecoder('utf-8').decode(versionBytes).trim();
  if (versionText !== '1.0.0') {
    throw new OtioZipError(
      'corrupt-archive',
      `Invalid version.txt content: ${versionText} (expected 1.0.0)`
    );
  }

  // Read content.otio bytes
  const contentOtioBytes = await readEntryData('content.otio');

  // Compute content sha256
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    digestInput(contentOtioBytes)
  );
  const contentSha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    entries,
    versionText,
    contentOtioBytes,
    contentSha256,
    readEntry: readEntryData,
  };
}

function digestInput(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (isArrayBufferBacked(bytes)) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', digestInput(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Materializes the regular archive entries beneath `media/` in lexical order.
 * Digest reads stay sequential so an archive cannot fan out decompression or
 * hashing work beyond the ZIP indexer's existing byte limits.
 */
export async function otioBundleMediaIndex(
  zip: OtioZipIndex,
  options?: { readonly digests?: boolean }
): Promise<Record<string, OtioMediaEntry>> {
  const media = Object.create(null) as Record<string, OtioMediaEntry>;
  const entries = [...zip.entries.values()]
    .filter((entry) => entry.name.startsWith('media/') && !entry.isDirectory)
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
  for (const entry of entries) {
    const bytes = options?.digests
      ? await zip.readEntry(entry.name)
      : undefined;
    media[entry.name] = {
      key: entry.name,
      bundle_path: entry.name,
      size: entry.uncompressedSize,
      ...(bytes === undefined ? {} : { sha256: await sha256Hex(bytes) }),
    };
  }
  return media;
}
