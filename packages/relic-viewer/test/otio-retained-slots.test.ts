import { describe, expect, test } from 'bun:test';
import {
  NativeDecoderRing,
  OTIO_RETAINED_SNAPSHOT_PIXELS,
  phaseBandMs,
  requiredResidentSlots,
  selectOtioCausalEpoch,
  SnapshotPixelBudget,
  type DecoderPhaseSample,
} from '../src/otio-video-decoders.ts';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';

const FPS30 = 1 / 30;
const FPS60 = 1 / 60;
const RATE = 48000;
const GUARD_FRAMES = 512;

// Source rate 1 and local time equal to the packet start, so offset equals
// iL0Plus1Start - sourceT0Seconds.
function sample(
  wMinSeconds: number,
  residentSlots?: number,
  offsetSeconds = 0.036,
  dL = 1100
): DecoderPhaseSample {
  return {
    dL,
    iL0Plus1Start: offsetSeconds,
    sourceT0Seconds: 0,
    rL: 1,
    wMinSeconds,
    ...(residentSlots === undefined ? {} : { residentSlots }),
  };
}

describe('phase band derives from the resident slot count', () => {
  test('three slots keep the original 2 * wMin band', () => {
    const band = phaseBandMs(sample(FPS30, 3), FPS60);
    expect(band.lower).toBeCloseTo(1080.667, 2);
    expect(band.upper).toBeCloseTo(1130.667, 2);
  });

  test('each extra slot widens the upper edge by exactly one minimum window', () => {
    for (const wMin of [FPS30, FPS60]) {
      const base = phaseBandMs(sample(wMin, 3), FPS60).upper;
      for (const slots of [4, 5, 6]) {
        const upper = phaseBandMs(sample(wMin, slots), FPS60).upper;
        expect(upper - base).toBeCloseTo((slots - 3) * wMin * 1000, 6);
      }
    }
  });

  test('upper edge is the eviction boundary: a frame stays resident through its window', () => {
    // Frame i+1 is captured at dL and evicted by the K-th later capture, at
    // dL + K * wMin. The transition to it, upper + offset, plus one window must
    // not pass that instant for any K or cadence.
    for (const wMin of [FPS30, FPS60]) {
      for (const slots of [3, 4, 6]) {
        const s = sample(wMin, slots, 0.02);
        const { upper } = phaseBandMs(s, FPS60);
        const transitionEnd = upper + 1000 * 0.02 + 1000 * wMin;
        expect(transitionEnd).toBeCloseTo(s.dL + 1000 * slots * wMin, 6);
      }
    }
  });

  test('a sample whose phase lies past the 3-slot upper edge is refused by 3 slots', () => {
    const bridge = {
      contextTime: 0,
      performanceTime: 0,
      mappingAllowanceMs: 0,
    };
    // contextNow chosen so the earliest guarded epoch is about 1153.8 ms.
    const contextNow = 54870.4 / RATE;
    const epoch = (slots: number) =>
      selectOtioCausalEpoch(
        [sample(FPS30, slots)],
        FPS60,
        bridge,
        RATE,
        contextNow,
        1100,
        1100,
        GUARD_FRAMES
      );
    expect(epoch(3)).toBeNull();
    const fourSlots = epoch(4);
    expect(fourSlots).not.toBeNull();
    expect(fourSlots!.performanceTime).toBeCloseTo(1153.8, 0);
    expect(fourSlots!.performanceTime).toBeLessThanOrEqual(
      phaseBandMs(sample(FPS30, 4), FPS60).upper
    );
  });
});

describe('requiredResidentSlots from measured lead and cadence', () => {
  test('30 fps with a 41 ms lead and one-window offset needs four slots', () => {
    expect(
      requiredResidentSlots({
        leadSeconds: 0.041,
        vsyncSeconds: FPS60,
        offsetSeconds: FPS30,
        wMinSeconds: FPS30,
      })
    ).toBe(4);
  });

  test('60 fps with the same lead needs six slots', () => {
    expect(
      requiredResidentSlots({
        leadSeconds: 0.041,
        vsyncSeconds: FPS60,
        offsetSeconds: FPS60,
        wMinSeconds: FPS60,
      })
    ).toBe(6);
  });

  test('no lead never drops below the three-slot ring', () => {
    expect(
      requiredResidentSlots({
        leadSeconds: 0,
        vsyncSeconds: FPS60,
        offsetSeconds: 0,
        wMinSeconds: FPS30,
      })
    ).toBe(3);
  });

  test('unusable inputs return null so the caller keeps its ring', () => {
    const base = {
      leadSeconds: 0.04,
      vsyncSeconds: FPS60,
      offsetSeconds: 0.01,
      wMinSeconds: FPS30,
    };
    expect(
      requiredResidentSlots({ ...base, leadSeconds: Number.NaN })
    ).toBeNull();
    expect(requiredResidentSlots({ ...base, leadSeconds: -0.001 })).toBeNull();
    expect(
      requiredResidentSlots({ ...base, wMinSeconds: FPS60 / 2 })
    ).toBeNull();
  });
});

