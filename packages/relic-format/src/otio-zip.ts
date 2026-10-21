/**
 * OpenTimelineIO dependency-free ZIP indexer and subtype detector.
 *
 * Implements:
 * - Pure byte-level ZIP EOCD and Central Directory traversal.
 * - Strict security checks: path traversal (..), absolute paths, symlinks,
 *   encrypted entries, duplicate normalized names, decompression caps (<= 100 MiB).
 * - Supported compression methods: 0 (STORED) and 8 (DEFLATE).
 * - Pluggable bounded inflater (node:zlib or DecompressionStream).
 * - Validation of standard .otioz archive layout: content.otio and version.txt (1.0.0).
 */

import { ContentTooLargeError, RelicFormatError } from './errors.ts';
import type {
  InflaterFn,
  OtioZipEntryInfo,
  OtioZipIndex,
} from './otio-types.ts';

export const MAX_EXPANDED_ZIP_BYTES = 100 * 1024 * 1024; // 100 MiB safety limit

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

    let cursor = cdOffset;
    let foundContentOtio = false;
    let foundVersionTxt = false;

    for (let i = 0; i < cdCount && cursor + 46 <= bytes.length; i++) {
      const sig = view.getUint32(cursor, true);
      if (sig !== 0x02014b50) break;

      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);

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
      return i;
    }
  }
  return -1;
}

/**
 * Default environment inflater using DecompressionStream.
 */
async function defaultInflater(
  compressedData: Uint8Array,
  uncompressedSize: number,
  maxBytes: number
): Promise<Uint8Array> {
  if (uncompressedSize > maxBytes) {
    throw new OtioZipError(
      'decompression-limit',
      `Decompressed size ${uncompressedSize} exceeds max limit of ${maxBytes} bytes`
    );
  }

  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compressedData).catch(() => {});
      writer.close().catch(() => {});

      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > maxBytes) {
            throw new OtioZipError(
              'decompression-limit',
              `Streamed decompressed bytes exceeded limit of ${maxBytes}`
            );
          }
          chunks.push(value);
        }
      }

      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch (err) {
      if (err instanceof OtioZipError) throw err;
      throw new OtioZipError(
        'corrupt-archive',
        `Browser DecompressionStream failed: ${String(err)}`
      );
    }
  }

  throw new OtioZipError(
    'unsupported-zip',
    'No DecompressionStream available; caller must supply a custom inflater'
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

  if (diskNumber !== 0 || cdDisk !== 0 || cdRecordsOnDisk !== cdTotalRecords) {
    throw new OtioZipError(
      'unsupported-zip',
      'Multi-disk ZIP archives are not supported'
    );
  }

  if (cdOffset + cdSize > archiveBytes.length) {
    throw new OtioZipError(
      'corrupt-archive',
      'Central directory points beyond end of archive'
    );
  }

  const entries = new Map<string, OtioZipEntryInfo>();
  const normalizedNames = new Set<string>();
  let aggregateUncompressed = 0;
  let cursor = cdOffset;

  for (let i = 0; i < cdTotalRecords; i++) {
    if (cursor + 46 > archiveBytes.length) {
      throw new OtioZipError(
        'corrupt-archive',
        'Truncated central directory entry'
      );
    }

    const sig = view.getUint32(cursor, true);
    if (sig !== 0x02014b50) {
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

    // Check for symlink (Unix mode 0120000)
    const unixMode = extAttr >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new OtioZipError(
        'corrupt-archive',
        'Symlink entries are prohibited'
      );
    }

    const rawNameBytes = archiveBytes.subarray(
      cursor + 46,
      cursor + 46 + nameLen
    );
    const rawName = new TextDecoder('utf-8', { fatal: false }).decode(
      rawNameBytes
    );

    // Validate path security
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
    if (normalizedNames.has(normName)) {
      throw new OtioZipError(
        'corrupt-archive',
        `Duplicate entry name: ${normName}`
      );
    }
    normalizedNames.add(normName);

    aggregateUncompressed += uncompSize;
    if (aggregateUncompressed > maxLimit) {
      throw new OtioZipError(
        'decompression-limit',
        `Aggregate uncompressed size ${aggregateUncompressed} exceeds cap of ${maxLimit} bytes`
      );
    }

    // Verify local file header
    if (localHeaderOffset + 30 > archiveBytes.length) {
      throw new OtioZipError(
        'corrupt-archive',
        'Local header offset beyond archive'
      );
    }
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new OtioZipError(
        'corrupt-archive',
        'Invalid local header signature'
      );
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

    if (dataOffset + compSize > archiveBytes.length) {
      throw new OtioZipError(
        'corrupt-archive',
        'File data extends beyond archive'
      );
    }

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
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  // Validate standard layout
  const versionEntry = entries.get('version.txt');
  if (!versionEntry) {
    throw new OtioZipError(
      'corrupt-archive',
      'Required version.txt missing from .otioz archive'
    );
  }

  const contentEntry = entries.get('content.otio');
  if (!contentEntry) {
    throw new OtioZipError(
      'corrupt-archive',
      'Required content.otio missing from .otioz archive'
    );
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

    const slice = archiveBytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize
    );

    let decompressed: Uint8Array;
    if (entry.method === 0) {
      decompressed = slice;
    } else {
      const inf = customInflater ?? inflater;
      decompressed = await inf(slice, entry.uncompressedSize, maxLimit);
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
        `CRC32 mismatch on ${name}: expected ${entry.crc32.toString(16)}, got ${computedCrc.toString(16)}`
      );
    }

    return decompressed;
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
    contentOtioBytes.slice().buffer as ArrayBuffer
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
