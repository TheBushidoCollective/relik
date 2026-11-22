/**
 * Keeping two comparison panes on the same part of the document.
 *
 * Each `.compare-pane` is its own scroll container, in both the side-by-side
 * and the swipe layout. Independently scrolled, the two stop being a
 * comparison: side by side you end up reading section 12 against section 3,
 * and under the swipe, where the panes are overlaid and clipped, the revealed
 * strip shows a different part of the document than the strip it covers.
 *
 * The tree diff now supplies the smarter mapping this originally said did not
 * exist: one id shared by the two changed nodes it paired. Where a paired mark
 * is visible, that exact content lands at the same viewport top on both sides.
 * Between paired regions the mapping stays proportional rather than pixel for
 * pixel, because the two sides are different documents. A version that gained
 * a section is taller than the one it is compared against, so mirroring pixels
 * runs one pane out of scroll while the other still has room. Proportional is
 * also the fallback near either end, where putting a landmark at the requested
 * top can be physically impossible and the start and end invariants win.
 */

import type { ScrollLandmark, ScrollPosition } from './scroll-landmark.ts';

/** A scroll container, narrowed to what syncing actually reads and writes. */
export interface Scroller {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: 'scroll', listener: () => void): void;
  removeEventListener(type: 'scroll', listener: () => void): void;
}

/** Optional content-aware mapping layered over the proportional fallback. */
export interface LandmarkSync<T extends Scroller> {
  /** Nearest paired mark in the pane the reader moved. */
  read(pane: T): ScrollLandmark | undefined;
  /** True when this pane had the same mark and handled the position. */
  apply(pane: T, landmark: ScrollLandmark): boolean;
}

/** How far down its own travel a scroller sits, or null when it cannot move. */
export function scrollFraction(el: Scroller): number | null {
  const travel = el.scrollHeight - el.clientHeight;
  if (!(travel > 0)) return null;
  const clamped = Math.min(Math.max(el.scrollTop, 0), travel);
  return clamped / travel;
}

/** Put a scroller at a fraction of its own travel. A no-op when it cannot move. */
export function applyScrollFraction(el: Scroller, fraction: number): void {
  const travel = el.scrollHeight - el.clientHeight;
  if (!(travel > 0)) return;
  const bounded = Math.min(Math.max(fraction, 0), 1);
  el.scrollTop = Math.round(bounded * travel);
}

/**
 * Whether two positions are close enough to leave alone.
 *
 * Writing `scrollTop` rounds to whole pixels, and a fraction converted into
 * two differently sized panes and back does not land on the same number it
 * started from. Without a deadband each correction provokes the next one and
 * the panes creep while a reader watches.
 */
const SETTLED_PIXELS = 1;

/**
 * The default scheduler: the next animation frame, or a timer where there is
 * no window. Every syncer here runs its writes through it.
 */
function nextFrame(run: () => void): void {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  ) {
    window.requestAnimationFrame(run);
  } else if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

/**
 * Bind scrollers so that scrolling any one moves the rest to the same relative
 * position. Returns a teardown that unbinds every listener.
 *
 * Reciprocal feedback is the whole difficulty: moving a follower fires its own
 * scroll event, which would drive the pane that just drove it. So one element
 * holds the wheel for the duration of a frame, events from anything else are
 * ignored while it does, and writes are coalesced to one per frame because a
 * scroll gesture fires far more often than a browser paints.
 */
