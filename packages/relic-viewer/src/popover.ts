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
}

/** Clearance between the panel and the thing it points at. */
export const POPOVER_GAP = 8;

/** Clearance between the panel and the edge of the visible stage. */
export const POPOVER_MARGIN = 8;

/**
 * Where the panel goes.
 *
 * Above the anchor by preference, because a panel below covers the text a
 * reader is about to read next, and a comment about a sentence that hides
 * the following sentence trades one problem for another. Below when there is
 * no room above, which is the first line of every document.
 *
 * Both axes are clamped to the visible box rather than to the content, so a
 * panel on a mark at the right edge stays reachable instead of sitting in
 * the overflow the stage clips.
 */
export function placePopover(
  anchor: AnchorBox,
  size: { readonly width: number; readonly height: number },
  host: HostBox,
  gap = POPOVER_GAP,
  margin = POPOVER_MARGIN,
  bounds?: AnchorBox
): Placement {
  const visibleTop = bounds
    ? Math.max(host.scrollTop, bounds.top) + margin
    : host.scrollTop + margin;
  const visibleBottom = bounds
    ? Math.min(host.scrollTop + host.clientHeight, bounds.top + bounds.height) -
      margin
    : host.scrollTop + host.clientHeight - margin;
  const above = anchor.top - gap - size.height;
  const below = anchor.top + anchor.height + gap;
  const side: 'above' | 'below' = above >= visibleTop ? 'above' : 'below';
  const wanted = side === 'above' ? above : below;
  const top = Math.max(
    visibleTop,
    Math.min(wanted, Math.max(visibleTop, visibleBottom - size.height))
  );

  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const leftLimit = bounds
    ? Math.max(host.scrollLeft, bounds.left) + margin
    : host.scrollLeft + margin;
  const rightLimit = bounds
    ? Math.min(host.scrollLeft + host.clientWidth, bounds.left + bounds.width) -
      size.width -
      margin
    : host.scrollLeft + host.clientWidth - size.width - margin;
  const left = Math.max(
    leftLimit,
    Math.min(centred, Math.max(leftLimit, rightLimit))
  );

  return { left, top, side };
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
  readonly bounds?: () => AnchorBox | undefined;
}

export interface PopoverLayer {
  /**
   * Puts `content` on the stage over `anchor`, replacing anything open.
   *
   * Showing the panel that is already open moves it rather than rebuilding
   * it, so a reader re-aiming a comment keeps the sentence they are typing
   * and the focus they are typing it with.
   */
  show(
    content: HTMLElement,
    anchor: AnchorBox,
    options?: PopoverPlacementOptions
  ): HTMLElement;
  /** Takes it down. Safe to call when nothing is open. */
  hide(): void;
  /** The open panel, or undefined. */
  current(): HTMLElement | undefined;
  /** Whether a node is inside the open panel, for outside-press handling. */
  contains(node: Node | null): boolean;
  /** Re-runs placement against the anchor the panel was opened on. */
  reposition(): void;
}

/**
 * One panel at a time, on one host.
 *
 * One rather than many because two open panels are two answers to "what is
 * the reader looking at", and the second one is always wrong.
 *
 * Anchors stay in the host's content coordinates whatever is on screen. When
 * part of the host is fullscreen, that element is the only thing painted, so
 * the panel is mounted inside it and the anchor translated into its
 * coordinates here. Every caller keeps measuring against the host, and none
 * of them has to know that fullscreen exists.
 */
export function popoverLayer(host: HTMLElement): PopoverLayer {
  let open: HTMLElement | undefined;
  let anchored: AnchorBox | undefined;
  let mounted: HTMLElement | undefined;
  let boundsProvider: (() => AnchorBox | undefined) | undefined;
  let observer: ResizeObserver | undefined;
  const onBoundedChange = (): void => position();
  const stopBounded = (): void => {
    observer?.disconnect();
    observer = undefined;
    host.removeEventListener('scroll', onBoundedChange, true);
    if (typeof window !== 'undefined')
      window.removeEventListener('resize', onBoundedChange);
  };
  const watchBounded = (): void => {
    stopBounded();
    if (!boundsProvider || !open || !mounted) return;
    host.addEventListener('scroll', onBoundedChange, true);
    if (typeof window !== 'undefined')
      window.addEventListener('resize', onBoundedChange);
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onBoundedChange);
      observer.observe(open);
      observer.observe(host);
      if (mounted !== host) observer.observe(mounted);
    }
  };

  /** Where a panel can be seen right now. */
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

  const position = (): void => {
    if (open === undefined || anchored === undefined || mounted === undefined)
      return;
    const bounds = boundsProvider?.();
    let localBounds: AnchorBox | undefined;
    if (boundsProvider) {
      const local = bounds && translate(bounds);
      localBounds = local;
      const left = local && Math.max(local.left, mounted.scrollLeft);
      const right =
        local &&
        Math.min(
          local.left + local.width,
          mounted.scrollLeft + mounted.clientWidth
        );
      const top = local && Math.max(local.top, mounted.scrollTop);
      const bottom =
        local &&
        Math.min(
          local.top + local.height,
          mounted.scrollTop + mounted.clientHeight
        );
      if (
        !local ||
        right! - left! <= 2 * POPOVER_MARGIN ||
        bottom! - top! <= 2 * POPOVER_MARGIN
      ) {
        open.style.visibility = 'hidden';
        return;
      }
      open.style.maxWidth = `${right! - left! - 2 * POPOVER_MARGIN}px`;
      open.style.maxHeight = `${bottom! - top! - 2 * POPOVER_MARGIN}px`;
      open.style.visibility = '';
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
      localBounds
    );
    open.style.left = `${placement.left}px`;
    open.style.top = `${placement.top}px`;
    open.dataset['side'] = placement.side;
  };

  return {
    show(content, anchor, options) {
      if (open !== undefined && open !== content) {
        stopBounded();
        open.style.maxWidth = '';
        open.style.maxHeight = '';
        open.style.visibility = '';
        open.remove();
        boundsProvider = undefined;
      }
      if (open !== content) boundsProvider = options?.bounds;
      else if (options?.bounds !== undefined) boundsProvider = options.bounds;
      content.classList.add('popover');
      const into = mount();
      if (open !== content || mounted !== into) {
        // Moving a node drops the focus inside it, and the panel moving is
        // never a reason for the reader to stop typing.
        const active = (
          typeof document === 'undefined' ? null : document.activeElement
        ) as HTMLElement | null | undefined;
        const refocus = active && content.contains(active) ? active : undefined;
        // Appended before measuring, because the panel's own height is what
        // decides whether it fits above, and an element outside the document
        // has no height to read.
        into.appendChild(content);
        refocus?.focus();
      }
      const remounted = mounted !== into;
      open = content;
      anchored = anchor;
      mounted = into;
      if (boundsProvider && (remounted || !observer)) watchBounded();
      position();
      return content;
    },
    hide() {
      stopBounded();
      open?.remove();
      if (open && boundsProvider) {
        open.style.maxWidth = '';
        open.style.maxHeight = '';
        open.style.visibility = '';
      }
      open = undefined;
      anchored = undefined;
      mounted = undefined;
      boundsProvider = undefined;
    },
    current() {
      return open;
    },
    contains(node) {
      return node !== null && open !== undefined && open.contains(node);
    },
    reposition: position,
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
