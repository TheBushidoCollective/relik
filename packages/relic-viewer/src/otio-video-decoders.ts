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

export type HTMLVideoElementWithRvfc = Omit<
  HTMLVideoElement,
  'requestVideoFrameCallback' | 'cancelVideoFrameCallback'
> & {
  requestVideoFrameCallback?(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
};

export type PresentedWindowOutcome =
  | { readonly kind: 'match'; readonly index: number }
  | { readonly kind: 'uncovered' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'backpressure' }
  | { readonly kind: 'producer-fault' }
  | { readonly kind: 'readout-failed' };

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
  if (index === null || !timing || timing.kind !== 'windows') return null;
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
      if (mediaTime >= start - q && mediaTime <= start + q) {
        const diff = Math.abs(mediaTime - start);
        if (diff < minDiff) {
          minDiff = diff;
          matchedIndex = candidate;
        }
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
 * Reads the frame the decoder presents now and classifies it against the
 * certified windows. A frame comes back only on a match; the caller owns it
 * and must close it. Every other outcome closes the frame here.
 */
export function readPresentedFrame(
  video: HTMLVideoElement,
  timing: OtioVideoTiming | null
): { outcome: PresentedWindowOutcome; frame: VideoFrame | null } {
  let vf: VideoFrame | null = null;
  try {
    vf = new VideoFrame(video);
    const outcome = presentedWindowOutcome(vf.timestamp / 1e6, timing);
    if (outcome.kind === 'match') {
      const frame = vf;
      vf = null;
      return { outcome, frame };
    }
    const rejected = vf;
    vf = null;
    rejected.close();
    return { outcome, frame: null };
  } catch {
    vf?.close();
    return { outcome: { kind: 'readout-failed' }, frame: null };
  }
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
  if (timing.kind !== 'windows') return 1 / 30;
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
  if (timing.kind !== 'windows') return 1 / 30;
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
  /** Retained slots K of this decoder ring; undefined means the 3-slot ring. */
  readonly residentSlots?: number;
}

export interface PhaseAnchorResult {
  readonly tauStar: number; // wallMs in ms
  readonly maxSpreadMs: number;
  readonly spreadLimitMs: number;
  readonly spreadAcceptable: boolean;
}

/**
 * Closed-form phase anchor calculation:
 * leadTarget = (vsync + (K - 1) * W_min,L) / 2
 * deltaSeconds = leadTarget - (starts[i_L0 + 1] - s_L(T0)) / r_L
 * tau_L = d_L + deltaSeconds * 1000 (ms)
 * tau* = (min tau_L + max tau_L) / 2
 * spreadLimit = min_L((K - 1) * W_min,L - vsync) * 1000 (ms)
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
    const retained = residentSlotCount(sample);
    const leadTarget = (vsyncSeconds + (retained - 1) * sample.wMinSeconds) / 2;
    const uL = sample.iL0Plus1Start - sample.sourceT0Seconds;
    const deltaSeconds = leadTarget - uL / sample.rL;
    const tauL = sample.dL + deltaSeconds * 1000;

    if (tauL < minTau) minTau = tauL;
    if (tauL > maxTau) maxTau = tauL;

    const spreadLimitL =
      ((retained - 1) * sample.wMinSeconds - vsyncSeconds) * 1000;
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

export interface OtioAudioClockBridge {
  readonly contextTime: number;
  readonly performanceTime: number;
  readonly mappingAllowanceMs: number;
}

export interface OtioCausalEpoch {
  readonly contextFrame: number;
  readonly contextTime: number;
  readonly performanceTime: number;
  readonly intervalLower: number;
  readonly intervalUpper: number;
}

/**
 * Retained slots K of a phase sample. A frame presented at dL stays resident
 * until K later frames have been captured into the ring. Absent means the
 * 3-slot ring that every existing archive was certified with.
 */
export function residentSlotCount(sample: DecoderPhaseSample): number {
  return sample.residentSlots ?? SNAPSHOT_SLOTS_PER_DECODER;
}

export function isRetainedSlotCount(slots: number): boolean {
  return Number.isSafeInteger(slots) && slots >= SNAPSHOT_SLOTS_PER_DECODER;
}

/**
 * Phase band of one leaf, in wall milliseconds. Let offset be the wall time
 * from T0 to the start of the first advanced frame, (starts[i+1] - s(T0)) / r.
 * The transition to that frame must land:
 * - at least one vsync after dL, so the frame is presented before it is due;
 * - at most (K-1) * wMin after dL. Frame i+1 is evicted by the K-th capture
 *   after dL, which comes no earlier than K * wMin later, so the frame is
 *   still resident through its own window only while the transition is within
 *   (K-1) * wMin.
 * At K = 3 the upper edge is dL + 2 * wMin - offset, the original band.
 */
export function phaseBandMs(
  sample: DecoderPhaseSample,
  vsyncSeconds: number
): { readonly lower: number; readonly upper: number } {
  const offset = (sample.iL0Plus1Start - sample.sourceT0Seconds) / sample.rL;
  const windows = residentSlotCount(sample) - 1;
  return {
    lower: sample.dL + 1000 * (vsyncSeconds - offset),
    upper: sample.dL + 1000 * (windows * sample.wMinSeconds - offset),
  };
}

/**
 * Retained slots a legacy cold start needs so its earliest guarded epoch lies
 * inside the phase band. The epoch falls leadSeconds after the sampling
 * instant, where leadSeconds is the measured output latency plus the selection
 * reserve. Sampling trails dL by at most one vsync. Solving
 * (K-1) * wMin >= vsync + lead + offset gives K, and K never drops below 3.
 * Returns null when an input is unusable, so the caller keeps its ring.
 */
export function requiredResidentSlots(input: {
  readonly leadSeconds: number;
  readonly vsyncSeconds: number;
  readonly offsetSeconds: number;
  readonly wMinSeconds: number;
}): number | null {
  const { leadSeconds, vsyncSeconds, offsetSeconds, wMinSeconds } = input;
  if (
    !Number.isFinite(leadSeconds) ||
    leadSeconds < 0 ||
    !Number.isFinite(vsyncSeconds) ||
    vsyncSeconds <= 0 ||
    !Number.isFinite(offsetSeconds) ||
    offsetSeconds < 0 ||
    !Number.isFinite(wMinSeconds) ||
    wMinSeconds < vsyncSeconds
  )
    return null;
  const reach = vsyncSeconds + leadSeconds + offsetSeconds;
  return Math.max(
    SNAPSHOT_SLOTS_PER_DECODER,
    1 + Math.ceil(reach / wMinSeconds)
  );
}

/**
 * Outcome of causal epoch selection with the evidence needed to explain a
 * refusal. `earliestWall` is the performance time of the earliest guarded
 * frame; `upperWall` is the lowest phase-band upper edge. Both are null when
 * the inputs are unusable.
 */
export interface OtioCausalEpochPlan {
  readonly epoch: OtioCausalEpoch | null;
  readonly earliestWall: number | null;
  readonly upperWall: number | null;
}

const UNUSABLE_CAUSAL_EPOCH: OtioCausalEpochPlan = {
  epoch: null,
  earliestWall: null,
  upperWall: null,
};

/** Select a future integer audio frame inside every admitted video phase band. */
export function selectOtioCausalEpoch(
  samples: readonly DecoderPhaseSample[],
  vsyncSeconds: number,
  bridge: OtioAudioClockBridge,
  sampleRate: number,
  contextNow: number,
  requestWall: number,
  nowWall: number,
  guardFrames: number
): OtioCausalEpoch | null {
  return planOtioCausalEpoch(
    samples,
    vsyncSeconds,
    bridge,
    sampleRate,
    contextNow,
    requestWall,
    nowWall,
    guardFrames
  ).epoch;
}

/**
 * Places the earliest guarded epoch. The epoch is refused when it lands before
 * the safe wall or after the band's upper edge. A refusal past the upper edge
 * means the rings were too short; the plan keeps the evidence to tell that apart
 * from clock, deadline or input failures.
 */
export function planOtioCausalEpoch(
  samples: readonly DecoderPhaseSample[],
  vsyncSeconds: number,
  bridge: OtioAudioClockBridge,
  sampleRate: number,
  contextNow: number,
  requestWall: number,
  nowWall: number,
  guardFrames: number
): OtioCausalEpochPlan {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(guardFrames) ||
    guardFrames < 0 ||
    !Number.isFinite(vsyncSeconds) ||
    vsyncSeconds <= 0 ||
    !Number.isFinite(bridge.contextTime) ||
    !Number.isFinite(bridge.performanceTime) ||
    !Number.isFinite(bridge.mappingAllowanceMs) ||
    bridge.mappingAllowanceMs < 0 ||
    !Number.isFinite(contextNow) ||
    !Number.isFinite(requestWall) ||
    !Number.isFinite(nowWall)
  )
    return UNUSABLE_CAUSAL_EPOCH;
  if (samples.some((sample) => !isRetainedSlotCount(residentSlotCount(sample))))
    return UNUSABLE_CAUSAL_EPOCH;
  let lower = -Infinity;
  let upper = Infinity;
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.dL) ||
      !Number.isFinite(sample.iL0Plus1Start) ||
      !Number.isFinite(sample.sourceT0Seconds) ||
      !Number.isFinite(sample.rL) ||
      sample.rL <= 0 ||
      !Number.isFinite(sample.wMinSeconds) ||
      sample.wMinSeconds < vsyncSeconds
    )
      return UNUSABLE_CAUSAL_EPOCH;
    const band = phaseBandMs(sample, vsyncSeconds);
    lower = Math.max(lower, band.lower);
    upper = Math.min(upper, band.upper);
  }
  const safeWall = Math.max(
    lower + bridge.mappingAllowanceMs,
    requestWall,
    nowWall
  );
  const contextAtSafeWall =
    bridge.contextTime + (safeWall - bridge.performanceTime) / 1000;
  const contextFrame = Math.max(
    Math.ceil(contextAtSafeWall * sampleRate),
    Math.ceil(contextNow * sampleRate) + guardFrames
  );
  if (!Number.isSafeInteger(contextFrame) || contextFrame < 0)
    return UNUSABLE_CAUSAL_EPOCH;
  const contextTime = contextFrame / sampleRate;
  const performanceTime =
    bridge.performanceTime + 1000 * (contextTime - bridge.contextTime);
  const placed =
    performanceTime >= safeWall &&
    performanceTime + bridge.mappingAllowanceMs <= upper;
  return {
    epoch: placed
      ? {
          contextFrame,
          contextTime,
          performanceTime,
          intervalLower: lower,
          intervalUpper: upper,
        }
      : null,
    earliestWall: performanceTime,
    upperWall: upper,
  };
}

