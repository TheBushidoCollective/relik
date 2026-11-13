import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OtioRationalTime, OtioTimeRange } from '@relic/format';
import {
  OTIO_AUDIO_OUTPUT_RUNNING_ADVANCE_MS,
  type OtioAudioOutputState,
} from '../src/otio-audio-output.ts';
import {
  CompositionPlaybackDisabled,
  createOtioPlaybackSession,
  createOtioProgramPlayer,
  OTIO_PROGRAM_OUTPUT_HOLD_MS,
  OTIO_PROGRAM_UNMUTE_HOLD_MS,
  type OtioPlaybackSession,
  type OtioProgramAudioOutput,
  type OtioProgramResolution,
  type ValidatedProgram,
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

/** The program's native element: events, play and pause, and a media clock the test moves. */
class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  muted = false;
  duration = 10;
  videoWidth = 16;
  videoHeight = 16;
  playbackRate = 1;
  preload = '';
  src = '';
  readyState = 0;
  /** readyState when metadata loads: 1 is HAVE_METADATA, 3 is HAVE_FUTURE_DATA. */
  metadataReadyState = 1;
  /** When set, load() stops at metadata; canPlay() fires canplay. */
  withholdCanPlay = false;
  /** Element calls in order: each play with the mute state it started under, pauses and seeks. */
  readonly calls: string[] = [];
  private time = 0;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(seconds: number) {
    this.time = seconds;
    this.calls.push('seek');
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }

  /** The media clock moves, as audio from a running output drives it. */
  advance(seconds: number): void {
    this.time += seconds;
  }

  load(): void {
    if (this.src === '') return;
    queueMicrotask(() => {
      this.readyState = this.metadataReadyState;
      this.dispatchEvent(new Event('loadedmetadata'));
      if (this.readyState >= 3 || this.withholdCanPlay) return;
      queueMicrotask(() => this.canPlay());
    });
  }

  /** The element can play: readyState reaches HAVE_FUTURE_DATA and canplay fires. */
  canPlay(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('canplay'));
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  play(): Promise<void> {
    this.calls.push(this.muted ? 'play:muted' : 'play');
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.calls.push('pause');
    this.dispatchEvent(new Event('pause'));
  }
}

interface PendingWait {
  readonly target: 'rendering' | 'running';
  readonly finish: () => void;
}

interface FakeOutput extends OtioProgramAudioOutput {
  readonly supported: boolean;
  /** Every wait the player started, in order, with the promise it got back. */
  readonly waits: {
    readonly target: 'rendering' | 'running';
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly settled: Promise<OtioAudioOutputState>;
  }[];
  /** How many times the player parked the primer. */
  readonly parks: number;
  /** Resolves when the player starts its next wait. */
  nextWait(): Promise<void>;
  /** Moves the primer to `next`; ends waits that reach their target, and every wait on idle, failed or unsupported. */
  reach(next: OtioAudioOutputState): void;
  /** Ends every pending wait as its timeout would. */
  timeOut(): void;
}

/** The primer's contract: a wait ends on reach, timeout or abort and never rejects; park goes idle. */
function fakeOutput(
  initial: OtioAudioOutputState,
  supported = true
): FakeOutput {
  let state = initial;
  let parks = 0;
  const pending = new Set<PendingWait>();
  const waits: FakeOutput['waits'] = [];
  const watchers: (() => void)[] = [];
  return {
    supported,
    get state() {
      return state;
    },
    get parks() {
      return parks;
    },
    waits,
    nextWait() {
      const { promise, resolve } = Promise.withResolvers<void>();
      watchers.push(resolve);
      return promise;
    },
    whenReached(target, { signal, timeoutMs }) {
      const { promise, resolve } =
        Promise.withResolvers<OtioAudioOutputState>();
      const wait: PendingWait = {
        target,
        finish: () => {
          if (pending.delete(wait)) resolve(state);
        },
      };
      pending.add(wait);
      signal.addEventListener('abort', wait.finish, { once: true });
      waits.push({ target, timeoutMs, signal, settled: promise });
      for (const watcher of watchers.splice(0)) watcher();
      return promise;
    },
    reach(next) {
      state = next;
      for (const wait of [...pending]) {
        const settles =
          wait.target === next ||
          (wait.target === 'rendering' && next === 'running') ||
          next === 'idle' ||
          next === 'failed' ||
          next === 'unsupported';
        if (settles) wait.finish();
      }
    },
    timeOut() {
      for (const wait of [...pending]) wait.finish();
    },
    park() {
      // As the primer does: stop, release, go idle. A failed primer stays failed.
      parks += 1;
      if (state !== 'failed') state = 'idle';
      for (const wait of [...pending]) wait.finish();
    },
  };
}

