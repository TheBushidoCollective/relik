import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  AUDIO_GAP_BUDGET_MS,
  gateSignal,
  measureSignal,
  type SignalEvidence,
} from './otio-program-audio-signal.ts';

// Each measureSignal call aligns a 6 s capture by correlation and takes 2 to 6 s on a loaded
// machine, so a test that measures twice exceeds Bun's 5 s default without anything being wrong.
setDefaultTimeout(60_000);

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

/**
 * Builds a capture shaped like the recorded failures: leading silence, a run of program samples, a
 * silent chunk the tap never delivered, then the program continuing from where it stopped.
 * Positions are sample indices into the reference.
 */
function recorded(
  source: Float32Array,
  lead: number,
  programStart: number,
  programLength: number,
  insertion: number
): Float32Array {
  const out = new Float32Array(source.length);
  let next = programStart;
  for (let i = lead; i < out.length && next < source.length; i++) {
    const offset = i - lead;
    if (offset >= programLength && offset < programLength + insertion) continue;
    out[i] = source[next++] ?? 0;
  }
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

  test('leading silence before the program is onset, not a gap', () => {
    const ref = reference();
    const evidence = measureSignal(delayed(ref, 1408), ref, RATE);
    expect(evidence.lagSamples).toBe(1408);
    expect(evidence.longestGapSamples).toBeLessThanOrEqual(1);
    const failures = gateSignal(evidence, 'lead');
    expect(failures.some((f) => f.includes('onset'))).toBe(true);
    expect(failures.some((f) => f.includes('audio gap'))).toBe(false);
  });

  test('the first-click capture (silence, 2048 program samples, a 1024-sample silent chunk, then program) fails as a gap', () => {
    const ref = reference();
    const evidence = measureSignal(
      recorded(ref, 1024, 3872, 2048, 1024),
      ref,
      RATE
    );
    expect(evidence.lagSamples).toBe(-1824);
    expect(evidence.longestGapSamples).toBeGreaterThanOrEqual(1024);
    expect(evidence.longestGapSamples).toBeLessThanOrEqual(1026);
    expect(evidence.longestGapMs).toBeGreaterThan(AUDIO_GAP_BUDGET_MS);
    expect(
      gateSignal(evidence, 'firstClick').some((f) => f.includes('audio gap'))
    ).toBe(true);
  });

  test('the prepared capture (silence, 2048 program samples, a 1024-sample silent chunk, then program) fails as an inserted offset step and a gap', () => {
    const ref = reference();
    const evidence = measureSignal(
      recorded(ref, 1408, 1760, 2048, 1024),
      ref,
      RATE
    );
    expect(evidence.lagSamples).toBe(672);
    expect(evidence.offsetSteps).toHaveLength(1);
    const [step] = evidence.offsetSteps;
    expect(step?.stepMs).toBeCloseTo((1024 * 1000) / RATE, 2);
    // The step sits at the exact reference sample where the old alignment stops and the new one
    // starts: sample 3808, the first sample of program after the silent chunk. Its silence is the
    // gap budget's to judge.
    expect(step?.startSeconds).toBeCloseTo(3808 / RATE, 6);
    expect(evidence.longestGapSamples).toBeGreaterThanOrEqual(1024);
    expect(evidence.longestGapSamples).toBeLessThanOrEqual(1026);
    const failures = gateSignal(evidence, 'prepared');
    expect(
      failures.some((f) => f.includes('offset step inserted 21.33 ms'))
    ).toBe(true);
    expect(failures.some((f) => f.includes('audio gap'))).toBe(true);
  });

  test('an inserted 21.3 ms chunk at 90 ms moves the rest of the program and fails as a step and a gap', () => {
    const ref = reference();
    const evidence = measureSignal(recorded(ref, 0, 0, 4320, 1024), ref, RATE);
    expect(evidence.lagSamples).toBe(1024);
    expect(
      evidence.offsetSteps.some(
        (s) => Math.abs(s.stepMs - (1024 * 1000) / RATE) < 0.01
      )
    ).toBe(true);
    const stepAt = evidence.offsetSteps.find(
      (s) => Math.abs(s.stepMs - (1024 * 1000) / RATE) < 0.01
    );
    // The chunk begins at reference sample 4320, the 90 ms mark, exactly.
    expect(stepAt?.startSeconds).toBeCloseTo(4320 / RATE, 6);
    expect(evidence.longestGapSamples).toBeGreaterThanOrEqual(1024);
    const failures = gateSignal(evidence, 'insert90');
    expect(failures.some((f) => f.includes('offset step inserted'))).toBe(true);
    expect(failures.some((f) => f.includes('audio gap'))).toBe(true);
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
    offsetSteps: [],
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

describe('sampled audio startSample', () => {
  test('the default start matches an explicit start of zero', () => {
    const ref = reference();
    const rendered = withSilence(ref, 2, 25);
    const implicit = measureSignal(rendered, ref, RATE);
    const explicit = measureSignal(rendered, ref, RATE, 0);
    expect(explicit.lagSamples).toBe(implicit.lagSamples);
    expect(explicit.longestGapSamples).toBe(implicit.longestGapSamples);
    expect(explicit.gapStartSeconds).toBeCloseTo(
      implicit.gapStartSeconds ?? -1,
      6
    );
  });

  test('a captured span that starts later aligns at lag 0', () => {
    const ref = reference();
    const start = 2 * RATE;
    const evidence = measureSignal(
      Float32Array.from(ref.subarray(start)),
      ref,
      RATE,
      start
    );
    expect(evidence.lagSamples).toBe(0);
    expect(gateSignal(evidence, 'shifted')).toEqual([]);
  });

  test('a gap is reported in absolute program seconds, not span seconds', () => {
    const ref = reference();
    const start = 2 * RATE;
    const rendered = Float32Array.from(ref.subarray(start));
    // 1 s into the captured span is 3 s into the program.
    rendered.fill(0, RATE, RATE + Math.round((25 * RATE) / 1000));
    const evidence = measureSignal(rendered, ref, RATE, start);
    expect(evidence.lagSamples).toBe(0);
    expect(evidence.longestGapSamples).toBeGreaterThanOrEqual(1200);
    expect(evidence.gapStartSeconds ?? -1).toBeCloseTo(3, 2);
  });

  test('a rendered start late by 10 ms keeps a positive lag and passes', () => {
    const ref = reference();
    const start = 2 * RATE;
    const evidence = measureSignal(
      delayed(Float32Array.from(ref.subarray(start)), 480),
      ref,
      RATE,
      start
    );
    expect(evidence.lagSamples).toBe(480);
    expect(evidence.onsetMs).toBeCloseTo(10, 6);
    expect(gateSignal(evidence, 'late10')).toEqual([]);
  });

  test('a rendered start late by 30 ms keeps a positive lag and fails onset', () => {
    const ref = reference();
    const start = 2 * RATE;
    const evidence = measureSignal(
      delayed(Float32Array.from(ref.subarray(start)), 1440),
      ref,
      RATE,
      start
    );
    expect(evidence.lagSamples).toBe(1440);
    expect(
      gateSignal(evidence, 'late30').some((f) => f.includes('onset'))
    ).toBe(true);
  });

  test('a negative start is refused', () => {
    const ref = reference();
    expect(() => measureSignal(Float32Array.from(ref), ref, RATE, -1)).toThrow(
      'startSample must be a non-negative integer'
    );
  });

  test('a start past the reference measures nothing and fails the minimum', () => {
    const ref = reference();
    const evidence = measureSignal(
      Float32Array.from(ref),
      ref,
      RATE,
      ref.length + 1
    );
    expect(evidence.testedMs).toBe(0);
    expect(
      gateSignal(evidence, 'past').some((f) => f.includes('only 0 ms'))
    ).toBe(true);
  });
});

describe('sampled audio startSample timestamps', () => {
  test('an offset step is reported in absolute program seconds when the span is shifted', () => {
    const ref = reference();
    const start = 2 * RATE;
    const span = Float32Array.from(ref.subarray(start));
    // Same shape as the unshifted step test: the step sits 3808 span samples in.
    const evidence = measureSignal(
      recorded(span, 1408, 1760, 2048, 1024),
      ref,
      RATE,
      start
    );
    expect(evidence.offsetSteps).toHaveLength(1);
    const [step] = evidence.offsetSteps;
    expect(step?.stepMs).toBeCloseTo((1024 * 1000) / RATE, 2);
    expect(step?.startSeconds).toBeCloseTo((start + 3808) / RATE, 6);
  });

  test('a dropout window is reported in absolute program seconds when the span is shifted', () => {
    const ref = reference();
    const start = 2 * RATE;
    const rendered = Float32Array.from(ref.subarray(start));
    // Silence 1.5 s to 2.5 s into the span: 3.5 s to 4.5 s of program.
    rendered.fill(0, Math.round(1.5 * RATE), Math.round(2.5 * RATE));
    const evidence = measureSignal(rendered, ref, RATE, start);
    const dropouts = evidence.windowFaults.filter((f) => f.kind === 'dropout');
    expect(dropouts.length).toBeGreaterThan(0);
    for (const fault of dropouts) {
      expect(fault.startSeconds).toBeGreaterThanOrEqual(2 + 1.4);
      expect(fault.startSeconds).toBeLessThanOrEqual(2 + 2.6);
    }
  });
});