/**
 * What a cold start does with its epoch selection result. A start that was
 * superseded by a newer start never fails anything: the newer start owns the
 * scheduler. Only a refusal past the band's upper edge is a ring shortage.
 */
export type ColdEpochVerdict =
  | 'superseded'
  | 'placed'
  | 'refused-slot-limited'
  | 'refused-explicit';

export function coldEpochVerdict(input: {
  readonly superseded: boolean;
  readonly epochPlaced: boolean;
  readonly ringsHoldTags: boolean;
  readonly slotLimited: boolean;
}): ColdEpochVerdict {
  if (input.superseded) return 'superseded';
  if (input.epochPlaced && input.ringsHoldTags) return 'placed';
  return input.slotLimited ? 'refused-slot-limited' : 'refused-explicit';
}

export interface NativeSnapshotSlot {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D | null;
  tag: number | null;
  epoch: number;
  lead: number;
}

export interface NativeSnapshotReservation {
  readonly epoch: number;
  readonly occurrence: string;
  readonly tags: readonly number[];
  isValid(): boolean;
  release(): void;
}

export interface NativeSnapshotIdentity {
  readonly videoElement: HTMLVideoElement;
  readonly bundlePath: string;
  readonly width: number;
  readonly height: number;
  readonly onInvalidated?: () => void;
}

