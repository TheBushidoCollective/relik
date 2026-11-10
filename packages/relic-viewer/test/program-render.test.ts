import { describe, expect, test } from 'bun:test';
import {
  mixProgramAudio,
  type ProgramAudioPlan,
  type ProgramAudioSpan,
} from '../src/program-render/audio-mix.ts';
import { ProgramRenderFailure } from '../src/program-render/failure.ts';
import type { ProgramMedia } from '../src/program-render/media.ts';
import { frameRateOf, frameTime } from '../src/program-render/render.ts';

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
  test('48 kHz integer-aligned source is copied bit-exact', () => {
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
        expect(out[100 + k]).toBe(right[k]!);
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
