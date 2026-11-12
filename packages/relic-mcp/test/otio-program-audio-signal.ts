/**
 * Sampled audio signal checks for the primer proof. Pure: the captured samples are compared with
 * the independent source reference (otio-program-reference.ts), sample by sample, after alignment.
 *
 * This module never reads a callback, a trace, or a stream start. Those are telemetry. Only the
 * samples the element actually output can prove an audio gap, so the 20 ms audio budget is proven
 * here and nowhere else.
 *
 * The gap is measured per sample. An earlier per-block measure rounded each silent run down to whole
 * blocks, so a 25 ms silence measured as 24 ms. A rounding error near the budget can turn a failure
 * into a pass, so the run length is counted in samples.
 *
 * Silence is counted from the first delivered program sample. Lead-in silence before the program
 * starts is onset, which the onset bound judges, never a gap. Offset steps are found block by block:
 * any move of the rendered audio against the reference, whether silence was inserted or content was
 * skipped, fails. Each move is placed at the exact reference sample where the old alignment stops
 * matching and the new one starts. Silence belongs to the gap budget, not to the offset walk.
 */

import {
  AUDIO_MIN_SNR_DB,
  alignAudio,
  type AudioFault,
  DROPOUT_EXPECTED_RMS,
  findAudioFaults,
  rms,
} from './otio-program-checks.ts';

/** The user's acceptance: an actual audio gap over this is a failure. Not a tolerance to tune. */
export const AUDIO_GAP_BUDGET_MS = 20;
/** Start offset bound, the same 20 ms the composition stage enforces. */
export const AUDIO_ONSET_BUDGET_MS = 20;
/** Block length used only to decide where the reference is loud enough to test. */
export const AUDIO_BLOCK_MS = 1;
/** A tested sample must have loud reference audio this far either side, so edges are not scored. */
export const AUDIO_GUARD_MS = 30;
/** Fewer tested milliseconds means the reference was not loud enough to judge. That fails. */
export const AUDIO_MIN_TESTED_MS = 3000;
/** Block length of the offset walk: 1024 samples, about 21.3 ms at 48 kHz. */
export const AUDIO_OFFSET_BLOCK_SAMPLES = 1024;
/**
 * A rendered sample at or below this magnitude counts as silent (about -60 dBFS). The program's
 * tone is 0.3 in amplitude, so a real dropout is exact zero or near it, while a zero crossing of a
 * loud signal stays silent for only a sample or two.
 */
export const AUDIO_SILENCE_AMPLITUDE = 1e-3;
/**
 * A silent run this long is a gap, not a zero crossing. A crossing of a loud tone is one sample
 * under the threshold; a dropout is far longer. Eight samples is about 0.17 ms, far inside the budget.
 */
export const AUDIO_MIN_SILENT_RUN_SAMPLES = 8;
/** Program audio boundaries in samples (1 s, 3 s, 4.5 s, 5 s), as the composition stage uses them. */
export const PROGRAM_AUDIO_BOUNDARIES: readonly number[] = [
  48000, 144000, 216000, 240000,
];

/**
 * One place where the rendered audio moved against the reference by a whole number of samples
 * after the walk had locked on. Silence inserted is positive, reference audio skipped is negative.
 */
export interface OffsetStep {
  /** Reference time, in seconds, of the first sample that follows the old alignment and matches the new. */
  readonly startSeconds: number;
  /** Positive: silence was inserted, so the audio moved later. Negative: reference audio was skipped. */
  readonly stepMs: number;
}

export interface SignalEvidence {
  /** Samples the rendered channel is delayed (positive) or early (negative) against the reference. */
  readonly lagSamples: number;
  readonly onsetMs: number;
  readonly snrDb: number;
  readonly testedMs: number;
  /** Longest run of tested samples where the rendered audio is silent, in samples. */
  readonly longestGapSamples: number;
  /** The same run in milliseconds, computed from the samples, not from blocks. */
  readonly longestGapMs: number;
  /** Number of separate silent runs in tested audio. The gate reads only the longest one. */
  readonly silentRuns: number;
  /** Reference time at which the longest gap starts, or null when there is none. */
  readonly gapStartSeconds: number | null;
  /** Every move of the rendered audio against the reference after the walk locked. Any fails. */
  readonly offsetSteps: readonly OffsetStep[];
  readonly windowFaults: readonly AudioFault[];
}