describe('aggregate 32 Mi-pixel retained cap', () => {
  const HD = 1920 * 1080;

  test('1080p admits 16 slots and refuses the 17th', () => {
    const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
    expect(budget.allocate(16 * HD)).toBe(true);
    expect(budget.canAllocate(HD)).toBe(false);
    expect(budget.allocate(HD)).toBe(false);
    expect(budget.allocatedPixels).toBe(16 * HD);
  });

  test('a 4608 by 4608 video cannot hold even three slots', () => {
    const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
    const square = 4608 * 4608;
    expect(budget.canAllocate(3 * square)).toBe(false);
    expect(budget.canAllocate(square)).toBe(true);
  });

  test('a third 60 fps decoder at six 1080p slots is refused and leaves the others intact', () => {
    const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
    expect(budget.allocate(6 * HD)).toBe(true);
    expect(budget.allocate(6 * HD)).toBe(true);
    expect(budget.allocate(6 * HD)).toBe(false);
    expect(budget.allocatedPixels).toBe(12 * HD);
  });
});

type FakeSurface = {
  width: number;
  height: number;
  getContext(): unknown;
  addEventListener(): void;
  removeEventListener(): void;
};

function withDom<T>(fn: (video: { timestamp: number }) => T): T {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const frameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'VideoFrame'
  );
  const video = {
    paused: false,
    timestamp: 0,
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback: () => {},
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (): FakeSurface => ({
        width: 0,
        height: 0,
        getContext() {
          return { clearRect() {}, drawImage() {} };
        },
        addEventListener() {},
        removeEventListener() {},
      }),
    },
  });
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value: class {
      timestamp: number;
      constructor(source: { timestamp: number }) {
        this.timestamp = source.timestamp * 1e6;
      }
      close() {}
    },
  });
  try {
    return fn(video);
  } finally {
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    if (frameDescriptor)
      Object.defineProperty(globalThis, 'VideoFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'VideoFrame');
  }
}

// Eight unit windows, so tags 0..7 are all certified and presentable.
const timing: OtioVideoTiming = {
  kind: 'windows',
  starts: new Float64Array([0, 1, 2, 3, 4, 5, 6, 7]),
  ends: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]),
};

function capture(
  ring: NativeDecoderRing,
  video: { timestamp: number },
  tag: number
) {
  video.timestamp = tag;
  return ring.readoutFrame(timing, ring.captureEpoch);
}

describe('ring eviction at K slots', () => {
  for (const slots of [4, 6]) {
    test(`a frame survives K-1 later captures and is evicted by the K-th at K=${slots}`, () =>
      withDom((video) => {
        const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
        const ring = new NativeDecoderRing(
          video as unknown as HTMLVideoElement,
          'occurrence',
          'clip.mov',
          budget
        );
        try {
          expect(ring.allocate(10, 10, slots)).toBe(true);
          expect(ring.slotCount).toBe(slots);
          expect(budget.allocatedPixels).toBe(slots * 100);
          expect(capture(ring, video, 0).kind).toBe('match');
          for (let tag = 1; tag < slots; tag++) capture(ring, video, tag);
          expect(ring.hasTag(0, 0)).toBe(true);
          expect(capture(ring, video, slots).kind).toBe('match');
          expect(ring.hasTag(0, 0)).toBe(false);
          expect(
            ring
              .residentTags()
              .map((entry) => entry.tag)
              .sort((a, b) => a - b)
          ).toEqual(Array.from({ length: slots }, (_, index) => index + 1));
        } finally {
          ring.release();
        }
      }));
  }

  test('growing a ring past the cap restores the previous slot count', () =>
    withDom((video) => {
      const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
      const ring = new NativeDecoderRing(
        video as unknown as HTMLVideoElement,
        'occurrence',
        'clip.mov',
        budget
      );
      try {
        const w = 1920;
        const h = 1080;
        expect(ring.allocate(w, h)).toBe(true);
        expect(ring.allocate(w, h, 17)).toBe(false);
        expect(ring.allocate(w, h, 3)).toBe(true);
        expect(ring.slotCount).toBe(3);
        expect(budget.allocatedPixels).toBe(3 * w * h);
      } finally {
        ring.release();
      }
    }));

  test('an allocation without an explicit count keeps a grown ring unchanged', () =>
    withDom((video) => {
      const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
      const ring = new NativeDecoderRing(
        video as unknown as HTMLVideoElement,
        'occurrence',
        'clip.mov',
        budget
      );
      try {
        expect(ring.allocate(10, 10, 5)).toBe(true);
        expect(ring.allocate(10, 10)).toBe(true);
        expect(ring.slotCount).toBe(5);
        expect(budget.allocatedPixels).toBe(5 * 100);
      } finally {
        ring.release();
      }
    }));
});
