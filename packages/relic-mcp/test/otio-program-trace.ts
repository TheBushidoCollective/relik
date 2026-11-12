/**
 * Trace and frame arithmetic for the primer proof. Pure: no browser and no I/O, so every gate
 * is unit-tested in otio-program-checks.test.ts.
 *
 * Clocks: trace timestamps are microseconds on Chrome's trace clock. Frame times are page
 * milliseconds from performance.now(). Each trusted pointerdown writes a performance.mark, which
 * appears in the trace under blink.user_timing with the same name. That mark is the only bridge
 * between the two clocks, and an absent mark is a failure, never a zero.
 *
 * Cold means the first trusted event found an idle output. The trace must cover QUIET_WINDOW_MS
 * before that event with no device activity inside the window, the OS must read the default
 * output idle at the event (otio-program-device-state.ts), and a device start must follow. A
 * device start is OutputController::Play. Stream creation is telemetry only: Chrome names one
 * creation in more than one event, so creation counts never gate.
 *
 * Resumed is a start the classifier does not count as cold. Chrome idle-suspends a paused program,
 * and a Play after that suspend rebuilds the program's pipeline (RendererImpl::Initialize) at the
 * trusted event. That start shows no stall the cold control could test, so it is labelled resumed.
 *
 * Mark order: a page or device reaction that lands before its trusted mark makes the mark late, so
 * the trace cannot attribute that reaction to the gesture. markOrderFailures fails such a trial.
 * The one exception is pausedSeekCompletion: Chrome re-applying a zero rate as its pipeline
 * finishes a start, seek or resume is not a reaction. Every other rate change and device Play counts.
 *
 * The first new frame is the first presented frame whose media time is one program frame past
 * the frame shown at the trusted Play. A frame that repeats one already shown is not new, so a
 * freeze appears as a gap between kept frames and never as a late start.
 */

export interface TraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ts: number;
  /** Present on real traces. A synthetic event without them never gets the paused-start exemption. */
  readonly pid?: number;
  readonly tid?: number;
  readonly args?: Readonly<Record<string, unknown>>;
}

export const PREPARE_MARK = 'relic-prepare-pointerdown';
export const PLAY_MARK = 'relic-play-pointerdown';
export const UNMUTE_MARK = 'relic-unmute-pointerdown';
/** Written after Tracing.start and before any trusted event. The quiet window is measured from it. */
export const TRACE_START_MARK = 'relic-trace-start';
export const PRIMER_TRACE_CATEGORIES = 'audio,media,blink.user_timing';

/** A device start: the output begins rendering. Counted, gated, and the only start that is cold. */
export const DEVICE_START_EVENT = 'OutputController::Play';
/** Stream creation. Telemetry only, reported per name in the receipts. */
export const STREAM_CREATION_EVENTS: readonly string[] = [
  'AudioOutputDevice::Start',
  'CreateStream',
];
/** Device-side callback: the real output clock. Not an AudioContext tap. */
export const DEVICE_CALLBACK_EVENT = 'AUHALStream::Render';
/** Any of these inside the quiet window means the output was already active at the trusted event. */
export const QUIET_WINDOW_EVENTS: readonly string[] = [
  ...STREAM_CREATION_EVENTS,
  DEVICE_START_EVENT,
  DEVICE_CALLBACK_EVENT,
];

/** The program's pipeline is created again: a resumed start, which the cold classifier never counts as cold. */
export const PIPELINE_INIT_EVENT = 'RendererImpl::Initialize';
/**
 * Page or device reactions that must not land just before their trusted mark. A zero rate is the
 * one exception, and only pausedSeekCompletion admits it.
 */
