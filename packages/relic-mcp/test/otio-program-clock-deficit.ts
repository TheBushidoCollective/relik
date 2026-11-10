/**
 * Element-clock deficit: for each consecutive presented frame, the wall time between frames minus
 * how far the media element's own clock advanced. Recreated from summarizeNativeStartup in the
 * deleted otio-program-native-controls.ts; the field names and arithmetic are unchanged.
 *
 * A large deficit with a frozen element clock is a stall of the media clock. A large wall gap with
 * the element clock advancing normally is presentation delay. This is diagnostic, never a gate:
 * the gates are in otio-program-trace.ts and otio-program-audio-signal.ts.
 */

export interface ClockFrame {
  readonly now: number;
  readonly mediaTime: number;
  readonly currentTime: number;
}

export interface ClockStep {
  readonly frame: number;
  readonly from: number;
  readonly to: number;
  readonly wallGapMs: number;
  readonly clockAdvanceMs: number;
  readonly clockDeficitMs: number;
  readonly elementTimeStart: number;
  readonly elementTimeEnd: number;
  readonly mediaTimeStart: number;
  readonly mediaTimeEnd: number;
  /** The element clock advanced less than half the wall gap: the media clock stalled. */
  readonly elementClockStalled: boolean;
}

export interface ClockDeficitSummary {
  readonly frameCount: number;
  readonly p95GapMs: number | null;
  readonly intervalsOver100Ms: number;
  readonly worstGap: ClockStep | null;
  readonly worstDeficit: ClockStep | null;
  readonly elementClockStalls: number;
  readonly gapsOver100Ms: readonly ClockStep[];
}

/** One step per consecutive pair. Element time is compared with the wall clock, not with media time. */
export function clockSteps(frames: readonly ClockFrame[]): ClockStep[] {
  return frames.slice(1).map((frame, index) => {
    const previous = frames[index]!;
    const wallGapMs = frame.now - previous.now;
    const clockAdvanceMs = (frame.currentTime - previous.currentTime) * 1000;
    return {
      frame: index + 1,
      from: previous.now,
      to: frame.now,
      wallGapMs,
      clockAdvanceMs,
      clockDeficitMs: wallGapMs - clockAdvanceMs,
      elementTimeStart: previous.currentTime,
      elementTimeEnd: frame.currentTime,
      mediaTimeStart: previous.mediaTime,
      mediaTimeEnd: frame.mediaTime,
      elementClockStalled: clockAdvanceMs < wallGapMs / 2,
    };
  });
}

function worst(
  steps: readonly ClockStep[],
  value: (step: ClockStep) => number
): ClockStep | null {
  return steps.reduce<ClockStep | null>(
    (best, step) => (!best || value(step) > value(best) ? step : best),
    null
  );
}

export function clockDeficitSummary(
  frames: readonly ClockFrame[]
): ClockDeficitSummary {
  const steps = clockSteps(frames);
  const sorted = steps.map((step) => step.wallGapMs).sort((a, b) => a - b);
  return {
    frameCount: frames.length,
    p95GapMs: sorted.length ? sorted[Math.floor(sorted.length * 0.95)]! : null,
    intervalsOver100Ms: steps.filter((step) => step.wallGapMs > 100).length,
    worstGap: worst(steps, (step) => step.wallGapMs),
    worstDeficit: worst(steps, (step) => step.clockDeficitMs),
    elementClockStalls: steps.filter((step) => step.elementClockStalled).length,
    gapsOver100Ms: steps.filter((step) => step.wallGapMs > 100),
  };
}
