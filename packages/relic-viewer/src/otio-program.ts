/**
 * Native program playback for Relik OTIO archives, and the playback session
 * that chooses between it, the legacy composition player, and scoped focus.
 *
 * ProgramFormat (`@relic/format`) verifies the manifest, the document identity,
 * the media digests, and each rendered MP4's digest and size, and returns MP4
 * bytes only for rendered timelines. This module adds what only the viewer can
 * check: that this browser plays the codecs, that the program covers the
 * composition timeline, and that the loaded element matches the manifest.
 *
 * Time domain: composition time, the document's `timeline_range` domain that
 * anchors and markers use. Every time the session reports is on the composition
 * clock (`timeline_range.duration.rate`), the rate the existing controller uses.
 * A program's `range.start_time` must equal `timeline_range.start_time`, so media
 * time is `composition time - range.start_time`.
 *
 * Session policy by archive status:
 * - `legacy` (no manifest): the existing controller plays the composition and
 *   receives every call directly, as before. No queue, no banner.
 * - `program` (valid program): the native video plays the composition. A
 *   scoped track or item uses the existing controller and original media.
 *   `setScope(scope, { source: 'program' })` bounds the native video to a range
 *   instead. Clearing the scope resumes the program at the same time.
 * - `unavailable` (manifest present, no valid program, or a failed check):
 *   composition play is rejected and nothing decodes. Only a scoped track or
 *   item plays, through the existing controller, created lazily.
 *
 * Transitions (scope changes, and seek and play on program and focus) run one
 * at a time, in call order. Seeks coalesce: only the newest seek does work, and
 * a superseded seek resolves without touching the element. A pause cancels any
 * play that has not started. A scope is committed only after the existing
 * controller accepts it, and a failed transition restores the previous state.
 */

import {
  addRationalTimes,
  compareRationalTimes,
  MAX_OTIO_PROGRAM_FPS,
  OTIO_PROGRAM_AUDIO_CODEC,
  readOtioProgramArchive,
  timeToSeconds,
  type OtioProgramErrorCode,
  type OtioProgramReasonCode,
  type OtioRationalTime,
  type OtioTimeRange,
  type OtioZipIndex,
} from '@relic/format';
import type {
  OtioPlaybackController,
  OtioPlaybackListener,
  OtioPlaybackScope,
  OtioPlaybackState,
} from './otio-playback.ts';

/** Every code a program reason can carry. Both sets are spec names; no viewer-only codes exist. */
export type OtioProgramReasonCodeAll =
  | OtioProgramReasonCode
  | OtioProgramErrorCode;

export interface OtioProgramReason {
  readonly code: OtioProgramReasonCodeAll;
  readonly message: string;
  readonly node_id?: string;
  readonly time?: OtioRationalTime;
}

const PROGRAM_ERROR_CODES: readonly OtioProgramErrorCode[] = [
  'malformed-manifest',
  'unsafe-path',
  'archive-mismatch',
  'digest-mismatch',
  'size-cap-exceeded',
];

/**
 * Maps a thrown value to a spec code. Only `OtioProgramErrorCode` values pass
 * through. Other failures, including ZIP read errors, map to a spec name:
 * a decompression limit is `size-cap-exceeded`, and anything else is
 * `archive-mismatch`.
 */
export function reasonCodeForError(error: unknown): OtioProgramReasonCodeAll {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    if ((PROGRAM_ERROR_CODES as readonly string[]).includes(error.code)) {
      return error.code as OtioProgramErrorCode;
    }
    if (error.code === 'decompression-limit') return 'size-cap-exceeded';
  }
  return 'archive-mismatch';
}

const VIDEO_CODEC = /^avc1\.[0-9a-fA-F]{6}$/;
const FRAME_EPSILON = 1e-6;
/** Longest allowed difference between the element's duration and the manifest's. */
const DURATION_TOLERANCE_MIN_SECONDS = 0.1;
/** Hard cap: a hostile frame rate cannot widen the duration check past one second. */
const DURATION_TOLERANCE_MAX_SECONDS = 1;
/** Lowest frame rate the viewer accepts. The format accepts far lower rates. */
const MIN_VIEWER_FPS = 1;

export function frameRateAllowed(frameRate: {
  readonly num: number;
  readonly den: number;
}): boolean {
  const fps = frameRate.num / frameRate.den;
  return (
    Number.isFinite(fps) && fps >= MIN_VIEWER_FPS && fps <= MAX_OTIO_PROGRAM_FPS
  );
}