/** Every block that is loud in the reference, with loud blocks on both sides for the guard. */
function testedBlocks(loud: readonly boolean[], guard: number): boolean[] {
  return loud.map((isLoud, index) => {
    if (!isLoud || index - guard < 0 || index + guard >= loud.length)
      return false;
    for (let i = index - guard; i <= index + guard; i++)
      if (!loud[i]) return false;
    return true;
  });
}

/**
 * Signal-to-error ratio in dB of the rendered channel at one lag over reference samples [start, end).
 * The same error the alignment reports, restricted to one block.
 */
function snrAtLag(
  rendered: Float32Array,
  expected: Float32Array,
  start: number,
  end: number,
  lag: number
): number {
  let signal = 0;
  let error = 0;
  for (let n = start; n < end; n++) {
    const x = expected[n] ?? 0;
    const i = n + lag;
    const r = i >= 0 && i < rendered.length ? (rendered[i] ?? 0) : 0;
    signal += x * x;
    error += (r - x) * (r - x);
  }
  return error > 0 ? 10 * Math.log10(signal / error) : Number.POSITIVE_INFINITY;
}

/**
 * True when the rendered audio at this lag holds a silent run of at least the minimum length in
 * [start, end), or runs out of the captured span there. Such a block holds a gap, which the gap
 * budget judges, not a moved copy.
 */
function silentAtLag(
  rendered: Float32Array,
  start: number,
  end: number,
  lag: number
): boolean {
  let run = 0;
  for (let n = start; n < end; n++) {
    const i = n + lag;
    if (i < 0 || i >= rendered.length) return true;
    run = Math.abs(rendered[i] ?? 0) <= AUDIO_SILENCE_AMPLITUDE ? run + 1 : 0;
    if (run >= AUDIO_MIN_SILENT_RUN_SAMPLES) return true;
  }
  return false;
}

/**
 * The lag within maxLag of the anchor at which one block matches the rendered channel best, or null
 * when even the best lag is below the strong SNR bound. Ties go to the lag nearest the anchor, so
 * an equally good alias of a periodic signal never displaces the lag the capture was already on.
 */
function bestPassingLag(
  rendered: Float32Array,
  expected: Float32Array,
  start: number,
  end: number,
  anchor: number,
  maxLag: number
): number | null {
  // Silence in the whole search window cannot be a shifted copy of the reference.
  let energy = 0;
  for (
    let i = Math.max(0, start - maxLag);
    i < Math.min(rendered.length, end + maxLag);
    i++
  ) {
    const v = rendered[i] ?? 0;
    energy += v * v;
  }
  if (energy === 0) return null;

  let best: number | null = null;
  let bestSnr = Number.NEGATIVE_INFINITY;
  for (let d = 0; d <= 2 * maxLag; d++) {
    const candidates = d === 0 ? [anchor] : [anchor + d, anchor - d];
    for (const lag of candidates) {
      if (lag < -maxLag || lag > maxLag) continue;
      const snr = snrAtLag(rendered, expected, start, end, lag);
      if (snr > bestSnr) {
        bestSnr = snr;
        best = lag;
      }
    }
  }
  return bestSnr >= AUDIO_MIN_SNR_DB ? best : null;
}

/**
 * The reference sample where the audio stops following the old lag and starts following the new
 * one, searched over [from, to). A sample follows a lag when the rendered audio there equals the
 * reference within the silence amplitude. The split maximises the samples that follow the old lag
 * before it and the new lag after it. Ties go to the earliest split.
 */
