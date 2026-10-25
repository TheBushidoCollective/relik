/**
 * The small panel that opens on the thing a comment is about.
 *
 * A thread beside a document answers "what was said". It cannot answer
 * "about what", and the sidebar is the wrong place to ask: a reader looking
 * at a sentence has to leave it, find a row, and hold the pairing in their
 * head. So the conversation comes to the words. A selection offers what can
 * be done with it, a mark opens the remark that covers it, and both happen
 * where the reader is already looking.
 *
 * Geometry lives in content coordinates rather than viewport ones, because
 * the stage scrolls its own children. A panel positioned against the visible
 * box is correct for exactly as long as nobody scrolls.
 *
 * Nothing here knows what a comment is. It takes a node somebody else
 * rendered and puts it in the right place, which is what keeps the thread
 * and the popover showing the same comment rather than two renderings that
 * drift.
 */

/** A box in the host's own content coordinates. */
export interface AnchorBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** What the host can tell us about its scroll and its visible extent. */
export interface HostBox {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly side: 'above' | 'below';
  /** Present only when the natural height fits on neither side. */
  readonly maxHeight?: number;
}

/** Clearance between the panel and the thing it points at. */
export const POPOVER_GAP = 8;

/** Clearance between the panel and the edge of the visible stage. */
export const POPOVER_MARGIN = 8;

/**
 * Horizontal positioning rule: centred on the anchor, clamped to the
 * visible bounds, pinned to the left limit when too wide.
 */
export function placeLeft(
  anchor: AnchorBox,
  width: number,
  host: { readonly scrollLeft: number; readonly clientWidth: number },
  margin = POPOVER_MARGIN
): number {
  const centred = anchor.left + anchor.width / 2 - width / 2;
  const leftLimit = host.scrollLeft + margin;
  const rightLimit = host.scrollLeft + host.clientWidth - width - margin;
  if (width > host.clientWidth - 2 * margin) {
    return leftLimit;
  }
  return Math.max(leftLimit, Math.min(centred, rightLimit));
}

/**
 * Where the panel goes.
 *
 * Above or below depending on room and preference.
 */
export function placePopover(
  anchor: AnchorBox,
  size: { readonly width: number; readonly height: number },
  host: HostBox,
  gap = POPOVER_GAP,
  margin = POPOVER_MARGIN,
  prefer: 'above' | 'below' = 'above'
): Placement {
  const vt = host.scrollTop + margin;
  const vb = host.scrollTop + host.clientHeight - margin;
  const a0 = anchor.top;
  const a1 = anchor.top + anchor.height;
  const roomAbove = a0 - gap - vt;
  const roomBelow = vb - (a1 + gap);

  let side: 'above' | 'below';
  let top: number;
  let maxHeight: number | undefined;

  if (a1 < vt || a0 > vb) {
    side = prefer;
    top = side === 'above' ? a0 - gap - size.height : a1 + gap;
  } else {
    const fitsAbove = roomAbove >= size.height;
    const fitsBelow = roomBelow >= size.height;

    if (prefer === 'above') {
      if (fitsAbove) {
        side = 'above';
      } else if (fitsBelow) {
        side = 'below';
      } else {
        side = roomAbove >= roomBelow ? 'above' : 'below';
        const room = side === 'above' ? roomAbove : roomBelow;
        maxHeight = Math.max(0, room);
      }
    } else {
      if (fitsBelow) {
        side = 'below';
      } else if (fitsAbove) {
        side = 'above';
      } else {
        side = roomBelow >= roomAbove ? 'below' : 'above';
        const room = side === 'below' ? roomBelow : roomAbove;
        maxHeight = Math.max(0, room);
      }
    }

    const h = maxHeight !== undefined ? maxHeight : size.height;
    top = side === 'above' ? a0 - gap - h : a1 + gap;
  }

  const left = placeLeft(anchor, size.width, host, margin);

  return {
    left,
    top,
    side,
    ...(maxHeight !== undefined ? { maxHeight } : {}),
  };
}

/**
 * Computes the new scrollTop to reveal the anchor and its attached panel.
 */
