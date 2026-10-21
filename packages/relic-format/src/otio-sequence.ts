/**
 * Canonical ImageSequenceReference.1 interpretation shared by packing,
 * playback, and media-continuity witnesses.
 */

import { isOtioRawNumber } from './otio-json.ts';
import type { OtioBundleEntryName, OtioMediaEntry } from './otio-types.ts';
import { MAX_OTIO_BUNDLE_MEDIA_ENTRIES, otioBundleEntry } from './otio-zip.ts';

const MAX_FRAME_PAD = 32;
const MAX_SEQUENCE_PATH = 1024;

export interface OtioImageSequence {
  readonly count: number;
  readonly startFrame: number;
  readonly frameStep: number;
  frame(imageIndex: number): number;
  url(imageIndex: number): string;
  entry(imageIndex: number): OtioBundleEntryName | null;
}

export type OtioImageSequenceRead =
  | { readonly ok: true; readonly sequence: OtioImageSequence }
  | { readonly ok: false; readonly reason: string };

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : isOtioRawNumber(value)
        ? value.numericValue
        : null;
  return numeric !== null && Number.isFinite(numeric) ? numeric : null;
}

function safeInteger(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric !== null && Number.isSafeInteger(numeric) ? numeric : null;
}

function formatFrame(frame: number, pad: number): string {
  const negative = frame < 0;
  const digits = String(Math.abs(frame));
  const body = digits.length >= pad ? digits : digits.padStart(pad, '0');
  return `${negative ? '-' : ''}${body}`;
}

function sequenceFailure(reason: string): OtioImageSequenceRead {
  return { ok: false, reason };
}

function assertImageIndex(imageIndex: number, count: number): void {
  if (
    !Number.isSafeInteger(imageIndex) ||
    imageIndex < 0 ||
    imageIndex >= count
  ) {
    throw new RangeError(
      `Image sequence index ${imageIndex} is outside [0, ${count})`
    );
  }
}

function readImageSequence(
  record: Record<string, unknown>
): OtioImageSequenceRead {
  if (
    record['OTIO_SCHEMA'] !== 'ImageSequenceReference.1' &&
    record['schema'] !== 'ImageSequenceReference.1'
  ) {
    return sequenceFailure('record must be ImageSequenceReference.1');
  }
  const stringField = (
    name: 'target_url_base' | 'name_prefix' | 'name_suffix'
  ): string | null => {
    if (!hasOwn(record, name)) return '';
    return typeof record[name] === 'string' ? (record[name] as string) : null;
  };
  const base = stringField('target_url_base');
  if (base === null) return sequenceFailure('target_url_base must be a string');
  const prefix = stringField('name_prefix');
  if (prefix === null) return sequenceFailure('name_prefix must be a string');
  const suffix = stringField('name_suffix');
  if (suffix === null) return sequenceFailure('name_suffix must be a string');

  const startFrame = hasOwn(record, 'start_frame')
    ? safeInteger(record['start_frame'])
    : 1;
  if (startFrame === null) {
    return sequenceFailure('start_frame must be a safe integer');
  }
  const frameStep = hasOwn(record, 'frame_step')
    ? safeInteger(record['frame_step'])
    : 1;
  if (frameStep === null || frameStep < 1) {
    return sequenceFailure(
      'frame_step must be a safe integer greater than zero'
    );
  }
  const pad = hasOwn(record, 'frame_zero_padding')
    ? safeInteger(record['frame_zero_padding'])
    : 0;
  if (pad === null || pad < 0 || pad > MAX_FRAME_PAD) {
    return sequenceFailure(
      `frame_zero_padding must be a safe integer from 0 to ${MAX_FRAME_PAD}`
    );
  }

  const rate = hasOwn(record, 'rate') ? finiteNumber(record['rate']) : 1;
  if (rate === null) return sequenceFailure('rate must be finite');

  let count = 0;
  if (hasOwn(record, 'available_range') && record['available_range'] !== null) {
    const range = asRecord(record['available_range']);
    if (!range || range['OTIO_SCHEMA'] !== 'TimeRange.1') {
      return sequenceFailure('available_range must be TimeRange.1');
    }
    const duration = asRecord(range['duration']);
    if (!duration || duration['OTIO_SCHEMA'] !== 'RationalTime.1') {
      return sequenceFailure('available_range.duration must be RationalTime.1');
    }
    const durationValue = finiteNumber(duration['value']);
    const durationRate = finiteNumber(duration['rate']);
    if (durationValue === null || durationRate === null || durationRate <= 0) {
      return sequenceFailure(
        'available_range.duration must have finite positive rate and finite value'
      );
    }
    if (rate > 0) {
      const sequenceRate = rate / frameStep;
      const scaled =
        sequenceRate === durationRate
          ? durationValue
          : (durationValue * sequenceRate) / durationRate;
      if (!Number.isFinite(scaled)) {
        return sequenceFailure('image sequence count is not finite');
      }
      count = Math.trunc(scaled);
      if (count > MAX_OTIO_BUNDLE_MEDIA_ENTRIES) {
        return sequenceFailure(
          `image sequence count exceeds ${MAX_OTIO_BUNDLE_MEDIA_ENTRIES}`
        );
      }
      if (count < 0) count = 0;
    }
  }

  if (count > 0) {
    const lastFrame = startFrame + (count - 1) * frameStep;
    if (!Number.isSafeInteger(lastFrame)) {
      return sequenceFailure('last image frame is not a safe integer');
    }
  }

  const slash = base.length > 0 && !base.endsWith('/') ? '/' : '';
  const buildUrl = (imageIndex: number): string =>
    `${base}${slash}${prefix}${formatFrame(startFrame + imageIndex * frameStep, pad)}${suffix}`;
  if (count > 0) {
    const first = buildUrl(0);
    const last = buildUrl(count - 1);
    if (first.length > MAX_SEQUENCE_PATH || last.length > MAX_SEQUENCE_PATH) {
      return sequenceFailure(
        `image sequence URL exceeds ${MAX_SEQUENCE_PATH} UTF-16 units`
      );
    }
  }

  const sequence: OtioImageSequence = {
    count,
    startFrame,
    frameStep,
    frame(imageIndex: number): number {
      assertImageIndex(imageIndex, count);
      return startFrame + imageIndex * frameStep;
    },
    url(imageIndex: number): string {
      assertImageIndex(imageIndex, count);
      return buildUrl(imageIndex);
    },
    entry(imageIndex: number): OtioBundleEntryName | null {
      assertImageIndex(imageIndex, count);
      return otioBundleEntry(buildUrl(imageIndex));
    },
  };
  return { ok: true, sequence };
}

