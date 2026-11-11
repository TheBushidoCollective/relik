import { describe, expect, test } from 'bun:test';
import {
  CALIBRATION_FINE_CADENCE_MS,
  CALIBRATION_FINE_READ_LIMIT,
  CALIBRATION_COARSE_CADENCE_MS,
  CALIBRATION_READ_LIMIT,
  CalibrationReadBudget,
  calibrationCadenceMs,
  isUsableOutputStamp,
  observationProvesOutput,
} from '../src/otio-clock-calibration.ts';

describe('calibration read budget', () => {
  test('admits exactly the read limit, then refuses every further read', () => {
    const budget = new CalibrationReadBudget();
    for (let i = 0; i < CALIBRATION_READ_LIMIT; i++)
      expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.take()).toBe(false);
    expect(budget.used).toBe(CALIBRATION_READ_LIMIT);
  });

  test('the limit is 64 reads', () => {
    expect(CALIBRATION_READ_LIMIT).toBe(64);
  });
});

describe('calibration cadence', () => {
  test('a usable stamp reads at the fine cadence until its reads are spent', () => {
    expect(calibrationCadenceMs({ usableStamp: true, fineReads: 0 })).toBe(
      CALIBRATION_FINE_CADENCE_MS
    );
    expect(
      calibrationCadenceMs({
        usableStamp: true,
        fineReads: CALIBRATION_FINE_READ_LIMIT - 1,
      })
    ).toBe(CALIBRATION_FINE_CADENCE_MS);
  });

  test('a usable stamp falls back to the coarse cadence once its fine reads are spent', () => {
    expect(
      calibrationCadenceMs({
        usableStamp: true,
        fineReads: CALIBRATION_FINE_READ_LIMIT,
      })
    ).toBe(CALIBRATION_COARSE_CADENCE_MS);
  });

  test('an unusable stamp always reads at the coarse cadence', () => {
    expect(calibrationCadenceMs({ usableStamp: false, fineReads: 0 })).toBe(
      CALIBRATION_COARSE_CADENCE_MS
    );
  });

  test('a frozen device with an unusable stamp stays under the read limit to the deadline', () => {
    // The reader starts at play, with a 350 ms deadline and no usable stamp.
    let t = 0;
    let reads = 0;
    const budget = new CalibrationReadBudget();
    while (t <= 350 && budget.take()) {
      reads++;
      t += calibrationCadenceMs({ usableStamp: false, fineReads: 0 });
    }
    expect(reads).toBeLessThanOrEqual(CALIBRATION_READ_LIMIT);
    expect(reads).toBeGreaterThan(0);
  });

  test('a device whose stamp becomes usable at 200 ms stays under the read limit to the deadline', () => {
    // Before the usable stamp, the coarse cadence applies. After it, at most 16
    // reads run fine. The worst case is the sum of both, not one cadence.
    let t = 0;
    let fineReads = 0;
    let reads = 0;
    const budget = new CalibrationReadBudget();
    while (t <= 350 && budget.take()) {
      reads++;
      const usable = t >= 200;
      const cadence = calibrationCadenceMs({ usableStamp: usable, fineReads });
      t += cadence;
      if (cadence === CALIBRATION_FINE_CADENCE_MS) fineReads++;
    }
    expect(reads).toBeLessThanOrEqual(CALIBRATION_READ_LIMIT);
    expect(fineReads).toBeLessThanOrEqual(CALIBRATION_FINE_READ_LIMIT);
  });
});

describe('usable output stamps', () => {
  test('a stamp with no times is not usable', () => {
    expect(isUsableOutputStamp(null)).toBe(false);
    expect(isUsableOutputStamp({})).toBe(false);
  });

  test('a stamp read before the device started (zero context time) is not usable', () => {
    expect(isUsableOutputStamp({ contextTime: 0, performanceTime: 500 })).toBe(
      false
    );
  });

  test('a stamp with zero performance time is not usable', () => {
    expect(isUsableOutputStamp({ contextTime: 0.1, performanceTime: 0 })).toBe(
      false
    );
  });

  test('a stamp with non-finite times is not usable', () => {
    expect(
      isUsableOutputStamp({ contextTime: Number.NaN, performanceTime: 500 })
    ).toBe(false);
    expect(
      isUsableOutputStamp({ contextTime: 0.1, performanceTime: Infinity })
    ).toBe(false);
  });

  test('a stamp with positive finite times is usable', () => {
    expect(
      isUsableOutputStamp({ contextTime: 0.1, performanceTime: 500 })
    ).toBe(true);
  });
});

describe('ring sizing waits only for an accepted observation', () => {
  test('an accepted observation proves output', () => {
    expect(observationProvesOutput('accepted')).toBe(true);
  });

  test('every rejection reason fails to prove output, so sizing never uses a rejected stamp', () => {
    for (const reason of [
      'unusable-zero',
      'context-not-running',
      'stale',
      'future',
      'regression',
      'duplicate',
      'partial-advance',
      'deadline',
      'terminal',
      'nonfinite-or-missing',
      'invalid-bracket',
      'discontinuity',
      'stagnant',
    ]) {
      expect(observationProvesOutput(reason)).toBe(false);
    }
  });
});