export function revealScrollTop(
  anchor: AnchorBox,
  panelHeight: number,
  host: HostBox & { readonly scrollHeight: number },
  gap = POPOVER_GAP,
  margin = POPOVER_MARGIN,
  prefer: 'above' | 'below' = 'above'
): number {
  const vt = host.scrollTop + margin;
  const vb = host.scrollTop + host.clientHeight - margin;
  const a0 = anchor.top;
  const a1 = anchor.top + anchor.height;
  const h = panelHeight;

  const roomAbove = a0 - gap - vt;
  const roomBelow = vb - (a1 + gap);
  if (a0 >= vt && a1 <= vb && (roomAbove >= h || roomBelow >= h)) {
    return host.scrollTop;
  }

  const maxSpanHeight = host.clientHeight - 2 * margin;

  interface SpanCandidate {
    side: 'above' | 'below';
    start: number;
    end: number;
    height: number;
  }

  const spans: SpanCandidate[] = [];
  const spanAbove = {
    side: 'above' as const,
    start: a0 - gap - h,
    end: a1,
    height: a1 - (a0 - gap - h),
  };
  if (spanAbove.height <= maxSpanHeight) {
    spans.push(spanAbove);
  }
  const spanBelow = {
    side: 'below' as const,
    start: a0,
    end: a1 + gap + h,
    height: a1 + gap + h - a0,
  };
  if (spanBelow.height <= maxSpanHeight) {
    spans.push(spanBelow);
  }

  const scrollTargetFor = (start: number, end: number): number => {
    const minSt = end - host.clientHeight + margin;
    const maxSt = start - margin;
    if (host.scrollTop < minSt) return minSt;
    if (host.scrollTop > maxSt) return maxSt;
    return host.scrollTop;
  };

  let chosenTarget: number;

  if (spans.length === 0) {
    chosenTarget = scrollTargetFor(a0, a1);
  } else if (spans.length === 1) {
    chosenTarget = scrollTargetFor(spans[0]!.start, spans[0]!.end);
  } else {
    const target0 = scrollTargetFor(spans[0]!.start, spans[0]!.end);
    const target1 = scrollTargetFor(spans[1]!.start, spans[1]!.end);
    const dist0 = Math.abs(target0 - host.scrollTop);
    const dist1 = Math.abs(target1 - host.scrollTop);

    if (dist0 < dist1) {
      chosenTarget = target0;
    } else if (dist1 < dist0) {
      chosenTarget = target1;
    } else {
      const preferred = spans.find((s) => s.side === prefer) ?? spans[0]!;
      chosenTarget = scrollTargetFor(preferred.start, preferred.end);
    }
  }

  const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight);
  return Math.max(0, Math.min(chosenTarget, maxScroll));
}

/**
 * Selects the target box for tall selections or regular targets.
 */
export function chooseTargetBox(
  full: AnchorBox,
  firstOrViewHeight: AnchorBox | undefined | number,
  viewHeightOrFirst?: number | AnchorBox
): AnchorBox {
  let first: AnchorBox | undefined;
  let viewHeight: number;

  if (typeof firstOrViewHeight === 'number') {
    viewHeight = firstOrViewHeight;
    first =
      typeof viewHeightOrFirst === 'object' && viewHeightOrFirst !== null
        ? (viewHeightOrFirst as AnchorBox)
        : undefined;
  } else {
    first = firstOrViewHeight;
    viewHeight = typeof viewHeightOrFirst === 'number' ? viewHeightOrFirst : 0;
  }

  if (full.height <= viewHeight / 2) {
    return full;
  }
  if (first !== undefined && (first.width > 0 || first.height > 0)) {
    return first;
  }
  return { left: full.left, top: full.top, width: full.width, height: 0 };
}

/**
 * Turns a box measured in viewport coordinates into the host's content ones.
 *
 * Every measurement a browser hands back is against the viewport, and every
 * position this module writes is against the scrolled content. One function
 * for the conversion because doing it at each call site is how half of them
 * end up missing the scroll offset.
 */
export function anchorFromClientRect(
  rect: { left: number; top: number; width: number; height: number },
  hostRect: { left: number; top: number },
  host: { scrollLeft: number; scrollTop: number }
): AnchorBox {
  return {
    left: rect.left - hostRect.left + host.scrollLeft,
    top: rect.top - hostRect.top + host.scrollTop,
    width: rect.width,
    height: rect.height,
  };
}

export interface PopoverPlacementOptions {
  readonly follow?: () => AnchorBox | undefined;
  readonly reveal?: boolean;
  readonly prefer?: 'above' | 'below';
}

