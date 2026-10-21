/**
 * OpenTimelineIO .otiod directory bundler.
 *
 * Emits a deterministic standard .otioz archive containing content.otio,
 * version.txt, and only media reached through supported OTIO structural edges.
 * Directory reads use a native descriptor-confined root. No bundle descendant is
 * checked or reopened by pathname after that root has been pinned.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  crc32,
  indexOtioZip,
  MAX_EXPANDED_ZIP_BYTES,
  parseOtioJson,
} from '@relic/format';
import {
  type ConfinedBundleDirectory,
  type ConfinedBundleFile,
  type FileReader,
  PublishError,
} from './publish.ts';

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

/** ZIP's non-ZIP64 entry-count sentinel is not usable by this writer. */
export const MAX_ZIP_ENTRY_COUNT = 0xffff;
/** content.otio and version.txt consume two of the 65,534 usable entries. */
export const MAX_MEDIA_ENTRY_COUNT = MAX_ZIP_ENTRY_COUNT - 3;
const MAX_ZIP_FILENAME_BYTES = 0xffff;
const ZIP_ENTRY_HEADER_BYTES = 30 + 46;
const VERSION_BYTES = new TextEncoder().encode('1.0.0');
const TEXT_ENCODER = new TextEncoder();
const MAX_RAW_REFERENCE_CHARS = MAX_ZIP_FILENAME_BYTES * 3;

function bundleRefusal(message: string): never {
  throw new PublishError('otio_bundle_invalid', message);
}

function sizeRefusal(message: string): never {
  throw new PublishError('local_size_precheck_failed', message);
}

function recordAt(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    bundleRefusal(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function schemaAt(record: Record<string, unknown>, where: string): string {
  const schema = record['OTIO_SCHEMA'];
  if (typeof schema !== 'string') bundleRefusal(`${where} has no OTIO_SCHEMA`);
  return schema;
}

function assertSafeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    bundleRefusal(`${name} must be a positive safe integer`);
  }
  return value;
}

function effectiveBundleLimit(options?: BundleOtiodOptions): number {
  const expanded = assertSafeLimit(
    options?.maxExpandedBytes ?? MAX_EXPANDED_ZIP_BYTES,
    'maxExpandedBytes'
  );
  if (options?.sizeLimitBytes === undefined) return expanded;
  return Math.min(
    expanded,
    assertSafeLimit(options.sizeLimitBytes, 'sizeLimitBytes')
  );
}

function utf8Length(value: string, where: string): number {
  // Every UTF-8 code point consumes at least one code unit's worth of bytes,
  // so this avoids allocating a giant encoded buffer for a hopeless name.
  if (value.length > MAX_ZIP_FILENAME_BYTES) {
    bundleRefusal(`${where} exceeds the ZIP filename byte limit`);
  }
  const length = TEXT_ENCODER.encode(value).length;
  if (length > MAX_ZIP_FILENAME_BYTES) {
    bundleRefusal(`${where} exceeds the ZIP filename byte limit`);
  }
  return length;
}

function checkedAdd(left: number, right: number, where: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total))
    bundleRefusal(`${where} exceeds safe arithmetic`);
  return total;
}

/**
 * Build a standard deterministic ZIP archive. Count validation deliberately
 * happens before compression or an entries-sized allocation.
 */