export function syncScrollers<T extends Scroller>(
  panes: readonly T[],
  schedule: (run: () => void) => void = nextFrame,
  landmarks?: LandmarkSync<T>
): () => void {
  if (panes.length < 2) return () => {};

  let driver: T | undefined;
  let queued = false;

  const follow = (): void => {
    queued = false;
    const leader = driver;
    if (leader === undefined) return;

    // The leader keeps the wheel until every write is done, and is released
    // only in the finally below. Clearing it first made each follower's own
    // scroll event look like a reader scrolling, which is the exact loop the
    // guard exists to stop.
    try {
      const fraction = scrollFraction(leader);
      if (fraction === null) return;
      const bounded = Math.min(Math.max(fraction, 0), 1);
      const landmark = landmarks?.read(leader);

      for (const pane of panes) {
        if (pane === leader) continue;
        // A paired changed node is the exact correspondence the visual diff
        // already established. A missing pair is not an error: additions,
        // deletions and stretches between changes use the fraction below.
        if (
          landmark !== undefined &&
          landmarks?.apply(pane, landmark) === true
        ) {
          continue;
        }
        const travel = pane.scrollHeight - pane.clientHeight;
        if (!(travel > 0)) continue;
        const target = Math.round(bounded * travel);
        // Only write a real move. An assignment that changes nothing still
        // fires a scroll event in some browsers, and the deadband is what
        // keeps a rounding difference from provoking the next correction.
        if (Math.abs(pane.scrollTop - target) > SETTLED_PIXELS) {
          pane.scrollTop = target;
        }
      }
    } finally {
      driver = undefined;
    }
  };

  const bound = panes.map((pane) => {
    const listener = (): void => {
      // A follower being moved is not a reader scrolling. Its event is the
      // echo of this frame's write.
      if (driver !== undefined && driver !== pane) return;
      driver = pane;
      if (queued) return;
      queued = true;
      schedule(follow);
    };
    pane.addEventListener('scroll', listener);
    return { pane, listener };
  });

  return () => {
    for (const { pane, listener } of bound) {
      pane.removeEventListener('scroll', listener);
    }
  };
}

/**
 * A sandboxed frame scroller that communicates through fractional scroll events
 * and commands across an opaque origin boundary.
 */
export interface FrameScroller {
  setScrollPosition(position: ScrollPosition): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * Whether two scroll fractions are close enough to leave alone.
 *
 * A difference smaller than half a thousandth is well below one pixel on any
 * practical viewport, and avoiding redundant writes keeps rounding jitter
 * from generating echo cycles across the postMessage bridge.
 */
const SETTLED_FRACTION = 0.001;

function positionsMatch(
  first: ScrollPosition,
  second: ScrollPosition,
  tolerance = 1
): boolean {
  if (
    first.landmark !== undefined &&
    second.landmark !== undefined &&
    first.landmark.id === second.landmark.id
  ) {
    return Math.abs(first.landmark.top - second.landmark.top) <= tolerance;
  }
  return (
    Math.abs(first.fraction - second.fraction) < SETTLED_FRACTION * tolerance
  );
}

/**
 * Bind sandboxed frame scrollers so that scrolling any one moves the other
 * to the same paired content position, with relative fraction as the fallback.
 * Returns a teardown that unbinds every listener.
 *
 * Like `syncScrollers`, this prefers paired content, retains proportional
 * mapping as the fallback, and guards against reciprocal feedback. Because postMessage is asynchronous across the opaque
 * frame boundary, the feedback guard tracks both the active driver during frame
 * scheduling and the expected echo fraction sent to each follower.
 */
export function syncFrameScrollers(
  panes: readonly FrameScroller[],
  schedule: (run: () => void) => void = nextFrame
): () => void {
  if (panes.length < 2) return () => {};

  let driver: FrameScroller | undefined;
  let latestPosition: ScrollPosition | null = null;
  let queued = false;
  const expectedEchoes = new Map<FrameScroller, ScrollPosition>();

  const follow = (): void => {
    queued = false;
    const leader = driver;
    const position = latestPosition;
    if (leader === undefined || position === null) return;

    try {
      const bounded: ScrollPosition = {
        fraction: Math.min(Math.max(position.fraction, 0), 1),
        ...(position.landmark === undefined
          ? {}
          : { landmark: position.landmark }),
      };

      for (const pane of panes) {
        if (pane === leader) continue;
        const lastSent = expectedEchoes.get(pane);
        if (lastSent !== undefined && positionsMatch(lastSent, bounded))
          continue;
        expectedEchoes.set(pane, bounded);
        pane.setScrollPosition(bounded);
      }
    } finally {
      driver = undefined;
      latestPosition = null;
    }
  };

  const bound = panes.map((pane) => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<ScrollPosition>>).detail;
      const frac = detail?.fraction;
      if (typeof frac !== 'number' || !Number.isFinite(frac)) return;
      const landmark = detail.landmark;
      const position: ScrollPosition = {
        fraction: frac,
        ...(landmark === undefined ? {} : { landmark }),
      };

      // An echo from a programmatic write to this follower is not a reader gesture.
      const expected = expectedEchoes.get(pane);
      if (expected !== undefined && positionsMatch(expected, position, 5)) {
        expectedEchoes.delete(pane);
        return;
      }
      expectedEchoes.delete(pane);
      driver = pane;
      latestPosition = position;
      if (queued) return;
      queued = true;
      schedule(follow);
    };
    pane.addEventListener('relic:frame-scroll', listener);
    return { pane, listener };
  });

  return () => {
    for (const { pane, listener } of bound) {
      pane.removeEventListener('relic:frame-scroll', listener);
    }
  };
}

