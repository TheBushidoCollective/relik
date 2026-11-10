import {
  classifyStart,
  DEVICE_CALLBACK_EVENT,
  deviceExcessMs,
  firstStart,
  gatePrimerWindow,
  markTs,
  p95,
  type PrimerWindow,
  PREPARE_MARK,
  stalls,
  streamStarts,
  streamStartCounts,
  type TraceEvent,
} from './otio-program-trace.ts';
import { describe, expect, test } from 'bun:test';
import {
  alignAudio,
  barIndex,
  checkFrame,
  checkTimestamps,
  findAudioFaults,
  type RgbFrame,
} from './otio-program-checks.ts';
import { framePsnrDb, PROGRAM_MIN_PSNR_DB } from './otio-program-media.ts';
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

describe('lossy video quality and frame identity guards', () => {
  function psnr(a: RgbFrame, b: RgbFrame): number {
    expect(a.data.length).toBe(b.data.length);
    let squared = 0;
    for (let i = 0; i < a.data.length; i++) {
      const delta = a.data[i]! - b.data[i]!;
      squared += delta * delta;
    }
    return framePsnrDb(squared, a.data.length);
  }

  test('one wrong source frame fails identity even if full-frame PSNR passes', () => {
    const expected = syntheticFrame(PROGRAM.plates.a, barFor(10));
    const wrongFrame = syntheticFrame(PROGRAM.plates.a, barFor(10) + 1);
    // The bar is small, so PSNR alone cannot prove frame identity.
    expect(psnr(expected, wrongFrame)).toBeGreaterThanOrEqual(
      PROGRAM_MIN_PSNR_DB
    );
    expect(
      checkFrame(wrongFrame, expectedFrame(10)).some((failure) =>
        failure.includes('bar index')
      )
    ).toBe(true);
  });

  test('substantially degraded color fails the per-frame 35 dB quality floor', () => {
    const expected = syntheticFrame(PROGRAM.plates.a, barFor(10));
    const degraded = syntheticFrame([150, 90, 90], barFor(10));
    expect(psnr(expected, degraded)).toBeLessThan(PROGRAM_MIN_PSNR_DB);
    expect(
      checkFrame(degraded, expectedFrame(10)).some((failure) =>
        failure.includes('background')
      )
    ).toBe(true);
  });

  test('identical frames have infinite PSNR and invalid populations are refused', () => {
    expect(framePsnrDb(0, 3)).toBe(Number.POSITIVE_INFINITY);
    expect(() => framePsnrDb(-1, 3)).toThrow();
    expect(() => framePsnrDb(0, 0)).toThrow();
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

/** Trace fixtures on the trace clock (microseconds). */
const traced = (name: string, ts: number, cat = 'audio'): TraceEvent => ({
  name,
  cat,
  ts,
});
const mark = (name: string, ts: number): TraceEvent =>
  traced(name, ts, 'blink.user_timing');
/** Device callbacks at the 1024-frame, 48 kHz period (21.33 ms). */
const callbacks = (fromUs: number, count: number, periodUs = 21_333) =>
  Array.from({ length: count }, (_, i) =>
    traced(DEVICE_CALLBACK_EVENT, fromUs + i * periodUs)
  );
/** 24 fps presented frames: 41.7 ms gaps, which is the steady budget case. */
const steadyGaps = (n = 95) => Array.from({ length: n }, () => 41.7);

const passingWindow = (over: Partial<PrimerWindow> = {}): PrimerWindow => ({
  startupMs: 120,
  gapsMs: steadyGaps(),
  bufferingBeforeFirstFrame: null,
  streamStarts: 0,
  expectedStreamStarts: 0,
  firstCallbackMs: null,
  deviceExcessMs: 0.4,
  deviceCallbacks: 180,
  firstClick: false,
  ...over,
});

describe('primer trace: marks and stream starts', () => {
  test('a mark is found only on the user-timing category', () => {
    const events = [traced(PREPARE_MARK, 5), mark(PREPARE_MARK, 900)];
    expect(markTs(events, PREPARE_MARK)).toBe(900);
    expect(markTs(events, 'relic-play-pointerdown')).toBeNull();
  });

  test('a stream start is the largest per-name count, not their sum', () => {
    const events = [
      traced('AudioOutputDevice::Start', 100),
      traced('CreateStream', 101),
      traced('OutputController::Play', 102),
    ];
    expect(streamStarts(events, 0)).toBe(1);
    expect(streamStartCounts(events, 0)['OutputController::Play']).toBe(1);
  });

  test('stream starts before the window are not counted', () => {
    const events = [
      traced('OutputController::Play', 50),
      traced('OutputController::Play', 500),
    ];
    expect(streamStarts(events, 100)).toBe(1);
    expect(streamStarts(events, 100, 400)).toBe(0);
  });
});

describe('primer trace: D and cold classification', () => {
  test('D runs from the first buffer render to the first device callback', () => {
    const events = [
      traced('OutputController::Play', 1_000),
      traced(DEVICE_CALLBACK_EVENT, 1_000 + 250_000),
    ];
    const first = firstStart(events, 0);
    expect(first?.dMs).toBe(250);
    expect(classifyStart(first?.dMs ?? null)).toBe('cold');
  });

  test('the cold, warm and ambiguous bands are the measured thresholds', () => {
    expect(classifyStart(100)).toBe('cold');
    expect(classifyStart(60)).toBe('warm');
    expect(classifyStart(80)).toBe('ambiguous');
    expect(classifyStart(null)).toBe('absent');
  });
});

describe('primer trace: device excess and frame percentiles', () => {
  test('a steady device has no excess; one late callback shows as excess', () => {
    const steady = callbacks(0, 180).map((e) => e.ts);
    expect(deviceExcessMs(steady)!).toBeLessThan(0.01);
    // Push every callback from index 31 onward back by 24 ms: one 45 ms interval.
    const late = callbacks(0, 60).map((e) => e.ts);
    for (let i = 31; i < late.length; i++) late[i] = late[i]! + 24_000;
    expect(deviceExcessMs(late)!).toBeGreaterThan(20);
  });

  test('too few callbacks is no measurement', () => {
    expect(deviceExcessMs(callbacks(0, 3).map((e) => e.ts))).toBeNull();
  });

  test('p95 is the floor(n * 0.95) rank, matching the steady gate', () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(p95(values)).toBe(95);
    expect(p95([])).toBeNull();
  });
});

describe('primer gates: passing evidence and negative controls', () => {
  test('evidence within every budget passes', () => {
    expect(gatePrimerWindow(passingWindow())).toEqual([]);
  });

  test('a first-frame-only plateau fails the gap gate (the stall the primer removes)', () => {
    const plateau = [...steadyGaps(60), 291.8, ...steadyGaps(34)];
    const failures = gatePrimerWindow(passingWindow({ gapsMs: plateau }));
    expect(failures.some((f) => f.includes('max gap 291.8'))).toBe(true);
    expect(stalls(plateau)).toBe(true);
    expect(stalls(steadyGaps())).toBe(false);
  });

  test('a first frame over 350 ms fails the first-frame budget', () => {
    const failures = gatePrimerWindow(passingWindow({ startupMs: 351 }));
    expect(
      failures.some((f) => f.includes('first frame 351.0 ms > 350 ms'))
    ).toBe(true);
  });

  test('a p95 over 50 ms fails even with no single gap over 100', () => {
    const gaps = Array.from({ length: 95 }, (_, i) => (i < 10 ? 70 : 41.7));
    const failures = gatePrimerWindow(passingWindow({ gapsMs: gaps }));
    expect(failures.some((f) => f.includes('p95 gap'))).toBe(true);
    expect(failures.some((f) => f.includes('max gap'))).toBe(false);
  });

  test('a stream start the primer should have shared fails the zero-start gate', () => {
    const failures = gatePrimerWindow(passingWindow({ streamStarts: 1 }));
    expect(failures).toEqual(['1 stream start(s) after Play, expected 0']);
  });

  test('first-click needs Buffering before the first frame and exactly one start', () => {
    const failures = gatePrimerWindow(
      passingWindow({
        firstClick: true,
        expectedStreamStarts: 1,
        streamStarts: 1,
        bufferingBeforeFirstFrame: false,
        firstCallbackMs: 60,
        startupMs: 120,
      })
    );
    expect(failures).toEqual([
      'Buffering was not shown before the first frame',
      'first frame 120.0 ms is later than the first device callback 60.0 ms + 50 ms',
    ]);
  });

  test('an audio gap over 20 ms fails the audio budget', () => {
    const failures = gatePrimerWindow(passingWindow({ deviceExcessMs: 25 }));
    expect(failures).toEqual(['audio gap 25.0 ms > 20 ms']);
  });

  test('a window with too few presented frames fails rather than passing empty', () => {
    const failures = gatePrimerWindow(
      passingWindow({ gapsMs: steadyGaps(10) })
    );
    expect(failures.some((f) => f.includes('presented frames'))).toBe(true);
  });
});
