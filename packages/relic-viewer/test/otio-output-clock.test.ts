import { describe, expect, test } from 'bun:test';
import {
  OutputClock,
  evidencePair,
  type ClockResult,
} from '../src/otio-output-clock';

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
  test('one future stamp is skipped: no evidence, the last accepted pair stands, playback continues', () => {
    const c = ready();
    c.arm();
    c.start();
    const accepted = c.lastAccepted;
    const future = { ...sample(50), performanceTime: 1055 };
    const skipped = c.observe(future);
    expect(skipped).toMatchObject({
      status: 'playing',
      reason: 'future-skipped',
    });
    expect(c.futureSkips).toBe(1);
    expect(c.lastAccepted).toEqual(accepted);
    expect(c.lastRejection).toBeNull();
    expect(evidencePair(c, skipped, 0.05, 1055)).toEqual(accepted);
    // The same stamp read again while it still leads is the same single skip.
    expect(
      c.observe({ ...future, readBegin: 1051, readEnd: 1052 }).reason
    ).toBe('future-skipped');
    expect(c.futureSkips).toBe(1);
    // A good stamp clears it, and a later future stamp is a new single skip.
    expect(c.observe(sample(60))).toMatchObject({
      status: 'playing',
      reason: 'accepted',
    });
    expect(c.observe({ ...sample(70), performanceTime: 1075 })).toMatchObject({
      status: 'playing',
      reason: 'future-skipped',
    });
    expect(c.futureSkips).toBe(2);
  });
  test('a context stamp ahead of currentTime is skipped once the same way', () => {
    const c = ready();
    c.arm();
    expect(c.observe({ ...sample(50), contextTime: 0.0731 })).toMatchObject({
      status: 'armed',
      reason: 'future-skipped',
    });
    expect(c.observe(sample(50)).status).toBe('armed');
  });
  test('a second future stamp before a good one interrupts playback', () => {
    const c = ready();
    c.arm();
    c.start();
    expect(c.observe({ ...sample(50), performanceTime: 1055 }).reason).toBe(
      'future-skipped'
    );
    expect(c.observe({ ...sample(52), performanceTime: 1057 })).toMatchObject({
      status: 'interrupted',
      reason: 'future',
    });
    expect(c.futureSkips).toBe(1);
    expect(c.lastRejection?.result.reason).toBe('future');
  });
  test('a future stamp that outlasts freshness with no good stamp interrupts playback', () => {
    const c = ready();
    c.arm();
    c.start();
    const future = { ...sample(41), performanceTime: 1100 };
    expect(c.observe(future).status).toBe('playing');
    expect(
      c.observe({ ...future, readBegin: 1091, readEnd: 1092 })
    ).toMatchObject({ status: 'interrupted', reason: 'stagnant' });
  });
  test('a skipped future stamp does not reset calibration; a second one does', () => {
    const c = ready();
    expect(c.observe({ ...sample(50), performanceTime: 1060 })).toMatchObject({
      status: 'calibrated',
      reason: 'future-skipped',
    });
    expect(c.observe({ ...sample(51), performanceTime: 1062 }).reason).toBe(
      'future'
    );
    expect(c.observe(sample(10)).status).toBe('calibrating');
    expect(c.observe(sample(9)).reason).toBe('regression');
  });
  test('terminates at the sample cap', () => {
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
  test('recovery re-reads the newest inherited stamp once after the request', () => {
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
      fork!.observe({ ...sample(70), readBegin: 1072, readEnd: 1073 })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    expect(
      fork!.observe({ ...sample(70), readBegin: 1073, readEnd: 1074 }).reason
    ).toBe('duplicate');
    fork!.arm();
  });
  test('a playback pre-read cannot change recovery evidence or its bounds', () => {
    const parent = (takeClosingStamp: boolean) => {
      const c = ready();
      c.arm();
      c.start();
      for (const t of takeClosingStamp ? [50, 60, 70] : [50, 60])
        c.observe(sample(t));
      return c;
    };
    const read = { ...sample(70), readBegin: 1072, readEnd: 1073 };
    const taken = parent(true).forkForRequest(1071, 1071)!;
    const untaken = parent(false).forkForRequest(1071, 1071)!;
    expect(taken.observe(read)).toEqual(untaken.observe(read));
    expect(taken.lastAccepted).toEqual(untaken.lastAccepted);
    expect(taken.state).toBe('calibrated');
    const older = parent(true).forkForRequest(1071, 1071)!;
    expect(
      older.observe({ ...sample(60), readBegin: 1072, readEnd: 1073 }).reason
    ).toBe('regression');
    const early = parent(true).forkForRequest(1071, 1071)!;
    expect(
      early.observe({ ...sample(70), readBegin: 1070, readEnd: 1073 }).reason
    ).toBe('invalid-bracket');
    const stale = parent(true).forkForRequest(1071, 1071)!;
    expect(
      stale.observe({ ...sample(70), readBegin: 1121, readEnd: 1121 }).reason
    ).toBe('stale');
  });
  test('a fork rejects a re-read below the parent held timestamp', () => {
    const c = ready();
    c.arm();
    c.start();
    for (const t of [50, 60, 70]) c.observe(sample(t));
    expect(c.observe({ ...sample(70), contextTime: 0.07015 }).reason).toBe(
      'sub-resolution'
    );
    const fork = c.forkForRequest(1071, 1071)!;
    expect(
      fork.observe({ ...sample(70), readBegin: 1072, readEnd: 1073 }).reason
    ).toBe('regression');
    expect(() => fork.arm()).toThrow();
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
    // At readEnd 1101, 40 is 61 ms old and no longer counts. 56, 73, 89 and
    // the confirming 100 are three advances spanning 44 ms, all within 45 ms.
    expect(fork?.observe(sample(100))).toMatchObject({
      status: 'calibrated',
      reason: 'accepted',
    });
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
  test('recovery calibrates on the confirming read, never below 30 ms', () => {
    const c = ready();
    c.arm();
    c.start();
    for (const t of [50, 59, 66, 73, 79])
      expect(c.observe(sample(t)).status).toBe('playing');
    // 1050 is 51 ms old at 1101: four fresh samples span 20 ms.
    const fork = c.forkForRequest(1101, 1101);
    expect(fork).not.toBeNull();
    expect(fork!.inheritedObservations).toEqual(
      [59, 66, 73, 79].map((t) => sample(t))
    );
    // Advancing and fresh, but 1085 - 1059 = 26 ms.
    expect(
      fork!.observe({ ...sample(85), readBegin: 1101, readEnd: 1102 })
    ).toMatchObject({ status: 'calibrating', reason: 'accepted' });
    expect(() => fork!.arm()).toThrow();
    // 1089 - 1059 = 30 ms completes the window.
    expect(
      fork!.observe({ ...sample(89), readBegin: 1102, readEnd: 1103 })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    fork!.arm();
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

// Recorded-pair guards. Removing the equal-performance condition from the hold
// rule must turn one of these red: a 40 ms performance move with a 150 us
// context move is a real discontinuity, and a 0.1 ms performance move is
// accepted, not held.
describe('recorded pair: hold condition needs equal performance', () => {
  test('150 us context with 40 ms performance interrupts as a discontinuity', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const r = clock.observe(
      read(
        base.contextTime + 0.00015,
        base.performanceTime + 40,
        base.performanceTime + 40.01
      )
    );
    expect(r.reason).toBe('discontinuity');
    expect(r.status).toBe('interrupted');
    expect(clock.lastAccepted).toEqual(base);
  });

  test('150 us context with 0.1 ms performance is accepted, not held', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const next = {
      contextTime: base.contextTime + 0.00015,
      performanceTime: base.performanceTime + 0.1,
    };
    const r = clock.observe(
      read(next.contextTime, next.performanceTime, next.performanceTime + 0.01)
    );
    expect(r.reason).toBe('accepted');
    expect(r.status).toBe('playing');
    expect(clock.lastAccepted).toEqual(next);
  });
});

describe('evidencePair', () => {
  test('a held read resolves to the last accepted pair, not its own stamp', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const heldContext = base.contextTime + 0.000086;
    const held = clock.observe(read(heldContext, base.performanceTime));
    expect(held.reason).toBe('sub-resolution');
    expect(
      evidencePair(clock, held, heldContext, base.performanceTime)
    ).toEqual(base);
  });

  test('an accepted read resolves to its own stamp', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const next = {
      contextTime: base.contextTime + 0.00015,
      performanceTime: base.performanceTime + 0.1,
    };
    const r = clock.observe(
      read(next.contextTime, next.performanceTime, next.performanceTime + 0.01)
    );
    expect(
      evidencePair(clock, r, next.contextTime, next.performanceTime)
    ).toEqual(next);
  });

  test('a duplicate read resolves to its own stamp, which equals the accepted pair', () => {
    const { clock } = replayRecorded();
    const base = clock.lastAccepted!;
    const r = clock.observe(read(base.contextTime, base.performanceTime));
    expect(r.reason).toBe('duplicate');
    expect(
      evidencePair(clock, r, base.contextTime, base.performanceTime)
    ).toEqual(base);
  });

  test('a held result with no accepted pair resolves to null', () => {
    const fresh = new OutputClock(1000);
    const held: ClockResult = {
      status: 'calibrating',
      reason: 'sub-resolution',
      offsetMin: null,
      offsetMax: null,
    };
    expect(evidencePair(fresh, held, 0.01, 1010)).toBeNull();
  });
});

// Recorded CI rows (scheduled-pcm-starvation-recovery-48000.json, run 42989394727):
// the first read of each output stamp before the gate closed at 26895.9, as
// [readEnd, contextAfter, contextTime, performanceTime]. Rows 0-4 calibrate a
// replay clock; rows 5-9 are the five samples the failed fork retained.
const STARVATION: readonly (readonly [number, number, number, number])[] = [
  [26797.20000000001, 26.026666666666667, 25.98426933333333, 26795.70000000001],
  [
    26810.20000000001, 26.034666666666666, 25.994201166666667,
    26805.70000000001,
  ],
  [
    26818.400000000023, 26.045333333333332, 26.004426000000002,
    26815.900000000023,
  ],
  [26826.400000000023, 26.056, 26.014309833333336, 26825.79999999999],
  [
    26842.600000000035, 26.066666666666666, 26.024363666666666,
    26835.70000000001,
  ],
  [
    26847.20000000001, 26.074666666666666, 26.034211499999998,
    26845.70000000001,
  ],
  [
    26858.79999999999, 26.085333333333335, 26.044447333333334,
    26855.900000000023,
  ],
  [26866.79999999999, 26.096, 26.054702166666665, 26866.100000000035],
  [26880.600000000035, 26.106666666666666, 26.064547, 26876],
  [26891.100000000035, 26.11466666666667, 26.07438983333333, 26885.79999999999],
];
const STARVATION_REQUEST = 26896.29999999999; // recovery-request requestClockNow
const STARVATION_OBSERVED = 26897.79999999999; // fork-unavailable observedWall
const STARVATION_CONTEXT = 26.125333333333334; // currentTime then: the closed frame
const replayStarvation = () => {
  const clock = new OutputClock(26790);
  for (const row of STARVATION.slice(0, 5)) clock.observe(recordedRead(row));
  expect(clock.state).toBe('calibrated');
  clock.arm();
  clock.start();
  for (const row of STARVATION.slice(5))
    expect(clock.observe(recordedRead(row)).status).toBe('playing');
  return clock;
};
// The closing callback's stamp. Nothing read it before the fork, so it was never
// recorded; values sit on the recorded cadence between 26885.8 and 26906.2.
const closingRead = () => ({
  readBegin: 26897.900000000023,
  readEnd: 26897.900000000023,
  contextBefore: STARVATION_CONTEXT,
  contextAfter: STARVATION_CONTEXT,
  state: 'running',
  contextTime: 26.0846,
  performanceTime: 26896,
});

describe('recovery fork at the recorded starvation close', () => {
  test('replays the retained evidence of the failed fork exactly', () => {
    const clock = replayStarvation();
    expect(clock.recoveryEvidence(STARVATION_OBSERVED).retained).toEqual([
      {
        time: 26845.70000000001,
        offset: 811.488500000014,
        readEnd: 26847.20000000001,
      },
      {
        time: 26855.900000000023,
        offset: 811.4526666666898,
        readEnd: 26858.79999999999,
      },
      {
        time: 26866.100000000035,
        offset: 811.3978333333689,
        readEnd: 26866.79999999999,
      },
      { time: 26876, offset: 811.4529999999977, readEnd: 26880.600000000035 },
      {
        time: 26885.79999999999,
        offset: 811.4101666666575,
        readEnd: 26891.100000000035,
      },
    ]);
    expect(clock.lastRejection).toBeNull();
  });

  test('a 29.9 ms fresh window forks and the closing read calibrates it', () => {
    for (const now of [STARVATION_REQUEST, STARVATION_OBSERVED]) {
      const fork = replayStarvation().forkForRequest(STARVATION_REQUEST, now);
      expect(fork).not.toBeNull();
      expect(fork!.deadline).toBe(STARVATION_REQUEST + 350);
      // 26845.7 is 50.6 ms old at the request: freshness still excludes it.
      expect(fork!.inheritedObservations.map((o) => o.performanceTime)).toEqual(
        [26855.900000000023, 26866.100000000035, 26876, 26885.79999999999]
      );
      expect(() => fork!.arm()).toThrow();
      // A post-request re-read counts once; the 29.9 ms span is still short.
      expect(
        fork!.observe({
          ...closingRead(),
          contextTime: 26.07438983333333,
          performanceTime: 26885.79999999999,
        })
      ).toMatchObject({ status: 'calibrating', reason: 'accepted' });
      expect(() => fork!.arm()).toThrow();
      // 26896 - 26855.9 = 40.1 ms with four advances.
      expect(fork!.observe(closingRead())).toMatchObject({
        status: 'calibrated',
        reason: 'accepted',
      });
      fork!.arm();
      expect(fork!.lastAccepted).toEqual({
        contextTime: 26.0846,
        performanceTime: 26896,
      });
    }
  });

  test('a late fork inherits only fresh samples and needs minAdvances of them', () => {
    // At 26906, 26855.9 is 50.1 ms old: three fresh samples remain.
    expect(
      replayStarvation()
        .forkForRequest(STARVATION_REQUEST, 26906)
        ?.inheritedObservations.map((o) => o.performanceTime)
    ).toEqual([26866.100000000035, 26876, 26885.79999999999]);
    // At 26916.2, 26866.1 is 50.1 ms old: two remain, too few to fork.
    expect(
      replayStarvation().forkForRequest(STARVATION_REQUEST, 26916.2)
    ).toBeNull();
  });

  test('a commit read after the oldest counted sample ages keeps the calibration', () => {
    const fork = replayStarvation().forkForRequest(
      STARVATION_REQUEST,
      STARVATION_OBSERVED
    )!;
    expect(fork.observe(closingRead()).status).toBe('calibrated');
    // 26906 is 50.1 ms after 26855.9, the oldest sample the closing read counted.
    expect(
      fork.observe({ ...closingRead(), readBegin: 26906, readEnd: 26906 })
    ).toMatchObject({ status: 'calibrated', reason: 'duplicate' });
    // The next callback's stamp, recorded at 26914, read as soon as it exists.
    expect(
      fork.observe({
        readBegin: 26906.5,
        readEnd: 26906.5,
        contextBefore: 26.136,
        contextAfter: 26.136,
        state: 'running',
        contextTime: 26.094806499999997,
        performanceTime: 26906.20000000001,
      })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    fork.arm();
  });
});

// Recovery loop contract: one fork is kept across every read of a recovery.
// Playing samples at 1000 ms offset; the fork at 1101 inherits [59, 66, 73, 79]
// because 1050 is 51 ms old.
const playingClock = () => {
  const c = ready();
  c.arm();
  c.start();
  for (const t of [50, 59, 66, 73, 79]) c.observe(sample(t));
  return c;
};
// A playing clock that started at 40, then accepted each sample(t) in `times`.
const playingAfter = (times: readonly number[]) => {
  const c = ready();
  c.arm();
  c.start();
  for (const t of times) expect(c.observe(sample(t)).status).toBe('playing');
  return c;
};
// A recovery read of sample(time, offset) that begins and ends at `end`.
const readAt = (time: number, end: number, offset = 1000) => ({
  ...sample(time, offset),
  readBegin: end,
  readEnd: end,
});
const inheritedTimes = (fork: OutputClock | null) =>
  fork?.inheritedObservations.map((o) => o.performanceTime) ?? null;
describe('recovery fork kept across reads', () => {
  test('a short advancing read stays in the fork and the playing clock is untouched', () => {
    const clock = playingClock();
    const before = clock.recoveryEvidence(1101);
    const observations = clock.observations.length;
    const fork = clock.forkForRequest(1101, 1101)!;
    expect(fork).not.toBeNull();
    // 1085 - 1059 = 26 ms: advancing, fresh, not yet calibrated.
    expect(
      fork.observe({ ...sample(85), readBegin: 1101, readEnd: 1102 })
    ).toMatchObject({ status: 'calibrating', reason: 'accepted' });
    expect(() => fork.arm()).toThrow();
    // 1089 - 1059 = 30 ms: the same fork calibrates on its next read.
    expect(
      fork.observe({ ...sample(89), readBegin: 1102, readEnd: 1103 })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    fork.arm();
    expect(clock.state).toBe('playing');
    expect(clock.recoveryEvidence(1101)).toEqual(before);
    expect(clock.observations).toHaveLength(observations);
  });

  test('a re-fork after the short read loses it; the kept fork calibrates', () => {
    const clock = playingClock();
    const fork = clock.forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(85), readBegin: 1101, readEnd: 1102 }).status
    ).toBe('calibrating');
    // At 1110, 1059 is 51 ms old: a new fork inherits [66, 73, 79], not read 85.
    const refork = clock.forkForRequest(1101, 1110)!;
    expect(inheritedTimes(refork)).toEqual([1066, 1073, 1079]);
    expect(refork.observe(readAt(89, 1110))).toMatchObject({
      status: 'calibrating',
      reason: 'accepted',
    });
    // The kept fork confirms at readEnd 1109, exactly 50 ms after 1059.
    expect(
      fork.observe({ ...sample(89), readBegin: 1108, readEnd: 1109 })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    fork.arm();
  });

  test('spread is checked across reads, not only against the inherited window', () => {
    const clock = playingClock();
    const fork = clock.forkForRequest(1101, 1101)!;
    // Offset 998 is 2 ms from the window and 24 ms from the window start.
    expect(
      fork.observe({ ...sample(85, 998), readBegin: 1101, readEnd: 1102 })
    ).toMatchObject({ status: 'calibrating', reason: 'accepted' });
    // Offset 1008.5 is 8.5 ms from the window but 10.5 ms from read A.
    expect(
      fork.observe({ ...sample(89, 1008.5), readBegin: 1102, readEnd: 1103 })
        .reason
    ).toBe('discontinuity');
    expect(fork.state).toBe('calibrating');
    expect(() => fork.arm()).toThrow();
    // A fresh fork judges the same read against the window alone and accepts it,
    // which is why the recovery loop must keep one fork.
    const refork = clock.forkForRequest(1101, 1102)!;
    expect(
      refork.observe({ ...sample(89, 1008.5), readBegin: 1102, readEnd: 1103 })
        .reason
    ).toBe('accepted');
  });

  test('a read that begins before the request cannot count toward recovery', () => {
    const clock = playingClock();
    const fork = clock.forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(85), readBegin: 1100, readEnd: 1102 }).reason
    ).toBe('invalid-bracket');
    expect(fork.state).toBe('calibrating');
    expect(() => fork.arm()).toThrow();
    // The rejection reset the candidate, so one later read cannot calibrate it.
    expect(
      fork.observe({ ...sample(89), readBegin: 1102, readEnd: 1103 }).status
    ).toBe('calibrating');
    expect(() => fork.arm()).toThrow();
  });
});

