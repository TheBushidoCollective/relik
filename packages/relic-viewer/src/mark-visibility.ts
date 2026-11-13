/**
 * Whether a comment mark is drawn at all.
 *
 * A mark is an overlay on something: a pin, a box, a badge, or the highlight
 * on a run of text. It is drawn only while the thing it is about is rendered
 * and inside the reader's scrollport. Outside either, the overlay has no
 * business on screen, and an open card for it must not stay where the thing
 * used to be.
 *
 * The rule is shared by the parent and the sandboxed frame, so there is one
 * definition of "shown". Only geometry and attributes cross the frame
 * boundary; no comment text does.
 */

/** Set on a mark that is not drawn, and removed when it is drawn again. */
export const CONCEALED_ATTRIBUTE = 'data-concealed';

/**
 * Why a mark is not drawn.
 *
 * `hidden` means the thing it is about is not rendered: a collapsed details,
 * a `hidden` attribute, `display: none`. `offscreen` means it is rendered but
 * outside the scrollport. A card closes on `hidden` and only waits on
 * `offscreen`, because scrolling away from a mark is not a reason to lose
 * what a reader was writing.
 */
export type Concealment = 'hidden' | 'offscreen';

/**
 * A hidden overlay is removed from layout, since its thing has no box to point
 * at. An offscreen overlay is made transparent instead, and keeps its box and
 * its hit testing. Reveal measures the box and hit-tests it after a scroll, and
 * an IntersectionObserver reports a scroll only after the next frame, so an
 * overlay made invisible to hit testing would fail that measurement. A text
 * mark keeps its words in every case and loses only its decoration.
 */
export const CONCEALMENT_CSS = `
[${CONCEALED_ATTRIBUTE}='hidden']:not(mark) { display: none !important; }
[${CONCEALED_ATTRIBUTE}='offscreen']:not(mark) { opacity: 0 !important; }
mark[${CONCEALED_ATTRIBUTE}] {
  background: none !important;
  border-bottom-color: transparent !important;
  box-shadow: none !important;
}
`;

type VisibilityProbe = Element & {
  checkVisibility?: (options?: {
    checkVisibilityCSS?: boolean;
    checkOpacity?: boolean;
  }) => boolean;
};

/**
 * True when the element is rendered: it is connected, neither it nor an
 * ancestor is display:none, visibility:hidden, the `hidden` attribute, or the
 * content of a closed details, and it has a box to draw.
 *
 * A detached element answers true. It is a stale anchor rather than a hidden
 * one, and the coordinate fallbacks that predate this rule still own it. The
 * same holds for a runtime that cannot report connection at all, so a stub
 * without layout never conceals anything.
 */
export function isRendered(el: Element): boolean {
  if (el.isConnected !== true) return true;
  const probe = (el as VisibilityProbe).checkVisibility;
  if (typeof probe === 'function') {
    if (!probe.call(el, { checkVisibilityCSS: true, checkOpacity: false })) {
      return false;
    }
  } else {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (
        typeof node.hasAttribute === 'function' &&
        node.hasAttribute('hidden')
      ) {
        return false;
      }
      if (node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open) {
        // The content of a closed details is hidden; its summary is not.
        const summary = Array.from(node.children).find(
          (child) => child.tagName === 'SUMMARY'
        );
        if (!summary || !summary.contains(el)) return false;
      }
      const style = (node as HTMLElement).style;
      if (
        style &&
        (style.display === 'none' || style.visibility === 'hidden')
      ) {
        return false;
      }
    }
  }
  // Nothing drawn means nothing to point at. Engines that skip layout for
  // content-visibility leave a hidden subtree with no boxes at all.
  const rects =
    typeof el.getClientRects === 'function' ? el.getClientRects() : undefined;
  if (rects !== undefined && rects.length === 0) return false;
  return true;
}

/** Writes the concealment attribute only when it changes. */
export function setConcealed(
  node: Element,
  concealment: Concealment | undefined
): void {
  const current = node.getAttribute(CONCEALED_ATTRIBUTE);
  if (concealment === undefined) {
    if (current !== null) node.removeAttribute(CONCEALED_ATTRIBUTE);
    return;
  }
  if (current !== concealment)
    node.setAttribute(CONCEALED_ATTRIBUTE, concealment);
}