/**
 * Allowed difference between a loaded element's duration and the manifest's.
 * Always within [0.1 s, 1 s], whatever the frame rate.
 */
export function durationToleranceSeconds(frameRate: {
  readonly num: number;
  readonly den: number;
}): number {
  const frameSeconds = frameRate.den / frameRate.num;
  if (!Number.isFinite(frameSeconds)) return DURATION_TOLERANCE_MIN_SECONDS;
  return Math.min(
    DURATION_TOLERANCE_MAX_SECONDS,
    Math.max(DURATION_TOLERANCE_MIN_SECONDS, frameSeconds)
  );
}

export interface ValidatedProgram {
  readonly timelineId: string;
  /** Verified MP4 bytes from ProgramFormat's `programs` map. */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** Composition time of the first program frame; equals `timeline_range.start_time`. */
  readonly start: OtioRationalTime;
  readonly duration: OtioRationalTime;
  readonly frameRate: { readonly num: number; readonly den: number };
  readonly frames: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `legacy`: no program manifest. `unavailable`: a manifest exists and this
 * timeline has no usable program; `reasons` says why. `available`: play it.
 */
export type OtioProgramResolution =
  | { readonly status: 'legacy' }
  | {
      readonly status: 'unavailable';
      readonly reasons: readonly OtioProgramReason[];
    }
  | { readonly status: 'available'; readonly program: ValidatedProgram };

type CanPlayTypeResult = '' | 'maybe' | 'probably';

export interface ResolveOtioProgramInput {
  readonly zip: OtioZipIndex | undefined;
  readonly timelineId: string;
  /** Every timeline id in the document, for ProgramFormat's document check. */
  readonly timelineIds: readonly string[];
  /**
   * Canonical `media/...` archive paths the OTIO document references, derived
   * from the same parsed document as `timelineIds`. Never taken from the manifest.
   */
  readonly mediaPaths: readonly string[];
  readonly timelineRange: OtioTimeRange;
  readonly canPlayType?: (type: string) => CanPlayTypeResult;
}

/** A program rejected by a viewer check or by load-time verification. */
export class ProgramRejection extends Error {
  readonly code: OtioProgramReasonCodeAll;

  constructor(code: OtioProgramReasonCodeAll, message: string) {
    super(message);
    this.code = code;
  }
}

/** Thrown when composition play is requested while the composition is unavailable. */
export class CompositionPlaybackDisabled extends Error {
  readonly code: OtioProgramReasonCodeAll;