// Fork at 1101 inherits [59, 66, 73, 79]. An accepted read counts only samples
// at most 50 ms older than its readEnd, so 1059 counts through readEnd 1109.
describe('recovery counts only samples fresh at each read', () => {
  test('a confirming read completing exactly 50 ms after the oldest inherited stamp is accepted', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(89), readBegin: 1109, readEnd: 1109 })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    fork.arm();
  });

  test('a sample 50 ms plus epsilon old stops counting; the fork lives on fresh samples', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    // 1059 is 50.001 ms old: [66, 73, 79, 89] spans 23 ms.
    expect(
      fork.observe({ ...sample(89), readBegin: 1109, readEnd: 1109.001 })
    ).toMatchObject({ status: 'calibrating', reason: 'accepted' });
    expect(() => fork.arm()).toThrow();
    // [66, 73, 79, 89, 96] spans 30 ms, all within 44 ms of 1110.
    expect(fork.observe(readAt(96, 1110))).toMatchObject({
      status: 'calibrated',
      reason: 'accepted',
    });
    fork.arm();
  });

  test('freshness is judged at readEnd: a read ending past 50 ms drops the sample', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(89), readBegin: 1108, readEnd: 1109.5 })
    ).toMatchObject({ status: 'calibrating', reason: 'accepted' });
    expect(() => fork.arm()).toThrow();
  });

  test('advances count only fresh samples', () => {
    const fork = playingAfter([45, 60, 75]).forkForRequest(1076, 1076)!;
    expect(inheritedTimes(fork)).toEqual([1040, 1045, 1060, 1075]);
    // At readEnd 1101, 1040 and 1045 are stale: [60, 75, 100] is two advances,
    // though it spans 40 ms and five samples were inherited or read.
    expect(fork.observe(sample(100))).toMatchObject({
      status: 'calibrating',
      reason: 'accepted',
    });
    expect(() => fork.arm()).toThrow();
  });

  test('calibration fixes the window: a later pre-arm read never demotes it', () => {
    const fork = playingAfter([56, 73, 89]).forkForRequest(1090, 1090)!;
    expect(fork.observe(sample(100)).status).toBe('calibrated');
    // 56 and 73 are past 50 ms at 1124. The read is judged on its own.
    expect(fork.observe(readAt(120, 1124))).toMatchObject({
      status: 'calibrated',
      reason: 'accepted',
    });
    fork.arm();
  });

  test('a discontinuity reset drops every inherited sample', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(85, 1011), readBegin: 1101, readEnd: 1102 })
        .reason
    ).toBe('discontinuity');
    // New reads rebuild the window alone: 90 to 101 spans 11 ms.
    for (const [t, end] of [
      [90, 1103],
      [95, 1104],
      [100, 1105],
      [101, 1106],
    ] as const)
      expect(fork.observe(readAt(t, end))).toMatchObject({
        status: 'calibrating',
        reason: 'accepted',
      });
    expect(() => fork.arm()).toThrow();
  });

  test('a stamp between a dropped sample and the last accepted one is a regression', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    // At 1117, 1059 and 1066 no longer count; 1070 is fresh but older than 1079.
    expect(fork.observe(readAt(70, 1117)).reason).toBe('regression');
    expect(fork.observe(readAt(89, 1118)).status).toBe('calibrating');
    expect(() => fork.arm()).toThrow();
  });

  test('two reads inside the budget calibrate, the second completing at the edge', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(85), readBegin: 1101, readEnd: 1102 }).status
    ).toBe('calibrating');
    expect(
      fork.observe({ ...sample(89), readBegin: 1108, readEnd: 1109 })
    ).toMatchObject({ status: 'calibrated', reason: 'accepted' });
    fork.arm();
  });

  test('an offset discontinuity across two in-budget reads is a discontinuity, not staleness', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(85, 998), readBegin: 1101, readEnd: 1102 })
        .status
    ).toBe('calibrating');
    expect(
      fork.observe({ ...sample(89, 1008.5), readBegin: 1108, readEnd: 1109 })
        .reason
    ).toBe('discontinuity');
    expect(() => fork.arm()).toThrow();
  });

  test('the budget ends at calibration: a started fork is not rejected by its inherited stamps', () => {
    const fork = playingClock().forkForRequest(1101, 1101)!;
    expect(
      fork.observe({ ...sample(89), readBegin: 1109, readEnd: 1109 }).status
    ).toBe('calibrated');
    fork.arm();
    fork.start();
    expect(
      fork.observe({ ...sample(200), readBegin: 1210, readEnd: 1210 }).status
    ).toBe('playing');
  });
});