interface ProgramGlobals {
  /** Runs the animation frames requested so far. */
  runFrames(): void;
  restore(): void;
}

/** Animation frames the test runs by hand, and blob URLs for the program bytes. */
function installProgramGlobals(): ProgramGlobals {
  const frames = new Map<number, FrameRequestCallback>();
  let lastFrame = 0;
  const replaced: [object, string, unknown][] = [
    [
      globalThis,
      'requestAnimationFrame',
      (callback: FrameRequestCallback): number => {
        lastFrame += 1;
        frames.set(lastFrame, callback);
        return lastFrame;
      },
    ],
    [
      globalThis,
      'cancelAnimationFrame',
      (id: number): void => {
        frames.delete(id);
      },
    ],
    [URL, 'createObjectURL', (): string => 'blob:otio-program-test'],
    [URL, 'revokeObjectURL', (): void => {}],
  ];
  const previous = replaced.map(([target, name]) =>
    Object.getOwnPropertyDescriptor(target, name)
  );
  for (const [target, name, value] of replaced) {
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return {
    runFrames() {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(0);
    },
    restore() {
      for (const [index, [target, name]] of replaced.entries()) {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else Reflect.deleteProperty(target, name);
      }
    },
  };
}

const program: ValidatedProgram = {
  timelineId: 'timeline',
  bytes: new Uint8Array(1),
  mimeType: 'video/mp4',
  start: at(0),
  duration: at(240),
  frameRate: { num: rate, den: 1 },
  frames: 240,
  width: 16,
  height: 16,
};

async function openProgram(
  audioOutput?: OtioProgramAudioOutput,
  log: string[] = []
): Promise<{ video: FakeVideo; session: OtioPlaybackSession }> {
  const video = new FakeVideo();
  const session = await createOtioPlaybackSession({
    resolution: { status: 'available', program },
    timelineRange,
    video: video as unknown as HTMLVideoElement,
    ...(audioOutput === undefined ? {} : { audioOutput }),
    createController: () => fakeController(log),
  });
  return { video, session };
}

describe('native program and the audio output primer', () => {
  let globals: ProgramGlobals;
  beforeEach(() => {
    globals = installProgramGlobals();
  });
  afterEach(() => {
    globals.restore();
  });

  /** Opens a program on a starting primer and presses Play; resolves once play holds. */
  async function holdPlay(log: string[] = []): Promise<{
    output: FakeOutput;
    video: FakeVideo;
    session: OtioPlaybackSession;
    playing: Promise<void>;
  }> {
    const output = fakeOutput('starting');
    const { video, session } = await openProgram(output, log);
    const held = output.nextWait();
    const playing = session.play();
    await held;
    return { output, video, session, playing };
  }

  test('an unmuted play waits for a starting output to render, then buffers until the clock moves', async () => {
    const { output, video, session, playing } = await holdPlay();
    // Held: the element has not started, and the transport shows Pause and Buffering.
    expect(video.calls).toEqual([]);
    expect(output.waits).toEqual([
      expect.objectContaining({
        target: 'rendering',
        timeoutMs: OTIO_PROGRAM_OUTPUT_HOLD_MS,
      }),
    ]);
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: true,
    });
    output.reach('rendering');
    await playing;
    expect(video.calls).toEqual(['play']);
    // The element fired playing, but no audio has moved its clock yet.
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: true,
    });
    globals.runFrames();
    expect(session.getState().buffering).toBe(true);
    video.advance(0.02);
    globals.runFrames();
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: false,
    });
  });

  test('a held play that times out stays buffering through a first-buffer plateau until the clock runs', async () => {
    const { output, video, session, playing } = await holdPlay();
    output.timeOut();
    await playing;
    // Neither the timeout nor the element's playing event ends start-up.
    expect(video.calls).toEqual(['play']);
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: true,
    });
    // The stream's first buffer moves the clock, which then stalls until the device runs.
    video.advance(0.0213);
    globals.runFrames();
    expect(session.getState().buffering).toBe(true);
    video.advance(0.064);
    globals.runFrames();
    globals.runFrames();
    expect(session.getState().buffering).toBe(true);
    // The device runs, and the clock moves on past any first buffer.
    video.advance(OTIO_AUDIO_OUTPUT_RUNNING_ADVANCE_MS / 1000);
    globals.runFrames();
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: false,
    });
  });

  test('a hold that ends with the primer failed also waits out a first-buffer plateau', async () => {
    const { output, video, session, playing } = await holdPlay();
    output.reach('failed');
    await playing;
    expect(video.calls).toEqual(['play']);
    // Without the primer, the element opens its own stream and takes its first buffer.
    video.advance(0.0853);
    globals.runFrames();
    expect(session.getState().buffering).toBe(true);
    video.advance(OTIO_AUDIO_OUTPUT_RUNNING_ADVANCE_MS / 1000);
    globals.runFrames();
    expect(session.getState().buffering).toBe(false);
  });

  test('a pause during the hold cancels the play', async () => {
    const output = fakeOutput('starting');
    const { video, session } = await openProgram(output);
    const reported: boolean[] = [];
    session.subscribe((state) => reported.push(state.playing));
    const held = output.nextWait();
    const playing = session.play();
    await held;
    session.pause();
    await playing;
    expect(output.waits[0]?.signal.aborted).toBe(true);
    expect(session.getState()).toMatchObject({
      playing: false,
      buffering: false,
    });
    // An output that arrives late never starts the cancelled play.
    output.reach('running');
    expect(video.calls).toEqual([]);
    expect(output.parks).toBe(1);
    expect(reported).toEqual([false, true, false]);
  });

  test('dispose during the hold settles the play without starting the element', async () => {
    const { output, video, session, playing } = await holdPlay();
    session.dispose();
    await playing;
    expect(output.waits[0]?.signal.aborted).toBe(true);
    expect(video.calls).toEqual([]);
  });

  test('a seek during the hold starts the play, then seeks, and the wait for the clock restarts there', async () => {
    const { video, session, playing } = await holdPlay();
    const seeking = session.seek(at(48));
    await Promise.all([playing, seeking]);
    expect(video.calls).toEqual(['play', 'seek']);
    expect(session.getState().time).toEqual(at(48));
    expect(session.getState().buffering).toBe(true);
    // The primer was still starting, so one first-buffer step from the new time is not enough.
    video.advance(0.02);
    globals.runFrames();
    expect(session.getState().buffering).toBe(true);
    video.advance(OTIO_AUDIO_OUTPUT_RUNNING_ADVANCE_MS / 1000);
    globals.runFrames();
    expect(session.getState().buffering).toBe(false);
  });

  test('a focus during the hold starts the play, then focuses on original media and keeps the primer', async () => {
    const log: string[] = [];
    const { output, video, session, playing } = await holdPlay(log);
    const focusing = session.setScope(clip('clip-a', 24, 48));
    await Promise.all([playing, focusing]);
    expect(video.calls).toEqual(['play', 'pause']);
    expect(log).toContain('setScope:clip-a:end');
    expect(session.availability().state).toBe('focus-track');
    expect(output.parks).toBe(0);
  });

  test('a page pause parks the primer before the element pauses', async () => {
    const output = fakeOutput('running');
    const { video, session } = await openProgram(output);
    await session.play();
    const primerAtPause: string[] = [];
    video.addEventListener('pause', () => primerAtPause.push(output.state));
    session.pause();
    expect(primerAtPause).toEqual(['idle']);
    expect(output.parks).toBe(1);
    expect(video.calls).toEqual(['play', 'pause']);
  });

  test('pausing a paused program leaves the primer prepared', async () => {
    const output = fakeOutput('running');
    const { session } = await openProgram(output);
    session.pause();
    expect(output.parks).toBe(0);
    expect(output.state).toBe('running');
  });

  test('the end of a bounded range parks the primer before the element pauses', async () => {
    const output = fakeOutput('running');
    const { video, session } = await openProgram(output);
    await session.setScope(clip('stack', 0, 24), { source: 'program' });
    await session.play();
    const primerAtPause: string[] = [];
    video.addEventListener('pause', () => primerAtPause.push(output.state));
    video.advance(1);
    globals.runFrames();
    expect(primerAtPause).toEqual(['idle']);
    expect(output.parks).toBe(1);
    expect(video.calls).toEqual(['play', 'pause', 'seek']);
  });

  test('a muted play never waits for the output', async () => {
    const output = fakeOutput('starting');
    const { video, session } = await openProgram(output);
    session.setMuted(true);
    await session.play();
    expect(video.calls).toEqual(['play:muted']);
    expect(output.waits).toEqual([]);
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: false,
    });
  });

  test('a mute during the hold starts the play muted', async () => {
    const { video, session, playing } = await holdPlay();
    session.setMuted(true);
    await playing;
    expect(video.calls).toEqual(['play:muted']);
    expect(session.getState()).toMatchObject({
      playing: true,
      buffering: false,
    });
  });

  for (const initial of [
    undefined,
    'unsupported',
    'idle',
    'failed',
    'running',
  ] as const) {
    test(`with ${initial ?? 'no'} primer, play starts at once and never buffers`, async () => {
      const output = initial === undefined ? undefined : fakeOutput(initial);
      const { video, session } = await openProgram(output);
      const buffering: boolean[] = [];
      session.subscribe((state) => buffering.push(state.buffering));
      await session.play();
      expect(video.calls).toEqual(['play']);
      expect(output?.waits ?? []).toEqual([]);
      expect(session.getState()).toMatchObject({
        playing: true,
        buffering: false,
      });
      expect(buffering).not.toContain(true);
    });
  }

  test('a rendering output starts at once and buffers until the clock moves, and a pause clears it', async () => {
    const output = fakeOutput('rendering');
    const { video, session } = await openProgram(output);
    await session.play();
    expect(video.calls).toEqual(['play']);
    expect(output.waits).toEqual([]);
    expect(session.getState().buffering).toBe(true);
    session.pause();
    expect(session.getState()).toMatchObject({
      playing: false,
      buffering: false,
    });
  });

  /** Plays muted, then unmutes while the primer is starting. */
  async function unmuteWhileStarting(): Promise<{
    output: FakeOutput;
    video: FakeVideo;
    session: OtioPlaybackSession;
  }> {
    const output = fakeOutput('idle');
    const { video, session } = await openProgram(output);
    session.setMuted(true);
    await session.play();
    // The Unmute press arms the primer before its click unmutes.
    output.reach('starting');
    session.setMuted(false);
    return { output, video, session };
  }

  test('an unmute while playing keeps the element muted until the output runs', async () => {
    const { output, video } = await unmuteWhileStarting();
    expect(video.muted).toBe(true);
    expect(output.waits).toEqual([
      expect.objectContaining({
        target: 'running',
        timeoutMs: OTIO_PROGRAM_UNMUTE_HOLD_MS,
      }),
    ]);
    output.reach('rendering');
    expect(video.muted).toBe(true);
    output.reach('running');
    await output.waits[0]?.settled;
    expect(video.muted).toBe(false);
  });

  test('an unmute that times out unmutes anyway', async () => {
    const { output, video } = await unmuteWhileStarting();
    output.timeOut();
    await output.waits[0]?.settled;
    expect(video.muted).toBe(false);
  });

  test('a mute cancels a waiting unmute', async () => {
    const { output, video, session } = await unmuteWhileStarting();
    session.setMuted(true);
    expect(output.waits[0]?.signal.aborted).toBe(true);
    await output.waits[0]?.settled;
    output.reach('running');
    expect(video.muted).toBe(true);
  });

  test('a pause applies a waiting unmute at once', async () => {
    const { output, video, session } = await unmuteWhileStarting();
    session.pause();
    expect(video.muted).toBe(false);
    expect(output.waits[0]?.signal.aborted).toBe(true);
  });

  test('an unmute on a running output acts at once', async () => {
    const output = fakeOutput('running');
    const { video, session } = await openProgram(output);
    session.setMuted(true);
    await session.play();
    session.setMuted(false);
    expect(video.muted).toBe(false);
    expect(output.waits).toEqual([]);
  });
});

