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
  MAX_INFLATED_ZIP_BYTES,
  OTIO_DOCUMENT_MAX_BYTES,
  PLAINTEXT_CAP_BYTES,
  MAX_OTIO_BUNDLE_MEDIA_ENTRIES,
  type OtioBundleEntryName,
  otioBundleEntryName,
  parseOtioJson,
  readOtioImageSequence,
  sanitizeOtioBundlePath,
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
const MAX_ZIP_FILENAME_BYTES = 0xffff;
export const ZIP_LOCAL_HEADER_BYTES = 30;
export const ZIP_CENTRAL_HEADER_BYTES = 46;
export const ZIP_END_BYTES = 22;
const ZIP_ENTRY_HEADER_BYTES =
  ZIP_LOCAL_HEADER_BYTES + ZIP_CENTRAL_HEADER_BYTES;
// Every entry name is encoded by TextEncoder, so both ZIP headers must mark it UTF-8.
const ZIP_UTF8_FILENAME_FLAG = 0x0800;
// Shared header values: version 20, made by 0x0014, time 0, date 1980-01-01.
const ZIP_VERSION = 20;
const ZIP_MADE_BY = 0x0014;
const ZIP_DOS_TIME = 0x0000;
const ZIP_DOS_DATE = 0x0021;
const VERSION_BYTES = new TextEncoder().encode('1.0.0');
const TEXT_ENCODER = new TextEncoder();
const MAX_RAW_REFERENCE_CHARS = MAX_ZIP_FILENAME_BYTES * 3;

function bundleRefusal(message: string): never {
  throw new PublishError('otio_bundle_invalid', message);
}

function sizeRefusal(message: string): never {
  throw new PublishError('local_size_precheck_failed', message);
}

