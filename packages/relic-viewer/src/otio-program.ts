/**
 * Native program playback for Relik OTIO archives, and the playback session
 * that chooses between it, the legacy composition player, and scoped focus.
 *
 * ProgramFormat (`@relic/format`) verifies the manifest, the document identity,
 * the media digests, and each rendered MP4's digest and size, and returns the
 * MP4 bytes only for rendered timelines. This module adds what only the viewer
 * can check: that this browser can play the codecs, that the program covers
 * the composition timeline, and that the loaded element matches the manifest.
 *
 * Time domain: `state.time` is composition time, the same domain as the
 * document's `timeline_range` and comment anchors. The existing controller
 * evaluates `evaluateOtioAt(doc, timelineId, time)` at that same `time`, and
 * the viewer's domain origin is `timeline_range.start_time`. A program's
 * `range.start_time` must equal `timeline_range.start_time`, so media time is
 * `composition time - range.start_time`.
 *
 * Session policy by archive status:
 * - `legacy` (no manifest): the existing controller plays the composition, as
 *   before. No banner.
 * - `program` (valid manifest, valid program): the native video plays the
 *   composition. A scoped track or item uses the existing controller and
 *   original media. Clearing the scope resumes the program.
 * - `unavailable` (manifest present, no valid program for this timeline, or a
 *   failed check): composition play is rejected and nothing plays. Only a
 *   scoped track or item plays, through the existing controller.
 */

import {
  addRationalTimes,
  compareRationalTimes,
  readOtioProgramArchive,
  timeToSeconds,
  type OtioRationalTime,
  type OtioTimeRange,
  type OtioZipIndex,
} from '@relic/format';
import { OTIO_PROGRAM_AUDIO_CODEC } from '@relic/format';
import type {
  OtioPlaybackController,
  OtioPlaybackListener,
  OtioPlaybackScope,
  OtioPlaybackState,
} from './otio-playback.ts';

export interface OtioProgramReason {
  readonly code: string;
  readonly message: string;
  readonly node_id?: string;
  readonly time?: OtioRationalTime;
}

const VIDEO_CODEC = /^avc1\.[0-9a-fA-F]{6}$/;
const FRAME_EPSILON = 1e-6;
/** Longest allowed difference between the element's duration and the manifest's. */
const DURATION_TOLERANCE_SECONDS = 0.1;

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
  readonly timelineRange: OtioTimeRange;
  readonly canPlayType?: (type: string) => CanPlayTypeResult;
}

/** A program rejected by a viewer check or by load-time verification. */
export class ProgramRejection extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Thrown when composition play is requested while the program is unavailable. */
export class CompositionPlaybackDisabled extends Error {
  readonly code: string;

  constructor(reason: OtioProgramReason | undefined) {
    super(
      reason === undefined
        ? 'Composition playback is unavailable.'
        : `Composition playback is unavailable: ${reason.message}`
    );
    this.name = 'CompositionPlaybackDisabled';
    this.code = reason?.code ?? 'unavailable';
  }
}

const defaultCanPlayType = (type: string): CanPlayTypeResult =>
  document.createElement('video').canPlayType(type);

