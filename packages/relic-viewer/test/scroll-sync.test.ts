/**
 * Tests for keeping two comparison panes on the same part of the document.
 *
 * The stub dispatches a scroll event on every write to `scrollTop`, which is
 * what a browser does and what makes this worth testing: a naive mirror feeds
 * itself, and a test whose stub stays silent would pass on code that loops
 * forever in a real page.
 */

import { describe, expect, test } from 'bun:test';
import { diffModeForRoute } from '../src/diff.ts';
import {
  isFrameScrollMessage,
  isSetScrollMessage,
} from '../src/frame-scroll.ts';
import { renderCodeComparison, renderRenderedComparison } from '../src/main.ts';
import {
  applyDocumentScrollFraction,
  applyDocumentScrollPosition,
  createSandboxHandler,
  documentScrollFraction,
  documentScrollPosition,
  setupFrameInteraction,
} from '../src/sandbox.ts';
import {
  landmarkScrollDelta,
  nearestScrollLandmark,
  type ScrollLandmark,
} from '../src/scroll-landmark.ts';
import {
  applyScrollFraction,
  type FrameScroller,
  type Scroller,
  scrollFraction,
  syncFrameScrollers,
  syncScrollers,
} from '../src/scroll-sync.ts';
import type { ReadyView } from '../src/viewer.ts';

/** A scroll container that announces its own movement, as a browser does. */
class ScrollerStub implements Scroller {
  private position = 0;
  private readonly listeners: (() => void)[] = [];
  /** Every write, so a test can see thrash rather than only its outcome. */
  readonly writes: number[] = [];

  constructor(
    readonly scrollHeight: number,
    readonly clientHeight: number
  ) {}

  get scrollTop(): number {
    return this.position;
  }

  set scrollTop(next: number) {
    this.position = next;
    this.writes.push(next);
    for (const listener of [...this.listeners]) listener();
  }

