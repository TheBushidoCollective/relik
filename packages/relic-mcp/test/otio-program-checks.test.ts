import { describe, expect, test } from 'bun:test';
import {
  alignAudio,
  barIndex,
  checkFrame,
  checkTimestamps,
  findAudioFaults,
  type RgbFrame,
} from './otio-program-checks.ts';
import {
  EXPECTED_PLACEMENTS,
  expectedAudio,
  expectedAudioSample,
  expectedBackground,
  expectedFrame,
  PROGRAM,
} from './otio-program-reference.ts';

/** Builds a synthetic frame: plate colour everywhere, a white bar at x = 4 * index. */
function syntheticFrame(
  background: readonly number[],
  barAt: number | null
): RgbFrame {
  const { width, height } = PROGRAM;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const bar =
        barAt !== null &&
        y >= PROGRAM.bar.rowTop &&
        y < PROGRAM.bar.rowBottom &&
        x >= barAt * PROGRAM.bar.width &&
        x < barAt * PROGRAM.bar.width + PROGRAM.bar.width;
      for (let c = 0; c < 3; c++)
        data[o + c] = bar ? 255 : (background[c] ?? 0);
    }
  return { width, height, data };
}

function barFor(frame: number) {
  const expect = expectedFrame(frame);
  if (expect.kind !== 'single') throw new Error('not a single frame');
  return expect.index;
}

describe('reference timing', () => {
  test('frame table matches the composition', () => {
    expect(expectedFrame(0)).toEqual({
      frame: 0,
      kind: 'single',
      plate: 'a',
      index: 0,
    });
    expect(expectedFrame(30)).toEqual({
      frame: 30,
      kind: 'single',
      plate: 'c',
      index: 0,
    });
    expect(expectedFrame(60)).toEqual({
      frame: 60,
      kind: 'single',
      plate: 'a',
      index: 60,
    });
    expect(expectedFrame(96)).toEqual({
      frame: 96,
      kind: 'single',
      plate: 'b',
      index: 66,
    });
    expect(expectedFrame(120)).toEqual({
      frame: 120,
      kind: 'single',
      plate: 'c',
      index: 0,
    });
    expect(expectedFrame(149)).toEqual({
      frame: 149,
      kind: 'single',
      plate: 'c',
      index: 58,
    });
    expect(expectedFrame(150)).toEqual({
      frame: 150,
      kind: 'single',
      plate: 'b',
      index: 120,
    });
  });

  test('dissolve weight runs 0 to 11/12 over frames 84 to 95', () => {
    const first = expectedFrame(84);
    const last = expectedFrame(95);
    expect(first.kind === 'dissolve' && first.weight).toBe(0);
    expect(last.kind === 'dissolve' && last.weight).toBeCloseTo(11 / 12, 9);
  });

  test('background mixes both plates during the dissolve', () => {
    const mid = expectedBackground(expectedFrame(90));
    expect(mid[0]).toBeCloseTo(200 * (1 - 6 / 12) + 40 * (6 / 12), 9);
  });

  test('audio gap is exactly silent and tones are present', () => {
    expect(expectedAudioSample(230000)).toBe(0);
    expect(Math.abs(expectedAudioSample(60000))).toBeGreaterThan(0);
  });

  test('placements agree with the composition the fixture writes', () => {
    expect(EXPECTED_PLACEMENTS.V2.map((p) => p.start)).toEqual([0, 1, 2, 4, 5]);
    expect(EXPECTED_PLACEMENTS.A1.map((p) => p.duration)).toEqual([
      4.5, 0.5, 1,
    ]);
  });
});

