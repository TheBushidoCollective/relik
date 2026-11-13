/**
 * Pure join of MediaStreamTrackProcessor chunks with the program renderer's trace, plus the gate and
 * the mutation controls built on it. Nothing here reads a file, starts a browser or throws on a fault
 * in the capture: every fault becomes a failure string, so the caller reports all of them.
 *
 * Chunks pair with renders by delivery order, never by stamp. Stamps are pairing keys only: they move
 * backwards in real captures, so ordering by stamp mispairs the content. Nothing here claims physical
 * output or a device sample. The gate measures the program renderer's tee.
 *
 * The gate measures only the chunks whose tee time lies between the play mark and the capture stop,
 * starting at the resting currentTime read at the trusted Play. Renders before Play may be
 * silent; audible ones fail the join.
 *
 * Telemetry (priming gap, playout estimate, pipeline rebuild, observer holds) goes into the receipt.
 * It never fails a join and no expected range is asserted against it.
 */
import { PLAY_MARK } from './otio-program-trace.ts';
import {
  AUDIO_GAP_BUDGET_MS,
  AUDIO_SILENCE_AMPLITUDE,
  gateSignal,
  measureSignal,
  type SignalEvidence,
} from './otio-program-audio-signal.ts';
import { AUDIO_MIN_SNR_DB } from './otio-program-checks.ts';

/** The captured program renders at 48 kHz. Chunk stamps and trace times share this clock. */
export const JOIN_RATE = 48000;
/** A chunk's tee time must fall inside its render's ProvideInput call, give or take this many microseconds. */
export const JOIN_TOLERANCE_US = 1;
export const AUDIO_READER_START_MARK = 'relic-audio-reader-start';
export const AUDIO_CAPTURE_STOP_MARK = 'relic-audio-capture-stop';
export const AUDIO_READER_STOP_MARK = 'relic-audio-reader-stop';
/** Prefix of the failure an audible program render before the play mark produces. */
export const PRE_GESTURE_FAILURE = 'pre-gesture audio';

/** Window around the play mark that counts a renderer init as a rebuild at play. Telemetry only. */
const PIPELINE_REBUILD_WINDOW_US = 1000;
const PROVIDE_INPUT = 'AudioRendererMixerInput::ProvideInput';
const RENDER = 'AudioRendererImpl::Render';
const INITIALIZE = 'RendererImpl::Initialize';
const REQUIRED_MARKS = [
  AUDIO_READER_START_MARK,
  PLAY_MARK,
  AUDIO_CAPTURE_STOP_MARK,
  AUDIO_READER_STOP_MARK,
] as const;

