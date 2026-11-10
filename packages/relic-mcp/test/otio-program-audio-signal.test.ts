import { describe, expect, test } from 'bun:test';
import {
  AUDIO_GAP_BUDGET_MS,
  gateSignal,
  measureSignal,
  type SignalEvidence,
} from './otio-program-audio-signal.ts';

const RATE = 48000;
const SECONDS = 6;

/**
 * A linear chirp from 200 Hz to 2 kHz at amplitude 0.3. It is aperiodic, so the lag search has one
 * correlation peak. A pure tone repeats every 109.09 samples, and 1200 samples is exactly 11 cycles,
 * so an alignment on a tone can land on a whole cycle instead of the true lag.
 */
function reference(): Float32Array {
  const out = new Float32Array(RATE * SECONDS);
  const sweep = (2000 - 200) / SECONDS;
  for (let n = 0; n < out.length; n++) {
    const t = n / RATE;
    out[n] = 0.3 * Math.sin(2 * Math.PI * (200 * t + (sweep * t * t) / 2));
  }
  return out;
}

/** Zeroes [fromSeconds, fromSeconds + durationMs) in a copy of the signal. */
function withSilence(
  source: Float32Array,
  fromSeconds: number,
  durationMs: number
): Float32Array {
  const out = Float32Array.from(source);
  const start = Math.round(fromSeconds * RATE);
  out.fill(0, start, start + Math.round((durationMs * RATE) / 1000));
  return out;
}

/** Shifts the signal later by the given samples, filling the start with silence. */
function delayed(source: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(source.length);
  out.set(source.subarray(0, source.length - samples), samples);
  return out;
}

describe('sampled audio signal gate', () => {
  test('an identical capture aligns at zero, with no silent run beyond a zero crossing', () => {
    const ref = reference();
    const evidence = measureSignal(Float32Array.from(ref), ref, RATE);
    expect(evidence.lagSamples).toBe(0);
    // A loud chirp crosses zero, and one sample at a crossing can sit under the silence threshold.
    // That is one sample, about 0.02 ms, far inside the 20 ms budget. Anything longer is a gap.
    expect(evidence.longestGapSamples).toBeLessThanOrEqual(1);
    expect(evidence.longestGapMs).toBeLessThanOrEqual(1000 / RATE);
    expect(evidence.testedMs).toBeGreaterThanOrEqual(3000);
    expect(gateSignal(evidence, 'identical')).toEqual([]);
  });

  test('a 25 ms silent dropout is measured as 25 ms and fails the 20 ms budget', () => {
    const ref = reference();
    const evidence = measureSignal(withSilence(ref, 2, 25), ref, RATE);
    expect(evidence.lagSamples).toBe(0);
    // Every silent sample counts. Up to one sample either side can be a near-zero crossing.
    expect(evidence.longestGapSamples).toBeGreaterThanOrEqual(1200);
    expect(evidence.longestGapSamples).toBeLessThanOrEqual(1202);
    expect(evidence.longestGapMs).toBeGreaterThan(AUDIO_GAP_BUDGET_MS);
    expect(
      gateSignal(evidence, 'dropout25').some((f) => f.includes('audio gap'))
    ).toBe(true);
  });

  test('a 10 ms silent dropout is measured as 10 ms and passes the gap check', () => {
    const ref = reference();
    const evidence = measureSignal(withSilence(ref, 2, 10), ref, RATE);
    expect(evidence.lagSamples).toBe(0);
    expect(evidence.longestGapSamples).toBeGreaterThanOrEqual(480);
    expect(evidence.longestGapSamples).toBeLessThanOrEqual(482);
    expect(gateSignal(evidence, 'dropout10')).toEqual([]);
  });

  test('a start delay of 10 ms is found at its true lag and passes the onset bound', () => {
    const ref = reference();
    const evidence = measureSignal(delayed(ref, 480), ref, RATE);
    expect(evidence.lagSamples).toBe(480);
    expect(gateSignal(evidence, 'delay10')).toEqual([]);
  });

  test('a start delay of 30 ms is found at its true lag and fails the onset bound', () => {
    const ref = reference();
    const evidence = measureSignal(delayed(ref, 1440), ref, RATE);
    expect(evidence.lagSamples).toBe(1440);
    expect(
      gateSignal(evidence, 'delay30').some((f) => f.includes('onset'))
    ).toBe(true);
  });
});

/** Hand-built evidence isolates the gate's boundary from alignment and measurement. */
function evidence(over: Partial<SignalEvidence>): SignalEvidence {
  return {
    lagSamples: 0,
    onsetMs: 0,
    snrDb: 60,
    testedMs: 5000,
    longestGapSamples: 0,
    longestGapMs: 0,
    silentRuns: 0,
    gapStartSeconds: null,
    windowFaults: [],
    ...over,
  };
}

describe('sampled audio gate boundaries', () => {
  test('a gap of exactly the 20 ms budget passes; one sample more fails', () => {
    expect(
      gateSignal(evidence({ longestGapMs: 20, longestGapSamples: 960 }), 'at')
    ).toEqual([]);
    expect(
      gateSignal(
        evidence({ longestGapMs: 961000 / 48000, longestGapSamples: 961 }),
        'over'
      ).some((f) => f.includes('audio gap'))
    ).toBe(true);
  });
});
