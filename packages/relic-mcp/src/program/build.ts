/**
 * Puts a rendered program into an OTIO archive before encryption.
 *
 * Every archive this accepts ends with a manifest. Each timeline is either
 * rendered, or focus-only with a reason the manifest carries, so a reader can
 * never fall back to a full composite the publisher did not select. When that
 * cannot be delivered honestly, the publish is refused with an exact reason.
 * Nothing is stripped silently and nothing is degraded silently.
 *
 * Reasons in the manifest are read by link holders. They carry a fixed code
 * and a fixed sentence, never a path, an environment value, or raw error text.
 *
 * The output is returned as parts, not one buffer. Source entries keep their
 * exact stored bytes, names and methods: the source's local entries and its
 * central directory pass through as views of the source, and the publisher
 * adds only a new manifest, the rendered programs, their headers, and a new
 * tail. The archive gains relic/program.json (DEFLATE) and one
 * relic/program/timeline-<i>.mp4 per rendered timeline (STORED).
 *
 * The plan is exact. Every size the reader enforces is computed here before
 * anything is rendered or allocated, from the reader's own validators, so a
 * refusal is a fact about the archive and not a guess that a retry corrects.
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  compareRationalTimes,
  crc32,
  indexOtioZip,
  MAX_EXPANDED_ZIP_BYTES,
  MAX_INFLATED_ZIP_BYTES,
  MAX_OTIO_PROGRAM_MANIFEST_BYTES,
  MAX_OTIO_PROGRAM_TIMELINES,
  MAX_ZIP_DIRECTORY_BYTES,
  OTIO_PROGRAM_MANIFEST_ENTRY,
  OTIO_PROGRAM_MAX_BYTES,
  OTIO_PROGRAM_PROTOCOL,
  OTIO_PROGRAM_SCHEMA,
  OtioProgramError,
  type OtioDocumentV1,
  type OtioMediaEntry,
  type OtioProgramManifestV1,
  type OtioProgramTimelineRecord,
  type OtioTimeRange,
  type OtioZipIndex,
  otioDocumentMediaPaths,
  otioProgramEntryName,
  parseOtioProgramRenderer,
  parseOtioProgramTimelineRecord,
  readOtioDocument,
  readOtioProgramArchive,
  stringifyOtioJson,
  stringifyOtioProgramManifest,
  type ZipSource,
} from '@relic/format';
import {
  writeZipCentralRecord,
  writeZipEnd,
  writeZipLocalHeader,
  type ZipEntryRecord,
  ZIP_CENTRAL_HEADER_BYTES,
  ZIP_END_BYTES,
  ZIP_LOCAL_HEADER_BYTES,
} from '../otio-bundle.ts';
import { PublishError } from '../publish.ts';
import {
  programArchiveBudget,
  programRenderInputWithinBounds,
  type ProgramPolicy,
} from './policy.ts';
import {
  RENDER_MESSAGES,
  type ProgramRenderer,
  type ProgramRenderOutput,
} from './render.ts';
import { ProgramStorageError } from './ramdisk.ts';
import {
  notApplicableReport,
  type ProgramReason,
  type ProgramReport,
  type ProgramTimelineReport,
  rawOtioReport,
} from './report.ts';

export interface ProgramBuildInput {
  /** The source archive bytes, as readSource returned them. */
  readonly archive: Uint8Array;
  /** The source name, after .otiod packaging. Decides which OTIO path applies. */
  readonly sourceName: string;
  /** The server's cap for the uploaded object. */
  readonly sizeLimit: number;
  readonly policy: ProgramPolicy;
  readonly renderer: ProgramRenderer | undefined;
  /** Recorded in the manifest as the renderer's client name. */
  readonly clientName: string;
}

/**
 * The output as parts. `parts` references the source and the renderer's MP4s,
 * and nothing archive-sized is copied. `concat(parts)` is the archive.
 */
export interface ProgramBuildResult {
  readonly parts: readonly Uint8Array[];
  readonly length: number;
  readonly report: ProgramReport;
}

/**
 * Upper bound on (any shipped-renderer record) minus (the size-cap record),
 * for one timeline. Proven by test.
 */
export const PROGRAM_RECORD_RESERVE_BYTES = 2048;
/** Upper bound on the browser string's growth over "none". */
export const RENDERER_IDENTITY_RESERVE_BYTES = 1024;

export type ProgramLimit =
  | 'manifest-bytes'
  | 'program-bytes'
  | 'deflate-bytes'
  | 'expanded-bytes'
  | 'entry-count'
  | 'directory-bytes'
  | 'archive-bytes';

/** The size_basis every size refusal reports, by the limit it names. */
const SIZE_BASIS: Record<ProgramLimit, string | undefined> = {
  'archive-bytes': 'whole-archive',
  'expanded-bytes': 'expanded-entries',
  'deflate-bytes': 'deflate-entries',
  'directory-bytes': 'central-directory',
  'program-bytes': 'program',
  'manifest-bytes': 'manifest',
  'entry-count': undefined,
};

const MAX_REASON_MESSAGE_CHARS = 512;
const MAX_REASONS_PER_TIMELINE = 64;
/** The reader's entry-count sentinel is 0xFFFF, so a count must stay below it. */
const ZIP_MAX_ENTRY_COUNT = 0xfffe;

