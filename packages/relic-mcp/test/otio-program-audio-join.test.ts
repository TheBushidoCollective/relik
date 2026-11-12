import { describe, expect, test } from 'bun:test';
import { expectedAudio } from './otio-program-reference.ts';
import { PLAY_MARK } from './otio-program-trace.ts';
import {
  AUDIO_CAPTURE_STOP_MARK,
  AUDIO_READER_START_MARK,
  AUDIO_READER_STOP_MARK,
  type AudioReference,
  type CapturedChunk,
  type CaptureRecord,
  gateCapture,
  JOIN_RATE,
  joinCapture,
  mutationControlFailures,
  type ObserverFrame,
  PRE_GESTURE_FAILURE,
} from './otio-program-audio-join.ts';

const RATE = JOIN_RATE;
const FRAMES = 1024;
const COUNT = 280;
const PERIOD_US = Math.round((FRAMES * 1_000_000) / RATE);
const PLAY_US = 1_000_000;
const FIRST_AFTER_PLAY_US = 8_800;
const TID = 7;
const MID = Math.floor(COUNT / 2);
/** The gate and the mutation controls each run several full-length signal measurements. */
const SLOW_MS = 60_000;

/**
 * The program's expected signal, indexed by program sample. It is longer than the capture so a
 * nonzero resting currentTime still has reference samples under every chunk.
 */
const EXPECTED = expectedAudio(COUNT * FRAMES + 3 * RATE);
const REFERENCE: AudioReference = { left: EXPECTED, right: EXPECTED };
const GATE = { reference: REFERENCE, label: 'program' };

/**
 * Delay frames alternate between 2000 and 3100. Each step into a 3100 frame moves the stamp back by
 * about 1.6 ms, so delivery order and stamp order disagree in real-shaped captures.
 */
function framesFor(index: number): number {
  return index % 2 === 0 ? 2000 : 3100;
}

function mark(name: string, ts: number): Record<string, unknown> {
  return { name, cat: 'blink.user_timing', ph: 'I', ts };
}

interface FixtureOptions {
  readonly firstGapUs?: number;
  readonly laterDelayMs?: number;
  readonly playUs?: number;
  readonly withPrimer?: boolean;
  readonly rebuiltAtPlay?: boolean;
  /** Resting currentTime at Play, in seconds. The first gated sample is reference sample rest * 48000. */
  readonly restSeconds?: number;
  /** Chunk 0 is silent. Silent pre-Play output does not advance program time. */
  readonly silentFirst?: boolean;
}

interface Fixture {
  readonly record: CaptureRecord;
  readonly renderTs: readonly number[];
}

/**
 * A capture shaped like the probe: a priming render with zero playout delay, a gap to the next
 * render, then renders at the chunk cadence. Each chunk's stamp is set so its tee time lands in the
 * middle of its own render's call. Samples are the expected signal from the resting sample, so the
 * gate can pass.
 */