/** One MediaStreamTrackProcessor chunk with its decoded channels. Its index in the record is its delivery order. */
export interface CapturedChunk {
  /** Stamp in microseconds. A pairing key only: never a time, never sorted. */
  readonly stampUs: number;
  readonly frames: number;
  readonly rate: number;
  /** Milliseconds from reader start at delivery. Telemetry only. */
  readonly deliveredMs: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** An observed frame after the trusted Play. Only the media clock matters here. */
export interface ObserverFrame {
  readonly now: number;
  readonly mediaTime: number;
}

export interface CaptureRecord {
  /** Chunks in delivery order. Never sorted. */
  readonly chunks: readonly CapturedChunk[];
  /** Chrome trace events of the same trial. Validated here, not trusted. */
  readonly events: readonly unknown[];
  /** The trace buffer overflowed or the capture is incomplete. Fails closed. */
  readonly truncated: boolean;
  /** tracingComplete.dataLossOccurred. Anything but false, including null, fails closed. */
  readonly dataLossOccurred: boolean | null;
  /**
   * The program's currentTime read at the trusted Play, in seconds. The gated span starts at program
   * sample round(restCurrentTime * rate). Null fails the gate.
   */
  readonly restCurrentTime: number | null;
  /** Frames observed after the trusted Play, for element-clock hold telemetry. */
  readonly observerFrames: readonly ObserverFrame[];
}

/** The expected program signal per channel, indexed by program sample. */
export interface AudioReference {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

export interface GateOptions {
  readonly reference: AudioReference;
  readonly label: string;
}

export interface JoinPair {
  readonly chunkIndex: number;
  readonly renderIndex: number;
  readonly teeUs: number;
}

export type JoinTelemetry = Readonly<Record<string, number | boolean | null>>;

export interface JoinResult {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly programId: string | null;
  readonly pairs: readonly JoinPair[];
  /**
   * Chunk indices whose pair's tee time lies between the play mark and the capture stop, in delivery
   * order. The gate measures exactly these.
   */
  readonly gatedChunks: readonly number[];
  /**
   * Program sample the gated span starts at: round(restCurrentTime * 48000), read at the trusted
   * pointerdown. Null when there is no valid resting time or no contiguous gated span. The gate
   * and the coverage rule both use this value.
   */
  readonly startSample: number | null;
  readonly sampleFrames: number;
  readonly telemetry: JoinTelemetry | null;
}

export interface GateResult {
  readonly failures: readonly string[];
  readonly join: JoinResult;
  readonly evidence: {
    readonly left: SignalEvidence;
    readonly right: SignalEvidence;
  } | null;
}

/** One program render: the Render event and the ProvideInput call that encloses it. */
interface ProgramRender {
  readonly id: string;
  readonly ts: number;
  readonly end: number;
  readonly piStart: number;
  readonly piEnd: number;
  /** ProvideInput's delay (frames). Sets the tee time of the chunk that fills this render. */
  readonly frames: number;
  /** Render's delay_timestamp (ms), or null when absent. */
  readonly delayTimestampMs: number | null;
  /** Render's playout_delay (ms), or null when absent. */
  readonly delayMs: number | null;
}

interface Match {
  readonly chunkIndex: number;
  readonly render: ProgramRender;
}

interface CdpTraceEvent {
  readonly name: string;
  readonly cat?: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly tid?: number;
  readonly args?: Readonly<Record<string, unknown>>;
}

function isTraceEvent(value: unknown): value is CdpTraceEvent {
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || typeof value.name !== 'string') return false;
  if (!('ph' in value) || typeof value.ph !== 'string') return false;
  if (!('ts' in value) || typeof value.ts !== 'number') return false;
  if (
    'cat' in value &&
    value.cat !== undefined &&
    typeof value.cat !== 'string'
  )
    return false;
  if (
    'dur' in value &&
    value.dur !== undefined &&
    typeof value.dur !== 'number'
  )
    return false;
  if (
    'args' in value &&
    value.args !== undefined &&
    (typeof value.args !== 'object' || value.args === null)
  ) {
    return false;
  }
  return true;
}

function parseEvents(events: readonly unknown[]): {
  parsed: CdpTraceEvent[];
  malformed: number;
} {
  const parsed: CdpTraceEvent[] = [];
  let malformed = 0;
  for (const value of events) {
    if (isTraceEvent(value)) parsed.push(value);
    else malformed++;
  }
  return { parsed, malformed };
}

function eventEnd(event: CdpTraceEvent): number {
  return event.ts + (event.dur ?? 0);
}

function numberArg(event: CdpTraceEvent, key: string): number | null {
  const value = event.args?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function teeUs(
  chunk: CapturedChunk,
  render: ProgramRender,
  rate: number
): number {
  return chunk.stampUs + Math.floor((render.frames * 1_000_000) / rate);
}

/** True when the chunk's tee time lies inside the render's call, within the join tolerance. */
function fits(
  chunk: CapturedChunk,
  render: ProgramRender,
  rate: number
): boolean {
  const tee = teeUs(chunk, render, rate);
  return (
    render.piStart - JOIN_TOLERANCE_US <= tee &&
    tee <= render.piEnd + JOIN_TOLERANCE_US
  );
}

/** True when either channel holds a sample above the silence threshold. */
function isAudible(chunk: CapturedChunk): boolean {
  const loud = (samples: Float32Array): boolean =>
    samples.some((sample) => Math.abs(sample) > AUDIO_SILENCE_AMPLITUDE);
  return loud(chunk.left) || loud(chunk.right);
}

/** True when every sample of both channels is a finite number. NaN and infinity are never scored. */
function finitePcm(chunk: CapturedChunk): boolean {
  return (
    chunk.left.every((sample) => Number.isFinite(sample)) &&
    chunk.right.every((sample) => Number.isFinite(sample))
  );
}

/**
 * Program renders in trace order. A render is kept only when exactly one ProvideInput call on its
 * thread encloses it and carries a delay. Anything else is returned as outside and never paired.
 */
function extractRenders(events: readonly CdpTraceEvent[]): {
  renders: ProgramRender[];
  outside: CdpTraceEvent[];
} {
  const inputs = new Map<string, CdpTraceEvent[]>();
  for (const event of events) {
    if (event.name !== PROVIDE_INPUT || event.ph !== 'X') continue;
    const key = String(event.tid);
    const list = inputs.get(key) ?? [];
    list.push(event);
    inputs.set(key, list);
  }
  const renders: ProgramRender[] = [];
  const outside: CdpTraceEvent[] = [];
  for (const event of events) {
    if (event.name !== RENDER || event.ph !== 'X') continue;
    const end = eventEnd(event);
    const enclosing = (inputs.get(String(event.tid)) ?? []).filter(
      (input) => input.ts <= event.ts && end <= eventEnd(input)
    );
    const [input] = enclosing;
    const frames =
      enclosing.length === 1 && input
        ? numberArg(input, 'delay (frames)')
        : null;
    if (input === undefined || frames === null) {
      outside.push(event);
      continue;
    }
    renders.push({
      id: String(event.args?.id),
      ts: event.ts,
      end,
      piStart: input.ts,
      piEnd: eventEnd(input),
      frames,
      delayTimestampMs: numberArg(event, 'delay_timestamp (ms)'),
      delayMs: numberArg(event, 'playout_delay (ms)'),
    });
  }
  renders.sort((a, b) => a.ts - b.ts);
  return { renders, outside };
}

function markTimes(events: readonly CdpTraceEvent[]): {
  times: Map<string, number>;
  duplicated: string[];
} {
  const times = new Map<string, number>();
  const duplicated: string[] = [];
  for (const event of events) {
    if (!event.cat?.includes('user_timing')) continue;
    if (!(REQUIRED_MARKS as readonly string[]).includes(event.name)) continue;
    if (times.has(event.name)) duplicated.push(event.name);
    else times.set(event.name, event.ts);
  }
  return { times, duplicated };
}

function countBackwardSteps(values: readonly number[]): number {
  let steps = 0;
  for (let k = 1; k < values.length; k++) {
    const previous = values[k - 1];
    const current = values[k];
    if (previous !== undefined && current !== undefined && current < previous)
      steps++;
  }
  return steps;
}

/** Element-clock telemetry: frames whose media time held still, and any media time that went backwards. */
function observerTelemetry(
  frames: readonly ObserverFrame[]
): Record<string, number> {
  let holds = 0;
  let backward = 0;
  for (let k = 1; k < frames.length; k++) {
    const previous = frames[k - 1];
    const current = frames[k];
    if (previous === undefined || current === undefined) continue;
    if (current.mediaTime === previous.mediaTime) holds++;
    else if (current.mediaTime < previous.mediaTime) backward++;
  }
  return {
    observerFrameCount: frames.length,
    observerHoldFrames: holds,
    observerBackwardSteps: backward,
  };
}

/** Min, median and max of a sample, as telemetry keys. An empty sample reports null. */
function spread(
  prefix: string,
  values: readonly number[]
): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    [`${prefix}Min`]: sorted[0] ?? null,
    [`${prefix}P50`]: sorted[Math.floor(sorted.length / 2)] ?? null,
    [`${prefix}Max`]: sorted[sorted.length - 1] ?? null,
  };
}

