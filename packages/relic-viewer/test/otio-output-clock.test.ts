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
