/**
 * Trace and frame arithmetic for the primer proof. Pure: no browser and no I/O, so every gate
 * is unit-tested in otio-program-checks.test.ts.
 *
 * Clocks: trace timestamps are microseconds on Chrome's trace clock. Frame times are page
 * milliseconds from performance.now(). Each trusted pointerdown writes a performance.mark, which
 * appears in the trace under blink.user_timing with the same name. That mark is the only bridge
 * between the two clocks, and an absent mark is a failure, never a zero.
 */

export interface TraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ts: number;
}

export const PREPARE_MARK = 'relic-prepare-pointerdown';
export const PLAY_MARK = 'relic-play-pointerdown';
export const UNMUTE_MARK = 'relic-unmute-pointerdown';
export const PRIMER_TRACE_CATEGORIES = 'audio,media,blink.user_timing';

/** A stream start appears under any of these names. Counted per name, reported per name. */
export const STREAM_START_EVENTS = [
  'AudioOutputDevice::Start',
  'CreateStream',
  'OutputController::Play',
] as const;
/** Renders the first buffer. Its count is the number of streams created. */
export const FIRST_BUFFER_EVENT = 'OutputController::Play';
/** Device-side callback: the real output clock. Not an AudioContext tap. */
export const DEVICE_CALLBACK_EVENT = 'AUHALStream::Render';

/** Bounds from the user's acceptance. None of these may be loosened to pass a trial. */
export const WINDOW_MS = 4000;
export const COLD_START_MS = 100;
export const WARM_START_MS = 60;
export const FIRST_FRAME_BUDGET_MS = 350;
export const GAP_BUDGET_MS = 100;
export const P95_BUDGET_MS = 50;
export const FIRST_CLICK_CALLBACK_SLACK_MS = 50;
export const MIN_DEVICE_CALLBACKS = 10;
/** 24 fps over the 4 s window gives 95 intervals. Fewer means the video did not play. */
export const MIN_WINDOW_INTERVALS = 90;

export type StartClass = 'cold' | 'warm' | 'ambiguous' | 'absent';

/** Trace time of the first mark with this name, or null when the trace has none. */
export function markTs(
  events: readonly TraceEvent[],
  name: string
): number | null {
  const mark = events.find(
    (event) => event.name === name && event.cat.includes('blink.user_timing')
  );
  return mark ? mark.ts : null;
}

function timesNamed(
  events: readonly TraceEvent[],
  name: string,
  fromTs: number,
  toTs: number
): number[] {
  return events
    .filter((e) => e.name === name && e.ts >= fromTs && e.ts <= toTs)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
}

export function streamStartCounts(
  events: readonly TraceEvent[],
  fromTs: number,
  toTs = Number.POSITIVE_INFINITY
): Record<string, number> {
  return Object.fromEntries(
    STREAM_START_EVENTS.map((name) => [
      name,
      timesNamed(events, name, fromTs, toTs).length,
    ])
  );
}

/**
 * Stream starts in the window. Chrome names one start in several events, so the honest count is
 * the largest per-name count, not their sum.
 */
export function streamStarts(
  events: readonly TraceEvent[],
  fromTs: number,
  toTs = Number.POSITIVE_INFINITY
): number {
  return Math.max(...Object.values(streamStartCounts(events, fromTs, toTs)));
}

export interface FirstStart {
  readonly playTs: number;
  readonly callbackTs: number | null;
  /** D: first buffer render to first device callback. */
  readonly dMs: number | null;
}

/** The first stream created at or after fromTs, with its D. Null when none was created. */
export function firstStart(
  events: readonly TraceEvent[],
  fromTs: number
): FirstStart | null {
  const playTs = timesNamed(
    events,
    FIRST_BUFFER_EVENT,
    fromTs,
    Number.POSITIVE_INFINITY
  )[0];
  if (playTs === undefined) return null;
  const callbackTs =
    timesNamed(
      events,
      DEVICE_CALLBACK_EVENT,
      playTs,
      Number.POSITIVE_INFINITY
    )[0] ?? null;
  return {
    playTs,
    callbackTs,
    dMs: callbackTs === null ? null : (callbackTs - playTs) / 1000,
  };
}

export function classifyStart(dMs: number | null): StartClass {
  if (dMs === null) return 'absent';
  if (dMs >= COLD_START_MS) return 'cold';
  if (dMs <= WARM_START_MS) return 'warm';
  return 'ambiguous';
}

