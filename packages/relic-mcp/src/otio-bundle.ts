/**
 * OpenTimelineIO .otiod directory bundler.
 *
 * Emits a standard, deterministic .otioz archive containing:
 * - content.otio (DEFLATE)
 * - version.txt (DEFLATE, contents exactly "1.0.0")
 * - media/<unique-name> (STORED)
 *
 * Rules enforced:
 * - Only an actual .otiod directory receives automatic packaging.
 * - Only referenced media (including inactive Clip.2 references and bundled
 *   image sequences) is packaged; unreferenced files are never included.
 * - Media paths are strictly resolved within the bundle root; symlinks, devices,
 *   FIFOs, sockets, path traversal (..), absolute paths, and URI authority/scheme
 *   escapes are strictly rejected.
 * - Single-pass deliberate percent decoding.
 * - No network fetching or execution of foreign code.
 * - 100 MiB safety ceiling on both aggregate uncompressed bytes and archive bytes.
 * - Purely deterministic archive generation: fixed timestamps, stable ordering,
 *   and fixed compression parameters ensure unchanged sources yield identical bytes.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';
import {
  crc32,
  indexOtioZip,
  MAX_EXPANDED_ZIP_BYTES,
  parseOtioJson,
} from '@relic/format';
import { type FileReader, PublishError } from './publish.ts';

export interface BundleOtiodOptions {
  readonly maxExpandedBytes?: number | undefined;
  readonly sizeLimitBytes?: number | undefined;
}

export interface BundleOtiodResult {
  readonly bytes: Uint8Array;
  readonly defaultFilename: string;
  readonly resolvedPath: string;
}

interface ZipFileEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

/**
 * Build a standard, deterministic ZIP archive from entries.
 *
 * Timestamps are fixed to DOS 1980-01-01 00:00:00.
 * Entries are written with no non-deterministic extra fields.
 */
