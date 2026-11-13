/**
 * Audio plan and mixer for the offline program renderer.
 *
 * Timing: output frame k is timeline time origin + k/48000 exactly. Each span
 * boundary is rounded once to its nearest output frame, so adjacent spans share
 * a boundary and nothing accumulates. Source content is read at the exact
 * timeline time of each output frame, so a fractional source position never
 * drifts.
 *
 * Resampling: a Blackman-windowed sinc, normalised to unity DC gain per output
 * frame. A position that falls exactly on a native frame is copied, not
 * filtered, so equal-rate integer-aligned audio passes through bit-exact.
 * Equal-rate fractional positions (for example an NTSC timeline over 48 kHz
 * source) are interpolated with the same kernel, because the output instant
 * does not coincide with a source frame.
 *
 * Source coverage: the filter taps for a window must start at the first decoded
 * frame (or at the file start, where earlier taps are zero), and the position
 * itself must lie within decoded data. Anything else fails explicitly, so a hole
 * or a short source is never read as silence.
 *
 * Unit speed is required; retimed audio is rejected.
 */
import {
  audioScheduleForOtioRange,
  type OtioDiagnostic,
  type OtioDocumentV1,
  type OtioNode,
  type OtioRationalTime,
  type OtioTimeRange,
} from '@relic/format';
import { failure, reasonFromDiagnostics } from './failure.ts';
import type { ProgramMedia } from './media.ts';
import { PROGRAM_AUDIO_RATE } from './protocol.ts';

/** Filter radius in native frames at full cutoff. Downsampling widens it. */
const RESAMPLE_RADIUS = 16;
/** Positions this close to a native frame are that frame. */
const INTEGER_POSITION_EPSILON = 1e-9;
/** Source positions may sit this far below zero from rounding alone. */
const START_EPSILON = 1e-6;

export interface ProgramAudioRamp {
  /** Absolute timeline seconds. */
  readonly startSec: number;
  readonly endSec: number;
  readonly direction: 'in' | 'out';
}

export interface ProgramAudioSpan {
  /** Nearest output frame to the span start, relative to the origin. */
  readonly startFrame: number;
  readonly endFrame: number;
  /** Absolute timeline seconds of the span start. */
  readonly startSec: number;
  /** File-relative source seconds at startSec. Unit speed, so time advances 1:1. */
  readonly sourceOriginSec: number;
  readonly path: string;
  readonly ramps: readonly ProgramAudioRamp[];
}

export interface ProgramAudioPlan {
  /** Absolute timeline seconds of output frame 0. */
  readonly originSec: number;
  readonly sampleCount: number;
  /** Sorted by startFrame. Silence needs no span. */
  readonly spans: readonly ProgramAudioSpan[];
}

function seconds(time: OtioRationalTime): number {
  return time.value / time.rate;
}

/** Nearest output frame to an offset from the origin, in seconds. */
function nearestFrame(offsetSec: number): number {
  return Math.round(offsetSec * PROGRAM_AUDIO_RATE);
}

function rangeSeconds(range: OtioTimeRange): { start: number; end: number } {
  const start = seconds(range.start_time);
  return { start, end: start + seconds(range.duration) };
}

export function planProgramAudio(
  document: OtioDocumentV1,
  timelineId: string,
  origin: OtioRationalTime,
  duration: OtioRationalTime,
  available: ReadonlySet<string>
): ProgramAudioPlan {
  const originSec = seconds(origin);
  const sampleCount = Math.ceil(seconds(duration) * PROGRAM_AUDIO_RATE - 1e-6);
  const schedule = audioScheduleForOtioRange(document, timelineId, {
    start_time: origin,
    duration,
  });
  const spans: ProgramAudioSpan[] = [];
  for (const span of schedule) {
    if (span.disposition === 'silence') continue;
    let id: string | null = span.node_id;
    const seen = new Set<string>();
    let disabled = false;
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      const node: OtioNode | undefined = document.nodes[id];
      if (!node) break;
      if (!node.enabled) {
        disabled = true;
        break;
      }
      id = node.parent_id;
    }
    if (disabled) continue;
    if (span.disposition === 'unavailable' || !span.bundle_path) {
      throw failure(
        reasonFromDiagnostics(
          span.diagnostics,
          span.bundle_path ? 'render-failed' : 'missing-media'
        ),
        `Audio for ${span.node_id} is unavailable`,
        span.node_id
      );
    }
    const map = span.source_mapping;
    if (!map) {
      throw failure(
        'invalid-timing',
        `Audio for ${span.node_id} has no source mapping`,
        span.node_id
      );
    }
    if (map.scalar !== 1) {
      throw failure(
        'unsupported-effect',
        `Audio for ${span.node_id} is retimed (scalar ${map.scalar}); only unit speed is mixed`,
        span.node_id
      );
    }
    if (
      span.diagnostics.some(
        (diagnostic: OtioDiagnostic) =>
          diagnostic.code === 'unsupported-effect' ||
          diagnostic.severity === 'error'
      )
    ) {
      throw failure(
        reasonFromDiagnostics(span.diagnostics, 'invalid-timing'),
        `Audio for ${span.node_id} has an unsupported effect or invalid timing`,
        span.node_id
      );
    }
    if (!available.has(span.bundle_path)) {
      throw failure(
        'missing-media',
        `Audio media ${span.bundle_path} is not in the render request`,
        span.node_id
      );
    }
    const range = rangeSeconds(span.timeline_range);
    if (Math.abs(seconds(map.timeline_origin) - range.start) > 1e-12) {
      throw failure(
        'invalid-timing',
        `Audio mapping for ${span.node_id} does not begin at its interval start`,
        span.node_id
      );
    }
    const startFrame = nearestFrame(range.start - originSec);
    const endFrame = nearestFrame(range.end - originSec);
    if (endFrame <= startFrame) continue;
    spans.push({
      startFrame,
      endFrame,
      startSec: range.start,
      sourceOriginSec: seconds(map.source_origin),
      path: span.bundle_path,
      ramps: span.gain_factors.map((factor) => {
        const ramp = rangeSeconds(factor.range);
        return {
          startSec: ramp.start,
          endSec: ramp.end,
          direction: factor.direction,
        };
      }),
    });
  }
  spans.sort((a, b) => a.startFrame - b.startFrame);
  return { originSec, sampleCount, spans };
}

