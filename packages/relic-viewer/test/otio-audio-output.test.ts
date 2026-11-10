import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  createOtioAudioOutput,
  OTIO_AUDIO_OUTPUT_IDLE_MS,
  otioAudioOutputSupported,
  type OtioAudioOutputState,
} from '../src/otio-audio-output';

type Nav = {
  userActivation?: { isActive: boolean };
  userAgentData?: { mobile: boolean };
};
type Listener = (e: { type: string; isTrusted: boolean }) => void;

function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

// Mirrors the element behaviour the module relies on. play() dispatches play,
// pause() rejects a pending play() with AbortError and dispatches pause, and a
// system resume dispatches play without a play() call from the module.
class MockVideo {
  media = 0;
  seeks: number[] = [];
  get currentTime(): number {
    return this.media;
  }
  set currentTime(v: number) {
    this.seeks.push(v);
    this.media = v;
  }
  duration = Number.NaN;
  paused = true;
  muted = true;
  volume = 0;
  src = '';
  preload = 'none';
  loop = false;
  playsInline = false;
  disablePictureInPicture = false;
  disableRemotePlayback = false;
  log: string[] = [];
  playCalls = 0;
  private pending: { reject(e: unknown): void } | null = null;
  private handlers = new Map<string, Set<() => void>>();

  play(): Promise<void> {
    this.playCalls++;
    this.log.push('play');
    this.paused = false;
    // The promise is registered before the event, as in Chrome: a pause()
    // dispatched from inside a play listener must be able to reject it.
    const { promise, reject } = Promise.withResolvers<void>();
    this.pending = { reject };
    this.emit('play');
    return promise;
  }

  pause(): void {
    if (this.paused) return;
    this.log.push('pause');
    this.paused = true;
    const p = this.pending;
    this.pending = null;
    p?.reject(domError('AbortError'));
    this.emit('pause');
  }

  // A system resume (media key, headset) plays the element without a play() call
  // from the module. It dispatches a play event, and nothing else.
  systemPlay(): void {
    this.paused = false;
    this.emit('play');
  }

  load(): void {
    this.log.push('load');
  }

  removeAttribute(name: string): void {
    if (name !== 'src') return;
    this.src = '';
    this.log.push('removeSrc');
  }

  addEventListener(type: string, fn: () => void): void {
    const set = this.handlers.get(type) ?? new Set<() => void>();
    set.add(fn);
    this.handlers.set(type, set);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.handlers.get(type)?.delete(fn);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  emit(type: string): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn();
  }

  // Test control: the browser rejects the pending play() with this error name.
  rejectPlay(name: string): void {
    this.paused = true;
    const p = this.pending;
    this.pending = null;
    p?.reject(domError(name));
  }
}

class MockDocument {
  hidden = false;
  visibilityState: 'visible' | 'hidden' = 'visible';
  readonly defaultView: { navigator: Nav };
  appended: unknown[] = [];
  private handlers = new Map<string, Set<Listener>>();

  constructor(nav: Nav) {
    this.defaultView = { navigator: nav };
  }