/**
 * What a ring holds after a resize. `refused` keeps the previous count,
 * reported as `slots`; `slots` is 0 when the ring was not held before.
 * `restore-failed` means the ring is empty and cannot serve frames.
 */
export type RingResizeOutcome =
  | { readonly kind: 'reached'; readonly slots: number }
  | {
      readonly kind: 'refused';
      readonly slots: number;
      readonly cause: 'cap' | 'allocation';
    }
  | { readonly kind: 'restore-failed' };

export interface RetainedRingTarget {
  readonly ring: NativeDecoderRing;
  readonly slots: number;
}

/**
 * Resizes rings to their targets in two passes. Every ring above its target
 * shrinks first, so the budget it gives back is available to any ring that
 * grows. The second pass then reports each ring's outcome.
 */
export function resizeRetainedRings(
  targets: readonly RetainedRingTarget[],
  width: number,
  height: number
): RingResizeOutcome[] {
  for (const { ring, slots } of targets) {
    if (ring.allocated && ring.slotCount > slots) {
      ring.resize(width, height, slots);
    }
  }
  return targets.map(({ ring, slots }) => ring.resize(width, height, slots));
}

export class NativeDecoderRing {
  readonly slots: NativeSnapshotSlot[] = [];
  private nextSlotIndex = 0;
  private currentEpoch = 0;
  private rVfcHandle: number | null = null;
  private allocatedPixels = 0;
  private allocatedSlots = SNAPSHOT_SLOTS_PER_DECODER;
  private reservationGeneration = 0;
  private readonly pinnedSlots = new Map<NativeSnapshotSlot, number>();
  private readonly invalidationListeners = new Set<() => void>();
  private readonly progressListeners = new Set<() => void>();
  private callbackGeneration = 0;
  private strictProducerOrder: boolean;
  private observedTag: number | null = null;
  private producerFault = false;
  private width = 0;
  private height = 0;

