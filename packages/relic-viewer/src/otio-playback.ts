/**
 * OpenTimelineIO native composition and playback controller for Relik viewer.
 *
 * Requirements:
 * - Driven solely by shared evaluator (evaluateOtioAt, OtioDocumentV1).
 * - Synchronized transport: play(), pause(), seek(time), subscribe().
 * - Frame / source offset accuracy with rational time arithmetic.
 * - Multi-track video composition in stack painter order (first child at bottom).
 * - Offscreen intermediate track surfaces with premultiplied weighted blend for SMPTE_Dissolve.
 * - Alpha composited over opaque black.
 * - Video elements are muted to prevent accidental embedded audio emissions.
 * - Authored audio tracks sum independently via Web Audio API, with per-track gain/mute/solo.
 * - FreezeFrame & LinearTimeWarp handling; explicit unsupported-browser refusal for reverse playback.
 * - ImageSequenceReference support with start_frame, frame_step, rate, padding, and error/hold/black policies.
 * - Bounded memory & resource lifecycle: revokes Object URLs, stops audio, cleans up listeners & rAF on dispose.
 */

import type {
  OtioAudioContribution,
  OtioDiagnostic,
  OtioDocumentV1,
  OtioEffect,
  OtioMediaReference,
  OtioNode,
  OtioRationalTime,
  OtioVideoContribution,
} from '@relic/format';
import {
  addRationalTimes,
  compareRationalTimes,
  evaluateOtioAt,
  rangeEndTime,
  rescaleTime,
  secondsToTime,
  timeToSeconds,
} from '@relic/format';
import {
  inferMediaMimeType,
  type OtioMediaResolver,
  resolveImageSequenceFramePath,
} from './otio-media.ts';

export interface OtioTrackState {
  readonly id: string;
  readonly name: string;
  readonly kind: 'Video' | 'Audio';
  readonly visible: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
}

export interface OtioPlaybackState {
  readonly time: OtioRationalTime;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly duration: OtioRationalTime;
  readonly rate: number;
  readonly diagnostics: readonly OtioDiagnostic[];
  readonly tracks: Readonly<Record<string, OtioTrackState>>;
}

export type OtioPlaybackListener = (state: OtioPlaybackState) => void;

export interface CreateOtioPlaybackOptions {
  readonly document: OtioDocumentV1;
  readonly timelineId: string;
  readonly canvas: HTMLCanvasElement;
  readonly resolveMedia:
    | OtioMediaResolver
    | ((bundlePath: string) => Promise<string | Blob | null> | string | Blob | null);
  readonly audioContext?: AudioContext;
}

export interface OtioPlaybackController {
  getState(): OtioPlaybackState;
  play(): Promise<void>;
  pause(): void;
  seek(time: OtioRationalTime): Promise<void>;
  subscribe(listener: OtioPlaybackListener): () => void;
  setTrackVisibility(trackId: string, visible: boolean): void;
  setTrackMute(trackId: string, muted: boolean): void;
  setTrackSolo(trackId: string, solo: boolean): void;
  dispose(): void;
}

interface LoadedVideo {
  readonly element: HTMLVideoElement;
  readonly url: string;
  ready: boolean;
}

interface LoadedAudio {
  readonly element: HTMLAudioElement;
  readonly url: string;
  sourceNode?: MediaElementAudioSourceNode;
  gainNode?: GainNode;
  ready: boolean;
}

interface LoadedImage {
  readonly element: HTMLImageElement;
  readonly url: string;
  ready: boolean;
}

/**
 * Determine the timeline's editorial duration and nominal rate.
 */