function buildFixture(options: FixtureOptions = {}): Fixture {
  const gap = options.firstGapUs ?? 34_700;
  const delay = options.laterDelayMs ?? 56.4;
  const play = options.playUs ?? PLAY_US;
  const restSamples = Math.round((options.restSeconds ?? 0) * RATE);
  const first = PLAY_US + FIRST_AFTER_PLAY_US;
  const renderTs: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    renderTs.push(i === 0 ? first : first + gap + (i - 1) * PERIOD_US);
  }

  const events: Record<string, unknown>[] = [];
  const chunks: CapturedChunk[] = [];
  // Program time: silent pre-Play chunks do not advance it. The first audible chunk is at rest.
  let programSample = restSamples;
  for (let i = 0; i < COUNT; i++) {
    const ts = renderTs[i] ?? first;
    const frames = framesFor(i);
    events.push(
      {
        name: 'AudioRendererMixerInput::ProvideInput',
        cat: 'audio',
        ph: 'X',
        ts: ts - 200,
        dur: 1000,
        tid: TID,
        args: { 'delay (frames)': frames },
      },
      {
        name: 'AudioRendererImpl::Render',
        cat: 'audio',
        ph: 'X',
        ts,
        dur: 500,
        tid: TID,
        args: {
          id: 0,
          'delay_timestamp (ms)': ts / 1000,
          'playout_delay (ms)': i === 0 ? 0 : delay,
        },
      }
    );
    if (options.withPrimer) {
      const primer = ts + 10_000;
      events.push(
        {
          name: 'AudioRendererMixerInput::ProvideInput',
          cat: 'audio',
          ph: 'X',
          ts: primer - 200,
          dur: 1000,
          tid: TID,
          args: { 'delay (frames)': 2700 },
        },
        {
          name: 'AudioRendererImpl::Render',
          cat: 'audio',
          ph: 'X',
          ts: primer,
          dur: 500,
          tid: TID,
          args: {
            id: 1,
            'delay_timestamp (ms)': primer / 1000,
            'playout_delay (ms)': delay,
          },
        }
      );
    }
    const tee = ts + 600;
    const silent = options.silentFirst === true && i === 0;
    const from = programSample;
    if (!silent) programSample += FRAMES;
    chunks.push({
      stampUs: tee - Math.floor((frames * 1_000_000) / RATE),
      frames: FRAMES,
      rate: RATE,
      deliveredMs: (i * FRAMES * 1000) / RATE,
      left: silent
        ? new Float32Array(FRAMES)
        : REFERENCE.left.subarray(from, from + FRAMES),
      right: silent
        ? new Float32Array(FRAMES)
        : REFERENCE.right.subarray(from, from + FRAMES),
    });
  }

  const lastEnd = (renderTs[COUNT - 1] ?? first) + 500;
  events.push(
    mark(AUDIO_READER_START_MARK, PLAY_US - 500_000),
    mark(PLAY_MARK, play),
    mark(AUDIO_CAPTURE_STOP_MARK, lastEnd + 200_000),
    mark(AUDIO_READER_STOP_MARK, lastEnd + 300_000)
  );
  if (options.rebuiltAtPlay) {
    events.push({
      name: 'RendererImpl::Initialize',
      cat: 'audio',
      ph: 'X',
      ts: PLAY_US + 200,
      dur: 50,
      tid: TID,
    });
  }

  // Frames after the play: the media clock holds for one frame in two.
  const observerFrames: ObserverFrame[] = [0, 0, 1, 1, 2, 2].map(
    (frame, k) => ({
      now: PLAY_US / 1000 + k * 33.3,
      mediaTime: frame / 30,
    })
  );

  return {
    record: {
      chunks,
      events,
      truncated: false,
      dataLossOccurred: false,
      restCurrentTime: options.restSeconds ?? 0,
      observerFrames,
    },
    renderTs,
  };
}

/** Sets one chunk's stamp so its tee time, computed with the given frames, lands at teeUs. */
function withTee(
  record: CaptureRecord,
  index: number,
  teeUs: number,
  frames: number
): CaptureRecord {
  return {
    ...record,
    chunks: record.chunks.map((chunk, k) =>
      k === index
        ? { ...chunk, stampUs: teeUs - Math.floor((frames * 1_000_000) / RATE) }
        : chunk
    ),
  };
}

/** Moves every trace event with this name to a new timestamp. */
function moveMark(
  events: readonly unknown[],
  name: string,
  ts: number
): unknown[] {
  return events.map((value) =>
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === name
      ? { ...value, ts }
      : value
  );
}

/** Copies the predecessor's PCM into chunk k, keeping its count, stamp and metadata. */
function repeatPredecessor(record: CaptureRecord, k: number): CaptureRecord {
  const previous = record.chunks[k - 1];
  return {
    ...record,
    chunks: record.chunks.map((chunk, index) =>
      index === k && previous !== undefined
        ? {
            ...chunk,
            left: previous.left.slice(),
            right: previous.right.slice(),
          }
        : chunk
    ),
  };
}