  appendChild(node: unknown): unknown {
    this.appended.push(node);
    return node;
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.handlers.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.handlers.set(type, set);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.handlers.get(type)?.delete(fn);
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  dispatch(type: string, isTrusted = true): void {
    for (const fn of [...(this.handlers.get(type) ?? [])])
      fn({ type, isTrusted });
  }
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
let createdBlobs: Blob[] = [];
let revoked: string[] = [];

beforeAll(() => {
  URL.createObjectURL = ((blob: Blob) => {
    createdBlobs.push(blob);
    return `blob:primer-${createdBlobs.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterAll(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

beforeEach(() => {
  createdBlobs = [];
  revoked = [];
});

const teardown: Array<() => void> = [];
afterEach(() => {
  for (const f of teardown.splice(0)) f();
});

// Replaces the global timers with a clock the test moves by hand.
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = ++seq;
    timers.set(id, { at: t + Math.max(0, ms), fn });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    now: () => t,
    timers: () => timers.size,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at))
            due = entry;
        }
        if (due === undefined) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

function setup(opts: { supported?: boolean; nav?: Nav } = {}) {
  const clock = fakeClock();
  const frames = new Map<number, () => void>();
  let frameSeq = 0;
  const videos: MockVideo[] = [];
  const doc = new MockDocument(
    opts.nav ?? { userActivation: { isActive: true } }
  );
  const busy = { value: false };
  const out = createOtioAudioOutput({
    document: doc as unknown as Document,
    supported: opts.supported ?? true,
    isBusy: () => busy.value,
    createElement: () => {
      const v = new MockVideo();
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
    now: clock.now,
    requestFrame: (cb) => {
      const id = ++frameSeq;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  const states: OtioAudioOutputState[] = [];
  out.subscribe((s) => states.push(s));
  teardown.push(() => {
    out.dispose();
    clock.restore();
  });

  const flush = () => {
    const batch = [...frames.values()];
    frames.clear();
    for (const cb of batch) cb();
  };
  // The most recently created element.
  const video = (): MockVideo => videos[videos.length - 1]!;
  // One sample: the element reads `media` at the frame and at a timeupdate.
  // Running samples only on timeupdate and the stall timer, so both are fired.
  const sample = (media: number) => {
    video().media = media;
    clock.advance(16);
    flush();
    video().emit('timeupdate');
  };
  const frameAt = (media: number) => sample(media);
  // Samples every 16 ms for `ms`. `media` maps elapsed time to currentTime.
  const run = (ms: number, media?: (elapsed: number) => number) => {
    for (let e = 16; e <= ms; e += 16) {
      if (media) video().media = media(e);
      clock.advance(16);
      flush();
      video().emit('timeupdate');
    }
  };
  const gesture = (type = 'pointerdown', trusted = true) =>
    doc.dispatch(type, trusted);

  return {
    out,
    doc,
    clock,
    frames,
    videos,
    video,
    states,
    busy,
    flush,
    frameAt,
    run,
    gesture,
  };
}

function ready(opts: { nav?: Nav } = {}) {
  const s = setup(opts);
  s.out.setProgramAvailable(true);
  return s;
}

// Lets promise reactions (play() rejections) run.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('setup', () => {
  test('creates a detached, unmuted, volume-one element and never plays it', async () => {
    const s = ready();
    s.run(2000);
    const v = s.video();
    expect(s.out.state).toBe('idle');
    expect(v.muted).toBe(false);
    expect(v.volume).toBe(1);
    expect(v.preload).toBe('auto');
    expect(v.playsInline).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.disablePictureInPicture).toBe(true);
    expect(v.disableRemotePlayback).toBe(true);
    expect(v.src).toBe('blob:primer-1');
    expect(v.playCalls).toBe(0);
    expect(s.doc.appended).toEqual([]);

    const blob = createdBlobs[0]!;
    expect(blob.type).toBe('video/mp4');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe('ftyp');
  });

  test('unsupported gate keeps the primer inert: no element, no listeners', () => {
    const s = setup({ supported: false });
    s.out.setProgramAvailable(true);
    expect(s.out.state).toBe('unsupported');
    expect(s.videos).toHaveLength(0);
    expect(s.doc.listenerCount()).toBe(0);
    s.gesture();
    expect(s.out.state).toBe('unsupported');
    expect(s.videos).toHaveLength(0);
  });

  test('dispose with the gate closed touches nothing on the document', () => {
    const s = setup({ supported: false });
    s.out.setProgramAvailable(true);
    s.out.dispose();
    expect(s.doc.listenerCount()).toBe(0);
    expect(s.videos).toHaveLength(0);
  });

  test('supported only for desktop user agents', () => {
    expect(otioAudioOutputSupported({ userAgentData: { mobile: false } })).toBe(
      true
    );
    expect(otioAudioOutputSupported({ userAgentData: { mobile: true } })).toBe(
      false
    );
    expect(otioAudioOutputSupported({})).toBe(false);
  });

  test('the element is unmuted: the only muted assignment in the source is the unmute line', async () => {
    const source = await Bun.file(
      new URL('../src/otio-audio-output.ts', import.meta.url)
    ).text();
    const lines = source.split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l === 'element.muted = false;')).toHaveLength(1);
    expect(lines.filter((l) => l === 'element.muted = true;')).toHaveLength(0);
  });
});

describe('arming', () => {
  test('a gesture before the program is available does nothing', () => {
    const s = setup();
    s.gesture();
    expect(s.videos).toHaveLength(0);
    expect(s.doc.listenerCount()).toBe(0);
    expect(s.out.state).toBe('unsupported');
  });

  test('untrusted events never call play()', () => {
    const s = ready();
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'click'])
      s.gesture(type, false);
    s.run(500);
    expect(s.video().playCalls).toBe(0);
    expect(s.out.state).toBe('idle');
  });

  test('inactive user activation never calls play(), and active activation does', () => {
    const s = ready();
    s.doc.defaultView.navigator.userActivation = { isActive: false };
    s.gesture();
    expect(s.video().playCalls).toBe(0);
    s.doc.defaultView.navigator.userActivation = { isActive: true };
    s.gesture();
    expect(s.video().playCalls).toBe(1);
  });

  test('a trusted gesture calls play() synchronously and reads starting on return', () => {
    const s = ready();
    s.gesture();
    expect(s.video().playCalls).toBe(1);
    expect(s.out.state).toBe('starting');
  });

  test('every trusted gesture type arms the primer', () => {
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'click']) {
      const s = ready();
      s.gesture(type);
      expect(s.video().playCalls).toBe(1);
    }
  });

  test('a repeated gesture while playing does not call play() again', () => {
    const s = ready();
    s.gesture();
    s.gesture('pointerup');
    s.gesture('click');
    expect(s.video().playCalls).toBe(1);
  });
});

describe('progress and plateaus', () => {
  for (const plateau of [0.0213, 0.0427, 0.0853]) {
    test(`a first-buffer-only plateau at ${plateau} s never reaches running`, async () => {
      const s = ready();
      s.gesture();
      const waiting = s.out.whenReached('running', {
        signal: new AbortController().signal,
        timeoutMs: 4000,
      });
      s.video().media = plateau;
      s.run(4000);
      expect(s.out.state).toBe('rendering');
      expect(s.states).not.toContain('running');
      expect(await waiting).toBe('rendering');
    });
  }

  test('sustained advance reaches rendering, then running', async () => {
    const s = ready();
    s.gesture();
    const waiting = s.out.whenReached('running', {
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    s.run(300, (e) => e / 1000);
    expect(s.out.state).toBe('running');
    expect(await waiting).toBe('running');
  });

  test('a frozen media clock never leaves starting, however long the wall clock runs', () => {
    const s = ready();
    s.gesture();
    s.run(10_000, () => 0);
    expect(s.out.state).toBe('starting');
    expect(s.states).not.toContain('rendering');
  });

  test('a running primer drops back to rendering after 1000 ms without advance', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    expect(s.out.state).toBe('running');
    s.clock.advance(500);
    expect(s.out.state).toBe('running');
    s.clock.advance(1000);
    expect(s.out.state).toBe('rendering');
  });

  test('a backward jump starts a new baseline and is not counted as progress', () => {
    const s = ready();
    s.gesture();
    s.frameAt(0.1);
    expect(s.out.state).toBe('rendering');
    s.frameAt(0);
    s.frameAt(0.04);
    // 0.1 + 0.04 = 140 ms, short of 150 ms. Counting the jump would reach running.
    expect(s.out.state).toBe('rendering');
  });

  test('seek before the end lands at zero once and is never counted as progress', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    expect(s.out.state).toBe('running');
    s.frameAt(3.6);
    expect(s.video().seeks).toEqual([0]);
    expect(s.video().media).toBe(0);
    // Chrome has not applied the seek yet: the element still reads near the end.
    s.frameAt(3.6);
    s.frameAt(3.6);
    expect(s.video().seeks).toEqual([0]);
    expect(s.out.state).toBe('running');
    // The seek lands, then playback continues from zero.
    s.frameAt(0.016);
    s.frameAt(0.032);
    expect(s.video().seeks).toEqual([0]);
    expect(s.out.state).toBe('running');
  });
});

describe('play() outcomes', () => {
  test('NotAllowedError fails and releases the element; a later trusted gesture re-arms a fresh one', async () => {
    const s = ready();
    s.gesture();
    const first = s.video();
    const url = first.src;
    first.rejectPlay('NotAllowedError');
    await settle();
    expect(s.out.state).toBe('failed');
    expect(first.src).toBe('');
    expect(revoked).toEqual([url]);
    s.gesture();
    expect(s.videos).toHaveLength(2);
    expect(s.video().playCalls).toBe(1);
    expect(s.out.state).toBe('starting');
  });

  test('AbortError returns to idle and releases the element', async () => {
    const s = ready();
    s.gesture();
    const first = s.video();
    first.rejectPlay('AbortError');
    await settle();
    expect(s.out.state).toBe('idle');
    expect(first.src).toBe('');
  });

  test('an element error fails and releases it; a later gesture re-arms', async () => {
    const s = ready();
    s.gesture();
    s.video().emit('error');
    await settle();
    expect(s.out.state).toBe('failed');
    s.gesture();
    expect(s.videos).toHaveLength(2);
    expect(s.video().playCalls).toBe(1);
  });
});

describe('visibility and idle', () => {
  test('hiding the page releases the element and goes idle; showing it does not resume', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    const first = s.video();
    s.doc.hidden = true;
    s.doc.visibilityState = 'hidden';
    s.doc.dispatch('visibilitychange');
    expect(first.paused).toBe(true);
    expect(first.src).toBe('');
    expect(s.out.state).toBe('idle');
    s.doc.hidden = false;
    s.doc.visibilityState = 'visible';
    s.doc.dispatch('visibilitychange');
    s.run(500);
    expect(s.videos).toHaveLength(1);
    expect(first.playCalls).toBe(1);
    expect(s.out.state).toBe('idle');
  });

  test('hiding the page also releases a preloaded, never-played element', () => {
    const s = ready();
    const first = s.video();
    s.doc.hidden = true;
    s.doc.visibilityState = 'hidden';
    s.doc.dispatch('visibilitychange');
    expect(first.src).toBe('');
    expect(revoked).toEqual(['blob:primer-1']);
    expect(s.out.state).toBe('idle');
  });

  test('the idle cap stops and releases the primer after 60 s without a trusted gesture', () => {
    const s = ready();
    s.gesture();
    const first = s.video();
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS - 1);
    expect(first.paused).toBe(false);
    s.clock.advance(1);
    expect(first.paused).toBe(true);
    expect(first.src).toBe('');
    expect(s.out.state).toBe('idle');
  });

  test('an untrusted event does not reset the idle cap', () => {
    const s = ready();
    s.gesture();
    const first = s.video();
    s.clock.advance(30_000);
    s.gesture('pointerdown', false);
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS - 30_000);
    expect(first.paused).toBe(true);
    expect(s.out.state).toBe('idle');
  });

  test('a trusted gesture resets the idle cap', () => {
    const s = ready();
    s.gesture();
    const first = s.video();
    s.clock.advance(50_000);
    s.gesture();
    s.clock.advance(50_000);
    expect(first.paused).toBe(false);
    expect(first.playCalls).toBe(1);
    s.clock.advance(10_000);
    expect(first.paused).toBe(true);
    expect(s.out.state).toBe('idle');
  });

  test('a busy program keeps the primer past the cap, and it is released once busy clears', () => {
    const s = ready();
    s.busy.value = true;
    s.gesture();
    const first = s.video();
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS + 5_000);
    expect(first.paused).toBe(false);
    s.busy.value = false;
    s.clock.advance(1000);
    expect(first.paused).toBe(true);
    expect(first.src).toBe('');
    expect(s.out.state).toBe('idle');
  });
});

describe('release and re-arm', () => {
  test('idle revokes the blob URL, clears the source, and drops every element listener', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    const v = s.video();
    const url = v.src;
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS);
    expect(revoked).toEqual([url]);
    expect(v.src).toBe('');
    expect(v.listenerCount()).toBe(0);
    expect(s.out.state).toBe('idle');
    expect(s.frames.size).toBe(0);
    expect(s.clock.timers()).toBe(0);
  });

  test('nothing restarts the primer by itself after it is released', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS);
    s.clock.advance(10 * 60_000);
    s.flush();
    expect(s.videos).toHaveLength(1);
    expect(s.video().playCalls).toBe(1);
    expect(s.out.state).toBe('idle');
    expect(s.frames.size).toBe(0);
    expect(s.clock.timers()).toBe(0);
  });

  test('a fresh trusted gesture recreates the element and plays it in the same synchronous call', () => {
    const s = ready();
    s.gesture();
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS);
    expect(s.out.state).toBe('idle');
    s.gesture();
    expect(s.videos).toHaveLength(2);
    expect(s.video().playCalls).toBe(1);
    expect(s.video().paused).toBe(false);
    expect(s.video().src).toBe('blob:primer-2');
    expect(createdBlobs).toHaveLength(2);
    expect(s.out.state).toBe('starting');
  });

  test('an untrusted gesture after release creates nothing', () => {
    const s = ready();
    s.gesture();
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS);
    s.gesture('pointerdown', false);
    expect(s.videos).toHaveLength(1);
    expect(s.out.state).toBe('idle');
  });

  test('an inactive activation after release creates nothing', () => {
    const s = ready();
    s.gesture();
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS);
    s.doc.defaultView.navigator.userActivation = { isActive: false };
    s.gesture();
    expect(s.videos).toHaveLength(1);
    expect(s.out.state).toBe('idle');
  });

  test('document listeners stay attached while the program is available', () => {
    const s = ready();
    expect(s.doc.listenerCount()).toBe(5);
    s.gesture();
    s.clock.advance(OTIO_AUDIO_OUTPUT_IDLE_MS);
    expect(s.doc.listenerCount()).toBe(5);
    s.gesture();
    expect(s.video().playCalls).toBe(1);
  });

  test('a system pause releases the primer, and a later gesture plays a fresh one', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    const first = s.video();
    first.pause();
    expect(s.out.state).toBe('idle');
    expect(first.src).toBe('');
    expect(first.listenerCount()).toBe(0);
    s.gesture();
    expect(s.videos).toHaveLength(2);
    expect(s.video().playCalls).toBe(1);
    expect(s.out.state).toBe('starting');
  });
});

describe('media-session resumes', () => {
  test('a system resume with nothing wanted is pulled back on an idle preloaded element', () => {
    const s = ready();
    const v = s.video();
    const stateCount = s.states.length;
    v.systemPlay();
    // The guard paused once. The pause event it dispatched reached onPause, which did nothing.
    expect(v.paused).toBe(true);
    expect(v.log).toEqual(['pause']);
    expect(s.states.length).toBe(stateCount);
    expect(s.out.state).toBe('idle');
    expect(v.playCalls).toBe(0);
    expect(s.videos).toHaveLength(1);
  });

  test('a pulled-back resume leaves no frames or timers behind, however long it runs', () => {
    const s = ready();
    s.video().systemPlay();
    expect(s.frames.size).toBe(0);
    expect(s.clock.timers()).toBe(0);
    s.clock.advance(120_000);
    s.run(500, (e) => e / 1000);
    expect(s.video().paused).toBe(true);
    expect(s.out.state).toBe('idle');
    expect(s.frames.size).toBe(0);
    expect(s.clock.timers()).toBe(0);
    expect(s.videos).toHaveLength(1);
  });

  test('a system resume on a released primer reaches nothing and cannot restart it', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    const v = s.video();
    v.pause();
    v.systemPlay();
    expect(v.src).toBe('');
    expect(v.listenerCount()).toBe(0);
    expect(v.playCalls).toBe(1);
    expect(s.videos).toHaveLength(1);
    expect(s.out.state).toBe('idle');
    expect(s.clock.timers()).toBe(0);
  });

  test('a system resume while a gesture wants playback is left alone', () => {
    const s = ready();
    s.gesture();
    const v = s.video();
    const logLength = v.log.length;
    v.systemPlay();
    expect(v.paused).toBe(false);
    expect(v.log.slice(logLength)).toEqual([]);
    expect(s.out.state).toBe('starting');
    expect(v.playCalls).toBe(1);
  });

  test('a trusted gesture still starts the same primer after a pulled-back resume', () => {
    const s = ready();
    s.video().systemPlay();
    expect(s.video().paused).toBe(true);
    s.gesture();
    expect(s.videos).toHaveLength(1);
    expect(s.video().paused).toBe(false);
    expect(s.video().playCalls).toBe(1);
    expect(s.out.state).toBe('starting');
  });

  test('dispose removes the listeners, so a later resume is not touched', () => {
    const s = ready();
    const v = s.video();
    s.out.dispose();
    const logLength = v.log.length;
    v.systemPlay();
    expect(v.paused).toBe(false);
    expect(v.log.slice(logLength)).toEqual([]);
  });

  test('losing the program removes the listeners, so a later resume is not touched', () => {
    const s = ready();
    const v = s.video();
    s.out.setProgramAvailable(false);
    const logLength = v.log.length;
    v.systemPlay();
    expect(v.paused).toBe(false);
    expect(v.log.slice(logLength)).toEqual([]);
  });
});

describe('whenReached', () => {
  test('resolves with rendering once reached', async () => {
    const s = ready();
    s.gesture();
    const waiting = s.out.whenReached('rendering', {
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    s.frameAt(0.02);
    expect(await waiting).toBe('rendering');
  });

  test('resolves early with failed when play() is rejected while waiting for running', async () => {
    const s = ready();
    s.gesture();
    const waiting = s.out.whenReached('running', {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    s.video().rejectPlay('NotAllowedError');
    await settle();
    expect(await waiting).toBe('failed');
  });

  test('resolves with the current state on timeout', async () => {
    const s = ready();
    s.gesture();
    const waiting = s.out.whenReached('rendering', {
      signal: new AbortController().signal,
      timeoutMs: 250,
    });
    s.clock.advance(250);
    expect(await waiting).toBe('starting');
    expect(s.out.state).toBe('starting');
  });

  test('resolves with the current state on abort, without rejecting', async () => {
    const s = ready();
    s.gesture();
    const controller = new AbortController();
    const waiting = s.out.whenReached('rendering', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();
    expect(await waiting).toBe('starting');
  });

  test('resolves at once from a terminal state, and when the timeout is zero', async () => {
    const s = ready();
    const signal = new AbortController().signal;
    expect(
      await s.out.whenReached('running', { signal, timeoutMs: 1000 })
    ).toBe('idle');
    s.gesture();
    expect(await s.out.whenReached('rendering', { signal, timeoutMs: 0 })).toBe(
      'starting'
    );
    const closed = setup({ supported: false });
    expect(
      await closed.out.whenReached('rendering', { signal, timeoutMs: 1000 })
    ).toBe('unsupported');
  });

  test('rendering is reached by a primer that is already running', async () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    expect(
      await s.out.whenReached('rendering', {
        signal: new AbortController().signal,
        timeoutMs: 1000,
      })
    ).toBe('running');
  });
});

describe('lifetime', () => {
  test('dispose pauses, removes src, reloads, revokes the URL, unhooks, and leaves no frames or timers', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    expect(s.frames.size + s.clock.timers()).toBeGreaterThan(0);
    const v = s.video();
    const url = v.src;

    s.out.dispose();

    expect(v.paused).toBe(true);
    expect(v.src).toBe('');
    expect(v.log.slice(-3)).toEqual(['pause', 'removeSrc', 'load']);
    expect(revoked).toEqual([url]);
    expect(s.doc.listenerCount()).toBe(0);
    expect(v.listenerCount()).toBe(0);
    expect(s.frames.size).toBe(0);
    expect(s.clock.timers()).toBe(0);
    expect(s.out.state).toBe('unsupported');

    s.gesture();
    s.out.setProgramAvailable(true);
    expect(v.playCalls).toBe(1);
    expect(s.videos).toHaveLength(1);
  });

  test('losing the program releases the element the same way; regaining it prepares an idle one', () => {
    const s = ready();
    s.gesture();
    s.run(300, (e) => e / 1000);
    const v = s.video();
    const url = v.src;
    s.out.setProgramAvailable(false);
    expect(v.paused).toBe(true);
    expect(v.src).toBe('');
    expect(revoked).toEqual([url]);
    expect(s.doc.listenerCount()).toBe(0);
    expect(s.clock.timers()).toBe(0);
    expect(s.out.state).toBe('unsupported');

    s.out.setProgramAvailable(true);
    expect(s.videos).toHaveLength(2);
    expect(s.out.state).toBe('idle');
    expect(s.video().playCalls).toBe(0);
    expect(s.doc.listenerCount()).toBe(5);
  });

  test('subscribers hear each change once and stop after unsubscribing', () => {
    const s = setup();
    s.out.setProgramAvailable(true);
    expect(s.states).toEqual(['idle']);
    const seen: OtioAudioOutputState[] = [];
    const unsubscribe = s.out.subscribe((state) => seen.push(state));
    s.gesture();
    expect(seen).toEqual(['starting']);
    unsubscribe();
    s.out.setProgramAvailable(false);
    expect(seen).toEqual(['starting']);
  });
});