  private notifyProgress(): void {
    for (const listener of [...this.progressListeners]) {
      try {
        listener();
      } catch {
        // A subscriber cannot prevent capture or invalidate other subscribers.
      }
    }
  }

  private invalidateReservations(): void {
    this.reservationGeneration++;
    const listeners = [...this.invalidationListeners];
    this.invalidationListeners.clear();
    this.pinnedSlots.clear();
    for (const notify of listeners) {
      try {
        notify();
      } catch {
        // One consumer must not prevent the other leases being invalidated.
      }
    }
    this.notifyProgress();
  }

  private readonly onContextLost = (): void => {
    this.invalidateReservations();
  };

  consecutiveUncovered = 0;
  totalUncovered = 0;
  lastCallbackWallMs: number | null = null;
  lastCapturedTag: number | null = null;
  lastProgressTag: number | null = null;
  lastProgressWallMs: number | null = null;
  isStarting = false;
  startupFirstAdvancedTag: number | null = null;
  timing: OtioVideoTiming | null = null;
  startupWaiter: {
    resolve: (sample: { now: number; capturedAt: number; tag: number }) => void;
    reject?: (reason?: unknown) => void;
  } | null = null;
  constructor(
    readonly videoElement: HTMLVideoElement,
    readonly key: string,
    readonly bundlePath: string,
    private readonly budget: SnapshotPixelBudget,
    options: { readonly strictProducerOrder?: boolean } = {}
  ) {
    this.strictProducerOrder = options.strictProducerOrder === true;
  }

  get captureEpoch(): number {
    return this.currentEpoch;
  }

  /** Retained snapshot slots this ring holds, the K in its phase bound. */
  get slotCount(): number {
    return this.allocatedSlots;
  }

  get highestObservedTag(): number | null {
    return this.observedTag;
  }

  /** Changing mode seals the old epoch; call resetEpoch before further capture. */
  setStrictProducerOrder(strict: boolean): void {
    if (this.strictProducerOrder === strict) return;
    this.strictProducerOrder = strict;
    this.producerFault = true;
    this.invalidateReservations();
  }

  subscribeProgress(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  allocate(width: number, height: number, slotCount?: number): boolean {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      typeof document === 'undefined' ||
      !document.createElement
    ) {
      return false;
    }
    const wanted = slotCount ?? this.allocatedSlots;
    if (!isRetainedSlotCount(wanted)) return false;
    if (
      this.width === width &&
      this.height === height &&
      this.allocatedSlots === wanted &&
      this.slots.length === wanted &&
      !this.hasLostContext()
    ) {
      return true;
    }
    const needed = wanted * width * height;
    if (!Number.isSafeInteger(needed)) return false;
    this.release();
    if (!this.budget.allocate(needed)) return false;
    this.allocatedPixels = needed;
    this.allocatedSlots = wanted;
    try {
      for (let i = 0; i < wanted; i++) {
        const canvas = document.createElement('canvas');
        // Register the surface before any operation that can throw.
        const slot: NativeSnapshotSlot = {
          canvas,
          ctx: null,
          tag: null,
          epoch: -1,
          lead: 0,
        };
        this.slots.push(slot);
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('snapshot-context-unavailable');
        this.slots[i] = { ...slot, ctx };
        canvas.addEventListener?.('contextlost', this.onContextLost);
      }
      this.width = width;
      this.height = height;
      return true;
    } catch {
      this.release();
      return false;
    }
  }

