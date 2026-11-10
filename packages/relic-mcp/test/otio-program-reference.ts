/**
 * Independent expectation for the rendered-program proof composition.
 *
 * Every value here comes from the composition's written timeline (see
 * fixtures/program/generate-program-fixture.py) and from the source formulas in
 * generate-program-media.sh. Nothing is read from Relic's evaluator, renderer, or manifest.
 * The library oracle written by OpenTimelineIO is checked against these numbers in the
 * self tests, so a disagreement between the timeline and this model fails loudly.
 */

export const PROGRAM = {
  fps: 30,
  width: 1280,
  height: 720,
  frames: 180,
  durationSeconds: 6,
  audioRate: 48000,
  audioChannels: 2,
  audioSamples: 288000,
  /** Frame-index bar: white 4 px columns at x = 4*n, rows y=600..619. */
  bar: { sampleRow: 610, width: 4, x0: 4, rowTop: 600, rowBottom: 620 },
  /** Background probe, clear of the bar row. */
  probe: { x: 60, y: 60, radius: 2 },
  /** Background colours (RGB) of the three plates. */
  plates: {
    a: [200, 40, 40],
    b: [40, 40, 200],
    c: [30, 200, 30],
  } as const,
  /** Dissolve window: 0.2 s either side of the 3.0 s cut. */
  dissolveFrames: { first: 84, lastExclusive: 96 },
  /** Silent gap in the chirp track, in seconds. */
  audioGap: { start: 4.5, end: 5.0 },
} as const;

export type PlateName = 'a' | 'b' | 'c';

export type FrameExpectation =
  | {
      readonly frame: number;
      readonly kind: 'single';
      readonly plate: PlateName;
      /** Source frame index of the plate that is shown, which the bar encodes. */
      readonly index: number;
    }
  | {
      readonly frame: number;
      readonly kind: 'dissolve';
      readonly outgoing: { readonly plate: 'a'; readonly index: number };
      readonly incoming: { readonly plate: 'b'; readonly index: number };
      /** Incoming weight, u = (t - 2.8) / 0.4. The outgoing weight is 1 - u. */
      readonly weight: number;
    };

/**
 * Expected picture for output frame k (t = k / 30 s).
 *
 * Stack order: V2 is above V1. V2 is opaque, so it hides V1 wherever it has media.
 *  - [1, 2) s: plate_c, index k - 30.
 *  - [4, 5) s: plate_c at 2x, index 2 * (k - 120).
 * V1 otherwise:
 *  - [0, 2.8) s: plate_a, index k.
 *  - [2.8, 3.2) s: dissolve from plate_a (index k) to plate_b (index k - 30).
 *  - [3.2, 6) s: plate_b, index k - 30.
 */
export function expectedFrame(frame: number): FrameExpectation {
  if (frame < 0 || frame >= PROGRAM.frames || !Number.isInteger(frame))
    throw new RangeError(`frame ${frame} outside the composition`);
  if (frame >= 30 && frame < 60)
    return { frame, kind: 'single', plate: 'c', index: frame - 30 };
  if (frame >= 120 && frame < 150)
    return { frame, kind: 'single', plate: 'c', index: 2 * (frame - 120) };
  if (frame < PROGRAM.dissolveFrames.first)
    return { frame, kind: 'single', plate: 'a', index: frame };
  if (frame < PROGRAM.dissolveFrames.lastExclusive)
    return {
      frame,
      kind: 'dissolve',
      outgoing: { plate: 'a', index: frame },
      incoming: { plate: 'b', index: frame - 30 },
      weight: (frame - PROGRAM.dissolveFrames.first) / 12,
    };
  return { frame, kind: 'single', plate: 'b', index: frame - 30 };
}

/** Expected background RGB for a frame, mixing both plates during the dissolve. */
export function expectedBackground(
  expect: FrameExpectation
): readonly number[] {
  if (expect.kind === 'single') return PROGRAM.plates[expect.plate];
  const a = PROGRAM.plates.a;
  const b = PROGRAM.plates.b;
  const u = expect.weight;
  return a.map((value, channel) => (1 - u) * value + u * (b[channel] ?? 0));
}

/** Audio source formulas. These match the ffmpeg aevalsrc expressions verbatim. */
export function chirp(seconds: number): number {
  return (
    0.5 * Math.sin(2 * Math.PI * (200 * seconds + 300 * seconds * seconds))
  );
}
export function tone(seconds: number): number {
  return 0.3 * Math.sin(2 * Math.PI * 1000 * seconds);
}

/**
 * Expected mixed program audio at 48 kHz for sample n, in exact integer segments.
 *  - chirp_a: samples [0, 216000) at source time n / 48000.
 *  - silent gap: [216000, 240000).
 *  - chirp_b: [240000, 288000) at source time 4.5 + (n - 240000) / 48000.
 *  - tone: [48000, 144000) at source time (n - 48000) / 48000.
 * The two tracks are summed. Both channels carry the same signal.
 */
export function expectedAudioSample(n: number): number {
  let value = 0;
  if (n >= 0 && n < 216000) value += chirp(n / 48000);
  else if (n >= 240000 && n < 288000)
    value += chirp(4.5 + (n - 240000) / 48000);
  if (n >= 48000 && n < 144000) value += tone((n - 48000) / 48000);
  return value;
}

export function expectedAudio(
  samples: number = PROGRAM.audioSamples
): Float32Array {
  const out = new Float32Array(samples);
  for (let n = 0; n < samples; n++) out[n] = expectedAudioSample(n);
  return out;
}

/** Start and duration of each stack child from the library oracle's JSON, checked by self tests. */
export const EXPECTED_PLACEMENTS = {
  V1: [
    { name: 'plate_a', start: 0, duration: 3.0 },
    { name: 'plate_b', start: 3.0, duration: 3.0 },
  ],
  V2: [
    { name: 'gap', start: 0, duration: 1.0 },
    { name: 'plate_c', start: 1.0, duration: 1.0 },
    { name: 'gap', start: 2.0, duration: 2.0 },
    { name: 'plate_c_2x', start: 4.0, duration: 1.0 },
    { name: 'gap', start: 5.0, duration: 1.0 },
  ],
  A1: [
    { name: 'chirp_a', start: 0, duration: 4.5 },
    { name: 'gap', start: 4.5, duration: 0.5 },
    { name: 'chirp_b', start: 5.0, duration: 1.0 },
  ],
  A2: [
    { name: 'gap', start: 0, duration: 1.0 },
    { name: 'tone', start: 1.0, duration: 2.0 },
    { name: 'gap', start: 3.0, duration: 3.0 },
  ],
} as const;
