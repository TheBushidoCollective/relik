/**
 * Pure checks over decoded rendered-program media. No Relic code is imported here.
 * Every function returns data or a list of failure strings. Nothing throws on a fault in the
 * media, so the caller can report every fault instead of the first one.
 */

import {
  PROGRAM,
  type FrameExpectation,
  expectedBackground,
} from './otio-program-reference.ts';

export interface RgbFrame {
  readonly width: number;
  readonly height: number;
  /** Packed rgb24, row-major. */
  readonly data: Uint8Array;
}

export const COLOUR_TOLERANCE = 16;
export const WEIGHT_TOLERANCE = 0.06;
export const AUDIO_MAX_LAG_SAMPLES = 96;
export const AUDIO_MIN_SNR_DB = 18;
export const DROPOUT_WINDOW_SECONDS = 0.02;
export const DROPOUT_EXPECTED_RMS = 0.05;
export const DROPOUT_RENDERED_RMS = 0.01;
export const SILENCE_EXPECTED_RMS = 0.005;
export const SILENCE_RENDERED_RMS = 0.02;
export const EDGE_GUARD_SECONDS = 0.03;

function pixel(
  frame: RgbFrame,
  x: number,
  y: number
): [number, number, number] {
  const offset = (y * frame.width + x) * 3;
  return [
    frame.data[offset] ?? 0,
    frame.data[offset + 1] ?? 0,
    frame.data[offset + 2] ?? 0,
  ];
}

/**
 * Decodes the source frame index from the bar row. The bar is the first run of near-white
 * pixels (every channel at least 200). Its centre is 4n + 1.5 for a bar at x = 4n.
 * Returns null when there is no run, or the run is not one bar wide.
 */
export function barIndex(frame: RgbFrame): number | null {
  const y = PROGRAM.bar.sampleRow;
  let runStart = -1;
  for (let x = 0; x <= frame.width; x++) {
    const white =
      x < frame.width && pixel(frame, x, y).every((channel) => channel >= 200);
    if (white && runStart < 0) runStart = x;
    if (!white && runStart >= 0) {
      const runEnd = x - 1;
      const width = runEnd - runStart + 1;
      if (width < PROGRAM.bar.width - 1 || width > PROGRAM.bar.width + 1)
        return null;
      const centre = (runStart + runEnd) / 2;
      return Math.round((centre - 1.5) / PROGRAM.bar.width);
    }
  }
  return null;
}

/** Mean colour of a (2r+1)^2 window at the background probe point. */
export function probeColour(frame: RgbFrame): [number, number, number] {
  const { x, y, radius } = PROGRAM.probe;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const [pr, pg, pb] = pixel(frame, x + dx, y + dy);
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

/**
 * Incoming dissolve weight measured from the probe. It uses the red channel (plate_a 200 to
 * plate_b 40) and the blue channel (40 to 200), and averages them.
 */
export function measuredDissolveWeight(probe: readonly number[]): number {
  const [aR, , aB] = PROGRAM.plates.a;
  const [bR, , bB] = PROGRAM.plates.b;
  const fromRed = (aR - (probe[0] ?? 0)) / (aR - bR);
  const fromBlue = ((probe[2] ?? 0) - aB) / (bB - aB);
  return (fromRed + fromBlue) / 2;
}

/** Every failure for one rendered frame against its independent expectation. */
export function checkFrame(
  frame: RgbFrame,
  expect: FrameExpectation,
  label = `frame ${expect.frame}`
): string[] {
  const failures: string[] = [];
  const probe = probeColour(frame);
  const background = expectedBackground(expect);
  if (expect.kind === 'single') {
    const index = barIndex(frame);
    if (index !== expect.index)
      failures.push(
        `${label}: bar index ${index} != expected ${expect.index} (plate ${expect.plate})`
      );
  }
  const colourDiffs = background.map((value, channel) =>
    Math.abs((probe[channel] ?? 0) - value)
  );
  if (colourDiffs.some((diff) => diff > COLOUR_TOLERANCE))
    failures.push(
      `${label}: background ${probe.map((v) => v.toFixed(0)).join(',')} != expected ${background.map((v) => v.toFixed(0)).join(',')} (kind ${expect.kind})`
    );
  if (expect.kind === 'dissolve') {
    const weight = measuredDissolveWeight(probe);
    if (Math.abs(weight - expect.weight) > WEIGHT_TOLERANCE)
      failures.push(
        `${label}: dissolve weight ${weight.toFixed(3)} != expected ${expect.weight.toFixed(3)}`
      );
  }
  return failures;
}

/**
 * Checks decoded presentation timestamps (seconds) against k / fps. Each frame must be within
 * half a frame of its slot, and the count must equal the manifest's frame count.
 */
export function checkTimestamps(
  pts: readonly number[],
  expectedFrames: number,
  fps: number = PROGRAM.fps
): string[] {
  const failures: string[] = [];
  if (pts.length !== expectedFrames)
    failures.push(`frame count ${pts.length} != expected ${expectedFrames}`);
  const half = 0.5 / fps;
  for (let k = 0; k < Math.min(pts.length, expectedFrames); k++) {
    const t = pts[k];
    if (t === undefined || !Number.isFinite(t)) {
      failures.push(`frame ${k}: no finite timestamp`);
      continue;
    }
    if (Math.abs(t - k / fps) > half)
      failures.push(
        `frame ${k}: pts ${t.toFixed(6)} != ${(k / fps).toFixed(6)}`
      );
  }
  return failures;
}

function sumSquares(values: Float32Array, start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i++) total += (values[i] ?? 0) ** 2;
  return total;
}