const RATE_EVENT = 'RendererImpl::SetPlaybackRate';
/** The renderer event CompleteSeek calls before it re-applies the playback rate. */
const SEEK_COMPLETION_EVENT = 'RendererImpl::StartPlayingFrom';
export const MARK_ORDER_EVENTS: readonly string[] = [
  RATE_EVENT,
  'AudioOutputDevice::Play',
  DEVICE_START_EVENT,
];
/** A reaction this close before its mark is a reordering. Wider windows would flag legitimate preroll. */
export const MARK_ORDER_WINDOW_US = 5_000;
/** How far after the trusted event the pipeline rebuild of a resumed Play is looked for. */
export const RESUME_WINDOW_US = 1_000_000;
const OUTPUT_PAUSE_EVENT = 'OutputController::Pause';
/** Chrome events that show its own device in use. They only bound the telemetry in externalRunningMs. */
const CHROME_DEVICE_EVENTS: readonly string[] = [
  ...QUIET_WINDOW_EVENTS,
  'AudioOutputDevice::Play',
  'OnMoreData',
];

/** Bounds from the user's acceptance. None of these may be loosened to pass a trial. */
export const QUIET_WINDOW_MS = 500;
export const WINDOW_MS = 4000;
export const FIRST_FRAME_BUDGET_MS = 350;
export const GAP_BUDGET_MS = 100;
export const P95_BUDGET_MS = 50;
export const MIN_DEVICE_CALLBACKS = 10;
/**
 * The program runs at 30 fps (otio-program-reference.ts), so 4 s of it gives about 119 intervals.
 * Fewer than 90 means the video did not play.
 */
export const MIN_WINDOW_INTERVALS = 90;

/** Media times are in seconds, so one program frame at 30 fps and float noise are both below this. */
const MEDIA_EPSILON_S = 1e-6;

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

/** Device starts (OutputController::Play) in the window. Stream creation is never counted here. */
export function deviceStarts(
  events: readonly TraceEvent[],
  fromTs: number,
  toTs = Number.POSITIVE_INFINITY
): number {
  return timesNamed(events, DEVICE_START_EVENT, fromTs, toTs).length;
}

/** Stream-creation events in the window, per name. Telemetry for the receipts only. */
export function creationCounts(
  events: readonly TraceEvent[],
  fromTs: number,
  toTs = Number.POSITIVE_INFINITY
): Record<string, number> {
  return Object.fromEntries(
    STREAM_CREATION_EVENTS.map((name) => [
      name,
      timesNamed(events, name, fromTs, toTs).length,
    ])
  );
}

export interface FirstStart {
  readonly playTs: number;
  readonly callbackTs: number | null;
  /** D: first device start to first device callback. Telemetry only. */
  readonly dMs: number | null;
}