export function buildZipArchive(
  entries: readonly ZipFileEntry[],
  maxArchiveBytes = MAX_EXPANDED_ZIP_BYTES
): Uint8Array {
  if (entries.length >= MAX_ZIP_ENTRY_COUNT) {
    bundleRefusal(
      `ZIP has ${entries.length} entries; this non-ZIP64 writer permits at most ${MAX_ZIP_ENTRY_COUNT - 1}`
    );
  }
  assertSafeLimit(maxArchiveBytes, 'maxArchiveBytes');

  const dosTime = 0x0000;
  const dosDate = 0x0021; // 1980-01-01
  const prepared: Array<{
    readonly entry: ZipFileEntry;
    readonly nameBytes: Uint8Array;
    readonly crc: number;
    readonly compressed: Uint8Array;
  }> = [];

  let localHeadersTotal = 0;
  let centralDirTotal = 0;
  for (const entry of entries) {
    const nameLength = utf8Length(
      entry.name,
      `ZIP entry name ${JSON.stringify(entry.name)}`
    );
    if (entry.data.length > 0xffffffff) {
      bundleRefusal(`ZIP entry ${entry.name} exceeds the ZIP32 size limit`);
    }
    const nameBytes = TEXT_ENCODER.encode(entry.name);
    const compressed =
      entry.method === 8
        ? new Uint8Array(deflateRawSync(entry.data, { level: 9 }))
        : entry.data;
    if (compressed.length > 0xffffffff) {
      bundleRefusal(
        `Compressed ZIP entry ${entry.name} exceeds the ZIP32 size limit`
      );
    }

    localHeadersTotal = checkedAdd(
      localHeadersTotal,
      checkedAdd(30 + nameLength, compressed.length, 'ZIP local header size'),
      'ZIP local headers'
    );
    centralDirTotal = checkedAdd(
      centralDirTotal,
      46 + nameLength,
      'ZIP central directory'
    );
    prepared.push({ entry, nameBytes, crc: crc32(entry.data), compressed });
  }

  const totalSize = checkedAdd(
    checkedAdd(localHeadersTotal, centralDirTotal, 'ZIP archive size'),
    22,
    'ZIP archive size'
  );
  if (totalSize > maxArchiveBytes) {
    sizeRefusal(
      `Generated .otioz archive size (${totalSize} bytes) exceeds limit of ${maxArchiveBytes} bytes`
    );
  }

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  let localCursor = 0;
  const localHeaderOffsets: number[] = [];

  for (const item of prepared) {
    const offset = localCursor;
    localHeaderOffsets.push(offset);
    view.setUint32(offset + 0, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, item.entry.method, true);
    view.setUint16(offset + 10, dosTime, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, item.crc, true);
    view.setUint32(offset + 18, item.compressed.length, true);
    view.setUint32(offset + 22, item.entry.data.length, true);
    view.setUint16(offset + 26, item.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    buffer.set(item.nameBytes, offset + 30);
    buffer.set(item.compressed, offset + 30 + item.nameBytes.length);
    localCursor += 30 + item.nameBytes.length + item.compressed.length;
  }

  const centralDirectoryOffset = localCursor;
  let centralCursor = centralDirectoryOffset;
  for (let index = 0; index < prepared.length; index++) {
    const item = prepared[index]!;
    const localOffset = localHeaderOffsets[index]!;
    view.setUint32(centralCursor + 0, 0x02014b50, true);
    view.setUint16(centralCursor + 4, 0x0014, true);
    view.setUint16(centralCursor + 6, 20, true);
    view.setUint16(centralCursor + 8, 0, true);
    view.setUint16(centralCursor + 10, item.entry.method, true);
    view.setUint16(centralCursor + 12, dosTime, true);
    view.setUint16(centralCursor + 14, dosDate, true);
    view.setUint32(centralCursor + 16, item.crc, true);
    view.setUint32(centralCursor + 20, item.compressed.length, true);
    view.setUint32(centralCursor + 24, item.entry.data.length, true);
    view.setUint16(centralCursor + 28, item.nameBytes.length, true);
    view.setUint16(centralCursor + 30, 0, true);
    view.setUint16(centralCursor + 32, 0, true);
    view.setUint16(centralCursor + 34, 0, true);
    view.setUint16(centralCursor + 36, 0, true);
    view.setUint32(centralCursor + 38, 0, true);
    view.setUint32(centralCursor + 42, localOffset, true);
    buffer.set(item.nameBytes, centralCursor + 46);
    centralCursor += 46 + item.nameBytes.length;
  }

  const centralDirectorySize = centralCursor - centralDirectoryOffset;
  view.setUint32(centralCursor + 0, 0x06054b50, true);
  view.setUint16(centralCursor + 4, 0, true);
  view.setUint16(centralCursor + 6, 0, true);
  view.setUint16(centralCursor + 8, entries.length, true);
  view.setUint16(centralCursor + 10, entries.length, true);
  view.setUint32(centralCursor + 12, centralDirectorySize, true);
  view.setUint32(centralCursor + 16, centralDirectoryOffset, true);
  view.setUint16(centralCursor + 20, 0, true);
  return buffer;
}

interface ParsedMediaPath {
  readonly archivePath: string;
  readonly bundleRelativePath: string;
}

/** A single deliberate decode, then a relative POSIX path only. */
function parseMediaReferenceUrl(rawUrl: string): ParsedMediaPath {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) bundleRefusal('Empty media reference path');
  if (trimmed.length > MAX_RAW_REFERENCE_CHARS || trimmed.includes('\0')) {
    bundleRefusal('Media reference path exceeds the supported bound');
  }

  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) &&
    !trimmed.startsWith('file:')
  ) {
    bundleRefusal(`Prohibited URL scheme in media reference: ${trimmed}`);
  }
  if (trimmed.startsWith('//')) {
    bundleRefusal(`Network authority escape in media reference: ${trimmed}`);
  }

  let pathPart = trimmed;
  if (pathPart.startsWith('file:')) {
    pathPart = pathPart.slice(5);
    if (pathPart.startsWith('///')) {
      bundleRefusal(
        `Absolute file URL prohibited in media reference: ${trimmed}`
      );
    }
    if (pathPart.startsWith('//')) {
      bundleRefusal(`File URL authority escape in media reference: ${trimmed}`);
    }
  }
  if (pathPart.includes('\\')) {
    bundleRefusal(`Backslashes prohibited in media reference: ${trimmed}`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    bundleRefusal(`Malformed percent encoding in media reference: ${trimmed}`);
  }
  if (decoded.length > MAX_ZIP_FILENAME_BYTES || decoded.includes('\0')) {
    bundleRefusal(
      `Decoded media reference is too long or contains a null byte: ${trimmed}`
    );
  }
  if (decoded.startsWith('/') || /^[a-zA-Z]:/.test(decoded)) {
    bundleRefusal(`Absolute path prohibited in media reference: ${trimmed}`);
  }

  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '..') {
      bundleRefusal(
        `Path traversal (..) prohibited in media reference: ${trimmed}`
      );
    }
    if (segment !== '' && segment !== '.') segments.push(segment);
  }
  if (segments.length === 0)
    bundleRefusal(`Empty media reference path: ${trimmed}`);

  const bundleRelativePath = segments.join('/');
  const archivePath = bundleRelativePath.startsWith('media/')
    ? bundleRelativePath
    : `media/${bundleRelativePath}`;
  utf8Length(archivePath, `Media archive path ${JSON.stringify(archivePath)}`);
  return { archivePath, bundleRelativePath };
}