  addEventListener(_type: 'scroll', listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: 'scroll', listener: () => void): void {
    const at = this.listeners.indexOf(listener);
    if (at !== -1) this.listeners.splice(at, 1);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/** A sandboxed frame scroller stub that communicates by fractional scroll events and commands. */
class FrameScrollerStub implements FrameScroller {
  private fraction = 0;
  private readonly listeners: ((event: Event) => void)[] = [];
  readonly writes: number[] = [];
  readonly positionWrites: {
    fraction: number;
    landmark?: { id: string; top: number };
  }[] = [];

  get currentFraction(): number {
    return this.fraction;
  }

  setScrollPosition(position: {
    fraction: number;
    landmark?: { id: string; top: number };
  }): void {
    this.fraction = position.fraction;
    this.writes.push(position.fraction);
    this.positionWrites.push(position);
  }

  emitScroll(fraction: number, landmark?: { id: string; top: number }): void {
    this.fraction = fraction;
    // A plain object rather than `new CustomEvent`. Bun's test runtime has no
    // DOM: this passed locally only because another test file registers DOM
    // globals and the runner happened to load it first, and it failed in CI
    // with "CustomEvent is not defined". The listener reads `type` and
    // `detail` and nothing else, so the shape is the whole contract.
    const event = {
      type: 'relic:frame-scroll',
      detail: { fraction, ...(landmark === undefined ? {} : { landmark }) },
    } as unknown as Event;
    for (const listener of [...this.listeners]) listener(event);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (type === 'relic:frame-scroll') this.listeners.push(listener);
  }

  removeEventListener(_type: string, listener: (event: Event) => void): void {
    const at = this.listeners.indexOf(listener);
    if (at !== -1) this.listeners.splice(at, 1);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

class ElementStub implements Scroller {
  readonly tagName: string;
  className = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  min = '';
  max = '';
  private _scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 500;

  get scrollTop(): number {
    return this._scrollTop;
  }

  set scrollTop(val: number) {
    this._scrollTop = val;
    for (const listener of [...(this.listeners['scroll'] ?? [])]) listener();
  }
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = {
    setProperty: (name: string, val: string): void => {
      (this.style as Record<string, string>)[name] = val;
    },
  };
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(' ')
        .filter((c) => c !== name)
        .join(' ');
    },
    contains: (name: string): boolean => {
      return this.className.split(' ').includes(name);
    },
    toggle: (name: string, force?: boolean): boolean => {
      const exists = this.className.split(' ').includes(name);
      const next = force !== undefined ? force : !exists;
      if (next) {
        if (!exists) this.className = `${this.className} ${name}`.trim();
      } else {
        this.className = this.className
          .split(' ')
          .filter((c) => c !== name)
          .join(' ');
      }
      return next;
    },
  };
  readonly listeners: Record<string, ((event?: unknown) => void)[]> = {};
  readonly postedMessages: unknown[] = [];
  contentWindow?: { postMessage: (msg: unknown) => void };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    if (this.tagName === 'IFRAME') {
      this.contentWindow = {
        postMessage: (msg: unknown) => {
          this.postedMessages.push(msg);
        },
      };
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  append(...children: ElementStub[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners[type] ?? [];
    list.push(listener);
    this.listeners[type] = list;
  }

  removeEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners[type];
    if (list === undefined) return;
    const at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
  }

  dispatchEvent(event: { type: string; detail?: unknown }): boolean {
    const list = this.listeners[event.type];
    if (list) {
      for (const listener of [...list]) listener(event);
    }
    return true;
  }

  click(): void {
    for (const listener of this.listeners['click'] ?? []) {
      listener({ target: this, preventDefault: () => {} });
    }
  }
}

const encoder = new TextEncoder();

function testView(
  route: ReadyView['route'],
  version: number,
  content: Uint8Array = encoder.encode('const current = true;\n'),
  currentVersion = version
): ReadyView {
  return {
    filename: route === 'download' ? 'archive.zip' : 'notes.md',
    declaredMimetype: route === 'markdown' ? 'text/markdown' : 'text/plain',
    content,
    route,
    downgradeNotice: undefined,
    shareUrl: 'https://relik.example/test#key',
    version,
    currentVersion,
    versionDigest: '0'.repeat(64),
  };
}

function withDocument<T>(run: (flushFrames: () => void) => T): T {
  const prevDoc = (globalThis as Record<string, unknown>).document;
  const prevRaf = (globalThis as Record<string, unknown>).requestAnimationFrame;
  const prevWin = (globalThis as Record<string, unknown>).window;
  const body = new ElementStub('BODY');
  let rafQueue: (() => void)[] = [];
  const flushFrames = (): void => {
    const due = rafQueue;
    rafQueue = [];
    for (const f of due) f();
  };
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1180,
    innerHeight: 773,
    requestAnimationFrame: (cb: () => void) => rafQueue.push(cb),
  };
  (globalThis as { document?: unknown }).document = {
    body,
    documentElement: {
      style: {
        setProperty: () => {},
        getPropertyValue: () => '',
      },
    },
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: () => void
  ) => {
    rafQueue.push(cb);
  };
  try {
    return run(flushFrames);
  } finally {
    (globalThis as Record<string, unknown>).document = prevDoc;
    (globalThis as Record<string, unknown>).window = prevWin;
    (globalThis as Record<string, unknown>).requestAnimationFrame = prevRaf;
  }
}

function descendants(element: ElementStub): ElementStub[] {
  return [element, ...element.children.flatMap(descendants)];
}

function withClass(element: ElementStub, name: string): ElementStub[] {
  return descendants(element).filter((candidate) =>
    candidate.className.split(' ').includes(name)
  );
}

function comparisonLayoutFaults(source: string): readonly string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const faults: string[] = [];
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      new RegExp(`${escaped}\\s*(,[^{]*)?\\{([^}]*)\\}`).exec(css)?.[2] ?? ''
    );
  };

  const stageDiff = rule('.stage-diff');
  const splitStage = rule(".compare-stage[data-layout='split']");
  const swipeStage = rule(".compare-stage[data-layout='swipe']");
  const comparePane = rule('.compare-pane');
  const threadInDiff = rule('.diff-row .thread');

  if (
    !/min-width:\s*min\(100%,\s*28rem\)/.test(stageDiff) &&
    !/min-width:\s*28rem/.test(stageDiff)
  ) {
    faults.push(
      'stage-diff has no legible minimum width to protect against collapse'
    );
  }
  if (!/flex:\s*0\s+1\s+auto/.test(threadInDiff)) {
    faults.push(
      'thread in diff-row refuses to shrink, crushing the comparison stage'
    );
  }
  if (!/max-width:\s*calc\(100%\s*-\s*28rem\)/.test(threadInDiff)) {
    faults.push(
      'thread in diff-row has no max-width bound leaving room for stage-diff'
    );
  }
  // The ceiling alone left the sidebar whatever was spare, which measured
  // 167px at a 1180 viewport with two dozen of its own children overflowing.
  // A bound needs a floor at both ends or it just moves the crush.
  if (!/min-width:\s*18rem/.test(threadInDiff)) {
    faults.push(
      'thread in diff-row has no legible minimum, so the spare width crushes it'
    );
  }
  if (!/grid-template-rows:\s*minmax\(0,\s*1fr\)/.test(splitStage)) {
    faults.push(
      'split comparison stage has no row constraint, expanding to max-content'
    );
  }
  if (!/grid-template-rows:\s*minmax\(0,\s*1fr\)/.test(swipeStage)) {
    faults.push(
      'swipe comparison stage has no row constraint, expanding to max-content'
    );
  }
  if (!/min-height:\s*0/.test(comparePane)) {
    faults.push(
      'compare-pane has no min-height zero to shrink inside grid track'
    );
  }
  if (!/height:\s*100%/.test(comparePane)) {
    faults.push('compare-pane does not take full height of grid track');
  }

  // Every change list lands in a sidebar a reader can drag to 230px. Three
  // fixed columns there left the quote about six pixels, which broke one
  // character per line into a row 995px tall, so the quote takes its own
  // line and stops after three of them.
  const changeRow = rule('.diff-change');
  const changeDetail = rule('.diff-change-detail');
  if (/grid-template-columns:[^;]*7rem/.test(changeRow)) {
    faults.push(
      'change row takes a third fixed column, collapsing the quote to nothing'
    );
  }
  if (!/grid-column:\s*1\s*\/\s*-1/.test(changeDetail)) {
    faults.push(
      'change quote shares a row with its label instead of taking one'
    );
  }
  if (!/line-clamp:\s*3/.test(changeDetail)) {
    faults.push(
      'change quote is unclamped, so one long paragraph becomes a scroll'
    );
  }
  // A changed row carries both texts. Clamping the cell showed three lines
  // of struck-through old text and none of what it became.
  const changedDetail = rule('.diff-change-changed .diff-change-detail');
  const sides = rule('.diff-change-detail del');
  if (!/overflow:\s*visible/.test(changedDetail)) {
    faults.push(
      'changed row clamps the cell, hiding the text the change produced'
    );
  }
  if (!/line-clamp:\s*2/.test(sides)) {
    faults.push('the two sides of a changed row are not each bounded');
  }
  return faults;
}

/** Runs scheduled work on demand, so a test decides when a frame happens. */
function manualFrames(): {
  schedule: (run: () => void) => void;
  flush: () => void;
  pending: () => number;
} {
  let queue: (() => void)[] = [];
  return {
    schedule: (run) => queue.push(run),
    flush: () => {
      const due = queue;
      queue = [];
      for (const run of due) run();
    },
    pending: () => queue.length,
  };
}