  /** Whether canvases are held now. slotCount alone does not say so. */
  get allocated(): boolean {
    return this.slots.length > 0;
  }

  /**
   * Moves the ring to `slots` retained canvases. A refused allocation has
   * already released the ring, so the previous count and size are restored
   * when they can be. The outcome names what the ring holds afterwards.
   */
  resize(width: number, height: number, slots: number): RingResizeOutcome {
    const previous = this.allocated
      ? { slots: this.slotCount, width: this.width, height: this.height }
      : null;
    if (this.allocate(width, height, slots)) {
      return { kind: 'reached', slots: this.slotCount };
    }
    // The release inside allocate already returned this ring's pixels, so
    // this asks whether the requested count fits the cap on its own.
    const cause = this.budget.canAllocate(slots * width * height)
      ? 'allocation'
      : 'cap';
    if (previous === null) return { kind: 'refused', slots: 0, cause };
    if (this.allocate(previous.width, previous.height, previous.slots)) {
      return { kind: 'refused', slots: previous.slots, cause };
    }
    return { kind: 'restore-failed' };
  }

  release(): void {
    this.invalidateReservations();
    this.observedTag = null;
    this.producerFault = false;
    this.cancelCallback();
    if (this.startupWaiter) {
      const waiter = this.startupWaiter;
      this.startupWaiter = null;
      waiter.reject?.(new Error('ring-released'));
    }
    for (const slot of this.slots) {
      slot.canvas.removeEventListener?.('contextlost', this.onContextLost);
      try {
        slot.canvas.width = 0;
        slot.canvas.height = 0;
      } catch {}
      slot.tag = null;
      slot.epoch = -1;
    }
    this.slots.length = 0;
    this.width = 0;
    this.height = 0;
    this.allocatedSlots = SNAPSHOT_SLOTS_PER_DECODER;
    if (this.allocatedPixels > 0) {
      this.budget.release(this.allocatedPixels);
      this.allocatedPixels = 0;
    }
  }

  cancelCallback(): void {
    this.callbackGeneration++;
    const rvfcVideo = this.videoElement as HTMLVideoElementWithRvfc;
    if (
      this.rVfcHandle !== null &&
      typeof rvfcVideo.cancelVideoFrameCallback === 'function'
    ) {
      try {
        rvfcVideo.cancelVideoFrameCallback(this.rVfcHandle);
      } catch {}
    }
    this.rVfcHandle = null;
  }

  resetEpoch(newEpoch: number): void {
    this.invalidateReservations();
    this.cancelCallback();
    if (this.startupWaiter) {
      const waiter = this.startupWaiter;
      this.startupWaiter = null;
      waiter.reject?.(new Error('epoch-reset'));
    }
    this.currentEpoch = newEpoch;
    this.observedTag = null;
    this.producerFault = false;
    this.nextSlotIndex = 0;
    this.consecutiveUncovered = 0;
    this.startupFirstAdvancedTag = null;
    this.lastCapturedTag = null;
    this.lastProgressTag = null;
    this.lastProgressWallMs = null;
    this.lastCallbackWallMs = null;
    for (const slot of this.slots) {
      slot.tag = null;
      slot.epoch = -1;
    }
  }

  recordProgress(outcome: PresentedWindowOutcome, now: number): void {
    if (outcome.kind !== 'match') return;
    if (this.lastProgressTag !== null && outcome.index <= this.lastProgressTag)
      return;
    this.lastProgressTag = outcome.index;
    this.lastProgressWallMs = now;
  }

  admitStartupCapture(
    outcome: PresentedWindowOutcome,
    epoch: number,
    now: number,
    capturedAt: number
  ): void {
    if (
      epoch !== this.currentEpoch ||
      outcome.kind !== 'match' ||
      this.startupFirstAdvancedTag === null ||
      outcome.index < this.startupFirstAdvancedTag ||
      !this.hasTag(outcome.index, epoch)
    )
      return;
    const waiter = this.startupWaiter;
    if (!waiter) return;
    this.startupWaiter = null;
    waiter.resolve({ now, capturedAt, tag: outcome.index });
  }

