import { describe, expect, test } from 'bun:test';
import {
  NativeDecoderRing,
  OTIO_RETAINED_SNAPSHOT_PIXELS,
  resizeRetainedRings,
  SnapshotPixelBudget,
} from '../src/otio-video-decoders.ts';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';

// 2560 x 1440 is 3,686,400 pixels per slot. Six slots is 22.1 Mi pixels, four
// slots is 14.7 Mi, and the aggregate cap is 32 Mi.
const W = 2560;
const H = 1440;
const PIXELS = W * H;

const timing: OtioVideoTiming = {
  kind: 'windows',
  starts: new Float64Array([0, 1, 2, 3, 4, 5, 6, 7]),
  ends: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]),
};

interface Stub {
  readonly video: { timestamp: number };
  readonly budget: SnapshotPixelBudget;
  ring(key: string): NativeDecoderRing;
}

/**
 * Installs DOM stubs for one test. `canvasFailures` counts canvas creations
 * that must throw, so a grow can fail for canvases while the budget admits it.
 */
function withRings<T>(
  fn: (stub: Stub, failures: { remaining: number }) => T
): T {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const frameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'VideoFrame'
  );
  const failures = { remaining: 0 };
  const video = {
    paused: false,
    timestamp: 0,
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback: () => {},
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        if (failures.remaining > 0) {
          failures.remaining--;
          throw new Error('canvas unavailable');
        }
        return {
          width: 0,
          height: 0,
          getContext: () => ({ clearRect() {}, drawImage() {} }),
          addEventListener() {},
          removeEventListener() {},
        };
      },
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
  const budget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
  const rings: NativeDecoderRing[] = [];
  const stub: Stub = {
    video,
    budget,
    ring(key) {
      const ring = new NativeDecoderRing(
        video as unknown as HTMLVideoElement,
        key,
        'clip.mov',
        budget
      );
      rings.push(ring);
      return ring;
    },
  };
  try {
    return fn(stub, failures);
  } finally {
    for (const ring of rings) ring.release();
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    if (frameDescriptor)
      Object.defineProperty(globalThis, 'VideoFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'VideoFrame');
  }
}

function capture(
  ring: NativeDecoderRing,
  video: { timestamp: number },
  tag: number
) {
  video.timestamp = tag;
  return ring.readoutFrame(timing, ring.captureEpoch);
}

describe('seek shrinks rings before any grow', () => {
  test('a seek from 6 to 4 slots frees the budget a second ring needs', () =>
    withRings(({ ring, budget }) => {
      const first = ring('first');
      const second = ring('second');
      expect(first.allocate(W, H, 6)).toBe(true);
      // 22.1 Mi held plus 14.7 Mi asked is over the 32 Mi cap.
      expect(second.allocate(W, H, 4)).toBe(false);
      expect(second.allocated).toBe(false);
      expect(budget.allocatedPixels).toBe(6 * PIXELS);

      const outcomes = resizeRetainedRings(
        [
          { ring: first, slots: 4 },
          { ring: second, slots: 4 },
        ],
        W,
        H
      );

      expect(outcomes).toEqual([
        { kind: 'reached', slots: 4 },
        { kind: 'reached', slots: 4 },
      ]);
      expect(first.slotCount).toBe(4);
      expect(second.slotCount).toBe(4);
      expect(budget.allocatedPixels).toBe(8 * PIXELS);
    }));

  test('the shrink runs first even when the growing ring is listed first', () =>
    withRings(({ ring, budget }) => {
      const first = ring('first');
      const second = ring('second');
      expect(first.allocate(W, H, 6)).toBe(true);
      const outcomes = resizeRetainedRings(
        [
          { ring: second, slots: 4 },
          { ring: first, slots: 4 },
        ],
        W,
        H
      );
      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        'reached',
        'reached',
      ]);
      expect(budget.allocatedPixels).toBe(8 * PIXELS);
    }));

  test('a ring that needs fewer slots gives back its pixels even with no growing ring', () =>
    withRings(({ ring, budget }) => {
      const first = ring('first');
      expect(first.allocate(W, H, 6)).toBe(true);
      expect(resizeRetainedRings([{ ring: first, slots: 3 }], W, H)).toEqual([
        { kind: 'reached', slots: 3 },
      ]);
      expect(budget.allocatedPixels).toBe(3 * PIXELS);
    }));
});

describe('explicit resize outcomes', () => {
  test('a grow the cap refuses restores the previous count and size', () =>
    withRings(({ ring, budget, video }) => {
      const only = ring('only');
      expect(only.allocate(W, H, 4)).toBe(true);
      // Ten slots is 36.9 Mi, over the cap even with this ring's pixels freed.
      expect(only.resize(W, H, 10)).toEqual({
        kind: 'refused',
        slots: 4,
        cause: 'cap',
      });
      expect(only.allocated).toBe(true);
      expect(only.slotCount).toBe(4);
      expect(budget.allocatedPixels).toBe(4 * PIXELS);
      // The restored ring still captures frames.
      expect(capture(only, video, 0)).toEqual({ kind: 'match', index: 0 });
    }));

  test('a grow refused for canvases, with the budget still admitting it, names the allocation cause', () =>
    withRings(({ ring, budget, video }, failures) => {
      const only = ring('only');
      expect(only.allocate(W, H, 4)).toBe(true);
      failures.remaining = 1;
      expect(only.resize(W, H, 5)).toEqual({
        kind: 'refused',
        slots: 4,
        cause: 'allocation',
      });
      expect(only.slotCount).toBe(4);
      expect(budget.allocatedPixels).toBe(4 * PIXELS);
      expect(capture(only, video, 0)).toEqual({ kind: 'match', index: 0 });
    }));

  test('a grow whose restore also fails leaves the ring empty and the budget returned', () =>
    withRings(({ ring, budget }, failures) => {
      const only = ring('only');
      expect(only.allocate(W, H, 4)).toBe(true);
      // Every canvas from here on fails, so the grow and its restore both do.
      failures.remaining = 100;
      expect(only.resize(W, H, 5)).toEqual({ kind: 'restore-failed' });
      expect(only.allocated).toBe(false);
      expect(budget.allocatedPixels).toBe(0);
    }));

  test('an unallocated ring refused by the cap reports zero slots', () =>
    withRings(({ ring, budget }) => {
      const first = ring('first');
      const second = ring('second');
      expect(first.allocate(W, H, 6)).toBe(true);
      expect(second.resize(W, H, 4)).toEqual({
        kind: 'refused',
        slots: 0,
        cause: 'cap',
      });
      expect(second.allocated).toBe(false);
      expect(budget.allocatedPixels).toBe(6 * PIXELS);
    }));

  test('a shrink is reached and leaves the ring holding the target count', () =>
    withRings(({ ring, budget }) => {
      const only = ring('only');
      expect(only.allocate(W, H, 6)).toBe(true);
      expect(only.resize(W, H, 4)).toEqual({ kind: 'reached', slots: 4 });
      expect(budget.allocatedPixels).toBe(4 * PIXELS);
    }));
});