const TEXT_ENCODER = new TextEncoder();
const MANIFEST_NAME = TEXT_ENCODER.encode(OTIO_PROGRAM_MANIFEST_ENTRY);

/** Fixed sentences for the decisions this module makes. No local detail appears in any of them. */
export const BUILD_MESSAGES = {
  sizeCap: 'the program would take the archive past the program budget',
  manifestWontFit:
    'the program manifest does not fit the cap, so focus-only playback cannot be delivered honestly',
  manifestSizeCap:
    'the program manifest exceeds the 16 MiB manifest cap, so the publish is refused rather than dropping the program',
  manifestUnbindable:
    'the document’s timelines cannot be recorded in a program manifest, so the publish is refused',
  outputUnverified: 'the program output failed its own verification',
  storageRelease: 'program storage made for this publish could not be released',
  storageEnforce: 'program storage could not be enforced for this publish',
  renderInput:
    'the program media is over the render input limit, so this timeline is focus-only',
  timelineCount:
    'the document has more timelines than a program manifest can list, so the publish is refused',
  clientInvalid:
    'the publishing client name cannot be recorded in a program manifest',
  sizeLimitInvalid:
    'the size limit for this publish is not a positive whole number',
  programInvalid:
    'the renderer described this program outside the supported bounds',
  programRange: 'the program range does not match this timeline',
  reasonsInvalid: 'the renderer gave no valid reason for this timeline',
  browserIdentity:
    'the renderer did not identify its browser, so this timeline has no program',
  unsafeEntry:
    'the archive contains an entry whose name is not a canonical OTIO bundle path',
  archiveUnreadable: 'the archive cannot be read as an OTIO bundle',
  documentUnreadable: 'the document in the archive cannot be read',
} as const;

/** Refuse the publish with an exact reason. Nothing is degraded on this path. */
function refuse(
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new PublishError('program_refused', message, {
    ...details,
    program_reason: reason,
  });
}

function archiveKind(sourceName: string): 'otioz' | 'raw' | 'other' {
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.otioz')) return 'otioz';
  if (lower.endsWith('.otio')) return 'raw';
  return 'other';
}

function hasReservedEntries(index: OtioZipIndex): boolean {
  return [...index.entries.keys()].some((name) => name.startsWith('relic/'));
}