// The closing stamp is the only post-request read before the next callback
// passes the 20 ms gap (448 frames past the guard at 48 kHz, 370 at 44.1 kHz).
describe('recovery at real callback and observation cadences', () => {
  test('60 Hz stamps never calibrate: four of them span 50 ms', () => {
    // Forking after the closing callback leaves two fresh samples.
    expect(
      playingAfter([56.7, 73.4, 90.1]).forkForRequest(1107, 1107)
    ).toBeNull();
    // Even forking right after 90.1, the closing read drops 56.7 (51.1 ms old).
    const fork = playingAfter([56.7, 73.4, 90.1]).forkForRequest(
      1091.1,
      1091.1
    )!;
    expect(inheritedTimes(fork)).toEqual([1056.7, 1073.4, 1090.1]);
    expect(fork.observe(sample(106.8))).toMatchObject({
      status: 'calibrating',
      reason: 'accepted',
    });
    expect(fork.observe(sample(123.5))).toMatchObject({
      status: 'calibrating',
      reason: 'accepted',
    });
    expect(() => fork.arm()).toThrow();
  });

  test('50 Hz stamps never calibrate: four of them span 60 ms', () => {
    expect(playingAfter([60, 80]).forkForRequest(1100.3, 1100.3)).toBeNull();
    const fork = playingAfter([60, 80]).forkForRequest(1081, 1081)!;
    expect(inheritedTimes(fork)).toEqual([1040, 1060, 1080]);
    expect(fork.observe(sample(100))).toMatchObject({
      status: 'calibrating',
      reason: 'accepted',
    });
    expect(() => fork.arm()).toThrow();
  });

  test('one dropped 10 ms stamp still recovers at the closing read', () => {
    const fork = playingAfter([
      50, 60, 70, 80, 90, 100, 110, 130,
    ]).forkForRequest(1140.3, 1140.3)!;
    expect(inheritedTimes(fork)).toEqual([1100, 1110, 1130]);
    expect(fork.observe(readAt(140, 1141.9))).toMatchObject({
      status: 'calibrated',
      reason: 'accepted',
    });
    fork.arm();
  });

  test('two dropped 10 ms stamps cannot fork', () => {
    expect(
      playingAfter([50, 60, 70, 80, 90, 100, 130]).forkForRequest(
        1140.3,
        1140.3
      )
    ).toBeNull();
  });

  test('frame-tick sampling of 10 ms stamps recovers when the close follows the last read stamp', () => {
    const fork = playingAfter([60, 80, 90]).forkForRequest(1100.3, 1100.3)!;
    expect(inheritedTimes(fork)).toEqual([1060, 1080, 1090]);
    expect(fork.observe(readAt(100, 1101.9))).toMatchObject({
      status: 'calibrated',
      reason: 'accepted',
    });
    fork.arm();
  });

  test('frame-tick sampling that skipped the stamp before the close cannot fork', () => {
    expect(
      playingAfter([50, 70, 90]).forkForRequest(1110.3, 1110.3)
    ).toBeNull();
  });

  test('44.1 kHz 512-frame stamps: a commit read 1.8 ms after the confirming read keeps the calibration', () => {
    const fork = playingAfter([51.6, 63.2, 74.8, 86.4]).forkForRequest(
      1098.3,
      1098.3
    )!;
    expect(inheritedTimes(fork)).toEqual([1051.6, 1063.2, 1074.8, 1086.4]);
    expect(fork.observe(readAt(98, 1099.9))).toMatchObject({
      status: 'calibrated',
      reason: 'accepted',
    });
    // 1051.6 is 50.1 ms old at 1101.7; calibration already happened at 1099.9.
    expect(fork.observe(readAt(98, 1101.7))).toMatchObject({
      status: 'calibrated',
      reason: 'duplicate',
    });
    fork.arm();
  });
});
