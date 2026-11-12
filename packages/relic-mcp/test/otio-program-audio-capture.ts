/**
 * Same-trial capture of the audio the program renderer hands to its tee, for the sampled audio
 * arms. One fresh viewer page, one Chrome trace, one MediaStreamTrackProcessor reader over the
 * program element's captureStream() audio track, and one trusted Play.
 *
 * What is sampled: the program renderer's output as its own tee delivers it. Not the mixer, the
 * browser output stream or the device. Stamps are opaque pairing keys: they join each chunk to a
 * program render in the same trace (otio-program-audio-join.ts) and are never read as times.
 *
 * No AudioContext, createMediaStreamSource or createScriptProcessor is used here: the reader is
 * the only tap.
 *
 * Receipts: a trial is judged on the sanitized record (sanitizeRecord), and that same record is what
 * a receipt saves. Reading the receipt back and judging it again gives the same verdict, because
 * every field the verdict reads survives the round trip. Only the trace's timing and numeric
 * arguments are kept. URLs, titles and other free-form arguments never reach disk.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  MARK_ORDER_EVENTS,
  markOrderFailures,
  PLAY_MARK,
  PRIMER_TRACE_CATEGORIES,
  TRACE_START_MARK,
  type TraceEvent,
} from './otio-program-trace.ts';
import {
  armPointer,
  pointerObservation,
} from './otio-program-primer-controls.ts';
import { VIEWER_CONTRACT, type ViewerPage } from './otio-program-viewer.ts';
import {
  AUDIO_CAPTURE_STOP_MARK,
  AUDIO_READER_START_MARK,
  AUDIO_READER_STOP_MARK,
  type AudioReference,
  type CapturedChunk,
  type CaptureRecord,
  gateCapture,
  type GateResult,
  JOIN_RATE,
  type JoinResult,
  mutationControlFailures,
  type ObserverFrame,
  PRE_GESTURE_FAILURE,
} from './otio-program-audio-join.ts';
import { AUDIO_ONSET_BUDGET_MS } from './otio-program-audio-signal.ts';

/** Quiet time with no new chunk before the reader is stopped. Trace drain, not a budget. */
export const AUDIO_DRAIN_QUIET_MS = 250;
/** The MediaStreamTrackProcessor maxBufferSize. Chunks are copied and closed as they arrive. */
export const AUDIO_READER_BUFFER = 512;
/** How long the early-start control waits after its element play() before the trusted click. */
export const EARLY_START_LEAD_MS = 200;
/** The window PATH.md judges after Play: the sampled audio of each ordinary trial must cover it. */
export const AUDIO_TRIAL_WINDOW_SECONDS = 4;

/** Receipt schema. Bump it whenever a saved field changes meaning. */
export const RECEIPT_SCHEMA = 'otio-program-audio-receipt/2';

const PROGRAM_RENDER = 'AudioRendererImpl::Render';
const MIXER_INPUT = 'AudioRendererMixerInput::ProvideInput';
/** Every renderer event is kept: the mark-order rule reads them and the telemetry reads Initialize. */
const RENDERER_PREFIX = 'RendererImpl::';
const REPLAY_MARKS: readonly string[] = [
  TRACE_START_MARK,
  PLAY_MARK,
  AUDIO_READER_START_MARK,
  AUDIO_CAPTURE_STOP_MARK,
  AUDIO_READER_STOP_MARK,
];
/** Numeric trace arguments the join, the telemetry and the mark-order rule read. Everything else is dropped. */
const KEPT_NUMERIC_ARGS: readonly string[] = [
  'delay (frames)',
  'playout_delay (ms)',
  'delay_timestamp (ms)',
  'rate',
];
/** A render id is kept only as a bare token, so no URL or title can ride along in it. */
const ID_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface CaptureOptions {
  /** The window the Play observer watches, from the trusted Play. */
  readonly seconds: number;
  /** Runs after the reader is installed and the Play observer is armed, before the trusted click. */
  readonly beforePlay?: ((page: ViewerPage) => Promise<void>) | undefined;
  /** Runs after beforePlay, immediately before the trusted click. */
  readonly beforeClick?: ((page: ViewerPage) => Promise<void>) | undefined;
}

interface WireChunk {
  readonly stampUs: number;
  readonly frames: number;
  readonly rate: number;
  readonly deliveredMs: number;
  readonly left: string;
  readonly right: string;
}

