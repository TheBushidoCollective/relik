/**
 * OpenTimelineIO native video decoder ring and synchronous rVFC capture.
 *
 * Implements S-C (synchronous inside-rVFC capture into a fixed 3-slot ring)
 * and S-B phase anchor / drift calculations.
 */

import type { OtioRationalTime } from '@relic/format';
import { rescaleTime, timeToSeconds } from '@relic/format';
import type { OtioVideoTiming } from './otio-video-timing.ts';

export const OTIO_PACKET_START_TOLERANCE_SECONDS = 2e-6; // Q = 2 µs
export const OTIO_RETAINED_SNAPSHOT_PIXELS = 32 * 1024 * 1024;
export const SNAPSHOT_SLOTS_PER_DECODER = 3;
export const DECODER_LOCAL_ZERO_SOURCE_VALUE_TOLERANCE = 1e-7;

export interface VideoFrameCallbackMetadata {
  readonly mediaTime: number;
  readonly expectedDisplayTime?: number;
  readonly width?: number;
  readonly height?: number;
  readonly presentedFrames?: number;
}

export type VideoFrameRequestCallback = (
  now: number,
  metadata: VideoFrameCallbackMetadata
) => void;

export interface HTMLVideoElementWithRvfc extends HTMLVideoElement {
  requestVideoFrameCallback?(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export type PresentedWindowOutcome =
  | { readonly kind: 'match'; readonly index: number }
  | { readonly kind: 'uncovered' }
  | { readonly kind: 'outside' };

export function compareDecoderSourceTimes(
  sourceTime: OtioRationalTime,
  candidate: OtioRationalTime
): number {
  const candidateAtSourceRate =
    candidate.rate === sourceTime.rate
      ? candidate
      : rescaleTime(candidate, sourceTime.rate);
  const difference = sourceTime.value - candidateAtSourceRate.value;
  if (!Number.isFinite(difference)) return NaN;
  if (Math.abs(difference) < DECODER_LOCAL_ZERO_SOURCE_VALUE_TOLERANCE) {
    return 0;
  }
  return difference < 0 ? -1 : 1;
}

export function acceptsDecoderLocalZero(sourceTime: OtioRationalTime): boolean {
  if (sourceTime.value >= 0) return false;
  return (
    compareDecoderSourceTimes(sourceTime, {
      value: 0,
      rate: sourceTime.rate,
    }) === 0
  );
}

export function decoderLocalSourceTime(
  sourceTime: OtioRationalTime
): OtioRationalTime {
  if (sourceTime.value === 0) {
    return Object.is(sourceTime.value, -0)
      ? { value: 0, rate: sourceTime.rate }
      : sourceTime;
  }
  return acceptsDecoderLocalZero(sourceTime)
    ? { value: 0, rate: sourceTime.rate }
    : sourceTime;
}

export function containerTimeAtSourceRate(
  seconds: number,
  sourceTime: OtioRationalTime
): OtioRationalTime {
  return { value: seconds * sourceTime.rate, rate: sourceTime.rate };
}

export function decoderLocalSeconds(sourceTime: OtioRationalTime): number {
  return timeToSeconds(decoderLocalSourceTime(sourceTime));
}

/**
 * Strict rational half-open search for certified presentation window index.
 * Refactored from videoDecoderTime so required window lookup is shared.
 */
export function certifiedWindowIndex(
  sourceTime: OtioRationalTime,
  timing: OtioVideoTiming | null
): number | null {
  if (
    timing === null ||
    timing.kind !== 'windows' ||
    timing.starts.length === 0 ||
    timing.starts.length !== timing.ends.length
  ) {
    return null;
  }
  const localTime = decoderLocalSourceTime(sourceTime);
  let lower = 0;
  let upper = timing.starts.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const start = timing.starts[middle];
    if (
      start !== undefined &&
      compareDecoderSourceTimes(
        localTime,
        containerTimeAtSourceRate(start, localTime)
      ) >= 0
    ) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const index = lower - 1;
  if (index < 0) return null;
  const start = timing.starts[index];
  const end = timing.ends[index];
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    compareDecoderSourceTimes(
      localTime,
      containerTimeAtSourceRate(end, localTime)
    ) >= 0
  ) {
    return null;
  }
  return index;
}

/**
 * Returns exact presentation midpoint for seek/scrub or paused frames.
 */
export function videoDecoderTime(
  sourceTime: OtioRationalTime,
  timing: OtioVideoTiming | null
): number | null {
  const index = certifiedWindowIndex(sourceTime, timing);
  if (index === null || !timing) return null;
  const start = timing.starts[index];
  const end = timing.ends[index];
  if (start === undefined || end === undefined) return null;
  return start + (end - start) / 2;
}

/**
 * Three presented outcomes per callback:
 * 1. Exact packet-start match within Q (2 µs).
 * 2. Uncovered inside certified span [starts[0] - Q, ends[last] - Q).
 * 3. Outside span before head or after tail.
 */
export function presentedWindowOutcome(
  mediaTime: number,
  timing: OtioVideoTiming | null,
  q: number = OTIO_PACKET_START_TOLERANCE_SECONDS
): PresentedWindowOutcome {
  if (
    timing === null ||
    timing.kind !== 'windows' ||
    timing.starts.length === 0 ||
    timing.starts.length !== timing.ends.length
  ) {
    return { kind: 'outside' };
  }
  const starts = timing.starts;
  const ends = timing.ends;
  const firstStart = starts[0];
  const lastEnd = ends[ends.length - 1];
  if (firstStart === undefined || lastEnd === undefined) {
    return { kind: 'outside' };
  }

  // Binary search for closest packet start:
  let lower = 0;
  let upper = starts.length;
  while (lower < upper) {
    const mid = lower + Math.floor((upper - lower) / 2);
    if ((starts[mid] ?? 0) < mediaTime) {
      lower = mid + 1;
    } else {
      upper = mid;
    }
  }

  let matchedIndex: number | null = null;
  let minDiff = Infinity;
  for (
    let candidate = Math.max(0, lower - 1);
    candidate <= Math.min(starts.length - 1, lower + 1);
    candidate++
  ) {
    const start = starts[candidate];
    if (start !== undefined) {
      const diff = Math.abs(mediaTime - start);
      if (diff <= q && diff < minDiff) {
        minDiff = diff;
        matchedIndex = candidate;
      }
    }
  }

  if (matchedIndex !== null) {
    return { kind: 'match', index: matchedIndex };
  }

  // Check if inside span [starts[0] - Q, ends[last] - Q):
  if (mediaTime >= firstStart - q && mediaTime < lastEnd - q) {
    return { kind: 'uncovered' };
  }

  return { kind: 'outside' };
}

/**
 * Checks native eligibility of timing and rate:
 * - certified windows
 * - every window duration and every gap between starts > 2Q
 * - W_min,L >= vsync
 */
export function checkNativeTimingEligibility(
  timing: OtioVideoTiming | null,
  rL: number,
  vsyncSeconds: number,
  q: number = OTIO_PACKET_START_TOLERANCE_SECONDS
): boolean {
  if (
    timing === null ||
    timing.kind !== 'windows' ||
    timing.starts.length === 0 ||
    timing.starts.length !== timing.ends.length ||
    !Number.isFinite(rL) ||
    rL <= 0
  ) {
    return false;
  }
  const starts = timing.starts;
  const ends = timing.ends;
  const twoQ = 2 * q;

  let minWindowSeconds = Infinity;

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = ends[i];
    if (
      s === undefined ||
      e === undefined ||
      !Number.isFinite(s) ||
      !Number.isFinite(e)
    ) {
      return false;
    }
    const windowDuration = e - s;
    if (windowDuration <= twoQ) {
      return false;
    }
    if (i < starts.length - 1) {
      const nextS = starts[i + 1];
      if (nextS === undefined || !Number.isFinite(nextS)) return false;
      const gap = nextS - s;
      if (gap <= twoQ) {
        return false;
      }
    }
    if (windowDuration < minWindowSeconds) {
      minWindowSeconds = windowDuration;
    }
  }

