import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type {
  OtioBundleEntryName,
  OtioDocumentV1,
  OtioNode,
  OtioRationalTime,
} from '@relic/format';
import {
  compareRationalTimes,
  evaluateOtioAt,
  readOtioDocument,
} from '@relic/format';
import type { OtioMediaResolver } from '../src/otio-media.ts';
import {
  createOtioPlayback,
  decodedImageAllowed,
  ImageFrameCache,
  OTIO_MAX_IMAGE_EDGE,
  type OtioPlaybackController,
  type OtioPreparedLeaf,
  type OtioVideoCompositionTree,
  renderOtioVideoTree,
  checkNativeTimingEligibility,
  computePhaseAnchor,
  OTIO_PACKET_START_TOLERANCE_SECONDS,
  presentedWindowOutcome,
  SNAPSHOT_SLOTS_PER_DECODER,
} from '../src/otio-playback.ts';
import {
  certifiedWindowIndex,
  minWindowDuration,
  NativeDecoderRing,
  SnapshotPixelBudget,
} from '../src/otio-video-decoders.ts';
import type {
  OtioVideoTiming,
  readOtioVideoTiming,
} from '../src/otio-video-timing.ts';

type ReadVideoTiming = typeof readOtioVideoTiming;
const OTIO_GRAPHICS_RESTORE_MS = 3000;

const standardFixtureUrl = new URL(
  '../../relic-format/test/fixtures/otio/standard-sample.otiod/content.otio',
  import.meta.url
);

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

class SoftCanvas {
  width = 1;
  height = 1;
  pixel: Pixel = { r: 0, g: 0, b: 0, a: 0 };
  readonly style = { visibility: '' };
  readonly ctx = new SoftContext(this);

  isContextLost(): boolean {
    return false;
  }

  getContext(kind: string): SoftContext | null {
    return kind === '2d' ? this.ctx : null;
  }
}

class LossyCanvas extends SoftCanvas {
  private lost = false;
  readonly listeners = new Map<string, Set<(e: Event) => void>>();

  addEventListener(type: string, listener: (e: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  loseContext(): void {
    this.lost = true;
    const event = { type: 'contextlost' } as Event;
    const set = this.listeners.get('contextlost');
    if (set) {
      for (const listener of Array.from(set)) {
        listener(event);
      }
    }
  }

  restoreContext(): void {
    this.lost = false;
    const event = { type: 'contextrestored' } as Event;
    const set = this.listeners.get('contextrestored');
    if (set) {
      for (const listener of Array.from(set)) {
        listener(event);
      }
    }
  }

  override isContextLost(): boolean {
    return this.lost;
  }
}

class SoftContext {
  fillStyle = '#000000';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  readonly drawnSources: Array<{ source: unknown }> = [];

  constructor(private readonly canvas: SoftCanvas) {}

  clearRect(): void {
    this.canvas.pixel = { r: 0, g: 0, b: 0, a: 0 };
  }

  fillRect(): void {
    this.blend({ ...parseColor(this.fillStyle), a: 1 });
  }

  drawImage(source: { pixel: Pixel }): void {
    this.drawnSources.push({ source });
    this.blend(source.pixel);
  }
  isContextLost(): boolean {
    return this.canvas.isContextLost();
  }

  private blend(src: Pixel): void {
    const srcA = clamp(src.a * this.globalAlpha);
    const dst = this.canvas.pixel;
    if (this.globalCompositeOperation === 'lighter') {
      this.canvas.pixel = {
        r: dst.r + src.r * srcA,
        g: dst.g + src.g * srcA,
        b: dst.b + src.b * srcA,
        a: clamp(dst.a + srcA),
      };
      return;
    }
    const outA = srcA + dst.a * (1 - srcA);
    const mix = (srcC: number, dstC: number): number =>
      outA === 0 ? 0 : (srcC * srcA + dstC * dst.a * (1 - srcA)) / outA;
    this.canvas.pixel = {
      r: mix(src.r, dst.r),
      g: mix(src.g, dst.g),
      b: mix(src.b, dst.b),
      a: outA,
    };
  }
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseColor(value: string): { r: number; g: number; b: number } {
  if (value === '#ffffff') return { r: 1, g: 1, b: 1 };
  if (value === '#ff0000') return { r: 1, g: 0, b: 0 };
  if (value === '#00ff00') return { r: 0, g: 1, b: 0 };
  if (value === '#0000ff') return { r: 0, g: 0, b: 1 };
  if (value === '#ffff00') return { r: 1, g: 1, b: 0 };
  return { r: 0, g: 0, b: 0 };
}

function solid(color: string): SoftCanvas {
  const canvas = new SoftCanvas();
  canvas.ctx.fillStyle = color;
  canvas.ctx.fillRect();
  return canvas;
}

function paintTree(
  tree: OtioVideoCompositionTree,
  leaves: readonly (OtioPreparedLeaf | null)[]
): Pixel {
  const output = new SoftCanvas();
  renderOtioVideoTree(
    output.ctx as unknown as CanvasRenderingContext2D,
    1,
    1,
    tree,
    leaves,
    () => new SoftCanvas() as unknown as HTMLCanvasElement
  );
  return output.pixel;
}

class MockMedia {
  pixel: Pixel = { r: 1, g: 0, b: 0, a: 1 };
  pixelAt?: (s: number) => Pixel;
  rejectNextPlay = false;
  preload = '';
  playsInline = false;
  muted = false;
  volume = 1;
  paused = true;
  readyState = 0;
  complete = false;
  naturalWidth = 64;
  naturalHeight = 64;
  error: MediaError | null = null;
  playbackRate = 1;
  readonly seekTargets: number[] = [];
  rvfcCallbacks = new Map<
    number,
    (
      now: number,
      metadata: { mediaTime: number; expectedDisplayTime?: number }
    ) => void
  >();
  private nextRvfcHandle = 1;
  hasRvfc = false;

  requestVideoFrameCallback?(
    cb: (
      now: number,
      metadata: { mediaTime: number; expectedDisplayTime?: number }
    ) => void
  ): number;

  cancelVideoFrameCallback?(handle: number): void;

  enableRvfc(): void {
    this.hasRvfc = true;
    this.requestVideoFrameCallback = (
      cb: (
        now: number,
        metadata: { mediaTime: number; expectedDisplayTime?: number }
      ) => void
    ): number => {
      const handle = this.nextRvfcHandle++;
      this.rvfcCallbacks.set(handle, cb);
      return handle;
    };
    this.cancelVideoFrameCallback = (handle: number): void => {
      this.rvfcCallbacks.delete(handle);
    };
  }

  advanceTo(s: number): void {
    this.time = s;
    if (this.pixelAt) {
      this.pixel = this.pixelAt(s);
    }
  }

  triggerRvfc(
    now: number,
    mediaTime: number,
    expectedDisplayTime?: number
  ): void {
    this.advanceTo(mediaTime);
    const cbs = Array.from(this.rvfcCallbacks.values());
    this.rvfcCallbacks.clear();
    const metadata: { mediaTime: number; expectedDisplayTime?: number } = {
      mediaTime,
    };
    if (expectedDisplayTime !== undefined) {
      metadata.expectedDisplayTime = expectedDisplayTime;
    }
    for (const cb of cbs) {
      cb(now, metadata);
    }
  }

  private time = 0;
  private source = '';
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    queueMicrotask(() => {
      this.readyState = 2;
      this.complete = true;
      this.dispatch('loadeddata');
      this.onload?.();
    });
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.seekTargets.push(value);
    this.time = value;
    if (this.pixelAt) {
      this.pixel = this.pixelAt(value);
    }
    queueMicrotask(() => {
      this.readyState = 2;
      this.dispatch('seeked');
      this.dispatch('loadeddata');
    });
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  addEventListener(event: string, cb: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  removeEventListener(event: string, cb: () => void): void {
    const list = this.listeners.get(event) ?? [];
    const index = list.indexOf(cb);
    if (index !== -1) list.splice(index, 1);
  }

  dispatch(event: string): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb();
  }

  play(): Promise<void> {
    if (this.rejectNextPlay) {
      this.rejectNextPlay = false;
      return Promise.reject(new Error('play-rejected'));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.readyState = 0;
  }

  remove(): void {}
}
async function waitForRvfc(media: MockMedia, maxYields = 50): Promise<void> {
  for (let i = 0; i < maxYields; i++) {
    if (media.rvfcCallbacks.size > 0) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
  throw new Error('waitForRvfc timed out: no callback registered');
}

async function startNative(
  playback: OtioPlaybackController,
  videoMedia: MockMedia,
  timing: Extract<OtioVideoTiming, { kind: 'windows' }>,
  options?: {
    d1?: number;
    tag?: number;
    t0?: OtioRationalTime;
    rL?: number;
  }
): Promise<number> {
  const d1 = options?.d1 ?? 100;
  const tag = options?.tag ?? 1;
  const t0Val = options?.t0 ? options.t0.value / options.t0.rate : 0;
  const rL = options?.rL ?? 1;
  const playPromise = playback.play();
  await waitForRvfc(videoMedia);
  const mediaTime = timing.starts[tag] ?? tag / 30;
  videoMedia.triggerRvfc(d1, mediaTime);
  await playPromise;
  const nu = 1 / 60;
  const wMin = minWindowDuration(timing, rL);
  const startK = timing.starts[tag] ?? 0;
  const tau = d1 + ((nu + 2 * wMin) / 2 - (startK - t0Val) / rL) * 1000;
  return tau;
}

class MockGain {
  readonly gain = { value: 1 };
  connect(): void {}
  disconnect(): void {}
}

class MockAudioContext {
  state = 'running';
  destination = {};
  readonly gains: MockGain[] = [];

  createGain(): MockGain {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }

  createMediaElementSource(): { connect: () => void; disconnect: () => void } {
    return { connect() {}, disconnect() {} };
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

class MockVideoFrame {
  static constructions = 0;
  static closes = 0;
  static throwInConstructor = false;
  static timestampOverride: number | null = null;

  static reset(): void {
    MockVideoFrame.constructions = 0;
    MockVideoFrame.closes = 0;
    MockVideoFrame.throwInConstructor = false;
    MockVideoFrame.timestampOverride = null;
  }

  readonly timestamp: number;
  readonly pixel: Pixel;
  private closed = false;

  constructor(source: unknown) {
    MockVideoFrame.constructions++;
    if (MockVideoFrame.throwInConstructor) {
      throw new Error('VideoFrame constructor failed');
    }
    const media = source as { currentTime?: number; pixel?: Pixel };
    const timeSeconds = media.currentTime ?? 0;
    let effectiveSeconds = timeSeconds;
    for (const r of [30, 24]) {
      const k = Math.floor(timeSeconds * r + 1e-4);
      if (Math.abs(timeSeconds - (k + 0.5) / r) < 1e-5) {
        effectiveSeconds = k / r;
        break;
      }
    }
    this.timestamp =
      MockVideoFrame.timestampOverride !== null
        ? MockVideoFrame.timestampOverride
        : Math.round(effectiveSeconds * 1e6);
    this.pixel = media.pixel ? { ...media.pixel } : { r: 0, g: 0, b: 0, a: 1 };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      MockVideoFrame.closes++;
    }
  }
}

function hostElement(): {
  className: string;
  style: Record<string, string>;
  setAttribute: () => void;
  appendChild: () => void;
  remove: () => void;
} {
  return {
    className: '',
    style: {},
    setAttribute() {},
    appendChild() {},
    remove() {},
  };
}

function node(
  partial: Partial<OtioNode> & Pick<OtioNode, 'id' | 'schema'>
): OtioNode {
  return {
    identity_origin: 'authored',
    json_pointer: `/${partial.id}`,
    name: partial.id,
    enabled: true,
    parent_id: null,
    children_ids: [],
    ...partial,
  };
}

function range(start: number, duration: number, rate: number) {
  return {
    start_time: { value: start, rate },
    duration: { value: duration, rate },
  };
}

function buildDocument(options?: {
  rate?: number;
  frames?: number;
  timelineRate?: number;
  timelineFrames?: number;
  audioFrames?: number;
  audioTransition?: boolean;
  effect?: boolean;
}): OtioDocumentV1 {
  const rate = options?.rate ?? 24;
  const frames = options?.frames ?? 48;
  const timelineRate = options?.timelineRate ?? rate;
  const timelineFrames = options?.timelineFrames ?? frames;
  const audioFrames = options?.audioFrames ?? frames;
  const transitionHandle = 6;
  const audioChildren = options?.audioTransition
    ? ['audio_a', 'audio_trans', 'audio_b']
    : ['audio_a'];
  const nodes: Record<string, OtioNode> = {
    timeline_1: node({
      id: 'timeline_1',
      schema: 'Timeline.1',
      children_ids: ['stack_1'],
      source_range: range(0, frames, rate),
      timeline_range: range(0, timelineFrames, timelineRate),
    }),
    stack_1: node({
      id: 'stack_1',
      schema: 'Stack.1',
      parent_id: 'timeline_1',
      children_ids: ['track_v', 'track_a'],
    }),
    track_v: node({
      id: 'track_v',
      schema: 'Track.1',
      parent_id: 'stack_1',
      children_ids: ['clip_v'],
      track_kind: 'Video',
    }),
    clip_v: node({
      id: 'clip_v',
      schema: 'Clip.1',
      parent_id: 'track_v',
      source_range: range(0, frames, rate),
      parent_range: range(0, frames, rate),
      timeline_range: range(0, frames, rate),
      visible_timeline_range: range(0, frames, rate),
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          schema: 'ExternalReference.1',
          target_url: 'media/clip.mp4',
        },
      },
      effects: options?.effect
        ? [{ schema: 'CustomEffect.1', name: 'Glow', enabled: true }]
        : [],
    }),
    track_a: node({
      id: 'track_a',
      schema: 'Track.1',
      parent_id: 'stack_1',
      children_ids: audioChildren,
      track_kind: 'Audio',
    }),
    audio_a: node({
      id: 'audio_a',
      schema: 'Clip.1',
      parent_id: 'track_a',
      source_range: range(0, audioFrames, rate),
      parent_range: range(0, audioFrames, rate),
      timeline_range: range(0, audioFrames, rate),
      visible_timeline_range: range(
        0,
        audioFrames + (options?.audioTransition ? transitionHandle : 0),
        rate
      ),
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          schema: 'ExternalReference.1',
          target_url: 'media/dialogue.wav',
        },
      },
    }),
  };
  if (options?.audioTransition) {
    nodes.audio_b = node({
      id: 'audio_b',
      schema: 'Clip.1',
      parent_id: 'track_a',
      source_range: range(0, 24, rate),
      parent_range: range(audioFrames, 24, rate),
      timeline_range: range(audioFrames, 24, rate),
      visible_timeline_range: range(
        audioFrames - transitionHandle,
        24 + transitionHandle,
        rate
      ),
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          schema: 'ExternalReference.1',
          target_url: 'media/dialogue.wav',
        },
      },
    });
    nodes.audio_trans = node({
      id: 'audio_trans',
      schema: 'Transition.1',
      parent_id: 'track_a',
      transition_type: 'SMPTE_Dissolve',
      in_offset: { value: 6, rate },
      out_offset: { value: 6, rate },
      timeline_range: range(
        audioFrames - transitionHandle,
        transitionHandle * 2,
        rate
      ),
    });
  }
  return {
    version: 1,
    document_sha256: 'doc',
    timeline_ids: ['timeline_1'],
    nodes,
    media: {},
    diagnostics: [],
    global_start_times: { timeline_1: { value: 0, rate: 30 } },
  };
}

function sampledMediaDocument(options: {
  readonly kind: 'Video' | 'Audio';
  readonly rate: number;
  readonly duration: number;
  readonly availableStart?: number;
  readonly sourceStart?: OtioRationalTime;
  readonly availableStartTime?: OtioRationalTime;
  readonly includeAvailableRange?: boolean;
  readonly targetUrl?: string;
}): OtioDocumentV1 {
  const {
    kind,
    rate,
    duration,
    availableStart = 0,
    sourceStart = { value: 0, rate },
    availableStartTime = { value: availableStart, rate },
    includeAvailableRange = true,
    targetUrl: explicitTargetUrl,
  } = options;
  const trackId = kind === 'Video' ? 'track_v' : 'track_a';
  const clipId = kind === 'Video' ? 'clip_v' : 'clip_a';
  const targetUrl =
    explicitTargetUrl ??
    (kind === 'Video' ? 'media/clip.mp4' : 'media/dialogue.wav');
  const time = (
    value: number,
    timeRate = rate
  ): Record<string, number | string> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    value,
    rate: timeRate,
  });
  return readOtioDocument(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: 'timeline_1' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: { relic: { id: 'stack_1' } },
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: trackId } },
            kind,
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                metadata: { relic: { id: clipId } },
                source_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: time(sourceStart.value, sourceStart.rate),
                  duration: time(duration),
                },
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: targetUrl,
                  ...(includeAvailableRange
                    ? {
                        available_range: {
                          OTIO_SCHEMA: 'TimeRange.1',
                          start_time: time(
                            availableStartTime.value,
                            availableStartTime.rate
                          ),
                          duration: time(duration),
                        },
                      }
                    : {}),
                },
              },
            ],
          },
        ],
      },
    })
  );
}

function sampledAvDocument(options?: {
  readonly rate?: number;
  readonly duration?: number;
  readonly videoUrl?: string;
  readonly audioUrl?: string;
}): OtioDocumentV1 {
  const rate = options?.rate ?? 30;
  const duration = options?.duration ?? 60;
  const videoUrl = options?.videoUrl ?? 'media/clip.mp4';
  const audioUrl = options?.audioUrl ?? 'media/dialogue.wav';
  const time = (
    value: number,
    timeRate = rate
  ): Record<string, number | string> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    value,
    rate: timeRate,
  });
  return readOtioDocument(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: 'timeline_1' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: { relic: { id: 'stack_1' } },
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_v' } },
            kind: 'Video',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                metadata: { relic: { id: 'clip_v' } },
                source_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: time(0),
                  duration: time(duration),
                },
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: videoUrl,
                },
              },
            ],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_a' } },
            kind: 'Audio',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                metadata: { relic: { id: 'clip_a' } },
                source_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: time(0),
                  duration: time(duration),
                },
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: audioUrl,
                },
              },
            ],
          },
        ],
      },
    })
  );
}

function mixedHandleDocument(): OtioDocumentV1 {
  const time = (value: number, rate = 24): Record<string, number | string> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    value,
    rate,
  });
  const clip = (
    id: string,
    sourceStart: OtioRationalTime,
    availableStart: OtioRationalTime,
    targetUrl: string
  ) => ({
    OTIO_SCHEMA: 'Clip.1',
    name: 'Shared handle',
    metadata: { relic: { id } },
    source_range: {
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: time(sourceStart.value, sourceStart.rate),
      duration: time(48),
    },
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: targetUrl,
      available_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: time(availableStart.value, availableStart.rate),
        duration: time(48),
      },
    },
  });
  return readOtioDocument(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: 'timeline_1' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: { relic: { id: 'stack_1' } },
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_qualified' } },
            kind: 'Video',
            children: [
              clip(
                'clip_qualified',
                { value: 4, rate: 24000 / 1001 },
                { value: 5, rate: 30000 / 1001 },
                'media/qualified.mp4'
              ),
            ],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_unqualified' } },
            kind: 'Video',
            children: [
              clip(
                'clip_unqualified',
                { value: 0, rate: 24 },
                { value: 24, rate: 24 },
                'media/unqualified.mp4'
              ),
            ],
          },
        ],
      },
    })
  );
}

