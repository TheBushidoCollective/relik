import { describe, expect, test } from 'bun:test';
import {
  type ClockFrame,
  clockDeficitSummary,
} from './otio-program-clock-deficit.ts';

/** Frames at 24 fps: the element clock advances with the wall clock, one frame per 41.67 ms. */
function steadyFrames(count: number): ClockFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    now: i * 41.67,
    mediaTime: i / 24,
    currentTime: i / 24,
  }));
}

describe('element-clock deficit diagnostic', () => {
  test('steady playback has no deficit and no element-clock stall', () => {
    const summary = clockDeficitSummary(steadyFrames(96));
    expect(summary.elementClockStalls).toBe(0);
    expect(summary.worstDeficit?.clockDeficitMs ?? 0).toBeLessThan(0.01);
    expect(summary.intervalsOver100Ms).toBe(0);
  });

  test('a frozen element clock across a long wall gap is an element-clock stall', () => {
    const base = steadyFrames(5);
    const frozenTime = base[4]!.currentTime;
    const frames: ClockFrame[] = [
      ...base,
      // The next presented frame arrives 292 ms later while the element clock does not move.
      { now: base[4]!.now + 292, mediaTime: 5 / 24, currentTime: frozenTime },
    ];
    const summary = clockDeficitSummary(frames);
    expect(summary.elementClockStalls).toBe(1);
    expect(summary.worstDeficit?.clockDeficitMs ?? 0).toBeGreaterThan(290);
  });

  test('a long wall gap with the element clock advancing is presentation delay, not a stall', () => {
    const frames: ClockFrame[] = [
      { now: 0, mediaTime: 0, currentTime: 0 },
      { now: 120, mediaTime: 0.12, currentTime: 0.12 },
      { now: 160, mediaTime: 0.16, currentTime: 0.16 },
    ];
    const summary = clockDeficitSummary(frames);
    expect(summary.elementClockStalls).toBe(0);
    expect(summary.worstGap?.wallGapMs).toBe(120);
    expect(summary.worstDeficit?.clockDeficitMs ?? 0).toBeLessThan(0.01);
  });

  test('a single frame reports no gap statistics', () => {
    const summary = clockDeficitSummary(steadyFrames(1));
    expect(summary.p95GapMs).toBeNull();
    expect(summary.worstGap).toBeNull();
  });
});