  const wMinSeconds = minWindowSeconds / rL;
  if (wMinSeconds < vsyncSeconds) {
    return false;
  }

  return true;
}

export function minWindowDuration(timing: OtioVideoTiming, rL: number): number {
  let minWindow = Infinity;
  for (let i = 0; i < timing.starts.length; i++) {
    const s = timing.starts[i] ?? 0;
    const e = timing.ends[i] ?? 0;
    const dur = e - s;
    if (dur < minWindow) minWindow = dur;
  }
  return Number.isFinite(minWindow) ? minWindow / Math.max(0.001, rL) : 1 / 30;
}

export function maxWindowDuration(timing: OtioVideoTiming, rL: number): number {
  let maxWindow = 0;
  for (let i = 0; i < timing.starts.length; i++) {
    const s = timing.starts[i] ?? 0;
    const e = timing.ends[i] ?? 0;
    const dur = e - s;
    if (dur > maxWindow) maxWindow = dur;
  }
  return Number.isFinite(maxWindow) && maxWindow > 0
    ? maxWindow / Math.max(0.001, rL)
    : 1 / 30;
}

export class VsyncTracker {
  private readonly intervals: number[] = [];
  private lastNow: number | null = null;

  recordTick(now: number): void {
    if (this.lastNow !== null) {
      const delta = now - this.lastNow;
      if (delta > 0 && delta < 200) {
        this.intervals.push(delta);
        if (this.intervals.length > 60) {
          this.intervals.shift();
        }
      }
    }
    this.lastNow = now;
  }