const { record: CLEAN } = buildFixture();

describe('joinCapture: one-to-one pairing in delivery order', () => {
  test('a clean capture pairs every chunk with its own render', () => {
    const join = joinCapture(CLEAN);
    expect(join.failures).toEqual([]);
    expect(join.pass).toBe(true);
    expect(join.programId).toBe('0');
    expect(join.pairs.length).toBe(COUNT);
    expect(
      join.pairs.every((pair) => pair.chunkIndex === pair.renderIndex)
    ).toBe(true);
    expect(join.sampleFrames).toBe(COUNT * FRAMES);
  });

  test('the fixture has backward stamps, so pairing by stamp would be wrong', () => {
    const join = joinCapture(CLEAN);
    expect(join.telemetry?.stampBackwardSteps).toBeGreaterThan(0);
    const sorted = {
      ...CLEAN,
      chunks: [...CLEAN.chunks].sort((a, b) => a.stampUs - b.stampUs),
    };
    expect(joinCapture(sorted).pass).toBe(false);
  });

  test('a tee exactly 1 us past its call still fits', () => {
    const ts = buildFixture().renderTs[MID] ?? 0;
    const callEnd = ts + 800;
    expect(
      joinCapture(withTee(CLEAN, MID, callEnd + 1, framesFor(MID))).pass
    ).toBe(true);
  });

  test('a tee 2 us past its call fails the join', () => {
    const ts = buildFixture().renderTs[MID] ?? 0;
    const callEnd = ts + 800;
    expect(
      joinCapture(withTee(CLEAN, MID, callEnd + 2, framesFor(MID))).pass
    ).toBe(false);
  });

  test('a stamp shifted by 1 ms fails the join', () => {
    const shifted = {
      ...CLEAN,
      chunks: CLEAN.chunks.map((c, k) =>
        k === MID ? { ...c, stampUs: c.stampUs + 1000 } : c
      ),
    };
    expect(joinCapture(shifted).pass).toBe(false);
  });

  test('the rebuilt-pipeline and observer telemetry are recorded', () => {
    const rebuilt = buildFixture({ rebuiltAtPlay: true }).record;
    expect(joinCapture(rebuilt).telemetry?.pipelineRebuiltAtPlay).toBe(true);
    expect(joinCapture(CLEAN).telemetry?.pipelineRebuiltAtPlay).toBe(false);
    expect(joinCapture(CLEAN).telemetry?.observerHoldFrames).toBeGreaterThan(0);
  });
});

describe('priming telemetry: recorded, never asserted as a range', () => {
  const cases: readonly [number, number][] = [
    [34_700, 56.4],
    [265_500, 59.2],
  ];
  for (const [gapUs, delayMs] of cases) {
    test(`gap ${gapUs} us and delay ${delayMs} ms pair one-to-one`, () => {
      const { record, renderTs } = buildFixture({
        firstGapUs: gapUs,
        laterDelayMs: delayMs,
      });
      const join = joinCapture(record);
      expect(join.failures).toEqual([]);
      expect(join.telemetry?.firstRenderWasPriming).toBe(true);
      expect(join.telemetry?.primingGapMs).toBeCloseTo(gapUs / 1000, 6);
      expect(join.telemetry?.primingStepMs).toBeCloseTo(
        gapUs / 1000 - delayMs,
        6
      );
      // The removed frames are the PCM frames of render 0's chunk, not its delay frames (2000).
      const expectedPlayout =
        (renderTs[1] ?? 0) / 1000 +
        delayMs -
        (FRAMES * 1000) / RATE -
        PLAY_US / 1000;
      expect(join.telemetry?.chromeEstimatedPlayoutFirstMs).toBeCloseTo(
        expectedPlayout,
        6
      );
    });
  }
});

