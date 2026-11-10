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
/**
 * A rendered sample at or below this magnitude counts as silent (about -60 dBFS). The program's
 * tone is 0.3 in amplitude, so a real dropout is exact zero or near it, while a zero crossing of a
 * loud signal stays silent for only a sample or two.
 */
export const AUDIO_SILENCE_AMPLITUDE = 1e-3;
/** Program audio boundaries in samples (1 s, 3 s, 4.5 s, 5 s), as the composition stage uses them. */
export const PROGRAM_AUDIO_BOUNDARIES: readonly number[] = [
  48000, 144000, 216000, 240000,
];

const MARGIN_SAMPLES = 4096;

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
 * Aligns one rendered channel to the reference, then measures silence over every tested sample.
 * The reference is cut to the captured span so nothing is scored past what was recorded.
 */
export function measureSignal(
  rendered: Float32Array,
  reference: Float32Array,
  rate: number
): SignalEvidence {
  const onsetSamples = Math.round((AUDIO_ONSET_BUDGET_MS * rate) / 1000);
  const span = Math.min(reference.length, rendered.length - 2 * onsetSamples);
  const expected = reference.subarray(0, Math.max(0, span));
  const alignment = alignAudio(rendered, expected, 2 * onsetSamples);
  const lag = alignment.lagSamples;

  const block = Math.round((AUDIO_BLOCK_MS * rate) / 1000);
  const blocks = Math.floor((expected.length - 2 * MARGIN_SAMPLES) / block);
  const loud: boolean[] = [];
  for (let b = 0; b < blocks; b++) {
    const start = MARGIN_SAMPLES + b * block;
    loud.push(rms(expected, start, start + block) >= DROPOUT_EXPECTED_RMS);
  }
  const guard = Math.round(AUDIO_GUARD_MS / AUDIO_BLOCK_MS);
  const tested = testedBlocks(loud, guard);

  const end = MARGIN_SAMPLES + blocks * block;
  let testedSamples = 0;
  let run = 0;
  let longest = 0;
  let silentRuns = 0;
  let longestEnd = -1;
  for (let n = MARGIN_SAMPLES; n < end; n++) {
    if (!tested[Math.floor((n - MARGIN_SAMPLES) / block)]) {
      run = 0;
      continue;
    }
    testedSamples++;
    if (Math.abs(rendered[n + lag] ?? 0) <= AUDIO_SILENCE_AMPLITUDE) {
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

  const windowFaults = findAudioFaults(
    rendered,
    expected,
    rate,
    lag,
    PROGRAM_AUDIO_BOUNDARIES
  );
  return {
    lagSamples: lag,
    onsetMs: (lag * 1000) / rate,
    snrDb: alignment.snrDb,
    testedMs: (testedSamples * 1000) / rate,
    longestGapSamples: longest,
    longestGapMs: (longest * 1000) / rate,
    silentRuns,
    gapStartSeconds: longestEnd < 0 ? null : (longestEnd - longest + 1) / rate,
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
  for (const fault of evidence.windowFaults)
    failures.push(
      `${label}: ${fault.kind} window at ${fault.startSeconds.toFixed(3)} s (rendered ${fault.rendered.toFixed(4)}, expected ${fault.expected.toFixed(4)})`
    );
  return failures;
}
