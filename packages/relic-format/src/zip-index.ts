/**
 * General ZIP index contract: indexZip returns {ok:true,index} or a named
 * refusal; index.read returns {ok:true,bytes} or the same refusal shape.
 * Entries describe files, directories and symlinks; only files can be read.
 */
import type { InflaterFn } from './otio-types.ts';

export interface ZipSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}
export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}
export type ZipRefusalReason =
  | 'encrypted'
  | 'zip64'
  | 'multi-disk'
  | 'duplicate'
  | 'unsafe-name'
  | 'bad-name-encoding'
  | 'too-many-entries'
  | 'directory-too-large'
  | 'entry-too-large'
  | 'total-too-large'
  | 'crc-mismatch'
  | 'size-mismatch'
  | 'unsupported-method'
  | 'not-a-file'
  | 'corrupt';
export interface ZipRefusal {
  readonly ok: false;
  readonly reason: ZipRefusalReason;
  readonly message: string;
}
export interface ZipEntryInfo {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly size: number;
  readonly encrypted: boolean;
}
export interface ZipIndex {
  readonly entries: ReadonlyMap<string, ZipEntryInfo>;
  read(
    name: string
  ): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | ZipRefusal>;
}
export type ZipIndexResult =
  | { readonly ok: true; readonly index: ZipIndex }
  | ZipRefusal;

const DIRECTORY_LIMIT = 16 * 1024 * 1024;
class ZipFailure extends Error {
  constructor(
    readonly reason: ZipRefusalReason,
    message: string
  ) {
    super(message);
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  CRC_TABLE[i] = value >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function fail(reason: ZipRefusalReason, message: string): never {
  throw new ZipFailure(reason, message);
}
function failure(error: unknown): ZipRefusal {
  return error instanceof ZipFailure
    ? { ok: false, reason: error.reason, message: error.message }
    : {
        ok: false,
        reason: 'corrupt',
        message: error instanceof Error ? error.message : String(error),
      };
}
function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('bad-name-encoding', 'ZIP entry name is not valid UTF-8');
  }
}
function safeName(raw: string): string {
  if (
    raw.includes('\0') ||
    raw.includes('\\') ||
    raw.startsWith('/') ||
    /^[A-Za-z]:/.test(raw)
  )
    return fail('unsafe-name', `Unsafe ZIP entry name: ${raw}`);
  const parts = raw.split('/');
  if (parts.includes('..'))
    return fail('unsafe-name', `Unsafe ZIP entry name: ${raw}`);
  const name = parts.filter((p) => p !== '' && p !== '.').join('/');
  if (!name) return fail('unsafe-name', 'Empty ZIP entry name');
  return name;
}
function checkExtra(bytes: Uint8Array): void {
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) fail('corrupt', 'Truncated ZIP extra field');
    const id = bytes[pos]! | (bytes[pos + 1]! << 8);
    const size = bytes[pos + 2]! | (bytes[pos + 3]! << 8);
    if (pos + 4 + size > bytes.length)
      fail('corrupt', 'Truncated ZIP extra field');
    if (id === 1) fail('zip64', 'ZIP64 extra fields are not supported');
    pos += 4 + size;
  }
}
async function inflate(
  data: Uint8Array,
  expected: number,
  max: number
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    return fail('unsupported-method', 'No deflate inflater is available');
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const writing = writer
    .write(copy)
    .then(() => writer.close())
    .catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (total > max - result.value.length) {
        await reader.cancel();
        await writer.abort().catch(() => undefined);
        return fail('entry-too-large', 'Inflated entry exceeds its bound');
      }
      chunks.push(result.value);
      total += result.value.length;
    }
    await writing;
    if (total !== expected)
      return fail(
        'size-mismatch',
        'Inflated entry length differs from the directory'
      );
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    throw error;
  }
}
interface InternalEntry extends ZipEntryInfo {
  readonly crc: number;
  readonly dataOffset: number;
}