/** The first device start at or after fromTs, with its D. Null when none started. */
export function firstStart(
  events: readonly TraceEvent[],
  fromTs: number
): FirstStart | null {
  const playTs = timesNamed(
    events,
    DEVICE_START_EVENT,
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

export interface QuietWindow {
  /** The trace start mark sits at least QUIET_WINDOW_MS before the trusted event. */
  readonly covered: boolean;
  /** Names of quiet-window events found inside the window, without repeats. */
  readonly offending: readonly string[];
}

/**
 * What the trace shows in the QUIET_WINDOW_MS before the first trusted event. An uncovered window
 * is unproven, not quiet: the trace did not start early enough to show the output's state.
 */
export function quietWindow(
  events: readonly TraceEvent[],
  firstTrustedTs: number
): QuietWindow {
  const start = markTs(events, TRACE_START_MARK);
  const windowStart = firstTrustedTs - QUIET_WINDOW_MS * 1000;
  const covered = start !== null && start <= windowStart;
  const names = new Set<string>();
  for (const event of events) {
    if (event.ts < windowStart || event.ts >= firstTrustedTs) continue;
    if (QUIET_WINDOW_EVENTS.includes(event.name)) names.add(event.name);
  }
  return { covered, offending: [...names] };
}

export type Coldness = 'cold' | 'warm' | 'absent' | 'unproven' | 'resumed';

export interface ColdnessInput {
  readonly quiet: QuietWindow;
  /** The OS read the default output idle immediately before the trusted event. */
  readonly osIdleAtTrusted: boolean;
  /** Device starts after the first trusted event. */
  readonly startsAfterTrusted: number;
  /** The program's pipeline was rebuilt after the trusted event (see pipelineResumed). */
  readonly resumed: boolean;
}

/**
 * What the first trusted event found. Only 'cold' is a cold start. Each other value says why the
 * trial is not cold, so a control can never count a warm, resumed or unmeasured start as cold.
 */
export function classifyColdness(input: ColdnessInput): Coldness {
  if (!input.quiet.covered) return 'unproven';
  if (input.quiet.offending.length > 0 || !input.osIdleAtTrusted) return 'warm';
  if (input.startsAfterTrusted === 0) return 'absent';
  if (input.resumed) return 'resumed';
  return 'cold';
}

/**
 * True when RendererImpl::Initialize falls in [fromTs, untilTs]. A resumed Play shows as this
 * rebuild: the program's pipeline is created again at the trusted event, after Chrome suspended it.
 * A rebuild before fromTs, such as at load, does not count.
 */
export function pipelineResumed(
  events: readonly TraceEvent[],
  fromTs: number,
  untilTs: number
): boolean {
  return events.some(
    (e) => e.name === PIPELINE_INIT_EVENT && e.ts >= fromTs && e.ts <= untilTs
  );
}

/**
 * CompleteSeek (pipeline_impl.cc) finishes a start, seek or resume by calling StartPlayingFrom and
 * then SetPlaybackRate with the playback rate, both on one renderer thread. A paused program
 * therefore shows a zero rate directly after its StartPlayingFrom. Only that shape is exempt: a
 * zero rate whose pid and tid match, with StartPlayingFrom the one latest renderer event before it
 * on that thread. A non-zero rate, a missing rate, pid or tid, any other preceding renderer event,
 * or two different renderer events tied for latest all fail.
 */
function pausedSeekCompletion(
  events: readonly TraceEvent[],
  event: TraceEvent
): boolean {
  if (event.name !== RATE_EVENT || event.args?.['rate'] !== 0) return false;
  if (event.pid === undefined || event.tid === undefined) return false;
  let latest: TraceEvent | null = null;
  let tied = false;
  for (const other of events) {
    if (!other.name.startsWith('RendererImpl::')) continue;
    if (other.pid !== event.pid || other.tid !== event.tid) continue;
    if (other.ts >= event.ts) continue;
    if (latest === null || other.ts > latest.ts) {
      latest = other;
      tied = false;
    } else if (other.ts === latest.ts && other.name !== latest.name) {
      tied = true;
    }
  }
  return latest?.name === SEEK_COMPLETION_EVENT && !tied;
}

/**
 * Each reaction that lands in [mark - MARK_ORDER_WINDOW_US, mark) is a failure: the page or the
 * device acted before the mark, so the mark is late and cannot attribute that reaction to the
 * gesture. An absent mark returns nothing here; the gate that needs the mark reports its absence.
 * The one exception is pausedSeekCompletion, a zero rate that Chrome applies as its pipeline
 * finishes a start, seek or resume. Every other reaction still fails.
 */
export function markOrderFailures(
  events: readonly TraceEvent[],
  name: string
): string[] {
  const at = markTs(events, name);
  if (at === null) return [];
  const failures: string[] = [];
  for (const event of events) {
    if (!MARK_ORDER_EVENTS.includes(event.name)) continue;
    if (event.ts < at - MARK_ORDER_WINDOW_US || event.ts >= at) continue;
    if (pausedSeekCompletion(events, event)) continue;
    failures.push(
      `page reacted before ${name} by ${at - event.ts} µs (${event.name})`
    );
  }
  return failures;
}

/** One default-output reading, placed on the trace clock. */
export interface OsReading {
  readonly traceTs: number;
  readonly running: boolean;
}

/**
 * Telemetry only. How long the OS read the default output running after Chrome's last
 * OutputController::Pause, counting only readings taken before any Chrome device event that
 * follows that pause. Null when Chrome paused nothing before untilTs, or no such reading showed the
 * output running. A value names use of the device by something other than this Chrome. It is a
 * receipt diagnostic and never gates.
 */
export function externalRunningMs(
  events: readonly TraceEvent[],
  readings: readonly OsReading[],
  untilTs: number
): number | null {
  let pauseTs: number | null = null;
  for (const e of events)
    if (
      e.name === OUTPUT_PAUSE_EVENT &&
      e.ts < untilTs &&
      (pauseTs === null || e.ts > pauseTs)
    )
      pauseTs = e.ts;
  if (pauseTs === null) return null;
  const pause: number = pauseTs;
  let deviceTs = Number.POSITIVE_INFINITY;
  for (const e of events)
    if (CHROME_DEVICE_EVENTS.includes(e.name) && e.ts > pause && e.ts < untilTs)
      deviceTs = Math.min(deviceTs, e.ts);
  let last: number | null = null;
  for (const r of readings)
    if (
      r.running &&
      r.traceTs > pause &&
      r.traceTs < untilTs &&
      r.traceTs < deviceTs
    )
      last = last === null ? r.traceTs : Math.max(last, r.traceTs);
  return last === null ? null : (last - pause) / 1000;
}

/** Telemetry only: callback spacing from the trace. Never gates and never proves audio. */
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

/**
 * Program frame slots skipped by presented gaps: each gap is rounded to whole program frames (the
 * rounding droppedFrames uses), and every frame past the first is a missed slot. At 30 fps that is
 * any gap of 50 ms or more.
 */
export function missedSlots(gapsMs: readonly number[], fps: number): number {
  let missed = 0;
  for (const gap of gapsMs)
    missed += Math.max(0, Math.round((gap * fps) / 1000) - 1);
  return missed;
}

/**
 * Frame cadence gates for a window: no gap over 100 ms and p95 within 50 ms. gapsMs are the gaps
 * between presented frames inside the window. boundaryGapsMs are the gaps that touch a window edge,
 * such as a stall that runs to the window end or one that runs in from its start. They count toward
 * the max and p95, and never toward the interval minimum.
 */
export function gateGaps(
  gapsMs: readonly number[],
  minIntervals: number,
  label: string,
  boundaryGapsMs: readonly number[] = []
): string[] {
  const failures: string[] = [];
  if (gapsMs.length < minIntervals)
    failures.push(
      `${label}: only ${gapsMs.length + 1} presented frames, need ${minIntervals + 1}`
    );
  const all = [...gapsMs, ...boundaryGapsMs];
  const max = maxOf(all);
  const tail = p95(all);
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

export interface WindowEdgeGaps {
  /** Gaps between presented frames inside the window. */
  readonly gapsMs: number[];
  /** From the window start to the first presented frame inside it. Null unless a frame came earlier. */
  readonly leadingGapMs: number | null;
  /** From the last presented frame inside the window to the window end. Null when there is no frame at all. */
  readonly trailingGapMs: number | null;
}

/**
 * Presented gaps over one window, with both edges counted. Times are page milliseconds in
 * presentation order. Only frames within [startMs, endMs] belong to the window. A window that starts
 * after a presented frame and shows none inside is one stall spanning the whole window. The start of
 * a run, before its first presented frame, is not a gap: the caller gates it as the startup budget.
 */
export function windowEdgeGaps(
  presentedMs: readonly number[],
  startMs: number,
  endMs: number
): WindowEdgeGaps {
  const inside = presentedMs.filter((t) => t >= startMs && t <= endMs);
  const before = presentedMs.some((t) => t < startMs);
  if (inside.length === 0)
    return {
      gapsMs: [],
      leadingGapMs: null,
      trailingGapMs: before ? endMs - startMs : null,
    };
  return {
    gapsMs: intervals(inside),
    leadingGapMs: before ? inside[0]! - startMs : null,
    trailingGapMs: endMs - inside[inside.length - 1]!,
  };
}

export interface MediaFrame {
  /** Page milliseconds. */
  readonly now: number;
  /** Seconds of program media. */
  readonly mediaTime: number;
}

export interface NewFrames<F extends MediaFrame> {
  /** The first new frame, or null when none was presented. */
  readonly firstNew: F | null;
  /** New frames in order: media time strictly increasing, repeats of a shown frame removed. */
  readonly kept: readonly F[];
  /** True when media time moved backward after the first new frame. Always a failure. */
  readonly backward: boolean;
}

/**
 * New frames after the trusted Play. The resting frame is the program frame shown at the trusted
 * event, rounded down to a whole frame. A new frame sits at least one program frame past it.
 * Frames before the first new frame are the resting frame repeated, and they are not counted.
 */
export function newFrames<F extends MediaFrame>(
  frames: readonly F[],
  restCurrentTime: number,
  fps: number
): NewFrames<F> {
  const restMedia = Math.floor(restCurrentTime * fps + MEDIA_EPSILON_S) / fps;
  const threshold = restMedia + 1 / fps - MEDIA_EPSILON_S;
  const kept: F[] = [];
  let backward = false;
  for (const frame of frames) {
    const last = kept[kept.length - 1];
    if (last === undefined) {
      if (frame.mediaTime >= threshold) kept.push(frame);
    } else if (frame.mediaTime > last.mediaTime + MEDIA_EPSILON_S) {
      kept.push(frame);
    } else if (frame.mediaTime < last.mediaTime - MEDIA_EPSILON_S) {
      backward = true;
    }
  }
  return { firstNew: kept[0] ?? null, kept, backward };
}

export interface PrimerWindow {
  /** First new frame minus the trusted Play, page clock. */
  readonly startupMs: number | null;
  /** Gaps between consecutive presented frames inside the window. */
  readonly gapsMs: readonly number[];
  /** From the last presented frame inside the window to the window end. Null when there is none. */
  readonly trailingGapMs: number | null;
  readonly bufferingBeforeFirstFrame: boolean | null;
  /** Device starts (OutputController::Play) after the trusted Play. */
  readonly deviceStarts: number;
  /** null: reported only, never gated (sequence F first-click, where Chrome's start may land either side). */
  readonly expectedDeviceStarts: number | null;
  /** Only the first-click arm: Buffering must show before the first new frame. */
  readonly firstClick: boolean;
}

/**
 * Video and start budgets for an arm that must not stall. Audio is never judged here: callback
 * spacing is telemetry only, and the audio budget is proven by otio-program-audio-signal.ts.
 */
export function gatePrimerWindow(w: PrimerWindow): string[] {
  const failures: string[] = [];
  if (w.startupMs === null)
    failures.push('no new frame after the trusted Play');
  else if (w.startupMs > FIRST_FRAME_BUDGET_MS)
    failures.push(
      `first frame ${w.startupMs.toFixed(1)} ms > ${FIRST_FRAME_BUDGET_MS} ms`
    );
  failures.push(
    ...gateGaps(
      w.gapsMs,
      MIN_WINDOW_INTERVALS,
      'window',
      w.trailingGapMs === null ? [] : [w.trailingGapMs]
    )
  );
  if (
    w.expectedDeviceStarts !== null &&
    w.deviceStarts !== w.expectedDeviceStarts
  )
    failures.push(
      `${w.deviceStarts} device start(s) after Play, expected ${w.expectedDeviceStarts}`
    );
  if (w.firstClick && w.bufferingBeforeFirstFrame !== true)
    failures.push('Buffering was not shown before the first frame');
  return failures;
}
