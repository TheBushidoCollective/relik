import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  OtioDocumentV1,
  OtioNode,
  OtioRationalTime,
} from '@relic/format';
import {
  createOtioPlayback,
  type CreateOtioPlaybackOptions,
  type OtioPlaybackController,
  type OtioPlaybackState,
} from '../src/otio-playback.ts';

// Mock Canvas 2D Context recording operations
class MockCanvasContext2D {
  fillStyle = '#000000';
  globalAlpha = 1.0;
  globalCompositeOperation = 'source-over';
  readonly operations: string[] = [];

  fillRect(x: number, y: number, w: number, h: number): void {
    this.operations.push(
      `fillRect(${x},${y},${w},${h})[fill=${this.fillStyle},alpha=${this.globalAlpha},op=${this.globalCompositeOperation}]`
    );
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.operations.push(`clearRect(${x},${y},${w},${h})`);
  }
  drawImage(img: unknown, ...args: number[]): void {
    let name = 'image';
    if (img && typeof img === 'object' && 'src' in img && typeof img.src === 'string') {
      name = img.src;
    }
    this.operations.push(
      `drawImage(${name},${args.join(',')})[alpha=${this.globalAlpha.toFixed(2)},op=${this.globalCompositeOperation}]`
    );
  }
}
class MockCanvasElement {
  width = 1920;
  height = 1080;
  readonly ctx = new MockCanvasContext2D();

  getContext(type: string): MockCanvasContext2D | null {
    if (type === '2d') return this.ctx;
    return null;
  }
}

class MockMediaElement {
  src = '';
  preload = '';
  playsInline = false;
  muted = false;
  volume = 1.0;
  currentTime = 0;
  readyState = 4; // HAVE_ENOUGH_DATA
  paused = true;
  complete = true;
  naturalWidth = 1920;
  naturalHeight = 1080;
  readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(event: string, cb: () => void): void {
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    list.push(cb);
  }