describe('scrollFraction', () => {
  test('reports position as a share of the travel available', () => {
    expect(scrollFraction(new ScrollerStub(2000, 1000))).toBe(0);
    const half = new ScrollerStub(2000, 1000);
    half.scrollTop = 500;
    expect(scrollFraction(half)).toBe(0.5);
    const end = new ScrollerStub(2000, 1000);
    end.scrollTop = 1000;
    expect(scrollFraction(end)).toBe(1);
  });

  test('a pane with nothing to scroll has no position, rather than zero', () => {
    // Zero would be a lie a caller cannot distinguish from "at the top", and
    // it would drag the other pane to the top every time it was read.
    expect(scrollFraction(new ScrollerStub(800, 800))).toBeNull();
    expect(scrollFraction(new ScrollerStub(600, 800))).toBeNull();
  });

  test('a position past either end reads as that end', () => {
    const over = new ScrollerStub(2000, 1000);
    over.scrollTop = 5000;
    expect(scrollFraction(over)).toBe(1);
    const under = new ScrollerStub(2000, 1000);
    under.scrollTop = -40;
    expect(scrollFraction(under)).toBe(0);
  });
});

describe('applyScrollFraction', () => {
  test('places a pane at a share of its own travel', () => {
    const pane = new ScrollerStub(3000, 1000);
    applyScrollFraction(pane, 0.5);
    expect(pane.scrollTop).toBe(1000);
    applyScrollFraction(pane, 1);
    expect(pane.scrollTop).toBe(2000);
  });

  test('a pane with nothing to scroll is left alone', () => {
    const pane = new ScrollerStub(500, 900);
    applyScrollFraction(pane, 0.7);
    expect(pane.writes).toEqual([]);
  });
});

describe('paired scroll landmarks', () => {
  const node = (id: string, top: number, height = 40) => ({
    getAttribute: (name: string) => (name === 'data-relic-sync-id' ? id : null),
    getBoundingClientRect: () => ({ top, bottom: top + height }),
  });

  test('selects the paired mark nearest the viewport top', () => {
    const root = {
      querySelectorAll: () => [
        node('d0', -180, 30),
        node('d1', 96, 50),
        node('d2', 600, 40),
      ],
    };
    expect(nearestScrollLandmark(root)).toEqual({ id: 'd1', top: 96 });
  });

  test('a tall container crossing the top does not beat a nearer node top', () => {
    const root = {
      querySelectorAll: () => [node('d0', -180, 420), node('d1', 20, 40)],
    };
    expect(nearestScrollLandmark(root)).toEqual({ id: 'd1', top: 20 });
  });

  test('a message carrying an anchor is accepted, not dropped', () => {
    // The guard only knew the changed-pair namespace, so every message
    // carrying an anchor was refused and the follower sat still while the
    // leader scrolled. Anchors are most messages now.
    expect(
      isFrameScrollMessage({
        type: 'relic:frame-scroll',
        fraction: 0.5,
        landmark: { id: 'a24', top: -23.6 },
      })
    ).toBe(true);
    expect(
      isSetScrollMessage({
        type: 'relic:set-scroll',
        fraction: 0.5,
        landmark: { id: 'd3', top: 12 },
      })
    ).toBe(true);
    // Still refused: an id from no namespace this diff mints.
    expect(
      isFrameScrollMessage({
        type: 'relic:frame-scroll',
        fraction: 0.5,
        landmark: { id: 'x1', top: 0 },
      })
    ).toBe(false);
  });

  test('an unchanged paragraph anchors a version that only added at the top', () => {
    // The reader's case: two paragraphs inserted at the top, nothing else
    // touched. The only change is off screen above, and what is in front of
    // the reader is unchanged content, which is exactly what the anchors
    // give the follower to resolve.
    const leader = {
      querySelectorAll: () => [node('d0', -400, 60), node('a4', 120, 40)],
    };
    const follower = { querySelectorAll: () => [node('a4', 300, 40)] };
    const landmark = nearestScrollLandmark(leader);
    expect(landmark).toEqual({ id: 'a4', top: 120 });
    // 180 pixels of correction: precisely the insertion the fraction would
    // have smeared across the whole document.
    expect(
      landmarkScrollDelta(follower, landmark as { id: string; top: number })
    ).toBe(180);
  });

  test('computes the correction from the follower mark, not page height', () => {
    const root = { querySelectorAll: () => [node('d7', 148, 80)] };
    expect(landmarkScrollDelta(root, { id: 'd7', top: 103 })).toBe(45);
    expect(landmarkScrollDelta(root, { id: 'missing', top: 103 })).toBeNull();
  });
});