function reverseNearZeroDocument(): OtioDocumentV1 {
  const time = (value: number): Record<string, number | string> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    value,
    rate: 24,
  });
  return readOtioDocument(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: 'timeline_1' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: { relic: { id: 'stack_1' } },
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_v' } },
            kind: 'Video',
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                metadata: { relic: { id: 'clip_v' } },
                source_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: time(-47.00000005),
                  duration: time(48),
                },
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: 'media/reverse.mp4',
                  available_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(48),
                  },
                },
                effects: [
                  {
                    OTIO_SCHEMA: 'LinearTimeWarp.1',
                    effect_name: 'LinearTimeWarp',
                    time_scalar: -1,
                    enabled: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    })
  );
}

interface TimingReadCall {
  readonly blob: Blob;
  readonly mime: string;
  readonly signal: AbortSignal | undefined;
}

function timingMediaFixture(options: {
  readonly blobs: ReadonlyMap<string, Blob>;
  readonly timings: ReadonlyMap<Blob, OtioVideoTiming>;
  readonly resolveUrl?: (
    entryName: OtioBundleEntryName
  ) => Promise<string | null> | string | null;
}): {
  readonly resolver: OtioMediaResolver;
  readonly readVideoTiming: ReadVideoTiming;
  readonly calls: TimingReadCall[];
  readonly state: { disposeCalls: number };
} {
  const calls: TimingReadCall[] = [];
  const state = { disposeCalls: 0 };
  const resolver: OtioMediaResolver = {
    hasEntry: (entryName) => options.blobs.has(entryName),
    getDecompressedBytes: () => 0,
    resolveBlob: async (entryName) => options.blobs.get(entryName) ?? null,
    resolveUrl: async (entryName) =>
      options.resolveUrl === undefined
        ? `blob:${entryName}`
        : options.resolveUrl(entryName),
    dispose: () => {
      state.disposeCalls += 1;
    },
  };
  const readVideoTiming: ReadVideoTiming = async (blob, mime, signal) => {
    calls.push({ blob, mime, signal });
    const timing = options.timings.get(blob);
    if (timing === undefined) {
      throw new Error('Missing explicit timing fixture for Blob');
    }
    return timing;
  };
  return { resolver, readVideoTiming, calls, state };
}

function parallelVideoOccurrencesDocument(): OtioDocumentV1 {
  const time = (value: number): Record<string, number | string> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    value,
    rate: 24,
  });
  const clip = (id: string): Record<string, unknown> => ({
    OTIO_SCHEMA: 'Clip.1',
    metadata: { relic: { id } },
    source_range: {
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: time(0),
      duration: time(24),
    },
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: 'media/clip.mp4',
      available_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: time(0),
        duration: time(24),
      },
    },
  });
  return readOtioDocument(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: 'timeline_1' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: { relic: { id: 'stack_1' } },
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_v_a' } },
            kind: 'Video',
            children: [clip('clip_v_a')],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            metadata: { relic: { id: 'track_v_b' } },
            kind: 'Video',
            children: [clip('clip_v_b')],
          },
        ],
      },
    })
  );
}