interface PairedRender {
  readonly pair: JoinPair;
  readonly render: ProgramRender;
}

function telemetryOf(
  record: CaptureRecord,
  renders: readonly ProgramRender[],
  pairs: readonly JoinPair[],
  play: number,
  rate: number
): JoinTelemetry {
  const paired: PairedRender[] = [];
  for (const pair of pairs) {
    const render = renders[pair.renderIndex];
    if (render !== undefined) paired.push({ pair, render });
  }

  // The priming render is the first paired render after the play mark. The gap runs from it to the
  // next paired render. The step is that gap minus the next render's reported delay. All telemetry.
  const priming = paired.find(({ render }) => render.end >= play);
  const primingIndex = priming === undefined ? -1 : paired.indexOf(priming);
  const next = primingIndex >= 0 ? paired[primingIndex + 1] : undefined;
  const firstRenderWasPriming =
    priming !== undefined && priming.render.delayMs === 0;
  const primingGapMs =
    priming !== undefined && next !== undefined && priming.render.delayMs === 0
      ? (next.render.ts - priming.render.ts) / 1000
      : null;
  const nextDelayMs = next?.render.delayMs ?? null;
  const primingStepMs =
    primingGapMs !== null && nextDelayMs !== null
      ? primingGapMs - nextDelayMs
      : null;

  // Chrome's playout estimate for the first paired render with a nonzero delay. The frames removed
  // are the PCM frames the earlier paired chunks delivered, not their delay frames. The Play mark is
  // the origin.
  let framesBefore = 0;
  let playoutFirstMs: number | null = null;
  for (const { pair, render } of paired) {
    if (render.delayMs !== null && render.delayMs > 0) {
      if (render.delayTimestampMs !== null) {
        playoutFirstMs =
          render.delayTimestampMs +
          render.delayMs -
          (framesBefore * 1000) / rate -
          play / 1000;
      }
      break;
    }
    framesBefore += record.chunks[pair.chunkIndex]?.frames ?? 0;
  }

  const lead = paired.map(({ pair, render }) => pair.teeUs - render.end);
  const tail = paired.map(({ pair, render }) => render.piEnd - pair.teeUs);
  const rebuilt = record.events.some(
    (value) =>
      isTraceEvent(value) &&
      value.name === INITIALIZE &&
      Math.abs(value.ts - play) <= PIPELINE_REBUILD_WINDOW_US
  );

  return {
    renderCount: renders.length,
    pairCount: pairs.length,
    restCurrentTime: record.restCurrentTime,
    firstRenderWasPriming,
    primingGapMs,
    primingStepMs,
    chromeEstimatedPlayoutFirstMs: playoutFirstMs,
    pipelineRebuiltAtPlay: rebuilt,
    firstRenderAfterPlayMs:
      priming === undefined ? null : (priming.render.ts - play) / 1000,
    stampBackwardSteps: countBackwardSteps(
      record.chunks.map((chunk) => chunk.stampUs)
    ),
    deliveredBackwardSteps: countBackwardSteps(
      record.chunks.map((chunk) => chunk.deliveredMs)
    ),
    ...observerTelemetry(record.observerFrames),
    ...spread('teeMinusRenderEndUs', lead),
    ...spread('callEndMinusTeeUs', tail),
  };
}

function unresolved(failures: string[], sampleFrames: number): JoinResult {
  return {
    pass: false,
    failures,
    programId: null,
    pairs: [],
    gatedChunks: [],
    startSample: null,
    sampleFrames,
    telemetry: null,
  };
}