export async function indexZip(
  archive: Uint8Array | ZipSource,
  limits: ZipLimits,
  inflater?: InflaterFn
): Promise<ZipIndexResult> {
  if (
    ![
      limits.maxArchiveBytes,
      limits.maxEntries,
      limits.maxEntryBytes,
      limits.maxTotalBytes,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new TypeError('ZIP limits must be nonnegative safe integers');
  const source: ZipSource =
    archive instanceof Uint8Array
      ? {
          size: archive.length,
          async read(start, end) {
            return archive.subarray(start, end);
          },
        }
      : archive;
  async function range(start: number, end: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.size
    )
      return fail('corrupt', 'ZIP range is outside the archive');
    const bytes = await source.read(start, end);
    if (!(bytes instanceof Uint8Array) || bytes.length !== end - start)
      return fail('corrupt', 'ZIP source returned an incomplete range');
    return bytes;
  }
  try {
    if (!Number.isSafeInteger(source.size) || source.size < 0)
      return fail('corrupt', 'Invalid archive size');
    if (source.size > limits.maxArchiveBytes)
      return fail('total-too-large', 'ZIP archive exceeds its size limit');
    const tailOffset = Math.max(0, source.size - 65557);
    const tail = await range(tailOffset, source.size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (
        tv.getUint32(i, true) === 0x06054b50 &&
        i + 22 + tv.getUint16(i + 20, true) === tail.length
      ) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return fail('corrupt', 'End of central directory not found');
    const disk = tv.getUint16(eocd + 4, true),
      cdDisk = tv.getUint16(eocd + 6, true);
    const diskCount = tv.getUint16(eocd + 8, true),
      count = tv.getUint16(eocd + 10, true);
    const cdSize = tv.getUint32(eocd + 12, true),
      cdOffset = tv.getUint32(eocd + 16, true);
    const endOffset = tailOffset + eocd;
    if (
      disk === 0xffff ||
      cdDisk === 0xffff ||
      diskCount === 0xffff ||
      count === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    )
      return fail('zip64', 'ZIP64 end record is not supported');
    if (disk !== 0 || cdDisk !== 0 || diskCount !== count)
      return fail('multi-disk', 'Multi-disk ZIP is not supported');
    if (count > limits.maxEntries)
      return fail('too-many-entries', 'ZIP entry count exceeds its limit');
    if (cdSize > DIRECTORY_LIMIT)
      return fail(
        'directory-too-large',
        'ZIP central directory exceeds its limit'
      );
    if (cdOffset > source.size || cdSize > source.size - cdOffset)
      return fail('corrupt', 'Central directory is outside the archive');
    if (endOffset >= 20 && cdOffset + cdSize === endOffset - 20) {
      const locator = await range(endOffset - 20, endOffset);
      if (
        new DataView(
          locator.buffer,
          locator.byteOffset,
          locator.byteLength
        ).getUint32(0, true) === 0x07064b50
      )
        return fail('zip64', 'ZIP64 locator is not supported');
    }
    if (cdOffset + cdSize !== endOffset)
      return fail('corrupt', 'Central directory does not end at EOCD');
    const directory = await range(cdOffset, endOffset);
    const view = new DataView(
      directory.buffer,
      directory.byteOffset,
      directory.byteLength
    );
    const entries = new Map<string, InternalEntry>();
    const extents: { start: number; end: number }[] = [];
    let cursor = 0,
      total = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > cdSize || view.getUint32(cursor, true) !== 0x02014b50)
        return fail('corrupt', 'Invalid central directory entry');
      const flags = view.getUint16(cursor + 8, true),
        method = view.getUint16(cursor + 10, true);
      const crc = view.getUint32(cursor + 16, true),
        compressedSize = view.getUint32(cursor + 20, true),
        size = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true),
        extraLength = view.getUint16(cursor + 30, true),
        commentLength = view.getUint16(cursor + 32, true);
      const attrs = view.getUint32(cursor + 38, true),
        localOffset = view.getUint32(cursor + 42, true);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > cdSize)
        return fail('corrupt', 'Truncated central directory entry');
      if (flags & 1) return fail('encrypted', 'Encrypted ZIP entry');
      if (method !== 0 && method !== 8)
        return fail('unsupported-method', `Unsupported ZIP method ${method}`);
      if (
        compressedSize === 0xffffffff ||
        size === 0xffffffff ||
        localOffset === 0xffffffff
      )
        return fail('zip64', 'ZIP64 entry is not supported');
      const rawName = decodeName(
        directory.subarray(cursor + 46, cursor + 46 + nameLength)
      );
      checkExtra(
        directory.subarray(
          cursor + 46 + nameLength,
          cursor + 46 + nameLength + extraLength
        )
      );
      const name = safeName(rawName);
      if (entries.has(name))
        return fail('duplicate', `Duplicate ZIP entry: ${name}`);
      const mode = attrs >>> 16,
        fileType = mode & 0o170000;
      if (
        mode &&
        fileType !== 0o100000 &&
        fileType !== 0o040000 &&
        fileType !== 0o120000
      )
        return fail('corrupt', `Unsupported ZIP file type: ${name}`);
      const kind =
        fileType === 0o120000
          ? 'symlink'
          : rawName.endsWith('/') || fileType === 0o040000
            ? 'directory'
            : 'file';
      if (size > limits.maxEntryBytes)
        return fail('entry-too-large', `ZIP entry exceeds limit: ${name}`);
      if (total > limits.maxTotalBytes - size)
        return fail('total-too-large', 'ZIP expanded size exceeds its limit');
      total += size;
      if (method === 0 && compressedSize !== size)
        return fail('size-mismatch', `Stored entry sizes disagree: ${name}`);
      if (localOffset + 30 > cdOffset)
        return fail('corrupt', 'Invalid local header offset');
      const local = await range(localOffset, localOffset + 30);
      const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
      if (lv.getUint32(0, true) !== 0x04034b50)
        return fail('corrupt', 'Invalid local header');
      const lf = lv.getUint16(6, true),
        lm = lv.getUint16(8, true),
        lc = lv.getUint32(14, true),
        lcs = lv.getUint32(18, true),
        ls = lv.getUint32(22, true);
      const ln = lv.getUint16(26, true),
        le = lv.getUint16(28, true);
      if (lcs === 0xffffffff || ls === 0xffffffff)
        return fail('zip64', 'ZIP64 local header is not supported');
      if (lf !== flags || lm !== method)
        return fail('corrupt', 'Local and central headers disagree');
      if (!(flags & 8) && (lc !== crc || lcs !== compressedSize || ls !== size))
        return fail(
          'size-mismatch',
          'Local and central entry metadata disagree'
        );
      const dataOffset = localOffset + 30 + ln + le;
      if (dataOffset > cdOffset || compressedSize > cdOffset - dataOffset)
        return fail('corrupt', 'Entry data exceeds local area');
      const variable = await range(localOffset + 30, dataOffset);
      if (decodeName(variable.subarray(0, ln)) !== rawName)
        return fail('corrupt', 'Local and central names disagree');
      checkExtra(variable.subarray(ln));
      extents.push({ start: localOffset, end: dataOffset + compressedSize });
      entries.set(name, {
        name,
        kind,
        method,
        compressedSize,
        size,
        encrypted: false,
        crc,
        dataOffset,
      });
      cursor = end;
    }
    if (cursor !== cdSize)
      return fail('corrupt', 'Central directory census mismatch');
    extents.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < extents.length; i++)
      if (extents[i]!.start < extents[i - 1]!.end)
        return fail('corrupt', 'ZIP entries overlap');
    const index: ZipIndex = {
      entries,
      async read(name) {
        try {
          const entry = entries.get(name);
          if (!entry || entry.kind !== 'file')
            return fail('not-a-file', `Not a regular ZIP file: ${name}`);
          const data = await range(
            entry.dataOffset,
            entry.dataOffset + entry.compressedSize
          );
          const bytes =
            entry.method === 0
              ? data
              : await (inflater ?? inflate)(data, entry.size, entry.size);
          if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size)
            return fail('size-mismatch', `ZIP entry length mismatch: ${name}`);
          if (crc32(bytes) !== entry.crc)
            return fail('crc-mismatch', `ZIP entry CRC mismatch: ${name}`);
          return { ok: true, bytes };
        } catch (error) {
          return failure(error);
        }
      },
    };
    return { ok: true, index };
  } catch (error) {
    return failure(error);
  }
}