describe('fail closed', () => {
  test('an audible program render that ends before the play mark is pre-gesture audio', () => {
    const { record } = buildFixture({ playUs: PLAY_US + 9_500 });
    const join = joinCapture(record);
    expect(join.pass).toBe(false);
    expect(
      join.failures.some((failure) => failure.startsWith(PRE_GESTURE_FAILURE))
    ).toBe(true);
  });

  test(
    'a silent render before Play with its chunk passes the join and the gate',
    () => {
      const { record } = buildFixture({
        playUs: PLAY_US + 9_500,
        silentFirst: true,
      });
      const join = joinCapture(record);
      expect(join.failures).toEqual([]);
      expect(join.pass).toBe(true);
      expect(join.gatedChunks[0]).toBe(1);
      expect(gateCapture(record, GATE).failures).toEqual([]);
    },
    SLOW_MS
  );

  test('a silent render before Play with no chunk still fails the join', () => {
    const { record } = buildFixture({
      playUs: PLAY_US + 9_500,
      silentFirst: true,
    });
    const join = joinCapture({ ...record, chunks: record.chunks.slice(1) });
    expect(join.pass).toBe(false);
    expect(
      join.failures.some((failure) =>
        failure.includes('pre-gesture render(s) have no paired chunk')
      )
    ).toBe(true);
  });

  test('reported data loss fails', () => {
    expect(joinCapture({ ...CLEAN, dataLossOccurred: true }).pass).toBe(false);
  });

  test('unknown data loss fails', () => {
    expect(joinCapture({ ...CLEAN, dataLossOccurred: null }).pass).toBe(false);
  });

  test('a truncated trace fails', () => {
    const join = joinCapture({ ...CLEAN, truncated: true });
    expect(join.pass).toBe(false);
    expect(join.failures.some((failure) => failure.includes('truncated'))).toBe(
      true
    );
  });

  test('a missing mark fails', () => {
    const events = CLEAN.events.filter(
      (value) =>
        !(
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          value.name === AUDIO_READER_STOP_MARK
        )
    );
    const join = joinCapture({ ...CLEAN, events });
    expect(join.pass).toBe(false);
    expect(
      join.failures.some((failure) => failure.startsWith('marks missing'))
    ).toBe(true);
  });

  test('malformed trace events fail', () => {
    const join = joinCapture({
      ...CLEAN,
      events: [...CLEAN.events, 42, { name: 'no ph or ts' }],
    });
    expect(join.pass).toBe(false);
    expect(
      join.failures.some((failure) => failure.includes('not trace events'))
    ).toBe(true);
  });

  test('a chunk at the wrong sample rate fails', () => {
    const chunks = CLEAN.chunks.map((chunk, k) =>
      k === 3 ? { ...chunk, rate: 44100 } : chunk
    );
    expect(joinCapture({ ...CLEAN, chunks }).pass).toBe(false);
  });
});

describe('gateCapture: resting currentTime aligns the span', () => {
  test(
    'the expected samples pass the gate on both channels at rest 0',
    () => {
      const gate = gateCapture(CLEAN, GATE);
      expect(gate.failures).toEqual([]);
      expect(gate.evidence).not.toBeNull();
    },
    SLOW_MS
  );

  test(
    'a nonzero resting currentTime with its matching samples passes',
    () => {
      const { record } = buildFixture({ restSeconds: 0.5 });
      const gate = gateCapture(record, GATE);
      expect(gate.join.pass).toBe(true);
      expect(gate.failures).toEqual([]);
    },
    SLOW_MS
  );

  test(
    'a resting currentTime of 2 s over chunks that begin at reference 0 fails',
    () => {
      const gate = gateCapture({ ...CLEAN, restCurrentTime: 2 }, GATE);
      expect(gate.join.pass).toBe(true);
      expect(gate.failures.length).toBeGreaterThan(0);
      expect(gate.evidence).not.toBeNull();
    },
    SLOW_MS
  );

  test(
    'a null resting currentTime fails and measures nothing',
    () => {
      const gate = gateCapture({ ...CLEAN, restCurrentTime: null }, GATE);
      expect(
        gate.failures.some((failure) => failure.includes('resting currentTime'))
      ).toBe(true);
      expect(gate.evidence).toBeNull();
    },
    SLOW_MS
  );

  test(
    'a negative resting currentTime fails',
    () => {
      const gate = gateCapture({ ...CLEAN, restCurrentTime: -1 }, GATE);
      expect(
        gate.failures.some((failure) => failure.includes('resting currentTime'))
      ).toBe(true);
      expect(gate.evidence).toBeNull();
    },
    SLOW_MS
  );

  test(
    'a non-finite resting currentTime fails',
    () => {
      const gate = gateCapture({ ...CLEAN, restCurrentTime: Number.NaN }, GATE);
      expect(
        gate.failures.some((failure) => failure.includes('resting currentTime'))
      ).toBe(true);
      expect(gate.evidence).toBeNull();
    },
    SLOW_MS
  );
});