/**
 * Joins the chunks to the program renderer's renders, one to one, in delivery order.
 *
 * The program is the one renderer id whose renders the chunks fill. Chunk k must pair with the k-th
 * program render in trace order, its tee time inside that render's call within JOIN_TOLERANCE_US.
 * Each chunk must fit exactly one program render and each render exactly one chunk. The counts must
 * be equal. Truncation, data loss, a missing mark, a wrong rate, a second renderer id that a chunk
 * fits, or an audible program render that ends before the play mark each fail the join. A silent
 * render before Play still needs its paired chunk.
 */
export function joinCapture(
  record: CaptureRecord,
  rate: number = JOIN_RATE
): JoinResult {
  const { chunks } = record;
  const failures: string[] = [];
  const sampleFrames = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);

  if (record.truncated)
    failures.push('trace truncated: the capture is incomplete');
  if (record.dataLossOccurred !== false) {
    failures.push(
      `trace data loss not reported false (dataLossOccurred ${String(record.dataLossOccurred)})`
    );
  }
  if (chunks.length === 0) failures.push('no chunks delivered');
  const badRate = chunks.filter((chunk) => chunk.rate !== rate).length;
  if (badRate > 0)
    failures.push(`${badRate} chunk(s) at a rate other than ${rate}`);
  const badFrames = chunks.filter(
    (chunk) => !Number.isInteger(chunk.frames) || chunk.frames <= 0
  ).length;
  if (badFrames > 0)
    failures.push(
      `${badFrames} chunk(s) without a positive integer frame count`
    );
  const badSamples = chunks.filter(
    (chunk) =>
      chunk.left.length !== chunk.frames || chunk.right.length !== chunk.frames
  ).length;
  if (badSamples > 0) {
    failures.push(
      `${badSamples} chunk(s) whose sample arrays do not match their frame count`
    );
  }
  const nonFinite = chunks.filter((chunk) => !finitePcm(chunk)).length;
  if (nonFinite > 0)
    failures.push(
      `${nonFinite} chunk(s) hold non-finite PCM (NaN or infinity)`
    );
  const badStamps = chunks.filter(
    (chunk) =>
      !Number.isFinite(chunk.stampUs) || !Number.isFinite(chunk.deliveredMs)
  ).length;
  if (badStamps > 0)
    failures.push(
      `${badStamps} chunk(s) without a finite stamp or delivery time`
    );

  const { parsed, malformed } = parseEvents(record.events);
  if (malformed > 0)
    failures.push(`${malformed} trace event(s) are not trace events`);

  const marks = markTimes(parsed);
  for (const name of marks.duplicated)
    failures.push(`mark ${name} recorded more than once`);
  const missing = REQUIRED_MARKS.filter((name) => !marks.times.has(name));
  if (missing.length > 0) failures.push(`marks missing: ${missing.join(', ')}`);
  const start = marks.times.get(AUDIO_READER_START_MARK);
  const stop = marks.times.get(AUDIO_READER_STOP_MARK);
  const play = marks.times.get(PLAY_MARK);
  const captureStop = marks.times.get(AUDIO_CAPTURE_STOP_MARK);
  if (
    start === undefined ||
    stop === undefined ||
    play === undefined ||
    captureStop === undefined
  ) {
    return unresolved(failures, sampleFrames);
  }

  const { renders, outside } = extractRenders(parsed);
  const windowed = renders.filter(
    (render) => start <= render.end && render.end <= stop
  );

  const matches: Match[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    for (const render of windowed) {
      if (fits(chunk, render, rate)) matches.push({ chunkIndex, render });
    }
  }

  const matchedIds = [...new Set(matches.map((match) => match.render.id))];
  if (matchedIds.length === 0) {
    failures.push('no renderer pairs any chunk');
    return unresolved(failures, sampleFrames);
  }
  const [programId] = matchedIds;
  if (matchedIds.length > 1 || programId === undefined) {
    failures.push(
      `chunks pair with more than one renderer id: ${matchedIds.join(', ')}`
    );
    return unresolved(failures, sampleFrames);
  }

  const programRenders = windowed.filter((render) => render.id === programId);
  const programMatches = matches.filter(
    (match) => match.render.id === programId
  );

  const outsideProgram = outside.filter(
    (event) =>
      String(event.args?.id) === programId &&
      start <= eventEnd(event) &&
      eventEnd(event) <= stop
  );
  if (outsideProgram.length > 0) {
    failures.push(
      `${outsideProgram.length} program render(s) outside a mixer input call`
    );
  }
  if (programRenders.length !== chunks.length) {
    failures.push(
      `${programRenders.length} program render(s) for ${chunks.length} chunk(s): one-to-one pairing needs equal counts`
    );
  }

  const chunkHits = new Map<number, number>();
  const renderHits = new Map<ProgramRender, number>();
  for (const match of programMatches) {
    chunkHits.set(match.chunkIndex, (chunkHits.get(match.chunkIndex) ?? 0) + 1);
    renderHits.set(match.render, (renderHits.get(match.render) ?? 0) + 1);
  }
  const chunksNotOne = chunks.filter((_, k) => chunkHits.get(k) !== 1).length;
  const rendersNotOne = programRenders.filter(
    (render) => renderHits.get(render) !== 1
  ).length;
  if (chunksNotOne > 0) {
    failures.push(
      `${chunksNotOne} chunk(s) do not fit exactly one program render`
    );
  }
  if (rendersNotOne > 0) {
    failures.push(
      `${rendersNotOne} program render(s) do not fit exactly one chunk`
    );
  }

  const pairs: JoinPair[] = [];
  let firstMismatch: number | null = null;
  const shared = Math.min(chunks.length, programRenders.length);
  for (let k = 0; k < shared; k++) {
    const chunk = chunks[k];
    const render = programRenders[k];
    if (chunk === undefined || render === undefined) break;
    if (fits(chunk, render, rate)) {
      pairs.push({
        chunkIndex: k,
        renderIndex: k,
        teeUs: teeUs(chunk, render, rate),
      });
    } else if (firstMismatch === null) {
      firstMismatch = k;
    }
  }
  if (firstMismatch !== null) {
    failures.push(
      `chunk ${firstMismatch} does not fit render ${firstMismatch} in delivery order`
    );
  }

  // Renders that end before Play may be silent. Each still needs its own paired chunk, and an
  // audible one fails. The two checks are independent: a silent render with no chunk still fails.
  const pairedRenders = new Set(
    pairs.map((pair) => programRenders[pair.renderIndex])
  );
  const early = programRenders.filter((render) => render.end < play);
  const unpairedEarly = early.filter(
    (render) => !pairedRenders.has(render)
  ).length;
  if (unpairedEarly > 0) {
    failures.push(
      `${unpairedEarly} pre-gesture render(s) have no paired chunk`
    );
  }
  const audibleEarly = pairs.filter((pair) => {
    const render = programRenders[pair.renderIndex];
    const chunk = chunks[pair.chunkIndex];
    return (
      render !== undefined &&
      render.end < play &&
      chunk !== undefined &&
      isAudible(chunk)
    );
  }).length;
  if (audibleEarly > 0) {
    failures.push(
      `${PRE_GESTURE_FAILURE}: ${audibleEarly} program render(s) end before the play mark with audible samples`
    );
  }

  // The gated span: pairs whose tee time lies between the play mark and the capture stop, in
  // delivery order. Tee time, not render end, so the span matches the capture's own coverage rule.
  const gatedChunks = pairs
    .filter((pair) => play <= pair.teeUs && pair.teeUs <= captureStop)
    .map((pair) => pair.chunkIndex);
  // Program sample the gated span starts at: round(restCurrentTime * rate), read at the trusted
  // pointerdown. Silent pre-Play output does not advance program time, so no frames before the span
  // are added. The gate and the coverage rule both read this one value.
  const contiguous = gatedChunks.every(
    (k, i) => i === 0 || k === (gatedChunks[i - 1] ?? NaN) + 1
  );
  const rest = record.restCurrentTime;
  const startSample =
    gatedChunks.length > 0 &&
    contiguous &&
    rest !== null &&
    Number.isFinite(rest) &&
    rest >= 0
      ? Math.round(rest * rate)
      : null;

  return {
    pass: failures.length === 0,
    failures,
    programId,
    pairs,
    gatedChunks,
    startSample,
    sampleFrames,
    telemetry: {
      ...telemetryOf(
        { ...record, events: parsed },
        programRenders,
        pairs,
        play,
        rate
      ),
      gatedChunkCount: gatedChunks.length,
    },
  };
}