export interface PopoverLayer {
  show(
    content: HTMLElement,
    anchor: AnchorBox,
    options?: PopoverPlacementOptions
  ): HTMLElement;
  hide(): void;
  current(): HTMLElement | undefined;
  contains(node: Node | null): boolean;
  reposition(): void;
  track(): void;
}

export function popoverLayer(host: HTMLElement): PopoverLayer {
  let open: HTMLElement | undefined;
  let anchored: AnchorBox | undefined;
  let mounted: HTMLElement | undefined;
  let options: PopoverPlacementOptions | undefined;
  let hasBeenPlaced = false;
  let observer: ResizeObserver | undefined;
  let rafId: number | undefined;

  const mount = (): HTMLElement => {
    const shown = (
      typeof document === 'undefined' ? null : document.fullscreenElement
    ) as HTMLElement | null | undefined;
    if (shown && shown !== host && host.contains(shown)) return shown;
    return host;
  };

  const translate = (box: AnchorBox): AnchorBox => {
    if (mounted === host || !mounted) return box;
    const from = host.getBoundingClientRect();
    const into = mounted.getBoundingClientRect();
    return {
      left:
        box.left - host.scrollLeft + from.left - into.left + mounted.scrollLeft,
      top: box.top - host.scrollTop + from.top - into.top + mounted.scrollTop,
      width: box.width,
      height: box.height,
    };
  };

  const performTrack = (): void => {
    if (!open || !mounted) return;
    const followFn = options?.follow;
    if (!followFn) return;
    const rawBox = followFn();
    if (!rawBox) return;
    anchored = rawBox;
    const box = translate(rawBox);
    const currentSide =
      (open.dataset['side'] as 'above' | 'below') || options?.prefer || 'above';
    const h = open.offsetHeight;
    const left = placeLeft(
      box,
      open.offsetWidth,
      {
        scrollLeft: mounted.scrollLeft,
        clientWidth: mounted.clientWidth,
      },
      POPOVER_MARGIN
    );
    const top =
      currentSide === 'above'
        ? box.top - POPOVER_GAP - h
        : box.top + box.height + POPOVER_GAP;
    open.style.left = `${left}px`;
    open.style.top = `${top}px`;
  };

  const scheduleTrack = (): void => {
    if (typeof requestAnimationFrame === 'function') {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = undefined;
        performTrack();
      });
    } else {
      performTrack();
    }
  };

  const onInnerScroll = (event: Event): void => {
    if (event.target !== host && host.contains(event.target as Node)) {
      scheduleTrack();
    }
  };

  const performFullPlace = (shouldReveal: boolean): void => {
    if (!open || !mounted) return;

    if (options?.follow) {
      const raw = options.follow();
      if (raw !== undefined) {
        anchored = raw;
        hasBeenPlaced = true;
      } else {
        if (hasBeenPlaced) {
          return;
        }
        hasBeenPlaced = true;
      }
    } else {
      hasBeenPlaced = true;
    }

    if (!anchored) return;

    open.style.maxHeight = '';
    delete open.dataset['capped'];

    const targetBox = translate(anchored);

    if (shouldReveal && mounted === host) {
      const panelHeight = open.offsetHeight;
      const nextScroll = revealScrollTop(
        targetBox,
        panelHeight,
        {
          scrollLeft: host.scrollLeft,
          scrollTop: host.scrollTop,
          clientWidth: host.clientWidth,
          clientHeight: host.clientHeight,
          scrollHeight: host.scrollHeight,
        },
        POPOVER_GAP,
        POPOVER_MARGIN,
        options?.prefer ?? 'above'
      );
      if (Math.abs(host.scrollTop - nextScroll) > 0.5) {
        host.scrollTop = nextScroll;
      }
    }

    const placement = placePopover(
      translate(anchored),
      { width: open.offsetWidth, height: open.offsetHeight },
      {
        scrollLeft: mounted.scrollLeft,
        scrollTop: mounted.scrollTop,
        clientWidth: mounted.clientWidth,
        clientHeight: mounted.clientHeight,
      },
      POPOVER_GAP,
      POPOVER_MARGIN,
      options?.prefer ?? 'above'
    );

    open.style.left = `${placement.left}px`;
    open.style.top = `${placement.top}px`;
    open.dataset['side'] = placement.side;

    if (placement.maxHeight !== undefined) {
      open.style.maxHeight = `${placement.maxHeight}px`;
      open.dataset['capped'] = 'true';
    } else {
      open.style.maxHeight = '';
      delete open.dataset['capped'];
    }
  };

  const onWindowResize = (): void => {
    performFullPlace(options?.reveal === true);
  };

  const onResizeObserver = (): void => {
    performFullPlace(false);
  };

  const startWatching = (): void => {
    stopWatching();
    host.addEventListener('scroll', onInnerScroll, true);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', onWindowResize);
    }
    if (typeof ResizeObserver !== 'undefined' && open) {
      observer = new ResizeObserver(onResizeObserver);
      observer.observe(host);
      observer.observe(open);
      for (const child of host.children) {
        if (child !== open && child instanceof HTMLElement) {
          observer.observe(child);
        }
      }
      if (mounted && mounted !== host) {
        observer.observe(mounted);
      }
    }
  };

  const stopWatching = (): void => {
    if (rafId !== undefined) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = undefined;
    }
    observer?.disconnect();
    observer = undefined;
    host.removeEventListener('scroll', onInnerScroll, true);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize);
    }
  };

  return {
    show(content, anchor, opts) {
      const isNewContent = open !== content;
      if (open !== undefined && isNewContent) {
        stopWatching();
        open.style.maxHeight = '';
        delete open.dataset['capped'];
        open.remove();
        hasBeenPlaced = false;
      }

      if (isNewContent || opts !== undefined) {
        options = opts;
      }

      content.classList.add('popover');
      const into = mount();

      if (isNewContent || mounted !== into) {
        const active = (
          typeof document === 'undefined' ? null : document.activeElement
        ) as HTMLElement | null | undefined;
        const refocus = active && content.contains(active) ? active : undefined;
        into.appendChild(content);
        refocus?.focus();
      }

      open = content;
      anchored = anchor;
      mounted = into;

      startWatching();
      performFullPlace(options?.reveal === true);

      return content;
    },
    hide() {
      stopWatching();
      if (open) {
        open.style.maxHeight = '';
        delete open.dataset['capped'];
        open.remove();
      }
      open = undefined;
      anchored = undefined;
      mounted = undefined;
      options = undefined;
      hasBeenPlaced = false;
    },
    current() {
      return open;
    },
    contains(node) {
      return node !== null && open !== undefined && open.contains(node);
    },
    reposition() {
      performFullPlace(options?.reveal === true);
    },
    track() {
      scheduleTrack();
    },
  };
}