describe('otio composition tree', () => {
  test('a 50/50 white dissolve stays white', () => {
    const white = solid('#ffffff');
    const tree: OtioVideoCompositionTree = {
      kind: 'track',
      node_id: 'track',
      ancestry: [],
      branches: [
        { weight: 0.5, child: { kind: 'leaf', contribution_index: 0 } },
        { weight: 0.5, child: { kind: 'leaf', contribution_index: 1 } },
      ],
    };
    const pixel = paintTree(tree, [
      {
        kind: 'image',
        source: white as unknown as CanvasImageSource,
        alpha: 1,
      },
      {
        kind: 'image',
        source: white as unknown as CanvasImageSource,
        alpha: 1,
      },
    ]);
    expect(pixel.r).toBeCloseTo(1, 5);
    expect(pixel.g).toBeCloseTo(1, 5);
    expect(pixel.b).toBeCloseTo(1, 5);
    expect(pixel.a).toBeCloseTo(1, 5);
  });

  test('nested tracks stay under the outer foreground', () => {
    const nested = [0, 1, 2].map((index) => ({
      kind: 'track' as const,
      node_id: `nested_${index}`,
      ancestry: ['outer', 'lower', 'nested'],
      branches: [
        {
          weight: 1,
          child: { kind: 'leaf' as const, contribution_index: index },
        },
      ],
    }));
    const tree: OtioVideoCompositionTree = {
      kind: 'stack',
      node_id: 'outer',
      ancestry: [],
      children: [
        {
          kind: 'track',
          node_id: 'lower',
          ancestry: ['outer'],
          branches: [
            {
              weight: 1,
              child: {
                kind: 'stack',
                node_id: 'nested',
                ancestry: ['outer', 'lower'],
                children: nested,
              },
            },
          ],
        },
        {
          kind: 'track',
          node_id: 'foreground',
          ancestry: ['outer'],
          branches: [
            { weight: 1, child: { kind: 'leaf', contribution_index: 3 } },
          ],
        },
      ],
    };
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    const pixel = paintTree(
      tree,
      colors.map((color) => ({
        kind: 'image' as const,
        source: solid(color) as unknown as CanvasImageSource,
        alpha: 1,
      }))
    );
    expect(pixel.r).toBeCloseTo(1, 5);
    expect(pixel.g).toBeCloseTo(1, 5);
    expect(pixel.b).toBeCloseTo(0, 5);
  });

  test('sequence black is opaque over a lower track', () => {
    const tree: OtioVideoCompositionTree = {
      kind: 'stack',
      node_id: 'stack',
      ancestry: [],
      children: [
        {
          kind: 'track',
          node_id: 'lower',
          ancestry: ['stack'],
          branches: [
            { weight: 1, child: { kind: 'leaf', contribution_index: 0 } },
          ],
        },
        {
          kind: 'track',
          node_id: 'upper',
          ancestry: ['stack'],
          branches: [
            { weight: 1, child: { kind: 'leaf', contribution_index: 1 } },
          ],
        },
      ],
    };
    const pixel = paintTree(tree, [
      {
        kind: 'image',
        source: solid('#ff0000') as unknown as CanvasImageSource,
        alpha: 1,
      },
      { kind: 'black' },
    ]);
    expect(pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  test('direct rendering: 99 gap-only tracks and 1 black track take 3 checkouts', () => {
    const output = new SoftCanvas();
    const checkouts: number[] = [];
    const checkout = (depth: number) => {
      checkouts.push(depth);
      return new SoftCanvas() as unknown as HTMLCanvasElement;
    };

    const gapTracks = Array.from({ length: 99 }, (_, i) => ({
      kind: 'track' as const,
      node_id: `track_gap_${i}`,
      ancestry: ['stack'],
      branches: [
        {
          weight: 1,
          child: {
            kind: 'leaf' as const,
            contribution_index: i,
          },
        },
      ],
    }));
    const blackTrack = {
      kind: 'track' as const,
      node_id: 'track_black',
      ancestry: ['stack'],
      branches: [
        {
          weight: 1,
          child: {
            kind: 'leaf' as const,
            contribution_index: 99,
          },
        },
      ],
    };

    const tree: OtioVideoCompositionTree = {
      kind: 'stack',
      node_id: 'stack',
      ancestry: [],
      children: [...gapTracks, blackTrack],
    };

    const leaves: (OtioPreparedLeaf | null)[] = [
      ...Array.from({ length: 99 }, () => ({ kind: 'empty' as const })),
      { kind: 'black' as const },
    ];

    renderOtioVideoTree(
      output.ctx as unknown as CanvasRenderingContext2D,
      960,
      540,
      tree,
      leaves,
      checkout
    );

    expect(checkouts.length).toBe(3);
    expect(checkouts).toEqual([2, 1, 0]);
    expect(output.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  test('depth-pooled checkout matches fresh-canvas exact pixels on nontrivial composite trees', () => {
    const nested = [0, 1, 2].map((index) => ({
      kind: 'track' as const,
      node_id: `nested_${index}`,
      ancestry: ['outer', 'lower', 'nested'],
      branches: [
        {
          weight: 1,
          child: { kind: 'leaf' as const, contribution_index: index },
        },
      ],
    }));
    const nestedTree: OtioVideoCompositionTree = {
      kind: 'stack',
      node_id: 'outer',
      ancestry: [],
      children: [
        {
          kind: 'track',
          node_id: 'lower',
          ancestry: ['outer'],
          branches: [
            {
              weight: 1,
              child: {
                kind: 'stack',
                node_id: 'nested',
                ancestry: ['outer', 'lower'],
                children: nested,
              },
            },
          ],
        },
        {
          kind: 'track',
          node_id: 'foreground',
          ancestry: ['outer'],
          branches: [
            { weight: 1, child: { kind: 'leaf', contribution_index: 3 } },
          ],
        },
      ],
    };
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    const nestedLeaves = colors.map((color) => ({
      kind: 'image' as const,
      source: solid(color) as unknown as CanvasImageSource,
      alpha: 1,
    }));

    const white = solid('#ffffff');
    const dissolveTree: OtioVideoCompositionTree = {
      kind: 'track',
      node_id: 'track',
      ancestry: [],
      branches: [
        { weight: 0.5, child: { kind: 'leaf', contribution_index: 0 } },
        { weight: 0.5, child: { kind: 'leaf', contribution_index: 1 } },
      ],
    };
    const dissolveLeaves = [
      {
        kind: 'image' as const,
        source: white as unknown as CanvasImageSource,
        alpha: 1,
      },
      {
        kind: 'image' as const,
        source: white as unknown as CanvasImageSource,
        alpha: 1,
      },
    ];

    const treesAndLeaves = [
      { tree: nestedTree, leaves: nestedLeaves },
      { tree: dissolveTree, leaves: dissolveLeaves },
    ];

    for (const { tree, leaves } of treesAndLeaves) {
      // 1. Fresh surfaces reference (independent baseline)
      const freshOutput = new SoftCanvas();
      renderOtioVideoTree(
        freshOutput.ctx as unknown as CanvasRenderingContext2D,
        1,
        1,
        tree,
        leaves,
        () => new SoftCanvas() as unknown as HTMLCanvasElement
      );

      // 2. Depth-pooled surfaces (reused across siblings at same depth)
      const pooledOutput = new SoftCanvas();
      const pool: SoftCanvas[] = [];
      renderOtioVideoTree(
        pooledOutput.ctx as unknown as CanvasRenderingContext2D,
        1,
        1,
        tree,
        leaves,
        (depth: number) => {
          let surface = pool[depth];
          if (!surface) {
            surface = new SoftCanvas();
            pool[depth] = surface;
          }
          surface.width = 1;
          surface.height = 1;
          return surface as unknown as HTMLCanvasElement;
        }
      );

      expect(pooledOutput.pixel).toEqual(freshOutput.pixel);
    }
  });
});

describe('otio image budget', () => {
  test('rejects an image edge above the decoded cap', () => {
    expect(decodedImageAllowed(64, 64)).toBe(true);
    expect(decodedImageAllowed(OTIO_MAX_IMAGE_EDGE + 1, 2)).toBe(false);
    expect(decodedImageAllowed(0, 10)).toBe(false);
  });

  test('evicts the oldest unpinned frame and releases it', () => {
    const cache = new ImageFrameCache(10);
    const released: string[] = [];
    expect(cache.put('a', 6, () => released.push('a'))).toBe(true);
    expect(cache.put('b', 6, () => released.push('b'))).toBe(true);
    cache.clearPins();
    cache.pin('b');
    cache.evict();
    expect(released).toEqual(['a']);
    expect(cache.size).toBe(1);
    expect(cache.retainedPixels).toBe(6);
  });
});

const playbackGlobalKeys = [
  'document',
  'Image',
  'Audio',
  'AudioContext',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'VideoFrame',
] as const;
type PlaybackGlobalKey = (typeof playbackGlobalKeys)[number];
const urlMethodNames = ['createObjectURL', 'revokeObjectURL'] as const;
type UrlMethodName = (typeof urlMethodNames)[number];

function propertyDescriptors<T extends PropertyKey>(
  target: object,
  names: readonly T[]
): Map<T, PropertyDescriptor | undefined> {
  const descriptors = new Map<T, PropertyDescriptor | undefined>();
  for (const name of names) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(target, name));
  }
  return descriptors;
}

function restoreProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, name);
    return;
  }
  Object.defineProperty(target, name, descriptor);
}

function restorePlaybackEnvironment(
  globals: ReadonlyMap<PlaybackGlobalKey, PropertyDescriptor | undefined>,
  urlMethods: ReadonlyMap<UrlMethodName, PropertyDescriptor | undefined>
): void {
  try {
    for (const name of urlMethodNames) {
      restoreProperty(URL, name, urlMethods.get(name));
    }
  } finally {
    for (const name of playbackGlobalKeys) {
      restoreProperty(globalThis, name, globals.get(name));
    }
  }
}

describe('otio playback controller', () => {
  const created: MockMedia[] = [];
  let raf: FrameRequestCallback | null = null;
  let originalGlobals = new Map<
    PlaybackGlobalKey,
    PropertyDescriptor | undefined
  >();
  let originalUrlMethods = new Map<
    UrlMethodName,
    PropertyDescriptor | undefined
  >();
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  beforeEach(() => {
    created.length = 0;
    createdUrls.length = 0;
    revokedUrls.length = 0;
    raf = null;
    originalGlobals = propertyDescriptors(globalThis, playbackGlobalKeys);
    originalUrlMethods = propertyDescriptors(URL, urlMethodNames);
    try {
      for (const [name, value] of [
        ['Image', MockMedia],
        ['Audio', MockMedia],
        ['AudioContext', MockAudioContext],
        [
          'document',
          {
            createElement: (tag: string) => {
              if (tag === 'canvas') return new SoftCanvas();
              if (tag === 'video' || tag === 'audio') {
                const media = new MockMedia();
                created.push(media);
                return media;
              }
              return hostElement();
            },
            body: hostElement(),
          },
        ],
        [
          'requestAnimationFrame',
          (cb: FrameRequestCallback) => {
            raf = cb;
            return 1;
          },
        ],
        [
          'cancelAnimationFrame',
          () => {
            raf = null;
          },
        ],
      ] as const) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => {
          const url = `blob:owned-${createdUrls.length}`;
          createdUrls.push(url);
          return url;
        },
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: (url: string) => {
          revokedUrls.push(url);
        },
      });
    } catch (error) {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
      throw error;
    }
  });

  afterEach(() => {
    try {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
    } finally {
      createdUrls.length = 0;
      revokedUrls.length = 0;
    }
  });

  function canvas(output?: SoftCanvas): HTMLCanvasElement {
    return (output ?? new SoftCanvas()) as unknown as HTMLCanvasElement;
  }

  test('keeps the native URL constructor while object URLs are mocked', () => {
    expect(new URL('https://relik.example/asset').hostname).toBe(
      'relik.example'
    );
  });

  test('duration comes from timeline_range, not a 24 fallback', () => {
    const playback = createOtioPlayback({
      document: buildDocument({
        rate: 24,
        frames: 48,
        timelineRate: 30,
        timelineFrames: 90,
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:clip',
    });
    expect(playback.getState().duration).toEqual({ value: 90, rate: 30 });
    expect(playback.getState().rate).toBe(30);
    playback.dispose();
  });

  test('a missing timeline_range does not reuse source_range', () => {
    const doc = buildDocument();
    const timeline = doc.nodes.timeline_1;
    if (!timeline) throw new Error('missing timeline');
    const playback = createOtioPlayback({
      document: {
        ...doc,
        nodes: {
          ...doc.nodes,
          timeline_1: { ...timeline, timeline_range: null },
        },
      },
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => null,
    });
    const state = playback.getState();
    expect(state.duration.value).toBe(0);
    expect(state.rate).toBe(30);
    expect(
      state.diagnostics.some((issue) => issue.code === 'invalid-timing')
    ).toBe(true);
    playback.dispose();
  });

  test('a later seek wins and clears buffering only when it finishes', async () => {
    const pending: Array<(value: string | null) => void> = [];
    const clipStarted = Promise.withResolvers<void>();
    const delayedClip = (): Promise<string | null> => {
      const deferred = Promise.withResolvers<string | null>();
      pending.push(deferred.resolve);
      clipStarted.resolve();
      return deferred.promise;
    };
    const playback = createOtioPlayback({
      document: buildDocument(),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: (path) =>
        path === 'media/clip.mp4'
          ? delayedClip()
          : Promise.resolve('blob:dialogue'),
    });
    const first = playback.seek({ value: 0, rate: 24 });
    await clipStarted.promise;
    const second = playback.seek({ value: 12, rate: 24 });
    expect(playback.getState().buffering).toBe(true);
    const resolveFirst = pending[0];
    if (resolveFirst === undefined)
      throw new Error('clip resolver did not start');
    resolveFirst('blob:dialogue');
    await first;
    await second;
    expect(playback.getState().time.value).toBe(12);
    expect(playback.getState().buffering).toBe(false);
    playback.dispose();
  });

  test('paused seek does not publish stale pixels while the decoder is seeking', async () => {
    const output = new SoftCanvas();
    const playback = createOtioPlayback({
      document: sampledMediaDocument({ kind: 'Video', rate: 24, duration: 48 }),
      timelineId: 'timeline_1',
      canvas: output as unknown as HTMLCanvasElement,
      resolveMedia: async () => 'blob:clip',
    });
    try {
      await playback.seek({ value: 0, rate: 24 });
      const decoder = created.find((element) => element.muted);
      if (!decoder) throw new Error('video decoder did not load');
      const oldPixel = { ...decoder.pixel };
      const newPixel = { r: 0, g: 0, b: 1, a: 1 };
      let currentTime = decoder.currentTime;
      let seeking = false;
      Object.defineProperty(decoder, 'seeking', { get: () => seeking });
      Object.defineProperty(decoder, 'currentTime', {
        get: () => currentTime,
        set: (value: number) => {
          decoder.seekTargets.push(value);
          currentTime = value;
          seeking = true;
          // The getter moves immediately; decoded pixels and seeked lag behind.
        },
      });
      const tick = async (): Promise<void> => {
        // Drain the controller's promise chain without advancing a media event.
        for (let i = 0; i < 100; i++) await Promise.resolve();
      };
      let firstSettled = false;
      const first = playback.seek({ value: 4, rate: 24 }).then(() => {
        firstSettled = true;
      });
      await tick();
      const beforeEvent = {
        seeking,
        buffering: playback.getState().buffering,
        settled: firstSettled,
        pixel: { ...output.pixel },
      };
      let sameTargetSettled = false;
      const repeated = playback.seek({ value: 4, rate: 24 }).then(() => {
        sameTargetSettled = true;
      });
      await tick();
      const sameTarget = {
        seeking,
        buffering: playback.getState().buffering,
        settled: sameTargetSettled,
        pixel: { ...output.pixel },
      };
      decoder.dispatch('seeked'); // Delayed event from an earlier seek, still seeking.
      await tick();
      const staleEvent = {
        seeking,
        buffering: playback.getState().buffering,
        settled: sameTargetSettled,
        pixel: { ...output.pixel },
      };
      seeking = false;
      decoder.pixel = newPixel;
      decoder.dispatch('seeked');
      await tick();
      if (seeking) {
        seeking = false;
        decoder.dispatch('seeked');
      }
      await Promise.all([first, repeated]);
      const completed = {
        buffering: playback.getState().buffering,
        pixel: { ...output.pixel },
      };
      console.log(
        'SEEK_EVENT_CONTROL',
        JSON.stringify({
          oldPixel,
          newPixel,
          beforeEvent,
          sameTarget,
          staleEvent,
          completed,
        })
      );
      expect(beforeEvent).toEqual({
        seeking: true,
        buffering: true,
        settled: false,
        pixel: oldPixel,
      });
      expect(sameTarget).toEqual({
        seeking: true,
        buffering: true,
        settled: false,
        pixel: oldPixel,
      });
      expect(staleEvent).toEqual({
        seeking: true,
        buffering: true,
        settled: false,
        pixel: oldPixel,
      });
      expect(completed).toEqual({ buffering: false, pixel: newPixel });
    } finally {
      playback.dispose();
    }
  });

  test('paused seek ignores an earlier seeked event while still seeking', async () => {
    const output = new SoftCanvas();
    const playback = createOtioPlayback({
      document: sampledMediaDocument({ kind: 'Video', rate: 24, duration: 48 }),
      timelineId: 'timeline_1',
      canvas: output as unknown as HTMLCanvasElement,
      resolveMedia: async () => 'blob:clip',
    });
    try {
      await playback.seek({ value: 0, rate: 24 });
      const decoder = created.find((element) => element.muted);
      if (!decoder) throw new Error('video decoder did not load');
      const oldPixel = { ...decoder.pixel };
      const newPixel = { r: 0, g: 0, b: 1, a: 1 };
      let currentTime = decoder.currentTime;
      let seeking = false;
      Object.defineProperty(decoder, 'seeking', { get: () => seeking });
      Object.defineProperty(decoder, 'currentTime', {
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
          seeking = true;
          decoder.readyState = 1;
        },
      });
      let settled = false;
      const pending = playback.seek({ value: 4, rate: 24 }).then(() => {
        settled = true;
      });
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(seeking).toBe(true);
      expect(settled).toBe(false);
      // A delayed event belongs to an older seek; current data is still old.
      decoder.readyState = 2;
      decoder.dispatch('seeked');
      for (let i = 0; i < 100; i++) await Promise.resolve();
      const afterStaleEvent = {
        seeking,
        settled,
        buffering: playback.getState().buffering,
        pixel: { ...output.pixel },
      };
      seeking = false;
      decoder.pixel = newPixel;
      decoder.dispatch('seeked');
      await pending;
      const completed = {
        buffering: playback.getState().buffering,
        pixel: { ...output.pixel },
      };
      console.log(
        'SEEK_STALE_EVENT_CONTROL',
        JSON.stringify({ oldPixel, newPixel, afterStaleEvent, completed })
      );
      expect(afterStaleEvent).toEqual({
        seeking: true,
        settled: false,
        buffering: true,
        pixel: oldPixel,
      });
      expect(completed).toEqual({ buffering: false, pixel: newPixel });
    } finally {
      playback.dispose();
    }
  });

  test('seek wait is not added to the transport clock', async () => {
    const pending: Array<(value: string | null) => void> = [];
    const clipStarted = Promise.withResolvers<void>();
    const delayedClip = (): Promise<string | null> => {
      const deferred = Promise.withResolvers<string | null>();
      pending.push(deferred.resolve);
      clipStarted.resolve();
      return deferred.promise;
    };
    const playback = createOtioPlayback({
      document: buildDocument(),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: (path) =>
        path === 'media/clip.mp4'
          ? delayedClip()
          : Promise.resolve('blob:dialogue'),
    });
    const p = playback.play();
    await clipStarted.promise;
    const s = playback.seek({ value: 12, rate: 24 });
    raf?.(8000);
    const resolveFirst = pending[0];
    if (resolveFirst === undefined)
      throw new Error('clip resolver did not start');
    resolveFirst('blob:dialogue');
    await Promise.all([p, s]);
    expect(playback.getState().time.value).toBe(12);
    playback.dispose();
  });

  test('seeks video decoders to certified presentation windows', async () => {
    const mediaBlob = new Blob(['unit-test video marker'], {
      type: 'video/mp4',
    });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 120 }, (_, frame) => frame / 60),
      ends: Float64Array.from({ length: 120 }, (_, frame) => (frame + 1) / 60),
    };
    const decoderTimeAt = async (
      doc: OtioDocumentV1,
      time: OtioRationalTime
    ): Promise<{
      target: number;
      calls: readonly TimingReadCall[];
      signalWasAborted: boolean | undefined;
    }> => {
      const fixture = timingMediaFixture({
        blobs: new Map([['media/clip.mp4', mediaBlob]]),
        timings: new Map([[mediaBlob, timing]]),
      });
      const first = created.length;
      const playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_1',
        canvas: canvas(),
        resolveMedia: fixture.resolver,
        readVideoTiming: fixture.readVideoTiming,
      });
      await playback.seek(time);
      const decoder = created.slice(first).find((element) => element.muted);
      if (!decoder) throw new Error('video decoder did not load');
      const target = decoder.currentTime;
      const signalWasAborted = fixture.calls[0]?.signal?.aborted;
      playback.dispose();
      return { target, calls: fixture.calls, signalWasAborted };
    };

    const video24 = sampledMediaDocument({
      kind: 'Video',
      rate: 24,
      duration: 48,
    });
    const video30 = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });
    const video48000 = sampledMediaDocument({
      kind: 'Video',
      rate: 48000,
      duration: 96000,
    });
    const source24 = await decoderTimeAt(video24, { value: 32, rate: 24 });
    expect(source24.target).toBeCloseTo(80.5 / 60, 14);
    expect(source24.calls).toHaveLength(1);
    expect(source24.calls[0]?.blob).toBe(mediaBlob);
    expect(source24.calls[0]?.mime).toBe('video/mp4');
    expect(source24.calls[0]?.signal).toBeDefined();
    expect(source24.signalWasAborted).toBe(false);
    expect(
      (
        await decoderTimeAt(video24, {
          value: 32 - Number.EPSILON * 32,
          rate: 24,
        })
      ).target
    ).toBeCloseTo(80.5 / 60, 14);
    expect(
      (await decoderTimeAt(video30, { value: 58.75, rate: 30 })).target
    ).toBeCloseTo(117.5 / 60, 14);
    expect(
      (await decoderTimeAt(video48000, { value: 799, rate: 48000 })).target
    ).toBeCloseTo(0.5 / 60, 14);
  });
  test('selects the certified WebM packet window instead of an FPS grid', async () => {
    const mediaBlob = new Blob(['webm packet timing marker'], {
      type: 'video/webm',
    });
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.webm', mediaBlob]]),
      timings: new Map<Blob, OtioVideoTiming>([
        [
          mediaBlob,
          {
            kind: 'windows',
            starts: new Float64Array([0, 0.033, 0.067]),
            ends: new Float64Array([0.033, 0.067, 0.1]),
          },
        ],
      ]),
    });
    const playback = createOtioPlayback({
      document: sampledMediaDocument({
        kind: 'Video',
        rate: 30,
        duration: 3,
        targetUrl: 'media/clip.webm',
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    await playback.seek({ value: 2, rate: 30 });

    const decoder = created.find((element) => element.muted);
    expect(decoder?.currentTime).toBe(0.05);
    expect(fixture.calls[0]?.mime).toBe('video/webm');
    expect(
      playback
        .getState()
        .diagnostics.some((issue) => issue.code === 'invalid-timing')
    ).toBe(false);
    playback.dispose();
  });

  test('caches one timing read per path without sharing occurrence decoders', async () => {
    const mediaBlob = new Blob(['two occurrence marker'], {
      type: 'video/mp4',
    });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: new Float64Array([0]),
      ends: new Float64Array([1]),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
      resolveUrl: async () => 'blob:media/primary_a.mp4',
    });
    const playback = createOtioPlayback({
      document: parallelVideoOccurrencesDocument(),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    await playback.seek({ value: 0, rate: 24 });

    const decoders = created.filter((element) => element.muted);
    expect(decoders).toHaveLength(2);
    expect(decoders.map((decoder) => decoder.src)).toEqual([
      'blob:media/primary_a.mp4',
      'blob:media/primary_a.mp4',
    ]);
    expect(decoders.map((decoder) => decoder.currentTime)).toEqual([0.5, 0.5]);
    expect(fixture.calls).toHaveLength(1);
    playback.dispose();
    expect(fixture.state.disposeCalls).toBe(0);
  });

  test('uses one callback Blob for the decoder and timing reader', async () => {
    const mediaBlob = new Blob(['callback video marker'], {
      type: 'video/mp4',
    });
    const calls: TimingReadCall[] = [];
    let resolves = 0;
    const readVideoTiming: ReadVideoTiming = async (blob, mime, signal) => {
      calls.push({ blob, mime, signal });
      return {
        kind: 'windows',
        starts: new Float64Array([0]),
        ends: new Float64Array([1]),
      };
    };
    const playback = createOtioPlayback({
      document: sampledMediaDocument({
        kind: 'Video',
        rate: 24,
        duration: 24,
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => {
        resolves += 1;
        return mediaBlob;
      },
      readVideoTiming,
    });

    await playback.seek({ value: 0, rate: 24 });

    const decoder = created.find((element) => element.muted);
    expect(resolves).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.blob).toBe(mediaBlob);
    expect(decoder?.src).toBe(createdUrls[0]);
    playback.dispose();
  });

  test('drops a stale timing result before it seeks a decoder', async () => {
    const mediaBlob = new Blob(['stale timing marker'], { type: 'video/mp4' });
    const timing = Promise.withResolvers<OtioVideoTiming>();
    const started = Promise.withResolvers<void>();
    const calls: TimingReadCall[] = [];
    let resolverDisposeCalls = 0;
    const resolver: OtioMediaResolver = {
      hasEntry: () => true,
      getDecompressedBytes: () => 0,
      resolveBlob: async () => mediaBlob,
      resolveUrl: async () => 'blob:stale-timing',
      dispose: () => {
        resolverDisposeCalls += 1;
      },
    };
    const readVideoTiming: ReadVideoTiming = async (blob, mime, signal) => {
      calls.push({ blob, mime, signal });
      started.resolve();
      return timing.promise;
    };
    const playback = createOtioPlayback({
      document: sampledMediaDocument({
        kind: 'Video',
        rate: 24,
        duration: 48,
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: resolver,
      readVideoTiming,
    });

    const first = playback.seek({ value: 0, rate: 24 });
    await started.promise;
    const second = playback.seek({ value: 12, rate: 24 });
    timing.resolve({
      kind: 'windows',
      starts: new Float64Array([0, 0.5]),
      ends: new Float64Array([0.5, 1]),
    });
    await first;
    await second;

    const decoder = created.find((element) => element.muted);
    expect(calls).toHaveLength(1);
    expect(decoder?.seekTargets).toEqual([0.75]);
    expect(playback.getState().time).toEqual({ value: 12, rate: 24 });
    playback.dispose();
    expect(resolverDisposeCalls).toBe(0);
  });

  test('decodes near-zero source samples locally without normalizing them', async () => {
    const sourceStart = { value: 4, rate: 24000 / 1001 };
    const availableStartTime = { value: 5, rate: 30000 / 1001 };
    const videoBlob = new Blob(['near-zero video marker'], {
      type: 'video/mp4',
    });
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', videoBlob]]),
      timings: new Map<Blob, OtioVideoTiming>([
        [
          videoBlob,
          {
            kind: 'windows',
            starts: new Float64Array([0]),
            ends: new Float64Array([1 / 60]),
          },
        ],
      ]),
    });
    const videoDocument = sampledMediaDocument({
      kind: 'Video',
      rate: 24,
      duration: 48,
      sourceStart,
      availableStartTime,
    });
    const videoContribution = evaluateOtioAt(videoDocument, 'timeline_1', {
      value: 0,
      rate: 24,
    }).video_contributions[0];
    if (!videoContribution) {
      throw new Error('near-zero video sample is missing');
    }
    const sourceTime = videoContribution.source_time;
    const videoHandle = videoContribution.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    if (!videoHandle) {
      throw new Error(
        'near-zero video sample is missing its handle diagnostic'
      );
    }
    const originalVideoContribution = structuredClone(videoContribution);
    expect(sourceTime.value).toBeLessThan(0);
    expect(
      compareRationalTimes(sourceTime, { value: 0, rate: sourceTime.rate })
    ).toBeLessThan(0);
    const video = createOtioPlayback({
      document: videoDocument,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    await video.seek({ value: 0, rate: 24 });

    const decoder = created.find((element) => element.muted);
    expect(decoder?.currentTime).toBe(1 / 120);
    expect(
      video
        .getState()
        .diagnostics.some((issue) => issue.code === 'invalid-timing')
    ).toBe(false);
    expect(video.getState().diagnostics).not.toContainEqual(videoHandle);
    const afterVideoContribution = evaluateOtioAt(videoDocument, 'timeline_1', {
      value: 0,
      rate: 24,
    }).video_contributions[0];
    expect(afterVideoContribution).toEqual(originalVideoContribution);
    expect(afterVideoContribution?.source_time).toEqual(
      originalVideoContribution.source_time
    );
    expect(afterVideoContribution?.diagnostics).toEqual(
      originalVideoContribution.diagnostics
    );
    expect(afterVideoContribution?.diagnostics).toContainEqual(videoHandle);
    video.dispose();

    const timingFailureFixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', videoBlob]]),
      timings: new Map<Blob, OtioVideoTiming>([
        [
          videoBlob,
          {
            kind: 'windows',
            starts: new Float64Array([1]),
            ends: new Float64Array([2]),
          },
        ],
      ]),
    });
    const timingFailure = createOtioPlayback({
      document: videoDocument,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: timingFailureFixture.resolver,
      readVideoTiming: timingFailureFixture.readVideoTiming,
    });
    await timingFailure.seek({ value: 0, rate: 24 });
    expect(timingFailure.getState().diagnostics).not.toContainEqual(
      videoHandle
    );
    expect(
      timingFailure
        .getState()
        .diagnostics.some(
          (issue) =>
            issue.code === 'invalid-timing' &&
            issue.message.includes('outside certified packet timing')
        )
    ).toBe(true);
    timingFailure.dispose();

    const firstAudio = created.length;
    const audioDocument = sampledMediaDocument({
      kind: 'Audio',
      rate: 30,
      duration: 60,
      sourceStart: { value: 56, rate: 30 },
      availableStartTime: { value: 56.00000000000001, rate: 30 },
    });
    const audioContribution = evaluateOtioAt(audioDocument, 'timeline_1', {
      value: 0,
      rate: 30,
    }).audio_contributions[0];
    if (!audioContribution) {
      throw new Error('near-zero audio sample is missing');
    }
    const audioSourceTime = audioContribution.source_time;
    const audioHandle = audioContribution.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    if (!audioHandle) {
      throw new Error(
        'near-zero audio sample is missing its handle diagnostic'
      );
    }
    const originalAudioContribution = structuredClone(audioContribution);
    expect(audioSourceTime.value).toBeLessThan(0);
    expect(
      compareRationalTimes(audioSourceTime, {
        value: 0,
        rate: audioSourceTime.rate,
      })
    ).toBeLessThan(0);
    const audio = createOtioPlayback({
      document: audioDocument,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:dialogue',
    });
    await audio.play();
    await audio.seek({ value: 0, rate: 30 });
    const voice = created
      .slice(firstAudio)
      .find((element) => element.attrs.get('data-bundle-path') !== undefined);
    expect(voice?.currentTime).toBe(0);
    expect(voice?.paused).toBe(false);
    expect(voice?.attrs.get('data-active')).toBe('true');
    expect(audio.getState().diagnostics).not.toContainEqual(audioHandle);
    const afterAudioContribution = evaluateOtioAt(audioDocument, 'timeline_1', {
      value: 0,
      rate: 30,
    }).audio_contributions[0];
    expect(afterAudioContribution).toEqual(originalAudioContribution);
    expect(afterAudioContribution?.source_time).toEqual(
      originalAudioContribution.source_time
    );
    expect(afterAudioContribution?.diagnostics).toEqual(
      originalAudioContribution.diagnostics
    );
    expect(afterAudioContribution?.diagnostics).toContainEqual(audioHandle);
    audio.dispose();
  });

  test('projects only qualified active handle diagnostics from decoder state', async () => {
    const document = mixedHandleDocument();
    const evaluation = evaluateOtioAt(document, 'timeline_1', {
      value: 0,
      rate: 24,
    });
    const qualified = evaluation.video_contributions.find(
      (contribution) => contribution.node_id === 'clip_qualified'
    );
    const unqualified = evaluation.video_contributions.find(
      (contribution) => contribution.node_id === 'clip_unqualified'
    );
    if (!qualified || !unqualified) {
      throw new Error('mixed handle contributions are missing');
    }
    const qualifiedHandle = qualified.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    const unqualifiedHandle = unqualified.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    if (!qualifiedHandle || !unqualifiedHandle) {
      throw new Error('mixed handle diagnostics are missing');
    }
    expect(evaluation.diagnostics).toContain(qualifiedHandle);
    expect(evaluation.diagnostics).toContain(unqualifiedHandle);
    expect(
      compareRationalTimes(qualified.source_time, {
        value: 0,
        rate: qualified.source_time.rate,
      })
    ).toBeLessThan(0);
    expect(
      compareRationalTimes(unqualified.source_time, {
        value: 0,
        rate: unqualified.source_time.rate,
      })
    ).toBeLessThan(0);
    expect(qualifiedHandle.message).toBe(unqualifiedHandle.message);
    const blob = new Blob(['mixed handle timing marker'], {
      type: 'video/mp4',
    });
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/qualified.mp4', blob],
        ['media/unqualified.mp4', blob],
      ]),
      timings: new Map<Blob, OtioVideoTiming>([
        [
          blob,
          {
            kind: 'windows',
            starts: new Float64Array([0]),
            ends: new Float64Array([1 / 60]),
          },
        ],
      ]),
    });
    const playback = createOtioPlayback({
      document,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    await playback.seek({ value: 0, rate: 24 });

    const diagnostics = playback.getState().diagnostics;
    expect(diagnostics).not.toContainEqual(qualifiedHandle);
    expect(diagnostics).toContainEqual(unqualifiedHandle);
    expect(
      diagnostics.filter((issue) => issue.code === 'missing-handles')
    ).toEqual([unqualifiedHandle]);
    playback.dispose();
  });

  test('recomputes decoder handle qualification for later samples of the same node', async () => {
    const document = reverseNearZeroDocument();
    const startContribution = evaluateOtioAt(document, 'timeline_1', {
      value: 0,
      rate: 24,
    }).video_contributions[0];
    if (!startContribution) {
      throw new Error('reverse near-zero start contribution is missing');
    }
    const startHandle = startContribution.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    if (!startHandle) {
      throw new Error('reverse near-zero start handle is missing');
    }
    expect(
      compareRationalTimes(startContribution.source_time, {
        value: 0,
        rate: startContribution.source_time.rate,
      })
    ).toBeLessThan(0);
    const playback = createOtioPlayback({
      document,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:reverse',
    });

    await playback.seek({ value: 0, rate: 24 });

    expect(playback.getState().diagnostics).not.toContainEqual(startHandle);

    await playback.seek({ value: 1, rate: 24 });

    const laterContribution = evaluateOtioAt(document, 'timeline_1', {
      value: 1,
      rate: 24,
    }).video_contributions[0];
    if (!laterContribution) {
      throw new Error('reverse near-zero later contribution is missing');
    }
    const laterHandle = laterContribution.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    if (!laterHandle) {
      throw new Error('reverse near-zero later handle is missing');
    }
    expect(
      compareRationalTimes(laterContribution.source_time, {
        value: 0,
        rate: laterContribution.source_time.rate,
      })
    ).toBeLessThan(0);
    expect(playback.getState().diagnostics).toContainEqual(laterHandle);
    playback.dispose();
  });

  test('withholds tiny negative samples without known media availability', async () => {
    const videoBlob = new Blob(['unknown availability video marker'], {
      type: 'video/mp4',
    });
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', videoBlob]]),
      timings: new Map<Blob, OtioVideoTiming>([
        [
          videoBlob,
          {
            kind: 'windows',
            starts: new Float64Array([0]),
            ends: new Float64Array([1 / 60]),
          },
        ],
      ]),
    });
    const videoDocument = sampledMediaDocument({
      kind: 'Video',
      rate: 24,
      duration: 48,
      sourceStart: { value: -5e-8, rate: 24 },
      includeAvailableRange: false,
    });
    const videoContribution = evaluateOtioAt(videoDocument, 'timeline_1', {
      value: 0,
      rate: 24,
    }).video_contributions[0];
    if (!videoContribution) {
      throw new Error('unknown-availability video sample is missing');
    }
    const unknownAvailability = videoContribution.diagnostics.find(
      (issue) =>
        issue.code === 'invalid-timing' &&
        issue.message.includes('Available range')
    );
    if (!unknownAvailability) {
      throw new Error(
        'unknown-availability video sample is missing its diagnostic'
      );
    }
    expect(
      compareRationalTimes(videoContribution.source_time, {
        value: 0,
        rate: videoContribution.source_time.rate,
      })
    ).toBeLessThan(0);
    const firstVideo = created.length;
    const video = createOtioPlayback({
      document: videoDocument,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    await video.seek({ value: 0, rate: 24 });

    expect(created.slice(firstVideo).some((element) => element.muted)).toBe(
      false
    );
    expect(fixture.calls).toHaveLength(0);
    expect(video.getState().diagnostics).toContainEqual(unknownAvailability);
    // The core note already explains the withheld video sample.
    expect(
      video
        .getState()
        .diagnostics.some((issue) => issue.message.includes('was withheld'))
    ).toBe(false);
    expect(
      evaluateOtioAt(videoDocument, 'timeline_1', {
        value: 0,
        rate: 24,
      }).video_contributions[0]
    ).toEqual(videoContribution);
    video.dispose();

    const firstAudio = created.length;
    const audioDocument = sampledMediaDocument({
      kind: 'Audio',
      rate: 30,
      duration: 60,
      sourceStart: { value: -5e-8, rate: 30 },
      includeAvailableRange: false,
    });
    const audioContribution = evaluateOtioAt(audioDocument, 'timeline_1', {
      value: 0,
      rate: 30,
    }).audio_contributions[0];
    if (!audioContribution) {
      throw new Error('unknown-availability audio sample is missing');
    }
    expect(
      compareRationalTimes(audioContribution.source_time, {
        value: 0,
        rate: audioContribution.source_time.rate,
      })
    ).toBeLessThan(0);
    const audio = createOtioPlayback({
      document: audioDocument,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:unknown-availability-audio',
    });
    await audio.play();
    await audio.seek({ value: 0, rate: 30 });

    expect(
      created
        .slice(firstAudio)
        .some(
          (element) =>
            element.attrs.get('data-bundle-path') === 'media/dialogue.wav'
        )
    ).toBe(false);
    expect(
      evaluateOtioAt(audioDocument, 'timeline_1', {
        value: 0,
        rate: 30,
      }).audio_contributions[0]
    ).toEqual(audioContribution);
    // Nothing in the core evaluation explains the withheld audio sample, so
    // playback state must, or the view would report a silent clip as ready.
    expect(audioContribution.diagnostics).toEqual([]);
    expect(audio.getState().diagnostics).toContainEqual({
      severity: 'warning',
      code: 'invalid-timing',
      message: `Source sample for ${audioContribution.name || audioContribution.node_id} is outside known media availability and was withheld`,
      target: { node_id: audioContribution.node_id },
    });
    audio.dispose();
  });

  test('keeps parsed black sequence policy frames out of withheld diagnostics', async () => {
    const time = (value: number) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate: 24,
    });
    const range = (start: number, duration: number) => ({
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: time(start),
      duration: time(duration),
    });
    const document = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_sequence_policy' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_sequence_policy' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              kind: 'Video',
              metadata: { relic: { id: 'track_sequence_lower' } },
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_sequence_lower' } },
                  source_range: range(0, 1),
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    target_url_base: 'media',
                    name_prefix: 'lower_',
                    name_suffix: '.png',
                    start_frame: 1001,
                    frame_step: 1,
                    rate: 24,
                    frame_zero_padding: 4,
                    missing_frame_policy: 'error',
                    available_range: range(0, 1),
                  },
                },
              ],
            },
            {
              OTIO_SCHEMA: 'Track.1',
              kind: 'Video',
              metadata: { relic: { id: 'track_sequence_policy' } },
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_sequence_policy' } },
                  source_range: range(-5e-8, 1),
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    target_url_base: 'media',
                    name_prefix: 'policy_',
                    name_suffix: '.png',
                    start_frame: 1001,
                    frame_step: 1,
                    rate: 24,
                    frame_zero_padding: 4,
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );
    const atZero = { value: 0, rate: 24 };
    const policyFrame = evaluateOtioAt(
      document,
      'timeline_sequence_policy',
      atZero
    ).video_contributions.find(
      (contribution) => contribution.node_id === 'clip_sequence_policy'
    );
    if (!policyFrame) {
      throw new Error('black sequence policy contribution is missing');
    }
    expect(policyFrame.sample_kind).toBe('black');
    expect(policyFrame.bundle_path).toBeNull();
    expect(policyFrame.diagnostics).toEqual([]);
    expect(
      compareRationalTimes(policyFrame.source_time, {
        value: 0,
        rate: policyFrame.source_time.rate,
      })
    ).toBeLessThan(0);

    const output = new SoftCanvas();
    const resolved: string[] = [];
    const playback = createOtioPlayback({
      document,
      timelineId: 'timeline_sequence_policy',
      canvas: canvas(output),
      resolveMedia: async (path) => {
        resolved.push(path);
        return `blob:${path}`;
      },
    });
    await playback.seek(atZero);

    expect(resolved).toEqual(['media/lower_1001.png']);
    expect(output.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(
      playback
        .getState()
        .diagnostics.some((issue) => issue.message.includes('was withheld'))
    ).toBe(false);
    playback.dispose();
  });

  test('keeps positive fractional audio timing exact', async () => {
    const playback = createOtioPlayback({
      document: sampledMediaDocument({
        kind: 'Audio',
        rate: 3,
        duration: 9,
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:dialogue',
    });

    await playback.play();
    await playback.seek({ value: 2, rate: 3 });

    const voice = created.find(
      (element) =>
        element.attrs.get('data-bundle-path') === 'media/dialogue.wav'
    );
    expect(voice?.currentTime).toBe(2 / 3);
    expect(voice?.attrs.get('data-active')).toBe('true');
    playback.dispose();
  });

  test('uses exact source seconds for unknown and uncovered packet timing', async () => {
    const unknownBlob = new Blob(['unknown timing marker'], {
      type: 'video/mp4',
    });
    const unknownFixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', unknownBlob]]),
      timings: new Map<Blob, OtioVideoTiming>([
        [unknownBlob, { kind: 'unknown', reason: 'unknown-duration' }],
      ]),
    });
    const unknown = createOtioPlayback({
      document: sampledMediaDocument({
        kind: 'Video',
        rate: 3,
        duration: 9,
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: unknownFixture.resolver,
      readVideoTiming: unknownFixture.readVideoTiming,
    });

    await unknown.seek({ value: 5, rate: 3 });

    const unknownDecoder = created.find((element) => element.muted);
    expect(unknownDecoder?.currentTime).toBe(5 / 3);
    expect(
      unknown
        .getState()
        .diagnostics.some(
          (issue) =>
            issue.code === 'invalid-timing' &&
            issue.message.includes('unknown-duration')
        )
    ).toBe(true);
    unknown.dispose();

    const firstGapDecoder = created.length;
    const gapBlob = new Blob(['gap timing marker'], { type: 'video/mp4' });
    const gapFixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', gapBlob]]),
      timings: new Map<Blob, OtioVideoTiming>([
        [
          gapBlob,
          {
            kind: 'windows',
            starts: new Float64Array([0, 2]),
            ends: new Float64Array([1, 3]),
          },
        ],
      ]),
    });
    const gapped = createOtioPlayback({
      document: sampledMediaDocument({
        kind: 'Video',
        rate: 2,
        duration: 6,
      }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: gapFixture.resolver,
      readVideoTiming: gapFixture.readVideoTiming,
    });

    await gapped.seek({ value: 2, rate: 2 });

    const gapDecoder = created
      .slice(firstGapDecoder)
      .find((element) => element.muted);
    expect(gapDecoder?.currentTime).toBe(1);
    expect(
      gapped
        .getState()
        .diagnostics.some(
          (issue) =>
            issue.code === 'invalid-timing' &&
            issue.message.includes('outside certified packet timing')
        )
    ).toBe(true);
    gapped.dispose();
  });

  test('withholds unavailable Video 2 fixture samples before they seek zero', async () => {
    const doc = readOtioDocument(readFileSync(standardFixtureUrl));
    const timelineId = doc.timeline_ids[0];
    if (!timelineId) throw new Error('standard fixture has no timeline');
    const mediaBlob = new Blob(['standard fixture timing marker'], {
      type: 'video/mp4',
    });
    const videoPaths = [
      'media/primary_a.mp4',
      'media/secondary_b_prores.mov',
      'media/secondary_b.mp4',
      'media/fx_flare.webm',
      'media/overlay_alpha.webm',
    ] as const;
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 240 }, (_, frame) => frame / 60),
      ends: Float64Array.from({ length: 240 }, (_, frame) => (frame + 1) / 60),
    };
    const fixture = timingMediaFixture({
      blobs: new Map<string, Blob>(
        videoPaths.map((path): [string, Blob] => [path, mediaBlob])
      ),
      timings: new Map([[mediaBlob, timing]]),
      resolveUrl: async (path) => `blob:${path}`,
    });
    const playback = createOtioPlayback({
      document: doc,
      timelineId,
      canvas: canvas(),
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    await playback.seek({ value: 48, rate: 24 });

    const videoDecoders = created.filter((element) => element.muted);
    expect(
      videoDecoders.filter(
        (element) => element.src === 'blob:media/primary_a.mp4'
      )
    ).toHaveLength(1);
    expect(
      videoDecoders.flatMap((element) => element.seekTargets)
    ).not.toContain(0);
    playback.dispose();
  });

  test('same-file dissolve voices stay independent and apply weight once', async () => {
    const doc = buildDocument({ audioTransition: true, audioFrames: 24 });
    const audioContext = new MockAudioContext();
    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:dialogue',
      audioContext: audioContext as unknown as AudioContext,
    });
    const time: OtioRationalTime = { value: 24, rate: 24 };
    await playback.seek(time);
    const evaluation = evaluateOtioAt(doc, 'timeline_1', time);
    const audio = created.filter((element) =>
      element.attrs.has('data-bundle-path')
    );
    expect(evaluation.audio_contributions.length).toBeGreaterThan(1);
    expect(audio.length).toBe(evaluation.audio_contributions.length);
    for (const contrib of evaluation.audio_contributions) {
      const product = contrib.volume * contrib.transition_weight;
      expect(
        audioContext.gains.some((gain) => gain.gain.value === product)
      ).toBe(true);
    }
    playback.dispose();
  });

  test('trimmed audio stops and mute reaches the fallback element', async () => {
    const env = globalThis as { AudioContext?: unknown };
    env.AudioContext = undefined;
    const playback = createOtioPlayback({
      document: buildDocument({ audioFrames: 12 }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:dialogue',
    });
    await playback.play();
    raf?.(0);
    await playback.seek({ value: 0, rate: 24 });
    const voice = created.find(
      (element) => element.attrs.get('data-active') === 'true'
    );
    expect(voice).toBeDefined();
    playback.setTrackMute('track_a', true);
    expect(voice?.volume).toBe(0);
    await playback.seek({ value: 24, rate: 24 });
    expect(voice?.paused).toBe(true);
    expect(voice?.attrs.get('data-active')).toBe('false');
    playback.dispose();
  });

  test('pauses a playing audio decoder for an unavailable -24/24 sample', async () => {
    const doc = sampledMediaDocument({
      kind: 'Audio',
      rate: 24,
      duration: 48,
      availableStart: 24,
    });
    const unavailable = evaluateOtioAt(doc, 'timeline_1', {
      value: 0,
      rate: 24,
    }).audio_contributions[0];
    if (!unavailable) {
      throw new Error('unavailable audio sample is missing');
    }
    expect(
      compareRationalTimes(unavailable.source_time, {
        value: 0,
        rate: unavailable.source_time.rate,
      })
    ).toBeLessThan(0);
    const unavailableHandle = unavailable.diagnostics.find(
      (issue) => issue.code === 'missing-handles'
    );
    if (!unavailableHandle) {
      throw new Error(
        'unavailable audio sample is missing its handle diagnostic'
      );
    }
    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:dialogue',
    });

    await playback.play();
    await playback.seek({ value: 24, rate: 24 });
    const voice = created.find(
      (element) =>
        element.attrs.get('data-bundle-path') === 'media/dialogue.wav'
    );
    expect(voice?.paused).toBe(false);
    expect(voice?.attrs.get('data-active')).toBe('true');

    await playback.seek({ value: 0, rate: 24 });

    expect(voice?.paused).toBe(true);
    expect(voice?.attrs.get('data-active')).toBe('false');
    expect(playback.getState().diagnostics).toContainEqual(unavailableHandle);
    expect(
      evaluateOtioAt(doc, 'timeline_1', {
        value: 0,
        rate: 24,
      }).audio_contributions[0]
    ).toEqual(unavailable);
    playback.dispose();
  });

  test('unsupported effects withhold rendered pixels until consent', async () => {
    const output = new SoftCanvas();
    const playback = createOtioPlayback({
      document: buildDocument({ effect: true }),
      timelineId: 'timeline_1',
      canvas: canvas(output),
      resolveMedia: async () => 'blob:clip',
    });
    await playback.seek({ value: 0, rate: 24 });
    expect(playback.getState().previewBlocked).toBe(true);
    expect(output.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    await playback.play();
    expect(playback.getState().playing).toBe(false);
    playback.setBaseMediaPreviewAllowed(true);
    await playback.seek({ value: 0, rate: 24 });
    expect(
      playback
        .getState()
        .diagnostics.some((issue) => issue.code === 'unsupported-effect')
    ).toBe(true);
    expect(playback.getState().previewBlocked).toBe(false);
    expect(output.pixel).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    await playback.play();
    expect(playback.getState().playing).toBe(true);
    playback.dispose();
  });

  test('aborts pending timing reads and drops late timing without disposing the resolver', async () => {
    const mediaBlob = new Blob(['late timing marker'], { type: 'video/mp4' });
    const timing = Promise.withResolvers<OtioVideoTiming>();
    const started = Promise.withResolvers<void>();
    const calls: TimingReadCall[] = [];
    let resolverDisposed = false;
    const resolver: OtioMediaResolver = {
      hasEntry: () => true,
      getDecompressedBytes: () => 0,
      resolveBlob: async () => mediaBlob,
      resolveUrl: async () => 'blob:deferred-timing',
      dispose: () => {
        resolverDisposed = true;
      },
    };
    const readVideoTiming: ReadVideoTiming = async (blob, mime, signal) => {
      calls.push({ blob, mime, signal });
      started.resolve();
      return timing.promise;
    };
    const playback = createOtioPlayback({
      document: buildDocument(),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: resolver,
      readVideoTiming,
    });

    const seek = playback.seek({ value: 0, rate: 24 });
    await started.promise;
    const decoder = created.find((element) => element.muted);
    playback.dispose();
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(resolverDisposed).toBe(false);

    timing.resolve({
      kind: 'windows',
      starts: new Float64Array([0]),
      ends: new Float64Array([1]),
    });
    await seek;
    expect(decoder?.seekTargets).toEqual([]);
  });

  test('dispose leaves an injected resolver alive and drops a late blob', async () => {
    let disposed = false;
    const { promise, resolve } = Promise.withResolvers<Blob>();
    const resolver = {
      hasEntry: () => true,
      getDecompressedBytes: () => 0,
      resolveBlob: async () => null,
      resolveUrl: async () => 'blob:kept',
      dispose: () => {
        disposed = true;
      },
    };
    const owned = createOtioPlayback({
      document: buildDocument(),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: resolver,
    });
    owned.dispose();
    expect(disposed).toBe(false);

    const late = createOtioPlayback({
      document: buildDocument(),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: () => promise,
    });
    const seek = late.seek({ value: 0, rate: 24 });
    await Promise.resolve();
    late.dispose();
    resolve(new Blob(['late']));
    await seek;
    expect(createdUrls.filter((url) => !revokedUrls.includes(url))).toEqual([]);
  });

  test('50 black tracks at 960x540 seek 0 creates 3 pooled canvases and paints all 50 leaves', async () => {
    const trackCount = 50;
    const tracks = Array.from({ length: trackCount }, (_, i) => ({
      OTIO_SCHEMA: 'Track.1',
      metadata: { relic: { id: `track_${i}` } },
      kind: 'Video',
      children: [
        {
          OTIO_SCHEMA: 'Clip.1',
          metadata: { relic: { id: `clip_${i}` } },
          source_range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 24, rate: 24 },
          },
          media_reference: {
            OTIO_SCHEMA: 'ImageSequenceReference.1',
            missing_frame_policy: 'black',
            available_range: null,
          },
        },
      ],
    }));

    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_50_black' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_50_black' } },
          children: tracks,
        },
      })
    );

    const output = new SoftCanvas();
    output.width = 960;
    output.height = 540;

    const createdCanvases: SoftCanvas[] = [];
    let leafPaintCount = 0;
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === 'canvas') {
        const sc = new SoftCanvas();
        createdCanvases.push(sc);
        const origFillRect = sc.ctx.fillRect.bind(sc.ctx);
        sc.ctx.fillRect = () => {
          leafPaintCount += 1;
          origFillRect();
        };
        return sc as unknown as HTMLElement;
      }
      return originalCreateElement(tag);
    }) as typeof document.createElement;

    let playback: OtioPlaybackController | null = null;
    try {
      playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_50_black',
        canvas: canvas(output),
        resolveMedia: async () => null,
      });

      await playback.seek({ value: 0, rate: 24 });

      expect(leafPaintCount).toBe(50);
      expect(createdCanvases.length).toBe(3);
      expect(output.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(playback.getState().diagnostics).toEqual([]);
    } finally {
      playback?.dispose();
      document.createElement = originalCreateElement;
    }
  });

  test('depth witness: 61 nested Stacks parse and create 62 surfaces; 62 Stacks throw nesting limit', async () => {
    function buildNestedStackJson(stackCount: number): string {
      let inner: Record<string, unknown> = {
        OTIO_SCHEMA: 'Clip.1',
        source_range: {
          start_time: { value: 0, rate: 24 },
          duration: { value: 1, rate: 24 },
        },
        media_reference: {
          OTIO_SCHEMA: 'ImageSequenceReference.1',
          missing_frame_policy: 'black',
          available_range: null,
        },
      };
      for (let i = stackCount - 1; i >= 0; i--) {
        inner = {
          OTIO_SCHEMA: 'Stack.1',
          tracks: inner,
        };
      }
      return JSON.stringify(inner);
    }

    expect(() => readOtioDocument(buildNestedStackJson(62))).toThrow(
      'OTIO JSON exceeds the nesting limit of 64'
    );

    const doc = readOtioDocument(buildNestedStackJson(61));
    const timelineId = doc.timeline_ids[0];
    if (!timelineId) throw new Error('missing synthetic timeline');

    const output = new SoftCanvas();
    output.width = 960;
    output.height = 540;

    const createdCanvases: SoftCanvas[] = [];
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === 'canvas') {
        const sc = new SoftCanvas();
        createdCanvases.push(sc);
        return sc as unknown as HTMLElement;
      }
      return originalCreateElement(tag);
    }) as typeof document.createElement;

    let playback: OtioPlaybackController | null = null;
    try {
      playback = createOtioPlayback({
        document: doc,
        timelineId,
        canvas: canvas(output),
        resolveMedia: async () => null,
      });

      await playback.seek({ value: 0, rate: 24 });

      expect(createdCanvases.length).toBe(62);
      expect(output.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(playback.getState().diagnostics).toEqual([]);
    } finally {
      playback?.dispose();
      document.createElement = originalCreateElement;
    }
  });

  test('every pooled canvas ends at 0x0 on dispose', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_dispose' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_dispose' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_dispose' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_dispose' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );
    const output = new SoftCanvas();
    output.width = 960;
    output.height = 540;

    const createdCanvases: SoftCanvas[] = [];
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === 'canvas') {
        const sc = new SoftCanvas();
        createdCanvases.push(sc);
        return sc as unknown as HTMLElement;
      }
      return originalCreateElement(tag);
    }) as typeof document.createElement;

    let playback: OtioPlaybackController | null = null;
    try {
      playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_dispose',
        canvas: canvas(output),
        resolveMedia: async () => null,
      });

      await playback.seek({ value: 0, rate: 24 });

      expect(createdCanvases.length).toBeGreaterThan(0);
      for (const surface of createdCanvases) {
        expect(surface.width).toBe(960);
        expect(surface.height).toBe(540);
      }

      playback.dispose();

      for (const surface of createdCanvases) {
        expect(surface.width).toBe(0);
        expect(surface.height).toBe(0);
      }
    } finally {
      playback?.dispose();
      document.createElement = originalCreateElement;
    }
  });

  test('loss before paint keeps buffering and draws nothing', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_loss_before_paint' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;
    visibleCanvas.pixel = { r: 0, g: 0, b: 0, a: 0 };

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_loss_before_paint',
      canvas: visibleCanvas as unknown as HTMLCanvasElement,
      resolveMedia: async () => null,
    });

    try {
      visibleCanvas.loseContext();

      await playback.seek({ value: 0, rate: 24 });

      expect(playback.getState().buffering).toBe(true);
      expect(visibleCanvas.pixel).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    } finally {
      playback.dispose();
    }
  });

  test('restore causes exactly one re-render and an exact pixel', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_restore' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;
    visibleCanvas.pixel = { r: 0, g: 0, b: 0, a: 0 };

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_restore',
      canvas: visibleCanvas as unknown as HTMLCanvasElement,
      resolveMedia: async () => null,
    });

    try {
      visibleCanvas.loseContext();
      await playback.seek({ value: 0, rate: 24 });
      expect(playback.getState().buffering).toBe(true);
      expect(visibleCanvas.pixel).toEqual({ r: 0, g: 0, b: 0, a: 0 });

      let reRenderCount = 0;
      const { promise: reRenderPromise, resolve: onReRender } =
        Promise.withResolvers<void>();
      playback.subscribe((state) => {
        if (!state.buffering) {
          reRenderCount += 1;
          onReRender();
        }
      });

      expect(reRenderCount).toBe(0);

      visibleCanvas.restoreContext();
      await reRenderPromise;

      expect(playback.getState().buffering).toBe(false);
      expect(visibleCanvas.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(reRenderCount).toBe(1);
    } finally {
      playback.dispose();
    }
  });

  test('a lost pooled surface is replaced at the same depth, the pool length is unchanged and the old surface is at width 0', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_pooled_lost' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;

    const createdPooledCanvases: LossyCanvas[] = [];
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === 'canvas') {
        const sc = new LossyCanvas();
        createdPooledCanvases.push(sc);
        return sc as unknown as HTMLElement;
      }
      return originalCreateElement(tag);
    }) as typeof document.createElement;

    let playback: OtioPlaybackController | null = null;
    try {
      playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_pooled_lost',
        canvas: visibleCanvas as unknown as HTMLCanvasElement,
        resolveMedia: async () => null,
      });

      await playback.seek({ value: 0, rate: 24 });
      expect(createdPooledCanvases.length).toBe(3); // depths 0, 1, 2

      const oldLeafSurface = createdPooledCanvases[2];
      if (!oldLeafSurface) throw new Error('missing old leaf surface');
      expect(oldLeafSurface.width).toBe(960);

      // Lose context on pooled leaf surface
      oldLeafSurface.loseContext();

      // Trigger next seek
      await playback.seek({ value: 1, rate: 24 });

      // Old surface width is 0
      expect(oldLeafSurface.width).toBe(0);

      // Pool created a 4th canvas to replace it
      expect(createdPooledCanvases.length).toBe(4);
      const newLeafSurface = createdPooledCanvases[3];
      if (!newLeafSurface) throw new Error('missing new leaf surface');
      expect(newLeafSurface.width).toBe(960);
      expect(newLeafSurface).not.toBe(oldLeafSurface);
    } finally {
      playback?.dispose();
      document.createElement = originalCreateElement;
    }
  });

  test('the deadline produces the error, and a later restore clears it and repaints', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_deadline' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;

    let timerCallback: (() => void) | null = null;
    let scheduledDelay = 0;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number
    ) => {
      timerCallback = fn as () => void;
      scheduledDelay = ms ?? 0;
      return 999 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    let playback: OtioPlaybackController | null = null;
    try {
      playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_deadline',
        canvas: visibleCanvas as unknown as HTMLCanvasElement,
        resolveMedia: async () => null,
      });

      await playback.seek({ value: 0, rate: 24 });
      expect(playback.getState().diagnostics).toEqual([]);

      visibleCanvas.loseContext();
      expect(playback.getState().buffering).toBe(true);
      expect(scheduledDelay).toBe(OTIO_GRAPHICS_RESTORE_MS);
      expect(timerCallback).not.toBeNull();

      const executeTimer = timerCallback as (() => void) | null;
      if (!executeTimer) throw new Error('deadline timer was not scheduled');
      executeTimer();

      const stateAtDeadline = playback.getState();
      expect(stateAtDeadline.buffering).toBe(false);
      expect(stateAtDeadline.graphicsFailed).toBe(true);
      expect(stateAtDeadline.diagnostics).toEqual([
        {
          severity: 'error',
          code: 'unsupported-browser',
          message:
            'Preview graphics context was lost and the browser did not restore it. Reload the page to try again.',
        },
      ]);

      const { promise: restorePromise, resolve: onRestore } =
        Promise.withResolvers<void>();
      playback.subscribe((state) => {
        if (!state.buffering && state.diagnostics.length === 0) {
          onRestore();
        }
      });

      // Later restore clears the error and repaints
      visibleCanvas.restoreContext();
      await restorePromise;

      const stateAfterRestore = playback.getState();
      expect(stateAfterRestore.buffering).toBe(false);
      expect(stateAfterRestore.diagnostics).toEqual([]);
      expect(visibleCanvas.pixel).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    } finally {
      globalThis.setTimeout = origSetTimeout;
      playback?.dispose();
    }
  });

  test('dispose removes listeners and the timer', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_dispose_listeners' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;

    let timerCleared = false;
    const origClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = ((id?: number) => {
      if (id !== undefined) timerCleared = true;
      origClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_dispose_listeners',
        canvas: visibleCanvas as unknown as HTMLCanvasElement,
        resolveMedia: async () => null,
      });

      expect(visibleCanvas.listeners.get('contextlost')?.size).toBe(1);
      expect(visibleCanvas.listeners.get('contextrestored')?.size).toBe(1);

      visibleCanvas.loseContext();

      playback.dispose();

      expect(visibleCanvas.listeners.get('contextlost')?.size ?? 0).toBe(0);
      expect(visibleCanvas.listeners.get('contextrestored')?.size ?? 0).toBe(0);
      expect(timerCleared).toBe(true);
    } finally {
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  test('visible canvas element is hidden during context loss and restored on present or dispose', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_visibility' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;
    visibleCanvas.style.visibility = 'inherit';

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_visibility',
      canvas: visibleCanvas as unknown as HTMLCanvasElement,
      resolveMedia: async () => null,
    });

    try {
      await playback.seek({ value: 0, rate: 24 });
      expect(visibleCanvas.style.visibility).toBe('inherit');

      // 1. lost -> hidden
      visibleCanvas.loseContext();
      expect(visibleCanvas.style.visibility).toBe('hidden');

      // 2. restore+present -> visible (restored to prior value)
      const { promise: reRenderPromise, resolve: onReRender } =
        Promise.withResolvers<void>();
      playback.subscribe((state) => {
        if (!state.buffering) {
          onReRender();
        }
      });
      visibleCanvas.restoreContext();
      await reRenderPromise;

      expect(visibleCanvas.style.visibility).toBe('inherit');

      // 3. failed-restore deadline keeps hidden
      let timerCallback: (() => void) | null = null;
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((
        fn: (...args: unknown[]) => void,
        _ms?: number
      ) => {
        timerCallback = fn as () => void;
        return 999 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      try {
        visibleCanvas.loseContext();
        expect(visibleCanvas.style.visibility).toBe('hidden');

        const executeTimer = timerCallback as (() => void) | null;
        if (!executeTimer) throw new Error('deadline timer not scheduled');
        executeTimer();

        expect(playback.getState().buffering).toBe(false);
        expect(visibleCanvas.style.visibility).toBe('hidden');
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }

      // 4. dispose restores prior inline value
      playback.dispose();
      expect(visibleCanvas.style.visibility).toBe('inherit');
    } finally {
      playback.dispose();
    }
  });

  test('episode-capped deadline: flapping loss and restore without present fires error at 3000 ms from first loss', async () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_flapping' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_1' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_1' } },
                  source_range: {
                    start_time: { value: 0, rate: 24 },
                    duration: { value: 24, rate: 24 },
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ImageSequenceReference.1',
                    missing_frame_policy: 'black',
                    available_range: null,
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const visibleCanvas = new LossyCanvas();
    visibleCanvas.width = 960;
    visibleCanvas.height = 540;

    let timerCallback: (() => void) | null = null;
    let scheduledDelay = 0;
    let timerScheduledCount = 0;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number
    ) => {
      timerCallback = fn as () => void;
      scheduledDelay = ms ?? 0;
      timerScheduledCount += 1;
      return 999 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    let playback: OtioPlaybackController | null = null;
    try {
      playback = createOtioPlayback({
        document: doc,
        timelineId: 'timeline_flapping',
        canvas: visibleCanvas as unknown as HTMLCanvasElement,
        resolveMedia: async () => null,
      });

      await playback.seek({ value: 0, rate: 24 });
      expect(playback.getState().diagnostics).toEqual([]);

      // First loss starts 3000ms timer
      visibleCanvas.loseContext();
      expect(timerScheduledCount).toBe(1);
      expect(scheduledDelay).toBe(OTIO_GRAPHICS_RESTORE_MS);

      // Flapping cycles without a successful present do not reset or restart timer
      visibleCanvas.restoreContext();
      visibleCanvas.loseContext();
      expect(timerScheduledCount).toBe(1);

      visibleCanvas.restoreContext();
      visibleCanvas.loseContext();
      expect(timerScheduledCount).toBe(1);

      // Deadline fires at 3000ms after first loss
      const executeTimer = timerCallback as (() => void) | null;
      if (!executeTimer) throw new Error('deadline timer not scheduled');
      executeTimer();

      expect(playback.getState().buffering).toBe(false);
      expect(playback.getState().graphicsFailed).toBe(true);
      expect(playback.getState().diagnostics).toEqual([
        {
          severity: 'error',
          code: 'unsupported-browser',
          message:
            'Preview graphics context was lost and the browser did not restore it. Reload the page to try again.',
        },
      ]);
      expect(visibleCanvas.style.visibility).toBe('hidden');

      // A successful present after restore clears timer and error
      const { promise: presentedPromise, resolve: onPresented } =
        Promise.withResolvers<void>();
      playback.subscribe((state) => {
        if (!state.buffering && state.diagnostics.length === 0) {
          onPresented();
        }
      });
      visibleCanvas.restoreContext();
      await presentedPromise;

      expect(playback.getState().diagnostics).toEqual([]);
      expect(visibleCanvas.style.visibility).not.toBe('hidden');
      expect(playback.getState().graphicsFailed).toBe(false);

      // A new loss after a successful present starts a fresh 3000ms episode
      timerScheduledCount = 0;
      visibleCanvas.loseContext();
      expect(timerScheduledCount).toBe(1);
      expect(scheduledDelay).toBe(OTIO_GRAPHICS_RESTORE_MS);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      playback?.dispose();
    }
  });

  test('play at or past duration restarts from 0 and advances', async () => {
    const playback = createOtioPlayback({
      document: buildDocument({ rate: 24, frames: 48 }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:clip',
    });
    try {
      // Seek to the end of the timeline
      await playback.seek({ value: 48, rate: 24 });
      expect(playback.getState().time.value).toBe(48);
      expect(playback.getState().playing).toBe(false);

      // Hitting play at the end should reset time to 0 and start playing
      await playback.play();
      expect(playback.getState().time.value).toBe(0);
      expect(playback.getState().playing).toBe(true);

      // Advance clock with animation frame tick
      expect(raf).not.toBeNull();
      raf?.(0);
      raf?.(500); // 0.5s at 24fps = 12 frames
      expect(playback.getState().time.value).toBe(12);
      expect(playback.getState().playing).toBe(true);
    } finally {
      playback.dispose();
    }
  });

  test('play at last frame (duration minus one frame) restarts from 0 and advances', async () => {
    const playback = createOtioPlayback({
      document: buildDocument({ rate: 24, frames: 48 }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:clip',
    });
    try {
      // Last reachable frame on scrubber / Next frame is frame 47 (48 - 1)
      await playback.seek({ value: 47, rate: 24 });
      expect(playback.getState().time.value).toBe(47);
      expect(playback.getState().playing).toBe(false);

      // Hitting play on the last frame should reset time to 0 and start playing
      await playback.play();
      expect(playback.getState().time.value).toBe(0);
      expect(playback.getState().playing).toBe(true);

      // Advance clock with animation frame tick
      expect(raf).not.toBeNull();
      raf?.(0);
      raf?.(500); // 0.5s at 24fps = 12 frames
      expect(playback.getState().time.value).toBe(12);
      expect(playback.getState().playing).toBe(true);
    } finally {
      playback.dispose();
    }
  });

  test('play mid-timeline keeps current position', async () => {
    const playback = createOtioPlayback({
      document: buildDocument({ rate: 24, frames: 48 }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:clip',
    });
    try {
      await playback.seek({ value: 20, rate: 24 });
      expect(playback.getState().time.value).toBe(20);
      expect(playback.getState().playing).toBe(false);

      await playback.play();
      expect(playback.getState().time.value).toBe(20);
      expect(playback.getState().playing).toBe(true);

      raf?.(0);
      raf?.(250); // 0.25s at 24fps = 6 frames
      expect(playback.getState().time.value).toBe(26);
    } finally {
      playback.dispose();
    }
  });

  test('play after natural end (tick reaching duration) restarts from 0 and advances', async () => {
    const playback = createOtioPlayback({
      document: buildDocument({ rate: 24, frames: 48 }),
      timelineId: 'timeline_1',
      canvas: canvas(),
      resolveMedia: async () => 'blob:clip',
    });
    try {
      // Start near the end (frame 40 out of 48)
      await playback.seek({ value: 40, rate: 24 });
      await playback.play();
      expect(playback.getState().playing).toBe(true);

      // Tick past the duration (48 frames = 2 seconds)
      raf?.(0);
      raf?.(1000); // 1.0s elapsed = 24 frames -> reaches end (40+24 = 64 >= 48)
      expect(playback.getState().playing).toBe(false);
      expect(playback.getState().time.value).toBe(48);

      // Play again after natural end
      await playback.play();
      expect(playback.getState().time.value).toBe(0);
      expect(playback.getState().playing).toBe(true);

      raf?.(1500);
      raf?.(2000); // 0.5s elapsed = 12 frames
      expect(playback.getState().time.value).toBe(12);
    } finally {
      playback.dispose();
    }
  });
});

describe('otio native video playback S-C and S-B', () => {
  const created: MockMedia[] = [];
  let raf: FrameRequestCallback | null = null;
  let originalGlobals = new Map<
    PlaybackGlobalKey,
    PropertyDescriptor | undefined
  >();
  let originalUrlMethods = new Map<
    UrlMethodName,
    PropertyDescriptor | undefined
  >();
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  beforeEach(() => {
    created.length = 0;
    createdUrls.length = 0;
    revokedUrls.length = 0;
    raf = null;
    MockVideoFrame.reset();
    originalGlobals = propertyDescriptors(globalThis, playbackGlobalKeys);
    originalUrlMethods = propertyDescriptors(URL, urlMethodNames);
    try {
      for (const [name, value] of [
        ['Image', MockMedia],
        ['Audio', MockMedia],
        ['AudioContext', MockAudioContext],
        ['VideoFrame', MockVideoFrame],
        [
          'document',
          {
            createElement: (tag: string) => {
              if (tag === 'canvas') return new SoftCanvas();
              if (tag === 'video' || tag === 'audio') {
                const media = new MockMedia();
                created.push(media);
                return media;
              }
              return hostElement();
            },
            body: hostElement(),
          },
        ],
        [
          'requestAnimationFrame',
          (cb: FrameRequestCallback) => {
            raf = cb;
            return 1;
          },
        ],
        [
          'cancelAnimationFrame',
          () => {
            raf = null;
          },
        ],
      ] as const) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => {
          const url = `blob:owned-${createdUrls.length}`;
          createdUrls.push(url);
          return url;
        },
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: (url: string) => {
          revokedUrls.push(url);
        },
      });
    } catch (error) {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
      throw error;
    }
  });

  afterEach(() => {
    try {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
    } finally {
      createdUrls.length = 0;
      revokedUrls.length = 0;
    }
  });
  test('presentedWindowOutcome: matches at ±Q, uncovered at ±(Q + 1e-7), outside span before head and after tail', () => {
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0.0, 0.04, 0.08]),
      ends: Float64Array.from([0.04, 0.08, 0.12]),
    };
    const Q = OTIO_PACKET_START_TOLERANCE_SECONDS; // 2e-6

    // Exact matches within Q
    expect(presentedWindowOutcome(0.0, timing)).toEqual({
      kind: 'match',
      index: 0,
    });
    expect(presentedWindowOutcome(0.0 + Q, timing)).toEqual({
      kind: 'match',
      index: 0,
    });
    expect(presentedWindowOutcome(0.04 - Q, timing)).toEqual({
      kind: 'match',
      index: 1,
    });
    expect(presentedWindowOutcome(0.08 + Q, timing)).toEqual({
      kind: 'match',
      index: 2,
    });

    // Inside span [0.0 - Q, 0.12 - Q), but no start matches within Q -> uncovered
    expect(presentedWindowOutcome(0.0 + Q + 1e-7, timing)).toEqual({
      kind: 'uncovered',
    });
    expect(presentedWindowOutcome(0.02, timing)).toEqual({
      kind: 'uncovered',
    });
    expect(presentedWindowOutcome(0.04 + Q + 1e-7, timing)).toEqual({
      kind: 'uncovered',
    });
    expect(presentedWindowOutcome(0.12 - Q - 1e-7, timing)).toEqual({
      kind: 'uncovered',
    });

    // Outside span before head: mediaTime < starts[0] - Q
    expect(presentedWindowOutcome(-0.01, timing)).toEqual({
      kind: 'outside',
    });
    expect(presentedWindowOutcome(0.0 - Q - 1e-7, timing)).toEqual({
      kind: 'outside',
    });

    // Outside span after tail: mediaTime >= ends[last] - Q
    expect(presentedWindowOutcome(0.12 - Q, timing)).toEqual({
      kind: 'outside',
    });
    expect(presentedWindowOutcome(0.15, timing)).toEqual({
      kind: 'outside',
    });
  });

  test('checkNativeTimingEligibility: validates windows, start gaps, and W_min >= vsync', () => {
    const Q = OTIO_PACKET_START_TOLERANCE_SECONDS;
    const vsync = 1 / 60; // ~16.6ms

    // Valid 30fps timing (windows = ~33.3ms > vsync)
    const validTiming: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, 1 / 30, 2 / 30]),
      ends: Float64Array.from([1 / 30, 2 / 30, 3 / 30]),
    };
    expect(checkNativeTimingEligibility(validTiming, 1.0, vsync)).toBe(true);

    // Window duration <= 2Q rejected
    const tinyWindowTiming: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, 0.04]),
      ends: Float64Array.from([Q, 0.08]),
    };
    expect(checkNativeTimingEligibility(tinyWindowTiming, 1.0, vsync)).toBe(
      false
    );

    // Start gap <= 2Q rejected
    const tinyGapTiming: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, Q]),
      ends: Float64Array.from([0.04, 0.08]),
    };
    expect(checkNativeTimingEligibility(tinyGapTiming, 1.0, vsync)).toBe(false);

    // W_min < vsync rejected (e.g. 120fps video on 60Hz display: W_min = 8.3ms < 16.6ms)
    const fastVideoTiming: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, 1 / 120, 2 / 120]),
      ends: Float64Array.from([1 / 120, 2 / 120, 3 / 120]),
    };
    expect(checkNativeTimingEligibility(fastVideoTiming, 1.0, vsync)).toBe(
      false
    );
  });

  test('computePhaseAnchor: calculates closed-form anchor and tests start spread fallback', () => {
    const vsync = 1 / 60; // 0.016666s
    const wMin = 1 / 30; // 0.033333s

    // Single decoder: always in band
    const singleSample = [
      {
        dL: 100, // now in ms
        iL0Plus1Start: 1 / 30, // nextStart
        sourceT0Seconds: 0,
        rL: 1.0,
        wMinSeconds: wMin,
      },
    ];
    const singleAnchor = computePhaseAnchor(singleSample, vsync);
    expect(singleAnchor.spreadAcceptable).toBe(true);
    expect(singleAnchor.maxSpreadMs).toBe(0);
    expect(singleAnchor.tauStar).toBeGreaterThan(0);

    // Two decoders with small phase spread: acceptable
    const dualSampleInBand = [
      {
        dL: 100,
        iL0Plus1Start: 1 / 30,
        sourceT0Seconds: 0,
        rL: 1.0,
        wMinSeconds: wMin,
      },
      {
        dL: 110, // 10ms spread < (2*Wmin - vsync)*1000 = (0.0666 - 0.0166)*1000 = 50ms
        iL0Plus1Start: 1 / 30,
        sourceT0Seconds: 0,
        rL: 1.0,
        wMinSeconds: wMin,
      },
    ];
    const dualAnchor = computePhaseAnchor(dualSampleInBand, vsync);
    expect(dualAnchor.spreadAcceptable).toBe(true);
    expect(dualAnchor.maxSpreadMs).toBe(10);
    expect(dualAnchor.tauStar).toBe(
      (singleAnchor.tauStar + singleAnchor.tauStar + 10) / 2
    );

    // Two decoders with wide phase spread > min(2*Wmin - vsync): unacceptable
    const dualSampleWideSpread = [
      {
        dL: 100,
        iL0Plus1Start: 1 / 30,
        sourceT0Seconds: 0,
        rL: 1.0,
        wMinSeconds: wMin,
      },
      {
        dL: 170, // 70ms spread > 50ms limit
        iL0Plus1Start: 1 / 30,
        sourceT0Seconds: 0,
        rL: 1.0,
        wMinSeconds: wMin,
      },
    ];
    const wideAnchor = computePhaseAnchor(dualSampleWideSpread, vsync);
    expect(wideAnchor.spreadAcceptable).toBe(false);
    expect(wideAnchor.maxSpreadMs).toBeCloseTo(70, 5);
    expect(wideAnchor.spreadLimitMs).toBeCloseTo(50, 1);
  });

  test('NativeDecoderRing: allocates 3 slots once, releases to 0x0, respects budget', () => {
    const budget = new SnapshotPixelBudget(3 * 960 * 540); // exactly one decoder budget
    const media = new MockMedia();
    const ring1 = new NativeDecoderRing(
      media as unknown as HTMLVideoElement,
      'occ1',
      'media/clip1.mp4',
      budget
    );

    expect(ring1.allocate(960, 540)).toBe(true);
    expect(ring1.slots).toHaveLength(SNAPSHOT_SLOTS_PER_DECODER);
    expect(budget.allocatedPixels).toBe(3 * 960 * 540);

    // Second decoder exceeds budget
    const ring2 = new NativeDecoderRing(
      media as unknown as HTMLVideoElement,
      'occ2',
      'media/clip2.mp4',
      budget
    );
    expect(ring2.allocate(960, 540)).toBe(false);

    // Releasing ring1 frees budget and sets canvas size to 0x0
    ring1.release();
    expect(ring1.slots).toHaveLength(0);
    expect(budget.allocatedPixels).toBe(0);

    // Now ring2 can allocate
    expect(ring2.allocate(960, 540)).toBe(true);
    ring2.release();
  });

  test('S-C: playing video is never drawn to compositor, only approved snapshot canvas', async () => {
    const mediaBlob = new Blob(['native video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });
      videoMedia!.advanceTo(0);
      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      expect(playback.getState().playing).toBe(true);

      // Tick at wallFor(0.5): req = 0 (paused T0 frame)
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(wallFor(0.5));
      expect(outCanvas.pixel.r).toBe(0);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);
      expect(
        outCanvas.ctx.drawnSources.some((d) => d.source instanceof MockMedia)
      ).toBe(false);

      // Deliver tag 1 at its consistent time and tick at wallFor(1.5): req = 1
      outCanvas.ctx.drawnSources.length = 0;
      videoMedia!.triggerRvfc(wallFor(1.0), 1 / 30);
      raf?.(wallFor(1.5));
      expect(outCanvas.pixel.r).toBe(1);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);

      // CRITICAL INVARIANT: The playing video element is NEVER passed to drawImage!
      const drawnVideoElements = outCanvas.ctx.drawnSources.filter(
        (d) => d.source instanceof MockMedia
      );
      expect(drawnVideoElements).toHaveLength(0);

      // Every drawn source is a snapshot canvas (SoftCanvas)
      const drawnCanvases = outCanvas.ctx.drawnSources.filter(
        (d) => d.source instanceof SoftCanvas
      );
      expect(drawnCanvases.length).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });

  test('S-C: holds previous composite when required tag is missing; currentTime and notify do not advance', async () => {
    const mediaBlob = new Blob(['hold test video'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      let notifyCount = 0;
      playback.subscribe(() => {
        notifyCount++;
      });
      const initialNotifyCount = notifyCount;
      const timeBefore = playback.getState().time.value;

      // 1. Tick at wallFor(2.5): it holds, and time and notify count are unchanged.
      raf?.(wallFor(2.5));
      expect(playback.getState().time.value).toBe(timeBefore);
      expect(notifyCount).toBe(initialNotifyCount);

      // 2. Deliver tag 2 at wallFor(2.6).
      videoMedia!.triggerRvfc(wallFor(2.6), 2 / 30);

      // 3. Tick at wallFor(2.7): it approves. Time ≈ 2.7, notify count +1, pixel = 2.
      raf?.(wallFor(2.7));
      expect(playback.getState().time.value).toBeGreaterThan(timeBefore);
      expect(notifyCount).toBeGreaterThan(initialNotifyCount);
      expect(outCanvas.pixel.r).toBe(2);
    } finally {
      playback.dispose();
    }
  });

  test('S-C: uncertified tail sample triggers resync into seek cadence with invalid-timing diagnostic', async () => {
    // Media has 5 certified windows (frames 0 to 4), frame 5+ is uncertified tail
    const mediaBlob = new Blob(['no-duration webm mock'], {
      type: 'video/webm',
    });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, 1 / 30, 2 / 30, 3 / 30, 4 / 30]),
      ends: Float64Array.from([1 / 30, 2 / 30, 3 / 30, 4 / 30, 5 / 30]),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.webm', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 30,
      targetUrl: 'media/clip.webm',
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.webm'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      // An outside-span callback is ignored (no sticky ineligible marking!)
      videoMedia!.triggerRvfc(wallFor(3), 0.25);
      expect(videoMedia!.hasRvfc).toBe(true);

      // A tick at wallFor(6) goes to seek cadence with invalid-timing
      raf?.(wallFor(6));
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      const state = playback.getState();
      expect(
        state.diagnostics.some(
          (d) =>
            d.code === 'invalid-timing' &&
            d.message.includes('outside certified packet timing')
        )
      ).toBe(true);

      // seek(2) while playing, then waitForRvfc, then deliver tag 3. Assert an approved native composite.
      const seekPromise = playback.seek({ value: 2, rate: 30 });
      await waitForRvfc(videoMedia!);
      videoMedia!.triggerRvfc(wallFor(7), 3 / 30);
      await seekPromise;

      expect(
        playback.getState().diagnostics.some((d) => d.code === 'invalid-timing')
      ).toBe(false);
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(wallFor(7.5));
      expect(outCanvas.pixel.r).toBe(2);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });

  test('S-C: uncovered callback inside span marks media path sticky-ineligible', async () => {
    const mediaBlob = new Blob(['uncovered bad timestamps'], {
      type: 'video/mp4',
    });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, 1 / 30, 2 / 30, 3 / 30]),
      ends: Float64Array.from([1 / 30, 2 / 30, 3 / 30, 4 / 30]),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 30,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia?.enableRvfc();

      const start = performance.now();
      const playPromise = playback.play();
      await waitForRvfc(videoMedia!);
      videoMedia?.triggerRvfc(100, 0.015); // uncovered inside span!
      await playPromise;
      const elapsed = performance.now() - start;

      // No 500 ms retry
      expect(elapsed).toBeLessThan(400);

      // Decoders are paused
      expect(videoMedia?.paused).toBe(true);

      // After seek(2), no callback registers
      await playback.seek({ value: 2, rate: 30 });
      expect(videoMedia?.rvfcCallbacks.size).toBe(0);
    } finally {
      playback.dispose();
    }
  });

  test('S-B audio: produces zero steady seeks during normal playback (seek cadence)', async () => {
    const doc = sampledMediaDocument({ kind: 'Audio', rate: 30, duration: 60 });
    const outCanvas = new SoftCanvas();
    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: async () => 'blob:clip',
    });

    try {
      await playback.play();
      expect(playback.getState().playing).toBe(true);

      const audioMedia = created.find(
        (m) => m.attrs.get('data-bundle-path') === 'media/dialogue.wav'
      );
      expect(audioMedia).toBeDefined();
      const initialSeeks = audioMedia?.seekTargets.length ?? 0;

      // Advance ticks smoothly over 30 ticks
      for (let i = 1; i <= 30; i++) {
        raf?.(i * 33.333);
        const t = playback.getState().time;
        audioMedia?.advanceTo(t.value / t.rate);
        for (let k = 0; k < 5; k++) await Promise.resolve();
      }

      // ZERO steady seeks occurred!
      expect(audioMedia?.seekTargets.length).toBe(initialSeeks);

      // Offset by 3 frames (> 2 frames tolerance) -> exactly one async seek!
      const tOff = playback.getState().time;
      audioMedia?.advanceTo((tOff.value - 3) / tOff.rate);
      raf?.(31 * 33.333);
      for (let k = 0; k < 5; k++) await Promise.resolve();
      expect(audioMedia?.seekTargets.length).toBe(initialSeeks + 1);
      // Gain restored on seeked
      audioMedia?.dispatch('seeked');
      expect(audioMedia?.volume).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });

  test('S-B audio: produces zero steady seeks during normal playback (native)', async () => {
    const mediaBlob = new Blob(['native audio test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/clip.mp4', mediaBlob],
        ['media/dialogue.wav', new Blob(['audio'])],
      ]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const doc = sampledAvDocument({ rate: 30, duration: 60 });
    const outCanvas = new SoftCanvas();
    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      const audioMedia = created.find(
        (m) => m.attrs.get('data-bundle-path') === 'media/dialogue.wav'
      );
      expect(audioMedia).toBeDefined();
      const initialSeeks = audioMedia?.seekTargets.length ?? 0;

      // Advance ticks smoothly over 30 ticks
      for (let i = 1; i <= 30; i++) {
        videoMedia!.triggerRvfc(wallFor(i), (i + 1) / 30);
        audioMedia?.advanceTo((i + 0.5) / 30);
        raf?.(wallFor(i + 0.5));
        for (let k = 0; k < 5; k++) await Promise.resolve();
      }

      expect(audioMedia?.seekTargets.length).toBe(initialSeeks);
      // Offset by 3 frames (> 2 frames tolerance) -> exactly one async seek!
      const tOff = playback.getState().time;
      audioMedia?.advanceTo((tOff.value - 3) / tOff.rate);
      videoMedia!.triggerRvfc(wallFor(31), 31 / 30);
      raf?.(wallFor(31.5));
      for (let k = 0; k < 5; k++) await Promise.resolve();
      expect(audioMedia?.seekTargets.length).toBe(initialSeeks + 1);
      // Gain restored on seeked
      audioMedia?.dispatch('seeked');
      expect(audioMedia?.volume).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });

  test('S-C: fallback to seek cadence when requestVideoFrameCallback is missing', async () => {
    const mediaBlob = new Blob(['plain video'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from([0, 1 / 30, 2 / 30]),
      ends: Float64Array.from([1 / 30, 2 / 30, 3 / 30]),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 30,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      // MockMedia by default does NOT have requestVideoFrameCallback
      await playback.play();
      expect(playback.getState().playing).toBe(true);

      // Runs smoothly on seek cadence
      raf?.(0);
      raf?.(100); // 100ms at 30fps = 3 frames
      expect(playback.getState().time.value).toBe(3);
    } finally {
      playback.dispose();
    }
  });
  test('regression P0: play with a frame-callback decoder succeeds in registering rvfc before play completes', async () => {
    const mediaBlob = new Blob(['p0 video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 10 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 10 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 10,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();

      const playPromise = playback.play();
      await waitForRvfc(videoMedia!);
      expect(videoMedia!.rvfcCallbacks.size).toBeGreaterThan(0);

      videoMedia!.triggerRvfc(100, 1 / 30);
      await playPromise;
      expect(playback.getState().playing).toBe(true);
    } finally {
      playback.dispose();
    }
  });
  test('regression 1: right after start a tick at req = iL0 approves pixel iL0, and a second start approves new epoch captures', async () => {
    const mediaBlob = new Blob(['reg 1 video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });
      videoMedia!.advanceTo(0);

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      // Right after start, tick at req = iL0 (frame 0.1) -> approves pixel 0 (T0 paused frame)
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(wallFor(0.1));
      expect(outCanvas.pixel.r).toBe(0);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);

      // Deliver tag 1, tick at frame 1.5 -> approves pixel 1
      videoMedia!.triggerRvfc(wallFor(1.0), 1 / 30);
      raf?.(wallFor(1.5));
      expect(outCanvas.pixel.r).toBe(1);

      // Second start: seek to frame 10 while playing
      const d2 = wallFor(2.0);
      const seekPromise = playback.seek({ value: 10, rate: 30 });
      await waitForRvfc(videoMedia!);
      // For seek to 10, iL0 is 10, first advanced tag is 11
      videoMedia!.triggerRvfc(d2, 11 / 30);
      await seekPromise;

      const nu = 1 / 60;
      const wMin = minWindowDuration(timing, 1);
      const tau2 =
        d2 + ((nu + 2 * wMin) / 2 - (timing.starts[11]! - 10 / 30)) * 1000;
      const wallFor2 = (f: number): number => tau2 + (f / 30) * 1000;

      // Tick at req = iL0 for new epoch (frame 0.1 after seek target 10)
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(wallFor2(0.1));
      expect(outCanvas.pixel.r).toBe(10);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });
  test('regression 2a: native run to frame 5, pause, seek(0) records a new seek to mid(0) and pixel is 0', async () => {
    const mediaBlob = new Blob(['reg 2a video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });
      videoMedia!.advanceTo(0);

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });

      // Run native playback to frame 5
      for (let f = 1; f <= 5; f++) {
        videoMedia!.triggerRvfc(tau + (f / 30) * 1000, f / 30);
        raf?.(tau + (f / 30) * 1000);
      }
      expect(playback.getState().time.value).toBeCloseTo(5, 4);
      expect(videoMedia!.currentTime).toBeCloseTo(5 / 30, 3);

      playback.pause();
      expect(playback.getState().playing).toBe(false);

      const prevSeeks = videoMedia!.seekTargets.length;
      await playback.seek({ value: 0, rate: 30 });

      // Must record a new seek to mid(0) = 1/60
      expect(videoMedia!.seekTargets.length).toBeGreaterThan(prevSeeks);
      expect(
        videoMedia!.seekTargets[videoMedia!.seekTargets.length - 1]
      ).toBeCloseTo(1 / 60, 4);
      expect(outCanvas.pixel.r).toBe(0);
      expect(playback.getState().time.value).toBe(0);
    } finally {
      playback.dispose();
    }
  });
  test('regression 2b: rejectNextPlay plus first advanced delivered causes attempt 1 to seek mid(0) again and first approved pixel is 0', async () => {
    const mediaBlob = new Blob(['reg 2b video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });
      videoMedia!.advanceTo(0);

      // Reject next play on attempt 0 while unpausing so rvfc callback can register
      videoMedia!.play = function (this: MockMedia): Promise<void> {
        this.paused = false;
        if (this.rejectNextPlay) {
          this.rejectNextPlay = false;
          return Promise.reject(new Error('play-rejected'));
        }
        return Promise.resolve();
      };
      videoMedia!.rejectNextPlay = true;
      const playPromise = playback.play();

      // Wait for attempt 0 callback registration
      await waitForRvfc(videoMedia!);
      // Deliver first advanced for attempt 0 -> moves videoMedia to 1/30 (pixel.r = 1)
      videoMedia!.triggerRvfc(100, 1 / 30);

      // Yield to allow attempt 0 rejection to process and attempt 1 to begin
      for (let i = 0; i < 20; i++) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 5);
        await promise;
        if (
          videoMedia!.seekTargets.filter((t) => Math.abs(t - 1 / 60) < 1e-4)
            .length >= 2
        ) {
          break;
        }
      }

      const mid0Seeks = videoMedia!.seekTargets.filter(
        (t) => Math.abs(t - 1 / 60) < 1e-4
      );
      expect(mid0Seeks.length).toBeGreaterThanOrEqual(2);

      // Wait for attempt 1 callback registration
      await waitForRvfc(videoMedia!);
      // Deliver first advanced for attempt 1
      const d1 = 150;
      videoMedia!.triggerRvfc(d1, 1 / 30);
      await playPromise;
      expect(playback.getState().playing).toBe(true);

      const nu = 1 / 60;
      const wMin = minWindowDuration(timing, 1);
      const tau = d1 + ((nu + 2 * wMin) / 2 - (timing.starts[1]! - 0)) * 1000;

      // Tick at req = iL0 = 0 -> must approve pixel 0
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(tau + (0.1 / 30) * 1000);
      expect(outCanvas.pixel.r).toBe(0);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });
  test('regression 3: when first advanced tag is 2, the tick at the tau-correct wallFor(2.25) approves pixel 2', async () => {
    const mediaBlob = new Blob(['reg 3 video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });
      videoMedia!.advanceTo(0);

      // First advanced tag skips to tag 2
      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 2,
      });

      // Tick at tau-correct wallFor(2.25)
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(tau + (2.25 / 30) * 1000);
      expect(outCanvas.pixel.r).toBe(2);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });
  test('regression 4: two rejected plays force fallback: decoders paused, no callbacks registered, next render seeks', async () => {
    const mediaBlob = new Blob(['reg 4 video test'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.advanceTo(0);

      // Both attempt 0 and attempt 1 play() calls reject
      videoMedia!.play = function (this: MockMedia): Promise<void> {
        this.paused = false;
        return Promise.reject(new Error('play-rejected-unsupported'));
      };

      const playPromise = playback.play();

      // Attempt 0: wait for rvfc and trigger it
      await waitForRvfc(videoMedia!);
      videoMedia!.triggerRvfc(100, 1 / 30);

      // Attempt 1: wait for rvfc and trigger it
      for (let i = 0; i < 20; i++) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 5);
        await promise;
        if (videoMedia!.rvfcCallbacks.size > 0) break;
      }
      await waitForRvfc(videoMedia!);
      videoMedia!.triggerRvfc(150, 1 / 30);

      await playPromise;

      // Both attempts rejected: must fall back to seek cadence
      expect(videoMedia!.paused).toBe(true);
      expect(videoMedia!.rvfcCallbacks.size).toBe(0);

      // Next render in seek cadence must record a seek
      const prevSeeks = videoMedia!.seekTargets.length;
      raf?.(100);
      for (let k = 0; k < 5; k++) await Promise.resolve();
      raf?.(200);
      for (let k = 0; k < 5; k++) await Promise.resolve();
      expect(videoMedia!.seekTargets.length).toBeGreaterThan(prevSeeks);
    } finally {
      playback.dispose();
    }
  });
});

