import { describe, expect, test } from 'bun:test';
import type { OtioRationalTime, OtioTimeRange } from '@relic/format';
import {
  CompositionPlaybackDisabled,
  createOtioPlaybackSession,
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

interface FakeOptions {
  readonly failSetScope?: boolean;
  /** When set, setScope waits on this gate before it commits. */
  readonly gate?: Promise<void>;
}

/** Records every call into `log` so tests can assert ordering. */
function fakeController(
  log: string[],
  options: FakeOptions = {}
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
      time = next;
    },
    async setScope(next) {
      log.push(`setScope:${next?.nodeId ?? 'null'}:start`);
      if (options.gate) await options.gate;
      if (options.failSetScope) throw new Error('boom');
      scope = next;
      log.push(`setScope:${next?.nodeId ?? 'null'}:end`);
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

describe('unavailable composition', () => {
  test('creates no controller at open and rejects composition play', async () => {
    const log: string[] = [];
    let created = 0;
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => {
        created += 1;
        return fakeController(log);
      },
    });
    expect(created).toBe(0);
    expect(session.availability().state).toBe('unavailable');
    expect(session.availability().compositionPlayable).toBe(false);
    await expect(session.play()).rejects.toBeInstanceOf(
      CompositionPlaybackDisabled
    );
  });

  test('a focused track sets its scope before any seek', async () => {
    const log: string[] = [];
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController(log),
    });
    await session.setScope(clip('clip-a', 24, 48));
    const scopeAt = log.indexOf('setScope:clip-a:end');
    const seekAt = log.findIndex((entry) => entry.startsWith('seek:'));
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(seekAt).toBeGreaterThan(scopeAt);
    expect(session.availability().state).toBe('focus-track');
  });

  test('a rejected focus rolls back and leaves composition unplayable', async () => {
    const log: string[] = [];
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController(log, { failSetScope: true }),
    });
    await expect(session.setScope(clip('clip-a', 24, 48))).rejects.toThrow(
      'boom'
    );
    expect(session.availability().state).toBe('unavailable');
    expect(log).toContain('dispose');
    expect(session.getState().scope).toBeNull();
  });

  test('program-bounded scope is refused when the composition has no program', async () => {
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController([]),
    });
    await expect(
      session.setScope(clip('stack', 0, 240), { source: 'program' })
    ).rejects.toBeInstanceOf(CompositionPlaybackDisabled);
  });
});

describe('transitions', () => {
  test('transitions run in call order, and seek waits for a pending scope', async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: () => fakeController(log, { gate }),
    });
    const first = session.setScope(clip('clip-a', 0, 48));
    const second = session.setScope(clip('clip-b', 48, 48));
    const seeking = session.seek(at(60));
    release();
    await Promise.all([first, second, seeking]);
    const startA = log.indexOf('setScope:clip-a:start');
    const endA = log.indexOf('setScope:clip-a:end');
    const startB = log.indexOf('setScope:clip-b:start');
    const seekAt = log.indexOf('seek:60');
    expect(startA).toBeLessThan(endA);
    expect(endA).toBeLessThan(startB);
    expect(startB).toBeLessThan(seekAt);
    expect(session.getState().scope?.nodeId).toBe('clip-b');
  });

  test('a failed transition does not block the next one', async () => {
    const log: string[] = [];
    let failNext = true;
    const controllerFactory = (): OtioPlaybackController => {
      const inner = fakeController(log);
      const failing = failNext;
      failNext = false;
      return failing
        ? {
            ...inner,
            setScope: async () => Promise.reject(new Error('first fails')),
          }
        : inner;
    };
    const session = await createOtioPlaybackSession({
      resolution: unavailable,
      timelineRange,
      createController: controllerFactory,
    });
    const first = session.setScope(clip('clip-a', 0, 48));
    const second = session.setScope(clip('clip-b', 48, 48));
    await expect(first).rejects.toThrow('first fails');
    await second;
    expect(session.getState().scope?.nodeId).toBe('clip-b');
  });
});

describe('legacy composition', () => {
  test('creates the existing controller at open and delegates play', async () => {
    const log: string[] = [];
    let created = 0;
    const session = await createOtioPlaybackSession({
      resolution: { status: 'legacy' },
      timelineRange,
      createController: () => {
        created += 1;
        return fakeController(log);
      },
    });
    expect(created).toBe(1);
    expect(session.availability().state).toBe('legacy');
    expect(session.availability().compositionPlayable).toBe(true);
    await session.play();
    expect(log).toContain('play');
  });
});