export function buildZipArchive(entries: readonly ZipFileEntry[]): Uint8Array {
  const dosTime = 0x0000;
  const dosDate = 0x0021; // 1980-01-01

  // Precompute compressed data and CRC for each entry
  const prepared = entries.map((entry) => {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const compressed =
      entry.method === 8
        ? deflateRawSync(entry.data, { level: 9 })
        : entry.data;

    return {
      entry,
      nameBytes,
      crc,
      compressed,
    };
  });

  // Calculate total buffer size
  let localHeadersTotal = 0;
  for (const p of prepared) {
    localHeadersTotal += 30 + p.nameBytes.length + p.compressed.length;
  }

  let centralDirTotal = 0;
  for (const p of prepared) {
    centralDirTotal += 46 + p.nameBytes.length;
  }

  const eocdTotal = 22;
  const totalSize = localHeadersTotal + centralDirTotal + eocdTotal;

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let localCursor = 0;
  const localHeaderOffsets: number[] = [];

  // Write Local File Headers
  for (const p of prepared) {
    const offset = localCursor;
    localHeaderOffsets.push(offset);

    view.setUint32(offset + 0, 0x04034b50, true); // signature
    view.setUint16(offset + 4, 20, true); // version needed: 2.0
    view.setUint16(offset + 6, 0, true); // flags: 0
    view.setUint16(offset + 8, p.entry.method, true); // compression method
    view.setUint16(offset + 10, dosTime, true); // mod time
    view.setUint16(offset + 12, dosDate, true); // mod date
    view.setUint32(offset + 14, p.crc, true); // crc32
    view.setUint32(offset + 18, p.compressed.length, true); // compressed size
    view.setUint32(offset + 22, p.entry.data.length, true); // uncompressed size
    view.setUint16(offset + 26, p.nameBytes.length, true); // filename length
    view.setUint16(offset + 28, 0, true); // extra field length

    buffer.set(p.nameBytes, offset + 30);
    buffer.set(p.compressed, offset + 30 + p.nameBytes.length);

    localCursor += 30 + p.nameBytes.length + p.compressed.length;
  }

  const cdOffset = localCursor;
  let cdCursor = cdOffset;

  // Write Central Directory Headers
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]!;
    const localOffset = localHeaderOffsets[i]!;

    view.setUint32(cdCursor + 0, 0x02014b50, true); // signature
    view.setUint16(cdCursor + 4, 0x0014, true); // version made by (DOS 2.0)
    view.setUint16(cdCursor + 6, 20, true); // version needed
    view.setUint16(cdCursor + 8, 0, true); // flags
    view.setUint16(cdCursor + 10, p.entry.method, true); // compression method
    view.setUint16(cdCursor + 12, dosTime, true); // mod time
    view.setUint16(cdCursor + 14, dosDate, true); // mod date
    view.setUint32(cdCursor + 16, p.crc, true); // crc32
    view.setUint32(cdCursor + 20, p.compressed.length, true); // compressed size
    view.setUint32(cdCursor + 24, p.entry.data.length, true); // uncompressed size
    view.setUint16(cdCursor + 28, p.nameBytes.length, true); // filename length
    view.setUint16(cdCursor + 30, 0, true); // extra field length
    view.setUint16(cdCursor + 32, 0, true); // comment length
    view.setUint16(cdCursor + 34, 0, true); // disk number start
    view.setUint16(cdCursor + 36, 0, true); // internal file attributes
    view.setUint32(cdCursor + 38, 0, true); // external file attributes
    view.setUint32(cdCursor + 42, localOffset, true); // local header offset

    buffer.set(p.nameBytes, cdCursor + 46);
    cdCursor += 46 + p.nameBytes.length;
  }

  const cdSize = cdCursor - cdOffset;

  // Write End of Central Directory (EOCD)
  view.setUint32(cdCursor + 0, 0x06054b50, true); // signature
  view.setUint16(cdCursor + 4, 0, true); // disk number
  view.setUint16(cdCursor + 6, 0, true); // disk with CD
  view.setUint16(cdCursor + 8, entries.length, true); // entries on disk
  view.setUint16(cdCursor + 10, entries.length, true); // total entries
  view.setUint32(cdCursor + 12, cdSize, true); // CD size
  view.setUint32(cdCursor + 16, cdOffset, true); // CD offset
  view.setUint16(cdCursor + 20, 0, true); // comment length

  return buffer;
}

/**
 * Single-pass deliberate percent decoding with strict security checks.
 */