function concatChannel(
  chunks: readonly CapturedChunk[],
  pick: (chunk: CapturedChunk) => Float32Array
): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(pick(chunk), offset);
    offset += chunk.frames;
  }
  return out;
}

/**
 * Correlation a gated chunk needs against the program audio. Under a gain-matched error model, SNR
 * S = r^2 / (1 - r^2), so the floor is the r at which S equals AUDIO_MIN_SNR_DB.
 */
const CHUNK_SNR_LINEAR = 10 ** (AUDIO_MIN_SNR_DB / 10);
const CHUNK_MIN_CORRELATION = Math.sqrt(
  CHUNK_SNR_LINEAR / (1 + CHUNK_SNR_LINEAR)
);

/**
 * Correlation of one rendered chunk with the reference at the channel's global lag. Only judged
 * samples count. A rendered sample at silence level is not judged here: a zero run is a gap, and
 * chunkMatchFailures judges it against the gap budget. A reference sample outside the program is
 * not judged either. Null when nothing is judged, or when the reference is silent across the window,
 * which the sampled checks cover. Zero when the judged rendered audio is absent from the reference.
 */
function chunkCorrelation(
  rendered: Float32Array,
  reference: Float32Array,
  from: number
): number | null {
  let inRange = 0;
  let referenceEnergy = 0;
  let judged = 0;
  let cross = 0;
  let renderedEnergy = 0;
  let judgedReferenceEnergy = 0;
  for (let k = 0; k < rendered.length; k++) {
    const index = from + k;
    if (index < 0 || index >= reference.length) continue;
    inRange++;
    const e = reference[index] ?? 0;
    referenceEnergy += e * e;
    const r = rendered[k] ?? 0;
    if (Math.abs(r) <= AUDIO_SILENCE_AMPLITUDE) continue;
    judged++;
    cross += r * e;
    renderedEnergy += r * r;
    judgedReferenceEnergy += e * e;
  }
  if (judged === 0 || referenceEnergy / inRange < AUDIO_SILENCE_AMPLITUDE ** 2)
    return null;
  if (judgedReferenceEnergy === 0) return 0;
  return cross / Math.sqrt(renderedEnergy * judgedReferenceEnergy);
}