/** Installs the reader in the page. Each chunk's samples are copied as f32 planar and base64 coded. */
function installReader(): string {
  return `(() => {
  const video = document.querySelector('video.otio-program-video');
  if (!video) throw new Error('audio capture: program video missing');
  if (typeof video.captureStream !== 'function') throw new Error('captureStream unavailable');
  if (typeof MediaStreamTrackProcessor !== 'function') throw new Error('MediaStreamTrackProcessor unavailable');
  const track = video.captureStream().getAudioTracks()[0];
  if (!track) throw new Error('program captureStream has no audio track');
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: ${AUDIO_READER_BUFFER} }).readable.getReader();
  const chunks = [];
  const toBase64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const state = { chunks, lastAt: performance.now(), reader, loop: null };
  state.loop = (async () => {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const data = result.value;
      try {
        const frames = data.numberOfFrames;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
        data.copyTo(right, { planeIndex: data.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
        chunks.push({
          stampUs: data.timestamp,
          frames,
          rate: data.sampleRate,
          deliveredMs: performance.now(),
          left: toBase64(left),
          right: toBase64(right),
        });
        state.lastAt = performance.now();
      } finally {
        data.close();
      }
    }
  })();
  performance.mark(${JSON.stringify(AUDIO_READER_START_MARK)});
  window.__audioCapture = state;
  return true;
})()`;
}

/** Resolves once no chunk has arrived for AUDIO_DRAIN_QUIET_MS, then stops the reader. */
function drainReader(): string {
  return `(async () => {
  const capture = window.__audioCapture;
  await new Promise((resolve) => {
    const check = () => {
      if (performance.now() - capture.lastAt >= ${AUDIO_DRAIN_QUIET_MS}) resolve();
      else setTimeout(check, 25);
    };
    check();
  });
  performance.mark(${JSON.stringify(AUDIO_READER_STOP_MARK)});
  await capture.reader.cancel();
  await capture.loop;
  return true;
})()`;
}

function decodeFloat32(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/**
 * Captures the program renderer's audio for one trusted Play. Returns the record the join and the
 * gate read. The trace and the reader are stopped before it returns; nothing else is left running.
 */
export async function captureProgramAudio(
  page: ViewerPage,
  options: CaptureOptions
): Promise<CaptureRecord> {
  await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);
  await page.evaluate(`performance.mark(${JSON.stringify(TRACE_START_MARK)})`);
  await page.evaluate(installReader());
  await armPointer(page, 'button.otio-play', PLAY_MARK, options.seconds * 1000);
  if (options.beforePlay) await options.beforePlay(page);
  if (options.beforeClick) await options.beforeClick(page);
  await page.click('button.otio-play');
  const observation = await pointerObservation(page, PLAY_MARK);
  await page.evaluate(
    `performance.mark(${JSON.stringify(AUDIO_CAPTURE_STOP_MARK)})`
  );
  await page.evaluate(
    `(async () => { await window.${VIEWER_CONTRACT.hook}.pause(); })()`
  );
  await page.evaluate(drainReader());
  const wire = await page.evaluate<WireChunk[]>('window.__audioCapture.chunks');
  const done = await page.stopPerformanceTrace();
  return {
    chunks: wire.map((chunk) => ({
      stampUs: chunk.stampUs,
      frames: chunk.frames,
      rate: chunk.rate,
      deliveredMs: chunk.deliveredMs,
      left: decodeFloat32(chunk.left),
      right: decodeFloat32(chunk.right),
    })),
    events: done.events,
    truncated: done.truncated,
    dataLossOccurred: done.dataLossOccurred,
    // A missing resting read is recorded as null. The join fails closed on it.
    restCurrentTime: observation.restCurrentTime ?? null,
    observerFrames: observation.frames ?? [],
  };
}

/** One trace event as a receipt keeps it: timing, identity and numeric arguments only. */
export interface ReceiptTraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly cat?: string;
  readonly dur?: number;
  readonly pid?: number | string;
  readonly tid?: number | string;
  readonly args?: Readonly<Record<string, number | string>>;
}

/**
 * A malformed trace event keeps only its place. The join counts it as malformed, exactly as it
 * counted the original. The empty name keeps every name-keyed read safe.
 */
export interface ReceiptPlaceholder {
  readonly name: '';
  readonly malformed: true;
}

export type ReceiptEvent = ReceiptTraceEvent | ReceiptPlaceholder;

/** One reader chunk's metadata. Its PCM lives in the receipt's reader files, in delivery order. */
export interface ReceiptChunk {
  readonly stampUs: number;
  readonly frames: number;
  readonly rate: number;
  readonly deliveredMs: number;
  /** Samples saved for each channel. A capture always has frames; kept so the join replays the same. */
  readonly leftSamples: number;
  readonly rightSamples: number;
}