/** Drains the microtasks that load events are queued on. No wall-clock wait. */
const settleEvents = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Starts a program session without awaiting it, so a test can watch when it opens. */
function startProgram(
  video: FakeVideo,
  audioOutput?: OtioProgramAudioOutput
): { readonly session: Promise<OtioPlaybackSession>; opened(): boolean } {
  let opened = false;
  const session = createOtioPlaybackSession({
    resolution: { status: 'available', program },
    timelineRange,
    video: video as unknown as HTMLVideoElement,
    ...(audioOutput === undefined ? {} : { audioOutput }),
    createController: () => fakeController([]),
  }).then((next) => {
    opened = true;
    return next;
  });
  return { session, opened: () => opened };
}

describe('readiness and the audio output primer', () => {
  let globals: ProgramGlobals;
  beforeEach(() => {
    globals = installProgramGlobals();
  });
  afterEach(() => {
    globals.restore();
  });

  test('a supported primer opens the program only once the element can play', async () => {
    const video = new FakeVideo();
    video.withholdCanPlay = true;
    const started = startProgram(video, fakeOutput('idle', true));
    await settleEvents();
    expect(video.readyState).toBe(1);
    expect(started.opened()).toBe(false);
    // Readiness alone starts no media, whatever state the element is in.
    expect(video.calls).toEqual([]);
    video.canPlay();
    const session = await started.session;
    expect(started.opened()).toBe(true);
    expect(session.availability().state).toBe('program');
    expect(video.calls).toEqual([]);
    // Playback still starts only when the caller asks for it.
    await session.play();
    expect(video.calls).toEqual(['play']);
  });

  test('a supported primer opens at once when the element is already ready at metadata', async () => {
    const video = new FakeVideo();
    video.metadataReadyState = 3;
    const session = await startProgram(video, fakeOutput('idle', true)).session;
    expect(session.availability().state).toBe('program');
    expect(video.calls).toEqual([]);
  });

  test('an unsupported primer opens at metadata without waiting for canplay', async () => {
    const video = new FakeVideo();
    video.withholdCanPlay = true;
    const started = startProgram(video, fakeOutput('unsupported', false));
    await settleEvents();
    expect(started.opened()).toBe(true);
    expect((await started.session).availability().state).toBe('program');
  });

  test('no primer opens at metadata without waiting for canplay', async () => {
    const video = new FakeVideo();
    video.withholdCanPlay = true;
    const started = startProgram(video);
    await settleEvents();
    expect(started.opened()).toBe(true);
    expect((await started.session).availability().state).toBe('program');
  });

  test('a load error before canplay leaves the program unavailable and never pauses it', async () => {
    const video = new FakeVideo();
    video.withholdCanPlay = true;
    const started = startProgram(video, fakeOutput('idle', true));
    await settleEvents();
    expect(started.opened()).toBe(false);
    video.dispatchEvent(new Event('error'));
    const session = await started.session;
    expect(session.availability().state).toBe('unavailable');
    expect(session.availability().reasons[0]?.code).toBe('unsupported-browser');
    expect(video.calls).toEqual([]);
  });

  test('a pre-canplay error rejects ready and never reaches the failure handler', async () => {
    const video = new FakeVideo();
    video.withholdCanPlay = true;
    const failures: unknown[] = [];
    const player = createOtioProgramPlayer({
      video: video as unknown as HTMLVideoElement,
      program,
      onFailure: (reason) => {
        failures.push(reason);
      },
      audioOutput: fakeOutput('idle', true),
    });
    await settleEvents();
    video.dispatchEvent(new Event('error'));
    await expect(player.ready).rejects.toMatchObject({
      code: 'unsupported-browser',
    });
    expect(failures).toEqual([]);
    player.dispose();
  });

  test('dispose while waiting for canplay settles ready and releases the element', async () => {
    const video = new FakeVideo();
    video.withholdCanPlay = true;
    const player = createOtioProgramPlayer({
      video: video as unknown as HTMLVideoElement,
      program,
      onFailure: () => {},
      audioOutput: fakeOutput('idle', true),
    });
    await settleEvents();
    player.dispose();
    await expect(player.ready).rejects.toMatchObject({
      code: 'unsupported-browser',
    });
    expect(video.src).toBe('');
    expect(video.calls).toEqual([]);
  });

  test('a supported and an unsupported primer open the same program', async () => {
    for (const supported of [true, false]) {
      const video = new FakeVideo();
      const session = await startProgram(video, fakeOutput('idle', supported))
        .session;
      expect(session.availability().state).toBe('program');
      expect(session.getState().playing).toBe(false);
      expect(video.calls).toEqual([]);
    }
  });
});