function computeTimelineDuration(
  doc: OtioDocumentV1,
  timelineId: string
): { duration: OtioRationalTime; rate: number } {
  const timelineNode = doc.nodes[timelineId];
  const rate =
    timelineNode?.global_start_time?.rate ??
    timelineNode?.source_range?.duration.rate ??
    24;

  if (timelineNode?.source_range?.duration && timelineNode.source_range.duration.value > 0) {
    return {
      duration: timelineNode.source_range.duration,
      rate: timelineNode.source_range.duration.rate,
    };
  }

  // Calculate max extent of child tracks
  let maxEndTime: OtioRationalTime = { value: 0, rate };

  function inspectNode(node: OtioNode): void {
    if (node.timeline_range) {
      const end = rangeEndTime(node.timeline_range);
      if (compareRationalTimes(end, maxEndTime) > 0) {
        maxEndTime = end;
      }
    }
    if (node.parent_range) {
      const end = rangeEndTime(node.parent_range);
      if (compareRationalTimes(end, maxEndTime) > 0) {
        maxEndTime = end;
      }
    }
    if (node.children_ids) {
      for (const childId of node.children_ids) {
        const child = doc.nodes[childId];
        if (child) inspectNode(child);
      }
    }
  }

  if (timelineNode) {
    inspectNode(timelineNode);
  }

  return {
    duration: maxEndTime.value > 0 ? maxEndTime : { value: 0, rate },
    rate,
  };
}

/**
 * Find all tracks in the timeline hierarchy.
 */
function collectTracks(
  doc: OtioDocumentV1,
  timelineId: string
): Record<string, OtioTrackState> {
  const tracks: Record<string, OtioTrackState> = {};
  const timelineNode = doc.nodes[timelineId];
  if (!timelineNode) return tracks;

  function traverse(node: OtioNode): void {
    if (node.schema.startsWith('Track')) {
      const kind = node.track_kind === 'Audio' ? 'Audio' : 'Video';
      tracks[node.id] = {
        id: node.id,
        name: node.name || (kind === 'Audio' ? 'Audio Track' : 'Video Track'),
        kind,
        visible: node.enabled !== false,
        muted: false,
        solo: false,
      };
    }
    if (node.children_ids) {
      for (const childId of node.children_ids) {
        const child = doc.nodes[childId];
        if (child) traverse(child);
      }
    }
  }

  traverse(timelineNode);
  return tracks;
}

/**
 * Create an OtioPlaybackController.
 */