/**
 * Every gated chunk must match the program audio at its own program position, at the channel's
 * measured global lag. The rendered audio runs lag samples late, so rendered sample j of a chunk that
 * starts at program sample p is compared with reference sample p + j - lag. The overall SNR and the
 * offset walk can both pass one repeated chunk, since a chunk is about 21 ms of a 6 s program, so each
 * chunk is judged on its own.
 *
 * The correlation skips silent rendered samples, so silent runs are judged here too, over the whole
 * span. The sampled gap check does not score the span's edges, and a zeroed first or last chunk would
 * otherwise pass. A run of silent rendered samples loses the audible program samples it covers. More
 * than AUDIO_GAP_BUDGET_MS of them is a gap. Samples before the program starts are not program audio.
 */
function chunkMatchFailures(
  span: readonly CapturedChunk[],
  pick: (chunk: CapturedChunk) => Float32Array,
  reference: Float32Array,
  startSample: number,
  lagSamples: number,
  label: string
): string[] {
  const failures: string[] = [];
  const gapSamples = Math.floor((JOIN_RATE * AUDIO_GAP_BUDGET_MS) / 1000);
  let lost = 0;
  let reported = false;
  let programStart = startSample;
  for (const [k, chunk] of span.entries()) {
    const rendered = pick(chunk);
    const from = programStart - lagSamples;
    const best = chunkCorrelation(rendered, reference, from);
    if (best !== null && best < CHUNK_MIN_CORRELATION) {
      failures.push(
        `${label}: gated chunk ${k} does not match the program audio (correlation ${best.toFixed(4)} at lag ${lagSamples} < ${CHUNK_MIN_CORRELATION.toFixed(4)})`
      );
    }
    for (let j = 0; j < rendered.length; j++) {
      if (Math.abs(rendered[j] ?? 0) > AUDIO_SILENCE_AMPLITUDE) {
        lost = 0;
        reported = false;
        continue;
      }
      const index = from + j;
      if (index < 0 || index >= reference.length) continue;
      if (Math.abs(reference[index] ?? 0) <= AUDIO_SILENCE_AMPLITUDE) continue;
      lost++;
      if (lost > gapSamples && !reported) {
        failures.push(
          `${label}: a silent run reaching gated chunk ${k} drops over ${AUDIO_GAP_BUDGET_MS} ms of program audio`
        );
        reported = true;
      }
    }
    programStart += chunk.frames;
  }
  return failures;
}

/**
 * Gates one joined capture over its gated span. The span starts at the resting currentTime, so the
 * reference slice is aligned to program time. Returns every failure: the join's own, the resting
 * time, the span, and every sampled-audio failure of each channel. An empty list passes.
 *
 * Non-finite PCM, in the capture or the reference, is rejected before anything is scored: NaN fails
 * every comparison and an infinite sample can turn an error into a perfect match. An infinite SNR is
 * kept only for a finite signal, where the error is exactly zero. A NaN SNR fails.
 */
export function gateCapture(
  record: CaptureRecord,
  options: GateOptions
): GateResult {
  const join = joinCapture(record);
  const failures: string[] = [...join.failures];

  const referenceFinite =
    options.reference.left.every((sample) => Number.isFinite(sample)) &&
    options.reference.right.every((sample) => Number.isFinite(sample));
  if (!record.chunks.every(finitePcm) || !referenceFinite) {
    failures.push(
      `${options.label}: non-finite PCM (NaN or infinity) in the capture or the reference; nothing is scored`
    );
    return { failures, join, evidence: null };
  }

  const rest = record.restCurrentTime;
  if (rest === null || !Number.isFinite(rest) || rest < 0) {
    failures.push(
      `no valid resting currentTime at the trusted Play: ${String(rest)}`
    );
    return { failures, join, evidence: null };
  }

  const gated = join.gatedChunks;
  if (gated.length === 0) {
    failures.push(
      'no gated span: no paired chunk has a tee time between the play mark and capture stop'
    );
    return { failures, join, evidence: null };
  }
  if (!gated.every((k, i) => i === 0 || k === (gated[i - 1] ?? NaN) + 1)) {
    failures.push('gated chunks are not contiguous in delivery order');
    return { failures, join, evidence: null };
  }

  const span = gated.flatMap((k) => record.chunks[k] ?? []);
  if (
    !span.every(
      (chunk) =>
        chunk.left.length === chunk.frames &&
        chunk.right.length === chunk.frames
    )
  ) {
    failures.push('gated chunk sample arrays do not match their frame count');
    return { failures, join, evidence: null };
  }

  // Program sample of the span's first sample. Every chunk after it sits at startSample plus the
  // frames before it, so the per-chunk positions and the measured lag use the same origin.
  const startSample = join.startSample;
  if (startSample === null) {
    failures.push('no program sample for the gated span');
    return { failures, join, evidence: null };
  }
  const evidence = {
    left: measureSignal(
      concatChannel(span, (chunk) => chunk.left),
      options.reference.left,
      JOIN_RATE,
      startSample
    ),
    right: measureSignal(
      concatChannel(span, (chunk) => chunk.right),
      options.reference.right,
      JOIN_RATE,
      startSample
    ),
  };
  if (Number.isNaN(evidence.left.snrDb) || Number.isNaN(evidence.right.snrDb)) {
    failures.push(`${options.label}: SNR is not a number`);
  }
  failures.push(
    ...gateSignal(evidence.left, `${options.label} left`),
    ...gateSignal(evidence.right, `${options.label} right`),
    ...chunkMatchFailures(
      span,
      (chunk) => chunk.left,
      options.reference.left,
      startSample,
      evidence.left.lagSamples,
      `${options.label} left`
    ),
    ...chunkMatchFailures(
      span,
      (chunk) => chunk.right,
      options.reference.right,
      startSample,
      evidence.right.lagSamples,
      `${options.label} right`
    )
  );
  return { failures, join, evidence };
}

