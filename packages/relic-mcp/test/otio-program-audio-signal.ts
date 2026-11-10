/**
 * Sampled audio signal checks for the primer proof. Pure: the captured samples are compared with
 * the independent source reference (otio-program-reference.ts), sample by sample, after alignment.
 *
 * This module never reads a callback, a trace, or a stream start. Those are telemetry. Only the
 * samples the element actually output can prove an audio gap, so the 20 ms audio budget is proven
 * here and nowhere else.
 */

import {
  type AudioFault,
  alignAudio,
  AUDIO_MIN_SNR_DB,
  DROPOUT_EXPECTED_RMS,
  DROPOUT_RENDERED_RMS,
  findAudioFaults,
  rms,
} from './otio-program-checks.ts';

/** The user's acceptance: an actual audio gap over this is a failure. Not a tolerance to tune. */
export const AUDIO_GAP_BUDGET_MS = 20;
/** Start offset bound, the same 20 ms the composition stage enforces. */
export const AUDIO_ONSET_BUDGET_MS = 20;
export const AUDIO_BLOCK_MS = 1;
/** The reference must be loud this far either side of a tested block, so edges are not scored. */
export const AUDIO_GUARD_MS = 30;
/** Fewer tested milliseconds means the reference was not loud enough to judge. That fails. */
export const AUDIO_MIN_TESTED_MS = 3000;
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
  /** Longest run of tested blocks where the rendered audio is silent. */
  readonly longestGapMs: number;
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
 * Aligns one rendered channel to the reference, then measures every tested 1 ms block. The
 * reference is cut to the captured span so nothing is scored past what was recorded.
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
  const silent: boolean[] = [];
  for (let b = 0; b < blocks; b++) {
    const start = MARGIN_SAMPLES + b * block;
    loud.push(rms(expected, start, start + block) >= DROPOUT_EXPECTED_RMS);
    silent.push(
      rms(rendered, start + lag, start + lag + block) < DROPOUT_RENDERED_RMS
    );
  }
  const guard = Math.round(AUDIO_GUARD_MS / AUDIO_BLOCK_MS);
  const tested = testedBlocks(loud, guard);

  let testedCount = 0;
  let run = 0;
  let longest = 0;
  let longestStart = -1;
  let runStart = -1;
  for (let b = 0; b < blocks; b++) {
    if (tested[b]) testedCount++;
    if (tested[b] && silent[b]) {
      if (run === 0) runStart = b;
      run++;
      if (run > longest) {
        longest = run;
        longestStart = runStart;
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
    testedMs: testedCount * AUDIO_BLOCK_MS,
    longestGapMs: longest * AUDIO_BLOCK_MS,
    gapStartSeconds:
      longestStart < 0 ? null : (MARGIN_SAMPLES + longestStart * block) / rate,
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
      `${label}: only ${evidence.testedMs} ms of loud reference was tested, need ${AUDIO_MIN_TESTED_MS} ms`
    );
  if (evidence.longestGapMs > AUDIO_GAP_BUDGET_MS)
    failures.push(
      `${label}: audio gap ${evidence.longestGapMs} ms at ${(evidence.gapStartSeconds ?? 0).toFixed(3)} s > ${AUDIO_GAP_BUDGET_MS} ms`
    );
  for (const fault of evidence.windowFaults)
    failures.push(
      `${label}: ${fault.kind} window at ${fault.startSeconds.toFixed(3)} s (rendered ${fault.rendered.toFixed(4)}, expected ${fault.expected.toFixed(4)})`
    );
  return failures;
}
