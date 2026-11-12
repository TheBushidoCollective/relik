/**
 * Pure join of MediaStreamTrackProcessor chunks with the program renderer's trace, plus the gate and
 * the mutation controls built on it. Nothing here reads a file, starts a browser or throws on a fault
 * in the capture: every fault becomes a failure string, so the caller reports all of them.
 *
 * Chunks pair with renders by delivery order, never by stamp. Stamps are pairing keys only: they move
 * backwards in real captures, so ordering by stamp mispairs the content. Nothing here claims physical
 * output or a device sample. The gate measures the program renderer's tee.
 *
 * Telemetry (priming gap, playout estimate, pipeline rebuild, observer holds) goes into the receipt.
 * It never fails a join and no expected range is asserted against it.
 */
import { PLAY_MARK } from './otio-program-trace.ts';
import {
  gateSignal,
  measureSignal,
  type SignalEvidence,
} from './otio-program-audio-signal.ts';

/** The captured program renders at 48 kHz. Chunk stamps and trace times share this clock. */
export const JOIN_RATE = 48000;
/** A chunk's tee time must fall inside its render's ProvideInput call, give or take this many microseconds. */
export const JOIN_TOLERANCE_US = 1;
export const AUDIO_READER_START_MARK = 'relic-audio-reader-start';
export const AUDIO_CAPTURE_STOP_MARK = 'relic-audio-capture-stop';
export const AUDIO_READER_STOP_MARK = 'relic-audio-reader-stop';
/** Prefix of the failure a program render before the play mark produces. The early-start control expects it. */
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
  /** The program's currentTime read at the trusted Play, before the page handler. */
  readonly restCurrentTime: number | null;
  /** Frames observed after the trusted Play, for element-clock hold telemetry. */
  readonly observerFrames: readonly ObserverFrame[];
}

/** The expected program signal per channel. The capture starts at reference sample 0. */
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

interface CdpTraceEvent {
  readonly name: string;
  readonly cat?: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly tid?: number;
  readonly args?: Readonly<Record<string, unknown>>;
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
  play: number | undefined,
  rate: number
): JoinTelemetry {
  const paired: PairedRender[] = [];
  for (const pair of pairs) {
    const render = renders[pair.renderIndex];
    if (render !== undefined) paired.push({ pair, render });
  }

  // The priming render is the first paired render after the play mark. The gap runs from it to the
  // next paired render. The step is that gap minus the next render's reported delay. All telemetry.
  const priming =
    play === undefined
      ? undefined
      : paired.find(({ render }) => render.end >= play);
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

  // Chrome's playout estimate for the first paired render with a nonzero delay. Frames already
  // delivered by earlier paired renders are removed, and the Play mark is the origin.
  let framesBefore = 0;
  let playoutFirstMs: number | null = null;
  if (play !== undefined) {
    for (const { render } of paired) {
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
      framesBefore += render.frames;
    }
  }

  const lead = paired.map(({ pair, render }) => pair.teeUs - render.end);
  const tail = paired.map(({ pair, render }) => render.piEnd - pair.teeUs);
  const rebuilt =
    play !== undefined &&
    record.events.some(
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
      play === undefined || priming === undefined
        ? null
        : (priming.render.ts - play) / 1000,
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
 * fits, or a program render that ends before the play mark each fail the join.
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
  if (start === undefined || stop === undefined)
    return unresolved(failures, sampleFrames);

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
  if (play !== undefined) {
    const early = programRenders.filter((render) => render.end < play).length;
    if (early > 0) {
      failures.push(
        `${PRE_GESTURE_FAILURE}: ${early} program render(s) end before the play mark`
      );
    }
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

  return {
    pass: failures.length === 0,
    failures,
    programId,
    pairs,
    sampleFrames,
    telemetry: telemetryOf(
      { ...record, events: parsed },
      programRenders,
      pairs,
      play,
      rate
    ),
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
 * Gates one joined capture. Returns every failure: the join's own, then every sampled-audio failure
 * of each channel. Evidence is null only when the sample arrays are malformed. An empty failure list
 * passes.
 */
export function gateCapture(
  record: CaptureRecord,
  options: GateOptions
): GateResult {
  const join = joinCapture(record);
  const failures: string[] = [...join.failures];
  const intact =
    record.chunks.length > 0 &&
    record.chunks.every(
      (chunk) =>
        chunk.left.length === chunk.frames &&
        chunk.right.length === chunk.frames
    );
  if (!intact) return { failures, join, evidence: null };

  const left = concatChannel(record.chunks, (chunk) => chunk.left);
  const right = concatChannel(record.chunks, (chunk) => chunk.right);
  const evidence = {
    left: measureSignal(left, options.reference.left, JOIN_RATE, 0),
    right: measureSignal(right, options.reference.right, JOIN_RATE, 0),
  };
  failures.push(
    ...gateSignal(evidence.left, `${options.label} left`),
    ...gateSignal(evidence.right, `${options.label} right`)
  );
  return { failures, join, evidence };
}

/**
 * The layer that must reject a control's mutation:
 * join: the pairing fails. play: a program render ends before the play mark. samples: pairing
 * passes but the sampled-audio gate fails.
 */
type RejectingLayer = 'join' | 'play' | 'samples';

interface Control {
  readonly name: string;
  readonly layer: RejectingLayer;
  /** Optional controls apply only when the capture has their precondition, and are skipped otherwise. */
  readonly optional?: boolean;
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
      name: 'repeated chunk',
      layer: 'join',
      apply: (r) =>
        middle === undefined
          ? null
          : {
              ...r,
              chunks: [
                ...r.chunks.slice(0, mid + 1),
                middle,
                ...r.chunks.slice(mid + 1),
              ],
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
      layer: 'samples',
      apply: (r) =>
        middle === undefined ||
        (middle.left.every((sample) => sample === 0) &&
          middle.right.every((sample) => sample === 0))
          ? null
          : editChunk(r, mid, (chunk) => ({
              ...chunk,
              left: new Float32Array(chunk.frames),
              right: new Float32Array(chunk.frames),
            })),
    },
    {
      name: 'chunks sorted by stamp',
      optional: true,
      layer: 'join',
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
        const after = r.chunks[mid + 1];
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
      optional: true,
      layer: 'join',
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
  if (control.layer === 'samples') {
    const gate = gateCapture(mutated, options);
    return gate.join.pass && gate.failures.length > 0;
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
