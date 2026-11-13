import { describe, expect, test } from 'bun:test';
import {
  isFrameImagePlacementMessage,
  isFrameMarkRectMessage,
  isFrameVisibilityMessage,
} from '../src/annotate-frame.ts';
import {
  CONCEALED_ATTRIBUTE,
  CONCEALMENT_CSS,
  type ConcealableMark,
  concealMarks,
  createScrollportWatch,
  isRendered,
  type ScrollportWatch,
  setConcealed,
} from '../src/mark-visibility.ts';

// A hand-written element with just the members the rule reads. Bun has no DOM,
// so layout is stated, not measured: each test says what is hidden and why.
class StubElement {
  readonly isConnected: boolean = true;
  readonly tagName: string;
  readonly children: StubElement[] = [];
  parentElement: StubElement | null = null;
  open = false;
  style: { display?: string; visibility?: string } = {};
  rects = 1;
  private readonly attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getClientRects(): { length: number } {
    return { length: this.rects };
  }

  contains(node: StubElement | null): boolean {
    for (let n: StubElement | null = node; n; n = n.parentElement) {
      if (n === this) return true;
    }
    return false;
  }

  append(child: StubElement): StubElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
}

function el(tag: string, parent?: StubElement): StubElement {
  const made = new StubElement(tag);
  return parent ? parent.append(made) : made;
}

describe('isRendered', () => {
  test('an element with a box and no hidden ancestor is rendered', () => {
    const body = el('body');
    const span = el('span', body);
    expect(isRendered(span as unknown as Element)).toBe(true);
  });

  test('the hidden attribute on an ancestor hides the element', () => {
    const body = el('body');
    const region = el('div', body);
    region.setAttribute('hidden', '');
    const span = el('span', region);
    expect(isRendered(span as unknown as Element)).toBe(false);
  });

  test('display none on an ancestor hides the element', () => {
    const body = el('body');
    const region = el('div', body);
    region.style = { display: 'none' };
    const span = el('span', region);
    expect(isRendered(span as unknown as Element)).toBe(false);
  });

  test('the content of a closed details is hidden, its summary is not', () => {
    const body = el('body');
    const details = el('details', body);
    const summary = el('summary', details);
    const inside = el('p', details);
    expect(isRendered(summary as unknown as Element)).toBe(true);
    expect(isRendered(inside as unknown as Element)).toBe(false);
    details.open = true;
    expect(isRendered(inside as unknown as Element)).toBe(true);
  });

  test('an element with no box is not drawn', () => {
    const body = el('body');
    const img = el('img', body);
    img.rects = 0;
    expect(isRendered(img as unknown as Element)).toBe(false);
  });

  test('a detached element is a stale anchor, not a hidden one', () => {
    const detached = new StubElement('span');
    Object.defineProperty(detached, 'isConnected', { value: false });
    expect(isRendered(detached as unknown as Element)).toBe(true);
  });
});

describe('setConcealed', () => {
  test('writes the reason and removes it when the mark is drawn again', () => {
    const node = el('mark');
    setConcealed(node as unknown as Element, 'hidden');
    expect(node.getAttribute(CONCEALED_ATTRIBUTE)).toBe('hidden');
    setConcealed(node as unknown as Element, 'offscreen');
    expect(node.getAttribute(CONCEALED_ATTRIBUTE)).toBe('offscreen');
    setConcealed(node as unknown as Element, undefined);
    expect(node.getAttribute(CONCEALED_ATTRIBUTE)).toBeNull();
  });
});