/**
 * The layer that must reject a control's mutation. join: the pairing fails. play: an audible render
 * ends before the play mark. gate: pairing passes and the gate fails.
 */
type RejectingLayer = 'join' | 'play' | 'gate';

interface Control {
  readonly name: string;
  readonly layer: RejectingLayer;
  /** Optional controls apply only when the capture has their precondition, and are skipped otherwise. */
  readonly optional?: boolean;
  /** For gate controls: some gate failure must match this, or the control is not rejected. */
  readonly expect?: RegExp;
  /** The mutated record, or null when the capture has nothing to mutate. */
  readonly apply: (record: CaptureRecord) => CaptureRecord | null;
}

function editChunk(
  record: CaptureRecord,
  index: number,
  edit: (chunk: CapturedChunk) => CapturedChunk
): CaptureRecord {
  return {
    ...record,
    chunks: record.chunks.map((chunk, k) =>
      k === index ? edit(chunk) : chunk
    ),
  };
}

function sameSamples(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && a.every((sample, k) => sample === b[k]);
}

function controlsFor(
  record: CaptureRecord,
  programId: string | null
): Control[] {
  const { parsed } = parseEvents(record.events);
  const { renders } = extractRenders(parsed);
  const programRenders = renders.filter((render) => render.id === programId);
  const programRender = programRenders[Math.floor(programRenders.length / 2)];
  const lastProgramRender = programRenders[programRenders.length - 1];
  const primer = renders.find((render) => render.id !== programId);
  const mid = Math.floor(record.chunks.length / 2);
  const middle = record.chunks[mid];
  const predecessor = record.chunks[mid - 1];
  const after = record.chunks[mid + 1];
  const playMark = parsed.find((event) => event.name === PLAY_MARK);

  return [
    {
      name: 'dropped first chunk',
      layer: 'join',
      apply: (r) =>
        r.chunks.length < 2 ? null : { ...r, chunks: r.chunks.slice(1) },
    },
    {
      name: 'dropped middle chunk',
      layer: 'join',
      apply: (r) =>
        middle === undefined
          ? null
          : { ...r, chunks: r.chunks.filter((_, k) => k !== mid) },
    },
    {
      // Count, stamps and metadata stay intact. Only the PCM of chunk mid is replaced by its
      // predecessor's. Pairing passes, so the gate must catch the repeated content itself.
      name: 'repeated chunk',
      layer: 'gate',
      expect: /does not match the program audio/,
      apply: (r) => {
        if (middle === undefined || predecessor === undefined) return null;
        if (
          sameSamples(middle.left, predecessor.left) &&
          sameSamples(middle.right, predecessor.right)
        ) {
          return null;
        }
        return editChunk(r, mid, (chunk) => ({
          ...chunk,
          left: predecessor.left.slice(),
          right: predecessor.right.slice(),
        }));
      },
    },
    {
      name: 'shifted timestamp',
      layer: 'join',
      apply: (r) =>
        middle === undefined
          ? null
          : editChunk(r, mid, (chunk) => ({
              ...chunk,
              stampUs: chunk.stampUs + 1000,
            })),
    },
    {
      name: 'zeroed chunk',
      layer: 'gate',
      apply: (r) => {
        if (middle === undefined) return null;
        if (
          middle.left.every((sample) => sample === 0) &&
          middle.right.every((sample) => sample === 0)
        ) {
          return null;
        }
        return editChunk(r, mid, (chunk) => ({
          ...chunk,
          left: new Float32Array(chunk.frames),
          right: new Float32Array(chunk.frames),
        }));
      },
    },
    {
      // Pairing is unchanged, so only the non-finite check can reject it. NaN fails every comparison.
      name: 'NaN sample in the middle chunk',
      layer: 'join',
      apply: (r) => {
        if (middle === undefined) return null;
        return editChunk(r, mid, (chunk) => {
          const left = chunk.left.slice();
          left[Math.floor(chunk.frames / 2)] = Number.NaN;
          return { ...chunk, left };
        });
      },
    },
    {
      name: 'chunks sorted by stamp',
      layer: 'join',
      optional: true,
      apply: (r) => {
        const sorted = [...r.chunks].sort((a, b) => a.stampUs - b.stampUs);
        return sorted.every((chunk, k) => chunk === r.chunks[k])
          ? null
          : { ...r, chunks: sorted };
      },
    },
    {
      name: 'adjacent chunks swapped in delivery order',
      layer: 'join',
      apply: (r) => {
        if (middle === undefined || after === undefined) return null;
        return {
          ...r,
          chunks: r.chunks.map((chunk, k) =>
            k === mid ? after : k === mid + 1 ? middle : chunk
          ),
        };
      },
    },
    {
      name: 'middle program render missing from trace',
      layer: 'join',
      apply: (r) => {
        if (programRender === undefined) return null;
        const events = r.events.filter(
          (value) =>
            !(
              isTraceEvent(value) &&
              value.name === RENDER &&
              value.ts === programRender.ts &&
              String(value.args?.id) === programId
            )
        );
        return events.length === r.events.length ? null : { ...r, events };
      },
    },
    {
      name: 'middle chunk moved into another renderer call',
      layer: 'join',
      optional: true,
      apply: (r) => {
        if (primer === undefined) return null;
        const target = Math.floor((primer.piStart + primer.piEnd) / 2);
        return editChunk(r, mid, (chunk) => ({
          ...chunk,
          stampUs:
            target - Math.floor((primer.frames * 1_000_000) / chunk.rate),
        }));
      },
    },
    {
      name: 'late PLAY_MARK',
      layer: 'play',
      apply: (r) => {
        if (lastProgramRender === undefined) return null;
        const late = lastProgramRender.ts + 1000;
        let moved = false;
        const events = r.events.map((value) => {
          if (isTraceEvent(value) && value.name === PLAY_MARK) {
            moved = true;
            return { ...value, ts: late };
          }
          return value;
        });
        return moved ? { ...r, events } : null;
      },
    },
    {
      // Pairing is unchanged, so the join passes. The gated span between Play and the stop is empty.
      name: 'capture stop moved to play plus 1 ms',
      layer: 'gate',
      expect: /gated span/,
      apply: (r) => {
        if (playMark === undefined) return null;
        const stopTs = playMark.ts + 1000;
        let moved = false;
        const events = r.events.map((value) => {
          if (isTraceEvent(value) && value.name === AUDIO_CAPTURE_STOP_MARK) {
            moved = true;
            return { ...value, ts: stopTs };
          }
          return value;
        });
        return moved ? { ...r, events } : null;
      },
    },
    {
      // The span is measured at the wrong program time, so the gate's alignment fails.
      name: 'resting currentTime moved to 2 s',
      layer: 'gate',
      apply: (r) =>
        r.restCurrentTime === 2 ? null : { ...r, restCurrentTime: 2 },
    },
    {
      name: 'resting currentTime missing',
      layer: 'gate',
      expect: /resting currentTime/,
      apply: (r) =>
        r.restCurrentTime === null ? null : { ...r, restCurrentTime: null },
    },
    {
      name: 'trace data loss reported',
      layer: 'join',
      apply: (r) =>
        r.dataLossOccurred === true ? null : { ...r, dataLossOccurred: true },
    },
    {
      name: 'trace data loss unknown',
      layer: 'join',
      apply: (r) =>
        r.dataLossOccurred === null ? null : { ...r, dataLossOccurred: null },
    },
    {
      name: 'trace truncated',
      layer: 'join',
      apply: (r) => (r.truncated ? null : { ...r, truncated: true }),
    },
  ];
}