/** The JSON half of a receipt. The PCM is saved beside it as two little-endian f32 files. */
export interface ReceiptRecord {
  readonly chunks: readonly ReceiptChunk[];
  readonly events: readonly ReceiptEvent[];
  readonly truncated: boolean;
  readonly dataLossOccurred: boolean | null;
  readonly restCurrentTime: number | null;
  readonly observerFrames: readonly ObserverFrame[];
}

/** The event shape the join's own test accepts, read before any field is trusted. */
interface UnvalidatedEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly cat?: unknown;
  readonly dur?: unknown;
  readonly args?: unknown;
  readonly pid?: unknown;
  readonly tid?: unknown;
}

/** Mirrors the join's isTraceEvent, so an event malformed here is malformed after sanitizing too. */
function wellFormed(value: unknown): value is UnvalidatedEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (
    typeof event.name !== 'string' ||
    typeof event.ph !== 'string' ||
    typeof event.ts !== 'number'
  )
    return false;
  if (event.cat !== undefined && typeof event.cat !== 'string') return false;
  if (event.dur !== undefined && typeof event.dur !== 'number') return false;
  if (
    event.args !== undefined &&
    (typeof event.args !== 'object' || event.args === null)
  )
    return false;
  return true;
}

function wanted(name: string): boolean {
  return (
    name === PROGRAM_RENDER ||
    name === MIXER_INPUT ||
    name.startsWith(RENDERER_PREFIX) ||
    REPLAY_MARKS.includes(name) ||
    MARK_ORDER_EVENTS.includes(name)
  );
}

function isIdent(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string';
}

function keptArgs(raw: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const args = raw as Record<string, unknown>;
  for (const key of KEPT_NUMERIC_ARGS) {
    const value = args[key];
    if (typeof value === 'number') out[key] = value;
  }
  const id = args.id;
  if (typeof id === 'number' || (typeof id === 'string' && ID_TOKEN.test(id)))
    out.id = id;
  return out;
}

function keepEvent(event: UnvalidatedEvent): ReceiptTraceEvent {
  const args = keptArgs(event.args);
  return {
    name: event.name,
    ph: event.ph,
    ts: event.ts,
    ...(typeof event.cat === 'string' ? { cat: event.cat } : {}),
    ...(typeof event.dur === 'number' ? { dur: event.dur } : {}),
    ...(isIdent(event.pid) ? { pid: event.pid } : {}),
    ...(isIdent(event.tid) ? { tid: event.tid } : {}),
    ...(Object.keys(args).length > 0 ? { args } : {}),
  };
}

/**
 * The trace events a receipt keeps: the render, mixer-input, renderer and mark events the join, the
 * telemetry and the mark-order rule read. Each malformed event leaves one placeholder in place, so
 * the join counts the same malformed events after a save and reload. Idempotent.
 */
export function sanitizeEvents(events: readonly unknown[]): ReceiptEvent[] {
  const out: ReceiptEvent[] = [];
  for (const value of events) {
    if (!wellFormed(value)) {
      out.push({ name: '', malformed: true });
      continue;
    }
    if (wanted(value.name)) out.push(keepEvent(value));
  }
  return out;
}

/**
 * The record a trial is judged on and a receipt saves. Chunks are kept whole, PCM included. Events
 * are sanitized. A non-finite resting time is recorded as null, which the gate fails closed on, so
 * the judged record and the saved record never disagree.
 */
export function sanitizeRecord(record: CaptureRecord): CaptureRecord {
  const rest = record.restCurrentTime;
  return {
    chunks: record.chunks,
    events: sanitizeEvents(record.events),
    truncated: record.truncated,
    dataLossOccurred: record.dataLossOccurred,
    restCurrentTime:
      typeof rest === 'number' && Number.isFinite(rest) ? rest : null,
    observerFrames: record.observerFrames,
  };
}

/** Encodes samples as little-endian f32. NaN payloads are kept as NaN. */
export function encodeF32LE(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++)
    view.setFloat32(i * 4, samples[i] ?? 0, true);
  return out;
}