  get medianSeconds(): number {
    if (this.intervals.length < 2) {
      return 1 / 60;
    }
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0
        ? ((sorted[mid - 1] ?? 16.666) + (sorted[mid] ?? 16.666)) / 2
        : (sorted[mid] ?? 16.666);
    const clampedMs = Math.max(4, Math.min(34, medianMs));
    return clampedMs / 1000;
  }

  reset(): void {
    this.intervals.length = 0;
    this.lastNow = null;
  }
}

export class SnapshotPixelBudget {
  private used = 0;

  constructor(readonly maxPixels: number = OTIO_RETAINED_SNAPSHOT_PIXELS) {}

  canAllocate(pixels: number): boolean {
    return this.used + pixels <= this.maxPixels;
  }

  allocate(pixels: number): boolean {
    if (!this.canAllocate(pixels)) return false;
    this.used += pixels;
    return true;
  }

  release(pixels: number): void {
    this.used = Math.max(0, this.used - pixels);
  }

  get allocatedPixels(): number {
    return this.used;
  }
}

export interface DecoderPhaseSample {
  readonly dL: number; // now in ms from rVFC
  readonly iL0Plus1Start: number; // starts[i_L0 + 1] in seconds
  readonly sourceT0Seconds: number; // s_L(T0) in seconds
  readonly rL: number; // playback rate
  readonly wMinSeconds: number; // smallest window / rL
}

export interface PhaseAnchorResult {
  readonly tauStar: number; // wallMs in ms
  readonly maxSpreadMs: number;
  readonly spreadLimitMs: number;
  readonly spreadAcceptable: boolean;
}

/**
 * Closed-form phase anchor calculation:
 * leadTarget = (vsync + 2 * W_min,L) / 2
 * deltaSeconds = leadTarget - (starts[i_L0 + 1] - s_L(T0)) / r_L
 * tau_L = d_L + deltaSeconds * 1000 (ms)
 * tau* = (min tau_L + max tau_L) / 2
 * spreadLimit = min_L(2 * W_min,L - vsync) * 1000 (ms)
 */