  constructor(reason: OtioProgramReason | undefined) {
    super(
      reason === undefined
        ? 'Composition playback is unavailable.'
        : `Composition playback is unavailable: ${reason.message}`
    );
    this.name = 'CompositionPlaybackDisabled';
    this.code = reason?.code ?? 'malformed-manifest';
  }
}

const defaultCanPlayType = (type: string): CanPlayTypeResult =>
  document.createElement('video').canPlayType(type);

const reasonFromError = (error: unknown): OtioProgramReason => {
  if (error instanceof ProgramRejection) {
    return { code: error.code, message: error.message };
  }
  return {
    code: reasonCodeForError(error),
    message:
      error instanceof Error ? error.message : 'Program could not be read.',
  };
};

/**
 * Resolves the program for one composition timeline. A missing manifest is
 * `legacy`. Any rejection by the format verifier or the viewer checks is
 * `unavailable`, with the spec code it maps to.
 */
export async function resolveOtioProgram(
  input: ResolveOtioProgramInput
): Promise<OtioProgramResolution> {
  const { zip, timelineId, timelineRange } = input;
  if (zip === undefined) return { status: 'legacy' };
  const canPlayType = input.canPlayType ?? defaultCanPlayType;
  try {
    const archive = await readOtioProgramArchive(zip, {
      document_sha256: zip.contentSha256,
      timeline_ids: input.timelineIds,
      media_paths: [...input.mediaPaths],
    });
    if (archive === null) return { status: 'legacy' };

    const record = archive.manifest.timelines.find(
      (item) => item.timeline_id === timelineId
    );
    if (record === undefined) {
      throw new ProgramRejection(
        'archive-mismatch',
        'The program manifest does not list this timeline.'
      );
    }
    if (record.status === 'unavailable') {
      return {
        status: 'unavailable',
        reasons:
          record.reasons.length > 0
            ? record.reasons
            : [
                {
                  code: 'render-failed',
                  message: 'The program could not be rendered.',
                },
              ],
      };
    }

    const descriptor = record.program;
    const bytes = archive.programs.get(record.index);
    if (bytes === undefined) {
      throw new ProgramRejection(
        'archive-mismatch',
        'The verified archive has no program for this timeline.'
      );
    }
    if (!VIDEO_CODEC.test(descriptor.video_codec)) {
      throw new ProgramRejection(
        'unsupported-codec',
        'Program video codec is not H.264.'
      );
    }
    if (!frameRateAllowed(descriptor.frame_rate)) {
      throw new ProgramRejection(
        'invalid-timing',
        'Program frame rate is outside the supported range.'
      );
    }
    const mimeType = `video/mp4; codecs="${descriptor.video_codec}, ${OTIO_PROGRAM_AUDIO_CODEC}"`;
    if (canPlayType(mimeType) === '') {
      throw new ProgramRejection(
        'unsupported-browser',
        'This browser cannot play the program codecs.'
      );
    }
    if (
      compareRationalTimes(
        descriptor.range.start_time,
        timelineRange.start_time
      ) !== 0 ||
      compareRationalTimes(
        descriptor.range.duration,
        timelineRange.duration
      ) !== 0
    ) {
      throw new ProgramRejection(
        'invalid-timing',
        'Program range does not match the composition timeline.'
      );
    }

    return {
      status: 'available',
      program: {
        timelineId,
        bytes,
        mimeType,
        start: descriptor.range.start_time,
        duration: descriptor.range.duration,
        frameRate: descriptor.frame_rate,
        frames: descriptor.frames,
        width: descriptor.width,
        height: descriptor.height,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reasons: [reasonFromError(error)] };
  }
}

export interface OtioProgramPlayer {
  /** Resolves once metadata matches the manifest; rejects with a ProgramRejection otherwise. */
  readonly ready: Promise<void>;
  getState(): OtioPlaybackState;
  /** The native element's media time in seconds. */
  mediaTimeSeconds(): number;
  play(): Promise<void>;
  pause(): void;
  seek(time: OtioRationalTime): Promise<void>;
  setMuted(muted: boolean): void;
  /** Limits playback to `range`; null lifts the limit. Seeks and play stay inside it. */
  setBounds(range: OtioTimeRange | null): void;
  subscribe(listener: OtioPlaybackListener): () => void;
  dispose(): void;
}

export interface OtioProgramPlayerOptions {
  readonly video: HTMLVideoElement;
  readonly program: ValidatedProgram;
  /** Called when playback fails after a successful load-time check. */
  readonly onFailure: (reason: OtioProgramReason) => void;
}

interface FrameBounds {
  /** First frame in range. */
  readonly start: number;
  /** First frame after the range. */
  readonly end: number;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

export function createOtioProgramPlayer(
  options: OtioProgramPlayerOptions
): OtioProgramPlayer {
  const { video, program, onFailure } = options;
  const fps = program.frameRate.num / program.frameRate.den;
  const frameSeconds = program.frameRate.den / program.frameRate.num;
  const lastFrame = program.frames - 1;
  const listeners = new Set<OtioPlaybackListener>();
  const cleanup: (() => void)[] = [];
  const loaded = Promise.withResolvers<void>();
  let isLoaded = false;
  let disposed = false;
  let buffering = false;
  let frame = 0;
  let frameRequest = 0;
  let objectUrl: string | undefined;
  let bounds: FrameBounds | null = null;
  /** Settles the pending seek with `false` when it errored or the player was disposed. */
  let settlePendingSeek: ((seeked: boolean) => void) | undefined;
  let settlePendingPlay: (() => void) | undefined;

  const clampFrame = (index: number): number =>
    Math.min(Math.max(index, 0), lastFrame);
  const frameFor = (time: OtioRationalTime): number =>
    clampFrame(
      Math.floor(
        (timeToSeconds(time) - timeToSeconds(program.start)) * fps +
          FRAME_EPSILON
      )
    );
  const timeForFrame = (index: number): OtioRationalTime =>
    addRationalTimes(program.start, {
      value: index * program.frameRate.den,
      rate: program.frameRate.num,
    });
  const frameAtElement = (): number =>
    clampFrame(Math.floor(video.currentTime * fps + FRAME_EPSILON));
  const boundedFrame = (index: number): number =>
    bounds === null
      ? index
      : Math.min(Math.max(index, bounds.start), bounds.end - 1);
  const frameBounds = (range: OtioTimeRange): FrameBounds => {
    const start = frameFor(range.start_time);
    const endSeconds =
      timeToSeconds(range.start_time) +
      timeToSeconds(range.duration) -
      timeToSeconds(program.start);
    const end = Math.min(
      Math.max(Math.ceil(endSeconds * fps - FRAME_EPSILON), 0),
      program.frames
    );
    return { start, end: Math.max(end, start + 1) };
  };

  const state = (): OtioPlaybackState => ({
    time: timeForFrame(frame),
    scope: null,
    playing: !video.paused && !video.ended,
    buffering,
    duration: program.duration,
    rate: video.playbackRate,
    diagnostics: [],
    tracks: {},
    baseMediaPreviewAllowed: false,
    previewBlocked: false,
    graphicsFailed: false,
  });

  const emit = (): void => {
    if (disposed) return;
    const next = state();
    for (const listener of listeners) listener(next);
  };

  /** Returns true when the displayed frame moved, so playback emits only on change. */
  const syncFrame = (): boolean => {
    const next = frameAtElement();
    if (next === frame) return false;
    frame = next;
    return true;
  };

  const stopFrameLoop = (): void => {
    if (frameRequest !== 0) cancelAnimationFrame(frameRequest);
    frameRequest = 0;
  };

  const tick = (): void => {
    frameRequest = 0;
    if (disposed) return;
    // Check the bound before emitting, so no frame past the range end is reported.
    if (bounds !== null && frameAtElement() >= bounds.end) {
      video.pause();
      video.currentTime = (bounds.end - 1 + 0.5) * frameSeconds;
      return;
    }
    if (syncFrame()) emit();
    if (!video.paused && !video.ended)
      frameRequest = requestAnimationFrame(tick);
  };

  const listen = <K extends keyof HTMLMediaElementEventMap>(
    type: K,
    handler: (event: HTMLMediaElementEventMap[K]) => void
  ): void => {
    video.addEventListener(type, handler);
    cleanup.push(() => video.removeEventListener(type, handler));
  };

  listen('play', () => {
    if (frameRequest === 0) frameRequest = requestAnimationFrame(tick);
    emit();
  });
  listen('pause', () => {
    stopFrameLoop();
    syncFrame();
    emit();
  });
  listen('ended', () => {
    stopFrameLoop();
    syncFrame();
    emit();
  });
  listen('seeked', () => {
    syncFrame();
    emit();
  });
  listen('waiting', () => {
    buffering = true;
    emit();
  });
  for (const type of ['playing', 'canplay'] as const) {
    listen(type, () => {
      buffering = false;
      emit();
    });
  }
  listen('error', () => {
    if (disposed || !isLoaded) return;
    video.pause();
    onFailure({
      code: 'unsupported-browser',
      message: 'The native program could not be played.',
    });
  });

  const verifyMetadata = (): void => {
    const tolerance = durationToleranceSeconds(program.frameRate);
    if (
      !Number.isFinite(video.duration) ||
      Math.abs(video.duration - timeToSeconds(program.duration)) > tolerance
    ) {
      throw new ProgramRejection(
        'archive-mismatch',
        'Program duration does not match the manifest.'
      );
    }
    if (
      video.videoWidth !== program.width ||
      video.videoHeight !== program.height
    ) {
      throw new ProgramRejection(
        'archive-mismatch',
        'Program dimensions do not match the manifest.'
      );
    }
  };

  const onMetadata = (): void => {
    try {
      verifyMetadata();
      isLoaded = true;
      loaded.resolve();
    } catch (error) {
      loaded.reject(
        error instanceof ProgramRejection
          ? error
          : new ProgramRejection(
              'unsupported-browser',
              'Program failed to load.'
            )
      );
    }
  };
  const onLoadError = (): void => {
    loaded.reject(
      new ProgramRejection(
        'unsupported-browser',
        'The native program failed to load.'
      )
    );
  };
  video.addEventListener('loadedmetadata', onMetadata, { once: true });
  video.addEventListener('error', onLoadError, { once: true });
  cleanup.push(() => {
    video.removeEventListener('loadedmetadata', onMetadata);
    video.removeEventListener('error', onLoadError);
  });
  // The session observes a failed load through `ready`.
  loaded.promise.catch(() => undefined);

  objectUrl = URL.createObjectURL(
    new Blob([program.bytes as BlobPart], { type: program.mimeType })
  );
  video.preload = 'auto';
  video.src = objectUrl;
  video.load();

  /**
   * Moves the element to a frame and settles when the seek completes, errors,
   * or the player is disposed. A failed or disposed seek never reports a frame.
   */
  const seekToFrame = async (target: number): Promise<void> => {
    if (disposed) return;
    const seconds = (target + 0.5) * frameSeconds;
    if (Math.abs(video.currentTime - seconds) > 1e-4) {
      const settled = Promise.withResolvers<boolean>();
      const finish = (seeked: boolean): void => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        if (settlePendingSeek === finish) settlePendingSeek = undefined;
        settled.resolve(seeked);
      };
      const onSeeked = (): void => finish(true);
      const onError = (): void => finish(false);
      settlePendingSeek = finish;
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.currentTime = seconds;
      const seeked = await settled.promise;
      if (!seeked || disposed) return;
    }
    if (disposed) return;
    frame = target;
    emit();
  };

  /**
   * Starts playback and settles when `play()` resolves, fails, errors, or the
   * player is disposed. An interrupted play (a pause during start-up) is not a
   * failure, so it never wedges the caller.
   */
  const startElement = async (): Promise<void> => {
    const settled = Promise.withResolvers<void>();
    const onError = (): void => settled.resolve();
    settlePendingPlay = () => settled.resolve();
    video.addEventListener('error', onError);
    try {
      await Promise.race([
        video.play().catch((error: unknown) => {
          if (isAbortError(error)) return;
          throw error;
        }),
        settled.promise,
      ]);
    } finally {
      video.removeEventListener('error', onError);
      settlePendingPlay = undefined;
    }
  };

  return {
    ready: loaded.promise,
    getState: state,
    mediaTimeSeconds: () => video.currentTime,
    async play() {
      if (disposed) return;
      if (bounds !== null) {
        const current = frameAtElement();
        // Outside the range, or on its last frame: play starts the range again.
        if (current < bounds.start || current >= bounds.end - 1) {
          await seekToFrame(bounds.start);
        }
      }
      await startElement();
    },
    pause() {
      if (disposed) return;
      video.pause();
    },
    async seek(time) {
      if (disposed) return;
      await seekToFrame(boundedFrame(frameFor(time)));
    },
    setMuted(muted) {
      video.muted = muted;
    },
    setBounds(range) {
      bounds = range === null ? null : frameBounds(range);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settlePendingSeek?.(false);
      settlePendingPlay?.();
      stopFrameLoop();
      video.pause();
      for (const remove of cleanup.splice(0)) remove();
      listeners.clear();
      video.removeAttribute('src');
      video.load();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    },
  };
}

/** The viewer state. Shown on `.otio-view` as `data-otio-program-state`. */
export type OtioProgramState =
  | 'program'
  | 'focus-track'
  | 'legacy'
  | 'unavailable';

export interface OtioProgramAvailability {
  readonly state: OtioProgramState;
  /** The composition's own status, regardless of what is focused. */
  readonly program: 'legacy' | 'available' | 'unavailable';
  /** Why the composition is unavailable. Empty for `legacy` and `available`. */
  readonly reasons: readonly OtioProgramReason[];
  /** Composition play works in `program` and `legacy` only. */
  readonly compositionPlayable: boolean;
  /** Track toggles act on the existing controller: a legacy composition or a focused track. */
  readonly trackControls: boolean;
  /** Mute-all applies to the native program element only. */
  readonly muteAll: boolean;
}

export interface OtioProgramSnapshot {
  readonly mode: OtioProgramState;
  /** The first reason code, or null when there is none. */
  readonly reason: string | null;
  /** Composition time in seconds; the same domain as comment anchors. */
  readonly timelineTimeSeconds: number;
  /** The native element's media time; null unless the program is playing the composition. */
  readonly mediaTimeSeconds: number | null;
  readonly playing: boolean;
}

export interface OtioScopeOptions {
  /**
   * `original` (the default) plays the scoped track or item's own media.
   * `program` bounds the native program to the scope's range.
   */
  readonly source?: 'original' | 'program';
}

export interface OtioPlaybackSession extends OtioPlaybackController {
  availability(): OtioProgramAvailability;
  snapshot(): OtioProgramSnapshot;
  setMuted(muted: boolean): void;
  setScope(
    scope: OtioPlaybackScope | null,
    options?: OtioScopeOptions
  ): Promise<void>;
}

export interface OtioPlaybackSessionOptions {
  readonly resolution: OtioProgramResolution;
  /** From the document: the composition range. Its duration rate is the clock rate for reported times. */
  readonly timelineRange: OtioTimeRange;
  /** The native element that plays the program. Required when the resolution is `available`. */
  readonly video?: HTMLVideoElement;
  /** Builds the existing controller. Legacy plays the composition with it; every state uses it for focus. */
  readonly createController: () => OtioPlaybackController;
}

/**
 * Opens the session. A program that fails its load-time check becomes
 * `unavailable` with that reason; the promise still resolves.
 */
export async function createOtioPlaybackSession(
  options: OtioPlaybackSessionOptions
): Promise<OtioPlaybackSession> {
  const session = new OtioPlaybackSessionImpl(options);
  await session.open();
  return session;
}

const inRange = (time: OtioRationalTime, range: OtioTimeRange): boolean =>
  compareRationalTimes(time, range.start_time) >= 0 &&
  compareRationalTimes(
    time,
    addRationalTimes(range.start_time, range.duration)
  ) < 0;

/** Expresses a time on the composition clock. Program times are frame-based, so they round to a clock tick. */
const atClock = (
  time: OtioRationalTime,
  clockRate: number
): OtioRationalTime => ({
  value: Math.round(timeToSeconds(time) * clockRate),
  rate: clockRate,
});

const idleState = (
  time: OtioRationalTime,
  duration: OtioRationalTime,
  rate: number
): OtioPlaybackState => ({
  time,
  scope: null,
  playing: false,
  buffering: false,
  duration,
  rate,
  diagnostics: [],
  tracks: {},
  baseMediaPreviewAllowed: false,
  previewBlocked: false,
  graphicsFailed: false,
});

class OtioPlaybackSessionImpl implements OtioPlaybackSession {
  private readonly options: OtioPlaybackSessionOptions;
  private readonly listeners = new Set<OtioPlaybackListener>();
  private readonly clockRate: number;
  private status: 'legacy' | 'available' | 'unavailable';
  private reasons: readonly OtioProgramReason[];
  private program: ValidatedProgram | undefined;
  private player: OtioProgramPlayer | undefined;
  private playerUnsubscribe: (() => void) | undefined;
  /** The existing controller: the composition for `legacy`, or the focused track. */
  private controller: OtioPlaybackController | undefined;
  private controllerUnsubscribe: (() => void) | undefined;
  private scoped = false;
  private programScope: OtioPlaybackScope | null = null;
  /** Composition time on the clock, used while no native program is playing. */
  private idleTime: OtioRationalTime;
  private muted = false;
  private baseMediaPreviewAllowed = false;
  private disposed = false;
  /** Tail of the transition queue: transitions run one at a time, in call order. */
  private transitions: Promise<void> = Promise.resolve();
  /** Increments on every seek; only the newest seek does work when it runs. */
  private seekSerial = 0;
  /** Increments on every play and pause; a queued play runs only if it is still the latest intent. */
  private playIntent = 0;

  constructor(options: OtioPlaybackSessionOptions) {
    this.options = options;
    this.clockRate = options.timelineRange.duration.rate;
    const { resolution } = options;
    this.status = resolution.status;
    this.reasons =
      resolution.status === 'unavailable' ? resolution.reasons : [];
    this.program =
      resolution.status === 'available' ? resolution.program : undefined;
    this.idleTime = { value: 0, rate: this.clockRate };
  }

  async open(): Promise<void> {
    if (this.status === 'available') {
      const program = this.program;
      const video = this.options.video;
      if (program === undefined || video === undefined) {
        this.markUnavailable({
          code: 'malformed-manifest',
          message: 'No video element is available for the program.',
        });
      } else {
        const player: OtioProgramPlayer = createOtioProgramPlayer({
          video,
          program,
          onFailure: (reason) => {
            // Not queued: a failure must take effect even while a transition waits on this element.
            this.failProgram(player, reason);
          },
        });
        try {
          await player.ready;
          if (this.disposed) {
            player.dispose();
            return;
          }
          this.player = player;
          player.setMuted(this.muted);
          this.playerUnsubscribe = player.subscribe(() => {
            if (this.mode() === 'program') this.emit();
          });
        } catch (error) {
          player.dispose();
          this.markUnavailable(reasonFromError(error));
        }
      }
    }
    if (this.status === 'legacy') {
      this.attachController(this.options.createController());
    }
  }

  mode(): OtioProgramState {
    if (this.scoped) return 'focus-track';
    if (this.status === 'available') return 'program';
    if (this.status === 'legacy') return 'legacy';
    return 'unavailable';
  }

  availability(): OtioProgramAvailability {
    const state = this.mode();
    return {
      state,
      program: this.status,
      reasons: this.reasons,
      compositionPlayable: state === 'program' || state === 'legacy',
      trackControls: state === 'focus-track' || state === 'legacy',
      muteAll: state === 'program',
    };
  }

  snapshot(): OtioProgramSnapshot {
    const mode = this.mode();
    const state = this.getState();
    return {
      mode,
      reason: this.reasons[0]?.code ?? null,
      timelineTimeSeconds: timeToSeconds(state.time),
      mediaTimeSeconds:
        mode === 'program' && this.player !== undefined
          ? this.player.mediaTimeSeconds()
          : null,
      playing: state.playing,
    };
  }

  getState(): OtioPlaybackState {
    if (
      this.controller !== undefined &&
      (this.scoped || this.status === 'legacy')
    ) {
      return this.controller.getState();
    }
    if (this.status === 'available' && this.player !== undefined) {
      const playerState = this.player.getState();
      return {
        ...playerState,
        time: atClock(playerState.time, this.clockRate),
        duration: atClock(playerState.duration, this.clockRate),
        rate: this.clockRate,
        scope: this.programScope,
      };
    }
    return idleState(
      this.idleTime,
      this.options.timelineRange.duration,
      this.clockRate
    );
  }

  play(): Promise<void> {
    // Legacy has no queue: the existing controller plays directly.
    if (this.status === 'legacy' && this.controller !== undefined) {
      return this.controller.play();
    }
    const intent = ++this.playIntent;
    return this.serialize(async () => {
      // A pause or a later play arrived first: this play no longer applies.
      if (this.disposed || intent !== this.playIntent) return;
      if (this.controller !== undefined && this.scoped) {
        await this.controller.play();
        return;
      }
      if (this.status === 'available' && this.player !== undefined) {
        await this.player.play();
        return;
      }
      throw new CompositionPlaybackDisabled(this.reasons[0]);
    });
  }

  pause(): void {
    // Cancels any play that has not started yet, then pauses at once.
    this.playIntent += 1;
    if (
      this.controller !== undefined &&
      (this.scoped || this.status === 'legacy')
    ) {
      this.controller.pause();
      return;
    }
    this.player?.pause();
  }

  seek(time: OtioRationalTime): Promise<void> {
    // Legacy has no queue: the existing controller coalesces its own renders.
    if (this.status === 'legacy' && this.controller !== undefined) {
      return this.controller.seek(time);
    }
    const serial = ++this.seekSerial;
    return this.serialize(async () => {
      // A newer seek arrived before this one ran: the newest seek does the work.
      if (this.disposed || serial !== this.seekSerial) return;
      if (this.controller !== undefined && this.scoped) {
        await this.controller.seek(time);
        return;
      }
      if (this.status === 'available' && this.player !== undefined) {
        await this.player.seek(time);
        return;
      }
      // Unavailable composition: positioning only, nothing decodes.
      this.idleTime = this.clampToComposition(time);
      this.emit();
    });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.player?.setMuted(muted);
  }

  setScope(
    scope: OtioPlaybackScope | null,
    options?: OtioScopeOptions
  ): Promise<void> {
    // Legacy has no queue: the existing controller receives the scope directly.
    if (this.status === 'legacy') return this.applyScope(scope, options);
    return this.serialize(() => this.applyScope(scope, options));
  }

  async prepareAudioContextChange(): Promise<void> {
    await this.controller?.prepareAudioContextChange();
  }

  subscribe(listener: OtioPlaybackListener): () => void {
    this.listeners.add(listener);
    // The controller contract delivers the current state at once.
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  setTrackVisibility(trackId: string, visible: boolean): void {
    this.controller?.setTrackVisibility(trackId, visible);
  }

  setTrackMute(trackId: string, muted: boolean): void {
    this.controller?.setTrackMute(trackId, muted);
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    this.controller?.setTrackSolo(trackId, solo);
  }

  setBaseMediaPreviewAllowed(allowed: boolean): void {
    this.baseMediaPreviewAllowed = allowed;
    this.controller?.setBaseMediaPreviewAllowed(allowed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachController();
    this.playerUnsubscribe?.();
    this.player?.dispose();
    this.listeners.clear();
  }

  /** Runs one transition after the previous one settles. A failed transition does not block the queue. */
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(run);
    this.transitions = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async applyScope(
    scope: OtioPlaybackScope | null,
    options: OtioScopeOptions | undefined
  ): Promise<void> {
    if (this.disposed) return;
    if (this.status === 'legacy') {
      // The legacy controller owns the composition and every scope. Commit after it accepts.
      await this.controller?.setScope(scope);
      this.scoped = scope !== null;
      this.emit();
      return;
    }
    if (options?.source === 'program') {
      await this.bindProgramScope(scope);
      return;
    }
    if (scope === null) {
      await this.leaveFocus();
      return;
    }
    await this.enterFocus(scope);
  }

  /** Focus a track or item. The scope is set before any seek, so the controller never composites the whole timeline. */
  private async enterFocus(scope: OtioPlaybackScope): Promise<void> {
    if (this.controller !== undefined) {
      await this.controller.setScope(scope);
      this.scoped = true;
      this.emit();
      return;
    }
    const time = this.compositionTime();
    const previousBound = this.programScope;
    this.player?.pause();
    this.setProgramBound(null);
    const controller = this.options.createController();
    controller.setBaseMediaPreviewAllowed(this.baseMediaPreviewAllowed);
    try {
      await controller.setScope(scope);
      await controller.seek(
        inRange(time, scope.range) ? time : scope.range.start_time
      );
    } catch (error) {
      controller.dispose();
      this.setProgramBound(previousBound);
      throw error;
    }
    if (this.disposed) {
      controller.dispose();
      return;
    }
    this.attachController(controller);
    this.scoped = true;
    this.emit();
  }

  /** Leave focus. The program resumes at the focused controller's composition time. */
  private async leaveFocus(): Promise<void> {
    if (!this.scoped || this.controller === undefined) return;
    const time = this.controller.getState().time;
    if (this.status === 'available' && this.player !== undefined) {
      await this.player.seek(time);
      this.player.setMuted(this.muted);
    } else {
      this.idleTime = this.clampToComposition(time);
    }
    this.detachController();
    this.scoped = false;
    this.emit();
  }

  /** Bound the native program to a scope's range, or lift the bound. Never switches to original media. */
  private async bindProgramScope(
    scope: OtioPlaybackScope | null
  ): Promise<void> {
    if (scope === null) {
      await this.leaveFocus();
      this.setProgramBound(null);
      this.emit();
      return;
    }
    if (this.status !== 'available' || this.player === undefined) {
      throw new CompositionPlaybackDisabled(this.reasons[0]);
    }
    await this.leaveFocus();
    const player = this.player;
    if (player === undefined) return;
    const previousBound = this.programScope;
    this.setProgramBound(scope);
    if (!inRange(player.getState().time, scope.range)) {
      try {
        await player.seek(scope.range.start_time);
      } catch (error) {
        this.setProgramBound(previousBound);
        throw error;
      }
    }
    this.emit();
  }

  private setProgramBound(scope: OtioPlaybackScope | null): void {
    this.programScope = scope;
    this.player?.setBounds(scope?.range ?? null);
  }

  /** The composition time now: the native program's, or the idle position. */
  private compositionTime(): OtioRationalTime {
    if (this.status === 'available' && this.player !== undefined) {
      return this.player.getState().time;
    }
    return this.idleTime;
  }

  /** Clamps a time into the composition range and expresses it on the clock. */
  private clampToComposition(time: OtioRationalTime): OtioRationalTime {
    const start = this.options.timelineRange.start_time;
    const end = addRationalTimes(start, this.options.timelineRange.duration);
    if (compareRationalTimes(time, start) < 0)
      return atClock(start, this.clockRate);
    if (compareRationalTimes(time, end) > 0)
      return atClock(end, this.clockRate);
    return atClock(time, this.clockRate);
  }

  private attachController(controller: OtioPlaybackController): void {
    this.controller = controller;
    controller.setBaseMediaPreviewAllowed(this.baseMediaPreviewAllowed);
    this.controllerUnsubscribe = controller.subscribe(() => this.emit());
  }

  private detachController(): void {
    this.controllerUnsubscribe?.();
    this.controllerUnsubscribe = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  }

  private markUnavailable(reason: OtioProgramReason): void {
    this.status = 'unavailable';
    this.reasons = [reason];
    this.program = undefined;
  }

  /** The native program failed after it loaded. Composition play is rejected from here on. */
  private failProgram(
    failed: OtioProgramPlayer,
    reason: OtioProgramReason
  ): void {
    if (this.disposed || this.player !== failed) return;
    const time = atClock(failed.getState().time, this.clockRate);
    this.playerUnsubscribe?.();
    this.playerUnsubscribe = undefined;
    this.player = undefined;
    failed.dispose();
    this.programScope = null;
    this.markUnavailable(reason);
    this.idleTime = time;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