describe('syncScrollers', () => {
  test('scrolling one pane moves the other to the same relative position', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    left.scrollTop = 1500;
    frames.flush();

    // Half of the left pane's 3000 of travel, so half of the right pane's 2000.
    expect(scrollFraction(left)).toBe(0.5);
    expect(right.scrollTop).toBe(1000);
  });

  test('either pane can drive', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    right.scrollTop = 2000;
    frames.flush();
    expect(left.scrollTop).toBe(3000);
  });

  test('the ends line up, which pixel mirroring cannot do', () => {
    // The reported case: a version that gained a section is taller than the
    // one it is compared against.
    const frames = manualFrames();
    const longer = new ScrollerStub(5000, 1000);
    const shorter = new ScrollerStub(2000, 1000);
    syncScrollers([longer, shorter], frames.schedule);

    longer.scrollTop = 4000;
    frames.flush();

    expect(scrollFraction(longer)).toBe(1);
    expect(shorter.scrollTop).toBe(1000);
    expect(scrollFraction(shorter)).toBe(1);
  });

  test('following a pane does not drive it back', () => {
    // The stub fires a scroll event on every write, so an unguarded mirror
    // ping-pongs. Each pane is written at most once for one gesture.
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    left.scrollTop = 900;
    frames.flush();

    // The follower's own scroll event arrived during that flush. Nothing may
    // be waiting on the next frame because of it: without the guard the echo
    // schedules another pass, so a continuous gesture pays for two frames of
    // work per frame of movement.
    expect(frames.pending()).toBe(0);

    frames.flush();
    expect(right.writes).toHaveLength(1);
    expect(left.writes).toEqual([900]);
  });

  test('a burst of scroll events costs one write per pane, not one per event', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    syncScrollers([left, right], frames.schedule);

    // A real gesture fires far more often than the browser paints.
    for (const top of [100, 200, 300, 400, 500]) left.scrollTop = top;
    expect(frames.pending()).toBe(1);
    frames.flush();

    expect(right.writes).toHaveLength(1);
    // The last position wins, not the first.
    expect(right.scrollTop).toBe(Math.round((500 / 3000) * 2000));
  });

  test('a pane already at the target is not written at all', () => {
    // Two versions of similar length put the follower where it already is.
    // Writing anyway fires a scroll event for no movement, which is work per
    // frame that buys nothing and is one rounding error away from a loop.
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(4000, 1000);
    syncScrollers([left, right], frames.schedule);

    right.scrollTop = 1500;
    frames.flush();
    const writesBefore = right.writes.length;

    left.scrollTop = 1500;
    frames.flush();

    expect(right.writes).toHaveLength(writesBefore);
    expect(right.scrollTop).toBe(1500);
  });

  test('a pane that cannot scroll is skipped rather than reset', () => {
    const frames = manualFrames();
    const tall = new ScrollerStub(4000, 1000);
    const flat = new ScrollerStub(700, 1000);
    syncScrollers([tall, flat], frames.schedule);

    tall.scrollTop = 1500;
    frames.flush();

    expect(flat.writes).toEqual([]);
  });

  test('teardown unbinds every listener', () => {
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(3000, 1000);
    const stop = syncScrollers([left, right], manualFrames().schedule);

    expect(left.listenerCount).toBe(1);
    expect(right.listenerCount).toBe(1);

    stop();
    expect(left.listenerCount).toBe(0);
    expect(right.listenerCount).toBe(0);
  });

  test('a single pane binds nothing, so a one-sided view costs no listener', () => {
    const only = new ScrollerStub(4000, 1000);
    syncScrollers([only], manualFrames().schedule);
    expect(only.listenerCount).toBe(0);
  });
});

describe('content-aware pane syncing', () => {
  test('a paired changed node outranks the proportional page fraction', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(6000, 1000);
    const handled: ScrollLandmark[] = [];
    syncScrollers([left, right], frames.schedule, {
      read: () => ({ id: 'd2', top: 84 }),
      apply: (pane, landmark) => {
        if (pane !== right) return false;
        handled.push(landmark);
        pane.scrollTop = 2316;
        return true;
      },
    });

    left.scrollTop = 1500;
    frames.flush();

    expect(handled).toEqual([{ id: 'd2', top: 84 }]);
    expect(right.scrollTop).toBe(2316);
    // Pure proportional mapping would have put this 184px lower.
    expect(right.scrollTop).not.toBe(2500);
  });

  test('missing paired mark falls back to proportional mapping', () => {
    const frames = manualFrames();
    const left = new ScrollerStub(4000, 1000);
    const right = new ScrollerStub(6000, 1000);
    syncScrollers([left, right], frames.schedule, {
      read: () => ({ id: 'd9', top: 40 }),
      apply: () => false,
    });

    left.scrollTop = 1500;
    frames.flush();
    expect(right.scrollTop).toBe(2500);
  });
});

describe('syncFrameScrollers', () => {
  test('forwards the paired landmark with its exact viewport top', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    left.emitScroll(0.5, { id: 'd3', top: 112 });
    frames.flush();

    expect(right.positionWrites).toEqual([
      { fraction: 0.5, landmark: { id: 'd3', top: 112 } },
    ]);
  });

  test('an asynchronous landmark echo does not drive the leader back', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    left.emitScroll(0.4, { id: 'd1', top: 90 });
    frames.flush();
    right.emitScroll(0.63, { id: 'd1', top: 91 });
    frames.flush();

    expect(left.positionWrites).toHaveLength(0);
    expect(right.positionWrites).toHaveLength(1);
  });

  test('scrolling one frame moves the other to the same relative fraction', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    left.emitScroll(0.5);
    frames.flush();

    expect(right.currentFraction).toBe(0.5);
    expect(right.writes).toEqual([0.5]);
  });

  test('either frame can drive', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    right.emitScroll(0.75);
    frames.flush();

    expect(left.currentFraction).toBe(0.75);
    expect(left.writes).toEqual([0.75]);
  });

  test('the ends line up at fraction 0 and 1', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    left.emitScroll(1.0);
    frames.flush();
    expect(right.currentFraction).toBe(1.0);

    left.emitScroll(0.0);
    frames.flush();
    expect(right.currentFraction).toBe(0.0);
  });

  test('following a frame does not drive it back', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    left.emitScroll(0.4);
    frames.flush();

    // Echo from follower should be ignored
    right.emitScroll(0.4);
    frames.flush();

    expect(frames.pending()).toBe(0);
    expect(left.writes).toHaveLength(0);
    expect(right.writes).toHaveLength(1);
  });

  test('a burst of scroll events costs one write per follower, with the last fraction winning', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    for (const f of [0.1, 0.2, 0.3, 0.4, 0.5]) left.emitScroll(f);
    expect(frames.pending()).toBe(1);
    frames.flush();

    expect(right.writes).toHaveLength(1);
    expect(right.currentFraction).toBe(0.5);
  });

  test('a frame already at the target fraction is not written at all', () => {
    const frames = manualFrames();
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    syncFrameScrollers([left, right], frames.schedule);

    right.emitScroll(0.6);
    frames.flush();
    const writesBefore = right.writes.length;

    left.emitScroll(0.6);
    frames.flush();

    expect(right.writes).toHaveLength(writesBefore);
  });

  test('teardown unbinds every listener', () => {
    const left = new FrameScrollerStub();
    const right = new FrameScrollerStub();
    const stop = syncFrameScrollers([left, right], manualFrames().schedule);

    expect(left.listenerCount).toBe(1);
    expect(right.listenerCount).toBe(1);

    stop();
    expect(left.listenerCount).toBe(0);
    expect(right.listenerCount).toBe(0);
  });

  test('a single frame binds nothing', () => {
    const only = new FrameScrollerStub();
    syncFrameScrollers([only], manualFrames().schedule);
    expect(only.listenerCount).toBe(0);
  });
});