  readoutFrame(
    timing: OtioVideoTiming,
    epoch: number,
    initialExpectedTag?: number
  ): PresentedWindowOutcome {
    if (this.producerFault) return { kind: 'producer-fault' };
    if (epoch !== this.currentEpoch || this.hasLostContext()) {
      if (epoch === this.currentEpoch) this.invalidateReservations();
      return { kind: 'readout-failed' };
    }
    const { outcome, frame } = readPresentedFrame(this.videoElement, timing);
    if (outcome.kind !== 'match' || frame === null) return outcome;
    let notify = false;
    try {
      // A paused seek can still expose the preceding presented frame. It is
      // not evidence about the new epoch until the sought frame appears.
      if (
        initialExpectedTag !== undefined &&
        this.observedTag === null &&
        outcome.index !== initialExpectedTag
      )
        return { kind: 'outside' };
      notify = true;
      if (
        this.strictProducerOrder &&
        this.observedTag !== null &&
        outcome.index < this.observedTag
      ) {
        this.producerFault = true;
        this.invalidateReservations();
        return { kind: 'producer-fault' };
      }
      this.observedTag = Math.max(
        this.observedTag ?? outcome.index,
        outcome.index
      );
      if (this.findSlotWithTag(outcome.index, epoch)) {
        this.lastCapturedTag = outcome.index;
        return outcome;
      }
      let slotIndex = this.nextSlotIndex;
      let slot: NativeSnapshotSlot | undefined;
      for (let i = 0; i < this.slots.length; i++) {
        slotIndex = (this.nextSlotIndex + i) % this.slots.length;
        const candidate = this.slots[slotIndex];
        if (candidate && !this.pinnedSlots.has(candidate)) {
          slot = candidate;
          break;
        }
      }
      if (!slot) return { kind: 'backpressure' };
      const ctx = slot.ctx;
      slot.tag = null;
      slot.epoch = -1;
      if (!ctx) return { kind: 'readout-failed' };
      try {
        ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
        ctx.drawImage(frame, 0, 0, slot.canvas.width, slot.canvas.height);
      } catch {
        return { kind: 'readout-failed' };
      }
      this.nextSlotIndex = (slotIndex + 1) % this.slots.length;
      slot.tag = outcome.index;
      slot.epoch = epoch;
      slot.lead = 0;
      this.lastCapturedTag = outcome.index;
      return outcome;
    } finally {
      frame.close();
      if (notify) this.notifyProgress();
    }
  }

  capturePausedFrame(
    expectedTag: number,
    epoch: number,
    timing?: OtioVideoTiming
  ): boolean {
    if (timing) {
      this.timing = timing;
    }
    const effectiveTiming = timing ?? this.timing;
    if (!effectiveTiming) {
      return false;
    }
    if (this.currentEpoch !== epoch) {
      return false;
    }
    const outcome = this.readoutFrame(effectiveTiming, epoch, expectedTag);
    return outcome.kind === 'match' && outcome.index === expectedTag;
  }

  findSlotWithTag(tag: number, epoch: number): NativeSnapshotSlot | null {
    if (epoch !== this.currentEpoch || this.producerFault) return null;
    if (this.hasLostContext()) {
      this.invalidateReservations();
      return null;
    }
    for (const slot of this.slots) {
      if (
        slot.ctx &&
        slot.canvas.width === this.width &&
        slot.canvas.height === this.height &&
        slot.epoch === epoch &&
        slot.tag === tag
      ) {
        return slot;
      }
    }
    return null;
  }

  hasTag(tag: number, epoch: number): boolean {
    return this.findSlotWithTag(tag, epoch) !== null;
  }

  /** Tags held by slots of the current epoch, each with its slot index. */
  residentTags(): { readonly slot: number; readonly tag: number }[] {
    const resident: { slot: number; tag: number }[] = [];
    this.slots.forEach((slot, index) => {
      if (slot.tag !== null && slot.epoch === this.currentEpoch)
        resident.push({ slot: index, tag: slot.tag });
    });
    return resident;
  }