function stepStart(
  rendered: Float32Array,
  expected: Float32Array,
  from: number,
  to: number,
  oldLag: number,
  newLag: number
): number {
  const follows = (n: number, lag: number): boolean => {
    const i = n + lag;
    if (i < 0 || i >= rendered.length) return false;
    return (
      Math.abs((rendered[i] ?? 0) - (expected[n] ?? 0)) <=
      AUDIO_SILENCE_AMPLITUDE
    );
  };
  let score = 0;
  for (let n = from; n < to; n++) if (follows(n, newLag)) score++;
  let best = from;
  let bestScore = score;
  for (let p = from; p < to; p++) {
    if (follows(p, oldLag)) score++;
    if (follows(p, newLag)) score--;
    if (score > bestScore) {
      bestScore = score;
      best = p + 1;
    }
  }
  return best;
}

/**
 * Walks the reference block by block and records each change of lag once the walk has locked.
 * Only blocks where every sample is tested are judged. A block that matches the current lag keeps
 * it and confirms the audio up to its end. Once locked, a block that mismatches and holds silence at
 * the current lag is a gap, left to the gap budget. Any other mismatch searches for the best lag,
 * and a found change is placed at the exact reference sample where the audio moves, searched from
 * the last confirmed sample. A change is recorded only after the walk has locked, so the first lock
 * is never a step.
 */
function findOffsetSteps(
  rendered: Float32Array,
  expected: Float32Array,
  rate: number,
  anchor: number,
  tested: readonly boolean[],
  testBlock: number
): OffsetStep[] {
  const block = AUDIO_OFFSET_BLOCK_SAMPLES;
  const maxLag = 2 * Math.round((AUDIO_ONSET_BUDGET_MS * rate) / 1000);
  const steps: OffsetStep[] = [];
  let current = anchor;
  let locked = false;
  let confirmed = 0;
  for (let start = 0; start + block <= expected.length; start += block) {
    const end = start + block;
    let judged = true;
    for (let n = start; n < end && judged; n++)
      judged = tested[Math.floor(n / testBlock)] === true;
    if (!judged) continue;

    if (snrAtLag(rendered, expected, start, end, current) >= AUDIO_MIN_SNR_DB) {
      locked = true;
      confirmed = end;
      continue;
    }
    if (locked && silentAtLag(rendered, start, end, current)) continue;

    const found = bestPassingLag(
      rendered,
      expected,
      start,
      end,
      current,
      maxLag
    );
    if (found === null) continue;
    if (locked) {
      const at = stepStart(rendered, expected, confirmed, end, current, found);
      steps.push({
        startSeconds: at / rate,
        stepMs: ((found - current) * 1000) / rate,
      });
    }
    current = found;
    locked = true;
    confirmed = end;
  }
  return steps;
}

/**
 * Aligns one rendered channel to the reference, then measures silence over every tested sample
 * from the first delivered program sample on. The reference is cut to the captured span so nothing
 * is scored past what was recorded. `startSample` is the program sample at which the rendered
 * channel's first sample was delivered (default 0). It moves the reference slice, the program
 * boundaries, and the reported gap time to absolute program time. Lag keeps its sign: positive
 * means the rendered audio is late against the reference.
 */
