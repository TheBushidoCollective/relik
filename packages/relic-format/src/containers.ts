import { assertSafeZipPath, indexZip, type ZipSource } from './zip-index.ts';

export type ZipContainerKind = 'otio' | 'docx' | 'xlsx' | 'epub' | 'archive';

const LIMITS = {
  maxArchiveBytes: Number.MAX_SAFE_INTEGER,
  maxEntries: 10_000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};
const EPUB_TYPE = 'application/epub+zip';

function fromNames(
  names: ReadonlySet<string>,
  epub: boolean
): ZipContainerKind {
  if (names.has('content.otio') && names.has('version.txt')) return 'otio';
  if (epub && names.has('META-INF/container.xml')) return 'epub';
  if (names.has('[Content_Types].xml')) {
    const word = names.has('word/document.xml');
    const excel = names.has('xl/workbook.xml');
    if (word && !excel) return 'docx';
    if (excel && !word) return 'xlsx';
  }
  return 'archive';
}

/** Shallow bounded sniff only. Renderers must use the checked ZIP index. */
export function zipContainerKindSync(bytes: Uint8Array): ZipContainerKind {
  try {
    if (bytes.length < 22) return 'archive';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (
      let i = bytes.length - 22;
      i >= Math.max(0, bytes.length - 65557);
      i--
    ) {
      if (
        view.getUint32(i, true) === 0x06054b50 &&
        i + 22 + view.getUint16(i + 20, true) === bytes.length
      ) {
        end = i;
        break;
      }
    }
    if (end < 0) return 'archive';
    const disk = view.getUint16(end + 4, true);
    const cdDisk = view.getUint16(end + 6, true);
    const diskCount = view.getUint16(end + 8, true);
    const count = view.getUint16(end + 10, true);
    const size = view.getUint32(end + 12, true);
    const offset = view.getUint32(end + 16, true);
    if (
      disk ||
      cdDisk ||
      diskCount !== count ||
      count === 0xffff ||
      count > LIMITS.maxEntries ||
      size === 0xffffffff ||
      offset === 0xffffffff ||
      size > 16 * 1024 * 1024 ||
      offset + size !== end
    )
      return 'archive';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const names = new Set<string>();
    let cursor = offset;
    let epub = false;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
        return 'archive';
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const compressed = view.getUint32(cursor + 20, true);
      const length = view.getUint32(cursor + 24, true);
      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const local = view.getUint32(cursor + 42, true);
      const next = cursor + 46 + nameLen + extraLen + commentLen;
      if (
        next > end ||
        (flags & 1) !== 0 ||
        (method !== 0 && method !== 8) ||
        compressed === 0xffffffff ||
        length === 0xffffffff ||
        local === 0xffffffff
      )
        return 'archive';
      const extraEnd = cursor + 46 + nameLen + extraLen;
      for (let pos = cursor + 46 + nameLen; pos < extraEnd; ) {
        if (pos + 4 > extraEnd) return 'archive';
        const id = view.getUint16(pos, true);
        const fieldSize = view.getUint16(pos + 2, true);
        if (id === 1 || pos + 4 + fieldSize > extraEnd) return 'archive';
        pos += 4 + fieldSize;
      }
      const name = assertSafeZipPath(
        decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen))
      );
      if (names.has(name)) return 'archive';
      names.add(name);
      if (
        name === 'mimetype' &&
        method === 0 &&
        length === 20 &&
        compressed === 20
      ) {
        if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50)
          return 'archive';
        const data =
          local +
          30 +
          view.getUint16(local + 26, true) +
          view.getUint16(local + 28, true);
        if (data + 20 > offset) return 'archive';
        epub = decoder.decode(bytes.subarray(data, data + 20)) === EPUB_TYPE;
      }
      cursor = next;
    }
    if (cursor !== end) return 'archive';
    return fromNames(names, epub);
  } catch {
    return 'archive';
  }
}

/** Inspect a range source with the checked index and never throw on bad ZIPs. */
export async function zipContainerKind(
  source: ZipSource
): Promise<ZipContainerKind> {
  try {
    const result = await indexZip(source, LIMITS);
    if (!result.ok) return 'archive';
    const entries = result.index.entries;
    const names = new Set(entries.keys());
    const mimetype = entries.get('mimetype');
    let epub = false;
    if (
      mimetype?.kind === 'file' &&
      mimetype.method === 0 &&
      mimetype.size === 20
    ) {
      const read = await result.index.read('mimetype');
      epub = read.ok && new TextDecoder().decode(read.bytes) === EPUB_TYPE;
    }
    return fromNames(names, epub);
  } catch {
    return 'archive';
  }
}