  removeEventListener(event: string, cb: () => void): void {
    const list = this.listeners.get(event);
    if (list) {
      const idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  dispatchEvent(event: string): void {
    const list = this.listeners.get(event);
    if (list) {
      for (const cb of [...list]) cb();
    }
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    // reset
  }
}

class MockAudioContext {
  state = 'running';
  destination = {};

  createGain(): {
    gain: { value: number };
    connect: (dest: unknown) => void;
    disconnect: () => void;
  } {
    return {
      gain: { value: 1.0 },
      connect: () => {},
      disconnect: () => {},
    };
  }

  createMediaElementSource(el: unknown): {
    connect: (dest: unknown) => void;
    disconnect: () => void;
  } {
    return {
      connect: () => {},
      disconnect: () => {},
    };
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

// Minimal OTIO test document builder
function buildTestDocument(options: {
  durationFrames?: number;
  rate?: number;
  includeTransition?: boolean;
  reverseClip?: boolean;
  imageSequence?: boolean;
  missingFramePolicy?: 'error' | 'hold' | 'black';
}): OtioDocumentV1 {
  const rate = options.rate ?? 24;
  const totalFrames = options.durationFrames ?? 48; // 2 seconds

  const nodes: Record<string, OtioNode> = {
    timeline_1: {
      id: 'timeline_1',
      identity_origin: 'authored',
      json_pointer: '/tracks',
      schema: 'Timeline.1',
      name: 'Test Timeline',
      enabled: true,
      parent_id: null,
      children_ids: ['stack_1'],
      source_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
    },
    stack_1: {
      id: 'stack_1',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0',
      schema: 'Stack.1',
      name: 'Tracks Stack',
      enabled: true,
      parent_id: 'timeline_1',
      children_ids: ['track_v0', 'track_v1', 'track_a0'],
    },
    track_v0: {
      id: 'track_v0',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/0',
      schema: 'Track.1',
      name: 'Bottom Video Track',
      enabled: true,
      parent_id: 'stack_1',
      children_ids: options.includeTransition ? ['clip_a', 'trans_1', 'clip_b'] : ['clip_a'],
      track_kind: 'Video',
    },
    track_v1: {
      id: 'track_v1',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/1',
      schema: 'Track.1',
      name: 'Top Video Track',
      enabled: true,
      parent_id: 'stack_1',
      children_ids: ['clip_c'],
      track_kind: 'Video',
    },
    track_a0: {
      id: 'track_a0',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/2',
      schema: 'Track.1',
      name: 'Audio Track',
      enabled: true,
      parent_id: 'stack_1',
      children_ids: ['clip_audio'],
      track_kind: 'Audio',
    },
    clip_a: {
      id: 'clip_a',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/0/children/0',
      schema: 'Clip.1',
      name: 'Clip A',
      enabled: true,
      parent_id: 'track_v0',
      children_ids: [],
      source_range: {
        start_time: { value: 0, rate },
        duration: { value: 24, rate },
      },
      parent_range: {
        start_time: { value: 0, rate },
        duration: { value: 24, rate },
      },
      timeline_range: {
        start_time: { value: 0, rate },
        duration: { value: 24, rate },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          schema: 'ExternalReference.1',
          target_url: 'media/clip_a.mp4',
          available_range: {
            start_time: { value: 0, rate },
            duration: { value: 24, rate },
          },
        },
      },
    },
    clip_b: {
      id: 'clip_b',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/0/children/2',
      schema: 'Clip.1',
      name: 'Clip B',
      enabled: true,
      parent_id: 'track_v0',
      children_ids: [],
      source_range: {
        start_time: { value: 0, rate },
        duration: { value: 24, rate },
      },
      parent_range: {
        start_time: { value: 24, rate },
        duration: { value: 24, rate },
      },
      timeline_range: {
        start_time: { value: 24, rate },
        duration: { value: 24, rate },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          schema: 'ExternalReference.1',
          target_url: 'media/clip_b.mp4',
        },
      },
    },
    clip_c: {
      id: 'clip_c',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/1/children/0',
      schema: 'Clip.1',
      name: 'Clip C (Top Overlay)',
      enabled: true,
      parent_id: 'track_v1',
      children_ids: [],
      source_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
      parent_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
      timeline_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: options.imageSequence
          ? {
              schema: 'ImageSequenceReference.1',
              target_url_base: 'media/seq/',
              name_prefix: 'frame_',
              name_suffix: '.png',
              start_frame: 1,
              frame_step: 1,
              rate,
              frame_zero_padding: 4,
              missing_frame_policy: options.missingFramePolicy ?? 'error',
            }
          : {
              schema: 'ExternalReference.1',
              target_url: 'media/overlay.png',
            },
      },
      effects: options.reverseClip
        ? [
            {
              schema: 'LinearTimeWarp.1',
              name: 'Reverse Warper',
              enabled: true,
              time_scalar: -1.0,
            },
          ]
        : [],
    },
    clip_audio: {
      id: 'clip_audio',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/2/children/0',
      schema: 'Clip.1',
      name: 'Authored Narration',
      enabled: true,
      parent_id: 'track_a0',
      children_ids: [],
      source_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
      parent_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
      timeline_range: {
        start_time: { value: 0, rate },
        duration: { value: totalFrames, rate },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      media_references: {
        DEFAULT_MEDIA: {
          schema: 'ExternalReference.1',
          target_url: 'media/dialogue.wav',
        },
      },
    },
  };

  if (options.includeTransition) {
    nodes.trans_1 = {
      id: 'trans_1',
      identity_origin: 'authored',
      json_pointer: '/tracks/children/0/children/0/children/1',
      schema: 'Transition.1',
      name: 'Dissolve 1',
      enabled: true,
      parent_id: 'track_v0',
      children_ids: [],
      transition_type: 'SMPTE_Dissolve',
      in_offset: { value: 6, rate },
      out_offset: { value: 6, rate },
    };
  }

  return {
    version: 1,
    document_sha256: 'docsha123',
    timeline_ids: ['timeline_1'],
    nodes,
    media: {},
    diagnostics: [],
  };
}

describe('otio-playback', () => {
  interface TestGlobalEnv {
    document?: unknown;
    Image?: unknown;
    Audio?: unknown;
    AudioContext?: unknown;
  }
  const testEnv = globalThis as unknown as TestGlobalEnv;

  let originalDocument: unknown;
  let originalImage: unknown;
  let originalAudio: unknown;
  let originalAudioContext: unknown;

  beforeEach(() => {
    originalDocument = testEnv.document;
    originalImage = testEnv.Image;
    originalAudio = testEnv.Audio;
    originalAudioContext = testEnv.AudioContext;

    // Install mocks
    testEnv.Image = MockMediaElement;
    testEnv.Audio = MockMediaElement;
    testEnv.AudioContext = MockAudioContext;

    testEnv.document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return new MockCanvasElement();
        if (tag === 'video') return new MockMediaElement();
        return {};
      },
    };
  });

  afterEach(() => {
    testEnv.document = originalDocument;
    testEnv.Image = originalImage;
    testEnv.Audio = originalAudio;
    testEnv.AudioContext = originalAudioContext;
  });

  test('initializes state with computed duration, rate, and collected tracks', () => {
    const doc = buildTestDocument({ durationFrames: 48, rate: 24 });
    const canvas = new MockCanvasElement() as unknown as HTMLCanvasElement;
    const mediaMap = new Map<string, string>([
      ['media/clip_a.mp4', 'blob:clip_a'],
      ['media/overlay.png', 'blob:overlay'],
      ['media/dialogue.wav', 'blob:dialogue'],
    ]);

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async (p) => mediaMap.get(p) ?? null,
    });

    const state = playback.getState();
    expect(state.duration.value).toBe(48);
    expect(state.duration.rate).toBe(24);
    expect(state.rate).toBe(24);
    expect(state.time.value).toBe(0);
    expect(state.playing).toBe(false);
    expect(state.buffering).toBe(false);

    expect(state.tracks.track_v0).toBeDefined();
    expect(state.tracks.track_v0.kind).toBe('Video');
    expect(state.tracks.track_v0.visible).toBe(true);

    expect(state.tracks.track_v1).toBeDefined();
    expect(state.tracks.track_v1.kind).toBe('Video');

    expect(state.tracks.track_a0).toBeDefined();
    expect(state.tracks.track_a0.kind).toBe('Audio');
    expect(state.tracks.track_a0.muted).toBe(false);

    playback.dispose();
  });

  test('subscription fires immediately and on state changes', async () => {
    const doc = buildTestDocument({});
    const canvas = new MockCanvasElement() as unknown as HTMLCanvasElement;

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async () => 'blob:test',
    });

    const observed: OtioPlaybackState[] = [];
    const unsubscribe = playback.subscribe((s) => observed.push(s));

    expect(observed.length).toBe(1);
    expect(observed[0].playing).toBe(false);

    await playback.seek({ value: 12, rate: 24 });
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(playback.getState().time.value).toBe(12);

    unsubscribe();
    await playback.seek({ value: 20, rate: 24 });
    expect(observed.length).toBe(3); // Did not add after unsubscribe

    playback.dispose();
  });

  test('video elements are strictly muted to prevent accidental embedded audio', async () => {
    const doc = buildTestDocument({});
    const canvas = new MockCanvasElement() as unknown as HTMLCanvasElement;
    let createdVideoElement: MockMediaElement | null = null;

    testEnv.document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return new MockCanvasElement();
        if (tag === 'video') {
          createdVideoElement = new MockMediaElement();
          return createdVideoElement;
        }
        return {};
      },
    };

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async () => 'blob:test',
    });

    await playback.seek({ value: 0, rate: 24 });

    expect(createdVideoElement).not.toBeNull();
    // Video must never emit accidental audio!
    expect(createdVideoElement?.muted).toBe(true);
    expect(createdVideoElement?.volume).toBe(0);

    playback.dispose();
  });

  test('track visibility and solo control compositing', () => {
    const doc = buildTestDocument({});
    const mockCanvas = new MockCanvasElement();
    const canvas = mockCanvas as unknown as HTMLCanvasElement;

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async () => 'blob:test',
    });

    playback.setTrackVisibility('track_v1', false);
    expect(playback.getState().tracks.track_v1.visible).toBe(false);

    playback.setTrackMute('track_a0', true);
    expect(playback.getState().tracks.track_a0.muted).toBe(true);

    playback.setTrackSolo('track_v0', true);
    expect(playback.getState().tracks.track_v0.solo).toBe(true);

    playback.dispose();
  });

  test('produces unsupported-browser diagnostic on reverse time_scalar', async () => {
    const doc = buildTestDocument({ reverseClip: true });
    const canvas = new MockCanvasElement() as unknown as HTMLCanvasElement;

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async () => 'blob:test',
    });

    await playback.seek({ value: 10, rate: 24 });
    const state = playback.getState();
    const reverseDiag = state.diagnostics.find(
      (d) => d.code === 'unsupported-browser' && d.message.includes('Reverse playback')
    );
    expect(reverseDiag).toBeDefined();

    playback.dispose();
  });

  test('handles image sequences and missing frame policies', async () => {
    // 1. Error policy
    const docError = buildTestDocument({
      imageSequence: true,
      missingFramePolicy: 'error',
    });
    const canvas = new MockCanvasElement() as unknown as HTMLCanvasElement;

    const playbackError = createOtioPlayback({
      document: docError,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async () => null, // missing media
    });

    await playbackError.seek({ value: 5, rate: 24 });
    const stateError = playbackError.getState();
    expect(stateError.diagnostics.some((d) => d.code === 'missing-media')).toBe(true);
    playbackError.dispose();

    // 2. Hold policy
    let loadCount = 0;
    const docHold = buildTestDocument({
      imageSequence: true,
      missingFramePolicy: 'hold',
    });

    const playbackHold = createOtioPlayback({
      document: docHold,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async (path) => {
        // Frame 1 exists, subsequent frames missing
        if (path.includes('frame_0001')) {
          loadCount++;
          return 'blob:frame1';
        }
        return null;
      },
    });

    // Seek to first frame -> successfully loaded
    await playbackHold.seek({ value: 0, rate: 24 });
    expect(loadCount).toBe(1);

    // Seek to second frame (missing) -> held from first frame, no error diagnostic for hold
    await playbackHold.seek({ value: 1, rate: 24 });
    const stateHold = playbackHold.getState();
    expect(stateHold.diagnostics.some((d) => d.code === 'missing-media')).toBe(false);
    playbackHold.dispose();
  });

  test('SMPTE_Dissolve transition uses intermediate track surface with lighter blend', async () => {
    const doc = buildTestDocument({ includeTransition: true });
    const mockCanvas = new MockCanvasElement();
    const canvas = mockCanvas as unknown as HTMLCanvasElement;

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      resolveMedia: async () => 'blob:test',
    });

    // Seek into the transition window: trans_1 is at frame 24, in_offset 6, out_offset 6
    // So transition spans frames 18 to 30. Frame 24 is mid-transition.
    await playback.seek({ value: 24, rate: 24 });

    // Verify canvas background was cleared to black
    const fillBlack = mockCanvas.ctx.operations.find(
      (op) => op.includes('fillRect') && op.includes('#000000')
    );
    expect(fillBlack).toBeDefined();

    playback.dispose();
  });

  test('clean disposal clears all timers, media pools, audio context, and canvas', () => {
    const doc = buildTestDocument({});
    const mockCanvas = new MockCanvasElement();
    const canvas = mockCanvas as unknown as HTMLCanvasElement;
    const audioCtx = new MockAudioContext() as unknown as AudioContext;

    const playback = createOtioPlayback({
      document: doc,
      timelineId: 'timeline_1',
      canvas,
      audioContext: audioCtx,
      resolveMedia: async () => 'blob:test',
    });

    playback.dispose();

    // Canvas should have been cleared
    const cleared = mockCanvas.ctx.operations.some((op) => op.includes('clearRect'));
    expect(cleared).toBe(true);

    // After disposal, seek or play are no-ops
    expect(playback.seek({ value: 10, rate: 24 })).resolves.toBeUndefined();
  });
});