function isSafeMediaPath(rest: string): boolean {
  if (rest.length === 0 || rest.startsWith('/') || rest.includes('\\'))
    return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in archive paths.
  if (/[\u0000-\u001f\u007f]/.test(rest)) return false;
  return rest
    .split('/')
    .every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * Accepts only content.otio, version.txt, and media/<safe path>. Anything else
 * is refused, because a name this publisher cannot vouch for has no place in a
 * manifest-bound archive.
 */
function isCanonicalFile(name: string): boolean {
  if (name === 'content.otio' || name === 'version.txt') return true;
  return (
    name.startsWith('media/') && isSafeMediaPath(name.slice('media/'.length))
  );
}

/** A directory is `media` or `media/<safe path>` and nothing else. */
function isCanonicalDirectory(bare: string): boolean {
  if (bare === 'media') return true;
  return (
    bare.startsWith('media/') && isSafeMediaPath(bare.slice('media/'.length))
  );
}

function truncate(message: string): string {
  return message.length <= MAX_REASON_MESSAGE_CHARS
    ? message
    : `${message.slice(0, MAX_REASON_MESSAGE_CHARS - 1)}…`;
}

function clampReasons(reasons: readonly ProgramReason[]): ProgramReason[] {
  return reasons.slice(0, MAX_REASONS_PER_TIMELINE).map((r) => ({
    ...r,
    message: truncate(r.message),
  }));
}

function utf8Length(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Sizes of the archive as the publisher can read it: everything the source
 * keeps, which the planner needs to bound what it adds.
 */
export interface ArchiveFacts {
  /** Bytes before the central directory: the source's local entries. */
  readonly prefixBytes: number;
  readonly directoryBytes: number;
  readonly entryCount: number;
  readonly commentBytes: number;
  /** Sum of uncompressedSize over every source entry. */
  readonly expandedBytes: number;
  /** Sum of uncompressedSize over every DEFLATE source entry. */
  readonly deflateBytes: number;
}

/** The new members a program archive adds: the manifest and k programs. */
export interface ProgramPlanSize {
  readonly manifestBytes: number;
  readonly manifestCompressedBytes: number;
  readonly programCount: number;
  /** Sum of the byte lengths of the program entry names. */
  readonly programNameBytes: number;
  /** Sum of the rendered MP4 lengths. */
  readonly programBytes: number;
}

/** Upper bound on a DEFLATE stream for n input bytes, zlib's stored-block worst case. */
export function deflateRawBound(n: number): number {
  return n + Math.floor((n + 7) / 8) + Math.floor((n + 63) / 64) + 5;
}

/** The exact size of the archive with the manifest and k programs added. */
export function programArchiveBytes(
  f: ArchiveFacts,
  p: ProgramPlanSize
): number {
  const k = p.programCount;
  return (
    f.prefixBytes +
    (ZIP_LOCAL_HEADER_BYTES +
      MANIFEST_NAME.length +
      p.manifestCompressedBytes) +
    (ZIP_LOCAL_HEADER_BYTES * k + p.programNameBytes + p.programBytes) +
    f.directoryBytes +
    ZIP_CENTRAL_HEADER_BYTES +
    MANIFEST_NAME.length +
    (ZIP_CENTRAL_HEADER_BYTES * k + p.programNameBytes) +
    ZIP_END_BYTES +
    f.commentBytes
  );
}

export interface BrokenProgramLimit {
  readonly limit: ProgramLimit;
  readonly allowed: number;
  readonly declared: number;
}

/**
 * The first limit a plan breaks, in the order the reader would meet them, or
 * undefined when the plan fits every limit the reader enforces. Each limit is
 * the reader's own bound, not a publisher policy.
 */
export function brokenProgramLimit(
  budget: number,
  f: ArchiveFacts,
  p: ProgramPlanSize
): BrokenProgramLimit | undefined {
  const mu = p.manifestBytes;
  const sp = p.programBytes;
  const k = p.programCount;
  if (mu > MAX_OTIO_PROGRAM_MANIFEST_BYTES) {
    return {
      limit: 'manifest-bytes',
      allowed: MAX_OTIO_PROGRAM_MANIFEST_BYTES,
      declared: mu,
    };
  }
  if (mu + sp > OTIO_PROGRAM_MAX_BYTES) {
    return {
      limit: 'program-bytes',
      allowed: OTIO_PROGRAM_MAX_BYTES,
      declared: mu + sp,
    };
  }
  if (f.deflateBytes + mu > MAX_INFLATED_ZIP_BYTES) {
    return {
      limit: 'deflate-bytes',
      allowed: MAX_INFLATED_ZIP_BYTES,
      declared: f.deflateBytes + mu,
    };
  }
  if (f.expandedBytes + mu + sp > MAX_EXPANDED_ZIP_BYTES) {
    return {
      limit: 'expanded-bytes',
      allowed: MAX_EXPANDED_ZIP_BYTES,
      declared: f.expandedBytes + mu + sp,
    };
  }
  if (f.entryCount + 1 + k > ZIP_MAX_ENTRY_COUNT) {
    return {
      limit: 'entry-count',
      allowed: ZIP_MAX_ENTRY_COUNT,
      declared: f.entryCount + 1 + k,
    };
  }
  const directory =
    f.directoryBytes +
    ZIP_CENTRAL_HEADER_BYTES +
    MANIFEST_NAME.length +
    ZIP_CENTRAL_HEADER_BYTES * k +
    p.programNameBytes;
  if (directory > MAX_ZIP_DIRECTORY_BYTES) {
    return {
      limit: 'directory-bytes',
      allowed: MAX_ZIP_DIRECTORY_BYTES,
      declared: directory,
    };
  }
  const archive = programArchiveBytes(f, p);
  if (archive > budget) {
    return { limit: 'archive-bytes', allowed: budget, declared: archive };
  }
  return undefined;
}

/**
 * The render budget: the most rendered program bytes all timelines may use
 * together, with the manifest at `manifestBytes` (the reserved size) and one
 * program name per timeline. It is the smallest of the archive room, the
 * program bound, and the expanded-bytes room, so the renderer never has to be
 * told a larger number than the plan can accept.
 */
export function programRenderBudget(i: {
  readonly budget: number;
  readonly facts: ArchiveFacts;
  readonly manifestBytes: number;
  readonly timelineCount: number;
}): number {
  let names = 0;
  for (let t = 0; t < i.timelineCount; t++) {
    names += utf8Length(otioProgramEntryName(t));
  }
  const archive = programArchiveBytes(i.facts, {
    manifestBytes: i.manifestBytes,
    manifestCompressedBytes: deflateRawBound(i.manifestBytes),
    programCount: i.timelineCount,
    programNameBytes: names,
    programBytes: 0,
  });
  return Math.min(
    i.budget - archive,
    OTIO_PROGRAM_MAX_BYTES - i.manifestBytes,
    MAX_EXPANDED_ZIP_BYTES - i.facts.expandedBytes - i.manifestBytes
  );
}

/** The refusal details for one broken limit, in the published shape. */
function limitDetails(b: BrokenProgramLimit): Record<string, unknown> {
  if (b.limit === 'entry-count') {
    return {
      limit: 'entry-count',
      entry_limit: b.allowed,
      declared_entries: b.declared,
    };
  }
  return {
    limit: b.limit,
    size_limit_bytes: b.allowed,
    declared_size_bytes: b.declared,
    size_basis: SIZE_BASIS[b.limit],
  };
}

/** Every timeline is unavailable for one stated reason, and no browser ran. */
function skippedRenderOutput(
  timelineIds: readonly string[],
  message: string
): ProgramRenderOutput {
  return {
    browser: 'none',
    outcomes: timelineIds.map(() => ({
      status: 'unavailable' as const,
      reasons: [{ code: 'size-cap-exceeded' as const, message }],
    })),
  };
}

/** No renderer is configured: every timeline is unavailable, and the manifest says why. */
function noRendererOutput(timelineIds: readonly string[]): ProgramRenderOutput {
  const message =
    'this publisher has no program renderer, so this timeline has no program';
  return {
    browser: 'none',
    outcomes: timelineIds.map(() => ({
      status: 'unavailable' as const,
      reasons: [{ code: 'unsupported-browser' as const, message }],
    })),
  };
}

/** True for a name that publishes as an OTIO archive, which always carries a manifest. */
export function isOtioBundleName(name: string): boolean {
  return archiveKind(name) === 'otioz';
}

/**
 * Reads every entry of the source, refusing any the publisher cannot vouch for,
 * and returns the sha256 of each media entry. Each file is read once through
 * the bounded reader, and nothing is kept: the parts reference the source.
 */
async function censusArchive(
  index: OtioZipIndex
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const [name, info] of index.entries) {
    if (info.isDirectory) {
      const bare = name.endsWith('/') ? name.slice(0, -1) : name;
      if (
        info.rawName !== `${bare}/` ||
        info.compressedSize !== 0 ||
        info.uncompressedSize !== 0 ||
        !isCanonicalDirectory(bare)
      ) {
        refuse('unsafe-entry', BUILD_MESSAGES.unsafeEntry);
      }
      continue;
    }
    if (!isCanonicalFile(name) || info.rawName !== name) {
      refuse('unsafe-entry', BUILD_MESSAGES.unsafeEntry);
    }
    let data: Uint8Array;
    try {
      data = await index.readEntry(name);
    } catch {
      refuse(
        'archive-unreadable',
        'an archive entry does not decompress to its declared size'
      );
    }
    if (name.startsWith('media/')) digests.set(name, sha256Hex(data));
  }
  return digests;
}

/**
 * The sizes the planner needs. The source's central directory and comment are
 * passed through unchanged, so the source must end exactly with them.
 */
function archiveFactsOf(source: Uint8Array, index: OtioZipIndex): ArchiveFacts {
  const d = index.directory;
  if (source.length !== d.offset + d.size + ZIP_END_BYTES + d.commentLength) {
    refuse('archive-unreadable', BUILD_MESSAGES.archiveUnreadable);
  }
  let expandedBytes = 0;
  let deflateBytes = 0;
  for (const info of index.entries.values()) {
    expandedBytes += info.uncompressedSize;
    if (info.method === 8) deflateBytes += info.uncompressedSize;
  }
  return {
    prefixBytes: d.offset,
    directoryBytes: d.size,
    entryCount: d.entryCount,
    commentBytes: d.commentLength,
    expandedBytes,
    deflateBytes,
  };
}

/** The media index the format reads: each media entry under its raw archive name. */
function mediaIndexFrom(
  index: OtioZipIndex,
  digests: ReadonlyMap<string, string>
): Record<string, OtioMediaEntry> {
  const media = Object.create(null) as Record<string, OtioMediaEntry>;
  for (const [name, info] of index.entries) {
    const sha = digests.get(name);
    if (info.isDirectory || sha === undefined) continue;
    media[name] = {
      key: name,
      bundle_path: name,
      size: info.uncompressedSize,
      sha256: sha,
    };
  }
  return media;
}

/**
 * The validated outcome of one timeline: its manifest record, and the MP4 that
 * record describes when the timeline rendered.
 */
interface Candidate {
  readonly record: OtioProgramTimelineRecord;
  readonly mp4?: Uint8Array;
}

function unavailableRecord(
  index: number,
  timelineId: string,
  reasons: readonly ProgramReason[]
): OtioProgramTimelineRecord {
  return {
    timeline_id: timelineId,
    index,
    status: 'unavailable',
    reasons,
  } as OtioProgramTimelineRecord;
}

function focusOnly(
  index: number,
  timelineId: string,
  code: ProgramReason['code'],
  message: string
): Candidate {
  return {
    record: unavailableRecord(index, timelineId, [{ code, message }]),
  };
}

/** The timeline's range in the document, or undefined when it has none. */
function documentRangeOf(
  doc: OtioDocumentV1,
  timelineId: string
): OtioTimeRange | undefined {
  return doc.nodes[timelineId]?.timeline_range ?? undefined;
}

/**
 * Validates one renderer outcome. Never throws: a missing, malformed or
 * mismatched outcome becomes that timeline's fixed reason, and nothing else.
 */
function candidateFor(
  index: number,
  timelineId: string,
  outcome: unknown,
  docRange: OtioTimeRange | undefined
): Candidate {
  if (!isObject(outcome)) {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      RENDER_MESSAGES.noOutcome
    );
  }
  if (outcome['status'] === 'unavailable') {
    const reasonsValue = outcome['reasons'];
    try {
      if (!Array.isArray(reasonsValue)) throw new Error('reasons');
      const reasons = clampReasons(reasonsValue as ProgramReason[]);
      return {
        record: parseOtioProgramTimelineRecord(
          unavailableRecord(index, timelineId, reasons),
          index
        ),
      };
    } catch {
      return focusOnly(
        index,
        timelineId,
        'render-failed',
        BUILD_MESSAGES.reasonsInvalid
      );
    }
  }
  if (outcome['status'] !== 'rendered') {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      RENDER_MESSAGES.noOutcome
    );
  }
  if (outcome['timelineId'] !== timelineId) {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      RENDER_MESSAGES.pageAnsweredOther
    );
  }
  const mp4 = outcome['mp4'];
  if (!(mp4 instanceof Uint8Array) || mp4.length < 1) {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      BUILD_MESSAGES.programInvalid
    );
  }
  const sha = outcome['sha256'];
  if (typeof sha !== 'string' || sha !== sha256Hex(mp4)) {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      RENDER_MESSAGES.digestMismatch
    );
  }
  const program = outcome['program'];
  if (!isObject(program)) {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      BUILD_MESSAGES.programInvalid
    );
  }
  let record: OtioProgramTimelineRecord;
  try {
    // Only the program's own keys reach the parser, plus the fields the
    // publisher computed. Anything else the renderer sent is not carried.
    record = parseOtioProgramTimelineRecord(
      {
        timeline_id: timelineId,
        index,
        status: 'rendered',
        reasons: [],
        program: {
          entry: otioProgramEntryName(index),
          sha256: sha,
          bytes: mp4.length,
          range: program['range'],
          frame_rate: program['frame_rate'],
          frames: program['frames'],
          width: program['width'],
          height: program['height'],
          video_codec: program['video_codec'],
          video_bitrate: program['video_bitrate'],
          audio_codec: program['audio_codec'],
          audio_rate: program['audio_rate'],
          channels: program['channels'],
          audio_samples: program['audio_samples'],
        },
      },
      index
    );
  } catch {
    return focusOnly(
      index,
      timelineId,
      'render-failed',
      BUILD_MESSAGES.programInvalid
    );
  }
  if (record.status !== 'rendered' || docRange === undefined) {
    return focusOnly(
      index,
      timelineId,
      'invalid-timing',
      BUILD_MESSAGES.programRange
    );
  }
  const range = record.program.range;
  if (
    compareRationalTimes(range.start_time, docRange.start_time) !== 0 ||
    compareRationalTimes(range.duration, docRange.duration) !== 0
  ) {
    return focusOnly(
      index,
      timelineId,
      'invalid-timing',
      BUILD_MESSAGES.programRange
    );
  }
  return { record, mp4 };
}