export function deviceCallbacks(
  events: readonly TraceEvent[],
  fromTs: number,
  toTs: number
): number[] {
  return timesNamed(events, DEVICE_CALLBACK_EVENT, fromTs, toTs);
}

/**
 * Telemetry only. Device callback spacing shows when Chrome's output thread ran. It is not audio
 * signal and never proves an audio gap. Null when there are too few callbacks to report.
 */
export function deviceExcessMs(callbackTs: readonly number[]): number | null {
  if (callbackTs.length < MIN_DEVICE_CALLBACKS) return null;
  const gaps = intervals(callbackTs.map((t) => t / 1000));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return Math.max(...gaps) - median;
}

/** Consecutive differences. Input order is preserved. */
export function intervals(times: readonly number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!);
}

export function framesAfter(
  frameTimesMs: readonly number[],
  pointerMs: number
): number[] {
  return frameTimesMs.filter((t) => t >= pointerMs);
}

/** Nearest-rank style, matching the existing steady-playback gate: sorted[floor(n * 0.95)]. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? null;
}

export function maxOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

/** True when some presented-frame gap exceeds the gap budget. Used to judge the cold controls. */
export function stalls(gapsMs: readonly number[]): boolean {
  return (maxOf(gapsMs) ?? 0) > GAP_BUDGET_MS;
}

/** Frame cadence gates for a window: no gap over 100 ms and p95 within 50 ms. */
export function gateGaps(
  gapsMs: readonly number[],
  minIntervals: number,
  label: string
): string[] {
  const failures: string[] = [];
  if (gapsMs.length < minIntervals)
    failures.push(
      `${label}: only ${gapsMs.length + 1} presented frames, need ${minIntervals + 1}`
    );
  const max = maxOf(gapsMs);
  const tail = p95(gapsMs);
  if (max !== null && max > GAP_BUDGET_MS)
    failures.push(
      `${label}: max gap ${max.toFixed(1)} ms > ${GAP_BUDGET_MS} ms`
    );
  if (tail !== null && tail > P95_BUDGET_MS)
    failures.push(
      `${label}: p95 gap ${tail.toFixed(1)} ms > ${P95_BUDGET_MS} ms`
    );
  return failures;
}

export interface PrimerWindow {
  /** First presented frame minus the trusted pointerdown, page clock. */
  readonly startupMs: number | null;
  /** Consecutive presented-frame gaps inside the window. */
  readonly gapsMs: readonly number[];
  readonly bufferingBeforeFirstFrame: boolean | null;
  readonly streamStarts: number;
  readonly expectedStreamStarts: number;
  /** First device callback minus the trusted pointerdown, trace clock. */
  readonly firstCallbackMs: number | null;
  readonly deviceExcessMs: number | null;
  readonly deviceCallbacks: number;
  /** Only the first-click arm: Buffering, and the first frame not later than the device + slack. */
  readonly firstClick: boolean;
}

/**
 * Video and start budgets for an arm that must not stall. Audio is never judged here: callback
 * spacing is telemetry only, and the audio budget is proven by otio-program-audio-signal.ts.
 */
export function gatePrimerWindow(w: PrimerWindow): string[] {
  const failures: string[] = [];
  if (w.startupMs === null)
    failures.push('no presented frame after the trusted Play');
  else if (w.startupMs > FIRST_FRAME_BUDGET_MS)
    failures.push(
      `first frame ${w.startupMs.toFixed(1)} ms > ${FIRST_FRAME_BUDGET_MS} ms`
    );
  failures.push(...gateGaps(w.gapsMs, MIN_WINDOW_INTERVALS, 'window'));
  if (w.streamStarts !== w.expectedStreamStarts)
    failures.push(
      `${w.streamStarts} stream start(s) after Play, expected ${w.expectedStreamStarts}`
    );
  if (w.firstClick) {
    if (w.bufferingBeforeFirstFrame !== true)
      failures.push('Buffering was not shown before the first frame');
    if (w.firstCallbackMs === null)
      failures.push('no device callback after the trusted Play');
    else if (
      w.startupMs !== null &&
      w.startupMs > w.firstCallbackMs + FIRST_CLICK_CALLBACK_SLACK_MS
    )
      failures.push(
        `first frame ${w.startupMs.toFixed(1)} ms is later than the first device callback ${w.firstCallbackMs.toFixed(1)} ms + ${FIRST_CLICK_CALLBACK_SLACK_MS} ms`
      );
  }
  return failures;
}