const sequenceReadCache = new WeakMap<object, OtioImageSequenceRead>();

/**
 * Applies the OpenTimelineIO image-sequence count and URL rules to one raw
 * ImageSequenceReference.1 record. A missing/null available range is valid
 * and yields zero images.
 */
export function readOtioImageSequence(record: unknown): OtioImageSequenceRead {
  const object = asRecord(record);
  if (!object)
    return sequenceFailure('ImageSequenceReference.1 must be an object');
  const cached = sequenceReadCache.get(object);
  if (cached) return cached;
  const read = readImageSequence(object);
  sequenceReadCache.set(object, read);
  return read;
}

const frameEntriesCache = new WeakMap<
  object,
  WeakMap<object, readonly OtioBundleEntryName[]>
>();

/**
 * Lists the canonical, indexed entries an image sequence can actually use.
 * Both the read result and this list are memoized by the immutable parsed
 * record and media index objects.
 */
export function otioSequenceFrameEntries(
  record: unknown,
  media: Readonly<Record<string, OtioMediaEntry>>
): readonly OtioBundleEntryName[] {
  const recordObject = asRecord(record);
  if (!recordObject || !media || typeof media !== 'object') return [];
  const mediaObject = media as object;
  let byMedia = frameEntriesCache.get(recordObject);
  if (!byMedia) {
    byMedia = new WeakMap<object, readonly OtioBundleEntryName[]>();
    frameEntriesCache.set(recordObject, byMedia);
  }
  const cached = byMedia.get(mediaObject);
  if (cached) return cached;

  const read = readOtioImageSequence(recordObject);
  if (!read.ok) {
    const empty: readonly OtioBundleEntryName[] = [];
    byMedia.set(mediaObject, empty);
    return empty;
  }

  const entries = new Set<OtioBundleEntryName>();
  for (let imageIndex = 0; imageIndex < read.sequence.count; imageIndex += 1) {
    const entry = read.sequence.entry(imageIndex);
    if (entry !== null && hasOwn(media, entry)) entries.add(entry);
  }
  const listed = [...entries].sort();
  byMedia.set(mediaObject, listed);
  return listed;
}