/** Linear fade gain at an absolute timeline time. Ramps multiply. */
export function gainAt(
  ramps: readonly ProgramAudioRamp[],
  timeSec: number
): number {
  let gain = 1;
  for (const ramp of ramps) {
    let fraction: number;
    if (ramp.endSec <= ramp.startSec) {
      fraction = timeSec >= ramp.endSec ? 1 : 0;
    } else {
      fraction = Math.min(
        1,
        Math.max(0, (timeSec - ramp.startSec) / (ramp.endSec - ramp.startSec))
      );
    }
    gain *= ramp.direction === 'in' ? fraction : 1 - fraction;
  }
  return gain;
}

/** Native source position of an output frame, in native frames. */
export function nativePosition(
  span: ProgramAudioSpan,
  originSec: number,
  nativeRate: number,
  frame: number
): number {
  const timeSec = originSec + frame / PROGRAM_AUDIO_RATE;
  return (span.sourceOriginSec + (timeSec - span.startSec)) * nativeRate;
}

/** Windowed sinc at offset d native frames, for cutoff fc (1 = native Nyquist). */
function kernel(d: number, fc: number, radius: number): number {
  if (Math.abs(d) >= radius) return 0;
  const x = fc * d;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const t = d / radius;
  const blackman =
    0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
  return fc * sinc * blackman;
}

/**
 * Fill `weights` for a position and return the first native index it covers.
 * Weights are normalised to sum to one, so DC gain is exactly unity.
 */
export function fillWeights(
  position: number,
  fc: number,
  radius: number,
  weights: Float64Array
): number {
  const first = Math.floor(position) - radius + 1;
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    const weight = kernel(position - (first + i), fc, radius);
    weights[i] = weight;
    sum += weight;
  }
  for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! / sum;
  return first;
}

/**
 * Planar stereo mix for output frames [start, start+count): length 2*count,
 * left then right, clamped to [-1, 1].
 */
export async function mixProgramAudio(
  plan: ProgramAudioPlan,
  media: ProgramMedia,
  start: number,
  count: number
): Promise<Float32Array> {
  const out = new Float32Array(2 * count);
  const end = start + count;
  for (const span of plan.spans) {
    if (span.startFrame >= end) break;
    if (span.endFrame <= start) continue;
    const from = Math.max(span.startFrame, start);
    const to = Math.min(span.endFrame, end);
    const info = await media.audioInfo(span.path);
    const fc = Math.min(1, PROGRAM_AUDIO_RATE / info.rate);
    const radius = Math.ceil(RESAMPLE_RADIUS / fc);
    const first = nativePosition(span, plan.originSec, info.rate, from);
    const last = nativePosition(span, plan.originSec, info.rate, to - 1);
    if (first < -START_EPSILON) {
      throw failure(
        'invalid-timing',
        `Audio for ${span.path} starts before the beginning of its source`
      );
    }
    const readStart = Math.max(0, Math.floor(first) - radius + 1);
    const readStop = Math.floor(last) + radius + 1;
    const read = await media.readNative(
      span.path,
      readStart,
      readStop - readStart
    );
    // Taps must begin at the first decoded frame (or at file start, where
    // earlier taps are zero). The position itself must be decoded.
    if (read.begin > readStart || Math.floor(last) >= read.end) {
      throw failure(
        'invalid-timing',
        `Audio source ${span.path} does not cover its timeline span`
      );
    }
    const weights = new Float64Array(2 * radius);
    for (let frame = from; frame < to; frame++) {
      const timeSec = plan.originSec + frame / PROGRAM_AUDIO_RATE;
      const gain = gainAt(span.ramps, timeSec);
      if (gain === 0) continue;
      const position = nativePosition(span, plan.originSec, info.rate, frame);
      const slot = frame - start;
      const nearest = Math.round(position);
      if (fc === 1 && Math.abs(position - nearest) < INTEGER_POSITION_EPSILON) {
        const index = nearest - readStart;
        if (index >= 0 && index < read.left.length) {
          out[slot]! += read.left[index]! * gain;
          out[count + slot]! += read.right[index]! * gain;
        }
        continue;
      }
      const firstTap = fillWeights(position, fc, radius, weights);
      let left = 0;
      let right = 0;
      for (let i = 0; i < weights.length; i++) {
        const index = firstTap + i - readStart;
        if (index < 0 || index >= read.left.length) continue;
        left += weights[i]! * read.left[index]!;
        right += weights[i]! * read.right[index]!;
      }
      out[slot]! += left * gain;
      out[count + slot]! += right * gain;
    }
  }
  for (let i = 0; i < out.length; i++) {
    const value = out[i]!;
    out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
  }
  return out;
}
