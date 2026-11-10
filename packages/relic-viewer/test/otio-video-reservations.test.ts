import { describe, expect, test } from 'bun:test';
import {
  NativeDecoderRing,
  SnapshotPixelBudget,
} from '../src/otio-video-decoders.ts';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';

const timing: OtioVideoTiming = {
  kind: 'windows',
  starts: new Float64Array([0, 1, 2, 3]),
  ends: new Float64Array([1, 2, 3, 4]),
};

class Surface {
  width = 0;
  height = 0;
  lost = false;
  failDraw = false;
  listeners = new Set<() => void>();
  ctx = {
    clearRect: () => {},
    drawImage: () => {
      if (this.failDraw) throw new Error('draw');
    },
    isContextLost: () => this.lost,
  };
  getContext() {
    return this.ctx;
  }
  addEventListener(_type: string, listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners.delete(listener);
  }
  lose() {
    this.lost = true;
    for (const listener of this.listeners) listener();
  }
}

function fixture(
  fn: (env: {
    ring: NativeDecoderRing;
    video: {
      paused: boolean;
      timestamp: number;
      requestVideoFrameCallback: (cb: (now: number) => void) => number;
      cancelVideoFrameCallback: (id: number) => void;
    };
    budget: SnapshotPixelBudget;
    surfaces: Surface[];
    callbacks: Map<number, (now: number) => void>;
    closed: () => number;
    factory: { make: () => Surface | null };
  }) => void
) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const frameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'VideoFrame'
  );
  const surfaces: Surface[] = [];
  const callbacks = new Map<number, (now: number) => void>();
  let next = 0;
  let closeCount = 0;
  const factory: { make: () => Surface | null } = { make: () => new Surface() };
  const video = {
    paused: false,
    timestamp: 0,
    requestVideoFrameCallback: (cb: (now: number) => void) => {
      callbacks.set(++next, cb);
      return next;
    },
    cancelVideoFrameCallback: (_id: number) => {},
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const surface = factory.make();
        if (!surface) throw new Error('creation failed');
        surfaces.push(surface);
        return surface;
      },
    },
  });
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value: class {
      timestamp: number;
      constructor(source: typeof video) {
        this.timestamp = source.timestamp * 1e6;
      }
      close() {
        closeCount++;
      }
    },
  });
  const budget = new SnapshotPixelBudget(1000);
  const ring = new NativeDecoderRing(
    video as unknown as HTMLVideoElement,
    'occurrence',
    'clip.mov',
    budget,
    { strictProducerOrder: true }
  );
  try {
    fn({
      ring,
      video,
      budget,
      surfaces,
      callbacks,
      closed: () => closeCount,
      factory,
    });
  } finally {
    ring.release();
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

describe('native video snapshot reservations', () => {
  test('rolls back budget and surfaces for null context and partial exceptions', () =>
    fixture(({ ring, budget, surfaces, factory }) => {
      let created = 0;
      factory.make = () => {
        const surface = new Surface();
        if (++created === 2) surface.getContext = () => null as never;
        return surface;
      };
      expect(ring.allocate(10, 10)).toBe(false);
      expect(budget.allocatedPixels).toBe(0);
      expect(ring.slots).toHaveLength(0);
      expect(surfaces.every((s) => s.width === 0 && s.height === 0)).toBe(true);
      created = 0;
      factory.make = () => {
        if (++created === 3) throw new Error('allocation');
        return new Surface();
      };
      expect(ring.allocate(10, 10)).toBe(false);
      expect(budget.allocatedPixels).toBe(0);
      expect(ring.slots).toHaveLength(0);
      ring.release();
      expect(budget.allocatedPixels).toBe(0);
    }));

  test('pins all three tags, distinguishes backpressure, and never invents a missed tag', () =>
    fixture(({ ring, video, budget, closed }) => {
      expect(ring.allocate(10, 10)).toBe(true);
      for (let tag = 0; tag < 3; tag++)
        expect(capture(ring, video, tag)).toEqual({
          kind: 'match',
          index: tag,
        });
      const lease = ring.reserveTags([0, 1, 2], 0)!;
      expect(lease.isValid()).toBe(true);
      expect(capture(ring, video, 3)).toEqual({ kind: 'backpressure' });
      expect(ring.hasTag(3, 0)).toBe(false);
      expect([0, 1, 2].every((tag) => ring.hasTag(tag, 0))).toBe(true);
      expect(closed()).toBe(4);
      video.timestamp = 5;
      expect(ring.readoutFrame(timing, 0)).toEqual({ kind: 'outside' });
      lease.release();
      lease.release();
      expect(capture(ring, video, 3)).toEqual({ kind: 'match', index: 3 });
      expect(budget.allocatedPixels).toBe(300);
    }));

  test('shared pins and callbacks retain backpressure until every owner releases', () =>
    fixture(({ ring, video, callbacks }) => {
      ring.allocate(10, 10);
      for (let tag = 0; tag < 3; tag++) capture(ring, video, tag);
      const first = ring.reserveTags([0, 1, 2], 0)!;
      const second = ring.reserveTags([0], 0)!;
      let blocked = 0;
      let failed = 0;
      ring.startCallbacks(
        timing,
        1,
        () => {
          failed++;
        },
        () => {
          blocked++;
        }
      );
      video.timestamp = 3;
      callbacks.get(1)!(1);
      expect(blocked).toBe(1);
      expect(failed).toBe(0);
      first.release();
      capture(ring, video, 3);
      expect(ring.hasTag(0, 0)).toBe(true);
      expect(second.isValid()).toBe(true);
      second.release();
    }));

  test('progress subscriptions wake on capture, backpressure and invalidation', () =>
    fixture(({ ring, video }) => {
      ring.allocate(10, 10);
      let calls = 0;
      const unsubscribe = ring.subscribeProgress(() => {
        calls++;
      });
      const unsubscribeThrowing = ring.subscribeProgress(() => {
        throw new Error('listener');
      });
      for (let tag = 0; tag < 3; tag++) capture(ring, video, tag);
      expect(calls).toBe(3);
      const lease = ring.reserveTags([0, 1, 2], 0)!;
      expect(capture(ring, video, 3)).toEqual({ kind: 'backpressure' });
      expect(calls).toBe(4);
      ring.resetEpoch(1);
      expect(calls).toBe(5);
      expect(lease.isValid()).toBe(false);
      unsubscribe();
      unsubscribe();
      unsubscribeThrowing();
      capture(ring, video, 0);
      expect(calls).toBe(5);
    }));

  test('native mode permits regression while switching mode seals the old epoch', () =>
    fixture(({ ring, video }) => {
      ring.allocate(10, 10);
      ring.setStrictProducerOrder(false);
      expect(capture(ring, video, 1)).toEqual({ kind: 'producer-fault' });
      ring.resetEpoch(1);
      expect(capture(ring, video, 1)).toEqual({ kind: 'match', index: 1 });
      expect(capture(ring, video, 0)).toEqual({ kind: 'match', index: 0 });
      expect(ring.highestObservedTag).toBe(1);
      ring.setStrictProducerOrder(true);
      expect(capture(ring, video, 0)).toEqual({ kind: 'producer-fault' });
      ring.resetEpoch(2);
      expect(capture(ring, video, 1)).toEqual({ kind: 'match', index: 1 });
      expect(capture(ring, video, 0)).toEqual({ kind: 'producer-fault' });
    }));

  test('paused seek ignores stale presented tag before its expected frame', () =>
    fixture(({ ring, video, closed }) => {
      ring.allocate(10, 10);
      video.timestamp = 1;
      expect(ring.capturePausedFrame(0, 0, timing)).toBe(false);
      expect(ring.highestObservedTag).toBeNull();
      expect(ring.hasTag(1, 0)).toBe(false);
      expect(closed()).toBe(1);
      video.timestamp = 0;
      expect(ring.capturePausedFrame(0, 0, timing)).toBe(true);
      expect(ring.highestObservedTag).toBe(0);
    }));

  test('observes actual tags under pressure and faults on regression until reset', () =>
    fixture(({ ring, video }) => {
      ring.allocate(10, 10);
      expect(ring.highestObservedTag).toBeNull();
      for (let tag = 0; tag < 3; tag++) capture(ring, video, tag);
      const lease = ring.reserveTags([0, 1, 2], 0)!;
      expect(capture(ring, video, 3)).toEqual({ kind: 'backpressure' });
      expect(ring.highestObservedTag).toBe(3);
      expect(capture(ring, video, 3)).toEqual({ kind: 'backpressure' });
      video.timestamp = 5;
      expect(ring.readoutFrame(timing, 0)).toEqual({ kind: 'outside' });
      expect(ring.highestObservedTag).toBe(3);
      expect(capture(ring, video, 2)).toEqual({ kind: 'producer-fault' });
      expect(ring.highestObservedTag).toBe(3);
      expect(lease.isValid()).toBe(false);
      expect(ring.reserveTags([0], 0)).toBeNull();
      expect(capture(ring, video, 3)).toEqual({ kind: 'producer-fault' });
      ring.resetEpoch(1);
      expect(ring.highestObservedTag).toBeNull();
      expect(capture(ring, video, 0)).toEqual({ kind: 'match', index: 0 });
      ring.release();
      expect(ring.highestObservedTag).toBeNull();
    }));

  test('validates element, path, dimensions, slot identity and notifies invalidation once', () =>
    fixture(({ ring, video, surfaces }) => {
      expect(ring.allocate(10, 10)).toBe(true);
      capture(ring, video, 0);
      const identity = {
        videoElement: video as unknown as HTMLVideoElement,
        bundlePath: 'clip.mov',
        width: 10,
        height: 10,
      };
      expect(
        ring.reserveTags([0], 0, { ...identity, bundlePath: 'other' })
      ).toBeNull();
      expect(ring.reserveTags([0], 0, { ...identity, width: 11 })).toBeNull();
      expect(
        ring.reserveTags([0], 0, {
          ...identity,
          videoElement: {} as HTMLVideoElement,
        })
      ).toBeNull();
      let invalidated = 0;
      const lease = ring.reserveTags([0], 0, {
        ...identity,
        onInvalidated: () => {
          invalidated++;
        },
      })!;
      surfaces[0]!.width = 11;
      expect(lease.isValid()).toBe(false);
      expect(lease.isValid()).toBe(false);
      expect(invalidated).toBe(1);
      lease.release();
    }));

  test('loss and reset explicitly invalidate while old releases cannot unpin replacement leases', () =>
    fixture(({ ring, video, surfaces }) => {
      ring.allocate(10, 10);
      capture(ring, video, 0);
      let invalidated = 0;
      const identity = {
        videoElement: video as unknown as HTMLVideoElement,
        bundlePath: 'clip.mov',
        width: 10,
        height: 10,
        onInvalidated: () => {
          invalidated++;
        },
      };
      const old = ring.reserveTags([0], 0, identity)!;
      ring.resetEpoch(1);
      expect(invalidated).toBe(1);
      capture(ring, video, 0);
      const replacement = ring.reserveTags([0], 1, identity)!;
      old.release();
      expect(replacement.isValid()).toBe(true);
      surfaces[0]!.lose();
      expect(invalidated).toBe(2);
      expect(replacement.isValid()).toBe(false);
    }));

  test('late cancelled callback cannot touch new callback or budget', () =>
    fixture(({ ring, budget, callbacks }) => {
      ring.allocate(10, 10);
      ring.startCallbacks(timing, 1, () => {});
      const stale = callbacks.get(1)!;
      ring.resetEpoch(1);
      ring.startCallbacks(timing, 1, () => {});
      stale(1);
      expect(ring.lastCallbackWallMs).toBeNull();
      expect(budget.allocatedPixels).toBe(300);
      callbacks.get(2)!(2);
      expect(ring.lastCallbackWallMs).toBe(2);
      expect(ring.hasTag(0, 1)).toBe(true);
      ring.release();
      callbacks.get(3)?.(3);
      expect(budget.allocatedPixels).toBe(0);
    }));

  test('draw failures do not create certified tags', () =>
    fixture(({ ring, video, surfaces }) => {
      ring.allocate(10, 10);
      surfaces[0]!.failDraw = true;
      expect(capture(ring, video, 0)).toEqual({ kind: 'readout-failed' });
      expect(ring.hasTag(0, 0)).toBe(false);
      expect(ring.reserveTags([0], 0)).toBeNull();
    }));
});