/** Decodes little-endian f32 bytes. Throws when the length is not whole samples. */
export function decodeF32LE(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0)
    throw new Error(
      `f32 file of ${bytes.byteLength} bytes is not whole samples`
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The JSON half and the two PCM halves of one record's receipt. */
function receiptOf(record: CaptureRecord): {
  json: ReceiptRecord;
  left: Uint8Array;
  right: Uint8Array;
} {
  const judged = sanitizeRecord(record);
  return {
    json: {
      chunks: judged.chunks.map((chunk) => ({
        stampUs: chunk.stampUs,
        frames: chunk.frames,
        rate: chunk.rate,
        deliveredMs: chunk.deliveredMs,
        leftSamples: chunk.left.length,
        rightSamples: chunk.right.length,
      })),
      events: sanitizeEvents(judged.events),
      truncated: judged.truncated,
      dataLossOccurred: judged.dataLossOccurred,
      restCurrentTime: judged.restCurrentTime,
      observerFrames: judged.observerFrames,
    },
    left: concatBytes(judged.chunks.map((chunk) => encodeF32LE(chunk.left))),
    right: concatBytes(judged.chunks.map((chunk) => encodeF32LE(chunk.right))),
  };
}

/** Rebuilds the record a receipt saved. Throws when the PCM does not match the chunk table. */
function recordOf(
  json: ReceiptRecord,
  left: Uint8Array,
  right: Uint8Array
): CaptureRecord {
  const leftAll = decodeF32LE(left);
  const rightAll = decodeF32LE(right);
  let l = 0;
  let r = 0;
  const chunks: CapturedChunk[] = json.chunks.map((chunk) => {
    const leftSlice = leftAll.subarray(l, l + chunk.leftSamples);
    const rightSlice = rightAll.subarray(r, r + chunk.rightSamples);
    l += chunk.leftSamples;
    r += chunk.rightSamples;
    return {
      stampUs: chunk.stampUs,
      frames: chunk.frames,
      rate: chunk.rate,
      deliveredMs: chunk.deliveredMs,
      left: leftSlice,
      right: rightSlice,
    };
  });
  if (l !== leftAll.length || r !== rightAll.length)
    throw new Error(
      `receipt PCM (${leftAll.length}/${rightAll.length} samples) does not match its chunk table (${l}/${r})`
    );
  return {
    chunks,
    events: json.events,
    truncated: json.truncated,
    dataLossOccurred: json.dataLossOccurred,
    restCurrentTime: json.restCurrentTime,
    observerFrames: json.observerFrames,
  };
}

/**
 * Saves one trial's receipt: `${base}.json` holds the meta and the record, and
 * `${base}-reader-left.f32` and `${base}-reader-right.f32` hold every reader chunk's PCM, pre-gesture
 * chunks included, in delivery order. The caller writes the gated samples.
 */
export async function writeAudioReceipt(
  base: string,
  meta: Readonly<Record<string, unknown>>,
  record: CaptureRecord
): Promise<void> {
  const { json, left, right } = receiptOf(record);
  await writeFile(
    `${base}.json`,
    JSON.stringify({ ...meta, schema: RECEIPT_SCHEMA, record: json })
  );
  await writeFile(`${base}-reader-left.f32`, left);
  await writeFile(`${base}-reader-right.f32`, right);
}

export interface AudioReceipt {
  readonly meta: Record<string, unknown>;
  readonly record: CaptureRecord;
}

/** Reads a receipt back. Fails on another schema or on PCM that does not match the record. */
export async function readAudioReceipt(base: string): Promise<AudioReceipt> {
  const { record: json, ...meta } = JSON.parse(
    await readFile(`${base}.json`, 'utf8')
  ) as Record<string, unknown>;
  if (meta.schema !== RECEIPT_SCHEMA)
    throw new Error(
      `${base}.json has schema ${String(meta.schema)}, expected ${RECEIPT_SCHEMA}`
    );
  const left = new Uint8Array(await readFile(`${base}-reader-left.f32`));
  const right = new Uint8Array(await readFile(`${base}-reader-right.f32`));
  return {
    meta,
    record: recordOf(json as ReceiptRecord, left, right),
  };
}

/** Every reader sample must be finite. A NaN passes the per-chunk correlation, so it is refused here. */
export function nonFiniteFailures(
  record: CaptureRecord,
  label: string
): string[] {
  const bad = record.chunks.filter(
    (chunk) => !allFinite(chunk.left) || !allFinite(chunk.right)
  ).length;
  return bad === 0
    ? []
    : [`${label}: ${bad} reader chunk(s) hold non-finite samples`];
}

function allFinite(samples: Float32Array): boolean {
  for (const sample of samples) if (!Number.isFinite(sample)) return false;
  return true;
}

function firstMarkTs(events: readonly unknown[], name: string): number | null {
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { name?: unknown; ts?: unknown };
    if (record.name === name && typeof record.ts === 'number') return record.ts;
  }
  return null;
}

export interface VerdictOptions {
  readonly label: string;
  readonly earlyStart: boolean;
  readonly reference: AudioReference;
}

