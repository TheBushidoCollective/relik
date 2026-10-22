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
  type OtioPreparedLeaf,
  type OtioVideoCompositionTree,
  renderOtioVideoTree,
} from '../src/otio-playback.ts';
import type {
  OtioVideoTiming,
  readOtioVideoTiming,
} from '../src/otio-video-timing.ts';

type ReadVideoTiming = typeof readOtioVideoTiming;

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
  readonly ctx = new SoftContext(this);

  getContext(kind: string): SoftContext | null {
    return kind === '2d' ? this.ctx : null;
  }
}

class SoftContext {
  fillStyle = '#000000';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';

  constructor(private readonly canvas: SoftCanvas) {}

  clearRect(): void {
    this.canvas.pixel = { r: 0, g: 0, b: 0, a: 0 };
  }

  fillRect(): void {
    this.blend({ ...parseColor(this.fillStyle), a: 1 });
  }

  drawImage(source: { pixel: Pixel }): void {
    this.blend(source.pixel);
  }

  private blend(src: Pixel): void {
    const srcA = clamp(src.a * this.globalAlpha);
    const dst = this.canvas.pixel;
    if (this.globalCompositeOperation === 'lighter') {
      this.canvas.pixel = {
        r: clamp(dst.r + src.r * srcA),
        g: clamp(dst.g + src.g * srcA),
        b: clamp(dst.b + src.b * srcA),
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
    queueMicrotask(() => {
      this.readyState = 2;
      this.dispatch('seeked');
      this.dispatch('loadeddata');
    });
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
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
    await playback.play();
    const seek = playback.seek({ value: 12, rate: 24 });
    await clipStarted.promise;
    raf?.(8000);
    const resolveFirst = pending[0];
    if (resolveFirst === undefined)
      throw new Error('clip resolver did not start');
    resolveFirst('blob:dialogue');
    await seek;
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
});