class MediaCollector {
  readonly results = new Map<string, string>();
  private candidateWork = 0;
  private headerBytes = 0;

  constructor(
    private readonly maxCandidateWork: number,
    private readonly maxHeaderBytes: number
  ) {}

  reserveCandidateWork(count: number): void {
    if (!Number.isSafeInteger(count) || count <= 0) {
      bundleRefusal('Media candidate count is not a positive safe integer');
    }
    if (count > this.maxCandidateWork - this.candidateWork) {
      bundleRefusal(
        `Media reference expansion exceeds the ${this.maxCandidateWork}-candidate budget`
      );
    }
    this.candidateWork += count;
  }

  addUrl(rawUrl: string, countWork = true): void {
    if (countWork) this.reserveCandidateWork(1);
    const parsed = parseMediaReferenceUrl(rawUrl);
    const prior = this.results.get(parsed.archivePath);
    if (prior !== undefined) {
      if (prior !== parsed.bundleRelativePath) {
        bundleRefusal(
          `Distinct media paths ${prior} and ${parsed.bundleRelativePath} collapse onto ${parsed.archivePath}`
        );
      }
      return;
    }
    if (this.results.size >= MAX_MEDIA_ENTRY_COUNT) {
      bundleRefusal(
        `OTIO bundle exceeds the ${MAX_MEDIA_ENTRY_COUNT}-media ZIP entry limit`
      );
    }

    const nameBytes = utf8Length(
      parsed.archivePath,
      `Media archive path ${parsed.archivePath}`
    );
    const contribution = ZIP_ENTRY_HEADER_BYTES + nameBytes * 2;
    if (contribution > this.maxHeaderBytes - this.headerBytes) {
      sizeRefusal(
        'OTIO ZIP filename and header bytes exceed the archive budget'
      );
    }
    this.headerBytes += contribution;
    this.results.set(parsed.archivePath, parsed.bundleRelativePath);
  }
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  where: string
): string {
  const value = record[field];
  if (typeof value !== 'string')
    bundleRefusal(`${where}.${field} must be a string`);
  if (value.length > MAX_RAW_REFERENCE_CHARS) {
    bundleRefusal(`${where}.${field} exceeds the media path bound`);
  }
  return value;
}

