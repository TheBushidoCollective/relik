import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ReceiptEvent,
  type ReceiptTraceEvent,
  readAudioReceipt,
  sanitizeEvents,
  type TrialVerdict,
  trialVerdict,
  writeAudioReceipt,
} from './otio-program-audio-capture.ts';
import {
  AUDIO_CAPTURE_STOP_MARK,
  AUDIO_READER_START_MARK,
  AUDIO_READER_STOP_MARK,
  type AudioReference,
  type CapturedChunk,
  type CaptureRecord,
  JOIN_RATE,
  joinCapture,
  PRE_GESTURE_FAILURE,
} from './otio-program-audio-join.ts';
import { expectedAudio } from './otio-program-reference.ts';
import {
  markOrderFailures,
  PLAY_MARK,
  type TraceEvent,
} from './otio-program-trace.ts';

/*
 * Synthetic fixture only. The samples are slices of the program's own expected signal, and the
 * trace is built here. Nothing is captured from a browser, and everything is written to a scratch
 * directory that is removed afterwards.
 */

const RATE = JOIN_RATE;
const FRAMES = 1024;
const COUNT = 280;
const PERIOD_US = Math.round((FRAMES * 1_000_000) / RATE);
const PLAY_US = 1_000_000;
const FIRST_AFTER_PLAY_US = 8_800;
const GAP_US = 34_700;
const EARLY_PLAY_OFFSET_US = 9_500;
const TID = 7;
const PID = 4242;
const PROGRAM_RENDER = 'AudioRendererImpl::Render';
const MIXER_INPUT = 'AudioRendererMixerInput::ProvideInput';
const RATE_EVENT = 'RendererImpl::SetPlaybackRate';
/** Each mutation control re-runs the gate over a full capture, so these tests take minutes. */
const SLOW_MS = 300_000;

const EXPECTED = expectedAudio(COUNT * FRAMES + 3 * RATE);
const REFERENCE: AudioReference = { left: EXPECTED, right: EXPECTED };

interface BuildOptions {
  /**
   * The first chunk renders audibly before the trusted Play. The program has advanced by that
   * chunk, so the resting time at Play is one chunk in.
   */
  readonly preGesture?: boolean;
  /** Index of a chunk whose first left sample is NaN. */
  readonly nanChunk?: number;
  /** A nonzero playback rate this many microseconds before the play mark. */
  readonly rateBeforePlayUs?: number;
  /** Extra trace events appended to the trace. */
  readonly extraEvents?: readonly unknown[];
}

function mark(name: string, ts: number): Record<string, unknown> {
  return { name, cat: 'blink.user_timing', ph: 'I', ts, pid: PID, tid: TID };
}

/** Delay frames alternate, so delivery order and stamp order disagree, as in real captures. */
function framesFor(index: number): number {
  return index % 2 === 0 ? 2000 : 3100;
}