function rejected(
  control: Control,
  mutated: CaptureRecord,
  options: GateOptions
): boolean {
  if (control.layer === 'gate') {
    const gate = gateCapture(mutated, options);
    return (
      gate.join.pass &&
      gate.failures.some((failure) =>
        control.expect ? control.expect.test(failure) : true
      )
    );
  }
  const join = joinCapture(mutated);
  if (control.layer === 'join') return !join.pass;
  return join.failures.some((failure) =>
    failure.startsWith(PRE_GESTURE_FAILURE)
  );
}

/**
 * Runs every mutation control against the clean capture. Returns [] only when the clean capture
 * passes the gate and every control changed the capture and was rejected at its own layer. Any other
 * result is a failure string that names the control.
 */
export function mutationControlFailures(
  record: CaptureRecord,
  options: GateOptions
): string[] {
  const clean = gateCapture(record, options);
  const failures: string[] = [];
  if (clean.failures.length > 0) {
    failures.push(`clean capture does not pass: ${clean.failures.join('; ')}`);
  }
  for (const control of controlsFor(record, clean.join.programId)) {
    const mutated = control.apply(record);
    if (mutated === null) {
      if (!control.optional)
        failures.push(`control "${control.name}" did not mutate the capture`);
    } else if (!rejected(control, mutated, options)) {
      failures.push(
        `control "${control.name}" was not rejected at the ${control.layer} layer`
      );
    }
  }
  return failures;
}