function requiredSafeInteger(
  record: Record<string, unknown>,
  field: string,
  where: string
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value))
    bundleRefusal(`${where}.${field} must be a safe integer`);
  return value;
}

function requiredPositiveFinite(
  record: Record<string, unknown>,
  field: string,
  where: string
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    bundleRefusal(`${where}.${field} must be a finite positive number`);
  }
  return value;
}

function sequenceFrameCount(record: Record<string, unknown>): number {
  const where = 'ImageSequenceReference.1';
  const frameStep = requiredSafeInteger(record, 'frame_step', where);
  if (frameStep <= 0)
    bundleRefusal(`${where}.frame_step must be a positive integer`);
  const sequenceRate = requiredPositiveFinite(record, 'rate', where);
  const range = recordAt(record['available_range'], `${where}.available_range`);
  if (schemaAt(range, `${where}.available_range`) !== 'TimeRange.1') {
    bundleRefusal(`${where}.available_range must be TimeRange.1`);
  }
  const duration = recordAt(
    range['duration'],
    `${where}.available_range.duration`
  );
  if (
    schemaAt(duration, `${where}.available_range.duration`) !== 'RationalTime.1'
  ) {
    bundleRefusal(`${where}.available_range.duration must be RationalTime.1`);
  }
  const durationValue = requiredPositiveFinite(
    duration,
    'value',
    `${where}.available_range.duration`
  );
  const durationRate = requiredPositiveFinite(
    duration,
    'rate',
    `${where}.available_range.duration`
  );

  // OTIO rescales duration to rate / frame_step and converts to frames.
  // Math.trunc matches RationalTime::to_frames for a positive availability.
  const rescaled = (durationValue / durationRate) * (sequenceRate / frameStep);
  if (!Number.isFinite(rescaled) || rescaled <= 0) {
    bundleRefusal(
      `${where}.available_range cannot produce a positive frame count`
    );
  }
  const count = Math.trunc(rescaled);
  if (!Number.isSafeInteger(count) || count <= 0) {
    bundleRefusal(`${where}.available_range frame count is unsafe or empty`);
  }
  return count;
}

function frameText(frame: number, padding: number): string {
  const negative = frame < 0;
  const digits = String(Math.abs(frame));
  const paddedLength = Math.max(padding, digits.length);
  if (paddedLength + (negative ? 1 : 0) > MAX_ZIP_FILENAME_BYTES) {
    bundleRefusal('Image sequence frame padding exceeds the filename bound');
  }
  return `${negative ? '-' : ''}${'0'.repeat(paddedLength - digits.length)}${digits}`;
}

