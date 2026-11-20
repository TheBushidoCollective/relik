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

import { PLAINTEXT_CAP_BYTES } from './limits.ts';
import { ContentTooLargeError, RelicFormatError } from './errors.ts';
import type {
  InflaterFn,
  OtioBundleEntryName,
  OtioMediaEntry,
  OtioZipEntryInfo,
  OtioZipIndex,
} from './otio-types.ts';
import { Sha256, sha256Hex } from './sha256.ts';
import {
  Crc32,
  indexZipForOtio,
  ZipFailure,
  type ZipRefusal,
} from './zip-index.ts';
export { Crc32, crc32 } from './zip-index.ts';

export const MAX_EXPANDED_ZIP_BYTES = PLAINTEXT_CAP_BYTES;
export const MAX_INFLATED_ZIP_BYTES = 100 * 1024 * 1024;
export const OTIO_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_DIRECTORY_BYTES = 16 * 1024 * 1024;
const ZIP_READ_CHUNK_BYTES = 8 * 1024 * 1024;

/** End-exclusive byte ranges in an immutable archive. */
export interface ZipSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/**
 * Two reserved members and ZIP64's unusable count leave 65,532 media entries.
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

const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;
const CD_SIG = 0x02014b50;

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

async function readZipRange(
  source: ZipSource,
  start: number,
  end: number
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.size
  ) {
    throw new OtioZipError(
      'corrupt-archive',
      'ZIP range is outside the archive'
    );
  }
  const bytes = await source.read(start, end);
  if (!(bytes instanceof Uint8Array) || bytes.length !== end - start) {
    throw new OtioZipError(
      'corrupt-archive',
      'ZIP source returned an incomplete range'
    );
  }
  return bytes;
}

/** Inspect ZIP magic and reserved member names without reading media bytes. */
export async function isOtiozSource(source: ZipSource): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(source.size) || source.size < 22) return false;
    const magic = await readZipRange(source, 0, 4);
    if (
      magic[0] !== 0x50 ||
      magic[1] !== 0x4b ||
      magic[2] !== 3 ||
      magic[3] !== 4
    )
      return false;
    const tail = await readZipRange(
      source,
      Math.max(0, source.size - 65557),
      source.size
    );
    const at = findEocdOffset(tail);
    if (at < 0) return false;
    const end = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const count = end.getUint16(at + 10, true);
    const size = end.getUint32(at + 12, true);
    const offset = end.getUint32(at + 16, true);
    if (
      count === ZIP64_U16 ||
      offset === ZIP64_U32 ||
      size > MAX_ZIP_DIRECTORY_BYTES ||
      offset + size > source.size
    )
      return false;
    const directory = await readZipRange(source, offset, offset + size);
    const view = new DataView(
      directory.buffer,
      directory.byteOffset,
      directory.byteLength
    );
    let cursor = 0;
    let content = false;
    let version = false;
    for (let i = 0; i < count && cursor + 46 <= directory.length; i++) {
      if (view.getUint32(cursor, true) !== CD_SIG) break;
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      if (cursor + 46 + nameLength > directory.length) break;
      const name = new TextDecoder().decode(
        directory.subarray(cursor + 46, cursor + 46 + nameLength)
      );
      if (name === 'content.otio') content = true;
      if (name === 'version.txt') version = true;
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return content && version;
  } catch {
    return false;
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
    // Never rejects: the bound or corruption error raised below is the one
    // that must surface, and close() rejects once cancelStream has aborted
    // the writer. Left unhandled, that rejection would terminate a Node host.
    const writeDone = writer
      .write(toDomWritableChunk(compressedData))
      .then(() => writer.close())
      .catch(() => undefined);
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
  archive: Uint8Array | ZipSource,
  options?: {
    readonly maxArchiveBytes?: number;
    readonly maxExpandedBytes?: number;
    readonly maxInflatedBytes?: number;
    readonly inflater?: InflaterFn;
  }
): Promise<OtioZipIndex> {
  const maxLimit = options?.maxExpandedBytes ?? MAX_EXPANDED_ZIP_BYTES;
  const maxArchive =
    options?.maxArchiveBytes ??
    options?.maxExpandedBytes ??
    PLAINTEXT_CAP_BYTES;
  const maxInflated = options?.maxInflatedBytes ?? MAX_INFLATED_ZIP_BYTES;
  const inflater = options?.inflater ?? defaultInflater;
  const isRangeSource = !(archive instanceof Uint8Array);
  const source: ZipSource =
    archive instanceof Uint8Array
      ? {
          size: archive.length,
          async read(start, end) {
            return archive.subarray(start, end);
          },
        }
      : archive;
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    ![maxLimit, maxArchive, maxInflated].every(
      (n) => Number.isSafeInteger(n) && n >= 0
    )
  ) {
    throw new OtioZipError('corrupt-archive', 'Invalid ZIP size or limits');
  }
  if (source.size > maxArchive) {
    throw new ContentTooLargeError(source.size, maxArchive);
  }
  const indexed = await indexZipForOtio(
    archive,
    {
      maxArchiveBytes: maxArchive,
      maxEntries: 0xffff - 1,
      maxEntryBytes: maxLimit,
      maxTotalBytes: maxLimit,
    },
    inflater
  );
  if (!indexed.ok) {
    const unsupported: ZipRefusal['reason'][] = [
      'encrypted',
      'zip64',
      'multi-disk',
      'directory-too-large',
      'unsupported-method',
    ];
    const limited: ZipRefusal['reason'][] = [
      'too-many-entries',
      'entry-too-large',
      'total-too-large',
    ];
    throw new OtioZipError(
      unsupported.includes(indexed.reason)
        ? 'unsupported-zip'
        : limited.includes(indexed.reason)
          ? 'decompression-limit'
          : 'corrupt-archive',
      indexed.message
    );
  }
  const sharedIndex = indexed.index;
  const entries = new Map<string, OtioZipEntryInfo>();
  let aggregateInflated = 0;
  for (const entry of indexed.index.entries.values()) {
    if (entry.kind === 'symlink') {
      throw new OtioZipError(
        'corrupt-archive',
        `Non-regular file type in ZIP entry prohibited: ${entry.rawName}`
      );
    }
    if (entry.method === 8) {
      aggregateInflated += entry.size;
      if (aggregateInflated > maxInflated) {
        throw new OtioZipError(
          'decompression-limit',
          `Aggregate DEFLATE size ${aggregateInflated} exceeds cap of ${maxInflated} bytes`
        );
      }
    }
    if (entry.name === 'content.otio' && entry.size > OTIO_DOCUMENT_MAX_BYTES) {
      throw new OtioZipError(
        'decompression-limit',
        `content.otio exceeds ${OTIO_DOCUMENT_MAX_BYTES} bytes`
      );
    }
    entries.set(entry.name, {
      name: entry.name,
      rawName: entry.rawName,
      method: entry.method,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.size,
      crc32: entry.crc,
      dataOffset: entry.dataOffset,
      isDirectory: entry.isDirectory,
    });
  }

  const successByEntry = new Map<string, Uint8Array>();
  const permanentFailureByEntry = new Map<string, OtioZipError>();
  const inflightByEntry = new Map<string, Promise<Uint8Array>>();
  // Verified digests, one promise per entry for this index. Concurrent callers
  // share a single scan. A transient failure is not remembered.
  const digestByEntry = new Map<string, Promise<string>>();

  async function loadEntry(
    entry: OtioZipEntryInfo,
    customInflater: InflaterFn | undefined
  ): Promise<Uint8Array> {
    if (
      isRangeSource &&
      (entry.uncompressedSize > OTIO_DOCUMENT_MAX_BYTES ||
        entry.compressedSize > OTIO_DOCUMENT_MAX_BYTES)
    ) {
      throw new OtioZipError(
        'decompression-limit',
        `Entry ${entry.name} is too large to materialize`
      );
    }
    try {
      return await sharedIndex.readOtio(entry.name, customInflater);
    } catch (error) {
      if (error instanceof ZipFailure) {
        throw new OtioZipError(
          error.reason === 'entry-too-large'
            ? 'decompression-limit'
            : 'corrupt-archive',
          error.message
        );
      }
      throw error;
    }
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

  async function scanStoredEntry(name: string, hash?: Sha256): Promise<void> {
    const entry = entries.get(name);
    if (!entry) {
      throw new OtioZipError(
        'corrupt-archive',
        `Entry not found in archive: ${name}`
      );
    }
    if (entry.method !== 0) {
      throw new OtioZipError('unsupported-zip', `Entry is not STORED: ${name}`);
    }
    const crc = new Crc32();
    const end = entry.dataOffset + entry.compressedSize;
    for (let at = entry.dataOffset; at < end; at += ZIP_READ_CHUNK_BYTES) {
      const bytes = await readZipRange(
        source,
        at,
        Math.min(at + ZIP_READ_CHUNK_BYTES, end)
      );
      crc.update(bytes);
      hash?.update(bytes);
    }
    const actual = crc.value();
    if (actual !== entry.crc32) {
      throw new OtioZipError(
        'corrupt-archive',
        `CRC32 mismatch on ${entry.name}: expected ${entry.crc32.toString(16)}, got ${actual.toString(16)}`
      );
    }
  }

  async function verifyStoredEntry(name: string): Promise<void> {
    await scanStoredEntry(name);
  }

  async function digestEntry(name: string): Promise<string> {
    const entry = entries.get(name);
    if (!entry) {
      throw new OtioZipError(
        'corrupt-archive',
        `Entry not found in archive: ${name}`
      );
    }
    const key = entry.name;
    const cached = digestByEntry.get(key);
    if (cached) return cached;
    const pending = computeDigest(entry);
    digestByEntry.set(key, pending);
    try {
      return await pending;
    } catch (err) {
      if (
        digestByEntry.get(key) === pending &&
        !isPermanentArchiveFailure(err)
      ) {
        digestByEntry.delete(key);
      }
      throw err;
    }
  }

  async function computeDigest(entry: OtioZipEntryInfo): Promise<string> {
    // STORED media streams through the hash; DEFLATE media is inflated and
    // held by readEntryData under the archive-wide bounds.
    if (entry.method !== 0) return sha256Hex(await readEntryData(entry.name));
    const hash = new Sha256();
    await scanStoredEntry(entry.name, hash);
    return hash.hex();
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

  const contentSha256 = sha256Hex(contentOtioBytes);

  return {
    entries,
    directory: sharedIndex.directory,
    versionText,
    contentOtioBytes,
    contentSha256,
    readEntry: readEntryData,
    verifyStoredEntry,
    digestEntry,
  };
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
    const digest = options?.digests
      ? await zip.digestEntry(entry.name)
      : undefined;
    media[entry.name] = {
      key: entry.name,
      bundle_path: entry.name,
      size: entry.uncompressedSize,
      ...(digest === undefined ? {} : { sha256: digest }),
    };
  }
  return media;
}
