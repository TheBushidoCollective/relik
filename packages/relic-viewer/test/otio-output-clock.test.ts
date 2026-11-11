import { describe, expect, test } from 'bun:test';
import { OutputClock } from '../src/otio-output-clock';

const sample = (time: number, offset = 1000) => ({
  readBegin: time + offset,
  readEnd: time + offset + 1,
  contextBefore: time / 1000 + 0.01,
  contextAfter: time / 1000 + 0.02,
  state: 'running',
  contextTime: time / 1000,
  performanceTime: time + offset,
});
const ready = () => {
  const clock = new OutputClock(1000);
  for (const t of [10, 20, 30, 40]) clock.observe(sample(t));
  return clock;
};
describe('output clock admission', () => {
  test('requires distinct advancing observations and keeps deadline', () => {
    const c = new OutputClock(1000);
    expect(c.observe(sample(10)).status).toBe('calibrating');
    expect(c.observe(sample(10)).reason).toBe('duplicate');
    for (const t of [20, 30, 40]) c.observe(sample(t));
    expect(c.state).toBe('calibrated');
    expect(c.deadline).toBe(1350);
    expect(c.observe(sample(351)).reason).toBe('deadline');
  });
  test('54ms jump resets candidate before start and interrupts after start', () => {
    const c = ready();
    expect(c.observe(sample(102, 1054.015)).reason).toBe('discontinuity');
    expect(c.state).toBe('calibrating');
    for (const t of [110, 120, 130, 140]) c.observe(sample(t, 1054.015));
    expect(c.state).toBe('calibrated');
    c.arm();
    c.start();
    expect(c.observe(sample(150, 1000)).status).toBe('interrupted');
  });
  test('rejects the recorded running-59 timestamp pair', () => {
    const c = new OutputClock(2670);
    c.observe({
      readBegin: 2680.6,
      readEnd: 2681,
      contextBefore: 0.05,
      contextAfter: 0.05,
      state: 'running',
      contextTime: 0.0367336667,
      performanceTime: 2680.6,
    });
    expect(
      c.observe({
        readBegin: 2742.6,
        readEnd: 2743,
        contextBefore: 0.11,
        contextAfter: 0.11,
        state: 'running',
        contextTime: 0.0447186667,
        performanceTime: 2742.6,
      }).reason
    ).toBe('discontinuity');
    expect(c.observations).toHaveLength(2);
  });
  test('invalid, stale, suspended and stagnant observations never start playback', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 0]) {
      const c = ready();
      expect(c.observe({ ...sample(50), contextTime: value }).status).not.toBe(
        'calibrated'
      );
      expect(c.observations.at(-1)?.observation.contextTime).toBe(value);
    }
    const c = ready();
    c.arm();
    c.start();
    expect(c.observe({ ...sample(50), state: 'suspended' }).status).toBe(
      'interrupted'
    );
    const d = ready();
    d.arm();
    d.start();
    expect(
      d.observe({ ...sample(40), readBegin: 1100, readEnd: 1101 }).status
    ).toBe('interrupted');
  });
  test('duplicate samples cannot extend admission or conceal stale clock', () => {
    const c = new OutputClock(1000);
    c.observe(sample(10));
    for (let i = 0; i < 4; i++) c.observe(sample(10));
    expect(c.state).toBe('calibrating');
    expect(
      c.observe({ ...sample(10), readBegin: 1070, readEnd: 1071 }).reason
    ).toBe('stale');
  });
  test('rejects future and regressing pairs and terminates at the sample cap', () => {
    const c = ready();
    expect(c.observe({ ...sample(50), performanceTime: 1060 }).reason).toBe(
      'future'
    );
    expect(c.observe(sample(10)).status).toBe('calibrating');
    expect(c.observe(sample(9)).reason).toBe('regression');
    const bounded = new OutputClock(1000, {
      maxSamples: 2,
      minAdvances: 3,
      minWindowMs: 30,
      freshnessMs: 50,
      futureToleranceMs: 2,
      maxOffsetSpreadMs: 10,
    });
    bounded.observe(sample(10));
    bounded.observe(sample(10));
    expect(bounded.observe(sample(20))).toMatchObject({
      status: 'failed',
      reason: 'sample-cap',
    });
  });
  test('streams every playback observation without retaining an unbounded history', () => {
    const records: unknown[] = [];
    const c = new OutputClock(1000, undefined, (record) =>
      records.push(record)
    );
    for (const t of [10, 20, 30, 40]) c.observe(sample(t));
    c.arm();
    c.start();
    for (let t = 50; t < 1000; t += 10) c.observe(sample(t));
    expect(c.observations).toHaveLength(4);
    expect(records.length).toBe(99);
    c.observe({ ...sample(1000), contextTime: NaN });
    expect(c.lastRejection?.observation.contextTime).toBeNaN();
  });
  test('rolling runtime window permits gradual drift but rejects a sudden step', () => {
    const c = ready();
    c.arm();
    c.start();
    for (let t = 50; t <= 250; t += 10) {
      const result = c.observe(sample(t, 1000 + (t - 40) / 10));
      expect(result.status).toBe('playing');
      expect(result.offsetMax! - result.offsetMin!).toBeLessThanOrEqual(10);
    }
    expect(c.observe(sample(260, 1075.015))).toMatchObject({
      status: 'interrupted',
      reason: 'discontinuity',
    });
  });
  test('runtime window refuses to drop in-window observations at its cap', () => {
    const c = new OutputClock(1000, {
      maxSamples: 5,
      minAdvances: 3,
      minWindowMs: 30,
      freshnessMs: 50,
      futureToleranceMs: 2,
      maxOffsetSpreadMs: 10,
    });
    for (const t of [10, 20, 30, 40]) c.observe(sample(t));
    c.arm();
    c.start();
    for (const t of [41, 42, 43, 44])
      expect(c.observe(sample(t)).status).toBe('playing');
    expect(c.observe(sample(45))).toMatchObject({
      status: 'interrupted',
      reason: 'runtime-window-cap',
    });
  });
  test('recovery inherits actual fresh samples but requires a new advancing read', () => {
    const c = ready();
    c.arm();
    c.start();
    for (const t of [50, 60, 70]) c.observe(sample(t));
    const fork = c.forkForRequest(1071, 1071);
    expect(fork).not.toBeNull();
    expect(fork!.deadline).toBe(1421);
    expect(fork!.inheritedObservations).toEqual(
      [40, 50, 60, 70].map((t) => sample(t))
    );
    expect(() => fork!.arm()).toThrow();
    expect(
      fork!.observe({ ...sample(70), readBegin: 1072, readEnd: 1073 }).reason
    ).toBe('duplicate');
    expect(() => fork!.arm()).toThrow();
    expect(fork!.observe(sample(80)).status).toBe('calibrated');
    fork!.arm();
  });
  test('60 Hz observations support recovery without widening the runtime window', () => {
    const c = ready();
    c.arm();
    c.start();
    for (const t of [56, 73, 89])
      expect(c.observe(sample(t)).status).toBe('playing');
    const fork = c.forkForRequest(1090, 1090);
    expect(fork?.inheritedObservations).toEqual(
      [40, 56, 73, 89].map((t) => sample(t))
    );
    expect(fork?.observe(sample(100)).status).toBe('calibrated');
    expect(c.observe(sample(100, 1054.015))).toMatchObject({
      status: 'interrupted',
      reason: 'discontinuity',
    });
  });
  test('recovery cannot inherit stale, insufficient, interrupted, or discontinuous observations', () => {
    const c = ready();
    c.arm();
    c.start();
    expect(c.forkForRequest(1041, 1041)).toBeNull();
    for (const t of [50, 60, 70]) c.observe(sample(t));
    expect(c.forkForRequest(1130, 1130)).toBeNull();
    expect(c.forkForRequest(1071, 1422)).toBeNull();
    const fork = c.forkForRequest(1071, 1071)!;
    expect(fork.observe(sample(80, 1054.015)).reason).toBe('discontinuity');
    expect(() => fork.arm()).toThrow();
    c.invalidate('sinkchange');
    expect(c.forkForRequest(1071, 1071)).toBeNull();
  });
});