function addImageSequence(
  record: Record<string, unknown>,
  collector: MediaCollector
): void {
  const where = 'ImageSequenceReference.1';
  const targetUrlBase = requiredString(record, 'target_url_base', where);
  const namePrefix = requiredString(record, 'name_prefix', where);
  const nameSuffix = requiredString(record, 'name_suffix', where);
  const startFrame = requiredSafeInteger(record, 'start_frame', where);
  const frameStep = requiredSafeInteger(record, 'frame_step', where);
  const padding = requiredSafeInteger(record, 'frame_zero_padding', where);
  if (frameStep <= 0)
    bundleRefusal(`${where}.frame_step must be a positive integer`);
  if (padding < 0)
    bundleRefusal(`${where}.frame_zero_padding must not be negative`);

  const count = sequenceFrameCount(record);
  const finalFrame = startFrame + (count - 1) * frameStep;
  if (!Number.isSafeInteger(finalFrame)) {
    bundleRefusal(`${where} final frame arithmetic exceeds safe integers`);
  }
  const separator =
    targetUrlBase.endsWith('/') || namePrefix.startsWith('/') ? '' : '/';
  const staticLength =
    targetUrlBase.length +
    separator.length +
    namePrefix.length +
    nameSuffix.length;
  const maxFrameLength = Math.max(
    frameText(startFrame, padding).length,
    frameText(finalFrame, padding).length
  );
  if (staticLength + maxFrameLength > MAX_RAW_REFERENCE_CHARS) {
    bundleRefusal(`${where} generated path exceeds the media path bound`);
  }

  // Reserve the whole series before materializing even one padded frame.
  collector.reserveCandidateWork(count);
  for (let index = 0; index < count; index++) {
    const frame = startFrame + index * frameStep;
    if (!Number.isSafeInteger(frame)) {
      bundleRefusal(`${where} frame arithmetic exceeds safe integers`);
    }
    collector.addUrl(
      `${targetUrlBase}${separator}${namePrefix}${frameText(frame, padding)}${nameSuffix}`,
      false
    );
  }
}

function consumeMediaReference(
  value: unknown,
  collector: MediaCollector,
  where: string
): void {
  if (value === null || value === undefined) return;
  const reference = recordAt(value, where);
  const schema = schemaAt(reference, where);
  switch (schema) {
    case 'ExternalReference.1': {
      const target = reference['target_url'];
      if (target === null || target === undefined || target === '') return;
      if (typeof target !== 'string')
        bundleRefusal(`${where}.target_url must be a string`);
      collector.addUrl(target);
      return;
    }
    case 'ImageSequenceReference.1':
      addImageSequence(reference, collector);
      return;
    case 'MissingReference.1':
    case 'GeneratorReference.1':
      return;
    default:
      bundleRefusal(
        `Unsupported OTIO media reference schema ${schema} at ${where}`
      );
  }
}

function collectionChildren(
  record: Record<string, unknown>,
  where: string
): readonly unknown[] {
  const children = record['children'];
  if (!Array.isArray(children))
    bundleRefusal(`${where}.children must be an array`);
  return children;
}

function traverseComposable(
  value: unknown,
  collector: MediaCollector,
  where: string
): void {
  const record = recordAt(value, where);
  const schema = schemaAt(record, where);
  switch (schema) {
    case 'Stack.1':
    case 'Track.1':
    case 'SerializableCollection.1': {
      const children = collectionChildren(record, where);
      for (let index = 0; index < children.length; index++) {
        traverseComposable(
          children[index],
          collector,
          `${where}.children[${index}]`
        );
      }
      return;
    }
    case 'Clip.1':
      consumeMediaReference(
        record['media_reference'],
        collector,
        `${where}.media_reference`
      );
      return;
    case 'Clip.2': {
      const refs = record['media_references'];
      if (refs === null || refs === undefined) return;
      if (typeof refs !== 'object' || Array.isArray(refs)) {
        bundleRefusal(`${where}.media_references must be an object`);
      }
      const mediaReferences = refs as Record<string, unknown>;
      for (const key of Object.keys(mediaReferences).sort()) {
        consumeMediaReference(
          mediaReferences[key],
          collector,
          `${where}.media_references.${key}`
        );
      }
      return;
    }
    // These are composable leaves with no direct media-bearing edge.
    case 'Gap.1':
    case 'Transition.1':
      return;
    default:
      bundleRefusal(`Unsupported structural OTIO schema ${schema} at ${where}`);
  }
}