/**
 * The renderer's outcomes as the publisher reads them: validated, never
 * trusted. The browser is one value for the run, so an invalid one gives every
 * timeline the browser-identity reason.
 */
function candidatesFor(
  timelineIds: readonly string[],
  output: ProgramRenderOutput,
  doc: OtioDocumentV1,
  clientName: string
): { browser: string; candidates: Candidate[] } {
  const raw = output as unknown as { browser?: unknown; outcomes?: unknown };
  const outcomes = Array.isArray(raw.outcomes)
    ? (raw.outcomes as unknown[])
    : undefined;
  let browser: string | undefined;
  if (typeof raw.browser === 'string') {
    try {
      parseOtioProgramRenderer({
        client: clientName,
        protocol: OTIO_PROGRAM_PROTOCOL,
        browser: raw.browser,
      });
      browser = raw.browser;
    } catch {
      browser = undefined;
    }
  }
  if (browser === undefined) {
    return {
      browser: 'none',
      candidates: timelineIds.map((id, i) =>
        focusOnly(i, id, 'render-failed', BUILD_MESSAGES.browserIdentity)
      ),
    };
  }
  return {
    browser,
    candidates: timelineIds.map((id, i) =>
      outcomes === undefined
        ? focusOnly(i, id, 'render-failed', RENDER_MESSAGES.noOutcome)
        : candidateFor(i, id, outcomes[i], documentRangeOf(doc, id))
    ),
  };
}