/** A scroll position, as a mirror records what it wrote. */
interface ScrollOffset {
  readonly top: number;
  readonly left: number;
}

/**
 * Keeps identical scrollers at the same `scrollTop` and `scrollLeft`.
 *
 * Two grids drawn from one width plan have the same geometry, so the exact
 * position is the right correspondence. `syncScrollers` maps proportionally,
 * because its two sides are different documents.
 *
 * The feedback guards are those of `syncScrollers`. The first pane to report a
 * scroll drives the frame, and the other panes' events are ignored until that
 * frame has written. A write is remembered as the position the pane landed at,
 * so the scroll event the write causes is not taken for a reader's gesture. The
 * landed position is read back, so a pane the browser clamps still recognises
 * its own echo. The teardown unbinds every listener and drops a write still
 * pending.
 */
export function mirrorScrollers(
  panes: readonly HTMLElement[],
  schedule: (run: () => void) => void = nextFrame
): () => void {
  if (panes.length < 2) return () => {};

  let driver: HTMLElement | undefined;
  let queued = false;
  let disposed = false;
  const echoes = new Map<HTMLElement, ScrollOffset>();

  const follow = (): void => {
    queued = false;
    const leader = driver;
    driver = undefined;
    if (leader === undefined || disposed) return;
    const top = leader.scrollTop;
    const left = leader.scrollLeft;
    for (const pane of panes) {
      if (pane === leader) continue;
      const fromTop = pane.scrollTop;
      const fromLeft = pane.scrollLeft;
      if (fromTop === top && fromLeft === left) {
        echoes.delete(pane);
        continue;
      }
      pane.scrollTop = top;
      pane.scrollLeft = left;
      const landedTop = pane.scrollTop;
      const landedLeft = pane.scrollLeft;
      if (landedTop !== fromTop || landedLeft !== fromLeft) {
        echoes.set(pane, { top: landedTop, left: landedLeft });
      } else {
        echoes.delete(pane);
      }
    }
  };

  const bound = panes.map((pane) => {
    const listener = (): void => {
      const echo = echoes.get(pane);
      if (echo !== undefined) {
        echoes.delete(pane);
        if (pane.scrollTop === echo.top && pane.scrollLeft === echo.left) {
          return;
        }
      }
      // While a frame is pending its driver owns the wheel. Other panes'
      // events in that window are the echoes of the frame's own writes.
      if (driver !== undefined && driver !== pane) return;
      driver = pane;
      if (queued) return;
      queued = true;
      schedule(follow);
    };
    pane.addEventListener('scroll', listener);
    return { pane, listener };
  });

  return () => {
    disposed = true;
    echoes.clear();
    for (const { pane, listener } of bound) {
      pane.removeEventListener('scroll', listener);
    }
  };
}