/**
 * Resolves the program for one composition timeline. Any ProgramFormat
 * rejection becomes an `unavailable` result with its code. A missing manifest
 * is `legacy`, not an error.
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
    });
    if (archive === null) return { status: 'legacy' };

    const record = archive.manifest.timelines.find(
      (item) => item.timeline_id === timelineId
    );
    if (record === undefined) {
      throw new ProgramRejection(
        'timeline-not-listed',
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
                  code: 'unsupported-schema',
                  message: 'The program could not be rendered.',
                },
              ],
      };
    }

    const descriptor = record.program;
    const bytes = archive.programs.get(record.index);
    if (bytes === undefined) {
      throw new ProgramRejection(
        'entry-missing',
        'The verified archive has no program for this timeline.'
      );
    }
    if (!VIDEO_CODEC.test(descriptor.video_codec)) {
      throw new ProgramRejection(
        'unsupported-codec',
        'Program video codec is not H.264.'
      );
    }
    const mimeType = `video/mp4; codecs="${descriptor.video_codec}, ${OTIO_PROGRAM_AUDIO_CODEC}"`;
    if (canPlayType(mimeType) === '') {
      throw new ProgramRejection(
        'unsupported-codec',
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
        'range-mismatch',
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
    if (error instanceof ProgramRejection) {
      return {
        status: 'unavailable',
        reasons: [{ code: error.code, message: error.message }],
      };
    }
    const code =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'malformed-manifest';
    return {
      status: 'unavailable',
      reasons: [
        {
          code,
          message:
            error instanceof Error
              ? error.message
              : 'Program could not be read.',
        },
      ],
    };
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
  subscribe(listener: OtioPlaybackListener): () => void;
  dispose(): void;
}

export interface OtioProgramPlayerOptions {
  readonly video: HTMLVideoElement;
  readonly program: ValidatedProgram;
  /** Called when playback errors after a successful load-time check. */
  readonly onFailure: (reason: OtioProgramReason) => void;
}

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
      code: 'unsupported-codec',
      message: 'The native program could not be played.',
    });
  });

  const verifyMetadata = (): void => {
    if (
      !Number.isFinite(video.duration) ||
      Math.abs(video.duration - timeToSeconds(program.duration)) >
        Math.max(DURATION_TOLERANCE_SECONDS, frameSeconds)
    ) {
      throw new ProgramRejection(
        'bad-duration',
        'Program duration does not match the manifest.'
      );
    }
    if (
      video.videoWidth !== program.width ||
      video.videoHeight !== program.height
    ) {
      throw new ProgramRejection(
        'bad-dimensions',
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
              'malformed-manifest',
              'Program failed to load.'
            )
      );
    }
  };
  const onLoadError = (): void => {
    loaded.reject(
      new ProgramRejection(
        'unsupported-codec',
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

  return {
    ready: loaded.promise,
    getState: state,
    mediaTimeSeconds: () => video.currentTime,
    async play() {
      if (disposed) return;
      await video.play();
    },
    pause() {
      if (disposed) return;
      video.pause();
    },
    async seek(time) {
      if (disposed) return;
      const target = frameFor(time);
      const seconds = (target + 0.5) * frameSeconds;
      if (Math.abs(video.currentTime - seconds) > 1e-4) {
        const seeked = Promise.withResolvers<void>();
        const done = (): void => {
          video.removeEventListener('seeked', done);
          seeked.resolve();
        };
        video.addEventListener('seeked', done);
        video.currentTime = seconds;
        await seeked.promise;
      }
      frame = target;
      emit();
    },
    setMuted(muted) {
      video.muted = muted;
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

/** The viewer state. Values are shown on `.otio-view` as `data-otio-program-state`. */
export type OtioProgramState =
  | 'program'
  | 'focus-track'
  | 'legacy'
  | 'unavailable';

export interface OtioProgramAvailability {
  readonly state: OtioProgramState;
  /** Why the program is unavailable, when it is. Empty for `legacy` and `program`. */
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

export interface OtioPlaybackSession extends OtioPlaybackController {
  availability(): OtioProgramAvailability;
  snapshot(): OtioProgramSnapshot;
  setMuted(muted: boolean): void;
}

export interface OtioPlaybackSessionOptions {
  readonly resolution: OtioProgramResolution;
  /** From the document: the composition range used for the idle state. */
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

class OtioPlaybackSessionImpl implements OtioPlaybackSession {
  private readonly options: OtioPlaybackSessionOptions;
  private readonly listeners = new Set<OtioPlaybackListener>();
  private status: 'legacy' | 'available' | 'unavailable';
  private reasons: readonly OtioProgramReason[];
  private program: ValidatedProgram | undefined;
  private player: OtioProgramPlayer | undefined;
  private playerUnsubscribe: (() => void) | undefined;
  /** The existing controller: the composition for `legacy`, or the focused track. */
  private controller: OtioPlaybackController | undefined;
  private controllerUnsubscribe: (() => void) | undefined;
  private scoped = false;
  private idleTime: OtioRationalTime;
  private muted = false;
  private baseMediaPreviewAllowed = false;
  private disposed = false;

  constructor(options: OtioPlaybackSessionOptions) {
    this.options = options;
    const { resolution } = options;
    this.status = resolution.status;
    this.reasons =
      resolution.status === 'unavailable' ? resolution.reasons : [];
    this.program =
      resolution.status === 'available' ? resolution.program : undefined;
    this.idleTime = { value: 0, rate: options.timelineRange.duration.rate };
  }

  async open(): Promise<void> {
    const { program, video } = this;
    if (this.status === 'available') {
      if (program === undefined || video === undefined) {
        this.markUnavailable({
          code: 'malformed-manifest',
          message: 'No video element is available for the program.',
        });
      } else {
        const player = createOtioProgramPlayer({
          video,
          program,
          onFailure: (reason) => {
            void this.failProgram(reason);
          },
        });
        try {
          await player.ready;
          this.player = player;
          player.setMuted(this.muted);
          this.playerUnsubscribe = player.subscribe(() => {
            if (this.mode() === 'program') this.emit();
          });
        } catch (error) {
          player.dispose();
          this.markUnavailable(
            error instanceof ProgramRejection
              ? {
                  code: error.code,
                  message: error.message,
                }
              : {
                  code: 'malformed-manifest',
                  message: 'Program failed to load.',
                }
          );
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
    if (this.status === 'available' && this.player !== undefined)
      return this.player.getState();
    return idleState(this.idleTime, this.options.timelineRange.duration);
  }

  async play(): Promise<void> {
    if (
      this.controller !== undefined &&
      (this.scoped || this.status === 'legacy')
    ) {
      await this.controller.play();
      return;
    }
    if (this.status === 'available' && this.player !== undefined) {
      await this.player.play();
      return;
    }
    throw new CompositionPlaybackDisabled(this.reasons[0]);
  }

  pause(): void {
    if (
      this.controller !== undefined &&
      (this.scoped || this.status === 'legacy')
    ) {
      this.controller.pause();
      return;
    }
    this.player?.pause();
  }

  async seek(time: OtioRationalTime): Promise<void> {
    if (
      this.controller !== undefined &&
      (this.scoped || this.status === 'legacy')
    ) {
      await this.controller.seek(time);
      return;
    }
    if (this.status === 'available' && this.player !== undefined) {
      await this.player.seek(time);
      return;
    }
    // Unavailable composition: positioning only, nothing decodes.
    this.idleTime = time;
    this.emit();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.player?.setMuted(muted);
  }

  async setScope(scope: OtioPlaybackScope | null): Promise<void> {
    if (this.disposed) return;
    if (this.status === 'legacy') {
      // The legacy controller owns the composition and every scope.
      this.scoped = scope !== null;
      await this.controller?.setScope(scope);
      this.emit();
      return;
    }
    if (scope === null) {
      if (!this.scoped) return;
      this.scoped = false;
      const time = this.controller?.getState().time ?? this.idleTime;
      this.detachController();
      if (this.status === 'available' && this.player !== undefined) {
        this.player.setMuted(this.muted);
        await this.player.seek(time);
      } else {
        this.idleTime = time;
      }
      this.emit();
      return;
    }
    if (this.controller === undefined) {
      // Focus starts at the current composition time; the program stops first.
      const time =
        this.status === 'available' && this.player !== undefined
          ? this.player.getState().time
          : this.idleTime;
      this.player?.pause();
      this.attachController(this.options.createController());
      await this.controller?.seek(time);
    }
    this.scoped = true;
    await this.controller?.setScope(scope);
    this.emit();
  }

  async prepareAudioContextChange(): Promise<void> {
    await this.controller?.prepareAudioContextChange();
  }

  subscribe(listener: OtioPlaybackListener): () => void {
    this.listeners.add(listener);
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

  /** The program failed after it loaded: composition play is rejected from here on. */
  private async failProgram(reason: OtioProgramReason): Promise<void> {
    if (this.disposed || this.player === undefined) return;
    const time = this.player.getState().time;
    this.playerUnsubscribe?.();
    this.playerUnsubscribe = undefined;
    this.player.dispose();
    this.player = undefined;
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

function idleState(
  time: OtioRationalTime,
  duration: OtioRationalTime
): OtioPlaybackState {
  return {
    time,
    scope: null,
    playing: false,
    buffering: false,
    duration,
    rate: 1,
    diagnostics: [],
    tracks: {},
    baseMediaPreviewAllowed: false,
    previewBlocked: false,
    graphicsFailed: false,
  };
}