function buildCapture(options: BuildOptions = {}): CaptureRecord {
  const play = options.preGesture ? PLAY_US + EARLY_PLAY_OFFSET_US : PLAY_US;
  const first = PLAY_US + FIRST_AFTER_PLAY_US;
  const renderTs: number[] = [];
  for (let i = 0; i < COUNT; i++)
    renderTs.push(i === 0 ? first : first + GAP_US + (i - 1) * PERIOD_US);

  const events: unknown[] = [];
  const chunks: CapturedChunk[] = [];
  let from = 0;
  for (let i = 0; i < COUNT; i++) {
    const ts = renderTs[i] ?? first;
    const frames = framesFor(i);
    events.push(
      {
        name: MIXER_INPUT,
        cat: 'audio',
        ph: 'X',
        ts: ts - 200,
        dur: 1000,
        pid: PID,
        tid: TID,
        args: { 'delay (frames)': frames },
      },
      {
        name: PROGRAM_RENDER,
        cat: 'audio',
        ph: 'X',
        ts,
        dur: 500,
        pid: PID,
        tid: TID,
        args: {
          id: 0,
          'delay_timestamp (ms)': ts / 1000,
          'playout_delay (ms)': i === 0 ? 0 : 56.4,
        },
      }
    );
    // The chunk's tee time is its stamp plus its delay frames, and must fall inside its render's call.
    const tee = ts + 600;
    const left = EXPECTED.slice(from, from + FRAMES);
    chunks.push({
      stampUs: tee - Math.floor((frames * 1_000_000) / RATE),
      frames: FRAMES,
      rate: RATE,
      deliveredMs: (i * FRAMES * 1000) / RATE,
      left,
      right: left.slice(),
    });
    from += FRAMES;
  }

  if (options.nanChunk !== undefined) {
    const target = chunks[options.nanChunk];
    if (target) target.left[0] = Number.NaN;
  }

  const lastEnd = (renderTs[COUNT - 1] ?? first) + 500;
  events.push(
    mark(AUDIO_READER_START_MARK, PLAY_US - 500_000),
    mark(PLAY_MARK, play),
    mark(AUDIO_CAPTURE_STOP_MARK, lastEnd + 200_000),
    mark(AUDIO_READER_STOP_MARK, lastEnd + 300_000),
    // Chrome's own trace noise: a navigation carrying a URL and a title. Neither may reach a receipt.
    {
      name: 'Page::navigate',
      cat: 'devtools.timeline',
      ph: 'X',
      ts: 5_000,
      dur: 1,
      pid: PID,
      tid: TID,
      args: {
        url: 'https://example.invalid/private-title',
        title: 'Private Title',
      },
    }
  );
  if (options.rateBeforePlayUs !== undefined)
    events.push({
      name: RATE_EVENT,
      cat: 'media',
      ph: 'X',
      ts: play - options.rateBeforePlayUs,
      dur: 1,
      pid: PID,
      tid: TID,
      args: { rate: 1 },
    });
  events.push(...(options.extraEvents ?? []));

  return {
    chunks,
    events,
    truncated: false,
    dataLossOccurred: false,
    restCurrentTime: options.preGesture ? FRAMES / RATE : 0,
    observerFrames: [0, 0, 1, 1, 2, 2].map((frame, k) => ({
      now: PLAY_US / 1000 + k * 33.3,
      mediaTime: frame / 30,
    })),
  };
}

function sameSamples(a: Float32Array, b: Float32Array): boolean {
  return (
    a.length === b.length && a.every((sample, k) => Object.is(sample, b[k]))
  );
}