export function createOtioPlayback(
  options: CreateOtioPlaybackOptions
): OtioPlaybackController {
  const { document: doc, timelineId, canvas, resolveMedia } = options;

  const { duration, rate } = computeTimelineDuration(doc, timelineId);
  const tracks: Record<string, OtioTrackState> = collectTracks(doc, timelineId);

  let currentTime: OtioRationalTime = { value: 0, rate };
  let isPlaying = false;
  let isBuffering = false;
  let isDisposed = false;

  let animFrameId: number | null = null;
  let lastFrameTimestamp: number | null = null;

  const listeners = new Set<OtioPlaybackListener>();
  const customDiagnostics: OtioDiagnostic[] = [];

  // Media caches
  const videoPool = new Map<string, LoadedVideo>();
  const audioPool = new Map<string, LoadedAudio>();
  const imagePool = new Map<string, LoadedImage>();
  const lastValidImageSequenceFrames = new Map<string, HTMLImageElement>();
  const localBlobUrls: string[] = [];

  // Intermediate offscreen surfaces for transition blending per track
  let trackCanvas: HTMLCanvasElement | null = null;
  let trackCtx: CanvasRenderingContext2D | null = null;

  // Web Audio Context setup
  let audioContext: AudioContext | null = options.audioContext ?? null;
  let masterGainNode: GainNode | null = null;
  const trackGainNodes = new Map<string, GainNode>();

  function getAudioContext(): AudioContext | null {
    if (isDisposed) return null;
    if (!audioContext && typeof AudioContext !== 'undefined') {
      try {
        audioContext = new AudioContext();
      } catch {
        audioContext = null;
      }
    }
    if (audioContext && !masterGainNode) {
      try {
        masterGainNode = audioContext.createGain();
        masterGainNode.connect(audioContext.destination);
      } catch {
        masterGainNode = null;
      }
    }
    return audioContext;
  }

  function getTrackGainNode(trackId: string): GainNode | null {
    const ctx = getAudioContext();
    if (!ctx || !masterGainNode) return null;

    let node = trackGainNodes.get(trackId);
    if (!node) {
      try {
        node = ctx.createGain();
        node.connect(masterGainNode);
        trackGainNodes.set(trackId, node);
      } catch {
        return null;
      }
    }
    return node;
  }

  function updateAudioGains(): void {
    const hasAnyAudioSolo = Object.values(tracks).some(
      (t) => t.kind === 'Audio' && t.solo
    );

    for (const [trackId, track] of Object.entries(tracks)) {
      if (track.kind !== 'Audio') continue;
      const gainNode = getTrackGainNode(trackId);
      if (!gainNode) continue;

      let targetGain = 1.0;
      if (track.muted) {
        targetGain = 0;
      } else if (hasAnyAudioSolo && !track.solo) {
        targetGain = 0;
      }

      try {
        gainNode.gain.value = targetGain;
      } catch {
        // Ignore audio node gain adjustment error
      }
    }
  }

  function getTrackIntermediateCanvas(width: number, height: number): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  } | null {
    if (typeof document === 'undefined') return null;
    if (!trackCanvas) {
      trackCanvas = document.createElement('canvas');
      trackCanvas.width = width;
      trackCanvas.height = height;
      trackCtx = trackCanvas.getContext('2d');
    } else {
      if (trackCanvas.width !== width || trackCanvas.height !== height) {
        trackCanvas.width = width;
        trackCanvas.height = height;
      }
    }
    if (!trackCtx) return null;
    return { canvas: trackCanvas, ctx: trackCtx };
  }

  async function resolveBundleMediaUrl(bundlePath: string): Promise<string | null> {
    if (isDisposed) return null;

    // Check if resolver is OtioMediaResolver object
    if (typeof resolveMedia === 'object' && resolveMedia !== null && 'resolveUrl' in resolveMedia) {
      return await resolveMedia.resolveUrl(bundlePath);
    }

    // Function resolver
    if (typeof resolveMedia === 'function') {
      const res = await resolveMedia(bundlePath);
      if (typeof res === 'string') {
        return res;
      }
      if (res instanceof Blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(res);
        localBlobUrls.push(url);
        return url;
      }
    }

    return null;
  }

  async function acquireVideo(bundlePath: string): Promise<LoadedVideo | null> {
    if (isDisposed) return null;
    const existing = videoPool.get(bundlePath);
    if (existing) return existing;

    const mediaUrl = await resolveBundleMediaUrl(bundlePath);
    if (!mediaUrl || isDisposed) return null;

    if (typeof document === 'undefined') return null;
    const element = document.createElement('video');
    element.preload = 'auto';
    element.playsInline = true;
    // CRITICAL: video elements must NEVER emit accidental embedded audio!
    element.muted = true;
    element.volume = 0;
    element.src = mediaUrl;

    const entry: LoadedVideo = {
      element,
      url: mediaUrl,
      ready: false,
    };
    videoPool.set(bundlePath, entry);

    // Wait for metadata
    if (element.readyState >= 1) {
      entry.ready = true;
    } else {
      const { promise, resolve } = Promise.withResolvers<void>();
      const onLoaded = () => {
        element.removeEventListener('loadedmetadata', onLoaded);
        element.removeEventListener('error', onError);
        entry.ready = true;
        resolve();
      };
      const onError = () => {
        element.removeEventListener('loadedmetadata', onLoaded);
        element.removeEventListener('error', onError);
        entry.ready = false;
        resolve();
      };
      element.addEventListener('loadedmetadata', onLoaded);
      element.addEventListener('error', onError);
      await promise;
    }
    return entry;
  }

  async function acquireImage(bundlePath: string): Promise<LoadedImage | null> {
    if (isDisposed) return null;
    const existing = imagePool.get(bundlePath);
    if (existing) return existing;

    const mediaUrl = await resolveBundleMediaUrl(bundlePath);
    if (!mediaUrl || isDisposed) return null;

    if (typeof Image === 'undefined') return null;
    const element = new Image();
    element.src = mediaUrl;

    const entry: LoadedImage = {
      element,
      url: mediaUrl,
      ready: false,
    };
    imagePool.set(bundlePath, entry);
    if (element.complete && element.naturalWidth > 0) {
      entry.ready = true;
    } else {
      const { promise, resolve } = Promise.withResolvers<void>();
      element.onload = () => {
        entry.ready = true;
        resolve();
      };
      element.onerror = () => {
        entry.ready = false;
        resolve();
      };
      await promise;
    }
    return entry;
  }

  async function acquireAudio(
    trackId: string,
    bundlePath: string
  ): Promise<LoadedAudio | null> {
    if (isDisposed) return null;
    const cacheKey = `${trackId}:${bundlePath}`;
    const existing = audioPool.get(cacheKey);
    if (existing) return existing;

    const mediaUrl = await resolveBundleMediaUrl(bundlePath);
    if (!mediaUrl || isDisposed) return null;

    if (typeof Audio === 'undefined') return null;
    const element = new Audio(mediaUrl);
    element.preload = 'auto';

    const entry: LoadedAudio = {
      element,
      url: mediaUrl,
      ready: false,
    };
    audioPool.set(cacheKey, entry);

    const trackGain = getTrackGainNode(trackId);
    const ctx = getAudioContext();
    if (ctx && trackGain) {
      try {
        const sourceNode = ctx.createMediaElementSource(element);
        const clipGain = ctx.createGain();
        sourceNode.connect(clipGain);
        clipGain.connect(trackGain);
        entry.sourceNode = sourceNode;
        entry.gainNode = clipGain;
      } catch {
        // Fallback without Web Audio routing if MediaElementSource unavailable
      }
    }

    return entry;
  }

  function seekMediaElement(
    media: HTMLMediaElement,
    targetSeconds: number
  ): Promise<void> {
    if (Math.abs(media.currentTime - targetSeconds) <= 0.01) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    const onSeeked = () => {
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('error', onError);
      resolve();
    };
    media.addEventListener('seeked', onSeeked);
    media.addEventListener('error', onError);
    try {
      media.currentTime = Math.max(0, targetSeconds);
    } catch {
      resolve();
    }
    return promise;
  }

  /**
   * Render composition onto canvas and synchronize audio.
   */
  async function renderComposition(
    time: OtioRationalTime,
    awaitDecodedFrames: boolean
  ): Promise<void> {
    if (isDisposed) return;

    customDiagnostics.length = 0;
    const evalResult = evaluateOtioAt(doc, timelineId, time);

    // Group video contributions by track
    const videoTracksMap = new Map<string, OtioVideoContribution[]>();
    for (const contrib of evalResult.video_contributions) {
      let list = videoTracksMap.get(contrib.track_id);
      if (!list) {
        list = [];
        videoTracksMap.set(contrib.track_id, list);
      }
      list.push(contrib);
    }

    // Check if any video track is soloed
    const hasAnyVideoSolo = Object.values(tracks).some(
      (t) => t.kind === 'Video' && t.solo
    );

    // Gather tracks in stack painter order: lowest track_index first (first child at bottom)
    const sortedTrackIds = Array.from(videoTracksMap.keys()).sort((a, b) => {
      const idxA = videoTracksMap.get(a)?.[0]?.track_index ?? 0;
      const idxB = videoTracksMap.get(b)?.[0]?.track_index ?? 0;
      return idxA - idxB;
    });

    const ctx = canvas.getContext('2d');
    const width = canvas.width || 1920;
    const height = canvas.height || 1080;

    // Clear canvas with opaque black
    if (ctx) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
    }

    const intermediate = getTrackIntermediateCanvas(width, height);

    // Process each video track in painter order
    for (const trackId of sortedTrackIds) {
      const trackState = tracks[trackId];
      if (trackState) {
        if (!trackState.visible) continue;
        if (hasAnyVideoSolo && !trackState.solo) continue;
      }

      const contribs = videoTracksMap.get(trackId) ?? [];
      if (contribs.length === 0) continue;

      if (intermediate) {
        intermediate.ctx.clearRect(0, 0, width, height);
      }

      for (let cIdx = 0; cIdx < contribs.length; cIdx++) {
        const contrib = contribs[cIdx] as OtioVideoContribution;
        const clipNode = doc.nodes[contrib.node_id];

        // Validate effects
        for (const eff of contrib.active_effects) {
          if (!eff.enabled) continue;
          if (eff.schema.startsWith('LinearTimeWarp')) {
            if (eff.time_scalar !== undefined && eff.time_scalar < 0) {
              customDiagnostics.push({
                severity: 'error',
                code: 'unsupported-browser',
                message: `Reverse playback (time_scalar: ${eff.time_scalar}) is not supported by browser video decoder`,
                target: { node_id: contrib.node_id },
              });
            }
          } else if (!eff.schema.startsWith('FreezeFrame')) {
            customDiagnostics.push({
              severity: 'warning',
              code: 'unsupported-effect',
              message: `Unsupported effect: ${eff.name || eff.schema}`,
              target: { node_id: contrib.node_id },
            });
          }
        }

        // Determine media reference
        const activeKey = clipNode?.active_media_reference_key;
        const activeMedia = activeKey && clipNode?.media_references
          ? clipNode.media_references[activeKey]
          : null;

        let drawableElement: CanvasImageSource | null = null;
        let isImageSeq = false;

        if (activeMedia?.schema.startsWith('ImageSequenceReference')) {
          isImageSeq = true;
          const framePath = resolveImageSequenceFramePath(
            activeMedia,
            contrib.source_time
          );

          if (!framePath) {
            customDiagnostics.push({
              severity: 'error',
              code: 'missing-media',
              message: `Could not resolve image sequence frame at source time ${contrib.source_time.value}/${contrib.source_time.rate}`,
              target: { node_id: contrib.node_id },
            });
          } else {
            const mime = inferMediaMimeType(framePath);
            if (mime === 'image/x-exr' || mime === 'image/x-dpx') {
              customDiagnostics.push({
                severity: 'error',
                code: 'unsupported-codec',
                message: `Unsupported image decoder: ${framePath}`,
                target: { node_id: contrib.node_id },
              });
            } else {
              const loaded = await acquireImage(framePath);
              if (loaded && loaded.ready) {
                drawableElement = loaded.element;
                lastValidImageSequenceFrames.set(contrib.node_id, loaded.element);
              } else {
                // Apply missing frame policy
                const policy = activeMedia.missing_frame_policy ?? 'error';
                if (policy === 'hold') {
                  const held = lastValidImageSequenceFrames.get(contrib.node_id);
                  if (held) {
                    drawableElement = held;
                  }
                } else if (policy === 'black') {
                  // Transparent on track surface, black background
                  drawableElement = null;
                } else {
                  customDiagnostics.push({
                    severity: 'error',
                    code: 'missing-media',
                    message: `Missing frame in image sequence: ${framePath}`,
                    target: { node_id: contrib.node_id },
                  });
                }
              }
            }
          }
        } else if (contrib.bundle_path) {
          const mime = inferMediaMimeType(contrib.bundle_path);
          if (mime.startsWith('video/')) {
            const videoLoaded = await acquireVideo(contrib.bundle_path);
            if (!videoLoaded || !videoLoaded.ready) {
              customDiagnostics.push({
                severity: 'error',
                code: 'missing-media',
                message: `Missing or unplayable video: ${contrib.bundle_path}`,
                target: { node_id: contrib.node_id },
              });
            } else {
              const targetSec = Math.max(0, timeToSeconds(contrib.source_time));
              if (awaitDecodedFrames) {
                await seekMediaElement(videoLoaded.element, targetSec);
              } else if (Math.abs(videoLoaded.element.currentTime - targetSec) > 0.05) {
                videoLoaded.element.currentTime = targetSec;
              }
              drawableElement = videoLoaded.element;
            }
          } else if (mime.startsWith('image/')) {
            const imgLoaded = await acquireImage(contrib.bundle_path);
            if (!imgLoaded || !imgLoaded.ready) {
              customDiagnostics.push({
                severity: 'error',
                code: 'missing-media',
                message: `Missing image: ${contrib.bundle_path}`,
                target: { node_id: contrib.node_id },
              });
            } else {
              drawableElement = imgLoaded.element;
            }
          } else {
            customDiagnostics.push({
              severity: 'error',
              code: 'unsupported-codec',
              message: `Unsupported codec for ${contrib.bundle_path}`,
              target: { node_id: contrib.node_id },
            });
          }
        } else {
          customDiagnostics.push({
            severity: 'error',
            code: 'missing-media',
            message: `No media reference for clip: ${contrib.name}`,
            target: { node_id: contrib.node_id },
          });
        }

        // Draw onto intermediate track surface
        if (drawableElement && intermediate) {
          const weight = Math.max(
            0,
            Math.min(1, contrib.transition_weight * contrib.alpha)
          );

          if (cIdx === 0) {
            intermediate.ctx.globalCompositeOperation = 'source-over';
            intermediate.ctx.globalAlpha = weight;
            intermediate.ctx.drawImage(drawableElement, 0, 0, width, height);
          } else {
            // Premultiplied weighted blend for transitions
            intermediate.ctx.globalCompositeOperation = 'lighter';
            intermediate.ctx.globalAlpha = weight;
            intermediate.ctx.drawImage(drawableElement, 0, 0, width, height);
          }
        }
      }

      // Composite track surface onto main canvas
      if (intermediate && ctx) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.drawImage(intermediate.canvas, 0, 0, width, height);
      }
    }

    // Synchronize Audio Contributions
    updateAudioGains();
    for (const audioContrib of evalResult.audio_contributions) {
      if (!audioContrib.bundle_path) continue;
      const audioTrack = tracks[audioContrib.track_id];
      if (audioTrack && audioTrack.muted) continue;

      const loaded = await acquireAudio(audioContrib.track_id, audioContrib.bundle_path);
      if (!loaded) continue;

      const targetSec = Math.max(0, timeToSeconds(audioContrib.source_time));
      if (Math.abs(loaded.element.currentTime - targetSec) > 0.15) {
        loaded.element.currentTime = targetSec;
      }

      const effectiveVolume = audioContrib.volume * audioContrib.transition_weight;
      if (loaded.gainNode) {
        loaded.gainNode.gain.value = effectiveVolume;
      } else {
        loaded.element.volume = effectiveVolume;
      }

      if (isPlaying && loaded.element.paused) {
        try {
          await loaded.element.play();
        } catch {
          // Ignore autoplay restriction or playback interruption
        }
      } else if (!isPlaying && !loaded.element.paused) {
        loaded.element.pause();
      }
    }
  }

  function notify(): void {
    if (isDisposed) return;
    const currentState = getState();
    for (const listener of listeners) {
      try {
        listener(currentState);
      } catch {
        // Prevent subscriber error from crashing playback loop
      }
    }
  }

  function tick(timestamp: number): void {
    if (isDisposed || !isPlaying) return;

    if (lastFrameTimestamp !== null) {
      const elapsedSeconds = (timestamp - lastFrameTimestamp) / 1000;
      const deltaFrames = elapsedSeconds * rate;
      const newTime = addRationalTimes(currentTime, {
        value: deltaFrames,
        rate,
      });

      if (compareRationalTimes(newTime, duration) >= 0) {
        currentTime = duration;
        isPlaying = false;
        pauseAllMedia();
        renderComposition(currentTime, false);
        notify();
        return;
      } else {
        currentTime = newTime;
      }
    }

    lastFrameTimestamp = timestamp;
    renderComposition(currentTime, false);
    notify();

    if (isPlaying && !isDisposed) {
      if (typeof requestAnimationFrame !== 'undefined') {
        animFrameId = requestAnimationFrame(tick);
      }
    }
  }

  function pauseAllMedia(): void {
    for (const video of videoPool.values()) {
      video.element.pause();
    }
    for (const audio of audioPool.values()) {
      audio.element.pause();
    }
  }

  function getState(): OtioPlaybackState {
    const evalRes = evaluateOtioAt(doc, timelineId, currentTime);
    const allDiagnostics = [
      ...evalRes.diagnostics,
      ...customDiagnostics,
    ];

    // Deduplicate diagnostics
    const seen = new Set<string>();
    const deduplicated: OtioDiagnostic[] = [];
    for (const diag of allDiagnostics) {
      const key = `${diag.code}:${diag.message}:${diag.target?.node_id ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(diag);
      }
    }

    return {
      time: currentTime,
      playing: isPlaying,
      buffering: isBuffering,
      duration,
      rate,
      diagnostics: deduplicated,
      tracks: { ...tracks },
    };
  }

  // Initial draw
  renderComposition(currentTime, false);

  return {
    getState,

    async play(): Promise<void> {
      if (isDisposed || isPlaying) return;

      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          // Ignore audio context resume error
        }
      }

      isPlaying = true;
      lastFrameTimestamp = null;
      notify();

      if (typeof requestAnimationFrame !== 'undefined') {
        animFrameId = requestAnimationFrame(tick);
      }
    },

    pause(): void {
      if (isDisposed || !isPlaying) return;
      isPlaying = false;
      if (animFrameId !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      pauseAllMedia();
      notify();
    },

    async seek(time: OtioRationalTime): Promise<void> {
      if (isDisposed) return;

      let clamped = time;
      if (time.value < 0) {
        clamped = { value: 0, rate: time.rate };
      } else if (compareRationalTimes(time, duration) > 0) {
        clamped = duration;
      }

      currentTime = rescaleTime(clamped, rate);
      isBuffering = true;
      notify();

      await renderComposition(currentTime, true);

      isBuffering = false;
      notify();
    },

    subscribe(listener: OtioPlaybackListener): () => void {
      listeners.add(listener);
      listener(getState());
      return () => {
        listeners.delete(listener);
      };
    },

    setTrackVisibility(trackId: string, visible: boolean): void {
      if (isDisposed) return;
      const track = tracks[trackId];
      if (track) {
        tracks[trackId] = { ...track, visible };
        renderComposition(currentTime, false);
        notify();
      }
    },

    setTrackMute(trackId: string, muted: boolean): void {
      if (isDisposed) return;
      const track = tracks[trackId];
      if (track) {
        tracks[trackId] = { ...track, muted };
        updateAudioGains();
        notify();
      }
    },

    setTrackSolo(trackId: string, solo: boolean): void {
      if (isDisposed) return;
      const track = tracks[trackId];
      if (track) {
        tracks[trackId] = { ...track, solo };
        updateAudioGains();
        renderComposition(currentTime, false);
        notify();
      }
    },

    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;

      if (animFrameId !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }

      pauseAllMedia();

      for (const video of videoPool.values()) {
        try {
          video.element.src = '';
          video.element.load();
        } catch {
          // Ignore video element load/reset error
        }
      }
      videoPool.clear();

      for (const audio of audioPool.values()) {
        try {
          audio.element.src = '';
          audio.element.load();
          audio.gainNode?.disconnect();
          audio.sourceNode?.disconnect();
        } catch {
          // Ignore audio element reset error
        }
      }
      audioPool.clear();
      imagePool.clear();
      lastValidImageSequenceFrames.clear();

      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        for (const url of localBlobUrls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Ignore revoke error
          }
        }
      }
      localBlobUrls.length = 0;

      if (typeof resolveMedia === 'object' && resolveMedia !== null && 'dispose' in resolveMedia) {
        try {
          resolveMedia.dispose();
        } catch {
          // Ignore resolver dispose error
        }
      }

      if (audioContext && !options.audioContext) {
        try {
          audioContext.close();
        } catch {
          // Ignore audio context close error
        }
      }
      audioContext = null;
      masterGainNode = null;
      trackGainNodes.clear();

      listeners.clear();
      trackCanvas = null;
      trackCtx = null;

      // Clear main canvas
      const ctx = canvas.getContext('2d');
      if (ctx) {
        try {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } catch {
          // Ignore canvas clear error
        }
      }
    },
  };
}