describe('frame scroll message contract', () => {
  test('isSetScrollMessage validates correct payloads and rejects malformed ones', () => {
    expect(
      isSetScrollMessage({ type: 'relic:set-scroll', fraction: 0.5 })
    ).toBe(true);
    expect(isSetScrollMessage({ type: 'relic:set-scroll', fraction: 0 })).toBe(
      true
    );
    expect(isSetScrollMessage({ type: 'relic:set-scroll', fraction: 1 })).toBe(
      true
    );
    expect(
      isSetScrollMessage({
        type: 'relic:set-scroll',
        fraction: 0.42,
        landmark: { id: 'd4', top: 116 },
      })
    ).toBe(true);
    expect(
      isSetScrollMessage({
        type: 'relic:set-scroll',
        fraction: 0.42,
        landmark: { id: '<script>', top: 116 },
      })
    ).toBe(false);
    expect(
      isSetScrollMessage({
        type: 'relic:set-scroll',
        fraction: 0.42,
        landmark: { id: 'd4', top: Number.NaN },
      })
    ).toBe(false);

    expect(isSetScrollMessage(null)).toBe(false);
    expect(isSetScrollMessage(undefined)).toBe(false);
    expect(isSetScrollMessage('not an object')).toBe(false);
    expect(isSetScrollMessage(12345)).toBe(false);
    expect(isSetScrollMessage({ type: 'relic:set-scroll' })).toBe(false);
    expect(
      isSetScrollMessage({ type: 'relic:set-scroll', fraction: '0.5' })
    ).toBe(false);
    expect(
      isSetScrollMessage({ type: 'relic:set-scroll', fraction: Number.NaN })
    ).toBe(false);
    expect(
      isSetScrollMessage({
        type: 'relic:set-scroll',
        fraction: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
    expect(
      isSetScrollMessage({ type: 'relic:wrong-type', fraction: 0.5 })
    ).toBe(false);
  });

  test('isFrameScrollMessage validates correct payloads and rejects malformed ones', () => {
    expect(
      isFrameScrollMessage({ type: 'relic:frame-scroll', fraction: 0.5 })
    ).toBe(true);
    expect(
      isFrameScrollMessage({ type: 'relic:frame-scroll', fraction: 0 })
    ).toBe(true);
    expect(
      isFrameScrollMessage({
        type: 'relic:frame-scroll',
        fraction: 0.25,
        landmark: { id: 'd1', top: -18 },
      })
    ).toBe(true);
    expect(
      isFrameScrollMessage({
        type: 'relic:frame-scroll',
        fraction: 0.25,
        landmark: { id: 'bad', top: -18 },
      })
    ).toBe(false);

    expect(isFrameScrollMessage(null)).toBe(false);
    expect(isFrameScrollMessage(undefined)).toBe(false);
    expect(isFrameScrollMessage('not an object')).toBe(false);
    expect(isFrameScrollMessage({ type: 'relic:frame-scroll' })).toBe(false);
    expect(
      isFrameScrollMessage({ type: 'relic:frame-scroll', fraction: '0.5' })
    ).toBe(false);
    expect(
      isFrameScrollMessage({ type: 'relic:frame-scroll', fraction: Number.NaN })
    ).toBe(false);
  });

  test('sandbox handler processes valid set-scroll message and applies fraction', () => {
    let received:
      | { fraction: number; landmark?: { id: string; top: number } }
      | undefined;
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: () => true,
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
        onSetScroll: (position) => {
          received = position;
        },
      }
    );

    handle({ type: 'relic:render', html: '<p>ok</p>' });
    const accepted = handle({
      type: 'relic:set-scroll',
      fraction: 0.75,
      landmark: { id: 'd2', top: 88 },
    });
    expect(accepted).toBe(true);
    expect(received).toEqual({
      fraction: 0.75,
      landmark: { id: 'd2', top: 88 },
    });
  });

  test('sandbox handler rejects malformed set-scroll messages without invoking setScroll', () => {
    let invoked = false;
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: () => true,
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
        onSetScroll: () => {
          invoked = true;
        },
      }
    );

    handle({ type: 'relic:render', html: '<p>ok</p>' });
    expect(handle({ type: 'relic:set-scroll', fraction: 'malformed' })).toBe(
      false
    );
    expect(handle({ type: 'relic:set-scroll', fraction: Number.NaN })).toBe(
      false
    );
    expect(handle({ type: 'relic:set-scroll' })).toBe(false);
    expect(invoked).toBe(false);
  });
  test('documentScrollFraction computes fraction and returns null when travel <= 0', () => {
    const doc = {
      scrollingElement: {
        scrollHeight: 2000,
        clientHeight: 1000,
        scrollTop: 500,
      },
      documentElement: {
        scrollHeight: 2000,
        clientHeight: 1000,
        scrollTop: 500,
      },
      body: { scrollHeight: 2000, scrollTop: 500 },
    } as unknown as Document;
    const win = { innerHeight: 1000, scrollY: 500 } as unknown as Window;

    expect(documentScrollFraction(doc, win)).toBe(0.5);

    const flatDoc = {
      scrollingElement: { scrollHeight: 800, clientHeight: 1000, scrollTop: 0 },
      documentElement: { scrollHeight: 800, clientHeight: 1000, scrollTop: 0 },
      body: { scrollHeight: 800, scrollTop: 0 },
    } as unknown as Document;
    expect(documentScrollFraction(flatDoc, win)).toBeNull();
  });

  test('document scroll position aligns the paired mark before fraction', () => {
    let scrolledTo = 500;
    const changed = {
      getAttribute: (name: string) =>
        name === 'data-relic-sync-id' ? 'd6' : null,
      getBoundingClientRect: () => ({ top: 170, bottom: 230 }),
    };
    const doc = {
      scrollingElement: {
        scrollHeight: 4000,
        clientHeight: 1000,
        scrollTop: 500,
      },
      documentElement: {
        scrollHeight: 4000,
        clientHeight: 1000,
        scrollTop: 500,
      },
      body: { scrollHeight: 4000, scrollTop: 500 },
      querySelectorAll: () => [changed],
    } as unknown as Document;
    const win = {
      innerHeight: 1000,
      scrollY: 500,
      scrollTo: (options: { top: number }) => {
        scrolledTo = options.top;
      },
    } as unknown as Window;

    expect(documentScrollPosition(doc, win)).toEqual({
      fraction: 1 / 6,
      landmark: { id: 'd6', top: 170 },
    });

    applyDocumentScrollPosition(doc, win, {
      fraction: 0.9,
      landmark: { id: 'd6', top: 112 },
    });
    // Exact landmark correction: 500 + (170 - 112). Fraction fallback would
    // have jumped to 2700 instead.
    expect(scrolledTo).toBe(558);

    applyDocumentScrollPosition(doc, win, {
      fraction: 0.9,
      landmark: { id: 'd6', top: 1000 },
    });
    // Putting a mark currently at 170px down at 1000px would need a negative
    // scroll position. That is impossible, so the ends-safe fallback wins.
    expect(scrolledTo).toBe(2700);
  });

  test('applyDocumentScrollFraction positions document at fraction', () => {
    let scrolledTo = 0;
    const doc = {
      scrollingElement: {
        scrollHeight: 3000,
        clientHeight: 1000,
        scrollTop: 0,
      },
      documentElement: { scrollHeight: 3000, clientHeight: 1000, scrollTop: 0 },
      body: { scrollHeight: 3000, scrollTop: 0 },
    } as unknown as Document;
    const win = {
      innerHeight: 1000,
      scrollY: 0,
      scrollTo: (opts: { top: number }) => {
        scrolledTo = opts.top;
      },
    } as unknown as Window;

    applyDocumentScrollFraction(doc, win, 0.5);
    expect(scrolledTo).toBe(1000);
  });

  test('setupFrameInteraction emits frame-scroll on window scroll and suppresses on setScroll', () => {
    let timerCb: (() => void) | undefined;
    const posted: object[] = [];
    const listeners: Record<string, (() => void)[]> = {};
    const win = {
      innerHeight: 1000,
      scrollY: 500,
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listeners[type] ?? [];
        listeners[type].push(listener);
      },
      scrollTo: (opts: { top: number }) => {
        (win as unknown as { scrollY: number }).scrollY = opts.top;
      },
      setTimeout: (cb: () => void) => {
        timerCb = cb;
        return 1;
      },
      clearTimeout: () => {
        timerCb = undefined;
      },
    } as unknown as Window;

    const doc = {
      scrollingElement: {
        scrollHeight: 3000,
        clientHeight: 1000,
        scrollTop: 500,
      },
      documentElement: {
        scrollHeight: 3000,
        clientHeight: 1000,
        scrollTop: 500,
        classList: { toggle: () => {} },
      },
      body: { scrollHeight: 3000, scrollTop: 500 },
      addEventListener: () => {},
    } as unknown as Document;

    const interaction = setupFrameInteraction(doc, win, (msg) =>
      posted.push(msg)
    );

    // User scroll triggers outward message
    for (const listener of listeners['scroll'] ?? []) listener();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: 'relic:frame-scroll', fraction: 0.25 });

    // Programmatic onSetScroll sets position and suppresses echo while timer is pending
    posted.length = 0;
    interaction.onSetScroll?.({ fraction: 0.75 });
    for (const listener of listeners['scroll'] ?? []) listener();
    expect(posted).toHaveLength(0);

    // Once timer fires, suppression clears and user scroll works again
    timerCb?.();
    for (const listener of listeners['scroll'] ?? []) listener();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: 'relic:frame-scroll', fraction: 0.75 });
  });
});