const dir = await mkdtemp(join(tmpdir(), 'relic-audio-receipt-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface RoundTrip {
  /** The verdict of the record as captured, judged in memory. */
  readonly live: TrialVerdict;
  /** The verdict of the record read back from the receipt. */
  readonly replay: TrialVerdict;
  readonly meta: Record<string, unknown>;
  readonly reloaded: CaptureRecord;
  readonly base: string;
}

async function roundTrip(
  name: string,
  record: CaptureRecord,
  earlyStart: boolean
): Promise<RoundTrip> {
  const label = `replay ${name}`;
  const live = trialVerdict(record, {
    label,
    earlyStart,
    reference: REFERENCE,
  });
  const base = join(dir, name);
  await writeAudioReceipt(
    base,
    {
      label,
      earlyStart,
      failures: live.failures,
      controlFailures: live.controlFailures,
    },
    record
  );
  const { meta, record: reloaded } = await readAudioReceipt(base);
  const replay = trialVerdict(reloaded, {
    label: String(meta.label),
    earlyStart: meta.earlyStart === true,
    reference: REFERENCE,
  });
  return { live, replay, meta, reloaded, base };
}

const runs = new Map<string, Promise<RoundTrip>>();
function memo(key: string, make: () => Promise<RoundTrip>): Promise<RoundTrip> {
  let run = runs.get(key);
  if (run === undefined) {
    run = make();
    runs.set(key, run);
  }
  return run;
}

const clean = () =>
  memo('clean', () => roundTrip('clean', buildCapture(), false));
const early = () =>
  memo('early-start', () =>
    roundTrip('early-start', buildCapture({ preGesture: true }), true)
  );
const nanFault = () =>
  memo('nan', () => roundTrip('nan', buildCapture({ nanChunk: 100 }), false));

describe('a receipt replays the verdict it was judged on', () => {
  test(
    'a clean capture gives the same verdict live and after save and reload',
    async () => {
      const run = await clean();
      expect(run.live.failures).toEqual([]);
      expect(run.replay.failures).toEqual(run.live.failures);
      expect(run.meta.failures).toEqual(run.live.failures);
      expect(run.replay.gate.join.gatedChunks).toEqual(
        run.live.gate.join.gatedChunks
      );
      expect(run.replay.gate.join.pairs).toEqual(run.live.gate.join.pairs);
      expect(run.replay.gate.join.startSample).toBe(
        run.live.gate.join.startSample
      );
      expect(run.replay.gate.join.programId).toBe(run.live.gate.join.programId);
    },
    SLOW_MS
  );

  test(
    'an early start keeps its pre-gesture prediction after save and reload',
    async () => {
      const run = await early();
      expect(run.live.controlFailures).toEqual([]);
      expect(
        run.live.failures.some((failure) =>
          failure.startsWith(PRE_GESTURE_FAILURE)
        )
      ).toBe(true);
      expect(run.replay.controlFailures).toEqual([]);
      expect(run.replay.controlFailures).toEqual(run.live.controlFailures);
      expect(run.replay.failures).toEqual(run.live.failures);
    },
    SLOW_MS
  );

  test(
    'a NaN fault keeps its failure and its NaN after save and reload',
    async () => {
      const run = await nanFault();
      expect(
        run.live.failures.some((failure) =>
          failure.includes('non-finite samples')
        )
      ).toBe(true);
      expect(run.replay.failures).toEqual(run.live.failures);
      expect(run.meta.failures).toEqual(run.live.failures);
      expect(run.reloaded.chunks[100]?.left[0]).toBeNaN();
    },
    SLOW_MS
  );
});

describe('what a receipt keeps', () => {
  test(
    'every reader chunk survives, pre-gesture chunks included',
    async () => {
      const run = await early();
      const original = buildCapture({ preGesture: true });
      expect(run.reloaded.chunks.length).toBe(original.chunks.length);
      const identical = run.reloaded.chunks.every((chunk, k) => {
        const source = original.chunks[k];
        return (
          source !== undefined &&
          chunk.frames === source.frames &&
          chunk.stampUs === source.stampUs &&
          chunk.deliveredMs === source.deliveredMs &&
          sameSamples(chunk.left, source.left) &&
          sameSamples(chunk.right, source.right)
        );
      });
      expect(identical).toBe(true);
      const bytes = await readFile(`${run.base}-reader-left.f32`);
      const samples = original.chunks.reduce(
        (sum, chunk) => sum + chunk.left.length,
        0
      );
      expect(bytes.byteLength).toBe(samples * 4);
    },
    SLOW_MS
  );

  test(
    'trace timing and numeric arguments are kept, and no URL or title reaches disk',
    async () => {
      const run = await clean();
      const text = await readFile(`${run.base}.json`, 'utf8');
      expect(text).not.toContain('example.invalid');
      expect(text).not.toContain('Private Title');
      const events = run.reloaded.events as readonly ReceiptEvent[];
      expect(events.some((event) => event.name === 'Page::navigate')).toBe(
        false
      );
      const render = events.find(
        (event): event is ReceiptTraceEvent =>
          'ph' in event && event.name === PROGRAM_RENDER
      );
      expect(render).toMatchObject({
        name: PROGRAM_RENDER,
        ph: 'X',
        cat: 'audio',
        dur: 500,
        pid: PID,
        tid: TID,
        args: { id: 0, 'playout_delay (ms)': 0 },
      });
      const playMark = events.find(
        (event): event is ReceiptTraceEvent =>
          'ph' in event && event.name === PLAY_MARK
      );
      expect(playMark).toMatchObject({ ph: 'I', cat: 'blink.user_timing' });
    },
    SLOW_MS
  );

  test('a render id that carries a URL or a title is dropped, a bare id is kept', () => {
    const kept = sanitizeEvents([
      {
        name: PROGRAM_RENDER,
        ph: 'X',
        ts: 1,
        args: { id: 'https://example.invalid/x', 'delay (frames)': 7 },
      },
      {
        name: PROGRAM_RENDER,
        ph: 'X',
        ts: 2,
        args: { id: 'render-3', 'delay (frames)': 7 },
      },
    ]);
    expect(kept[0]).toMatchObject({ args: { 'delay (frames)': 7 } });
    expect(kept[0]).not.toHaveProperty('args.id');
    expect(kept[1]).toMatchObject({ args: { id: 'render-3' } });
  });

  test('sanitizing is idempotent and leaves one placeholder per malformed event', () => {
    const once = sanitizeEvents([
      42,
      mark(PLAY_MARK, 5),
      { name: 'no ph or ts' },
      { name: PROGRAM_RENDER, ph: 'X', ts: 1, args: { id: 0 } },
    ]);
    expect(once.length).toBe(4);
    expect(once[0]).toEqual({ name: '', malformed: true });
    expect(once[2]).toEqual({ name: '', malformed: true });
    expect(sanitizeEvents(once)).toEqual(once);
  });
});

describe('fault verdicts survive the round trip', () => {
  test('malformed events, a truncated trace and unknown data loss keep their join failures', async () => {
    const record: CaptureRecord = {
      ...buildCapture({ extraEvents: [42, { name: 'no ph or ts' }] }),
      truncated: true,
      dataLossOccurred: null,
    };
    const base = join(dir, 'malformed');
    await writeAudioReceipt(base, {}, record);
    const { record: reloaded } = await readAudioReceipt(base);
    const live = joinCapture(record);
    expect(
      live.failures.some((failure) => failure.includes('not trace events'))
    ).toBe(true);
    expect(live.failures.some((failure) => failure.includes('truncated'))).toBe(
      true
    );
    expect(joinCapture(reloaded).failures).toEqual(live.failures);
  });

  test('a playback rate before the play mark keeps its mark-order failure after reload', async () => {
    const record = buildCapture({ rateBeforePlayUs: 2_000 });
    const base = join(dir, 'mark-order');
    await writeAudioReceipt(base, {}, record);
    const { record: reloaded } = await readAudioReceipt(base);
    const live = markOrderFailures(
      record.events as readonly TraceEvent[],
      PLAY_MARK
    );
    expect(live.some((failure) => failure.includes(RATE_EVENT))).toBe(true);
    expect(
      markOrderFailures(reloaded.events as readonly TraceEvent[], PLAY_MARK)
    ).toEqual(live);
  });
});

describe('the decoder fails closed', () => {
  test('PCM that does not match its chunk table is refused', async () => {
    const base = join(dir, 'mismatch');
    await writeAudioReceipt(base, {}, buildCapture({ preGesture: true }));
    const bytes = await readFile(`${base}-reader-left.f32`);
    await truncate(`${base}-reader-left.f32`, bytes.byteLength - 4);
    await expect(readAudioReceipt(base)).rejects.toThrow(
      'does not match its chunk table'
    );
  });

  test('a receipt of another schema is refused before its PCM is read', async () => {
    const base = join(dir, 'old-schema');
    await writeFile(
      `${base}.json`,
      JSON.stringify({ schema: 'old', record: {} })
    );
    await expect(readAudioReceipt(base)).rejects.toThrow('expected');
  });
});