export function computePhaseAnchor(
  samples: readonly DecoderPhaseSample[],
  vsyncSeconds: number
): PhaseAnchorResult {
  if (samples.length === 0) {
    return {
      tauStar: 0,
      maxSpreadMs: 0,
      spreadLimitMs: 0,
      spreadAcceptable: true,
    };
  }

  let minTau = Infinity;
  let maxTau = -Infinity;
  let minSpreadLimitMs = Infinity;

  for (const sample of samples) {
    const leadTarget = (vsyncSeconds + 2 * sample.wMinSeconds) / 2;
    const uL = sample.iL0Plus1Start - sample.sourceT0Seconds;
    const deltaSeconds = leadTarget - uL / sample.rL;
    const tauL = sample.dL + deltaSeconds * 1000;

    if (tauL < minTau) minTau = tauL;
    if (tauL > maxTau) maxTau = tauL;

    const spreadLimitL = (2 * sample.wMinSeconds - vsyncSeconds) * 1000;
    if (spreadLimitL < minSpreadLimitMs) minSpreadLimitMs = spreadLimitL;
  }

  const tauStar = (minTau + maxTau) / 2;
  const maxSpreadMs = maxTau - minTau;
  const spreadAcceptable = maxSpreadMs <= minSpreadLimitMs;

  return {
    tauStar,
    maxSpreadMs,
    spreadLimitMs: minSpreadLimitMs,
    spreadAcceptable,
  };
}

export interface NativeSnapshotSlot {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D | null;
  tag: number | null;
  epoch: number;
  lead: number;
}

export class NativeDecoderRing {
  readonly slots: NativeSnapshotSlot[] = [];
  private nextSlotIndex = 0;
  private currentEpoch = 0;
  private rVfcHandle: number | null = null;
  private allocatedPixels = 0;

  consecutiveUncovered = 0;
  totalUncovered = 0;
  lastCallbackWallMs: number | null = null;
  isStarting = false;
  startupFirstAdvancedTag: number | null = null;
  startupWaiter: {
    resolve: (sample: { now: number; tag: number }) => void;
  } | null = null;
  missingSince: number | null = null;

  constructor(
    readonly videoElement: HTMLVideoElement,
    readonly key: string,
    readonly bundlePath: string,
    private readonly budget: SnapshotPixelBudget
  ) {}

  allocate(width: number, height: number): boolean {
    if (this.slots.length === SNAPSHOT_SLOTS_PER_DECODER) {
      return true;
    }
    const needed = SNAPSHOT_SLOTS_PER_DECODER * width * height;
    if (!this.budget.allocate(needed)) {
      return false;
    }
    this.allocatedPixels = needed;
    for (let i = 0; i < SNAPSHOT_SLOTS_PER_DECODER; i++) {
      if (typeof document === 'undefined' || !document.createElement)
        return false;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      this.slots.push({
        canvas,
        ctx,
        tag: null,
        epoch: -1,
        lead: 0,
      });
    }
    return true;
  }

  release(): void {
    this.cancelCallback();
    for (const slot of this.slots) {
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.tag = null;
      slot.epoch = -1;
    }
    this.slots.length = 0;
    if (this.allocatedPixels > 0) {
      this.budget.release(this.allocatedPixels);
      this.allocatedPixels = 0;
    }
  }

  cancelCallback(): void {
    const rvfcVideo = this.videoElement as HTMLVideoElementWithRvfc;
    if (
      this.rVfcHandle !== null &&
      typeof rvfcVideo.cancelVideoFrameCallback === 'function'
    ) {
      try {
        rvfcVideo.cancelVideoFrameCallback(this.rVfcHandle);
      } catch {}
      this.rVfcHandle = null;
    }
  }

  resetEpoch(newEpoch: number): void {
    this.cancelCallback();
    this.currentEpoch = newEpoch;
    this.consecutiveUncovered = 0;
    this.startupWaiter = null;
    this.startupFirstAdvancedTag = null;
    this.missingSince = null;
    for (const slot of this.slots) {
      slot.tag = null;
      slot.epoch = -1;
    }
  }

