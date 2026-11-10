import { describe, expect, test } from 'bun:test';
import {
  mixProgramAudio,
  type ProgramAudioPlan,
  type ProgramAudioSpan,
} from '../src/program-render/audio-mix.ts';
import { ProgramRenderFailure } from '../src/program-render/failure.ts';
import { ProgramMedia } from '../src/program-render/media.ts';
import {
  assertCanvasAvailable,
  assertSequenceFrame,
  compositionFrameRate,
  frameRateOf,
  frameTime,
  isDisabled,
  staticReasons,
} from '../src/program-render/render.ts';
import {
  compareRationalTimes,
  evaluateOtioAt,
  readOtioDocument,
  type OtioDocumentV1,
} from '@relic/format';

/** In-memory stand-in for ProgramMedia: stereo source at a fixed native rate. */
function memoryMedia(
  rate: number,
  left: Float32Array,
  right: Float32Array
): ProgramMedia {
  return {
    async audioInfo() {
      return { rate, channels: 2 as const };
    },
    async readNative(_path: string, start: number, count: number) {
      const l = new Float32Array(count);
      const r = new Float32Array(count);
      const end = Math.min(start + count, left.length);
      for (let i = start; i < end; i++) {
        l[i - start] = left[i]!;
        r[i - start] = right[i]!;
      }
      return { left: l, right: r, begin: start, end: Math.max(start, end) };
    },
  } as unknown as ProgramMedia;
}

function singleSpan(
  frames: number,
  overrides: Partial<ProgramAudioSpan> = {}
): ProgramAudioPlan {
  const span: ProgramAudioSpan = {
    startFrame: 0,
    endFrame: frames,
    startSec: 0,
    sourceOriginSec: 0,
    path: 'source.wav',
    ramps: [],
    ...overrides,
  };
  return { originSec: 0, sampleCount: frames, spans: [span] };
}

describe('frameRateOf', () => {
  test('integer and NTSC rates have exact rational forms', () => {
    expect(frameRateOf(24)).toEqual({ num: 24, den: 1 });
    expect(frameRateOf(29.97)).toEqual({ num: 2997, den: 100 });
    expect(frameRateOf(24000 / 1001)).toEqual({ num: 24000, den: 1001 });
  });

  test('rates above 240 fps fail with invalid-timing', () => {
    expect(() => frameRateOf(240.5)).toThrow(ProgramRenderFailure);
  });

  test('rates below 1 fps fail with invalid-timing', () => {
    expect(() => frameRateOf(0.5)).toThrow(ProgramRenderFailure);
  });
});

describe('frameTime', () => {
  test('zero origin: frame n is at n / fps', () => {
    const t = frameTime({ value: 0, rate: 24 }, 5, { num: 24, den: 1 });
    expect(t.value / t.rate).toBeCloseTo(5 / 24, 12);
  });

  test('non-zero origin: frame n is origin + n / fps', () => {
    // origin 1/2 s, frame 24 at 24 fps is one second later: 1.5 s total.
    const t = frameTime({ value: 1, rate: 2 }, 24, { num: 24, den: 1 });
    expect(t.value / t.rate).toBeCloseTo(1.5, 12);
  });
});