/**
 * Enumerate only actual OTIO compositional edges. Metadata and extension fields
 * are intentionally never traversed because they cannot authorize a disk read.
 */
export function collectReferencedMedia(
  obj: unknown,
  results: Map<string, string>,
  options?: {
    readonly maxHeaderBytes?: number;
    readonly maxCandidateWork?: number;
  }
): void {
  const root = recordAt(obj, 'content.otio');
  const schema = schemaAt(root, 'content.otio');
  const collector = new MediaCollector(
    options?.maxCandidateWork ?? MAX_MEDIA_ENTRY_COUNT,
    options?.maxHeaderBytes ?? MAX_EXPANDED_ZIP_BYTES
  );

  if (schema === 'Timeline.1') {
    const tracks = recordAt(root['tracks'], 'Timeline.1.tracks');
    if (schemaAt(tracks, 'Timeline.1.tracks') !== 'Stack.1') {
      bundleRefusal('Timeline.1.tracks must be Stack.1');
    }
    traverseComposable(tracks, collector, 'Timeline.1.tracks');
  } else {
    traverseComposable(root, collector, 'content.otio');
  }

  for (const [archivePath, sourcePath] of collector.results) {
    results.set(archivePath, sourcePath);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

async function readHeldFile(
  file: ConfinedBundleFile,
  relativePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  const size = file.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    bundleRefusal(`Securely opened ${relativePath} has an invalid fstat size`);
  }
  if (size > maxBytes) {
    sizeRefusal(
      `Securely opened ${relativePath} size (${size} bytes) exceeds remaining bundle limit of ${maxBytes} bytes`
    );
  }
  const bytes = await file.readBounded(maxBytes);
  if (!(bytes instanceof Uint8Array)) {
    bundleRefusal(`Securely opened ${relativePath} returned non-byte data`);
  }
  if (bytes.length > maxBytes || bytes.length !== size) {
    bundleRefusal(
      `Securely opened ${relativePath} changed while being read or exceeded its byte budget`
    );
  }
  return bytes;
}

async function readRegular(
  root: ConfinedBundleDirectory,
  relativePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  const file = await root.openRegular(relativePath);
  try {
    return await readHeldFile(file, relativePath, maxBytes);
  } finally {
    await file.close();
  }
}

async function readMediaRegular(
  root: ConfinedBundleDirectory,
  relativePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  let file: ConfinedBundleFile;
  let openedPath = relativePath;
  try {
    file = await root.openRegular(relativePath);
  } catch (error) {
    // The alternate media/ root is compatibility only. It is never a response
    // to a symlink, non-directory component, permission problem, or special file.
    if (!isNotFound(error) || relativePath.startsWith('media/')) throw error;
    openedPath = `media/${relativePath}`;
    file = await root.openRegular(openedPath);
  }
  try {
    return await readHeldFile(file, openedPath, maxBytes);
  } finally {
    await file.close();
  }
}

function baseZipHeaderBytes(): number {
  return (
    ZIP_ENTRY_HEADER_BYTES +
    utf8Length('content.otio', 'content.otio') * 2 +
    ZIP_ENTRY_HEADER_BYTES +
    utf8Length('version.txt', 'version.txt') * 2 +
    22
  );
}

/**
 * Securely package an .otiod directory into a standard deterministic .otioz.
 * Every descendant read remains attached to the root descriptor opened below.
 */
export async function bundleOtiod(
  directoryPath: string,
  files: FileReader,
  options?: BundleOtiodOptions
): Promise<BundleOtiodResult> {
  const limit = effectiveBundleLimit(options);
  const resolvedDir = files.resolve(directoryPath);
  let root: ConfinedBundleDirectory;
  try {
    root = await files.openBundleRoot(resolvedDir);
  } catch (error) {
    throw new PublishError(
      'source_not_regular_file',
      `could not securely open .otiod root ${resolvedDir}: ${(error as Error).message}`
    );
  }

  try {
    // version.txt is fixed, but it consumes the same expanded-byte budget as
    // every disk-backed entry before content.otio is ever opened.
    let aggregateUncompressed = VERSION_BYTES.length;
    if (aggregateUncompressed > limit) {
      sizeRefusal(`version.txt exceeds limit of ${limit} bytes`);
    }

    let contentOtioBytes: Uint8Array;
    try {
      contentOtioBytes = await readRegular(
        root,
        'content.otio',
        limit - aggregateUncompressed
      );
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new PublishError(
        'source_unreadable',
        `could not securely read content.otio in ${resolvedDir}: ${(error as Error).message}`
      );
    }
    aggregateUncompressed += contentOtioBytes.length;

    let otioJson: unknown;
    try {
      otioJson = parseOtioJson(contentOtioBytes);
    } catch (error) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Invalid OTIO JSON in content.otio: ${(error as Error).message}`
      );
    }
    if (!isRecord(otioJson))
      bundleRefusal('content.otio root must be an object');

    const mediaRefMap = new Map<string, string>();
    collectReferencedMedia(otioJson, mediaRefMap, {
      maxCandidateWork: MAX_MEDIA_ENTRY_COUNT,
      maxHeaderBytes: limit - baseZipHeaderBytes(),
    });

    const mediaEntries: Array<{
      readonly name: string;
      readonly data: Uint8Array;
    }> = [];
    for (const archivePath of Array.from(mediaRefMap.keys()).sort()) {
      const bundleRelativePath = mediaRefMap.get(archivePath)!;
      let fileBytes: Uint8Array;
      try {
        fileBytes = await readMediaRegular(
          root,
          bundleRelativePath,
          limit - aggregateUncompressed
        );
      } catch (error) {
        if (error instanceof PublishError) throw error;
        throw new PublishError(
          'source_unreadable',
          `Could not securely read referenced media ${bundleRelativePath}: ${(error as Error).message}`
        );
      }
      aggregateUncompressed += fileBytes.length;
      mediaEntries.push({ name: archivePath, data: fileBytes });
    }

    const zipEntries: ZipFileEntry[] = [
      { name: 'content.otio', data: contentOtioBytes, method: 8 },
      { name: 'version.txt', data: VERSION_BYTES, method: 8 },
      ...mediaEntries.map((entry) => ({
        name: entry.name,
        data: entry.data,
        method: 0 as const,
      })),
    ];
    const zipBytes = buildZipArchive(zipEntries, limit);

    try {
      await indexOtioZip(zipBytes, {
        maxExpandedBytes: limit,
        inflater: async (compressed, _uncompressedSize, maxBytes) =>
          new Uint8Array(
            inflateRawSync(compressed, { maxOutputLength: maxBytes })
          ),
      });
    } catch (error) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Self-validation of generated .otioz archive failed: ${(error as Error).message}`
      );
    }

    const base = files.basename(resolvedDir);
    return {
      bytes: zipBytes,
      defaultFilename: base.toLowerCase().endsWith('.otiod')
        ? `${base.slice(0, -6)}.otioz`
        : `${base}.otioz`,
      resolvedPath: resolvedDir,
    };
  } finally {
    await root.close();
  }
}
