import { describe, expect, test } from 'bun:test';
import type { OtioRationalTime, OtioTimeRange } from '@relic/format';
import {
  createOtioPlaybackSession,
  reasonCodeForError,
  type OtioProgramResolution,
} from '../src/otio-program.ts';
import type {
  OtioPlaybackController,
  OtioPlaybackScope,
  OtioPlaybackState,
} from '../src/otio-playback.ts';

const rate = 24;
const timelineRange: OtioTimeRange = {
  start_time: { value: 0, rate },
  duration: { value: 240, rate },
};
const at = (frame: number): OtioRationalTime => ({ value: frame, rate });
const clip = (
  nodeId: string,
  start: number,
  length: number
): OtioPlaybackScope => ({
  nodeId,
  range: { start_time: at(start), duration: at(length) },
});
const unavailable: OtioProgramResolution = {
  status: 'unavailable',
  reasons: [{ code: 'unsupported-codec', message: 'no codec' }],
};

const deferred = (): { promise: Promise<void>; release: () => void } => {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

interface Gates {
  readonly setScope?: Promise<void>;
  readonly seek?: Promise<void>;
}

/** Records every call in `log`. Gates hold a call open until released, to model a slow render. */
function fakeController(
  log: string[],
  gates: Gates = {}
): OtioPlaybackController {
  let time = at(0);
  let scope: OtioPlaybackScope | null = null;
  const state = (): OtioPlaybackState => ({
    time,
    scope,
    playing: false,
    buffering: false,
    duration: timelineRange.duration,
    rate,
    diagnostics: [],
    tracks: {},
    baseMediaPreviewAllowed: false,
    previewBlocked: false,
    graphicsFailed: false,
  });
  return {
    getState: state,
    async play() {
      log.push('play');
    },
    pause() {
      log.push('pause');
    },
    async seek(next) {
      log.push(`seek:${next.value}`);
      if (gates.seek) await gates.seek;
      time = next;
      log.push(`seek:${next.value}:end`);
    },
    async setScope(next) {
      log.push(`setScope:${next?.nodeId ?? 'null'}`);
      if (gates.setScope) await gates.setScope;
      scope = next;
    },
    setBaseMediaPreviewAllowed() {},
    async prepareAudioContextChange() {},
    subscribe: () => () => {},
    setTrackVisibility() {},
    setTrackMute() {},
    setTrackSolo() {},
    dispose() {
      log.push('dispose');
    },
  };
}

describe('legacy calls go straight to the existing controller', () => {
  test('a seek is not queued behind a slow seek', async () => {
    const log: string[] = [];
    const gate = deferred();
    const session = await createOtioPlaybackSession({
      resolution: { status: 'legacy' },
      timelineRange,
      createController: () => fakeController(log, { seek: gate.promise }),
    });
    const first = session.seek(at(10));
    const second = session.seek(at(20));
    // Both reach the controller before either slow seek finishes.
    expect(log).toEqual(['seek:10', 'seek:20']);
    gate.release();
    await Promise.all([first, second]);
  });
});

describe('focused seeks coalesce', () => {
  test('only the newest seek reaches the controller', async () => {
    const log: string[] = [];
    const gate = deferred();
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController(log, { setScope: gate.promise }),
    });
    const focusing = session.setScope(clip('clip-a', 0, 120));
    const seeks = [
      session.seek(at(10)),
      session.seek(at(20)),
      session.seek(at(30)),
    ];
    gate.release();
    await Promise.all([focusing, ...seeks]);
    expect(log).toContain('seek:30');
    expect(log).not.toContain('seek:10');
    expect(log).not.toContain('seek:20');
  });
});

describe('pause cancels a queued play', () => {
  test('play queued behind a focus change does not start after a later pause', async () => {
    const log: string[] = [];
    const gate = deferred();
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController(log, { setScope: gate.promise }),
    });
    const focusing = session.setScope(clip('clip-a', 0, 120));
    const playing = session.play();
    session.pause();
    gate.release();
    await focusing;
    await playing;
    expect(log).not.toContain('play');
  });
});

describe('reason codes map to spec names', () => {
  test('a format error code passes through', () => {
    const error = Object.assign(new Error('digest'), {
      code: 'digest-mismatch',
    });
    expect(reasonCodeForError(error)).toBe('digest-mismatch');
  });

  test('a decompression limit maps to size-cap-exceeded', () => {
    const error = Object.assign(new Error('limit'), {
      code: 'decompression-limit',
    });
    expect(reasonCodeForError(error)).toBe('size-cap-exceeded');
  });

  test('a ZIP read error maps to archive-mismatch, never leaking its own code', () => {
    const error = Object.assign(new Error('crc'), { code: 'corrupt-archive' });
    expect(reasonCodeForError(error)).toBe('archive-mismatch');
    expect(
      reasonCodeForError(
        Object.assign(new Error('x'), { code: 'unsupported-zip' })
      )
    ).toBe('archive-mismatch');
  });

  test('a non-error value maps to archive-mismatch', () => {
    expect(reasonCodeForError('boom')).toBe('archive-mismatch');
  });
});

describe('subscribe and positioning', () => {
  test('subscribe delivers the current state immediately', async () => {
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController([]),
    });
    const seen: OtioPlaybackState[] = [];
    session.subscribe((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rate).toBe(rate);
  });

  test('an unavailable composition clamps idle seeks into the composition range', async () => {
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController([]),
    });
    await session.seek(at(-50));
    expect(session.getState().time.value).toBe(0);
    await session.seek(at(9999));
    expect(session.getState().time.value).toBe(240);
    expect(session.getState().time.rate).toBe(rate);
  });
});