/** Everything about the archive a manifest carries, apart from its timelines. */
interface ManifestIdentity {
  readonly documentSha256: string;
  readonly clientName: string;
  readonly media: Readonly<Record<string, string>>;
}

/** The manifest for one browser and one list of records. */
function manifestFor(
  identity: ManifestIdentity,
  browser: string,
  records: readonly OtioProgramTimelineRecord[]
): OtioProgramManifestV1 {
  return {
    schema: OTIO_PROGRAM_SCHEMA,
    document_sha256: identity.documentSha256,
    renderer: {
      client: identity.clientName,
      protocol: OTIO_PROGRAM_PROTOCOL,
      browser,
    },
    media: identity.media,
    timelines: records,
  };
}

/**
 * The output parts: the source's local entries, the new manifest and programs,
 * the source's central directory, and a new tail with the new central records
 * and the source's comment. The source's offsets are unchanged, because its
 * local entries stay in place at the front.
 */
function assembleParts(
  source: Uint8Array,
  facts: ArchiveFacts,
  manifest: Uint8Array,
  deflated: Uint8Array,
  programs: readonly { readonly index: number; readonly mp4: Uint8Array }[]
): { parts: Uint8Array[]; length: number } {
  const parts: Uint8Array[] = [source.subarray(0, facts.prefixBytes)];
  let at = facts.prefixBytes;

  const manifestRecord: ZipEntryRecord = {
    nameBytes: MANIFEST_NAME,
    method: 8,
    crc32: crc32(manifest),
    compressedSize: deflated.length,
    uncompressedSize: manifest.length,
    localHeaderOffset: at,
  };
  const manifestLocal = new Uint8Array(
    ZIP_LOCAL_HEADER_BYTES + MANIFEST_NAME.length + deflated.length
  );
  const headerLength = writeZipLocalHeader(manifestLocal, 0, manifestRecord);
  manifestLocal.set(deflated, headerLength);
  parts.push(manifestLocal);
  at += manifestLocal.length;

  const programRecords: ZipEntryRecord[] = [];
  for (const program of programs) {
    const nameBytes = TEXT_ENCODER.encode(otioProgramEntryName(program.index));
    const record: ZipEntryRecord = {
      nameBytes,
      method: 0,
      crc32: crc32(program.mp4),
      compressedSize: program.mp4.length,
      uncompressedSize: program.mp4.length,
      localHeaderOffset: at,
    };
    const header = new Uint8Array(ZIP_LOCAL_HEADER_BYTES + nameBytes.length);
    writeZipLocalHeader(header, 0, record);
    parts.push(header, program.mp4);
    programRecords.push(record);
    at += header.length + program.mp4.length;
  }

  const directoryOffset = at;
  parts.push(
    source.subarray(facts.prefixBytes, facts.prefixBytes + facts.directoryBytes)
  );

  const added = [manifestRecord, ...programRecords];
  const centralBytes = added.reduce(
    (total, r) => total + ZIP_CENTRAL_HEADER_BYTES + r.nameBytes.length,
    0
  );
  const tail = new Uint8Array(
    centralBytes + ZIP_END_BYTES + facts.commentBytes
  );
  let cursor = 0;
  for (const record of added) {
    cursor += writeZipCentralRecord(tail, cursor, record);
  }
  writeZipEnd(tail, cursor, {
    entryCount: facts.entryCount + added.length,
    directorySize: facts.directoryBytes + centralBytes,
    directoryOffset,
    comment: source.subarray(source.length - facts.commentBytes),
  });
  parts.push(tail);

  let length = 0;
  for (const part of parts) length += part.length;
  return { parts, length };
}