export interface TrialVerdict {
  readonly label: string;
  readonly earlyStart: boolean;
  /** Every failure of the trial: samples, join, gate, coverage, mark order and mutation controls. */
  readonly failures: readonly string[];
  /** Early-start control failures only. Empty means the control did what it predicts. */
  readonly controlFailures: readonly string[];
  readonly gate: GateResult;
}

/**
 * The verdict of one trial, judged on the sanitized record. A receipt saves exactly that record, so
 * judging the reloaded receipt gives the same verdict.
 */
export function trialVerdict(
  record: CaptureRecord,
  options: VerdictOptions
): TrialVerdict {
  const { label, earlyStart, reference } = options;
  const judged = sanitizeRecord(record);
  const gateOptions = { reference, label };
  const gate = gateCapture(judged, gateOptions);
  const samples = nonFiniteFailures(judged, label);
  const coverage = trialCoverageFailures(judged, gate.join, label);
  const markFailures = markOrderFailures(
    judged.events as readonly TraceEvent[],
    PLAY_MARK
  );
  const controls = mutationControlFailures(judged, gateOptions);
  const failures = [
    ...samples,
    ...gate.failures,
    ...coverage,
    ...markFailures,
    ...controls,
  ];

  // Early-start control: a program render must end before the trusted Play, and the gate must
  // report it as pre-gesture audio. The control's own capture must also be finite.
  const controlFailures: string[] = [];
  if (earlyStart) {
    const playUs = firstMarkTs(judged.events, PLAY_MARK);
    const preGesture =
      playUs === null
        ? 0
        : gate.join.pairs.filter((pair) => pair.teeUs < playUs).length;
    if (preGesture === 0)
      controlFailures.push(
        'early-start control produced no program render before the trusted Play'
      );
    if (
      !gate.failures.some((failure) => failure.startsWith(PRE_GESTURE_FAILURE))
    )
      controlFailures.push(
        `early-start control did not fail as predicted: ${gate.failures.join(' | ') || 'none'}`
      );
    controlFailures.push(...samples);
  }
  return { label, earlyStart, failures, controlFailures, gate };
}

/**
 * Ordinary trials: the gated span must cover the window the proof judges after Play, the 4 s
 * PATH.md names. Empty means it does.
 */
export function trialCoverageFailures(
  record: CaptureRecord,
  join: JoinResult,
  label: string
): string[] {
  const { frames } = gatedFrames(record, join);
  const required = AUDIO_TRIAL_WINDOW_SECONDS * JOIN_RATE;
  if (frames >= required) return [];
  return [
    `${label}: gated span ${frames} frames, need ${required} for the ${AUDIO_TRIAL_WINDOW_SECONDS} s after Play`,
  ];
}

/**
 * Stage 15: the gated span must hold the whole reference from its resting start, plus the onset
 * margin on each side, so the gate scores every reference sample. Empty means it does.
 */
export function fullCoverageFailures(
  record: CaptureRecord,
  join: JoinResult,
  referenceLength: number,
  label: string
): string[] {
  const { frames, startSample } = gatedFrames(record, join);
  if (startSample === null)
    return [
      `${label}: no resting currentTime, so the reference offset is unknown`,
    ];
  const margin = Math.round((AUDIO_ONSET_BUDGET_MS * JOIN_RATE) / 1000) * 2;
  const required = referenceLength - startSample + margin;
  if (frames >= required) return [];
  return [
    `${label}: gated span ${frames} frames, need ${required} to cover the reference from sample ${startSample}`,
  ];
}

/**
 * Frames of the gated span and the reference sample it starts at. The span is the join's own
 * join.gatedChunks, the single authority the gate scores, so coverage and the saved samples cannot
 * drift from it. The start is the resting currentTime read at the trusted Play.
 */
function gatedFrames(
  record: CaptureRecord,
  join: JoinResult
): { frames: number; startSample: number | null } {
  const frames = join.gatedChunks.reduce(
    (sum, index) => sum + (record.chunks[index]?.frames ?? 0),
    0
  );
  const startSample = join.startSample;
  return { frames, startSample };
}

/** The gated span's samples for one channel, in delivery order. This is what the gate scores. */
export function gatedChannel(
  record: CaptureRecord,
  join: JoinResult,
  channel: 'left' | 'right'
): Float32Array {
  const total = gatedFrames(record, join).frames;
  const out = new Float32Array(total);
  let offset = 0;
  for (const index of join.gatedChunks) {
    const chunk = record.chunks[index];
    if (!chunk) continue;
    out.set(chunk[channel], offset);
    offset += chunk.frames;
  }
  return out;
}
