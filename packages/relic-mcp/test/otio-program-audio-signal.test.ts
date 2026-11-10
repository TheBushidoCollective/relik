import { describe, expect, test } from 'bun:test';
import { gateSignal, measureSignal } from './otio-program-audio-signal.ts';

const RATE = 48000;
const SECONDS = 6;

/** A steady 440 Hz tone at 0.3 amplitude: loud everywhere, so every block is testable. */
function reference(): Float32Array {
  const out = new Float32Array(RATE * SECONDS);
  for (let n = 0; n < out.length; n++)
    out[n] = 0.3 * Math.sin((2 * Math.PI * 440 * n) / RATE);
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
  test('an identical capture passes with no gap and the onset at zero', () => {
    const ref = reference();
    const evidence = measureSignal(Float32Array.from(ref), ref, RATE);
    expect(evidence.longestGapMs).toBe(0);
    expect(Math.abs(evidence.onsetMs)).toBeLessThan(1);
    expect(evidence.testedMs).toBeGreaterThanOrEqual(3000);
    expect(gateSignal(evidence, 'identical')).toEqual([]);
  });

  test('a 25 ms silent dropout over the 20 ms audio budget fails', () => {
    const ref = reference();
    const evidence = measureSignal(withSilence(ref, 2, 25), ref, RATE);
    expect(evidence.longestGapMs).toBeGreaterThanOrEqual(25);
    expect(
      gateSignal(evidence, 'dropout25').some((f) => f.includes('audio gap'))
    ).toBe(true);
  });

  test('a 10 ms silent dropout within the budget passes the gap check', () => {
    const ref = reference();
    const evidence = measureSignal(withSilence(ref, 2, 10), ref, RATE);
    expect(evidence.longestGapMs).toBeLessThanOrEqual(10);
    expect(gateSignal(evidence, 'dropout10')).toEqual([]);
  });

  test('a start delay of 10 ms is within the onset bound', () => {
    const ref = reference();
    const evidence = measureSignal(delayed(ref, 480), ref, RATE);
    expect(evidence.lagSamples).toBe(480);
    expect(gateSignal(evidence, 'delay10')).toEqual([]);
  });

  test('a start delay of 30 ms fails the onset bound, not clamped to pass', () => {
    const ref = reference();
    const evidence = measureSignal(delayed(ref, 1440), ref, RATE);
    expect(evidence.lagSamples).toBe(1440);
    expect(
      gateSignal(evidence, 'delay30').some((f) => f.includes('onset'))
    ).toBe(true);
  });
});