  capturePausedFrame(tag: number, epoch: number): void {
    if (this.slots.length === 0) return;
    const slot = this.slots[0];
    if (!slot) return;
    slot.tag = tag;
    slot.epoch = epoch;
    slot.lead = 0;
    if (slot.ctx) {
      try {
        slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
        slot.ctx.drawImage(
          this.videoElement,
          0,
          0,
          slot.canvas.width,
          slot.canvas.height
        );
      } catch {}
    }
  }

  findSlotWithTag(tag: number, epoch: number): NativeSnapshotSlot | null {
    for (const slot of this.slots) {
      if (slot.epoch === epoch && slot.tag === tag) {
        return slot;
      }
    }
    return null;
  }

  hasTag(tag: number, epoch: number): boolean {
    return this.findSlotWithTag(tag, epoch) !== null;
  }

  hasLostContext(): boolean {
    for (const slot of this.slots) {
      const surface = slot.canvas as HTMLCanvasElement & {
        isContextLost?: () => boolean;
      };
      if (
        typeof surface.isContextLost === 'function' &&
        surface.isContextLost()
      ) {
        return true;
      }
      if (slot.ctx) {
        const ctx2d = slot.ctx as CanvasRenderingContext2D & {
          isContextLost?: () => boolean;
        };
        if (
          typeof ctx2d.isContextLost === 'function' &&
          ctx2d.isContextLost()
        ) {
          return true;
        }
      }
    }
    return false;
  }

  startCallbacks(
    timing: OtioVideoTiming,
    _rL: number,
    onUncoveredStickyIneligible: () => void
  ): void {
    const rvfcVideo = this.videoElement as HTMLVideoElementWithRvfc;
    if (typeof rvfcVideo.requestVideoFrameCallback !== 'function') {
      return;
    }
    const epoch = this.currentEpoch;
    const loop = (): void => {
      if (this.currentEpoch !== epoch || this.videoElement.paused) {
        this.rVfcHandle = null;
        return;
      }
      try {
        this.rVfcHandle = rvfcVideo.requestVideoFrameCallback!(
          (now: number, metadata: VideoFrameCallbackMetadata) => {
            this.rVfcHandle = null;
            if (this.currentEpoch !== epoch || this.videoElement.paused) {
              return;
            }
            this.lastCallbackWallMs = now;
            const outcome = presentedWindowOutcome(metadata.mediaTime, timing);
            if (outcome.kind === 'match') {
              this.consecutiveUncovered = 0;
              if (this.slots.length > 0) {
                const slot = this.slots[this.nextSlotIndex];
                this.nextSlotIndex =
                  (this.nextSlotIndex + 1) % this.slots.length;
                if (slot) {
                  slot.tag = outcome.index;
                  slot.epoch = epoch;
                  slot.lead = 0;
                  if (slot.ctx) {
                    try {
                      slot.ctx.clearRect(
                        0,
                        0,
                        slot.canvas.width,
                        slot.canvas.height
                      );
                      slot.ctx.drawImage(
                        this.videoElement,
                        0,
                        0,
                        slot.canvas.width,
                        slot.canvas.height
                      );
                    } catch {}
                  }
                }
              }
              if (
                this.startupWaiter &&
                this.startupFirstAdvancedTag !== null &&
                outcome.index >= this.startupFirstAdvancedTag
              ) {
                const waiter = this.startupWaiter;
                this.startupWaiter = null;
                waiter.resolve({ now, tag: outcome.index });
              }
              loop();
            } else if (outcome.kind === 'uncovered') {
              this.consecutiveUncovered += 1;
              this.totalUncovered += 1;
              if (this.isStarting || this.consecutiveUncovered >= 2) {
                onUncoveredStickyIneligible();
                return;
              }
              loop();
            } else {
              // outside span: ignored, re-register
              loop();
            }
          }
        );
      } catch {
        this.rVfcHandle = null;
      }
    };
    loop();
  }
}