export interface PopoverAction {
  readonly label: string;
  /** A stable hook for the tests and for the browser proofs. */
  readonly className?: string;
  /** Visual weight. `primary` for the one the reader most likely wants. */
  readonly kind?: 'primary' | 'quiet';
  readonly ariaLabel?: string;
  readonly onSelect: () => void;
}

/**
 * A button inside a panel.
 *
 * `mousedown` is cancelled on every one of them because a press moves focus,
 * moving focus collapses the selection, and a panel whose whole purpose is
 * to act on a selection must not destroy it on the way to being clicked.
 * This is the same reason the older selection bubble does it, kept here so
 * no future control in a panel has to rediscover it.
 */
export function popoverButton(action: PopoverAction): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'popover-action';
  if (action.className !== undefined) button.classList.add(action.className);
  if (action.kind !== undefined) button.classList.add(`is-${action.kind}`);
  button.textContent = action.label;
  if (action.ariaLabel !== undefined) {
    button.setAttribute('aria-label', action.ariaLabel);
  }
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    action.onSelect();
  });
  return button;
}

/** How much of a selection the offer names back to the reader. */
export const OFFER_QUOTE_LIMIT = 42;

export interface SelectionOfferOptions {
  /** The text itself, for the label and for the clipboard. */
  readonly text: string;
  /**
   * Whether copying is on offer. False when the selection arrived from a
   * sandboxed frame too large to transport, where offering Copy would hand
   * back a prefix and call it the selection.
   */
  readonly canCopy: boolean;
  readonly onCopy: () => void;
  readonly onComment: () => void;
  readonly onCancel: () => void;
}

/**
 * What a selection is offered before anything is written.
 *
 * Two verbs and a way out. The intermediate step exists because selecting
 * text is not a declaration of intent: most selections are made to read, to
 * copy, or by accident, and a panel that jumps straight to a composer treats
 * every one of them as the start of a comment.
 */