function safePercentDecode(pathStr: string): string {
  if (pathStr.includes('\0')) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Null byte in media reference path: ${pathStr}`
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathStr);
  } catch (err) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Malformed percent-encoding in media reference: ${pathStr}`
    );
  }
  if (decoded.includes('\0')) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Null byte in decoded media reference path: ${pathStr}`
    );
  }
  return decoded;
}

/**
 * Validate and normalize a referenced media URL.
 * Maps valid bundle-relative paths to the canonical archive path under media/.
 */
function parseMediaReferenceUrl(rawUrl: string, results: Map<string, string>): void {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return;

  // 1. Prohibit remote network URLs and non-file schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    if (!trimmed.startsWith('file:')) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Prohibited URL scheme in media reference: ${trimmed}`
      );
    }
  }

  // 2. Prohibit network protocol-relative authority escapes
  if (trimmed.startsWith('//')) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Network authority escapes prohibited in media reference: ${trimmed}`
    );
  }

  let pathPart = trimmed;
  if (pathPart.startsWith('file:')) {
    pathPart = pathPart.slice(5);
    if (pathPart.startsWith('///')) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Absolute file URL prohibited in media reference: ${trimmed}`
      );
    }
    if (pathPart.startsWith('//')) {
      throw new PublishError(
        'otio_bundle_invalid',
        `File URL authority escape prohibited in media reference: ${trimmed}`
      );
    }
  }

  // 3. Prohibit backslashes
  if (pathPart.includes('\\')) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Backslashes prohibited in media reference: ${trimmed}`
    );
  }

  // 4. Single-pass percent decoding
  const decoded = safePercentDecode(pathPart);

  // 5. Absolute path check
  if (decoded.startsWith('/') || /^[a-zA-Z]:/.test(decoded)) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Absolute paths prohibited in media reference: ${trimmed}`
    );
  }

  // 6. Split segments and check traversal
  const segments = decoded.split('/');
  const normalized: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      throw new PublishError(
        'otio_bundle_invalid',
        `Path traversal (..) prohibited in media reference: ${trimmed}`
      );
    }
    if (seg === '' || seg === '.') continue;
    normalized.push(seg);
  }

  if (normalized.length === 0) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Empty media reference path: ${trimmed}`
    );
  }

  const bundleRelPath = normalized.join('/');
  const archivePath = bundleRelPath.startsWith('media/')
    ? bundleRelPath
    : `media/${bundleRelPath}`;

  results.set(archivePath, bundleRelPath);
}

function addImageSequenceUrls(
  record: Record<string, unknown>,
  results: Map<string, string>
): void {
  const targetUrlBase =
    typeof record['target_url_base'] === 'string'
      ? record['target_url_base']
      : '';
  const namePrefix =
    typeof record['name_prefix'] === 'string' ? record['name_prefix'] : '';
  const nameSuffix =
    typeof record['name_suffix'] === 'string' ? record['name_suffix'] : '';
  const startFrame =
    typeof record['start_frame'] === 'number' ? record['start_frame'] : 0;
  const frameStep =
    typeof record['frame_step'] === 'number' && record['frame_step'] > 0
      ? record['frame_step']
      : 1;
  const padding =
    typeof record['frame_zero_padding'] === 'number'
      ? record['frame_zero_padding']
      : 0;

  let frameCount = 1;
  if (
    typeof record['number_of_frames_in_sequence'] === 'number' &&
    record['number_of_frames_in_sequence'] > 0
  ) {
    frameCount = record['number_of_frames_in_sequence'];
  } else if (
    record['available_range'] &&
    typeof record['available_range'] === 'object' &&
    (record['available_range'] as Record<string, unknown>)['duration'] &&
    typeof (
      (record['available_range'] as Record<string, unknown>)[
        'duration'
      ] as Record<string, unknown>
    )['value'] === 'number'
  ) {
    const durVal = (
      (record['available_range'] as Record<string, unknown>)[
        'duration'
      ] as Record<string, unknown>
    )['value'] as number;
    if (durVal > 0) {
      frameCount = Math.floor(durVal);
    }
  }

  for (let i = 0; i < frameCount; i++) {
    const frameNum = startFrame + i * frameStep;
    const frameStr =
      padding > 0
        ? String(frameNum).padStart(padding, '0')
        : String(frameNum);
    const frameUrl = `${targetUrlBase}${namePrefix}${frameStr}${nameSuffix}`;
    parseMediaReferenceUrl(frameUrl, results);
  }
}

/**
 * Recursively inspect the parsed OTIO JSON document to collect all referenced media.
 * Includes both active and inactive references in Clip.2 and image sequence frames.
 */
export function collectReferencedMedia(
  obj: unknown,
  results: Map<string, string>
): void {
  if (obj === null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectReferencedMedia(item, results);
    }
    return;
  }

  const record = obj as Record<string, unknown>;
  const schema =
    typeof record['OTIO_SCHEMA'] === 'string' ? record['OTIO_SCHEMA'] : '';

  if (schema.startsWith('ExternalReference')) {
    const targetUrl = record['target_url'];
    if (typeof targetUrl === 'string' && targetUrl.trim().length > 0) {
      parseMediaReferenceUrl(targetUrl, results);
    }
  } else if (schema.startsWith('ImageSequenceReference')) {
    addImageSequenceUrls(record, results);
  }

  if (record['media_reference']) {
    collectReferencedMedia(record['media_reference'], results);
  }
  if (
    record['media_references'] &&
    typeof record['media_references'] === 'object'
  ) {
    for (const key of Object.keys(record['media_references'])) {
      collectReferencedMedia(
        (record['media_references'] as Record<string, unknown>)[key],
        results
      );
    }
  }

  for (const key of Object.keys(record)) {
    if (key === 'media_reference' || key === 'media_references') continue;
    collectReferencedMedia(record[key], results);
  }
}

/**
 * Securely package an .otiod directory into a standard .otioz archive.
 */
export async function bundleOtiod(
  directoryPath: string,
  files: FileReader,
  options?: BundleOtiodOptions
): Promise<BundleOtiodResult> {
  const maxLimit = options?.maxExpandedBytes ?? MAX_EXPANDED_ZIP_BYTES;
  const resolvedDir = files.resolve(directoryPath);

  // 1. Verify directory stat
  const dirStat = await files.stat(resolvedDir);
  if (dirStat.kind === 'symlink') {
    throw new PublishError(
      'source_not_regular_file',
      `${resolvedDir} is a symlink`
    );
  }
  if (dirStat.kind !== 'directory') {
    throw new PublishError(
      'source_not_found',
      `${resolvedDir} is not a directory`
    );
  }

  // 2. Read content.otio
  const contentOtioPath = pathResolve(resolvedDir, 'content.otio');
  const contentStat = await files.stat(contentOtioPath);
  if (contentStat.kind === 'symlink') {
    throw new PublishError(
      'otio_bundle_invalid',
      `content.otio in ${resolvedDir} is a symlink`
    );
  }
  if (contentStat.kind !== 'file') {
    throw new PublishError(
      'otio_bundle_invalid',
      `content.otio missing or not a regular file in ${resolvedDir}`
    );
  }

  let contentOtioBytes: Uint8Array;
  try {
    contentOtioBytes = await files.read(contentOtioPath);
  } catch (err) {
    throw new PublishError(
      'source_unreadable',
      `could not read content.otio in ${resolvedDir}: ${(err as Error).message}`
    );
  }

  let aggregateUncompressed = contentOtioBytes.length;
  if (aggregateUncompressed > maxLimit) {
    throw new PublishError(
      'local_size_precheck_failed',
      `content.otio size (${aggregateUncompressed} bytes) exceeds limit of ${maxLimit} bytes`
    );
  }

  // 3. Parse content.otio losslessly
  let otioJson: unknown;
  try {
    otioJson = parseOtioJson(contentOtioBytes);
  } catch (err) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Invalid OTIO JSON in content.otio: ${(err as Error).message}`
    );
  }

  if (typeof otioJson !== 'object' || otioJson === null) {
    throw new PublishError(
      'otio_bundle_invalid',
      'content.otio root must be a JSON object'
    );
  }

  // 4. Collect referenced media paths
  const mediaRefMap = new Map<string, string>();
  collectReferencedMedia(otioJson, mediaRefMap);

  // 5. Read all referenced media files
  const mediaEntries: Array<{ name: string; data: Uint8Array }> = [];
  const sortedArchivePaths = Array.from(mediaRefMap.keys()).sort();

  for (const archivePath of sortedArchivePaths) {
    const bundleRelPath = mediaRefMap.get(archivePath)!;
    let targetPath = pathResolve(resolvedDir, bundleRelPath);

    // Verify target path does not escape bundle root
    let rel = pathRelative(resolvedDir, targetPath);
    if (rel.startsWith('..') || pathIsAbsolute(rel)) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Referenced media path escapes bundle root: ${bundleRelPath}`
      );
    }

    let stat = await files.stat(targetPath);
    // If not found directly, check if it's under media/ if bundleRelPath didn't start with media/
    if (stat.kind !== 'file' && !bundleRelPath.startsWith('media/')) {
      const altPath = pathResolve(resolvedDir, 'media', bundleRelPath);
      const altRel = pathRelative(resolvedDir, altPath);
      if (!altRel.startsWith('..') && !pathIsAbsolute(altRel)) {
        const altStat = await files.stat(altPath);
        if (altStat.kind === 'file') {
          targetPath = altPath;
          stat = altStat;
        }
      }
    }

    if (stat.kind === 'symlink') {
      throw new PublishError(
        'otio_bundle_invalid',
        `Referenced media is a symlink: ${bundleRelPath}`
      );
    }
    if (stat.kind === 'directory') {
      throw new PublishError(
        'otio_bundle_invalid',
        `Referenced media path is a directory: ${bundleRelPath}`
      );
    }
    if (stat.kind !== 'file') {
      throw new PublishError(
        'source_unreadable',
        `Referenced media file not found or not a regular file: ${bundleRelPath}`
      );
    }

    let fileBytes: Uint8Array;
    try {
      fileBytes = await files.read(targetPath);
    } catch (err) {
      throw new PublishError(
        'source_unreadable',
        `Could not read referenced media file ${bundleRelPath}: ${(err as Error).message}`
      );
    }

    aggregateUncompressed += fileBytes.length;
    if (aggregateUncompressed > maxLimit) {
      throw new PublishError(
        'local_size_precheck_failed',
        `Aggregate uncompressed bundle size (${aggregateUncompressed} bytes) exceeds limit of ${maxLimit} bytes`
      );
    }
    if (
      options?.sizeLimitBytes &&
      aggregateUncompressed > options.sizeLimitBytes
    ) {
      throw new PublishError(
        'local_size_precheck_failed',
        `Aggregate uncompressed bundle size (${aggregateUncompressed} bytes) exceeds limit of ${options.sizeLimitBytes} bytes`
      );
    }

    mediaEntries.push({
      name: archivePath,
      data: fileBytes,
    });
  }

  // 6. version.txt: exactly "1.0.0"
  const versionBytes = new TextEncoder().encode('1.0.0');
  aggregateUncompressed += versionBytes.length;

  // 7. Assemble entries: content.otio (method 8), version.txt (method 8), media (method 0)
  const zipEntries: ZipFileEntry[] = [
    { name: 'content.otio', data: contentOtioBytes, method: 8 },
    { name: 'version.txt', data: versionBytes, method: 8 },
    ...mediaEntries.map((m) => ({
      name: m.name,
      data: m.data,
      method: 0 as const,
    })),
  ];

  // 8. Build deterministic ZIP
  const zipBytes = buildZipArchive(zipEntries);

  if (zipBytes.length > maxLimit) {
    throw new PublishError(
      'local_size_precheck_failed',
      `Generated .otioz archive size (${zipBytes.length} bytes) exceeds limit of ${maxLimit} bytes`
    );
  }
  if (options?.sizeLimitBytes && zipBytes.length > options.sizeLimitBytes) {
    throw new PublishError(
      'local_size_precheck_failed',
      `Generated .otioz archive size (${zipBytes.length} bytes) exceeds limit of ${options.sizeLimitBytes} bytes`
    );
  }

  // 9. Self-validate with indexOtioZip
  try {
    await indexOtioZip(zipBytes, {
      maxExpandedBytes: maxLimit,
      inflater: async (compressed) => {
        return new Uint8Array(inflateRawSync(compressed));
      },
    });
  } catch (err) {
    throw new PublishError(
      'otio_bundle_invalid',
      `Self-validation of generated .otioz archive failed: ${(err as Error).message}`
    );
  }

  // 10. Compute defaultFilename: replace .otiod with .otioz
  const base = files.basename(resolvedDir);
  const defaultFilename = base.toLowerCase().endsWith('.otiod')
    ? `${base.slice(0, -6)}.otioz`
    : `${base}.otioz`;

  return {
    bytes: zipBytes,
    defaultFilename,
    resolvedPath: resolvedDir,
  };
}