/**
 * A ZipSource over the output parts, so the reader verifies exactly what is
 * returned. Reads inside one part are views. A read that crosses parts is
 * copied, and the reader only makes such reads across the bounded directory.
 */
function partsSource(parts: readonly Uint8Array[], size: number): ZipSource {
  return {
    size,
    async read(start, end) {
      if (!(start >= 0 && end >= start && end <= size)) {
        throw new Error('read outside the archive');
      }
      const pieces: Uint8Array[] = [];
      let offset = 0;
      for (const part of parts) {
        const partEnd = offset + part.length;
        if (partEnd > start && offset < end) {
          const from = Math.max(start, offset) - offset;
          const to = Math.min(end, partEnd) - offset;
          pieces.push(part.subarray(from, to));
        }
        offset = partEnd;
        if (offset >= end) break;
      }
      if (pieces.length === 1) return pieces[0]!;
      const joined = new Uint8Array(end - start);
      let at = 0;
      for (const piece of pieces) {
        joined.set(piece, at);
        at += piece.length;
      }
      return joined;
    },
  };
}

/**
 * Builds the program archive as parts. Steps 12 to 16 are wrapped so that any
 * error that is not a PublishError becomes refuse('output-invalid').
 */
export async function buildProgramArchive(
  input: ProgramBuildInput
): Promise<ProgramBuildResult> {
  const kind = archiveKind(input.sourceName);
  if (kind === 'other') {
    return {
      parts: [input.archive],
      length: input.archive.length,
      report: notApplicableReport(),
    };
  }
  if (kind === 'raw') {
    return {
      parts: [input.archive],
      length: input.archive.length,
      report: rawOtioReport(),
    };
  }

  // 2 to 4: configuration and identity, before any byte is read.
  if (input.policy.invalid !== undefined) {
    refuse('invalid-config', input.policy.invalid);
  }
  if (!Number.isSafeInteger(input.sizeLimit) || input.sizeLimit <= 0) {
    refuse('invalid-size-limit', BUILD_MESSAGES.sizeLimitInvalid);
  }
  try {
    parseOtioProgramRenderer({
      client: input.clientName,
      protocol: OTIO_PROGRAM_PROTOCOL,
      browser: 'none',
    });
  } catch {
    refuse('invalid-config', BUILD_MESSAGES.clientInvalid);
  }

  // 5: the program budget.
  const budget = programArchiveBudget(input.sizeLimit, input.policy);

  // 6 and 7: index the source, then take its census.
  let index: OtioZipIndex;
  try {
    index = await indexOtioZip(input.archive, {
      maxExpandedBytes: MAX_EXPANDED_ZIP_BYTES,
    });
  } catch {
    refuse('archive-unreadable', BUILD_MESSAGES.archiveUnreadable);
  }
  // A program is generated only by this publisher. An existing relic/ entry is
  // either a stale copy or a forgery, and neither is removed silently.
  if (hasReservedEntries(index)) {
    refuse(
      'entries-present',
      'the archive already contains relic/ entries. Publish the bundle without them: this publisher generates the program itself, and it never strips or keeps entries it did not generate.'
    );
  }
  const digests = await censusArchive(index);
  const facts = archiveFactsOf(input.archive, index);
  const mediaIndex = mediaIndexFrom(index, digests);
  const media: readonly OtioMediaEntry[] = Object.values(mediaIndex);

  // 9: the document, its hash, and the media it references.
  let doc: OtioDocumentV1;
  try {
    doc = readOtioDocument(index.contentOtioBytes, { mediaIndex });
  } catch {
    refuse('archive-unreadable', BUILD_MESSAGES.documentUnreadable);
  }
  if (doc.document_sha256 !== index.contentSha256) {
    refuse(
      'archive-unreadable',
      'the document digest does not match the archive content'
    );
  }
  const timelineIds = doc.timeline_ids;
  // The media the document references, exactly. The manifest and its self-check
  // must agree with this set and no other.
  let referencedPaths: readonly string[];
  try {
    referencedPaths = otioDocumentMediaPaths(doc);
  } catch {
    refuse(
      'media-set-unbindable',
      'the document references more media than a program manifest can bind, so the publish is refused'
    );
  }
  // A ZIP name field holds at most 65535 bytes. Lone surrogates are not well-formed names.
  for (const path of referencedPaths) {
    if (
      new TextEncoder().encode(path).length > 65535 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        path
      )
    ) {
      refuse(
        'unsafe-path',
        'a referenced media name is not a safe archive path'
      );
    }
  }
  if (timelineIds.length === 0) {
    refuse(
      'no-timelines',
      'the document has no timelines, so there is nothing to play'
    );
  }
  if (timelineIds.length > MAX_OTIO_PROGRAM_TIMELINES) {
    refuse('timeline-count', BUILD_MESSAGES.timelineCount);
  }
  const timelineCount = timelineIds.length;

  const mediaMap: Record<string, string> = {};
  for (const path of referencedPaths) {
    const sha = digests.get(path);
    if (sha === undefined) {
      refuse('archive-unreadable', 'a referenced media entry has no digest');
    }
    mediaMap[path] = sha;
  }
  const identity: ManifestIdentity = {
    documentSha256: index.contentSha256,
    clientName: input.clientName,
    media: mediaMap,
  };

  // 10: the baseline B0. Every timeline is unavailable for the size-cap reason,
  // and the browser is "none". Its size is exact, not reserved.
  const baseRecords: OtioProgramTimelineRecord[] = timelineIds.map((id, i) =>
    unavailableRecord(i, id, [
      { code: 'size-cap-exceeded', message: BUILD_MESSAGES.sizeCap },
    ])
  );
  let b0Bytes: Uint8Array;
  try {
    b0Bytes = stringifyOtioProgramManifest(
      manifestFor(identity, 'none', baseRecords)
    );
  } catch (error) {
    if (
      error instanceof OtioProgramError &&
      error.code === 'size-cap-exceeded'
    ) {
      refuse('manifest-size-cap', BUILD_MESSAGES.manifestSizeCap);
    }
    refuse('manifest-unbindable', BUILD_MESSAGES.manifestUnbindable);
  }
  const mu0 = b0Bytes.length;
  const mc0 = deflateRawSync(b0Bytes, { level: 9 }).length;
  const b0Break = brokenProgramLimit(budget, facts, {
    manifestBytes: mu0,
    manifestCompressedBytes: mc0,
    programCount: 0,
    programNameBytes: 0,
    programBytes: 0,
  });
  if (b0Break !== undefined) {
    if (b0Break.limit === 'manifest-bytes') {
      refuse('manifest-size-cap', BUILD_MESSAGES.manifestSizeCap);
    }
    refuse(
      'manifest-unfit',
      BUILD_MESSAGES.manifestWontFit,
      limitDetails(b0Break)
    );
  }

  // 11: the render decision. The reserved manifest size covers every record a
  // shipped renderer can write, and the browser's identity.
  const reserved =
    mu0 +
    timelineCount * PROGRAM_RECORD_RESERVE_BYTES +
    RENDERER_IDENTITY_RESERVE_BYTES;
  const reserveBreak = brokenProgramLimit(budget, facts, {
    manifestBytes: reserved,
    manifestCompressedBytes: deflateRawBound(reserved),
    programCount: 0,
    programNameBytes: 0,
    programBytes: 0,
  });
  let contentText: string;
  try {
    contentText = new TextDecoder('utf-8', { fatal: true }).decode(
      index.contentOtioBytes
    );
  } catch {
    refuse('archive-unreadable', BUILD_MESSAGES.documentUnreadable);
  }

  let output: ProgramRenderOutput;
  const renderBudget = programRenderBudget({
    budget,
    facts,
    manifestBytes: reserved,
    timelineCount,
  });
  if (reserveBreak !== undefined) {
    // Even one program cannot fit beside the base. No browser starts.
    output = skippedRenderOutput(timelineIds, BUILD_MESSAGES.sizeCap);
  } else if (!programRenderInputWithinBounds(media)) {
    // The page would receive more media than one render may take. No browser starts.
    output = skippedRenderOutput(timelineIds, BUILD_MESSAGES.renderInput);
  } else if (!(renderBudget >= 1)) {
    // Nothing is left for a program. No browser starts.
    output = skippedRenderOutput(timelineIds, BUILD_MESSAGES.sizeCap);
  } else {
    try {
      output =
        input.renderer === undefined
          ? noRendererOutput(timelineIds)
          : await input.renderer({
              contentText,
              documentSha256: index.contentSha256,
              timelineIds,
              media,
              readMedia: (bundlePath) => index.readEntry(bundlePath),
              maxTotalBytes: renderBudget,
              forceEncoderAbsent: input.policy.forceEncoderAbsent,
            });
    } catch (error) {
      if (error instanceof ProgramStorageError) {
        // Storage this publisher made could not be released or enforced. Degrading
        // would leave that state behind unreported, so the publish is refused.
        refuse(
          error.cleanupFailed
            ? 'profile-storage-failed'
            : 'profile-storage-unenforced',
          error.cleanupFailed
            ? BUILD_MESSAGES.storageRelease
            : BUILD_MESSAGES.storageEnforce
        );
      }
      output = {
        browser: 'none',
        outcomes: timelineIds.map(() => ({
          status: 'unavailable' as const,
          reasons: [
            {
              code: 'render-failed' as const,
              message: RENDER_MESSAGES.renderFailed,
            },
          ],
        })),
      };
    }
  }

  let assembled: { parts: Uint8Array[]; length: number; report: ProgramReport };
  try {
    // 12: validate every outcome. This step never throws; a missing or unknown
    // outcome gets its fixed reason.
    const { browser, candidates } = candidatesFor(
      timelineIds,
      output,
      doc,
      input.clientName
    );

    // 13: admission, in index order. Mu is exact: the baseline plus each
    // admitted record's length change, plus the browser's length change.
    const browserDelta =
      utf8Length(stringifyOtioJson(browser)) -
      utf8Length(stringifyOtioJson('none'));
    let mu = mu0 + browserDelta;
    const admitted: OtioProgramTimelineRecord[] = [...baseRecords];
    const programs: { index: number; mp4: Uint8Array }[] = [];
    let programBytes = 0;
    let programNames = 0;
    for (let i = 0; i < timelineCount; i++) {
      const candidate = candidates[i]!;
      const mp4 = candidate.mp4;
      const nameBytes =
        mp4 === undefined ? 0 : utf8Length(otioProgramEntryName(i));
      const nextMu =
        mu +
        utf8Length(stringifyOtioJson(candidate.record)) -
        utf8Length(stringifyOtioJson(baseRecords[i]!));
      const plan: ProgramPlanSize = {
        manifestBytes: nextMu,
        manifestCompressedBytes: deflateRawBound(nextMu),
        programCount: programs.length + (mp4 === undefined ? 0 : 1),
        programNameBytes: programNames + nameBytes,
        programBytes: programBytes + (mp4?.length ?? 0),
      };
      if (brokenProgramLimit(budget, facts, plan) !== undefined) {
        // Dropped: this timeline keeps its size-cap record.
        continue;
      }
      admitted[i] = candidate.record;
      mu = nextMu;
      if (mp4 !== undefined) {
        programs.push({ index: i, mp4 });
        programBytes += mp4.length;
        programNames += nameBytes;
      }
    }

    // 14: the final manifest, exactly sized, then the exact plan.
    const manifest = stringifyOtioProgramManifest(
      manifestFor(identity, browser, admitted)
    );
    if (manifest.length !== mu) {
      throw new Error(
        'the manifest length accounting drifted from its records'
      );
    }
    const deflated = deflateRawSync(manifest, { level: 9 });
    if (deflated.length > deflateRawBound(mu)) {
      throw new Error('the compressed manifest exceeds its bound');
    }
    const finalBreak = brokenProgramLimit(budget, facts, {
      manifestBytes: mu,
      manifestCompressedBytes: deflated.length,
      programCount: programs.length,
      programNameBytes: programNames,
      programBytes,
    });
    if (finalBreak !== undefined) {
      throw new Error(`the admitted plan breaks the ${finalBreak.limit} limit`);
    }

    // 15: the parts, whose size is exactly the plan's size.
    const { parts, length } = assembleParts(
      input.archive,
      facts,
      manifest,
      deflated,
      programs
    );
    const expected = programArchiveBytes(facts, {
      manifestBytes: mu,
      manifestCompressedBytes: deflated.length,
      programCount: programs.length,
      programNameBytes: programNames,
      programBytes,
    });
    if (length !== expected || length > budget) {
      throw new Error('the assembled archive differs from its planned size');
    }

    // 16: verify through the reader, exactly as a reader would.
    const written = await indexOtioZip(partsSource(parts, length), {
      maxExpandedBytes: MAX_EXPANDED_ZIP_BYTES,
    });
    const verified = await readOtioProgramArchive(written, {
      document_sha256: index.contentSha256,
      timeline_ids: timelineIds,
      media_paths: referencedPaths,
    });
    if (verified === null) {
      throw new Error('the written archive carries no program manifest');
    }

    // 17: the report, from the records that were admitted.
    const timelines: ProgramTimelineReport[] = admitted.map((record) =>
      record.status === 'rendered'
        ? {
            timeline_id: record.timeline_id,
            index: record.index,
            status: 'rendered',
            reasons: [],
            program: {
              bytes: record.program.bytes,
              frames: record.program.frames,
              width: record.program.width,
              height: record.program.height,
            },
          }
        : {
            timeline_id: record.timeline_id,
            index: record.index,
            status: 'unavailable',
            reasons: record.reasons,
          }
    );
    const renderedCount = timelines.filter(
      (t) => t.status === 'rendered'
    ).length;
    const status =
      renderedCount === timelines.length
        ? 'rendered'
        : renderedCount === 0
          ? 'unavailable'
          : 'partial';
    assembled = { parts, length, report: { status, timelines } };
  } catch (error) {
    if (error instanceof PublishError) throw error;
    // An output that fails verification is a defect in this publisher, not a
    // rendering limit. It is never reported as focus-only.
    refuse('output-invalid', BUILD_MESSAGES.outputUnverified);
  }

  return {
    parts: assembled.parts,
    length: assembled.length,
    report: assembled.report,
  };
}