export function selectionOffer(options: SelectionOfferOptions): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'popover popover-offer';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Selection actions');

  if (options.canCopy) {
    panel.appendChild(
      popoverButton({
        label: 'Copy text',
        className: 'popover-copy',
        onSelect: options.onCopy,
      })
    );
  }
  panel.appendChild(
    popoverButton({
      label: 'Comment',
      className: 'popover-comment',
      kind: 'primary',
      ariaLabel: `Comment on "${shortQuote(options.text)}"`,
      onSelect: options.onComment,
    })
  );
  panel.appendChild(
    popoverButton({
      label: '\u00d7',
      className: 'popover-cancel',
      kind: 'quiet',
      ariaLabel: 'Dismiss and deselect',
      onSelect: options.onCancel,
    })
  );
  return panel;
}

export function shortQuote(text: string, limit = OFFER_QUOTE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}\u2026` : flat;
}

export interface CardOptions {
  /**
   * The comment, rendered by whoever renders it in the thread.
   *
   * Passed in rather than built here on purpose: the sidebar and the panel
   * are two placements of one comment, and two renderers would drift until
   * the same remark read differently depending on where it was seen.
   */
  readonly content: Node;
  readonly actions: readonly PopoverAction[];
  /** Marks the panel as belonging to one comment, for pairing and tests. */
  readonly commentId?: string;
}

export function popoverCard(options: CardOptions): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'popover popover-card';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Comment');
  if (options.commentId !== undefined) {
    panel.dataset['commentId'] = options.commentId;
  }
  panel.appendChild(options.content);
  if (options.actions.length > 0) {
    const tools = document.createElement('div');
    tools.className = 'popover-tools';
    for (const action of options.actions) {
      tools.appendChild(popoverButton(action));
    }
    panel.appendChild(tools);
  }
  return panel;
}

export interface ComposerOptions {
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly value?: string;
  /** Said under the field when the action has a cost worth knowing first. */
  readonly disclosure?: string;
  readonly onSubmit: (body: string) => void;
  readonly onCancel: () => void;
}

export interface Composer {
  readonly element: HTMLElement;
  readonly field: HTMLTextAreaElement;
  /** Puts the panel back in a state a reader can retry from. */
  setBusy(busy: boolean): void;
  setNote(note: string | null): void;
}

/**
 * Writing, inside the panel.
 *
 * Used for a reply and for an edit, because they are the same interaction
 * with a different starting value and a different verb, and building two of
 * them is how one of them ends up missing the busy state.
 */
export function inlineComposer(options: ComposerOptions): Composer {
  const element = document.createElement('div');
  element.className = 'popover-composer';

  const field = document.createElement('textarea');
  field.className = 'popover-field';
  field.placeholder = options.placeholder;
  if (options.value !== undefined) field.value = options.value;
  element.appendChild(field);

  const note = document.createElement('p');
  note.className = 'popover-note';
  note.hidden = true;
  element.appendChild(note);

  const line = document.createElement('div');
  line.className = 'popover-tools';
  const submit = popoverButton({
    label: options.submitLabel,
    kind: 'primary',
    onSelect: () => {
      const body = field.value.trim();
      // An empty write is refused here rather than sent, because the service
      // would refuse it too and the round trip teaches the reader nothing.
      if (body.length === 0) {
        field.focus();
        return;
      }
      options.onSubmit(body);
    },
  });
  const cancel = popoverButton({
    label: 'Cancel',
    kind: 'quiet',
    onSelect: options.onCancel,
  });
  line.appendChild(submit);
  line.appendChild(cancel);
  element.appendChild(line);

  if (options.disclosure !== undefined) {
    const said = document.createElement('p');
    said.className = 'popover-disclosure';
    said.textContent = options.disclosure;
    element.appendChild(said);
  }

  return {
    element,
    field,
    setBusy(busy) {
      field.disabled = busy;
      submit.disabled = busy;
      cancel.disabled = busy;
    },
    setNote(text) {
      note.textContent = text ?? '';
      note.hidden = text === null;
    },
  };
}

/**
 * Copy, and say which happened.
 *
 * The clipboard is refused often enough to matter: an insecure context, a
 * denied permission, a browser that only allows it inside a user gesture it
 * did not recognise. Reporting success on a rejected write would leave the
 * reader pasting whatever they copied an hour ago.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const COPY_FAILED_NOTE =
  'This browser would not let the page write to the clipboard. The text is ' +
  'still selected, so a copy from the keyboard will work.';
