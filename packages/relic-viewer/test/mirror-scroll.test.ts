import { describe, expect, test } from 'bun:test';
import { mirrorScrollers } from '../src/scroll-sync.ts';

interface Geometry {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/**
 * A scroll container with the timing a browser gives mirroring code. A write is
 * clamped to the travel its content allows, and the scroll event for a change
 * arrives later, never inside the write. `user` is a reader's gesture: the same
 * change, but not a write, so a test can tell the two apart.
 */
class FakeScroller {
  /** Writes made through `scrollTop` or `scrollLeft`, which the mirror makes. */
  writes = 0;
  readonly #events: FakeScroller[];
  readonly #geometry: Geometry;
  readonly #listeners = new Set<() => void>();
  #top = 0;
  #left = 0;
  #pending = false;

  constructor(events: FakeScroller[], geometry: Geometry) {
    this.#events = events;
    this.#geometry = geometry;
  }

  get scrollTop(): number {
    return this.#top;
  }

  set scrollTop(value: number) {
    this.writes++;
    this.#place(value, this.#left);
  }

  get scrollLeft(): number {
    return this.#left;
  }

  set scrollLeft(value: number) {
    this.writes++;
    this.#place(this.#top, value);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** A reader's gesture. */
  user(top: number, left: number): void {
    this.#place(top, left);
  }

  /** The one scroll event a browser sends for the changes so far. */
  deliver(): void {
    this.#pending = false;
    for (const listener of [...this.#listeners]) listener();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'scroll') this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'scroll') this.#listeners.delete(listener);
  }

  #place(top: number, left: number): void {
    const { scrollHeight, clientHeight, scrollWidth, clientWidth } =
      this.#geometry;
    const nextTop = Math.min(
      Math.max(top, 0),
      Math.max(0, scrollHeight - clientHeight)
    );
    const nextLeft = Math.min(
      Math.max(left, 0),
      Math.max(0, scrollWidth - clientWidth)
    );
    if (nextTop === this.#top && nextLeft === this.#left) return;
    this.#top = nextTop;
    this.#left = nextLeft;
    if (!this.#pending) {
      this.#pending = true;
      this.#events.push(this);
    }
  }
}

// A test double stands in for the element. The mirror reads and writes only the
// members the fake implements.
const asElement = (pane: FakeScroller): HTMLElement =>
  pane as unknown as HTMLElement;

/** Panes that share one event queue, and the frames the mirror schedules. */
function world() {
  const events: FakeScroller[] = [];
  const frames: Array<() => void> = [];
  const counts = { scheduled: 0 };
  const schedule = (run: () => void): void => {
    counts.scheduled++;
    frames.push(run);
  };
  const pane = (overrides: Partial<Geometry> = {}): FakeScroller =>
    new FakeScroller(events, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollWidth: 1600,
      clientWidth: 400,
      ...overrides,
    });
  /**
   * Delivers events and runs frames until nothing is pending. A feedback loop
   * never settles, so it fails here rather than hanging the run.
   */
  const settle = (): void => {
    for (let round = 0; round < 50; round++) {
      if (events.length === 0 && frames.length === 0) return;
      for (const scroller of events.splice(0)) scroller.deliver();
      for (const run of frames.splice(0)) run();
    }
    throw new Error('the panes did not settle: scroll feedback never ended');
  };
  return { events, frames, counts, schedule, pane, settle };
}

describe('mirrorScrollers', () => {
  test('a reader scroll sets every other pane to the same top and left, exactly', () => {
    const w = world();
    const a = w.pane();
    const b = w.pane({ scrollHeight: 2000 });
    const c = w.pane({ scrollWidth: 2400 });
    mirrorScrollers([a, b, c].map(asElement), w.schedule);
    a.user(400, 40);
    w.settle();
    // Exact, not proportional: 400 of a's 800 travel is 900 of b's 1800.
    expect([b.scrollTop, b.scrollLeft]).toEqual([400, 40]);
    expect([c.scrollTop, c.scrollLeft]).toEqual([400, 40]);
    expect([a.scrollTop, a.scrollLeft]).toEqual([400, 40]);
  });

  test('the echo of a write neither moves the leader nor starts another frame', () => {
    const w = world();
    const a = w.pane();
    const b = w.pane();
    mirrorScrollers([a, b].map(asElement), w.schedule);
    a.user(120, 0);
    w.settle();
    expect(w.counts.scheduled).toBe(1);
    expect(a.writes).toBe(0);
    expect(b.scrollTop).toBe(120);
  });

  test('a follower the browser clamps reports where it landed and does not drag the leader', () => {
    const w = world();
    const a = w.pane();
    // 100 of travel, so a write to 400 lands at 100.
    const short = w.pane({ scrollHeight: 300 });
    mirrorScrollers([a, short].map(asElement), w.schedule);
    a.user(400, 0);
    w.settle();
    expect(short.scrollTop).toBe(100);
    expect(a.scrollTop).toBe(400);
    expect(a.writes).toBe(0);
    expect(w.counts.scheduled).toBe(1);
  });

  test('a reader scroll on a follower makes that pane the leader', () => {
    const w = world();
    const a = w.pane();
    const b = w.pane();
    const c = w.pane();
    mirrorScrollers([a, b, c].map(asElement), w.schedule);
    b.user(700, 30);
    w.settle();
    expect([a.scrollTop, a.scrollLeft]).toEqual([700, 30]);
    expect([c.scrollTop, c.scrollLeft]).toEqual([700, 30]);
  });

  test('while a frame is pending its driver owns it, and other panes are ignored', () => {
    const w = world();
    const a = w.pane();
    const b = w.pane();
    mirrorScrollers([a, b].map(asElement), w.schedule);
    a.user(100, 0);
    b.user(200, 0);
    // Both events arrive before the frame runs, as a browser can deliver them.
    for (const scroller of w.events.splice(0)) scroller.deliver();
    expect(w.counts.scheduled).toBe(1);
    for (const run of w.frames.splice(0)) run();
    expect([a.scrollTop, b.scrollTop]).toEqual([100, 100]);
  });

  test('a burst of scroll events in one frame becomes one frame at the latest position', () => {
    const w = world();
    const a = w.pane();
    const b = w.pane();
    mirrorScrollers([a, b].map(asElement), w.schedule);
    a.user(10, 0);
    a.user(20, 0);
    a.user(30, 0);
    w.settle();
    expect(w.counts.scheduled).toBe(1);
    expect(b.scrollTop).toBe(30);
  });

  test('teardown unbinds every listener and drops a write still pending', () => {
    const w = world();
    const a = w.pane();
    const b = w.pane();
    const unbind = mirrorScrollers([a, b].map(asElement), w.schedule);
    expect(a.listenerCount).toBe(1);
    a.user(50, 0);
    for (const scroller of w.events.splice(0)) scroller.deliver();
    unbind();
    for (const run of w.frames.splice(0)) run();
    expect(b.scrollTop).toBe(0);
    expect(a.listenerCount).toBe(0);
    a.user(90, 0);
    w.settle();
    expect(b.scrollTop).toBe(0);
  });

  test('fewer than two panes bind nothing', () => {
    const w = world();
    const a = w.pane();
    const unbind = mirrorScrollers([asElement(a)], w.schedule);
    expect(a.listenerCount).toBe(0);
    unbind();
  });
});