/**
 * Tells whether each observed mark is inside its scrollport.
 *
 * An IntersectionObserver with no root answers for the viewport and for every
 * clipping ancestor at once, so a mark inside a scrolling pane or a clipped
 * box is handled without walking the tree. A mark nothing has reported yet
 * counts as inside: no observer means no evidence, not evidence of absence.
 */
export interface ScrollportWatch {
  /** Observes exactly these elements and releases any others. */
  sync(elements: Iterable<Element>): void;
  inView(el: Element): boolean;
  disconnect(): void;
}

export function createScrollportWatch(onChange: () => void): ScrollportWatch {
  const inside = new WeakMap<Element, boolean>();
  const observed = new Set<Element>();
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          let changed = false;
          for (const entry of entries) {
            if (inside.get(entry.target) !== entry.isIntersecting) {
              inside.set(entry.target, entry.isIntersecting);
              changed = true;
            }
          }
          if (changed) onChange();
        })
      : undefined;
  return {
    sync(elements) {
      if (observer === undefined) return;
      const wanted = new Set(elements);
      for (const el of observed) {
        if (wanted.has(el)) continue;
        observer.unobserve(el);
        observed.delete(el);
        inside.delete(el);
      }
      for (const el of wanted) {
        if (observed.has(el)) continue;
        observer.observe(el);
        observed.add(el);
      }
    },
    inView(el) {
      return inside.get(el) !== false;
    },
    disconnect() {
      observer?.disconnect();
      observed.clear();
    },
  };
}

/** A mark to conceal, with the element its visibility depends on. */
export interface ConcealableMark {
  readonly node: Element;
  readonly subject: Element;
}

/**
 * Sets the concealment on every mark and returns the comment ids concealed.
 *
 * A comment is concealed only when every mark carrying its id is concealed,
 * so a comment with one mark still showing keeps it. The reason reported is
 * the strongest among its marks: `hidden` if any is hidden, else `offscreen`.
 *
 * `live: false` conceals everything. The frame uses it while its parent has
 * scrolled the frame out of view, which the frame cannot see for itself.
 */
export function concealMarks(
  marks: readonly ConcealableMark[],
  watch: ScrollportWatch,
  live = true
): ReadonlyMap<string, Concealment> {
  watch.sync(marks.map((mark) => mark.node));
  // A mark that is its own subject is taken out of layout by the hidden
  // concealment itself. Left in place, the attribute would be the only thing
  // hiding the mark and the reason it still tests as hidden, so it is lifted
  // before anything is measured and written back below if the mark is hidden
  // for a reason of its own.
  if (live) {
    for (const { node, subject } of marks) {
      if (
        subject === node &&
        node.getAttribute(CONCEALED_ATTRIBUTE) === 'hidden'
      )
        node.removeAttribute(CONCEALED_ATTRIBUTE);
    }
  }
  // Every mark is measured before any attribute is written, so one write
  // cannot force layout for the next read.
  const measured: {
    node: Element;
    id: string;
    concealment: Concealment | 'shown';
  }[] = [];
  for (const { node, subject } of marks) {
    const id = node.getAttribute('data-comment-id');
    if (id === null || id === '') continue;
    measured.push({
      node,
      id,
      concealment:
        !live || !isRendered(subject)
          ? 'hidden'
          : !watch.inView(node)
            ? 'offscreen'
            : 'shown',
    });
  }
  // 'shown' marks a comment with at least one mark drawn, which conceals
  // nothing however many of its marks are hidden.
  const merged = new Map<string, Concealment | 'shown'>();
  for (const { node, id, concealment } of measured) {
    setConcealed(node, concealment === 'shown' ? undefined : concealment);
    const previous = merged.get(id);
    merged.set(id, mergeReason(previous, concealment));
  }
  const out = new Map<string, Concealment>();
  for (const [id, reason] of merged) {
    if (reason !== 'shown') out.set(id, reason);
  }
  return out;
}

function mergeReason(
  previous: Concealment | 'shown' | undefined,
  next: Concealment | 'shown'
): Concealment | 'shown' {
  if (previous === undefined) return next;
  if (previous === 'shown' || next === 'shown') return 'shown';
  if (previous === 'hidden' || next === 'hidden') return 'hidden';
  return 'offscreen';
}