describe('scroller inventory across rendering modes', () => {
  test('establishes which modes actually have independent scrollers', () => {
    const modes = [
      {
        route: 'markdown',
        diffMode: diffModeForRoute('markdown'),
        panes: 2,
        scroller: '.compare-pane (container)',
      },
      {
        route: 'code',
        diffMode: diffModeForRoute('code'),
        panes: 1,
        scroller: '.diff-changes (unified single scroller)',
      },
      {
        route: 'image',
        diffMode: diffModeForRoute('image'),
        panes: 1,
        scroller: 'none (overlaid canvas with slider)',
      },
      {
        route: 'sandboxed-html',
        diffMode: diffModeForRoute('sandboxed-html'),
        panes: 2,
        scroller: 'inner frame document',
      },
      {
        route: 'sandboxed-jsx',
        diffMode: diffModeForRoute('sandboxed-jsx'),
        panes: 2,
        scroller: 'inner frame document',
      },
      {
        route: 'pdf',
        diffMode: diffModeForRoute('pdf'),
        panes: 1,
        scroller: 'none (not comparable, single version only)',
      },
    ];

    expect(modes.find((m) => m.route === 'markdown')?.diffMode).toBe(
      'markdown'
    );
    expect(modes.find((m) => m.route === 'code')?.diffMode).toBe('code');
    expect(modes.find((m) => m.route === 'image')?.diffMode).toBe('image');
    expect(modes.find((m) => m.route === 'sandboxed-html')?.diffMode).toBe(
      'rendered'
    );
    expect(modes.find((m) => m.route === 'sandboxed-jsx')?.diffMode).toBe(
      'rendered'
    );
    expect(modes.find((m) => m.route === 'pdf')?.diffMode).toBeUndefined();
  });

  test('renderCodeComparison renders a single unified scroller container, leaving no panes to desync', () => {
    withDocument(() => {
      const comparison = renderCodeComparison(
        testView('code', 2, encoder.encode('const a = 1;\nconst b = 2;\n')),
        testView('code', 1, encoder.encode('const a = 1;\nconst b = 3;\n'))
      ) as unknown as ElementStub;

      // One single diff-changes scroller. Both before and current line numbers and diff rows
      // are columns inside that single container, so they scroll together by construction.
      expect(withClass(comparison, 'diff-changes')).toHaveLength(1);
      expect(withClass(comparison, 'compare-pane')).toHaveLength(0);
    });
  });

  test('renderRenderedComparison syncs panes in split layout', () => {
    withDocument((flushFrames) => {
      const comparison = renderRenderedComparison(
        testView('markdown', 2, encoder.encode('# Current\n')),
        testView('markdown', 1, encoder.encode('# Historical\n')),
        'markdown',
        'https://usercontent.example'
      ) as unknown as ElementStub;

      const stage = withClass(comparison, 'compare-stage')[0];
      expect(stage?.dataset['layout']).toBe('split');

      const panes = withClass(comparison, 'compare-pane');
      expect(panes).toHaveLength(2);
      const beforePane = panes[0];
      const afterPane = panes[1];
      if (!beforePane || !afterPane) throw new Error('panes missing');
      beforePane.scrollHeight = 3000;
      beforePane.clientHeight = 1000;
      afterPane.scrollHeight = 2000;
      afterPane.clientHeight = 1000;

      // Left drives right via renderRenderedComparison's syncScrollers
      beforePane.scrollTop = 1000;
      flushFrames();
      expect(afterPane.scrollTop).toBe(500);

      // Right drives left
      afterPane.scrollTop = 1000;
      flushFrames();
      expect(beforePane.scrollTop).toBe(2000);
    });
  });

  test('renderRenderedComparison syncs panes in swipe layout', () => {
    withDocument((flushFrames) => {
      const comparison = renderRenderedComparison(
        testView('markdown', 2, encoder.encode('# Current\n')),
        testView('markdown', 1, encoder.encode('# Historical\n')),
        'markdown',
        'https://usercontent.example'
      ) as unknown as ElementStub;

      const stage = withClass(comparison, 'compare-stage')[0];
      const swipeBtn = descendants(comparison).find(
        (el) => el.tagName === 'BUTTON' && el.dataset['layout'] === 'swipe'
      );
      swipeBtn?.click();
      expect(stage?.dataset['layout']).toBe('swipe');

      const panes = withClass(comparison, 'compare-pane');
      expect(panes).toHaveLength(2);
      const beforePane = panes[0];
      const afterPane = panes[1];
      if (!beforePane || !afterPane) throw new Error('panes missing');
      beforePane.scrollHeight = 4000;
      beforePane.clientHeight = 1000;
      afterPane.scrollHeight = 2000;
      afterPane.clientHeight = 1000;

      beforePane.scrollTop = 1500;
      flushFrames();
      expect(afterPane.scrollTop).toBe(500);
    });
  });

  test('renderRenderedComparison syncs frame scrollers for rendered mode in split layout', () => {
    withDocument((flushFrames) => {
      const comparison = renderRenderedComparison(
        testView('sandboxed-html', 2, encoder.encode('<p>v2</p>')),
        testView('sandboxed-html', 1, encoder.encode('<p>v1</p>')),
        'rendered',
        'https://usercontent.example'
      ) as unknown as ElementStub;

      const stage = withClass(comparison, 'compare-stage')[0];
      const splitBtn = descendants(comparison).find(
        (el) => el.tagName === 'BUTTON' && el.dataset['layout'] === 'split'
      );
      splitBtn?.click();
      expect(stage?.dataset['layout']).toBe('split');

      const iframeElements = descendants(comparison).filter(
        (el) => el.tagName === 'IFRAME'
      );
      expect(iframeElements).toHaveLength(2);
      const beforeIframe = iframeElements[0];
      const afterIframe = iframeElements[1];
      if (!beforeIframe || !afterIframe) throw new Error('iframes missing');
      // Left frame dispatches scroll event, driving right frame
      beforeIframe.dispatchEvent({
        type: 'relic:frame-scroll',
        detail: { fraction: 0.4 },
      });
      flushFrames();

      const lastSentToAfter =
        afterIframe.postedMessages[afterIframe.postedMessages.length - 1];
      expect(lastSentToAfter).toEqual({
        type: 'relic:set-scroll',
        fraction: 0.4,
      });

      // Right frame dispatches scroll event, driving left frame
      afterIframe.dispatchEvent({
        type: 'relic:frame-scroll',
        detail: { fraction: 0.8 },
      });
      flushFrames();

      const lastSentToBefore =
        beforeIframe.postedMessages[beforeIframe.postedMessages.length - 1];
      expect(lastSentToBefore).toEqual({
        type: 'relic:set-scroll',
        fraction: 0.8,
      });
    });
  });

  test('renderRenderedComparison syncs frame scrollers for rendered mode in swipe layout', () => {
    withDocument((flushFrames) => {
      const comparison = renderRenderedComparison(
        testView('sandboxed-html', 2, encoder.encode('<p>v2</p>')),
        testView('sandboxed-html', 1, encoder.encode('<p>v1</p>')),
        'rendered',
        'https://usercontent.example'
      ) as unknown as ElementStub;

      const stage = withClass(comparison, 'compare-stage')[0];
      // Side by side is the default for every class now, so the swipe is
      // reached the way a reader reaches it: by pressing for it.
      expect(stage?.dataset['layout']).toBe('split');
      const swipeControl = descendants(comparison).find(
        (el) => el.dataset?.['layout'] === 'swipe'
      );
      swipeControl?.dispatchEvent({ type: 'click' });
      expect(stage?.dataset['layout']).toBe('swipe');

      const iframeElements = descendants(comparison).filter(
        (el) => el.tagName === 'IFRAME'
      );
      expect(iframeElements).toHaveLength(2);
      const beforeIframe = iframeElements[0];
      const afterIframe = iframeElements[1];
      if (!beforeIframe || !afterIframe) throw new Error('iframes missing');
      beforeIframe.dispatchEvent({
        type: 'relic:frame-scroll',
        detail: { fraction: 0.65 },
      });
      flushFrames();

      const lastSentToAfter =
        afterIframe.postedMessages[afterIframe.postedMessages.length - 1];
      expect(lastSentToAfter).toEqual({
        type: 'relic:set-scroll',
        fraction: 0.65,
      });
    });
  });
});

