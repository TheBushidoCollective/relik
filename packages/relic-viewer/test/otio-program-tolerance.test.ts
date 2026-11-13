import { describe, expect, test } from 'bun:test';
import {
  durationToleranceSeconds,
  frameRateAllowed,
} from '../src/otio-program.ts';

const fps = (num: number, den = 1) => ({ num, den });

describe('duration tolerance', () => {
  test('ordinary rates keep the 0.1 s floor', () => {
    expect(durationToleranceSeconds(fps(24))).toBe(0.1);
    expect(durationToleranceSeconds(fps(240))).toBe(0.1);
    expect(durationToleranceSeconds(fps(24000, 1001))).toBe(0.1);
  });

  test('a one-frame-per-second rate widens to the frame duration', () => {
    expect(durationToleranceSeconds(fps(1))).toBe(1);
  });

  test('a hostile slow rate cannot widen the check past one second', () => {
    expect(durationToleranceSeconds(fps(1, 1_000_000))).toBe(1);
    expect(durationToleranceSeconds(fps(1, 1_000_000_000))).toBe(1);
    expect(durationToleranceSeconds(fps(1, 999_999))).toBe(1);
  });

  test('a hostile fast rate keeps the floor', () => {
    expect(durationToleranceSeconds(fps(1_000_000))).toBe(0.1);
    expect(durationToleranceSeconds(fps(1_000_000, 1))).toBe(0.1);
  });

  test('a non-finite frame duration falls back to the floor, never a wider check', () => {
    expect(durationToleranceSeconds(fps(0, 1))).toBe(0.1);
  });

  test('no allowed rate yields a tolerance outside [0.1 s, 1 s]', () => {
    for (const rate of [
      fps(1),
      fps(2),
      fps(24),
      fps(240),
      fps(1, 2),
      fps(1, 1000),
    ]) {
      const tolerance = durationToleranceSeconds(rate);
      expect(tolerance).toBeGreaterThanOrEqual(0.1);
      expect(tolerance).toBeLessThanOrEqual(1);
    }
  });
});

describe('frame rate guard', () => {
  test('accepts rates from 1 fps up to the format cap of 240 fps', () => {
    expect(frameRateAllowed(fps(1))).toBe(true);
    expect(frameRateAllowed(fps(24))).toBe(true);
    expect(frameRateAllowed(fps(240))).toBe(true);
    expect(frameRateAllowed(fps(24000, 1001))).toBe(true);
  });

  test('rejects hostile slow rates the format would otherwise accept', () => {
    expect(frameRateAllowed(fps(1, 1_000_000))).toBe(false);
    expect(frameRateAllowed(fps(1, 2))).toBe(false);
  });

  test('rejects rates above 240 fps and zero or non-finite rates', () => {
    expect(frameRateAllowed(fps(241))).toBe(false);
    expect(frameRateAllowed(fps(0))).toBe(false);
    expect(frameRateAllowed(fps(1, 0))).toBe(false);
  });
});