// Recorded CI rows (scheduled-pcm-cold-start-48000.json), each as
// [readEnd, contextAfter, contextTime, performanceTime]. readBegin is readEnd
// and contextBefore is contextAfter, as the browser recorded them.
const RECORDED: readonly (readonly [number, number, number, number])[] = [
  [2475.2999999999884, 1.616, 1.5737023333333333, 2468.2999999999884],
  [2478.0999999999767, 1.624, 1.5835541666666668, 2478.0999999999767],
  [2483.5999999999767, 1.624, 1.5835541666666668, 2478.0999999999767],
  [2491.5999999999767, 1.6346666666666667, 1.593615, 2488.0999999999767],
  [2494.7999999999884, 1.6346666666666667, 1.593615, 2488.0999999999767],
  [
    2499.6999999999534, 1.6453333333333333, 1.6036628333333336,
    2498.1999999999534,
  ],
  [
    2507.7999999999884, 1.6453333333333333, 1.6036628333333336,
    2498.1999999999534,
  ],
  [2511.399999999965, 1.656, 1.6135296666666668, 2508.0999999999767],
  [2516.7999999999884, 1.656, 1.6135296666666668, 2508.0999999999767],
  [2524.899999999965, 1.664, 1.6235275, 2518.0999999999767],
  [
    2528.0999999999767, 1.6693333333333333, 1.6335173333333333,
    2528.0999999999767,
  ],
  [
    2532.899999999965, 1.6746666666666667, 1.6336033333333333,
    2528.0999999999767,
  ],
];
const recordedRead = ([
  readEnd,
  contextAfter,
  contextTime,
  performanceTime,
]: readonly [number, number, number, number]) => ({
  readBegin: readEnd,
  readEnd,
  contextBefore: contextAfter,
  contextAfter,
  state: 'running',
  contextTime,
  performanceTime,
});
// A read whose bracket collapses to one instant at readEnd.
const read = (
  contextTime: number,
  performanceTime: number,
  readEnd = 2532.9
) => ({
  readBegin: readEnd,
  readEnd,
  contextBefore: contextTime,
  contextAfter: contextTime,
  state: 'running',
  contextTime,
  performanceTime,
});
// A sample() read whose contextTime moves by `us` microseconds, performanceTime kept.
const holdOf = (time: number, us: number) => ({
  ...sample(time),
  contextTime: time / 1000 + us / 1e6,
});
// Replays rows 1 to 11. Row 8 calibrates; rows 9 to 11 run in playback.
const replayRecorded = () => {
  const clock = new OutputClock(2470);
  for (const row of RECORDED.slice(0, 7)) clock.observe(recordedRead(row));
  expect(clock.state).toBe('calibrating');
  expect(clock.observe(recordedRead(RECORDED[7]!)).status).toBe('calibrated');
  clock.arm();
  clock.start();
  const results = RECORDED.slice(8, 11).map((row) =>
    clock.observe(recordedRead(row))
  );
  expect(results.map((r) => r.reason)).toEqual([
    'duplicate',
    'accepted',
    'accepted',
  ]);
  expect(results.every((r) => r.status === 'playing')).toBe(true);
  return { clock, row11: results[2]! };
};