describe('comparison layout chain and viewport guards', () => {
  test('every link in the comparison height and width chain is present in styles.css', async () => {
    const css = await Bun.file(
      new URL('../src/styles.css', import.meta.url)
    ).text();
    expect(comparisonLayoutFaults(css)).toEqual([]);
  });

  test('stylesheet does not use viewport-reserve calc() expressions', async () => {
    const css = (
      await Bun.file(new URL('../src/styles.css', import.meta.url)).text()
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const reserves = [...css.matchAll(/calc\([^)]*100[vd]h[^)]*-[^)]*\)/g)].map(
      (match) => match[0]
    );
    expect(reserves).toEqual([]);
  });

  test('proves layout geometry at 1180x773, wide, narrow, and mobile viewports', () => {
    const viewports = [
      { name: 'reported', width: 1180, height: 773 },
      { name: 'wide', width: 1568, height: 900 },
      { name: 'narrow', width: 768, height: 1024 },
      { name: 'mobile', width: 400, height: 800 },
    ];

    for (const vp of viewports) {
      const barHeight = 62;
      const diffRowHeight = vp.height - barHeight;
      expect(diffRowHeight).toBeGreaterThan(0);

      const isMobile = vp.width <= 704; // 44rem
      const minLegibleRail = isMobile ? 0 : 448; // 28rem
      const maxSidebarWidth = isMobile
        ? vp.width
        : Math.max(280, vp.width - 448);
      const sidebarWidth = Math.min(352, maxSidebarWidth);
      const stageWidth = isMobile ? vp.width : vp.width - sidebarWidth;

      // Version history rail width is guaranteed at least its legible minimum
      expect(stageWidth).toBeGreaterThanOrEqual(minLegibleRail);

      // Diff shell height inside stage-diff
      const stagePaddingTop = 20;
      const diffShellHeight = diffRowHeight - stagePaddingTop;
      expect(diffShellHeight).toBeGreaterThan(0);

      // Toolbar height at this width (does not explode into vertical letter stack)
      const toolbarHeight = isMobile ? 120 : 75;
      const diffResultHeight = diffShellHeight - toolbarHeight;
      expect(diffResultHeight).toBeGreaterThan(100);

      // Compare stage height inside diff-result
      const resultChrome = 12 + 20 + 36; // padding-top + summary + controls
      const compareStageHeight = diffResultHeight - resultChrome;
      expect(compareStageHeight).toBeGreaterThan(50);

      // Both panes have clientHeight > 0
      const paneClientHeight = compareStageHeight - 2; // stage borders
      expect(paneClientHeight).toBeGreaterThan(0);

      // Both panes are inside viewport
      const paneTop =
        barHeight + stagePaddingTop + toolbarHeight + resultChrome + 1;
      const paneBottom = paneTop + paneClientHeight;
      expect(paneBottom).toBeLessThanOrEqual(vp.height);
    }
  });

  test('mutation proof: the checker fails when the sidebar loses its minimum', () => {
    // The shipped bound had only a ceiling, so the sidebar took the spare
    // width and clipped its own rows. This is that stylesheet.
    const ceilingOnly = `
      .stage-diff {
        min-width: min(100%, 28rem);
      }
      .diff-row .thread {
        flex: 0 1 auto;
        max-width: calc(100% - 28rem);
      }
    `;
    expect(comparisonLayoutFaults(ceilingOnly)).toContain(
      'thread in diff-row has no legible minimum, so the spare width crushes it'
    );

    const both = `
      .stage-diff {
        min-width: min(100%, 28rem);
      }
      .diff-row .thread {
        flex: 0 1 auto;
        width: clamp(18rem, var(--thread-width, 22rem), calc(100% - 28rem));
        min-width: 18rem;
        max-width: calc(100% - 28rem);
      }
    `;
    expect(comparisonLayoutFaults(both)).not.toContain(
      'thread in diff-row has no legible minimum, so the spare width crushes it'
    );
  });

  test('mutation proof: layout fault checker fails if min-width on stage-diff is removed', () => {
    const broken = `
      .stage-diff {
        min-width: 0;
        padding: 1.25rem 1.25rem 0;
      }
      .diff-row .thread {
        flex: 0 1 auto;
        max-width: calc(100% - 28rem);
      }
      .compare-stage[data-layout='split'] {
        grid-template-rows: minmax(0, 1fr);
      }
      .compare-stage[data-layout='swipe'] {
        grid-template-rows: minmax(0, 1fr);
      }
      .compare-pane {
        min-height: 0;
        height: 100%;
      }
    `;
    const faults = comparisonLayoutFaults(broken);
    expect(faults).toContain(
      'stage-diff has no legible minimum width to protect against collapse'
    );
  });

  test('mutation proof: layout fault checker fails if grid-template-rows on split stage is removed', () => {
    const broken = `
      .stage-diff {
        min-width: min(100%, 28rem);
        padding: 1.25rem 1.25rem 0;
      }
      .diff-row .thread {
        flex: 0 1 auto;
        max-width: calc(100% - 28rem);
      }
      .compare-stage[data-layout='split'] {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .compare-stage[data-layout='swipe'] {
        grid-template-rows: minmax(0, 1fr);
      }
      .compare-pane {
        min-height: 0;
        height: 100%;
      }
    `;
    const faults = comparisonLayoutFaults(broken);
    expect(faults).toContain(
      'split comparison stage has no row constraint, expanding to max-content'
    );
  });
});
