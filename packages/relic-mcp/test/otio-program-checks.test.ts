import {
  type Coldness,
  externalRunningMs,
  markOrderFailures,
  PIPELINE_INIT_EVENT,
  pipelineResumed,
  PLAY_MARK,
  RESUME_WINDOW_US,
  UNMUTE_MARK,
  classifyColdness,
  creationCounts,
  DEVICE_CALLBACK_EVENT,
  DEVICE_START_EVENT,
  deviceExcessMs,
  deviceStarts,
  firstStart,
  gateGaps,
  gatePrimerWindow,
  intervals,
  MIN_WINDOW_INTERVALS,
  markTs,
  missedSlots,
  newFrames,
  p95,
  type PrimerWindow,
  PREPARE_MARK,
  quietWindow,
  TRACE_START_MARK,
  WINDOW_MS,
  windowEdgeGaps,
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
import {
  bareControlFailures,
  type BareEvidence,
  coldStallComparator,
  coldTrials,
  inconclusiveFailures,
  measureBare,
} from './otio-program-primer-controls.ts';
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
/** 30 fps presented frames: 33.3 ms gaps, the program's steady cadence. */
const steadyGaps = (n = 95) =>
  Array.from({ length: n }, () => 1000 / PROGRAM.fps);

const passingWindow = (over: Partial<PrimerWindow> = {}): PrimerWindow => ({
  startupMs: 120,
  gapsMs: steadyGaps(),
  trailingGapMs: 16,
  bufferingBeforeFirstFrame: null,
  deviceStarts: 0,
  expectedDeviceStarts: 0,
  firstClick: false,
  ...over,
});

describe('primer trace: marks, device starts and creation telemetry', () => {
  test('a mark is found only on the user-timing category', () => {
    const events = [traced(PREPARE_MARK, 5), mark(PREPARE_MARK, 900)];
    expect(markTs(events, PREPARE_MARK)).toBe(900);
    expect(markTs(events, 'relic-play-pointerdown')).toBeNull();
  });

  test('a device start is OutputController::Play alone; stream creation is telemetry', () => {
    const events = [
      traced('AudioOutputDevice::Start', 100),
      traced('CreateStream', 101),
      traced(DEVICE_START_EVENT, 102),
    ];
    expect(deviceStarts(events, 0)).toBe(1);
    expect(creationCounts(events, 0)).toEqual({
      'AudioOutputDevice::Start': 1,
      CreateStream: 1,
    });
  });

  test('device starts before the window are not counted', () => {
    const events = [
      traced(DEVICE_START_EVENT, 50),
      traced(DEVICE_START_EVENT, 500),
    ];
    expect(deviceStarts(events, 100)).toBe(1);
    expect(deviceStarts(events, 100, 400)).toBe(0);
  });
});

describe('primer trace: quiet window before the trusted event', () => {
  const trusted = 1_000_000;
  const start = (ts: number) => mark(TRACE_START_MARK, ts);

  test('a covered window with no activity is quiet', () => {
    const quiet = quietWindow([start(0), mark(PREPARE_MARK, trusted)], trusted);
    expect(quiet).toEqual({ covered: true, offending: [] });
  });

  test('a trace started less than 500 ms before the event is not covered', () => {
    const quiet = quietWindow(
      [start(600_000), mark(PREPARE_MARK, trusted)],
      trusted
    );
    expect(quiet.covered).toBe(false);
  });

  test('each device-activity name inside the window is flagged', () => {
    for (const name of [
      'AudioOutputDevice::Start',
      'CreateStream',
      DEVICE_START_EVENT,
      DEVICE_CALLBACK_EVENT,
    ]) {
      const quiet = quietWindow(
        [
          start(0),
          traced(name, trusted - 100_000),
          mark(PREPARE_MARK, trusted),
        ],
        trusted
      );
      expect(quiet.offending).toEqual([name]);
    }
  });

  test('activity before the window is not offending', () => {
    const quiet = quietWindow(
      [
        start(0),
        traced(DEVICE_CALLBACK_EVENT, 100_000),
        mark(PREPARE_MARK, trusted),
      ],
      trusted
    );
    expect(quiet).toEqual({ covered: true, offending: [] });
  });
});

describe('primer trace: coldness and device-start evidence', () => {
  const quiet = { covered: true, offending: [] };
  const cold = {
    quiet,
    osIdleAtTrusted: true,
    startsAfterTrusted: 1,
    resumed: false,
  };

  test('a covered quiet window, an idle OS and a later device start is cold', () => {
    expect(classifyColdness(cold)).toBe('cold');
  });

  test('no device start after the event is absent, never cold', () => {
    expect(classifyColdness({ ...cold, startsAfterTrusted: 0 })).toBe('absent');
  });

  test('activity in the window or a running OS output is warm', () => {
    expect(
      classifyColdness({
        ...cold,
        quiet: { covered: true, offending: ['CreateStream'] },
      })
    ).toBe('warm');
    expect(classifyColdness({ ...cold, osIdleAtTrusted: false })).toBe('warm');
  });

  test('an uncovered window is unproven, whatever else it shows', () => {
    expect(
      classifyColdness({ ...cold, quiet: { covered: false, offending: [] } })
    ).toBe('unproven');
  });

  test('D runs from the first device start to the first device callback', () => {
    const events = [
      traced(DEVICE_START_EVENT, 1_000),
      traced(DEVICE_CALLBACK_EVENT, 251_000),
    ];
    expect(firstStart(events, 0)?.dMs).toBe(250);
  });
});

describe('primer trace: a resumed start is labelled, never cold', () => {
  const trusted = 2_000_000;
  const started = {
    quiet: { covered: true, offending: [] },
    osIdleAtTrusted: true,
    startsAfterTrusted: 1,
    resumed: false,
  };

  test('a rebuilt pipeline after a suspended program is resumed', () => {
    expect(classifyColdness({ ...started, resumed: true })).toBe('resumed');
  });

  test('resumed keeps the warm and absent labels that come before it', () => {
    expect(
      classifyColdness({ ...started, resumed: true, osIdleAtTrusted: false })
    ).toBe('warm');
    expect(
      classifyColdness({ ...started, resumed: true, startsAfterTrusted: 0 })
    ).toBe('absent');
  });

  test('a rebuild shortly after Play is resumed; a rebuild at load or after the window is not', () => {
    expect(
      pipelineResumed(
        [traced(PIPELINE_INIT_EVENT, trusted + 250)],
        trusted,
        trusted + RESUME_WINDOW_US
      )
    ).toBe(true);
    expect(
      pipelineResumed(
        [traced(PIPELINE_INIT_EVENT, 100)],
        trusted,
        trusted + RESUME_WINDOW_US
      )
    ).toBe(false);
    expect(
      pipelineResumed(
        [traced(PIPELINE_INIT_EVENT, trusted + RESUME_WINDOW_US + 1)],
        trusted,
        trusted + RESUME_WINDOW_US
      )
    ).toBe(false);
  });

  test('a Play that rebuilds the pipeline after a suspend is classified resumed end to end', () => {
    const events = [
      mark(TRACE_START_MARK, 0),
      mark(PREPARE_MARK, trusted - 1_500_000),
      mark(PLAY_MARK, trusted),
      traced(PIPELINE_INIT_EVENT, trusted + 250),
      traced(DEVICE_START_EVENT, trusted + 2_100),
    ];
    expect(
      classifyColdness({
        quiet: quietWindow(events, trusted),
        osIdleAtTrusted: true,
        startsAfterTrusted: deviceStarts(events, trusted),
        resumed: pipelineResumed(events, trusted, trusted + RESUME_WINDOW_US),
      })
    ).toBe('resumed');
  });
});

describe('primer trace: strict mark order and the quiet window', () => {
  const at = 2_000_000;

  test('the late-trial leads seen on the proof run fail: 171, 150 and 93 µs before the mark', () => {
    const failures = markOrderFailures(
      [
        mark(PREPARE_MARK, at),
        traced('RendererImpl::SetPlaybackRate', at - 171),
        traced('AudioOutputDevice::Play', at - 150),
        traced(DEVICE_START_EVENT, at - 93),
      ],
      PREPARE_MARK
    );
    expect(failures).toHaveLength(3);
    expect(failures[0]).toContain(
      'page reacted before relic-prepare-pointerdown by 171 µs'
    );
  });

  test('a reaction 8 µs before its mark fails', () => {
    expect(
      markOrderFailures(
        [
          mark(UNMUTE_MARK, at),
          traced('RendererImpl::SetPlaybackRate', at - 8),
        ],
        UNMUTE_MARK
      )
    ).toHaveLength(1);
  });

  test('a reaction after its mark passes, and so does a preroll 2 s earlier', () => {
    expect(
      markOrderFailures(
        [
          mark(PLAY_MARK, at),
          traced('RendererImpl::SetPlaybackRate', at + 100),
        ],
        PLAY_MARK
      )
    ).toEqual([]);
    expect(
      markOrderFailures(
        [
          mark(PLAY_MARK, at),
          traced('RendererImpl::SetPlaybackRate', at - 2_000_000),
        ],
        PLAY_MARK
      )
    ).toEqual([]);
  });

  test('a reaction 6 ms before its mark is outside the 5 ms window and passes', () => {
    expect(
      markOrderFailures(
        [mark(PLAY_MARK, at), traced('AudioOutputDevice::Play', at - 6_000)],
        PLAY_MARK
      )
    ).toEqual([]);
  });

  test('an absent mark has no order to check', () => {
    expect(
      markOrderFailures(
        [traced('AudioOutputDevice::Play', at - 8)],
        UNMUTE_MARK
      )
    ).toEqual([]);
  });

  test('a device start before the mark is offending; the same start after it is not', () => {
    const before = quietWindow(
      [
        mark(TRACE_START_MARK, 0),
        traced(DEVICE_START_EVENT, at - 100),
        mark(PREPARE_MARK, at),
      ],
      at
    );
    expect(before.offending).toEqual([DEVICE_START_EVENT]);
    const after = quietWindow(
      [
        mark(TRACE_START_MARK, 0),
        mark(PREPARE_MARK, at),
        traced(DEVICE_START_EVENT, at + 100),
      ],
      at
    );
    expect(after).toEqual({ covered: true, offending: [] });
  });
});

describe('primer trace: OS running after Chrome paused is telemetry', () => {
  // Shaped like the sham trial that the late-trial receipts describe: Chrome paused at 10.259 s,
  // the OS read the output running until 13.744 s, idle from 13.952 s, and the trusted event at 15.192 s.
  const pause = 10_259_000;
  const trusted = 15_192_000;
  const events = [
    traced('OutputController::Pause', pause),
    mark(PREPARE_MARK, trusted),
  ];
  const reading = (traceTs: number, running: boolean) => ({ traceTs, running });

  test('the span from Chrome pause to the last running reading is reported', () => {
    const readings = [
      reading(11_000_000, true),
      reading(13_744_000, true),
      reading(13_952_000, false),
    ];
    expect(externalRunningMs(events, readings, trusted)).toBe(3485);
  });

  test('a Chrome device event after the pause ends the reading that follows it', () => {
    const withPlay = [...events, traced('AudioOutputDevice::Play', 12_000_000)];
    const readings = [reading(11_000_000, true), reading(13_744_000, true)];
    expect(externalRunningMs(withPlay, readings, trusted)).toBe(741);
  });

  test('no pause, no running reading, or a pause after the trusted event gives null', () => {
    expect(
      externalRunningMs(
        [mark(PREPARE_MARK, trusted)],
        [reading(11_000_000, true)],
        trusted
      )
    ).toBeNull();
    expect(
      externalRunningMs(events, [reading(11_000_000, false)], trusted)
    ).toBeNull();
    expect(
      externalRunningMs(
        [traced('OutputController::Pause', trusted + 1)],
        [reading(trusted - 1, true)],
        trusted
      )
    ).toBeNull();
  });
});

describe('primer cold pool: resumed trials never enter the stall comparator', () => {
  const step = 1000 / PROGRAM.fps;

  /** One 4 s window at 30 fps. A stalled window holds one frame for two intervals mid-window. */
  function bareWindow(stalled: boolean): BareEvidence {
    const pointerAt = 1_000;
    const kept: { now: number; mediaTime: number; presentationTime: number }[] =
      [];
    let at = pointerAt + 20;
    for (let i = 0; at < pointerAt + WINDOW_MS - 10; i++) {
      kept.push({
        now: at + 3,
        mediaTime: i / PROGRAM.fps,
        presentationTime: at,
      });
      at += i === 60 && stalled ? 2 * step : step;
    }
    return measureBare({
      kept,
      pointerAt,
      ticksMs: null,
      windowMs: WINDOW_MS,
      fps: PROGRAM.fps,
    });
  }
  const trial = (coldness: Coldness, stalled: boolean) => ({
    round: 0,
    arm: 'none',
    coldness,
    bare: bareWindow(stalled),
  });

  test('a stalled cold trial passes the comparator; a healthy one is named', () => {
    expect(coldStallComparator([trial('cold', true)])).toEqual([]);
    const failures = coldStallComparator([trial('cold', false)]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('missed no program frame slot');
  });

  test('four stalled cold trials pass once a healthy resumed trial is excluded', () => {
    const pool = [
      trial('cold', true),
      trial('cold', true),
      trial('cold', true),
      trial('cold', true),
      trial('resumed', false),
    ];
    // The healthy resumed trial would fail the comparator if the pool counted it.
    expect(coldStallComparator(pool)).toHaveLength(1);
    expect(coldStallComparator(coldTrials(pool))).toEqual([]);
    expect(inconclusiveFailures('bare none', pool)).toEqual([]);
  });

  test('two cold trials make the pool inconclusive, whatever resumed trials sit beside them', () => {
    const pool = [
      trial('cold', true),
      trial('cold', true),
      trial('resumed', true),
      trial('resumed', true),
    ];
    expect(inconclusiveFailures('bare none', pool)).toEqual([
      'bare none: 2 cold trial(s), need 3; inconclusive',
    ]);
    expect(
      inconclusiveFailures('bare none', [...pool, trial('cold', true)])
    ).toEqual([]);
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
    expect(missedSlots(plateau, PROGRAM.fps)).toBeGreaterThan(0);
    expect(missedSlots(steadyGaps(), PROGRAM.fps)).toBe(0);
  });

  test('missed program frame slots: a gap of 50 ms or more skips a slot, and the trailing gap counts', () => {
    expect(missedSlots([49.9], PROGRAM.fps)).toBe(0);
    expect(missedSlots([50], PROGRAM.fps)).toBe(1);
    expect(missedSlots([66.8], PROGRAM.fps)).toBe(1);
    expect(missedSlots([99.4], PROGRAM.fps)).toBe(2);
    expect(missedSlots([100], PROGRAM.fps)).toBe(2);
    expect(missedSlots([100.6], PROGRAM.fps)).toBe(2);
    expect(missedSlots([35.3, 38.9], PROGRAM.fps)).toBe(0);
    expect(missedSlots([880], PROGRAM.fps)).toBe(25);
  });

  test('the bare negative controls and the cold comparator reject and accept their own windows', () => {
    expect(bareControlFailures()).toEqual([]);
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

  test('a device start the primer should have shared fails the zero-start gate', () => {
    const failures = gatePrimerWindow(passingWindow({ deviceStarts: 1 }));
    expect(failures).toEqual(['1 device start(s) after Play, expected 0']);
  });

  test('first-click needs Buffering before the first frame and exactly one device start', () => {
    const failures = gatePrimerWindow(
      passingWindow({
        firstClick: true,
        expectedDeviceStarts: 1,
        deviceStarts: 1,
        bufferingBeforeFirstFrame: false,
        startupMs: 120,
      })
    );
    expect(failures).toEqual([
      'Buffering was not shown before the first frame',
    ]);
  });

  test('first-click has no device-callback clause: a late callback never fails the gate', () => {
    const failures = gatePrimerWindow(
      passingWindow({
        firstClick: true,
        expectedDeviceStarts: 1,
        deviceStarts: 1,
        bufferingBeforeFirstFrame: true,
        startupMs: 120,
      })
    );
    expect(failures).toEqual([]);
  });

  test('a window with too few presented frames fails rather than passing empty', () => {
    const failures = gatePrimerWindow(
      passingWindow({ gapsMs: steadyGaps(10) })
    );
    expect(failures.some((f) => f.includes('presented frames'))).toBe(true);
  });
});

describe('primer trace: first new frame and freezes', () => {
  const fps = PROGRAM.fps;
  // Round 0 shape: the resting frame repeats at +8 and +16.2 ms; new frames run from +149.6 ms.
  const round0 = [
    { now: 8, mediaTime: 0 },
    { now: 16.2, mediaTime: 0 },
    ...Array.from({ length: 119 }, (_, i) => ({
      now: 149.6 + (i * 1000) / fps,
      mediaTime: (i + 1) / fps,
    })),
  ];
  const restCurrentTime = 0.016666;
  const gatedFromFirstNew = (
    frames: readonly { now: number; mediaTime: number }[]
  ) => {
    const fresh = newFrames(frames, restCurrentTime, fps);
    const edges = windowEdgeGaps(
      fresh.kept.map((f) => f.now),
      0,
      WINDOW_MS
    );
    return gatePrimerWindow({
      startupMs: fresh.firstNew ? fresh.firstNew.now : null,
      gapsMs: edges.gapsMs,
      trailingGapMs: edges.trailingGapMs,
      bufferingBeforeFirstFrame: true,
      deviceStarts: 1,
      expectedDeviceStarts: 1,
      firstClick: true,
    });
  };

  test('the first new frame, not the resting frame, starts the window', () => {
    const fresh = newFrames(round0, restCurrentTime, fps);
    expect(fresh.firstNew?.now).toBe(149.6);
    expect(fresh.backward).toBe(false);
    expect(gatedFromFirstNew(round0)).toEqual([]);
  });

  test('read the old way, from every presented frame, the same round fails at 133.4 ms', () => {
    const gaps = intervals(round0.map((f) => f.now));
    const failures = gatePrimerWindow({
      startupMs: 149.6,
      gapsMs: gaps,
      trailingGapMs: null,
      bufferingBeforeFirstFrame: true,
      deviceStarts: 1,
      expectedDeviceStarts: 1,
      firstClick: true,
    });
    expect(failures.some((f) => f.includes('max gap 133.4'))).toBe(true);
  });

  test('a freeze in the middle of the window still fails the 100 ms gate', () => {
    const frozen = [...round0.slice(0, 62), ...round0.slice(66)];
    const failures = gatedFromFirstNew(frozen);
    expect(failures.some((f) => f.includes('max gap'))).toBe(true);
  });

  test('a backward media-time step fails', () => {
    const fresh = newFrames(
      [...round0, { now: 4000, mediaTime: 0.5 }],
      restCurrentTime,
      fps
    );
    expect(fresh.backward).toBe(true);
  });
});

describe('primer window edges: a terminal stall fails and startup is not a gap', () => {
  const pointerAt = 1000;
  const end = pointerAt + WINDOW_MS;
  const stepMs = 1000 / PROGRAM.fps;
  /** Presented times every frame step from fromMs through toMs, inclusive. */
  const presentedFrom = (fromMs: number, toMs: number) =>
    Array.from(
      { length: Math.round((toMs - fromMs) / stepMs) + 1 },
      (_, i) => fromMs + i * stepMs
    );

  test('a stall that runs to the window end fails the 100 ms gate; the gaps alone miss it', () => {
    // Frames stop 3.12 s after the Play and nothing follows, so no gap between frames shows it.
    const edges = windowEdgeGaps(
      presentedFrom(pointerAt + 120, pointerAt + 3120),
      pointerAt,
      end
    );
    expect(missedSlots(edges.gapsMs, PROGRAM.fps)).toBe(0);
    expect(edges.trailingGapMs).toBeCloseTo(880, 6);
    expect(
      gatePrimerWindow(
        passingWindow({
          startupMs: 120,
          gapsMs: edges.gapsMs,
          trailingGapMs: null,
        })
      )
    ).toEqual([]);
    const failures = gatePrimerWindow(
      passingWindow({
        startupMs: 120,
        gapsMs: edges.gapsMs,
        trailingGapMs: edges.trailingGapMs,
      })
    );
    expect(failures.some((f) => f.includes('max gap 880.0'))).toBe(true);
  });

  test('startup before the first frame is the startup budget, not a gap', () => {
    const edges = windowEdgeGaps(
      presentedFrom(pointerAt + 340, end - 20),
      pointerAt,
      end
    );
    expect(edges.leadingGapMs).toBeNull();
    expect(edges.gapsMs.every((gap) => gap < 40)).toBe(true);
    expect(edges.trailingGapMs).toBeCloseTo(80 / 3, 6);
    expect(
      gatePrimerWindow(
        passingWindow({
          startupMs: 340,
          gapsMs: edges.gapsMs,
          trailingGapMs: edges.trailingGapMs,
        })
      )
    ).toEqual([]);
  });

  test('a frame presented after the window end is outside the window', () => {
    const presented = [...presentedFrom(pointerAt + 340, end - 20), end + 30];
    const edges = windowEdgeGaps(presented, pointerAt, end);
    expect(edges.trailingGapMs).toBeCloseTo(80 / 3, 6);
    expect(edges.gapsMs.every((gap) => gap < 40)).toBe(true);
  });

  test('a window that starts after a presented frame and shows none inside is one stall', () => {
    const edges = windowEdgeGaps(presentedFrom(0, 900), pointerAt, end);
    expect(edges.gapsMs).toEqual([]);
    expect(edges.trailingGapMs).toBe(WINDOW_MS);
    const failures = gatePrimerWindow(
      passingWindow({
        startupMs: 340,
        gapsMs: edges.gapsMs,
        trailingGapMs: edges.trailingGapMs,
      })
    );
    expect(failures.some((f) => f.includes('max gap 4000.0'))).toBe(true);
  });

  test('a leading edge gap is the stall that runs in from the window start', () => {
    // The last frame before the window is at 900 ms and the first inside it at 1250 ms.
    const edges = windowEdgeGaps(
      [900, ...presentedFrom(pointerAt + 250, end - 20)],
      pointerAt,
      end
    );
    expect(edges.leadingGapMs).toBeCloseTo(250, 6);
    expect(edges.gapsMs.every((gap) => gap < 40)).toBe(true);
    const failures = gateGaps(
      edges.gapsMs,
      MIN_WINDOW_INTERVALS,
      'unmute window',
      [edges.leadingGapMs!, edges.trailingGapMs!]
    );
    expect(failures.some((f) => f.includes('max gap 250.0'))).toBe(true);
  });

  test('an edge gap counts toward max and p95 but never toward the interval minimum', () => {
    const edgeOnly = Array.from({ length: 80 }, () => 1000 / PROGRAM.fps);
    expect(
      gateGaps(steadyGaps(10), MIN_WINDOW_INTERVALS, 'w', edgeOnly).some((f) =>
        f.includes('only 11 presented frames')
      )
    ).toBe(true);
    expect(
      gateGaps(steadyGaps(95), MIN_WINDOW_INTERVALS, 'w', [150]).some((f) =>
        f.includes('max gap 150.0')
      )
    ).toBe(true);
    expect(gateGaps(steadyGaps(95), MIN_WINDOW_INTERVALS, 'w', [])).toEqual([]);
  });
});