describe('gateCapture: the gated span runs from Play to the capture stop', () => {
  test(
    'capture stop moved to play plus 1 ms leaves no gated span and fails the gate',
    () => {
      const events = moveMark(
        CLEAN.events,
        AUDIO_CAPTURE_STOP_MARK,
        PLAY_US + 1000
      );
      const gate = gateCapture({ ...CLEAN, events }, GATE);
      expect(gate.join.pass).toBe(true);
      expect(gate.join.gatedChunks).toEqual([]);
      expect(
        gate.failures.some((failure) => failure.includes('no gated span'))
      ).toBe(true);
      expect(gate.evidence).toBeNull();
    },
    SLOW_MS
  );

  test(
    'two zeroed chunks fail the sampled gate while pairing still passes',
    () => {
      const chunks = CLEAN.chunks.map((chunk, k) =>
        k === 100 || k === 101
          ? {
              ...chunk,
              left: new Float32Array(FRAMES),
              right: new Float32Array(FRAMES),
            }
          : chunk
      );
      const gate = gateCapture({ ...CLEAN, chunks }, GATE);
      expect(gate.join.pass).toBe(true);
      expect(gate.failures.length).toBeGreaterThan(0);
    },
    SLOW_MS
  );

  test('a chunk whose samples do not match its frame count fails before measuring', () => {
    const chunks = CLEAN.chunks.map((chunk, k) =>
      k === 5 ? { ...chunk, left: chunk.left.slice(0, FRAMES - 1) } : chunk
    );
    const gate = gateCapture({ ...CLEAN, chunks }, GATE);
    expect(gate.join.pass).toBe(false);
    expect(gate.evidence).toBeNull();
  });

  test(
    'a repeated predecessor chunk passes the join and fails the gate as not matching the program audio',
    () => {
      const record = repeatPredecessor(CLEAN, MID);
      const gate = gateCapture(record, GATE);
      expect(gate.join.pass).toBe(true);
      expect(
        gate.failures.some((failure) =>
          failure.includes('does not match the program audio')
        )
      ).toBe(true);
    },
    SLOW_MS
  );
});

describe('mutation controls', () => {
  test(
    'every control is rejected at its own layer on the primer capture',
    () => {
      const { record } = buildFixture({ withPrimer: true });
      expect(mutationControlFailures(record, GATE)).toEqual([]);
    },
    SLOW_MS
  );

  test(
    'optional controls with no precondition are skipped, not failed',
    () => {
      expect(mutationControlFailures(CLEAN, GATE)).toEqual([]);
    },
    SLOW_MS
  );

  test(
    'a capture that fails the clean gate is reported, not passed',
    () => {
      const failures = mutationControlFailures(
        { ...CLEAN, restCurrentTime: null },
        GATE
      );
      expect(
        failures.some((failure) =>
          failure.startsWith('clean capture does not pass')
        )
      ).toBe(true);
    },
    SLOW_MS
  );
});