describe('VideoFrame readout (planner tests 1-6)', () => {
  const created: MockMedia[] = [];
  let raf: FrameRequestCallback | null = null;
  let originalGlobals = new Map<
    PlaybackGlobalKey,
    PropertyDescriptor | undefined
  >();
  let originalUrlMethods = new Map<
    UrlMethodName,
    PropertyDescriptor | undefined
  >();
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  beforeEach(() => {
    created.length = 0;
    createdUrls.length = 0;
    revokedUrls.length = 0;
    raf = null;
    MockVideoFrame.reset();
    originalGlobals = propertyDescriptors(globalThis, playbackGlobalKeys);
    originalUrlMethods = propertyDescriptors(URL, urlMethodNames);
    try {
      for (const [name, value] of [
        ['Image', MockMedia],
        ['Audio', MockMedia],
        ['AudioContext', MockAudioContext],
        ['VideoFrame', MockVideoFrame],
        [
          'document',
          {
            createElement: (tag: string) => {
              if (tag === 'canvas') return new SoftCanvas();
              if (tag === 'video' || tag === 'audio') {
                const media = new MockMedia();
                created.push(media);
                return media;
              }
              return hostElement();
            },
            body: hostElement(),
          },
        ],
        [
          'requestAnimationFrame',
          (cb: FrameRequestCallback) => {
            raf = cb;
            return 1;
          },
        ],
        [
          'cancelAnimationFrame',
          () => {
            raf = null;
          },
        ],
      ] as const) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => {
          const url = `blob:owned-${createdUrls.length}`;
          createdUrls.push(url);
          return url;
        },
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: (url: string) => {
          revokedUrls.push(url);
        },
      });
    } catch (error) {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
      throw error;
    }
  });

  afterEach(() => {
    try {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
    } finally {
      createdUrls.length = 0;
      revokedUrls.length = 0;
    }
  });

  test('1. The hazard: metadata says N while element is at N+1; slot tags N+1, tick N holds, tick N+1 shows N+1', async () => {
    const mediaBlob = new Blob(['hazard test video'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      // Initial state: frame 1 composite is showing
      raf?.(wallFor(1.2));
      expect(outCanvas.pixel.r).toBe(1);

      // Wait for next callback registration
      await waitForRvfc(videoMedia!);

      // The hazard: metadata reports frame 1 (N), but the element has already advanced to frame 2 (N+1)
      videoMedia!.advanceTo(2 / 30);
      const cbs = Array.from(videoMedia!.rvfcCallbacks.values());
      videoMedia!.rvfcCallbacks.clear();
      for (const cb of cbs) {
        cb(wallFor(2.0), { mediaTime: 1 / 30 });
      }

      // Tick requiring frame 1 (N) must HOLD (slot got tag N+1 with N+1 pixels, no tag 1)
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(wallFor(1.8));
      expect(outCanvas.pixel.r).toBe(1); // holds previous frame 1

      // Tick requiring frame 2 (N+1) shows frame 2 (N+1)
      outCanvas.ctx.drawnSources.length = 0;
      raf?.(wallFor(2.5));
      expect(outCanvas.pixel.r).toBe(2);
      expect(outCanvas.ctx.drawnSources.length).toBeGreaterThan(0);
    } finally {
      playback.dispose();
    }
  });
  test('2. Close accounting: constructions equal closes after match, uncovered, outside, stale epoch, and draw throws', () => {
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const budget = new SnapshotPixelBudget(3 * 960 * 540);
    const media = new MockMedia();
    media.enableRvfc();
    const ring = new NativeDecoderRing(
      media as unknown as HTMLVideoElement,
      'occ_close',
      'media/clip.mp4',
      budget
    );
    expect(ring.allocate(960, 540)).toBe(true);

    try {
      // 1. A match callback: exactly 1 construction, 1 close
      MockVideoFrame.reset();
      ring.resetEpoch(1);
      media.advanceTo(1 / 30);
      const matchOutcome = ring.readoutFrame(timing, 1);
      expect(matchOutcome.kind).toBe('match');
      expect(MockVideoFrame.constructions).toBe(1);
      expect(MockVideoFrame.closes).toBe(1);

      // 2. An uncovered callback: exactly 1 construction, 1 close
      MockVideoFrame.reset();
      media.advanceTo(0.015);
      const uncoveredOutcome = ring.readoutFrame(timing, 1);
      expect(uncoveredOutcome.kind).toBe('uncovered');
      expect(MockVideoFrame.constructions).toBe(1);
      expect(MockVideoFrame.closes).toBe(1);

      // 3. An outside callback: exactly 1 construction, 1 close
      MockVideoFrame.reset();
      media.advanceTo(5.0);
      const outsideOutcome = ring.readoutFrame(timing, 1);
      expect(outsideOutcome.kind).toBe('outside');
      expect(MockVideoFrame.constructions).toBe(1);
      expect(MockVideoFrame.closes).toBe(1);

      // 4. A stale epoch: callback ignored, 0 constructions, 0 closes
      MockVideoFrame.reset();
      ring.resetEpoch(1);
      ring.startCallbacks(timing, 1, () => {});
      ring.resetEpoch(2); // Stale epoch: currentEpoch is now 2
      media.triggerRvfc(100, 1 / 30);
      expect(MockVideoFrame.constructions).toBe(0);
      expect(MockVideoFrame.closes).toBe(0);

      // 5. A draw that throws: 1 construction, 1 close in finally
      MockVideoFrame.reset();
      ring.resetEpoch(3);
      media.advanceTo(2 / 30);
      const throwingSlot = ring.slots[0];
      expect(throwingSlot).toBeDefined();
      const origDraw = throwingSlot!.ctx!.drawImage;
      throwingSlot!.ctx!.drawImage = () => {
        throw new Error('draw error');
      };
      try {
        const drawThrowsOutcome = ring.readoutFrame(timing, 3);
        expect(drawThrowsOutcome.kind).toBe('readout-failed');
        expect(MockVideoFrame.constructions).toBe(1);
        expect(MockVideoFrame.closes).toBe(1);
      } finally {
        throwingSlot!.ctx!.drawImage = origDraw;
      }
    } finally {
      ring.release();
    }
  });

  test('3. Draw throws: the slot stays untagged and the frame holds', async () => {
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const budget = new SnapshotPixelBudget(3 * 960 * 540);
    const media = new MockMedia();
    media.enableRvfc();
    const ring = new NativeDecoderRing(
      media as unknown as HTMLVideoElement,
      'occ_draw_throws',
      'media/clip.mp4',
      budget
    );
    expect(ring.allocate(960, 540)).toBe(true);
    ring.resetEpoch(1);

    const slot = ring.slots[0];
    expect(slot).toBeDefined();
    const origDraw = slot!.ctx!.drawImage;
    slot!.ctx!.drawImage = () => {
      throw new Error('simulated drawImage error');
    };

    try {
      media.advanceTo(1 / 30);
      const outcome = ring.readoutFrame(timing, 1);
      expect(outcome.kind).toBe('readout-failed');
      // Slot must remain untagged
      expect(slot!.tag).toBeNull();
      expect(slot!.epoch).toBe(-1);
      expect(ring.findSlotWithTag(1, 1)).toBeNull();
    } finally {
      slot!.ctx!.drawImage = origDraw;
      ring.release();
    }
  });

  test('4. Constructor throws twice: path becomes permanently ineligible and drops to seek cadence', async () => {
    const mediaBlob = new Blob(['throw twice video'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / 30) * 1000;

      // Now simulate VideoFrame constructor throwing repeatedly
      MockVideoFrame.throwInConstructor = true;

      // First callback fails: consecutiveUncovered becomes 1
      await waitForRvfc(videoMedia!);
      videoMedia!.triggerRvfc(wallFor(2.0), 2 / 30);

      // Second callback fails: consecutiveUncovered reaches 2 -> permanently ineligible
      await waitForRvfc(videoMedia!);
      videoMedia!.triggerRvfc(wallFor(3.0), 3 / 30);

      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Path is permanently dropped to seek cadence, decoders paused, rvfc cleared
      expect(videoMedia!.paused).toBe(true);
      expect(videoMedia!.rvfcCallbacks.size).toBe(0);
      expect(playback.getState().playing).toBe(true);
    } finally {
      MockVideoFrame.throwInConstructor = false;
      playback.dispose();
    }
  });

  test('5. No VideoFrame global: zero snapshot draws, and seeks stay exact', async () => {
    const mediaBlob = new Blob(['no VideoFrame video'], { type: 'video/mp4' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    // Remove VideoFrame from global scope
    const globalScope = globalThis as { VideoFrame?: unknown };
    delete globalScope.VideoFrame;
    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * 30 + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });

      await playback.play();
      expect(playback.getState().playing).toBe(true);
      // Because VideoFrame is missing, native mode is not used; no rvfc registered
      expect(videoMedia!.rvfcCallbacks.size).toBe(0);

      // Zero attempts or retries in nativeMode: exactly 1 initial seek, no retry re-renders
      const mid0Seeks = videoMedia!.seekTargets.filter(
        (t) => Math.abs(t - 1 / 60) < 1e-4
      );
      expect(mid0Seeks).toHaveLength(1);
      await playback.seek({ value: 5, rate: 30 });
      expect(playback.getState().time.value).toBe(5);
      expect(outCanvas.pixel.r).toBe(5);

      await playback.seek({ value: 12, rate: 30 });
      expect(playback.getState().time.value).toBe(12);
      expect(outCanvas.pixel.r).toBe(12);
    } finally {
      playback.dispose();
    }
  });

  test('6. Paused readout mismatch: attempt fails, T0 re-rendered, second mismatch falls back to seek cadence', async () => {
    const mediaBlob = new Blob(['paused mismatch video'], {
      type: 'video/mp4',
    });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();

      // Mismatch timestamp override during paused capture (says frame 5 instead of frame 0)
      MockVideoFrame.reset();
      MockVideoFrame.timestampOverride = (5 * 1000000) / 30;

      await playback.play();
      expect(playback.getState().playing).toBe(true);

      // Attempt 0 failed and attempt 1 retried: exactly 2 VideoFrame constructions occurred
      expect(MockVideoFrame.constructions).toBe(2);

      // Both attempts failed: falls back to seek cadence, decoders paused, 0 callbacks
      expect(videoMedia!.paused).toBe(true);
      expect(videoMedia!.rvfcCallbacks.size).toBe(0);

      // Subsequent ticks run in seek cadence and trigger seeks
      const initialSeeks = videoMedia!.seekTargets.length;
      raf?.(100);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      raf?.(200);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(videoMedia!.seekTargets.length).toBeGreaterThan(initialSeeks);
    } finally {
      MockVideoFrame.timestampOverride = null;
      playback.dispose();
    }
  });
});