export function measureSignal(
  rendered: Float32Array,
  reference: Float32Array,
  rate: number,
  startSample: number = 0
): SignalEvidence {
  const onsetSamples = Math.round((AUDIO_ONSET_BUDGET_MS * rate) / 1000);
  if (!Number.isInteger(startSample) || startSample < 0)
    throw new Error(
      `startSample must be a non-negative integer, got ${startSample}`
    );
  const span = Math.min(
    reference.length - startSample,
    rendered.length - 2 * onsetSamples
  );
  const expected = reference.subarray(
    startSample,
    startSample + Math.max(0, span)
  );
  const alignment = alignAudio(rendered, expected, 2 * onsetSamples);
  const lag = alignment.lagSamples;

  const block = Math.round((AUDIO_BLOCK_MS * rate) / 1000);
  const blocks = Math.floor(expected.length / block);
  const loud: boolean[] = [];
  for (let b = 0; b < blocks; b++) {
    const start = b * block;
    loud.push(rms(expected, start, start + block) >= DROPOUT_EXPECTED_RMS);
  }
  const guard = Math.round(AUDIO_GUARD_MS / AUDIO_BLOCK_MS);
  const tested = testedBlocks(loud, guard);

  const end = blocks * block;
  let testedSamples = 0;
  let delivered = false;
  let run = 0;
  let longest = 0;
  let silentRuns = 0;
  let longestEnd = -1;
  for (let n = 0; n < end; n++) {
    if (tested[Math.floor(n / block)] !== true) {
      run = 0;
      continue;
    }
    testedSamples++;
    const magnitude = Math.abs(rendered[n + lag] ?? 0);
    // Before the first delivered sample the program has not started. That lead-in is onset.
    if (!delivered) {
      delivered = magnitude > AUDIO_SILENCE_AMPLITUDE;
      continue;
    }
    if (magnitude <= AUDIO_SILENCE_AMPLITUDE) {
      if (run === 0) silentRuns++;
      run++;
      if (run > longest) {
        longest = run;
        longestEnd = n;
      }
    } else {
      run = 0;
    }
  }

  const startSeconds = startSample / rate;
  const windowFaults = findAudioFaults(
    rendered,
    expected,
    rate,
    lag,
    PROGRAM_AUDIO_BOUNDARIES.map((edge) => edge - startSample)
  ).map((fault) => ({
    ...fault,
    startSeconds: fault.startSeconds + startSeconds,
  }));
  return {
    lagSamples: lag,
    onsetMs: (lag * 1000) / rate,
    snrDb: alignment.snrDb,
    testedMs: (testedSamples * 1000) / rate,
    longestGapSamples: longest,
    longestGapMs: (longest * 1000) / rate,
    silentRuns,
    gapStartSeconds:
      longestEnd < 0 ? null : (startSample + longestEnd - longest + 1) / rate,
    offsetSteps: findOffsetSteps(
      rendered,
      expected,
      rate,
      lag,
      tested,
      block
    ).map((step) => ({
      ...step,
      startSeconds: step.startSeconds + startSeconds,
    })),
    windowFaults,
  };
}

/** Every failure of one channel's sampled evidence. Empty means the channel passes. */
export function gateSignal(evidence: SignalEvidence, label: string): string[] {
  const failures: string[] = [];
  if (Math.abs(evidence.onsetMs) > AUDIO_ONSET_BUDGET_MS)
    failures.push(
      `${label}: onset ${evidence.onsetMs.toFixed(1)} ms > ${AUDIO_ONSET_BUDGET_MS} ms`
    );
  if (evidence.snrDb < AUDIO_MIN_SNR_DB)
    failures.push(
      `${label}: SNR ${evidence.snrDb.toFixed(1)} dB < ${AUDIO_MIN_SNR_DB} dB`
    );
  if (evidence.testedMs < AUDIO_MIN_TESTED_MS)
    failures.push(
      `${label}: only ${evidence.testedMs.toFixed(0)} ms of loud reference was tested, need ${AUDIO_MIN_TESTED_MS} ms`
    );
  if (evidence.longestGapMs > AUDIO_GAP_BUDGET_MS)
    failures.push(
      `${label}: audio gap ${evidence.longestGapMs.toFixed(1)} ms at ${(evidence.gapStartSeconds ?? 0).toFixed(3)} s > ${AUDIO_GAP_BUDGET_MS} ms`
    );
  for (const step of evidence.offsetSteps)
    failures.push(
      `${label}: offset step ${step.stepMs > 0 ? 'inserted' : 'skipped'} ${Math.abs(step.stepMs).toFixed(2)} ms at ${step.startSeconds.toFixed(3)} s`
    );
  for (const fault of evidence.windowFaults)
    failures.push(
      `${label}: ${fault.kind} window at ${fault.startSeconds.toFixed(3)} s (rendered ${fault.rendered.toFixed(4)}, expected ${fault.expected.toFixed(4)})`
    );
  return failures;
}
