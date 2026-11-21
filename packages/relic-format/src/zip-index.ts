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
export class ZipFailure extends Error {
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
export class Crc32 {
  private crc = 0xffffffff;

  update(bytes: Uint8Array): this {
    let crc = this.crc;
    for (const byte of bytes)
      crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
    this.crc = crc;
    return this;
  }

  value(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

export function crc32(bytes: Uint8Array): number {
  return new Crc32().update(bytes).value();
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
function decodeName(bytes: Uint8Array, where: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(
      'bad-name-encoding',
      `ZIP entry name is not valid UTF-8 in ${where}`
    );
  }
}
function safeName(raw: string, legacyNames: boolean): string {
  if (raw.includes('\0'))
    return fail('unsafe-name', 'NUL in ZIP entry name prohibited');
  if (
    (!legacyNames && raw.includes('\\')) ||
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    /^[A-Za-z]:/.test(raw)
  )
    return fail('unsafe-name', `Absolute paths in archive prohibited: ${raw}`);
  const parts = raw.split(legacyNames ? /[/\\]/ : /\//);
  if (parts.includes('..'))
    return fail('unsafe-name', `Path traversal (..) prohibited: ${raw}`);
  const name = parts.filter((p) => p !== '' && p !== '.').join('/');
  if (!name) return fail('unsafe-name', `Invalid ZIP entry path: ${raw}`);
  return name;
}
/** Normalize a ZIP member name or throw when it cannot be used safely. */
export function assertSafeZipPath(raw: string): string {
  return safeName(raw, false);
}

function checkExtra(bytes: Uint8Array, label: string): void {
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length)
      fail('corrupt', `Truncated extra field: ${label}`);
    const id = bytes[pos]! | (bytes[pos + 1]! << 8);
    const size = bytes[pos + 2]! | (bytes[pos + 3]! << 8);
    if (pos + 4 + size > bytes.length)
      fail('corrupt', `Truncated extra field: ${label}`);
    if (id === 1)
      fail('zip64', `ZIP64 extended information is not supported: ${label}`);
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
export interface OtioIndexedEntry extends ZipEntryInfo {
  readonly rawName: string;
  readonly crc: number;
  readonly dataOffset: number;
  readonly isDirectory: boolean;
}
interface InternalEntry extends OtioIndexedEntry {}

export interface OtioCompatibleZipIndex extends ZipIndex {
  readonly entries: ReadonlyMap<string, OtioIndexedEntry>;
  readonly directory: {
    readonly offset: number;
    readonly size: number;
    readonly entryCount: number;
    readonly commentLength: number;
  };
  readOtio(name: string, inflater?: InflaterFn): Promise<Uint8Array>;
}

export async function indexZip(
  archive: Uint8Array | ZipSource,
  limits: ZipLimits,
  inflater?: InflaterFn,
  signal?: AbortSignal
): Promise<ZipIndexResult> {
  return indexZipInternal(archive, limits, inflater, false, undefined, signal);
}

export async function indexZipForOtio(
  archive: Uint8Array | ZipSource,
  limits: ZipLimits,
  inflater?: InflaterFn,
  checkEntry?: (
    name: string,
    method: number,
    size: number
  ) => ZipRefusal | undefined
): Promise<
  { readonly ok: true; readonly index: OtioCompatibleZipIndex } | ZipRefusal
> {
  return indexZipInternal(archive, limits, inflater, true, checkEntry);
}

async function indexZipInternal(
  archive: Uint8Array | ZipSource,
  limits: ZipLimits,
  inflater: InflaterFn | undefined,
  legacyNames: boolean,
  checkEntry?: (
    name: string,
    method: number,
    size: number
  ) => ZipRefusal | undefined,
  signal?: AbortSignal
): Promise<
  { readonly ok: true; readonly index: OtioCompatibleZipIndex } | ZipRefusal
> {
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
  function checkAborted(): void {
    if (signal?.aborted) fail('corrupt', 'ZIP operation aborted');
  }
  async function range(start: number, end: number): Promise<Uint8Array> {
    checkAborted();
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.size
    )
      return fail('corrupt', 'ZIP range is outside the archive');
    const bytes = await source.read(start, end);
    checkAborted();
    if (!(bytes instanceof Uint8Array) || bytes.length !== end - start)
      return fail('corrupt', 'ZIP source returned an incomplete range');
    return bytes;
  }
  try {
    checkAborted();
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
    if (eocd < 0)
      return fail('corrupt', 'End of Central Directory record not found');
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
      return fail(
        'zip64',
        'ZIP64 sentinel in the end of central directory is not supported'
      );
    if (disk !== 0 || cdDisk !== 0 || diskCount !== count)
      return fail('multi-disk', 'Multi-disk ZIP archives are not supported');
    if (count > limits.maxEntries)
      return fail('too-many-entries', 'ZIP entry count exceeds its limit');
    if (!legacyNames && cdSize > DIRECTORY_LIMIT)
      return fail(
        'directory-too-large',
        'Central directory exceeds the size limit'
      );
    if (cdOffset > source.size || cdSize > source.size - cdOffset)
      return fail('corrupt', 'Central directory points beyond end of archive');
    if (endOffset >= 20 && cdOffset + cdSize === endOffset - 20) {
      const locator = await range(endOffset - 20, endOffset);
      if (
        new DataView(
          locator.buffer,
          locator.byteOffset,
          locator.byteLength
        ).getUint32(0, true) === 0x07064b50
      )
        return fail(
          'zip64',
          'ZIP64 end of central directory locator is not supported'
        );
    }
    if (cdOffset + cdSize !== endOffset)
      return fail(
        'corrupt',
        'Central directory extent does not end at the end of central directory record'
      );
    if (legacyNames && cdSize > DIRECTORY_LIMIT)
      return fail(
        'directory-too-large',
        'Central directory exceeds the size limit'
      );
    const directory = await range(cdOffset, endOffset);
    const view = new DataView(
      directory.buffer,
      directory.byteOffset,
      directory.byteLength
    );
    const entries = new Map<string, InternalEntry>();
    const extents: { start: number; end: number; name: string }[] = [];
    let cursor = 0,
      total = 0;
    for (let i = 0; i < count; i++) {
      checkAborted();
      if (cursor + 46 > cdSize)
        return fail('corrupt', 'Truncated central directory entry');
      if (view.getUint32(cursor, true) !== 0x02014b50)
        return fail(
          'corrupt',
          `Invalid central directory signature at ${cursor}`
        );
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
      if (flags & 1)
        return fail(
          'encrypted',
          'Encrypted ZIP entries are strictly prohibited'
        );
      if (method !== 0 && method !== 8)
        return fail(
          'unsupported-method',
          `Unsupported compression method: ${method} (only 0 STORED and 8 DEFLATE allowed)`
        );
      if (end > cdSize)
        return fail(
          'corrupt',
          'Central directory entry extends past declared extent'
        );
      if (compressedSize === 0xffffffff)
        return fail('zip64', 'ZIP64 sentinel compressed size is not supported');
      if (size === 0xffffffff)
        return fail(
          'zip64',
          'ZIP64 sentinel uncompressed size is not supported'
        );
      if (localOffset === 0xffffffff)
        return fail(
          'zip64',
          'ZIP64 sentinel local header offset is not supported'
        );
      const rawName = decodeName(
        directory.subarray(cursor + 46, cursor + 46 + nameLength),
        'central directory'
      );
      checkExtra(
        directory.subarray(
          cursor + 46 + nameLength,
          cursor + 46 + nameLength + extraLength
        ),
        rawName
      );
      const mode = attrs >>> 16,
        fileType = mode & 0o170000;
      if (
        fileType !== 0 &&
        fileType !== 0o100000 &&
        fileType !== 0o040000 &&
        fileType !== 0o120000
      )
        return fail(
          'corrupt',
          `Non-regular file type in ZIP entry prohibited: ${rawName}`
        );
      const kind =
        fileType === 0o120000
          ? 'symlink'
          : rawName.endsWith('/') ||
              fileType === 0o040000 ||
              (fileType === 0 && (attrs & 0x10) !== 0)
            ? 'directory'
            : 'file';
      if (legacyNames && kind === 'symlink')
        return fail(
          'corrupt',
          `Non-regular file type in ZIP entry prohibited: ${rawName}`
        );
      const name = safeName(rawName, legacyNames);
      if (entries.has(name))
        return fail('duplicate', `Duplicate entry name: ${name}`);
      if (method === 0 && compressedSize !== size)
        return fail('size-mismatch', `STORED entry sizes disagree: ${rawName}`);
      if (size > limits.maxEntryBytes)
        return fail(
          'entry-too-large',
          legacyNames
            ? `Aggregate uncompressed size ${total + size} exceeds cap of ${limits.maxTotalBytes} bytes`
            : `ZIP entry exceeds limit: ${name}`
        );
      if (total > limits.maxTotalBytes - size)
        return fail(
          'total-too-large',
          `Aggregate uncompressed size ${total + size} exceeds cap of ${limits.maxTotalBytes} bytes`
        );
      total += size;
      const refused = checkEntry?.(name, method, size);
      if (refused) return refused;
      if (localOffset + 30 > source.size || localOffset >= cdOffset)
        return fail('corrupt', 'Local header offset beyond archive');
      const local = await range(localOffset, localOffset + 30);
      const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
      if (lv.getUint32(0, true) !== 0x04034b50)
        return fail('corrupt', 'Invalid local header signature');
      const lf = lv.getUint16(6, true),
        lm = lv.getUint16(8, true),
        lc = lv.getUint32(14, true),
        lcs = lv.getUint32(18, true),
        ls = lv.getUint32(22, true);
      const ln = lv.getUint16(26, true),
        le = lv.getUint16(28, true);
      if (lcs === 0xffffffff)
        return fail(
          'zip64',
          'ZIP64 sentinel local compressed size is not supported'
        );
      if (ls === 0xffffffff)
        return fail(
          'zip64',
          'ZIP64 sentinel local uncompressed size is not supported'
        );
      if (lf !== flags)
        return fail('corrupt', `Mismatched flags in local header: ${rawName}`);
      if (lm !== method)
        return fail(
          'corrupt',
          `Mismatched compression method in local header: ${rawName}`
        );
      if (!(flags & 8)) {
        if (lc !== crc)
          return fail('corrupt', `Mismatched CRC in local header: ${rawName}`);
        if (lcs !== compressedSize)
          return fail(
            'size-mismatch',
            `Mismatched compressed size in local header: ${rawName}`
          );
        if (ls !== size)
          return fail(
            'size-mismatch',
            `Mismatched uncompressed size in local header: ${rawName}`
          );
      }
      if (localOffset + 30 + ln > source.size)
        return fail(
          'corrupt',
          `Local header name extends beyond archive: ${rawName}`
        );
      const dataOffset = localOffset + 30 + ln + le;
      if (dataOffset > source.size || dataOffset > cdOffset)
        return fail(
          'corrupt',
          `Local header extends beyond archive: ${rawName}`
        );
      const variable = await range(localOffset + 30, dataOffset);
      if (decodeName(variable.subarray(0, ln), 'local header') !== rawName)
        return fail(
          'corrupt',
          `Local and central directory filenames disagree: ${rawName}`
        );
      if (compressedSize > source.size - dataOffset)
        return fail('corrupt', `File data extends beyond archive: ${rawName}`);
      checkExtra(variable.subarray(ln), rawName);
      if (compressedSize > cdOffset - dataOffset)
        return fail(
          'corrupt',
          `File data overlaps central directory: ${rawName}`
        );
      extents.push({
        start: localOffset,
        end: dataOffset + compressedSize,
        name: rawName,
      });
      entries.set(name, {
        name,
        rawName,
        isDirectory: kind === 'directory' || rawName.endsWith('\\'),
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
      return fail(
        'corrupt',
        'Central directory census did not consume the declared extent'
      );
    extents.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < extents.length; i++) {
      checkAborted();
      if (extents[i]!.start < extents[i - 1]!.end)
        return fail('corrupt', `ZIP entries overlap: ${extents[i]!.name}`);
    }
    async function load(
      name: string,
      customInflater?: InflaterFn
    ): Promise<Uint8Array> {
      const entry = entries.get(name);
      if (!entry || (!legacyNames && entry.kind !== 'file'))
        return fail('not-a-file', `Not a regular ZIP file: ${name}`);
      const chunkSize = 8 * 1024 * 1024;
      let data: Uint8Array;
      if (archive instanceof Uint8Array || entry.compressedSize <= chunkSize) {
        data = await range(
          entry.dataOffset,
          entry.dataOffset + entry.compressedSize
        );
      } else {
        data = new Uint8Array(entry.compressedSize);
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          const start = entry.dataOffset + offset;
          data.set(
            await range(
              start,
              entry.dataOffset + Math.min(offset + chunkSize, data.length)
            ),
            offset
          );
        }
      }
      const bytes =
        entry.method === 0
          ? data
          : await (customInflater ?? inflater ?? inflate)(
              data,
              entry.size,
              entry.size
            );
      checkAborted();
      if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size)
        return fail(
          'size-mismatch',
          `Decompressed length ${bytes.length} does not match expected ${entry.size}`
        );
      const computedCrc = crc32(bytes);
      if (computedCrc !== entry.crc)
        return fail(
          'crc-mismatch',
          `CRC32 mismatch on ${entry.name}: expected ${entry.crc.toString(16)}, got ${computedCrc.toString(16)}`
        );
      return bytes;
    }
    const index: OtioCompatibleZipIndex = {
      entries,
      directory: {
        offset: cdOffset,
        size: cdSize,
        entryCount: count,
        commentLength: tv.getUint16(eocd + 20, true),
      },
      readOtio: load,
      async read(name) {
        try {
          const entry = entries.get(name);
          if (!entry || entry.kind !== 'file')
            return fail('not-a-file', `Not a regular ZIP file: ${name}`);
          return { ok: true, bytes: await load(name) };
        } catch (error) {
          return failure(error);
        }
      },
    };
    checkAborted();
    return { ok: true, index };
  } catch (error) {
    return failure(error);
  }
}