describe('concealMarks', () => {
  const everything: ScrollportWatch = {
    sync: () => {},
    inView: () => true,
    disconnect: () => {},
  };

  function mark(id: string, subject: StubElement): ConcealableMark {
    const node = el('span');
    node.setAttribute('data-comment-id', id);
    return {
      node: node as unknown as Element,
      subject: subject as unknown as Element,
    };
  }

  test('a mark whose subject is hidden is concealed and its id reported', () => {
    const body = el('body');
    const region = el('div', body);
    region.setAttribute('hidden', '');
    const concealed = concealMarks([mark('c1', region)], everything);
    expect(concealed.get('c1')).toBe('hidden');
  });

  test('a comment stays drawn while any of its marks is drawn', () => {
    const body = el('body');
    const hidden = el('div', body);
    hidden.setAttribute('hidden', '');
    const visible = el('p', body);
    const concealed = concealMarks(
      [mark('c1', hidden), mark('c1', visible)],
      everything
    );
    expect(concealed.has('c1')).toBe(false);
  });

  test('a mark outside its scrollport is offscreen, not hidden', () => {
    const body = el('body');
    const subject = el('p', body);
    const outside = new Set<unknown>();
    const scrolled: ScrollportWatch = {
      sync: () => {},
      inView: (node) => !outside.has(node),
      disconnect: () => {},
    };
    const marks = [mark('c2', subject)];
    outside.add(marks[0]!.node);
    expect(concealMarks(marks, scrolled).get('c2')).toBe('offscreen');
  });

  test('a frame the page cannot see conceals everything, hidden', () => {
    const body = el('body');
    const subject = el('p', body);
    const concealed = concealMarks([mark('c3', subject)], everything, false);
    expect(concealed.get('c3')).toBe('hidden');
  });

  test('a mark is cleared again when its subject is shown again', () => {
    const body = el('body');
    const region = el('div', body);
    region.setAttribute('hidden', '');
    const marks = [mark('c4', region)];
    concealMarks(marks, everything);
    expect(marks[0]!.node.getAttribute(CONCEALED_ATTRIBUTE)).toBe('hidden');
    region.removeAttribute('hidden');
    expect(concealMarks(marks, everything).has('c4')).toBe(false);
    expect(marks[0]!.node.getAttribute(CONCEALED_ATTRIBUTE)).toBeNull();
  });

  test('a mark that is its own subject is drawn again once only this rule hides it', () => {
    // The stylesheet takes a hidden mark out of layout, so this stub loses its
    // box to the attribute the way an element does in a browser.
    class SelfHiding extends StubElement {
      shown = false;
      override getClientRects(): { length: number } {
        return {
          length:
            this.shown && this.getAttribute(CONCEALED_ATTRIBUTE) !== 'hidden'
              ? 1
              : 0,
        };
      }
    }
    const body = el('body');
    const node = body.append(new SelfHiding('button')) as SelfHiding;
    node.setAttribute('data-comment-id', 'c5');
    const marks: ConcealableMark[] = [
      { node: node as unknown as Element, subject: node as unknown as Element },
    ];
    expect(concealMarks(marks, everything).get('c5')).toBe('hidden');
    expect(node.getAttribute(CONCEALED_ATTRIBUTE)).toBe('hidden');
    // Still hidden for its own reason: the attribute is written back.
    expect(concealMarks(marks, everything).get('c5')).toBe('hidden');
    expect(node.getAttribute(CONCEALED_ATTRIBUTE)).toBe('hidden');
    node.shown = true;
    expect(concealMarks(marks, everything).has('c5')).toBe(false);
    expect(node.getAttribute(CONCEALED_ATTRIBUTE)).toBeNull();
  });
});

describe('createScrollportWatch', () => {
  test('without an IntersectionObserver every mark counts as inside', () => {
    const watch = createScrollportWatch(() => {});
    const node = el('span') as unknown as Element;
    watch.sync([node]);
    expect(watch.inView(node)).toBe(true);
    watch.disconnect();
  });
});

describe('concealment CSS', () => {
  test('gives each reason its own rule, and only hidden leaves layout', () => {
    // A hidden subject has no box, so display:none costs nothing. An offscreen
    // overlay keeps its box and its hit testing, because reveal measures and
    // hit-tests it right after a scroll, before the observer has caught up.
    // Removing it from layout, or from hit testing, fails that measurement.
    expect(CONCEALMENT_CSS).toContain(
      `[${CONCEALED_ATTRIBUTE}='hidden']:not(mark) { display: none`
    );
    expect(CONCEALMENT_CSS).toContain(
      `[${CONCEALED_ATTRIBUTE}='offscreen']:not(mark) { opacity: 0`
    );
    expect(CONCEALMENT_CSS).toContain(`mark[${CONCEALED_ATTRIBUTE}]`);
    expect(CONCEALMENT_CSS).not.toContain("='true'");
  });

  test('the viewer stylesheet carries the same rules for the page', async () => {
    // The page cannot reach the frame's copy, and the frame cannot reach this
    // one, so each must state the rule itself. Checked here so they cannot drift.
    const sheet = await Bun.file(
      new URL('../src/styles.css', import.meta.url)
    ).text();
    expect(sheet).toContain(`[${CONCEALED_ATTRIBUTE}='hidden']:not(mark)`);
    expect(sheet).toContain(`[${CONCEALED_ATTRIBUTE}='offscreen']:not(mark)`);
    expect(sheet).toContain(`mark[${CONCEALED_ATTRIBUTE}]`);
    expect(sheet).not.toContain("[data-concealed='true']");
  });
});

describe('frame messages for visibility', () => {
  test('the page says whether the frame is in view', () => {
    expect(
      isFrameVisibilityMessage({
        type: 'relic:frame-visibility',
        visible: false,
      })
    ).toBe(true);
    expect(
      isFrameVisibilityMessage({
        type: 'relic:frame-visibility',
        visible: 'no',
      })
    ).toBe(false);
  });

  test('an image that is not drawn reports concealed, not unavailable', () => {
    expect(
      isFrameImagePlacementMessage({
        type: 'relic:frame-image-placement',
        id: 'c5',
        requestId: 1,
        status: 'concealed',
        concealment: 'offscreen',
      })
    ).toBe(true);
  });

  test('a concealed image says why, and only one of the two reasons', () => {
    expect(
      isFrameImagePlacementMessage({
        type: 'relic:frame-image-placement',
        id: 'c5',
        requestId: 1,
        status: 'concealed',
        concealment: 'somewhere',
      })
    ).toBe(false);
  });

  test('a mark rect reports concealment with a reason and no rect', () => {
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'c6',
        concealed: 'hidden',
      })
    ).toBe(true);
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'c6',
        concealed: 'bogus',
      })
    ).toBe(false);
  });
});