describe('mixProgramAudio', () => {
  test('48 kHz integer-aligned source preserves sample values', () => {
    const left = Float32Array.from(
      { length: 200 },
      (_, i) => (i % 17) / 20 - 0.4
    );
    const right = Float32Array.from(
      { length: 200 },
      (_, i) => -((i % 13) / 25)
    );
    const media = memoryMedia(48000, left, right);
    return mixProgramAudio(singleSpan(100), media, 0, 100).then((out) => {
      for (let k = 0; k < 100; k++) {
        expect(out[k]).toBe(left[k]!);
        expect(out[100 + k] === right[k]).toBe(true);
      }
    });
  });

  test('44.1 kHz constant source keeps unity DC gain in the interior', async () => {
    const n = 88200;
    const left = new Float32Array(n).fill(0.5);
    const right = new Float32Array(n).fill(-0.25);
    const media = memoryMedia(44100, left, right);
    const out = await mixProgramAudio(singleSpan(40000), media, 0, 40000);
    for (let k = 100; k < 39000; k++) {
      expect(Math.abs(out[k]! - 0.5)).toBeLessThan(1e-5);
      expect(Math.abs(out[40000 + k]! + 0.25)).toBeLessThan(1e-5);
    }
  });

  test('44.1 kHz sine resamples to the 48 kHz sine within tolerance', async () => {
    const sourceRate = 44100;
    const f = 1000;
    const n = 88200;
    const tone = Float32Array.from({ length: n }, (_, i) =>
      Math.sin((2 * Math.PI * f * i) / sourceRate)
    );
    const media = memoryMedia(sourceRate, tone, tone);
    const out = await mixProgramAudio(singleSpan(40000), media, 0, 40000);
    let worst = 0;
    for (let k = 200; k < 39000; k++) {
      const expected = Math.sin((2 * Math.PI * f * k) / 48000);
      worst = Math.max(worst, Math.abs(out[k]! - expected));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  test('mixing in windows gives the same samples as one pass (no drift)', async () => {
    const sourceRate = 44100;
    const n = 88200;
    const tone = Float32Array.from(
      { length: n },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / sourceRate)
    );
    const media = memoryMedia(sourceRate, tone, tone);
    const plan = singleSpan(30000);
    const whole = await mixProgramAudio(plan, media, 0, 30000);
    const first = await mixProgramAudio(plan, media, 0, 10000);
    const second = await mixProgramAudio(plan, media, 10000, 20000);
    for (let k = 0; k < 10000; k++) {
      expect(first[k]).toBe(whole[k]!);
      expect(first[10000 + k]).toBe(whole[30000 + k]!);
    }
    for (let k = 0; k < 20000; k++) {
      expect(second[k]).toBe(whole[10000 + k]!);
      expect(second[20000 + k]).toBe(whole[30000 + 10000 + k]!);
    }
  });

  test('fade-in ramp applies linearly in timeline seconds', async () => {
    const left = new Float32Array(4800).fill(1);
    const right = new Float32Array(4800).fill(1);
    const media = memoryMedia(48000, left, right);
    const plan = singleSpan(4800, {
      ramps: [{ startSec: 0, endSec: 0.1, direction: 'in' }],
    });
    const out = await mixProgramAudio(plan, media, 0, 4800);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[2400]).toBeCloseTo(0.5, 6);
    expect(out[4799]).toBeCloseTo(4799 / 4800, 6);
  });

  test('a span that runs past decoded source fails, never reads as silence', () => {
    const left = new Float32Array(500).fill(0.2);
    const right = new Float32Array(500).fill(0.2);
    const media = memoryMedia(48000, left, right);
    return expect(
      mixProgramAudio(singleSpan(1000), media, 0, 1000)
    ).rejects.toThrow(ProgramRenderFailure);
  });
});

describe('program fidelity guards', () => {
  function documentWithRates(rates: number[]): OtioDocumentV1 {
    const nodes: Record<string, unknown> = {
      timeline: {
        id: 'timeline',
        schema: 'Timeline.1',
        enabled: true,
        parent_id: null,
        children_ids: ['video'],
      },
      video: {
        id: 'video',
        schema: 'Track.1',
        track_kind: 'Video',
        enabled: true,
        parent_id: 'timeline',
        children_ids: rates.map((_, i) => `clip${i}`),
      },
    };
    rates.forEach((rate, i) => {
      nodes[`clip${i}`] = {
        id: `clip${i}`,
        schema: 'Clip.1',
        enabled: true,
        parent_id: 'video',
        children_ids: [],
        active_media_reference_key: 'default',
        media_references: {
          default: {
            schema: 'ExternalReference.1',
            target_url: `media/${i}.mp4`,
          },
        },
        source_range: { duration: { value: 48, rate } },
      };
    });
    return { nodes } as unknown as OtioDocumentV1;
  }

  test('NTSC frame at a cut compares equal to its boundary', () => {
    for (const fps of [23.976, 24000 / 1001, 30000 / 1001, 60000 / 1001]) {
      const t = frameTime({ value: 0, rate: fps }, 48, frameRateOf(fps));
      expect(compareRationalTimes(t, { value: 48, rate: fps })).toBe(0);
    }
  });

  test('NTSC cut selects the next clip at the actual boundary', () => {
    const fps = 24000 / 1001;
    const clip = (name: string, start: number) => ({
      OTIO_SCHEMA: 'Clip.1',
      name,
      source_range: {
        start_time: { value: start, rate: fps },
        duration: { value: 48, rate: fps },
      },
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: `media/${name}.mp4`,
      },
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              kind: 'Video',
              children: [clip('A', 10), clip('B', 100)],
            },
          ],
        },
      })
    );
    const timeline = doc.timeline_ids[0]!;
    const before = evaluateOtioAt(
      doc,
      timeline,
      frameTime({ value: 0, rate: fps }, 47, frameRateOf(fps))
    );
    const cut = evaluateOtioAt(
      doc,
      timeline,
      frameTime({ value: 0, rate: fps }, 48, frameRateOf(fps))
    );
    expect(before.video_contributions[0]?.name).toBe('A');
    expect(cut.video_contributions[0]?.name).toBe('B');
    expect(cut.video_contributions[0]?.source_time.value).toBe(100);
  });

  test('sequence boundary rejects an image selected one frame early', () => {
    expect(() => assertSequenceFrame(6.999999999999999, 1, 1, 8)).not.toThrow();
    expect(() => assertSequenceFrame(6.999999999999999, 1, 1, 7)).toThrow(
      ProgramRenderFailure
    );
    expect(() => assertSequenceFrame(6.5, 1, 1, 7)).not.toThrow();
  });

  test('frame rate requires matching certified video cadence', async () => {
    const media = { isImage: () => false, videoFrameRate: async () => 30 };
    await expect(
      compositionFrameRate(documentWithRates([30, 30]), 'timeline', media)
    ).resolves.toEqual({ num: 30, den: 1 });
    await expect(
      compositionFrameRate(documentWithRates([1]), 'timeline', media)
    ).rejects.toThrow(ProgramRenderFailure);
    await expect(
      compositionFrameRate(documentWithRates([12, 30]), 'timeline', media)
    ).rejects.toThrow(ProgramRenderFailure);
    await expect(
      compositionFrameRate(documentWithRates([24]), 'timeline', media)
    ).rejects.toThrow(ProgramRenderFailure);
  });

  test('disabled ancestor hides a clip', () => {
    const doc = documentWithRates([30]);
    (doc.nodes.video as { enabled: boolean }).enabled = false;
    expect(isDisabled(doc, 'clip0')).toBe(true);
    expect(isDisabled(doc, 'timeline')).toBe(false);
  });

  test('ancestor time effects are rejected', () => {
    const doc = documentWithRates([30]);
    (doc.nodes.video as { effects: unknown[] }).effects = [
      { enabled: true, schema: 'FreezeFrame.1' },
    ];
    expect(staticReasons(doc, 'timeline')[0]?.code).toBe('unsupported-effect');
  });

  test('lost output or pooled canvas is rejected', () => {
    const canvas = {
      getContext: () => ({ isContextLost: () => true }),
    } as unknown as HTMLCanvasElement;
    expect(() => assertCanvasAvailable(canvas)).toThrow(ProgramRenderFailure);
  });

  test('video cursor rejects rotated and uncovered frames and decodes sequentially', async () => {
    const media = new ProgramMedia(new Set(['x']));
    let opens = 0;
    const sample = (n: number, rotation = 0) => ({
      timestamp: n / 30,
      duration: 1 / 30,
      rotation,
      flip: false,
      close() {},
    });
    const state = {
      last: null,
      iterator: null,
      sink: {
        async getSample(t: number) {
          return sample(Math.min(59, Math.floor(t * 30)));
        },
        async *samples(t: number) {
          opens++;
          for (let i = Math.floor(t * 30); i < 60; i++) yield sample(i);
        },
      },
    };
    (media as unknown as { videos: Map<string, Promise<unknown>> }).videos.set(
      'x',
      Promise.resolve(state)
    );
    for (let i = 0; i < 50; i++)
      expect((await media.videoSample('x', i / 30)).timestamp).toBe(i / 30);
    expect(opens).toBe(1);
    await expect(media.videoSample('x', 5)).rejects.toThrow(
      ProgramRenderFailure
    );
    const rotated = {
      ...state,
      last: null,
      iterator: null,
      sink: {
        ...state.sink,
        async getSample() {
          return sample(0, 90);
        },
      },
    };
    (media as unknown as { videos: Map<string, Promise<unknown>> }).videos.set(
      'rotated',
      Promise.resolve(rotated)
    );
    await expect(media.videoSample('rotated', 0)).rejects.toThrow(
      ProgramRenderFailure
    );
    media.dispose();
  });

  test('audio reads reuse a decoder and restart from the first packet on backward seeks', async () => {
    const media = new ProgramMedia(new Set(['x']));
    let opens = 0;
    const state = {
      rate: 10,
      channels: 1,
      iterator: null,
      samples: [],
      discardedBefore: 0,
      ended: false,
      sink: {
        async *samples(start?: number) {
          expect(start).toBeUndefined();
          opens++;
          for (let i = 0; i < 50; i++) {
            yield {
              timestamp: i / 10,
              numberOfFrames: 1,
              copyTo(dest: Float32Array) {
                dest[0] = i / 100;
              },
              close() {},
            };
          }
        },
      },
    };
    const internal = media as unknown as {
      audios: Map<string, Promise<unknown>>;
    };
    internal.audios.set('x', Promise.resolve(state));
    const first = await media.readNative('x', 10, 10);
    const second = await media.readNative('x', 19, 10);
    expect(first.left[9]).toBeCloseTo(second.left[0]!, 6);
    expect(opens).toBe(1);
    const rewind = await media.readNative('x', 0, 2);
    expect(rewind.left[1]).toBeCloseTo(0.01, 6);
    expect(opens).toBe(2);
    media.dispose();
  });
});