describe('frame checks fail on wrong media', () => {
  test('a correct frame passes', () => {
    const frame = syntheticFrame(PROGRAM.plates.a, barFor(10));
    expect(barIndex(frame)).toBe(barFor(10));
    expect(checkFrame(frame, expectedFrame(10))).toEqual([]);
  });

  test('a bar shifted by one frame index is reported', () => {
    const frame = syntheticFrame(PROGRAM.plates.a, barFor(10) + 1);
    const failures = checkFrame(frame, expectedFrame(10));
    expect(failures.join('\n')).toContain('bar index 11 != expected 10');
  });

  test('a wrong plate background is reported', () => {
    const frame = syntheticFrame(PROGRAM.plates.b, barFor(10));
    const failures = checkFrame(frame, expectedFrame(10));
    expect(failures.some((f) => f.includes('background'))).toBe(true);
  });

  test('a dissolve at the wrong weight is reported', () => {
    const expect84 = expectedFrame(90);
    const wrong = expectedBackground({
      ...expect84,
      weight: 0.1,
    } as typeof expect84);
    const frame = syntheticFrame(
      wrong.map((v) => Math.round(v)) as unknown as readonly number[],
      null
    );
    const failures = checkFrame(frame, expect84);
    expect(failures.some((f) => f.includes('dissolve weight'))).toBe(true);
  });

  test('a missing bar is reported as a null index, not a pass', () => {
    const frame = syntheticFrame(PROGRAM.plates.a, null);
    expect(barIndex(frame)).toBeNull();
    expect(checkFrame(frame, expectedFrame(10)).length).toBeGreaterThan(0);
  });
});

describe('timestamp checks', () => {
  const pts = Array.from({ length: PROGRAM.frames }, (_, k) => k / PROGRAM.fps);

  test('exact timestamps pass', () => {
    expect(checkTimestamps(pts, PROGRAM.frames)).toEqual([]);
  });

  test('a one-frame shift is reported', () => {
    const shifted = pts.map((t) => t + 1 / PROGRAM.fps);
    expect(checkTimestamps(shifted, PROGRAM.frames).length).toBeGreaterThan(0);
  });

  test('a dropped frame is reported by count', () => {
    expect(checkTimestamps(pts.slice(1), PROGRAM.frames).join('\n')).toContain(
      'frame count 179'
    );
  });
});

describe('audio checks fail on wrong audio', () => {
  const expected = expectedAudio(120000);

  test('a clean copy aligns at lag 0 with high SNR', () => {
    const alignment = alignAudio(Float32Array.from(expected), expected);
    expect(alignment.lagSamples).toBe(0);
    expect(alignment.snrDb).toBeGreaterThan(60);
  });

  test('a 5-sample delay is measured as lag 5', () => {
    const delayed = new Float32Array(expected.length);
    delayed.set(expected.subarray(0, expected.length - 5), 5);
    expect(alignAudio(delayed, expected).lagSamples).toBe(5);
  });

  test('a delay beyond the lag window is refused, not matched', () => {
    const delayed = new Float32Array(expected.length);
    delayed.set(expected.subarray(0, expected.length - 200), 200);
    const alignment = alignAudio(delayed, expected);
    expect(Math.abs(alignment.lagSamples) === 96 || alignment.snrDb < 18).toBe(
      true
    );
  });

  test('a dropout inside audible tone is reported', () => {
    const rendered = Float32Array.from(expected);
    rendered.fill(0, 60000, 62000);
    const alignment = alignAudio(rendered, expected);
    const faults = findAudioFaults(
      rendered,
      expected,
      48000,
      alignment.lagSamples
    );
    expect(faults.some((f) => f.kind === 'dropout')).toBe(true);
  });

  test('sound inside the expected gap is reported as unexpected', () => {
    const full = expectedAudio();
    const rendered = Float32Array.from(full);
    for (let i = 220000; i < 230000; i++) rendered[i] = 0.3 * Math.sin(i / 3);
    const alignment = alignAudio(rendered, full);
    const faults = findAudioFaults(rendered, full, 48000, alignment.lagSamples);
    expect(faults.some((f) => f.kind === 'unexpected-sound')).toBe(true);
  });

  test('a clean rendering has no faults', () => {
    const alignment = alignAudio(Float32Array.from(expected), expected);
    expect(
      findAudioFaults(
        Float32Array.from(expected),
        expected,
        48000,
        alignment.lagSamples
      )
    ).toEqual([]);
  });
});
