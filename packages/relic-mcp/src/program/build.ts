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
 * content.otio and every media entry keep their bytes. The archive gains
 * relic/program.json (DEFLATE) and one relic/program/timeline-<i>.mp4 per
 * rendered timeline (STORED).
 */

import {
  indexOtioZip,
  MAX_EXPANDED_ZIP_BYTES,
  MAX_OTIO_PROGRAM_FPS,
  otioDocumentMediaPaths,
  type OtioMediaEntry,
  type OtioProgramManifestV1,
  type OtioZipIndex,
  OTIO_PROGRAM_MANIFEST_ENTRY,
  OTIO_PROGRAM_PROTOCOL,
  OTIO_PROGRAM_SCHEMA,
  otioBundleMediaIndex,
  otioProgramEntryName,
  parseOtioProgramManifest,
  readOtioDocument,
  readOtioProgramArchive,
  stringifyOtioProgramManifest,
} from '@relic/format';
import { buildZipArchive } from '../otio-bundle.ts';
import { PublishError } from '../publish.ts';
import type { ProgramPolicy } from './policy.ts';
import {
  RENDER_MESSAGES,
  type ProgramRenderer,
  type ProgramRenderOutput,
  type ProgramTimelineOutcome,
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

export interface ProgramBuildResult {
  readonly bytes: Uint8Array;
  readonly report: ProgramReport;
}

interface BaseEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

interface Decision {
  readonly index: number;
  readonly timelineId: string;
  readonly reasons: readonly ProgramReason[];
  readonly rendered?:
    | {
        readonly mp4: Uint8Array;
        readonly sha256: string;
        readonly program: Extract<
          ProgramTimelineOutcome,
          { status: 'rendered' }
        >['program'];
      }
    | undefined;
}

/** Headroom for the manifest's JSON, sized for timelines with several reasons. */
const MANIFEST_RESERVE_BYTES = 8192;
const MANIFEST_RESERVE_PER_TIMELINE = 2048;
/** Local and central directory headers plus the entry name, per program entry. */
const ZIP_ENTRY_OVERHEAD_BYTES = 512;
const MAX_REASON_MESSAGE_CHARS = 512;
const MAX_REASONS_PER_TIMELINE = 64;

/** Fixed sentences for the decisions this module makes. No local detail appears in any of them. */
const BUILD_MESSAGES = {
  sizeCap: 'the program would take the archive past the program budget',
  manifestWontFit:
    'the program manifest does not fit the cap, so focus-only playback cannot be delivered honestly',
  outputUnverified: 'the program output failed its own verification',
  storageRelease: 'program storage made for this publish could not be released',
  storageEnforce: 'program storage could not be enforced for this publish',
  invalidTiming: 'the program timing is outside the supported bounds',
} as const;

/** Refuse the publish with an exact reason. Nothing is degraded on this path. */
function refuse(reason: string, message: string): never {
  throw new PublishError('program_refused', message, {
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
function assertCanonicalEntry(name: string): void {
  if (name === 'content.otio' || name === 'version.txt') return;
  if (name.startsWith('media/') && isSafeMediaPath(name.slice('media/'.length)))
    return;
  refuse(
    'unsafe-entry',
    'the archive contains an entry whose name is not a canonical OTIO bundle path'
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

function isSizeError(error: unknown): boolean {
  return (
    (error as { code?: string } | undefined)?.code ===
    'local_size_precheck_failed'
  );
}

/** Every regular entry, decompressed, after the canonical-name guard. */
async function baseEntries(index: OtioZipIndex): Promise<BaseEntry[]> {
  const out: BaseEntry[] = [];
  for (const [name, info] of index.entries) {
    if (info.isDirectory) continue;
    assertCanonicalEntry(name);
    out.push({
      name,
      data: await index.readEntry(name),
      method: name.startsWith('media/') ? 0 : 8,
    });
  }
  return out;
}

/**
 * ProgramFormat's bounds: at least 1 fps and at most the maximum, a start at
 * zero, and a duration of at least one frame and at most the maximum. A
 * timeline outside them is unavailable with invalid-timing, never rendered.
 */
function withinProgramBounds(program: {
  readonly frame_rate: { readonly num: number; readonly den: number };
  readonly range: {
    readonly start_time: { readonly value: number };
    readonly duration: { readonly value: number; readonly rate: number };
  };
}): boolean {
  const { num, den } = program.frame_rate;
  if (!(den > 0) || num < den || num / den > MAX_OTIO_PROGRAM_FPS) return false;
  if (program.range.start_time.value !== 0) return false;
  const seconds = program.range.duration.value / program.range.duration.rate;
  if (!Number.isFinite(seconds)) return false;
  return seconds >= den / num;
}

export async function buildProgramArchive(
  input: ProgramBuildInput
): Promise<ProgramBuildResult> {
  const kind = archiveKind(input.sourceName);
  if (kind === 'other') {
    return { bytes: input.archive, report: notApplicableReport() };
  }
  if (kind === 'raw') {
    return { bytes: input.archive, report: rawOtioReport() };
  }

  if (input.policy.invalid !== undefined) {
    refuse('invalid-config', input.policy.invalid);
  }
  if (input.renderer === undefined) {
    refuse(
      'renderer-not-configured',
      'this publisher has no program renderer, so an OTIO archive cannot be published with its manifest'
    );
  }

  let index: OtioZipIndex;
  try {
    index = await indexOtioZip(input.archive, {
      maxExpandedBytes: MAX_EXPANDED_ZIP_BYTES,
    });
  } catch {
    refuse(
      'archive-unreadable',
      'the archive cannot be read as an OTIO bundle'
    );
  }

  // A program is generated only by this publisher. An existing relic/ entry is
  // either a stale copy or a forgery, and neither is removed silently.
  if (hasReservedEntries(index)) {
    refuse(
      'entries-present',
      'the archive already contains relic/ entries. Publish the bundle without them: this publisher generates the program itself, and it never strips or keeps entries it did not generate.'
    );
  }

  const base = await baseEntries(index);
  const mediaIndex = await otioBundleMediaIndex(index, { digests: true });
  const media: readonly OtioMediaEntry[] = Object.values(mediaIndex);
  const doc = readOtioDocument(index.contentOtioBytes, { mediaIndex });
  if (doc.document_sha256 !== index.contentSha256) {
    refuse(
      'archive-unreadable',
      'the document digest does not match the archive content'
    );
  }
  const timelineIds = doc.timeline_ids;
  // The media the document references, exactly. The manifest and its self-check
  // must agree with this set and no other.
  const referencedPaths = otioDocumentMediaPaths(doc);
  if (timelineIds.length === 0) {
    refuse(
      'no-timelines',
      'the document has no timelines, so there is nothing to play'
    );
  }

  // The program budget is the lower of the server's cap and the local knob.
  const budget = Math.min(
    input.sizeLimit,
    input.policy.maxBytes ?? input.sizeLimit
  );
  const contentText = new TextDecoder('utf-8', { fatal: true }).decode(
    index.contentOtioBytes
  );

  let output: ProgramRenderOutput;
  try {
    output = await input.renderer({
      contentText,
      documentSha256: index.contentSha256,
      timelineIds,
      media,
      readMedia: (bundlePath) => index.readEntry(bundlePath),
      maxBytes: budget,
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

  const baseSize = buildZipArchive(base, MAX_EXPANDED_ZIP_BYTES).length;
  let used =
    baseSize +
    MANIFEST_RESERVE_BYTES +
    MANIFEST_RESERVE_PER_TIMELINE * timelineIds.length;

  const decisions: Decision[] = timelineIds.map((timelineId, i) => {
    const outcome: ProgramTimelineOutcome | undefined = output.outcomes[i];
    if (outcome === undefined) {
      return {
        index: i,
        timelineId,
        reasons: [
          { code: 'render-failed', message: RENDER_MESSAGES.noOutcome },
        ],
      };
    }
    if (outcome.status === 'unavailable') {
      return { index: i, timelineId, reasons: clampReasons(outcome.reasons) };
    }
    if (!withinProgramBounds(outcome.program)) {
      return {
        index: i,
        timelineId,
        reasons: [
          { code: 'invalid-timing', message: BUILD_MESSAGES.invalidTiming },
        ],
      };
    }
    const cost = outcome.mp4.length + ZIP_ENTRY_OVERHEAD_BYTES;
    if (used + cost > budget) {
      return {
        index: i,
        timelineId,
        reasons: [
          { code: 'size-cap-exceeded', message: BUILD_MESSAGES.sizeCap },
        ],
      };
    }
    used += cost;
    return {
      index: i,
      timelineId,
      reasons: [],
      rendered: {
        mp4: outcome.mp4,
        sha256: outcome.sha256,
        program: outcome.program,
      },
    };
  });

  const manifestFor = (plan: readonly Decision[]): OtioProgramManifestV1 => ({
    schema: OTIO_PROGRAM_SCHEMA,
    document_sha256: index.contentSha256,
    renderer: {
      client: input.clientName,
      protocol: OTIO_PROGRAM_PROTOCOL,
      browser: output.browser,
    },
    media: Object.fromEntries(
      referencedPaths.map((path) => {
        const sha = media.find((m) => m.bundle_path === path)?.sha256;
        if (sha === undefined) {
          refuse(
            'archive-unreadable',
            'a referenced media entry has no digest'
          );
        }
        return [path, sha];
      })
    ),
    timelines: plan.map((d) =>
      d.rendered === undefined
        ? {
            timeline_id: d.timelineId,
            index: d.index,
            status: 'unavailable',
            reasons: d.reasons,
          }
        : {
            timeline_id: d.timelineId,
            index: d.index,
            status: 'rendered',
            reasons: [],
            program: {
              entry: otioProgramEntryName(d.index),
              sha256: d.rendered.sha256,
              bytes: d.rendered.mp4.length,
              range: d.rendered.program.range,
              frame_rate: d.rendered.program.frame_rate,
              frames: d.rendered.program.frames,
              width: d.rendered.program.width,
              height: d.rendered.program.height,
              video_codec: d.rendered.program.video_codec,
              video_bitrate: d.rendered.program.video_bitrate,
              audio_codec: d.rendered.program.audio_codec,
              audio_rate: d.rendered.program.audio_rate,
              channels: d.rendered.program.channels,
              audio_samples: d.rendered.program.audio_samples,
            },
          }
    ),
  });

  // Build the archive and prove it verifies before it can leave this function.
  const attempt = async (plan: readonly Decision[]): Promise<Uint8Array> => {
    const manifest = stringifyOtioProgramManifest(manifestFor(plan));
    parseOtioProgramManifest(manifest);
    const programs: BaseEntry[] = plan.flatMap((d) =>
      d.rendered === undefined
        ? []
        : [
            {
              name: otioProgramEntryName(d.index),
              data: d.rendered.mp4,
              method: 0 as const,
            },
          ]
    );
    const bytes = buildZipArchive(
      [
        ...base,
        {
          name: OTIO_PROGRAM_MANIFEST_ENTRY,
          data: manifest,
          method: 8 as const,
        },
        ...programs,
      ],
      budget
    );
    const written = await indexOtioZip(bytes, {
      maxExpandedBytes: MAX_EXPANDED_ZIP_BYTES,
    });
    // Full verification: document binding, media and program digests, sizes.
    const verified = await readOtioProgramArchive(written, {
      document_sha256: index.contentSha256,
      timeline_ids: timelineIds,
      media_paths: referencedPaths,
    });
    if (verified === null) {
      throw new Error('the written archive carries no program manifest');
    }
    return bytes;
  };

  let bytes: Uint8Array;
  let finalPlan: readonly Decision[] = decisions;
  try {
    bytes = await attempt(decisions);
  } catch (first) {
    if (!isSizeError(first)) {
      // An output that fails verification is a defect in this publisher, not a
      // rendering limit. It is never reported as focus-only.
      refuse('output-invalid', BUILD_MESSAGES.outputUnverified);
    }
    // The programs do not fit. Keep every timeline focus-only, and say so in
    // the manifest, which must fit by itself.
    finalPlan = decisions.map((d) =>
      d.rendered === undefined
        ? d
        : {
            ...d,
            rendered: undefined,
            reasons: [
              { code: 'size-cap-exceeded', message: BUILD_MESSAGES.sizeCap },
            ],
          }
    );
    try {
      bytes = await attempt(finalPlan);
    } catch (second) {
      if (isSizeError(second)) {
        refuse('manifest-unfit', BUILD_MESSAGES.manifestWontFit);
      }
      refuse('output-invalid', BUILD_MESSAGES.outputUnverified);
    }
  }

  const timelines: ProgramTimelineReport[] = finalPlan.map((d) =>
    d.rendered === undefined
      ? {
          timeline_id: d.timelineId,
          index: d.index,
          status: 'unavailable',
          reasons: d.reasons,
        }
      : {
          timeline_id: d.timelineId,
          index: d.index,
          status: 'rendered',
          reasons: [],
          program: {
            bytes: d.rendered.mp4.length,
            frames: d.rendered.program.frames,
            width: d.rendered.program.width,
            height: d.rendered.program.height,
          },
        }
  );
  const renderedCount = timelines.filter((t) => t.status === 'rendered').length;
  const status =
    renderedCount === timelines.length
      ? 'rendered'
      : renderedCount === 0
        ? 'unavailable'
        : 'partial';

  return { bytes, report: { status, timelines } };
}