export function rms(values: Float32Array, start: number, end: number): number {
  const n = end - start;
  return n > 0 ? Math.sqrt(sumSquares(values, start, end) / n) : 0;
}

export interface AudioAlignment {
  /** Sample lag of the rendered signal relative to the expected signal. Positive is late. */
  readonly lagSamples: number;
  readonly gain: number;
  readonly snrDb: number;
}

/**
 * Finds the lag that best matches the rendered channel to the expected channel, then reports
 * the gain-matched SNR at that lag. Only the interior of the expected signal is compared, which
 * keeps codec priming and tail samples out of the score.
 */
export function alignAudio(
  rendered: Float32Array,
  expected: Float32Array,
  maxLag: number = AUDIO_MAX_LAG_SAMPLES
): AudioAlignment {
  const margin = 4096;
  const end = expected.length - margin;
  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let eEnergy = 0;
    let rEnergy = 0;
    for (let i = margin; i < end; i++) {
      const r = rendered[i + lag] ?? 0;
      const e = expected[i] ?? 0;
      dot += r * e;
      eEnergy += e * e;
      rEnergy += r * r;
    }
    const score =
      eEnergy > 0 && rEnergy > 0 ? dot / Math.sqrt(eEnergy * rEnergy) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  let dot = 0;
  let eEnergy = 0;
  for (let i = margin; i < end; i++) {
    const r = rendered[i + bestLag] ?? 0;
    const e = expected[i] ?? 0;
    dot += r * e;
    eEnergy += e * e;
  }
  const gain = eEnergy > 0 ? dot / eEnergy : 0;
  let signal = 0;
  let noise = 0;
  for (let i = margin; i < end; i++) {
    const e = (expected[i] ?? 0) * gain;
    const diff = (rendered[i + bestLag] ?? 0) - e;
    signal += e * e;
    noise += diff * diff;
  }
  const snrDb =
    noise > 0 ? 10 * Math.log10(signal / noise) : Number.POSITIVE_INFINITY;
  return { lagSamples: bestLag, gain, snrDb };
}

export interface AudioFault {
  readonly kind: 'dropout' | 'unexpected-sound';
  readonly startSeconds: number;
  readonly rendered: number;
  readonly expected: number;
}

/**
 * Compares the rendered channel with the expected channel in fixed windows, after the lag from
 * alignAudio. A dropout is a window where the expected signal is loud but the rendered signal is
 * quiet. Unexpected sound is a window where the expected signal is silent but the rendered one is
 * not. Windows within EDGE_GUARD_SECONDS of an expected boundary are skipped, because codec
 * spread at a cut is not a fault.
 */
export function findAudioFaults(
  rendered: Float32Array,
  expected: Float32Array,
  rate: number,
  lagSamples: number,
  boundariesSamples: readonly number[] = []
): AudioFault[] {
  const windowN = Math.round(DROPOUT_WINDOW_SECONDS * rate);
  const guard = Math.round(EDGE_GUARD_SECONDS * rate);
  const faults: AudioFault[] = [];
  const margin = 4096;
  for (
    let start = margin;
    start + windowN <= expected.length - margin;
    start += windowN
  ) {
    const end = start + windowN;
    if (
      boundariesSamples.some(
        (edge) => edge + guard > start && edge - guard < end
      )
    )
      continue;
    const e = rms(expected, start, end);
    const r = rms(rendered, start + lagSamples, end + lagSamples);
    const seconds = start / rate;
    if (e >= DROPOUT_EXPECTED_RMS && r < DROPOUT_RENDERED_RMS)
      faults.push({
        kind: 'dropout',
        startSeconds: seconds,
        rendered: r,
        expected: e,
      });
    if (e < SILENCE_EXPECTED_RMS && r >= SILENCE_RENDERED_RMS)
      faults.push({
        kind: 'unexpected-sound',
        startSeconds: seconds,
        rendered: r,
        expected: e,
      });
  }
  return faults;
}