describe('otio native playback regressions 5-9, clock and capability gate', () => {
  const created: MockMedia[] = [];
  let raf: FrameRequestCallback | null = null;
  let originalGlobals = new Map<
    PlaybackGlobalKey,
    PropertyDescriptor | undefined
  >();
  let originalUrlMethods = new Map<
    UrlMethodName,
    PropertyDescriptor | undefined
  >();
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  beforeEach(() => {
    created.length = 0;
    createdUrls.length = 0;
    revokedUrls.length = 0;
    raf = null;
    MockVideoFrame.reset();
    originalGlobals = propertyDescriptors(globalThis, playbackGlobalKeys);
    originalUrlMethods = propertyDescriptors(URL, urlMethodNames);
    try {
      for (const [name, value] of [
        ['Image', MockMedia],
        ['Audio', MockMedia],
        ['AudioContext', MockAudioContext],
        ['VideoFrame', MockVideoFrame],
        [
          'document',
          {
            createElement: (tag: string) => {
              if (tag === 'canvas') return new SoftCanvas();
              if (tag === 'video' || tag === 'audio') {
                const media = new MockMedia();
                created.push(media);
                return media;
              }
              return hostElement();
            },
            body: hostElement(),
          },
        ],
        [
          'requestAnimationFrame',
          (cb: FrameRequestCallback) => {
            raf = cb;
            return 1;
          },
        ],
        [
          'cancelAnimationFrame',
          () => {
            raf = null;
          },
        ],
      ] as const) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => {
          const url = `blob:owned-${createdUrls.length}`;
          createdUrls.push(url);
          return url;
        },
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: (url: string) => {
          revokedUrls.push(url);
        },
      });
    } catch {
      // Ignore definition errors
    }
  });

  afterEach(() => {
    try {
      restorePlaybackEnvironment(originalGlobals, originalUrlMethods);
    } finally {
      createdUrls.length = 0;
      revokedUrls.length = 0;
    }
  });

  test('clock: when a drawn-set resync fires, state.time equals the T0 that was painted', async () => {
    const rate = 24;
    const timingA: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 48 }, (_, i) => i / rate),
      ends: Float64Array.from({ length: 48 }, (_, i) => (i + 1) / rate),
    };
    const timingB: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 48 }, (_, i) => i / rate),
      ends: Float64Array.from({ length: 48 }, (_, i) => (i + 1) / rate),
    };
    const blobA = new Blob(['clip A'], { type: 'video/mp4' });
    const blobB = new Blob(['clip B'], { type: 'video/mp4' });
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/clipA.mp4', blobA],
        ['media/clipB.mp4', blobB],
      ]),
      timings: new Map([
        [blobA, timingA],
        [blobB, timingB],
      ]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const time = (value: number) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate,
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_1' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_v' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_a' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(48),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipA.mp4',
                  },
                },
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_b' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(48),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipB.mp4',
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate });
      const videoA = created.find((m) => m.src.includes('media/clipA.mp4'));
      expect(videoA).toBeDefined();
      videoA!.enableRvfc();
      videoA!.pixelAt = () => ({ r: 10, g: 0, b: 0, a: 1 });
      videoA!.advanceTo(0);

      const tau = await startNative(playback, videoA!, timingA, {
        d1: 100,
        tag: 1,
        rL: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / rate) * 1000;

      // Tick at frame 47 on Clip A
      videoA!.triggerRvfc(wallFor(47), 47 / rate);
      raf?.(wallFor(47));
      expect(playback.getState().time.value).toBeCloseTo(47, 3);

      let timeAtResyncNotification: number | null = null;
      let bufferingAtResync = false;
      const unsub = playback.subscribe((state) => {
        if (state.buffering && timeAtResyncNotification === null) {
          timeAtResyncNotification = state.time.value;
          bufferingAtResync = state.buffering;
        }
      });

      // Tick at frame 48 -> enters Clip B, triggering drawn-set resync
      raf?.(wallFor(48));

      // The buffering notification fires before the exact paint, so it still
      // reports the time of the frame on screen.
      expect(bufferingAtResync).toBe(true);
      expect(timeAtResyncNotification).toBeCloseTo(47, 4);
      for (let k = 0; k < 20; k++) await Promise.resolve();
      // The exact paint publishes the new time together with the canvas.
      expect(playback.getState().time.value).toBeCloseTo(48, 4);
      unsub();
    } finally {
      playback.dispose();
    }
  });
  test('capability gate: with no VideoFrame global, native path never calls play() on decoder and playback is not held in buffering for startup timeout', async () => {
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / 30),
    };
    const mediaBlob = new Blob(['cap gate video test'], { type: 'video/mp4' });
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const doc = sampledMediaDocument({
      kind: 'Video',
      rate: 30,
      duration: 60,
    });

    delete (globalThis as { VideoFrame?: unknown }).VideoFrame;

    const origCapturePausedFrame =
      NativeDecoderRing.prototype.capturePausedFrame;
    let capturePausedFrameCalled = false;
    NativeDecoderRing.prototype.capturePausedFrame = () => {
      capturePausedFrameCalled = true;
      return true;
    };

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate: 30 });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();

      let playCalled = false;
      const originalPlay = videoMedia!.play;
      videoMedia!.play = function (this: MockMedia) {
        playCalled = true;
        return originalPlay.call(this);
      };

      const playStart = Date.now();
      await playback.play();
      const playDuration = Date.now() - playStart;

      expect(capturePausedFrameCalled).toBe(false);
      expect(playCalled).toBe(false);
      expect(playback.getState().buffering).toBe(false);
      expect(playDuration).toBeLessThan(250);
    } finally {
      NativeDecoderRing.prototype.capturePausedFrame = origCapturePausedFrame;
      playback.dispose();
    }
  });

  test('regression 5: clip, gap, clip runs native, then seek cadence at gap, then native again ending with approved pixel from clip B', async () => {
    const rate = 30;
    const timingA: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 30 }, (_, i) => i / rate),
      ends: Float64Array.from({ length: 30 }, (_, i) => (i + 1) / rate),
    };
    const timingB: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 30 }, (_, i) => i / rate),
      ends: Float64Array.from({ length: 30 }, (_, i) => (i + 1) / rate),
    };
    const blobA = new Blob(['clip A 5'], { type: 'video/mp4' });
    const blobB = new Blob(['clip B 5'], { type: 'video/mp4' });
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/clipA.mp4', blobA],
        ['media/clipB.mp4', blobB],
      ]),
      timings: new Map([
        [blobA, timingA],
        [blobB, timingB],
      ]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const time = (value: number) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate,
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_1' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_v' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_a' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(30),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipA.mp4',
                  },
                },
                {
                  OTIO_SCHEMA: 'Gap.1',
                  metadata: { relic: { id: 'gap_1' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(10),
                  },
                },
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_b' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(30),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipB.mp4',
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });
    const origCreate = document.createElement;
    document.createElement = (tag: string) => {
      const el = origCreate.call(document, tag);
      if (tag === 'video') {
        const media = el as unknown as MockMedia;
        media.enableRvfc();
        media.pixelAt = (s) => ({
          r:
            (media.src.includes('clipB') ? 200 : 100) +
            Math.floor(s * rate + 1e-4),
          g: 0,
          b: 0,
          a: 1,
        });
      }
      return el;
    };

    try {
      await playback.seek({ value: 0, rate });
      const videoA = created.find((m) => m.src.includes('media/clipA.mp4'));
      expect(videoA).toBeDefined();
      videoA!.advanceTo(0);

      const tau = await startNative(playback, videoA!, timingA, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / rate) * 1000;

      // Native playback on Clip A: tick at frame 10 approves pixel 110
      videoA!.triggerRvfc(wallFor(10), 10 / rate);
      raf?.(wallFor(10));
      expect(outCanvas.pixel.r).toBe(110);
      expect(videoA!.rvfcCallbacks.size).toBeGreaterThan(0);

      // Tick at frame 32 (gap): drawn-set changed to empty, drops to seek cadence
      raf?.(wallFor(32));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(videoA!.paused).toBe(true);
      expect(videoA!.rvfcCallbacks.size).toBe(0);

      // Seek cadence ticks advance playhead through the gap into Clip B
      for (let f = 33; f <= 43; f++) {
        raf?.(wallFor(f));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }

      const videoB = created.find((m) => m.src.includes('media/clipB.mp4'));
      expect(videoB).toBeDefined();
      // Wait for rvfc callback registration on Clip B (native returned!)
      await waitForRvfc(videoB!);
      expect(videoB!.rvfcCallbacks.size).toBeGreaterThan(0);

      // Trigger first advanced rvfc on Clip B
      videoB!.triggerRvfc(wallFor(43), 1 / rate);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Native tick on Clip B approves pixel from Clip B (>= 200)
      videoB!.triggerRvfc(wallFor(44), 2 / rate);
      raf?.(wallFor(44));
      expect(outCanvas.pixel.r).toBeGreaterThanOrEqual(200);
    } finally {
      document.createElement = origCreate;
      playback.dispose();
    }
  });
  test('regression 6: audio stays paused while start is pending and plays within 2 frames of audio source time at first approved tick', async () => {
    const rate = 30;
    const duration = 60;
    const doc = sampledAvDocument({ rate, duration });
    const videoBlob = new Blob(['reg 6 video'], { type: 'video/mp4' });
    const audioBlob = new Blob(['reg 6 audio'], { type: 'audio/wav' });
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: duration }, (_, i) => i / rate),
      ends: Float64Array.from({ length: duration }, (_, i) => (i + 1) / rate),
    };
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/clip.mp4', videoBlob],
        ['media/dialogue.wav', audioBlob],
      ]),
      timings: new Map([[videoBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      const audioMedia = created.find((m) =>
        m.src.includes('media/dialogue.wav')
      );
      expect(videoMedia).toBeDefined();
      expect(audioMedia).toBeDefined();

      videoMedia!.enableRvfc();
      videoMedia!.advanceTo(0);

      const playPromise = playback.play();
      await waitForRvfc(videoMedia!);

      // Audio stays paused while start is pending
      expect(audioMedia!.paused).toBe(true);

      // Deliver first advanced rvfc to complete start
      videoMedia!.triggerRvfc(100, 1 / rate);
      await playPromise;

      const nu = 1 / 60;
      const wMin = minWindowDuration(timing, 1);
      const tau = 100 + ((nu + 2 * wMin) / 2 - 1 / rate) * 1000;
      const wallFor = (frame: number): number => tau + (frame / rate) * 1000;

      videoMedia!.triggerRvfc(wallFor(1.0), 1 / rate);

      // First approved tick
      raf?.(wallFor(1.5));
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Audio must play and be within 2 frames of audio source time
      expect(audioMedia!.paused).toBe(false);
      const expectedAudioTime = 1.5 / rate;
      const twoFramesTolerance = 2 / rate;
      expect(
        Math.abs(audioMedia!.currentTime - expectedAudioTime)
      ).toBeLessThanOrEqual(twoFramesTolerance);
    } finally {
      playback.dispose();
    }
  });

  test('regression 7: 0.25x speed on 30 fps windows and 500 ms VFR window: 1 s of consistent ticks with zero resyncs', async () => {
    const rate = 30;
    // Starts: 15 frames at 30fps (0..0.5s), 1 frame 500ms VFR (0.5..1.0s), 15 frames at 30fps (1.0..1.5s)
    const startsList: number[] = [];
    const endsList: number[] = [];
    for (let i = 0; i < 15; i++) {
      startsList.push(i / rate);
      endsList.push((i + 1) / rate);
    }
    // VFR window of 500ms
    startsList.push(15 / rate);
    endsList.push(15 / rate + 0.5);
    // Subsequent 30fps windows
    for (let i = 0; i < 15; i++) {
      startsList.push(15 / rate + 0.5 + i / rate);
      endsList.push(15 / rate + 0.5 + (i + 1) / rate);
    }
    const timing: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from(startsList),
      ends: Float64Array.from(endsList),
    };

    const mediaBlob = new Blob(['reg 7 video'], { type: 'video/mp4' });
    const fixture = timingMediaFixture({
      blobs: new Map([['media/clip.mp4', mediaBlob]]),
      timings: new Map([[mediaBlob, timing]]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const time = (value: number) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate,
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_1' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_v' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_warp' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(120),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clip.mp4',
                  },
                  effects: [
                    {
                      OTIO_SCHEMA: 'LinearTimeWarp.1',
                      name: 'LinearTimeWarp',
                      time_scalar: 0.25,
                      enabled: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      })
    );

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate });
      const videoMedia = created.find((m) => m.src.includes('media/clip.mp4'));
      expect(videoMedia).toBeDefined();
      videoMedia!.enableRvfc();
      videoMedia!.pixelAt = (s) => ({
        r: Math.floor(s * rate + 1e-4),
        g: 0,
        b: 0,
        a: 1,
      });
      videoMedia!.advanceTo(0);

      const tau = await startNative(playback, videoMedia!, timing, {
        d1: 100,
        tag: 1,
        rL: 0.25,
      });

      let resyncCount = 0;
      playback.subscribe((state) => {
        if (state.buffering) resyncCount++;
      });

      // Run 1s of consistent ticks at 60Hz (60 ticks, 16.67ms each)
      let lastTag = -1;
      for (let tick = 1; tick <= 60; tick++) {
        const now = tau + (tick * 1000) / 60;
        const sourceTime = (tick / 60) * 0.25;
        let tag = 0;
        for (let i = 0; i < timing.starts.length; i++) {
          if ((timing.starts[i] ?? 0) <= sourceTime + 1e-6) tag = i;
        }
        if (tag !== lastTag) {
          lastTag = tag;
          videoMedia!.triggerRvfc(now, timing.starts[tag] ?? 0);
        }
        raf?.(now);
      }

      expect(resyncCount).toBe(0);
      expect(playback.getState().playing).toBe(true);
      expect(playback.getState().buffering).toBe(false);
    } finally {
      playback.dispose();
    }
  });

  test('regression 8: 1920x1080 output, 6 clips scrubbed while paused, then play on clip 6: a frame callback registers; rings only for drawn leaves, budget', async () => {
    const rate = 30;
    const numClips = 6;
    const clipBlobs: Blob[] = [];
    const blobsMap = new Map<string, Blob>();
    const timingsMap = new Map<Blob, OtioVideoTiming>();
    const children: Record<string, unknown>[] = [];

    const time = (value: number) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate,
    });

    for (let c = 0; c < numClips; c++) {
      const blob = new Blob([`clip ${c}`], { type: 'video/mp4' });
      clipBlobs.push(blob);
      const url = `media/clip${c}.mp4`;
      blobsMap.set(url, blob);
      const timing: OtioVideoTiming = {
        kind: 'windows',
        starts: Float64Array.from({ length: 30 }, (_, i) => i / rate),
        ends: Float64Array.from({ length: 30 }, (_, i) => (i + 1) / rate),
      };
      timingsMap.set(blob, timing);
      children.push({
        OTIO_SCHEMA: 'Clip.1',
        metadata: { relic: { id: `clip_${c}` } },
        source_range: {
          OTIO_SCHEMA: 'TimeRange.1',
          start_time: time(0),
          duration: time(10),
        },
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: url,
        },
      });
    }

    const fixture = timingMediaFixture({
      blobs: blobsMap,
      timings: timingsMap,
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 1920;
    outCanvas.height = 1080;

    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_1' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_v' } },
              kind: 'Video',
              children,
            },
          ],
        },
      })
    );

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      // Scrub while paused across all 6 clips
      for (let c = 0; c < numClips; c++) {
        await playback.seek({ value: c * 10 + 5, rate });
      }

      // Clip 6 is at frame 55 (the active clip)
      const clip6Media = created.find((m) => m.src.includes('media/clip5.mp4'));
      expect(clip6Media).toBeDefined();
      clip6Media!.enableRvfc();
      clip6Media!.advanceTo(5 / rate);

      // Play on clip 6: native ring is allocated within budget because only drawn leaves get rings
      const playPromise = playback.play();
      await waitForRvfc(clip6Media!);

      // Frame callback registers successfully
      expect(clip6Media!.rvfcCallbacks.size).toBeGreaterThan(0);
      clip6Media!.triggerRvfc(100, 6 / rate);
      await playPromise;
      expect(playback.getState().playing).toBe(true);
    } finally {
      playback.dispose();
    }
  });

  test('regression 9: hidden track clip with missing media enters mid-run: missing-media diagnostic appears without a discontinuity', async () => {
    const rate = 30;
    const timingA: OtioVideoTiming = {
      kind: 'windows',
      starts: Float64Array.from({ length: 60 }, (_, i) => i / rate),
      ends: Float64Array.from({ length: 60 }, (_, i) => (i + 1) / rate),
    };
    const blobA = new Blob(['clip A 9'], { type: 'video/mp4' });
    const blobMissing = new Blob(['clip missing 9'], { type: 'video/mp4' });
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/clipA.mp4', blobA],
        ['media/missing.mp4', blobMissing],
      ]),
      timings: new Map([
        [blobA, timingA],
        [blobMissing, timingA],
      ]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const time = (value: number) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate,
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_1' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_visible' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_a' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(60),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipA.mp4',
                  },
                },
              ],
            },
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_hidden' } },
              kind: 'Video',
              enabled: false,
              children: [
                {
                  OTIO_SCHEMA: 'Gap.1',
                  metadata: { relic: { id: 'gap_h' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(30),
                  },
                },
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_missing' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0),
                    duration: time(30),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/missing.mp4',
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });
    const origCreate = document.createElement;
    document.createElement = (tag: string) => {
      const el = origCreate.call(document, tag);
      if (tag === 'video') {
        const media = el as unknown as MockMedia;
        const desc = Object.getOwnPropertyDescriptor(
          MockMedia.prototype,
          'src'
        );
        Object.defineProperty(media, 'src', {
          set(val: string) {
            desc?.set?.call(this, val);
            if (val.includes('missing')) {
              Object.defineProperty(this, 'currentTime', {
                set() {
                  throw new Error('Unplayable media');
                },
                get() {
                  return 0;
                },
              });
            }
          },
          get() {
            return desc?.get?.call(this);
          },
        });
      }
      return el;
    };

    try {
      await playback.seek({ value: 0, rate });
      const videoA = created.find((m) => m.src.includes('media/clipA.mp4'));
      expect(videoA).toBeDefined();
      videoA!.enableRvfc();
      videoA!.pixelAt = () => ({ r: 77, g: 0, b: 0, a: 1 });
      videoA!.advanceTo(0);

      const tau = await startNative(playback, videoA!, timingA, {
        d1: 100,
        tag: 1,
      });
      const wallFor = (frame: number): number => tau + (frame / rate) * 1000;

      // Frame 10: visible clip plays, hidden clip has not entered, no missing-media
      videoA!.triggerRvfc(wallFor(10), 10 / rate);
      raf?.(wallFor(10));
      expect(outCanvas.pixel.r).toBe(77);
      expect(
        playback.getState().diagnostics.some((d) => d.code === 'missing-media')
      ).toBe(false);

      // Frame 35: hidden clip with missing media enters mid-run
      videoA!.triggerRvfc(wallFor(35), 35 / rate);
      raf?.(wallFor(35));
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // Diagnostic appears
      expect(
        playback.getState().diagnostics.some((d) => d.code === 'missing-media')
      ).toBe(true);

      // Native playback continues without discontinuity (playing stays true, buffering false, decoder not paused)
      expect(playback.getState().playing).toBe(true);
      expect(playback.getState().buffering).toBe(false);
      expect(videoA!.paused).toBe(false);
      expect(outCanvas.pixel.r).toBe(77);
    } finally {
      document.createElement = origCreate;
      playback.dispose();
    }
  });

  test('watchdog: two native videos with alternating missing tags do not freeze without resync', async () => {
    const rate = 24;
    const timingA: Extract<OtioVideoTiming, { kind: 'windows' }> = {
      kind: 'windows',
      starts: Float64Array.from({ length: 120 }, (_, i) => i / 24),
      ends: Float64Array.from({ length: 120 }, (_, i) => (i + 1) / 24),
    };
    const timingB: Extract<OtioVideoTiming, { kind: 'windows' }> = {
      kind: 'windows',
      starts: Float64Array.from({ length: 150 }, (_, i) => i / 30),
      ends: Float64Array.from({ length: 150 }, (_, i) => (i + 1) / 30),
    };
    const blobA = new Blob(['clip A'], { type: 'video/mp4' });
    const blobB = new Blob(['clip B'], { type: 'video/mp4' });
    const fixture = timingMediaFixture({
      blobs: new Map([
        ['media/clipA.mp4', blobA],
        ['media/clipB.mp4', blobB],
      ]),
      timings: new Map([
        [blobA, timingA],
        [blobB, timingB],
      ]),
    });

    const outCanvas = new SoftCanvas();
    outCanvas.width = 960;
    outCanvas.height = 540;

    const time = (value: number, r: number = rate) => ({
      OTIO_SCHEMA: 'RationalTime.1',
      value,
      rate: r,
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline_1' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: { relic: { id: 'stack_1' } },
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_v_a' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_a' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0, 24),
                    duration: time(120, 24),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipA.mp4',
                  },
                },
              ],
            },
            {
              OTIO_SCHEMA: 'Track.1',
              metadata: { relic: { id: 'track_v_b' } },
              kind: 'Video',
              children: [
                {
                  OTIO_SCHEMA: 'Clip.1',
                  metadata: { relic: { id: 'clip_b' } },
                  source_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: time(0, 30),
                    duration: time(150, 30),
                  },
                  media_reference: {
                    OTIO_SCHEMA: 'ExternalReference.1',
                    target_url: 'media/clipB.mp4',
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas: outCanvas as unknown as HTMLCanvasElement,
      resolveMedia: fixture.resolver,
      readVideoTiming: fixture.readVideoTiming,
    });

    try {
      await playback.seek({ value: 0, rate });
      const videoA = created.find((m) => m.src.includes('media/clipA.mp4'));
      const videoB = created.find((m) => m.src.includes('media/clipB.mp4'));
      expect(videoA).toBeDefined();
      expect(videoB).toBeDefined();
      videoA!.enableRvfc();
      videoB!.enableRvfc();
      videoA!.advanceTo(0);
      videoB!.advanceTo(0);

      let bufferingCount = 0;
      playback.subscribe((state) => {
        if (state.buffering) bufferingCount++;
      });
      let pauseCount = 0;
      const origPauseA = videoA!.pause.bind(videoA);
      videoA!.pause = () => {
        pauseCount++;
        origPauseA();
      };
      const origPauseB = videoB!.pause.bind(videoB);
      videoB!.pause = () => {
        pauseCount++;
        origPauseB();
      };

      const playPromise = playback.play();
      await waitForRvfc(videoA!);
      await waitForRvfc(videoB!);

      const d1 = 100;
      const vsync = 1 / 60;
      const wMinA = minWindowDuration(timingA, 1);
      const wMinB = minWindowDuration(timingB, 1);
      const deltaSecA = (vsync + 2 * wMinA) / 2 - (timingA.starts[1] ?? 0);
      const deltaSecB = (vsync + 2 * wMinB) / 2 - (timingB.starts[1] ?? 0);
      const d1_B = d1 + (deltaSecA - deltaSecB) * 1000;

      videoA!.triggerRvfc(d1, timingA.starts[1] ?? 1 / 24);
      videoB!.triggerRvfc(d1_B, timingB.starts[1] ?? 1 / 30);
      await playPromise;

      const tauStar = d1 + deltaSecA * 1000;
      const startWall = tauStar + 100;

      let lastProgressWallMs = startWall;
      let lastTimeValue = playback.getState().time.value;
      let initialSeeksA = videoA!.seekTargets.length;
      let initialSeeksB = videoB!.seekTargets.length;
      let initialPauseCount = pauseCount;
      let initialBufferingCount = bufferingCount;

      for (let tick = 1; tick <= 30; tick++) {
        const now = startWall + tick * 40;
        const elapsedSec = (now - tauStar) / 1000;
        const reqA = certifiedWindowIndex(
          { value: elapsedSec * 24, rate: 24 },
          timingA
        );
        const reqB = certifiedWindowIndex(
          { value: elapsedSec * 30, rate: 30 },
          timingB
        );

        if (tick % 2 === 1) {
          videoA!.triggerRvfc(now, timingA.starts[reqA ?? 0] ?? 0);
          videoB!.triggerRvfc(
            now,
            timingB.starts[Math.max(0, (reqB ?? 0) - 1)] ?? 0
          );
        } else {
          videoB!.triggerRvfc(now, timingB.starts[reqB ?? 0] ?? 0);
          videoA!.triggerRvfc(
            now,
            timingA.starts[Math.max(0, (reqA ?? 0) - 1)] ?? 0
          );
        }

        raf?.(now);
        for (let k = 0; k < 25; k++) await Promise.resolve();

        const state = playback.getState();
        const currentTimeValue = state.time.value;
        const currentSeeksA = videoA!.seekTargets.length;
        const currentSeeksB = videoB!.seekTargets.length;
        const timeAdvanced = currentTimeValue > lastTimeValue;
        const resyncOccurred =
          state.buffering ||
          bufferingCount > initialBufferingCount ||
          pauseCount > initialPauseCount ||
          currentSeeksA > initialSeeksA ||
          currentSeeksB > initialSeeksB;
        if (timeAdvanced || resyncOccurred) {
          lastProgressWallMs = now;
          lastTimeValue = currentTimeValue;
          initialBufferingCount = bufferingCount;
          initialPauseCount = pauseCount;
          initialSeeksA = currentSeeksA;
          initialSeeksB = currentSeeksB;
        }
        const stretch = now - lastProgressWallMs;
        if (stretch > 150) {
          throw new Error(
            `native playback presented nothing and did not resync for ${stretch} ms`
          );
        }
      }
    } finally {
      playback.dispose();
    }
  });
});