function inflateRawBounded(compressed: Uint8Array, budget: number): Uint8Array {
  const result = inflateRawSync(compressed, {
    maxOutputLength: Math.max(1, budget),
  });
  const inflated = new Uint8Array(
    result.buffer,
    result.byteOffset,
    result.byteLength
  );
  if (inflated.length > budget) {
    throw new Error(`Inflated ZIP entry exceeds byte budget of ${budget}`);
  }
  return inflated;
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
  const expanded = Math.min(
    PLAINTEXT_CAP_BYTES,
    assertSafeLimit(
      options?.maxExpandedBytes ?? PLAINTEXT_CAP_BYTES,
      'maxExpandedBytes'
    )
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

/** A ZIP entry's facts for layout. Its bytes are written separately. */
export interface ZipLayoutEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

/** Byte offsets and the exact size of an archive, decided before any byte is written. */
export interface ZipLayout {
  readonly localHeaderOffsets: readonly number[];
  readonly directoryOffset: number;
  readonly directorySize: number;
  readonly totalSize: number;
}

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

function assertZipEntryCount(count: number): void {
  if (count >= MAX_ZIP_ENTRY_COUNT) {
    bundleRefusal(
      `ZIP has ${count} entries; this non-ZIP64 writer permits at most ${MAX_ZIP_ENTRY_COUNT - 1}`
    );
  }
}

/**
 * Plans a standard archive from entry sizes alone: offsets, directory size, and
 * the exact total. Count, name, ZIP32, overflow, and budget checks run before
 * any archive-sized allocation.
 */
export function planZipLayout(
  entries: readonly ZipLayoutEntry[],
  maxArchiveBytes: number
): ZipLayout {
  assertZipEntryCount(entries.length);
  assertSafeLimit(maxArchiveBytes, 'maxArchiveBytes');

  const localHeaderOffsets: number[] = [];
  let localTotal = 0;
  let directorySize = 0;
  for (const entry of entries) {
    if (entry.nameBytes.length > MAX_ZIP_FILENAME_BYTES) {
      bundleRefusal(
        `ZIP entry name ${JSON.stringify(entry.name)} exceeds the ZIP filename byte limit`
      );
    }
    if (entry.uncompressedSize > 0xffffffff) {
      bundleRefusal(`ZIP entry ${entry.name} exceeds the ZIP32 size limit`);
    }
    if (entry.compressedSize > 0xffffffff) {
      bundleRefusal(
        `Compressed ZIP entry ${entry.name} exceeds the ZIP32 size limit`
      );
    }
    localHeaderOffsets.push(localTotal);
    localTotal = checkedAdd(
      localTotal,
      checkedAdd(
        ZIP_LOCAL_HEADER_BYTES + entry.nameBytes.length,
        entry.compressedSize,
        'ZIP local header size'
      ),
      'ZIP local headers'
    );
    directorySize = checkedAdd(
      directorySize,
      ZIP_CENTRAL_HEADER_BYTES + entry.nameBytes.length,
      'ZIP central directory'
    );
  }

  const totalSize = checkedAdd(
    checkedAdd(localTotal, directorySize, 'ZIP archive size'),
    ZIP_END_BYTES,
    'ZIP archive size'
  );
  if (totalSize > maxArchiveBytes) {
    sizeRefusal(
      `Generated .otioz archive size (${totalSize} bytes) exceeds limit of ${maxArchiveBytes} bytes`
    );
  }
  return {
    localHeaderOffsets,
    directoryOffset: localTotal,
    directorySize,
    totalSize,
  };
}

/** Writes one entry's local header and compressed payload, and returns its directory record. */
function writeZipEntry(
  archive: Uint8Array,
  offset: number,
  nameBytes: Uint8Array,
  method: 0 | 8,
  data: Uint8Array,
  compressed: Uint8Array
): ZipEntryRecord {
  const record: ZipEntryRecord = {
    nameBytes,
    method,
    crc32: crc32(data),
    compressedSize: compressed.length,
    uncompressedSize: data.length,
    localHeaderOffset: offset,
  };
  writeZipLocalHeader(archive, offset, record);
  archive.set(compressed, offset + ZIP_LOCAL_HEADER_BYTES + nameBytes.length);
  return record;
}

/** Writes the central directory and the end record after the local entries. */
function writeZipDirectory(
  archive: Uint8Array,
  layout: ZipLayout,
  records: readonly ZipEntryRecord[]
): Uint8Array {
  let cursor = layout.directoryOffset;
  for (const record of records) {
    cursor += writeZipCentralRecord(archive, cursor, record);
  }
  writeZipEnd(archive, cursor, {
    entryCount: records.length,
    directorySize: layout.directorySize,
    directoryOffset: layout.directoryOffset,
    comment: new Uint8Array(0),
  });
  return archive;
}

/**
 * Build a standard deterministic ZIP archive. Count and size validation happen
 * before any archive-sized allocation.
 */
export function buildZipArchive(
  entries: readonly ZipFileEntry[],
  maxArchiveBytes = PLAINTEXT_CAP_BYTES
): Uint8Array {
  assertZipEntryCount(entries.length);
  const prepared = entries.map((entry) => {
    utf8Length(entry.name, `ZIP entry name ${JSON.stringify(entry.name)}`);
    return {
      name: entry.name,
      nameBytes: TEXT_ENCODER.encode(entry.name),
      method: entry.method,
      data: entry.data,
      compressed:
        entry.method === 8
          ? deflateRawSync(entry.data, { level: 9 })
          : entry.data,
    };
  });
  const layout = planZipLayout(
    prepared.map((item) => ({
      name: item.name,
      nameBytes: item.nameBytes,
      method: item.method,
      compressedSize: item.compressed.length,
      uncompressedSize: item.data.length,
    })),
    maxArchiveBytes
  );
  const archive = new Uint8Array(layout.totalSize);
  const records = prepared.map((item, index) =>
    writeZipEntry(
      archive,
      layout.localHeaderOffsets[index]!,
      item.nameBytes,
      item.method,
      item.data,
      item.compressed
    )
  );
  return writeZipDirectory(archive, layout, records);
}

interface CollectedMedia {
  readonly relative: string;
  readonly optional: boolean;
}

class MediaCollector {
  readonly results = new Map<OtioBundleEntryName, CollectedMedia>();
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

  addUrl(rawUrl: string, countWork: boolean, optional: boolean): void {
    if (countWork) this.reserveCandidateWork(1);
    if (rawUrl.length > MAX_RAW_REFERENCE_CHARS) {
      bundleRefusal('Media reference path exceeds the supported bound');
    }

    let relative: string;
    try {
      relative = sanitizeOtioBundlePath(rawUrl);
    } catch (error) {
      bundleRefusal(error instanceof Error ? error.message : String(error));
    }
    const archivePath = otioBundleEntryName(relative);
    const prior = this.results.get(archivePath);
    if (prior !== undefined) {
      if (prior.relative !== relative) {
        bundleRefusal(
          `Distinct media paths ${prior.relative} and ${relative} collapse onto ${archivePath}`
        );
      }
      this.results.set(archivePath, {
        relative,
        optional: prior.optional && optional,
      });
      return;
    }
    if (this.results.size >= MAX_OTIO_BUNDLE_MEDIA_ENTRIES) {
      bundleRefusal(
        `OTIO bundle exceeds the ${MAX_OTIO_BUNDLE_MEDIA_ENTRIES}-media ZIP entry limit`
      );
    }

    const nameBytes = utf8Length(
      archivePath,
      `Media archive path ${archivePath}`
    );
    const contribution = ZIP_ENTRY_HEADER_BYTES + nameBytes * 2;
    if (contribution > this.maxHeaderBytes - this.headerBytes) {
      sizeRefusal(
        'OTIO ZIP filename and header bytes exceed the archive budget'
      );
    }
    this.headerBytes += contribution;
    this.results.set(archivePath, { relative, optional });
  }
}

function addImageSequence(
  record: Record<string, unknown>,
  collector: MediaCollector
): void {
  const read = readOtioImageSequence(record);
  if (!read.ok) {
    bundleRefusal(`ImageSequenceReference.1 ${read.reason}`);
  }
  const { sequence } = read;
  if (sequence.count === 0) return;

  collector.reserveCandidateWork(sequence.count);
  for (let index = 0; index < sequence.count; index++) {
    collector.addUrl(sequence.url(index), false, true);
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
      collector.addUrl(target, true, false);
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
  results: Map<OtioBundleEntryName, CollectedMedia>,
  options?: {
    readonly maxHeaderBytes?: number;
    readonly maxCandidateWork?: number;
  }
): void {
  const root = recordAt(obj, 'content.otio');
  const schema = schemaAt(root, 'content.otio');
  const collector = new MediaCollector(
    options?.maxCandidateWork ?? MAX_OTIO_BUNDLE_MEDIA_ENTRIES,
    options?.maxHeaderBytes ?? OTIO_DOCUMENT_MAX_BYTES
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

  for (const [archivePath, media] of collector.results) {
    results.set(archivePath, media);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

/** Refuses a file whose size is not representable or exceeds the remaining budget. */
function heldSize(
  file: ConfinedBundleFile,
  relativePath: string,
  maxBytes: number
): number {
  const size = file.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    bundleRefusal(`Securely opened ${relativePath} has an invalid fstat size`);
  }
  if (size > maxBytes) {
    sizeRefusal(
      `Securely opened ${relativePath} size (${size} bytes) exceeds remaining bundle limit of ${maxBytes} bytes`
    );
  }
  return size;
}

/** content.otio: the size is checked, then one exact allocation is read into. */
async function readRegular(
  root: ConfinedBundleDirectory,
  relativePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  const file = await root.openRegular(relativePath);
  try {
    const bytes = new Uint8Array(heldSize(file, relativePath, maxBytes));
    await file.readInto(bytes);
    return bytes;
  } finally {
    await file.close();
  }
}

interface ProbedMedia {
  readonly openedPath: string;
  readonly size: number;
}

interface PlannedMedia {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly relative: string;
  readonly openedPath: string;
  readonly size: number;
}

/**
 * Pass 1: open a referenced file through the pinned root, size it, and close it.
 * The alternate media/ root is compatibility only. It is never a response to a
 * symlink, non-directory component, permission problem, or special file.
 */
async function probeMediaRegular(
  root: ConfinedBundleDirectory,
  relativePath: string,
  maxBytes: number
): Promise<ProbedMedia> {
  let file: ConfinedBundleFile;
  let openedPath = relativePath;
  try {
    file = await root.openRegular(relativePath);
  } catch (error) {
    if (!isNotFound(error) || relativePath.startsWith('media/')) throw error;
    openedPath = `media/${relativePath}`;
    file = await root.openRegular(openedPath);
  }
  try {
    return { openedPath, size: heldSize(file, openedPath, maxBytes) };
  } finally {
    await file.close();
  }
}

/** Pass 2: reopen a sized file through the pinned root and fill its archive slot. */
async function readPlannedMedia(
  root: ConfinedBundleDirectory,
  media: PlannedMedia,
  target: Uint8Array
): Promise<void> {
  let file: ConfinedBundleFile;
  try {
    file = await root.openRegular(media.openedPath);
  } catch (error) {
    throw new PublishError(
      'source_unreadable',
      `Could not securely read referenced media ${media.relative}: ${(error as Error).message}`
    );
  }
  try {
    if (file.size !== media.size) {
      bundleRefusal(
        `Securely opened ${media.openedPath} changed while being read`
      );
    }
    try {
      await file.readInto(target);
    } catch (error) {
      throw new PublishError(
        'source_unreadable',
        `Could not securely read referenced media ${media.relative}: ${(error as Error).message}`
      );
    }
  } finally {
    await file.close();
  }
}

/** Fixed-entry framing plus the ZIP structures that must fit before media is read. */
function baseZipHeaderBytes(): number {
  return (
    ZIP_ENTRY_HEADER_BYTES +
    utf8Length('content.otio', 'content.otio') * 2 +
    ZIP_ENTRY_HEADER_BYTES +
    utf8Length('version.txt', 'version.txt') * 2 +
    ZIP_END_BYTES
  );
}

/**
 * Securely package an .otiod directory into a standard deterministic .otioz.
 * Every descendant read remains attached to the root descriptor opened below.
 *
 * Pass 1 sizes each referenced file through the pinned root and closes it, so
 * the layout and the single archive allocation are decided before any media byte
 * is read. Pass 2 reopens each file through the same root and reads it straight
 * into its archive slot.
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
        Math.min(limit - aggregateUncompressed, OTIO_DOCUMENT_MAX_BYTES)
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

    const mediaRefMap = new Map<OtioBundleEntryName, CollectedMedia>();
    collectReferencedMedia(otioJson, mediaRefMap, {
      maxCandidateWork: MAX_OTIO_BUNDLE_MEDIA_ENTRIES,
      maxHeaderBytes: Math.min(
        limit - baseZipHeaderBytes(),
        OTIO_DOCUMENT_MAX_BYTES
      ),
    });

    // Pass 1: size every referenced file through the pinned root. No media byte is read.
    const planned: PlannedMedia[] = [];
    for (const archivePath of Array.from(mediaRefMap.keys()).sort()) {
      const media = mediaRefMap.get(archivePath)!;
      let probed: ProbedMedia;
      try {
        probed = await probeMediaRegular(
          root,
          media.relative,
          limit - aggregateUncompressed
        );
      } catch (error) {
        if (error instanceof PublishError) throw error;
        if (media.optional && isNotFound(error)) continue;
        throw new PublishError(
          'source_unreadable',
          `Could not securely read referenced media ${media.relative}: ${(error as Error).message}`
        );
      }
      aggregateUncompressed += probed.size;
      planned.push({
        name: archivePath,
        nameBytes: TEXT_ENCODER.encode(archivePath),
        relative: media.relative,
        openedPath: probed.openedPath,
        size: probed.size,
      });
    }

    // The layout comes from sizes alone. Entry count, names, ZIP32 limits, and
    // the exact total are refused here, before the one archive allocation.
    const contentName = TEXT_ENCODER.encode('content.otio');
    const versionName = TEXT_ENCODER.encode('version.txt');
    const contentCompressed = deflateRawSync(contentOtioBytes, { level: 9 });
    const versionCompressed = deflateRawSync(VERSION_BYTES, { level: 9 });
    const layout = planZipLayout(
      [
        {
          name: 'content.otio',
          nameBytes: contentName,
          method: 8,
          compressedSize: contentCompressed.length,
          uncompressedSize: contentOtioBytes.length,
        },
        {
          name: 'version.txt',
          nameBytes: versionName,
          method: 8,
          compressedSize: versionCompressed.length,
          uncompressedSize: VERSION_BYTES.length,
        },
        ...planned.map((media) => ({
          name: media.name,
          nameBytes: media.nameBytes,
          method: 0 as const,
          compressedSize: media.size,
          uncompressedSize: media.size,
        })),
      ],
      limit
    );
    const archive = new Uint8Array(layout.totalSize);
    const records: ZipEntryRecord[] = [
      writeZipEntry(
        archive,
        layout.localHeaderOffsets[0]!,
        contentName,
        8,
        contentOtioBytes,
        contentCompressed
      ),
      writeZipEntry(
        archive,
        layout.localHeaderOffsets[1]!,
        versionName,
        8,
        VERSION_BYTES,
        versionCompressed
      ),
    ];

    // Pass 2: each file is reopened through the same pinned root and read into its slot.
    for (let index = 0; index < planned.length; index++) {
      const media = planned[index]!;
      const offset = layout.localHeaderOffsets[index + 2]!;
      const dataStart =
        offset + ZIP_LOCAL_HEADER_BYTES + media.nameBytes.length;
      const target = archive.subarray(dataStart, dataStart + media.size);
      await readPlannedMedia(root, media, target);
      const record: ZipEntryRecord = {
        nameBytes: media.nameBytes,
        method: 0,
        crc32: crc32(target),
        compressedSize: media.size,
        uncompressedSize: media.size,
        localHeaderOffset: offset,
      };
      writeZipLocalHeader(archive, offset, record);
      records.push(record);
    }

    writeZipDirectory(archive, layout, records);

    try {
      await indexOtioZip(archive, {
        maxExpandedBytes: limit,
        maxInflatedBytes: MAX_INFLATED_ZIP_BYTES,
        inflater: async (compressed, _uncompressedSize, maxBytes) =>
          inflateRawBounded(compressed, maxBytes),
      });
    } catch (error) {
      throw new PublishError(
        'otio_bundle_invalid',
        `Self-validation of generated .otioz archive failed: ${(error as Error).message}`
      );
    }

    const base = files.basename(resolvedDir);
    return {
      bytes: archive,
      defaultFilename: base.toLowerCase().endsWith('.otiod')
        ? `${base.slice(0, -6)}.otioz`
        : `${base}.otioz`,
      resolvedPath: resolvedDir,
    };
  } finally {
    await root.close();
  }
}
