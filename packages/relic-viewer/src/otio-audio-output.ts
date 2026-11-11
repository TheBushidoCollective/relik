import { otioAudioPrimerBlob } from './otio-audio-primer-media';

export type OtioAudioOutputState =
  | 'unsupported'
  | 'idle'
  | 'starting'
  | 'rendering'
  | 'running'
  | 'failed';

export const OTIO_AUDIO_OUTPUT_ATTRIBUTE = 'data-otio-audio-output';
export const OTIO_AUDIO_OUTPUT_IDLE_MS = 60_000;
export const OTIO_AUDIO_OUTPUT_RUNNING_ADVANCE_MS = 150;

// Length of the silent primer in otio-audio-primer-media (4 s).
const PRIMER_SECONDS = 4;
// Running needs an advance this recent, and drops back after this long without one.
const RUNNING_RECENT_MS = 100;
const RUNNING_STALL_MS = 1000;
// A busy program keeps the primer alive; the idle cap is re-checked at this interval.
const BUSY_RECHECK_MS = 1000;
// Seek back to zero this long before the end, so the mixer never sees end-of-stream.
const SEEK_LEAD_S = 0.5;
const GESTURE_EVENTS = [
  'pointerdown',
  'pointerup',
  'keydown',
  'click',
] as const;
// States from which a wait for 'rendering' or 'running' can never succeed.
const TERMINAL: Record<OtioAudioOutputState, boolean> = {
  unsupported: true,
  idle: true,
  starting: false,
  rendering: false,
  running: false,
  failed: true,
};

interface NavigatorLike {
  userAgentData?: { mobile?: boolean };
  userActivation?: { isActive?: boolean };
}

export function otioAudioOutputSupported(
  nav: NavigatorLike | undefined = globalThis.navigator
): boolean {
  return nav?.userAgentData?.mobile === false;
}

export interface OtioAudioOutput {
  /** Whether this browser can run the primer. A supported program waits for canplay before it is ready. */
  readonly supported: boolean;
  readonly state: OtioAudioOutputState;
  whenReached(
    target: 'rendering' | 'running',
    o: { readonly signal: AbortSignal; readonly timeoutMs: number }
  ): Promise<OtioAudioOutputState>;
  setProgramAvailable(available: boolean): void;
  subscribe(l: (s: OtioAudioOutputState) => void): () => void;
  // Releases the primer at once: stops playback, drops the element and its blob
  // URL, and goes idle (a failed primer stays failed). A no-op without an available program.
  park(): void;
  dispose(): void;
}

interface Waiter {
  readonly target: 'rendering' | 'running';
  finish(state: OtioAudioOutputState): void;
}

// A wait ends early once the target can no longer be reached from this state.
function settled(
  target: 'rendering' | 'running',
  s: OtioAudioOutputState
): boolean {
  return (
    s === target || (target === 'rendering' && s === 'running') || TERMINAL[s]
  );
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err
    ? String(err.name)
    : '';
}