describe('held reads at the performance rounding step', () => {
  test('replays the recorded running pair as a held read, not an interruption', () => {
    const { clock, row11 } = replayRecorded();
    const accepted = clock.lastAccepted;
    expect(accepted).toEqual({
      contextTime: 1.6335173333333333,
      performanceTime: 2528.0999999999767,
    });
    const held = clock.observe(recordedRead(RECORDED[11]!));
    expect(held.status).toBe('playing');
    expect(held.reason).toBe('sub-resolution');
    expect(held.offsetMin).toBe(row11.offsetMin);
    expect(held.offsetMax).toBe(row11.offsetMax);
    expect(clock.lastAccepted).toEqual(accepted);
    expect(clock.lastRejection).toBeNull();
  });

  test('a context-only advance of 199 us is held', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const r = clock.observe(
      read(base.contextTime + 0.000199, base.performanceTime)
    );
    expect(r.reason).toBe('sub-resolution');
    expect(r.status).toBe('playing');
  });

  test('a context-only advance of 200 us still interrupts', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const r = clock.observe(
      read(base.contextTime + 0.0002, base.performanceTime)
    );
    expect(r.reason).toBe('partial-advance');
    expect(r.status).toBe('interrupted');
  });

  test('a performance-only advance still interrupts', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const r = clock.observe(read(base.contextTime, base.performanceTime + 0.1));
    expect(r.reason).toBe('partial-advance');
    expect(r.status).toBe('interrupted');
  });

  test('holds at 86 and 150 us are fine, a third at 210 us interrupts', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    expect(
      clock.observe(read(base.contextTime + 0.000086, base.performanceTime))
        .reason
    ).toBe('sub-resolution');
    expect(
      clock.observe(read(base.contextTime + 0.00015, base.performanceTime))
        .reason
    ).toBe('sub-resolution');
    const r = clock.observe(
      read(base.contextTime + 0.00021, base.performanceTime)
    );
    expect(r.reason).toBe('partial-advance');
    expect(r.status).toBe('interrupted');
  });

  test('no creep: each hold is measured from the accepted pair, so 200 us ends them', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    for (const us of [90, 120, 150, 180, 199]) {
      expect(
        clock.observe(read(base.contextTime + us / 1e6, base.performanceTime))
          .reason
      ).toBe('sub-resolution');
    }
    const r = clock.observe(
      read(base.contextTime + 0.0002, base.performanceTime)
    );
    expect(r.reason).toBe('partial-advance');
    expect(r.status).toBe('interrupted');
  });

  test('a held read past the freshness window is stale, not stagnant', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const r = clock.observe(
      read(
        base.contextTime + 0.000086,
        base.performanceTime,
        base.performanceTime + 50.1
      )
    );
    expect(r.reason).toBe('stale');
    expect(r.status).toBe('interrupted');
  });

  test('a held read below the held mark regresses', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    expect(
      clock.observe(read(base.contextTime + 0.00015, base.performanceTime))
        .reason
    ).toBe('sub-resolution');
    const r = clock.observe(
      read(base.contextTime + 0.0001, base.performanceTime)
    );
    expect(r.reason).toBe('regression');
    expect(r.status).toBe('interrupted');
  });

  test('a held read neither calibrates nor resets calibration', () => {
    const c = new OutputClock(1000);
    c.observe(sample(10));
    c.observe(sample(25));
    c.observe(sample(40));
    expect(c.state).toBe('calibrating');
    const held = c.observe(holdOf(40, 86));
    expect(held.reason).toBe('sub-resolution');
    expect(held.status).toBe('calibrating');
    expect(c.observe(sample(45)).status).toBe('calibrated');
  });

  test('a held read keeps a calibrated or armed clock in its state', () => {
    const c = ready();
    const calibrated = c.observe(holdOf(40, 86));
    expect(calibrated.reason).toBe('sub-resolution');
    expect(calibrated.status).toBe('calibrated');
    c.arm();
    const armed = c.observe(holdOf(40, 150));
    expect(armed.reason).toBe('sub-resolution');
    expect(armed.status).toBe('armed');
    c.start();
    expect(c.state).toBe('playing');
  });

  test('a held read is never inherited by a recovery fork', () => {
    const c = ready();
    c.arm();
    c.start();
    for (const t of [50, 60, 70]) c.observe(sample(t));
    expect(c.observe(holdOf(70, 86)).reason).toBe('sub-resolution');
    const fork = c.forkForRequest(1000, 1075);
    expect(fork).not.toBeNull();
    expect(fork!.inheritedObservations.map((o) => o.contextTime)).toEqual([
      0.04, 0.05, 0.06, 0.07,
    ]);
    expect(fork!.lastAccepted).toEqual({
      contextTime: 0.07,
      performanceTime: 1070,
    });
  });

  test('lastAccepted is the last accepted pair, copied, and never a held read', () => {
    const c = new OutputClock(1000);
    expect(c.lastAccepted).toBeNull();
    c.observe(sample(10));
    const first = c.lastAccepted!;
    expect(first).toEqual({ contextTime: 0.01, performanceTime: 1010 });
    first.contextTime = 9;
    expect(c.lastAccepted).toEqual({
      contextTime: 0.01,
      performanceTime: 1010,
    });
    c.observe(sample(20));
    c.observe(holdOf(20, 86));
    expect(c.lastAccepted).toEqual({
      contextTime: 0.02,
      performanceTime: 1020,
    });
  });

  test('a held read leaves the last rejection and the last accepted pair alone', () => {
    const c = new OutputClock(1000);
    c.observe(sample(10));
    c.observe({ ...sample(20), state: 'suspended' });
    const rejection = c.lastRejection;
    expect(rejection?.result.reason).toBe('context-not-running');
    for (const t of [30, 40]) c.observe(sample(t));
    expect(c.observe(holdOf(40, 86)).reason).toBe('sub-resolution');
    expect(c.lastRejection).toBe(rejection);
    expect(c.lastAccepted).toEqual({
      contextTime: 0.04,
      performanceTime: 1040,
    });
  });
});