  reserveTags(
    tags: readonly number[],
    epoch: number,
    identity?: NativeSnapshotIdentity
  ): NativeSnapshotReservation | null {
    if (this.producerFault) return null;
    if (this.hasLostContext()) {
      this.invalidateReservations();
      return null;
    }
    if (
      epoch !== this.currentEpoch ||
      (identity &&
        (identity.videoElement !== this.videoElement ||
          identity.bundlePath !== this.bundlePath ||
          identity.width !== this.width ||
          identity.height !== this.height))
    )
      return null;
    const unique = [...new Set(tags)];
    const slots: NativeSnapshotSlot[] = [];
    for (const tag of unique) {
      const slot = this.findSlotWithTag(tag, epoch);
      if (!slot) return null;
      slots.push(slot);
    }
    const generation = this.reservationGeneration;
    const width = this.width;
    const height = this.height;
    const surfaces = slots.map((slot) => ({
      canvas: slot.canvas,
      ctx: slot.ctx,
    }));
    for (const slot of slots)
      this.pinnedSlots.set(slot, (this.pinnedSlots.get(slot) ?? 0) + 1);
    let released = false;
    let notified = false;
    const notify = (): void => {
      if (released || notified) return;
      notified = true;
      identity?.onInvalidated?.();
    };
    this.invalidationListeners.add(notify);
    return {
      epoch,
      occurrence: this.key,
      tags: unique,
      isValid: () => {
        if (released || generation !== this.reservationGeneration) return false;
        const valid =
          epoch === this.currentEpoch &&
          this.width === width &&
          this.height === height &&
          !this.hasLostContext() &&
          slots.every(
            (slot, index) =>
              this.slots.includes(slot) &&
              slot.canvas === surfaces[index]?.canvas &&
              slot.ctx === surfaces[index]?.ctx &&
              slot.ctx !== null &&
              slot.canvas.width === width &&
              slot.canvas.height === height &&
              slot.epoch === epoch &&
              slot.tag === unique[index]
          );
        if (!valid) this.invalidateReservations();
        return valid;
      },
      release: () => {
        if (released) return;
        released = true;
        this.invalidationListeners.delete(notify);
        if (generation !== this.reservationGeneration) return;
        for (const slot of slots) {
          const count = this.pinnedSlots.get(slot) ?? 0;
          if (count <= 1) this.pinnedSlots.delete(slot);
          else this.pinnedSlots.set(slot, count - 1);
        }
      },
    };
  }

  hasLostContext(): boolean {
    if (
      this.slots.length !== this.allocatedSlots ||
      this.width <= 0 ||
      this.height <= 0
    )
      return true;
    for (const slot of this.slots) {
      if (
        !slot.ctx ||
        slot.canvas.width !== this.width ||
        slot.canvas.height !== this.height
      )
        return true;
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
    onUncoveredStickyIneligible: () => void,
    onBackpressure?: () => void
  ): void {
    this.timing = timing;
    const rvfcVideo = this.videoElement as HTMLVideoElementWithRvfc;
    if (typeof rvfcVideo.requestVideoFrameCallback !== 'function') {
      return;
    }
    this.cancelCallback();
    const epoch = this.currentEpoch;
    const callbackGeneration = this.callbackGeneration;
    const loop = (): void => {
      if (callbackGeneration !== this.callbackGeneration) return;
      if (this.currentEpoch !== epoch || this.videoElement.paused) {
        this.rVfcHandle = null;
        return;
      }
      try {
        this.rVfcHandle = rvfcVideo.requestVideoFrameCallback!(
          (now: number, _metadata: VideoFrameCallbackMetadata) => {
            if (callbackGeneration !== this.callbackGeneration) return;
            this.rVfcHandle = null;
            if (this.currentEpoch !== epoch || this.videoElement.paused) {
              return;
            }
            this.lastCallbackWallMs = now;
            const outcome = this.readoutFrame(timing, epoch);
            this.recordProgress(outcome, now);
            if (outcome.kind === 'match') {
              this.consecutiveUncovered = 0;
              this.admitStartupCapture(outcome, epoch, now, performance.now());
              loop();
            } else if (
              outcome.kind === 'uncovered' ||
              outcome.kind === 'readout-failed' ||
              outcome.kind === 'producer-fault'
            ) {
              this.consecutiveUncovered += 1;
              this.totalUncovered += 1;
              if (
                outcome.kind === 'producer-fault' ||
                this.isStarting ||
                this.consecutiveUncovered >= 2
              ) {
                if (this.startupWaiter) {
                  const waiter = this.startupWaiter;
                  this.startupWaiter = null;
                  waiter.reject?.(
                    new Error(
                      outcome.kind === 'producer-fault'
                        ? 'producer-regression-during-startup'
                        : outcome.kind === 'readout-failed'
                          ? 'readout-failed-during-startup'
                          : 'uncovered-during-startup'
                    )
                  );
                }
                onUncoveredStickyIneligible();
                return;
              }
              loop();
            } else if (outcome.kind === 'backpressure') {
              onBackpressure?.();
              loop();
            } else {
              // Outside the certified span.
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