// Lifecycle: the element exists only while it is wanted or preloaded. Hiding the
// page, the idle cap, a system pause, a failure, or losing the program releases
// it (no source, no listeners, blob URL revoked). A trusted active gesture is the
// only thing that creates it again, synchronously, and it plays in that same call.
export function createOtioAudioOutput(o: {
  document: Document;
  supported: boolean;
  isBusy: () => boolean;
  createElement?: () => HTMLVideoElement;
  now?: () => number;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}): OtioAudioOutput {
  const doc = o.document;
  const now = o.now ?? (() => performance.now());
  const requestFrame =
    o.requestFrame ?? ((cb: () => void) => requestAnimationFrame(() => cb()));
  const cancelFrame =
    o.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));
  const makeElement = o.createElement ?? (() => doc.createElement('video'));

  let state: OtioAudioOutputState = 'unsupported';
  let programAvailable = false;
  let documentAttached = false;
  let disposed = false;
  let element: HTMLVideoElement | null = null;
  let objectUrl: string | null = null;
  // True while the primer should be playing. Every callback checks it first.
  let wanted = false;
  // Bumped on every start and stop. Stale play() promises and frames are ignored.
  let generation = 0;
  // A seek to zero was requested and its landing is not yet observed.
  let seekPending = false;
  let frameId: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  // Progress counts only the element's own currentTime, never the wall clock.
  let lastTime = 0;
  let advanceS = 0;
  let lastAdvanceAt = 0;
  const subscribers = new Set<(s: OtioAudioOutputState) => void>();
  const waiters = new Set<Waiter>();

  function setState(next: OtioAudioOutputState): void {
    if (next === state) return;
    state = next;
    for (const l of [...subscribers]) l(next);
    for (const w of [...waiters]) if (settled(w.target, next)) w.finish(next);
  }

  function cancelFrameLoop(): void {
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
  }

  function scheduleFrame(): void {
    if (
      frameId !== null ||
      !wanted ||
      (state !== 'starting' && state !== 'rendering')
    )
      return;
    const gen = generation;
    frameId = requestFrame(() => {
      frameId = null;
      if (gen !== generation) return;
      observe();
      scheduleFrame();
    });
  }

  function armStall(): void {
    clearTimeout(stallTimer);
    const delay = Math.max(1, lastAdvanceAt + RUNNING_STALL_MS - now());
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      observe();
    }, delay);
  }

  function observe(): void {
    const el = element;
    if (!wanted || el === null) return;
    const t = el.currentTime;
    if (!Number.isFinite(t) || t < 0) return;
    const at = now();
    const seekAt = PRIMER_SECONDS - SEEK_LEAD_S;
    const seekLanding = seekPending && t >= seekAt;
    if (seekPending && !seekLanding) seekPending = false;
    if (!seekLanding) {
      if (t > lastTime) {
        advanceS += t - lastTime;
        lastTime = t;
        lastAdvanceAt = at;
      } else if (t < lastTime) {
        // A loop or a seek back starts a new baseline. It is not progress.
        lastTime = t;
      }
    }
    if (state === 'starting' && advanceS > 0) setState('rendering');
    if (
      state === 'rendering' &&
      advanceS * 1000 >= OTIO_AUDIO_OUTPUT_RUNNING_ADVANCE_MS &&
      at - lastAdvanceAt <= RUNNING_RECENT_MS
    )
      setState('running');
    if (state === 'running' && at - lastAdvanceAt >= RUNNING_STALL_MS) {
      // The stalled advance no longer counts. Otherwise one step after the stall
      // re-asserts running without the 150 ms check.
      advanceS = 0;
      setState('rendering');
    }
    // A subscriber may have disposed or parked the primer during the transitions.
    if (!wanted || element !== el) return;
    if (state === 'running') {
      cancelFrameLoop();
      armStall();
    } else {
      clearTimeout(stallTimer);
      stallTimer = undefined;
      scheduleFrame();
    }
    if (!seekLanding && t >= seekAt) {
      el.currentTime = 0;
      seekPending = true;
      lastTime = 0;
    }
  }

  // Stops the wanted playback. The element stays in place, paused.
  function stopPlayback(): void {
    generation++;
    wanted = false;
    seekPending = false;
    cancelFrameLoop();
    clearTimeout(idleTimer);
    clearTimeout(stallTimer);
    idleTimer = undefined;
    stallTimer = undefined;
    if (element !== null && !element.paused) element.pause();
  }

  function onPlay(): void {
    // The media session can resume the element outside this module (a headset
    // or keyboard play key). Only startPlayback may play it, so any play while
    // nothing is wanted is pulled back. pause() does not dispatch play, so this
    // cannot recurse, and the pause event it queues reaches onPause, which does
    // nothing once wanted is false.
    if (!wanted && element !== null) element.pause();
  }

  function onPause(): void {
    // A system pause during playback parks the primer, so nothing restarts it.
    if (wanted && element?.paused) parkIdle();
  }

  function onError(): void {
    if (element !== null) fail();
  }

  function attachElement(el: HTMLVideoElement): void {
    el.addEventListener('timeupdate', observe);
    el.addEventListener('error', onError);
    el.addEventListener('pause', onPause);
    el.addEventListener('play', onPlay);
  }

  function detachElement(el: HTMLVideoElement): void {
    el.removeEventListener('timeupdate', observe);
    el.removeEventListener('error', onError);
    el.removeEventListener('pause', onPause);
    el.removeEventListener('play', onPlay);
  }

  // Creates the element with its source, and makes it the current element.
  function createPrimer(): HTMLVideoElement {
    element = makeElement();
    element.muted = false;
    element.volume = 1;
    element.preload = 'auto';
    element.playsInline = true;
    element.loop = true;
    element.disablePictureInPicture = true;
    element.disableRemotePlayback = true;
    objectUrl = URL.createObjectURL(otioAudioPrimerBlob());
    element.src = objectUrl;
    attachElement(element);
    return element;
  }

  // Drops the element, its source and its blob URL. Safe to call when none exists.
  function releaseElement(): void {
    const el = element;
    if (el === null) return;
    element = null;
    detachElement(el);
    if (!el.paused) el.pause();
    el.removeAttribute('src');
    el.load();
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  // Stops, releases the element, and goes idle. A failed primer stays failed.
  function parkIdle(): void {
    stopPlayback();
    releaseElement();
    if (state !== 'failed') setState('idle');
  }

  function fail(): void {
    stopPlayback();
    releaseElement();
    setState('failed');
  }

  function touchIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdleDeadline, OTIO_AUDIO_OUTPUT_IDLE_MS);
  }

  function onIdleDeadline(): void {
    idleTimer = undefined;
    if (!wanted) return;
    if (o.isBusy()) {
      idleTimer = setTimeout(onIdleDeadline, BUSY_RECHECK_MS);
      return;
    }
    parkIdle();
  }

  function startPlayback(el: HTMLVideoElement): void {
    const gen = ++generation;
    wanted = true;
    seekPending = false;
    lastTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    advanceS = 0;
    lastAdvanceAt = now();
    setState('starting');
    cancelFrameLoop();
    scheduleFrame();
    let pending: Promise<void> | undefined;
    try {
      pending = el.play();
    } catch {
      fail();
      return;
    }
    pending?.then(undefined, (err: unknown) => {
      if (gen !== generation) return;
      if (errorName(err) === 'AbortError') parkIdle();
      else fail();
    });
  }

  const onGesture = (event: Event): void => {
    if (!event.isTrusted) return;
    if (doc.hidden || doc.visibilityState === 'hidden') return;
    const nav = (doc.defaultView?.navigator ?? globalThis.navigator) as
      | NavigatorLike
      | undefined;
    if (nav?.userActivation?.isActive === false) return;
    // Listeners are attached only while the program is available and supported,
    // so the element can be created here, in the same synchronous call as play().
    const el = element ?? createPrimer();
    touchIdle();
    if (el.paused) startPlayback(el);
  };

  const onVisibility = (): void => {
    if (!(doc.hidden || doc.visibilityState === 'hidden')) return;
    if (element !== null) parkIdle();
  };

  function attachDocument(): void {
    if (documentAttached) return;
    documentAttached = true;
    for (const type of GESTURE_EVENTS)
      doc.addEventListener(type, onGesture, true);
    doc.addEventListener('visibilitychange', onVisibility);
  }

  function detachDocument(): void {
    if (!documentAttached) return;
    documentAttached = false;
    for (const type of GESTURE_EVENTS)
      doc.removeEventListener(type, onGesture, true);
    doc.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    supported: o.supported,
    get state() {
      return state;
    },

    whenReached(target, { signal, timeoutMs }) {
      if (settled(target, state) || signal.aborted || timeoutMs <= 0)
        return Promise.resolve(state);
      const { promise, resolve } =
        Promise.withResolvers<OtioAudioOutputState>();
      const onAbort = () => waiter.finish(state);
      const timer = setTimeout(() => waiter.finish(state), timeoutMs);
      const waiter: Waiter = {
        target,
        finish: (s) => {
          if (!waiters.delete(waiter)) return;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(s);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
      return promise;
    },

    setProgramAvailable(available) {
      if (disposed || available === programAvailable) return;
      programAvailable = available;
      if (available && o.supported) {
        attachDocument();
        createPrimer();
        setState('idle');
      } else {
        stopPlayback();
        releaseElement();
        detachDocument();
        setState('unsupported');
      }
    },

    park() {
      if (disposed || !programAvailable || !o.supported) return;
      parkIdle();
    },

    subscribe(l) {
      subscribers.add(l);
      return () => {
        subscribers.delete(l);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      programAvailable = false;
      stopPlayback();
      releaseElement();
      detachDocument();
      setState('unsupported');
      subscribers.clear();
    },
  };
}
