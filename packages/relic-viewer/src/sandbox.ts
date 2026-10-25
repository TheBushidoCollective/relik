/**
 * The usercontent origin's page.
 *
 * This runs on a different registrable domain from the service. That
 * separation is the control, not a detail: the service origin holds the
 * fragment, and untrusted HTML must never execute anywhere that can reach it.
 * Google's own pattern is separate isolated origins, and they treat XSS inside
 * a sandbox domain as an invalid bug report, which shows how completely the
 * origin boundary is doing the work.
 *
 * The parent frames this page with `sandbox` and without `allow-same-origin`,
 * so the document lands in an opaque origin. It cannot read `parent.location`,
 * it cannot touch this origin's storage, and it has no credentials to leak.
 *
 * It receives markup, or transpiled component code. It never receives the
 * key, and there is deliberately no code in this bundle that could do
 * anything with one.
 *
 * Rendered content here cannot reach the network. The page's CSP names no
 * remote source, so nothing a relic's author writes can make a request
 * leave this frame. The JSX path carries its own dependencies for the same
 * reason: React and ReactDOM are bundled into this script, and the build
 * inlines that script into the page. An opaque origin cannot fetch even
 * its own origin's assets, so inlining is the only channel through which
 * the frame can receive code at all.
 */
// React and ReactDOM are bundled into this file rather than fetched: the
// frame is not allowed to reach the network, and an opaque origin cannot
// fetch same-origin assets even when they are offered. One bundled copy
// also settles the instance question hooks depend on: the `React` global
// the component resolves and the `createRoot` that mounts it are the same
// module by construction.
import type { AnchorRect } from '@relic/format';
import {
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
} from '@relic/format';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  FRAME_SELECTION_TEXT_LIMIT_BYTES,
  type FrameMarkPayload,
  type FrameMarkRectMessage,
  type FramePointMessage,
  type FrameRect,
  type FrameRegionMessage,
  type FrameSelectionMessage,
  isActiveMarkMessage,
  isArmPointingMessage,
  isClearMarkMessage,
  isClearMarksMessage,
  isPaintMarkMessage,
  isPaintMarksMessage,
  isQuietMarksMessage,
  isRevealMarkMessage,
  isTrackMarkMessage,
  normaliseFrameExternalLink,
  type RevealMarkMessage,
  takeHeadUtf8,
  takeTailUtf8,
} from './annotate-frame.ts';
import { isSetScrollMessage } from './frame-scroll.ts';
import {
  type Anchor,
  applyAnchors,
  applyMarks,
  captureTree,
  HIGHLIGHT_CSS,
  isAnnotateMessage,
  isRevealChangeMessage,
  type Mark,
} from './rendered-tree.ts';
import {
  landmarkScrollDelta,
  nearestScrollLandmark,
  type ScrollPosition,
} from './scroll-landmark.ts';

export interface RenderMessage {
  readonly type: 'relic:render';
  readonly html: string;
}

export function isRenderMessage(data: unknown): data is RenderMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    'html' in data &&
    data.type === 'relic:render' &&
    typeof data.html === 'string'
  );
}

export interface RenderJsxMessage {
  readonly type: 'relic:render-jsx';
  readonly code: string;
}

export function isRenderJsxMessage(data: unknown): data is RenderJsxMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    'code' in data &&
    data.type === 'relic:render-jsx' &&
    typeof data.code === 'string'
  );
}

export interface FrameInteractionHandler {
  setArmed(armed: boolean): void;
  onPaintMark(mark: FrameMarkPayload): boolean;
  onPaintMarks(marks: readonly FrameMarkPayload[]): boolean;
  onClearMark(id: string): void;
  onClearMarks(): void;
  onRevealMark(msg: RevealMarkMessage): void;
  onPairMark(id: string, active: boolean): void;
  onTrackMark?(id: string | null): void;
  onActiveMark?(id: string | null): void;
  onQuietMarks?(ids: readonly string[]): void;
  onRevealChange?(changeId: string, top: number): void;
  onSetScroll?(position: ScrollPosition): void;
}

export interface FrameInteraction extends FrameInteractionHandler {
  isArmed(): boolean;
  onTrackMark(id: string | null): void;
  onActiveMark(id: string | null): void;
  onQuietMarks(ids: readonly string[]): void;
  onRevealChange(changeId: string, top: number): void;
}

/**
 * Constant stylesheet injected into the frame for comment marks and pointing.
 * Isolated from service-origin styles, so it provides its own visual tokens.
 * Every declaration carries `!important` because the frame's document is
 * author-owned untrusted content: whatever stylesheet or inline style that
 * content ships must never be able to hide or restyle a mark, which is how a
 * commented passage would stop being findable.
 *
 * A commented passage is visible at rest: a reader must see what carries a
 * comment without touching it. Active is stronger than at rest, because it
 * marks the one comment the reader is looking at right now. Resolved is
 * deliberately quiet: settled feedback should stop shouting.
 */
export const FRAME_MARK_CSS = `
.relic-text-mark {
  background: rgba(180, 140, 60, 0.28) !important;
  border-bottom: 2px solid rgba(180, 140, 60, 0.85) !important;
  color: inherit !important;
  cursor: pointer !important;
  padding: 0.1em 0 !important;
}
.relic-text-mark:hover {
  background: rgba(180, 140, 60, 0.4) !important;
}
[data-relic-change-id].is-current-change {
  outline: 3px solid rgba(180, 140, 60, 0.95) !important;
  outline-offset: 3px !important;
}
.relic-text-mark.is-active {
  background: rgba(180, 140, 60, 0.5) !important;
  outline: 2px solid rgba(180, 140, 60, 0.9) !important;
}
.relic-text-mark.is-resolved {
  background: rgba(140, 140, 140, 0.14) !important;
  border-bottom-color: rgba(140, 140, 140, 0.4) !important;
}
.relic-text-mark.is-pending {
  background: rgba(180, 140, 60, 0.16) !important;
  border-bottom: 2px dashed rgba(180, 140, 60, 0.85) !important;
}
.relic-text-mark.is-paired {
  background: rgba(180, 140, 60, 0.42) !important;
  outline: 2px solid rgba(180, 140, 60, 0.85) !important;
}
.relic-region-mark {
  position: absolute !important;
  box-sizing: border-box !important;
  background: rgba(180, 140, 60, 0.22) !important;
  border: 2px solid rgba(180, 140, 60, 0.85) !important;
  border-radius: 3px !important;
  cursor: pointer !important;
  pointer-events: auto !important;
}
.relic-region-mark:hover {
  background: rgba(180, 140, 60, 0.34) !important;
}
.relic-region-mark.is-active {
  background: rgba(180, 140, 60, 0.42) !important;
  box-shadow: 0 0 0 2px rgba(180, 140, 60, 0.9) !important;
}
.relic-region-mark.is-resolved {
  background: rgba(140, 140, 140, 0.1) !important;
  border-color: rgba(140, 140, 140, 0.45) !important;
}
.relic-region-mark.is-pending {
  background: rgba(180, 140, 60, 0.12) !important;
  border: 2px dashed rgba(180, 140, 60, 0.85) !important;
  pointer-events: none !important;
}
.relic-region-mark.is-paired {
  background: rgba(180, 140, 60, 0.38) !important;
  box-shadow: 0 0 0 2px rgba(180, 140, 60, 0.85) !important;
}
.relic-region-mark.is-drawing {
  pointer-events: none !important;
  cursor: crosshair !important;
}
.relic-pin-mark {
  position: absolute !important;
  box-sizing: border-box !important;
  width: 20px !important;
  height: 20px !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 2px solid #fff !important;
  border-radius: 999px !important;
  background: rgba(180, 140, 60, 0.95) !important;
  box-shadow: 0 0 0 1px rgba(60, 45, 20, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3) !important;
  transform: translate(-50%, -50%) !important;
  cursor: pointer !important;
  pointer-events: auto !important;
}
.relic-pin-mark:hover {
  box-shadow: 0 0 0 4px rgba(180, 140, 60, 0.35) !important;
}
.relic-pin-mark.is-active,
.relic-pin-mark.is-paired {
  outline: 2px solid rgba(180, 140, 60, 0.9) !important;
  outline-offset: 2px !important;
}
.relic-pin-mark.is-resolved {
  background: rgba(140, 140, 140, 0.7) !important;
}
.relic-pin-mark.is-pending {
  background: rgba(180, 140, 60, 0.18) !important;
  border: 2px dashed rgba(180, 140, 60, 0.95) !important;
  box-shadow: none !important;
  pointer-events: none !important;
  cursor: default !important;
}
.relic-pointing-active, .relic-pointing-active * {
  cursor: crosshair !important;
}
`;

export function ensureFrameStyles(doc: Document): void {
  if (doc.getElementById('relic-frame-styles')) return;
  const style = doc.createElement('style');
  style.id = 'relic-frame-styles';
  style.textContent = FRAME_MARK_CSS;
  doc.head?.appendChild(style);
}

/**
 * A mark's bounding box in the frame's own client coordinates, or undefined
 * when the element cannot be measured. Guarded because the frame interaction
 * tests drive a DOM-less stub whose elements carry no geometry, and because
 * an element not in the rendered tree has no box to measure.
 */
function markFrameRect(el: Element): FrameRect | undefined {
  const getter = (el as HTMLElement).getBoundingClientRect;
  if (typeof getter !== 'function') return undefined;
  try {
    const box = getter.call(el) as {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    if (!box) return undefined;
    for (const value of [box.left, box.top, box.width, box.height]) {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    }
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    };
  } catch {
    return undefined;
  }
}

/**
 * Wire a painted mark to report clicks and hover to the parent.
 *
 * Geometry is measured at event time, not when the mark is painted: a mark
 * scrolled or resized after painting would otherwise report where it used to
 * be. Only geometry crosses this boundary, never comment text: the parent
 * owns the popover precisely so plaintext stays out of an origin that runs
 * the relic's own code.
 */
function wireFrameMark(mark: Element, id: string, doc: Document): void {
  mark.addEventListener('click', (e) => {
    (e as MouseEvent).stopPropagation?.();
    const rect = markFrameRect(mark);
    doc.defaultView?.parent?.postMessage(
      {
        type: 'relic:frame-mark-click',
        id,
        ...(rect === undefined ? {} : { rect }),
      },
      '*'
    );
  });
  mark.addEventListener('mouseenter', () => {
    const rect = markFrameRect(mark);
    doc.defaultView?.parent?.postMessage(
      {
        type: 'relic:frame-mark-hover',
        id,
        ...(rect === undefined ? {} : { rect }),
      },
      '*'
    );
  });
  mark.addEventListener('mouseleave', () => {
    doc.defaultView?.parent?.postMessage(
      { type: 'relic:frame-mark-hover', id: null },
      '*'
    );
  });
}

/**
 * Wrap an occurrence of a text quote in the frame DOM with a mark element.
 *
 * Uses `document.createElement('mark')` and DOM text node splitting.
 * Never uses `innerHTML`, ensuring author markup or hostile quote text
 * cannot inject executable HTML.
 */
export function wrapFrameQuote(
  root: HTMLElement,
  exact: string,
  prefix?: string,
  suffix?: string,
  id = ''
): boolean {
  if (exact.length === 0) return false;
  const doc = root.ownerDocument;
  if (!doc) return false;
  ensureFrameStyles(doc);

  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (
        parent?.closest(
          'mark.relic-text-mark, script, style, #relic-frame-overlay'
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let curr = walker.nextNode();
  while (curr !== null) {
    textNodes.push(curr as Text);
    curr = walker.nextNode();
  }
  if (textNodes.length === 0) return false;

  type Candidate = {
    node: Text;
    index: number;
    score: number;
  };
  const candidates: Candidate[] = [];

  for (const node of textNodes) {
    let startPos = 0;
    while (startPos < node.data.length) {
      const index = node.data.indexOf(exact, startPos);
      if (index === -1) break;
      let score = 0;
      if (prefix && prefix.length > 0) {
        const preceding = node.data.slice(0, index);
        if (preceding.endsWith(prefix) || prefix.endsWith(preceding)) {
          score += Math.min(preceding.length, prefix.length);
        }
      }
      if (suffix && suffix.length > 0) {
        const following = node.data.slice(index + exact.length);
        if (following.startsWith(suffix) || suffix.startsWith(following)) {
          score += Math.min(following.length, suffix.length);
        }
      }
      candidates.push({ node, index, score });
      startPos = index + 1;
    }
  }

  if (candidates.length === 0) {
    let fullText = '';
    const spans: { node: Text; start: number; end: number }[] = [];
    for (const node of textNodes) {
      const start = fullText.length;
      fullText += node.data;
      spans.push({ node, start, end: fullText.length });
    }

    const multiCandidates: { start: number; end: number; score: number }[] = [];
    let startPos = 0;
    while (startPos < fullText.length) {
      const idx = fullText.indexOf(exact, startPos);
      if (idx === -1) break;
      let score = 0;
      if (prefix && prefix.length > 0) {
        const preceding = fullText.slice(Math.max(0, idx - prefix.length), idx);
        if (preceding === prefix) score += prefix.length;
      }
      if (suffix && suffix.length > 0) {
        const following = fullText.slice(
          idx + exact.length,
          idx + exact.length + suffix.length
        );
        if (following === suffix) score += suffix.length;
      }
      multiCandidates.push({ start: idx, end: idx + exact.length, score });
      startPos = idx + 1;
    }

    if (multiCandidates.length === 0) return false;

    multiCandidates.sort((a, b) => b.score - a.score);
    const chosen = multiCandidates[0];
    if (!chosen) return false;
    for (const span of spans) {
      if (span.end <= chosen.start || span.start >= chosen.end) continue;
      const nodeStart = Math.max(0, chosen.start - span.start);
      const nodeEnd = Math.min(span.node.data.length, chosen.end - span.start);
      const matchLen = nodeEnd - nodeStart;
      if (matchLen <= 0) continue;

      let target = span.node;
      if (nodeStart > 0) {
        target = target.splitText(nodeStart);
      }
      if (target.data.length > matchLen) {
        target.splitText(matchLen);
      }

      const mark = doc.createElement('mark');
      mark.className = `relic-text-mark${id === 'pending:target' ? ' is-pending' : ''}`;
      mark.dataset.commentId = id;
      target.parentNode?.insertBefore(mark, target);
      mark.appendChild(target);
      wireFrameMark(mark, id, doc);
    }
    return true;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return false;
  let target = best.node;
  if (best.index > 0) {
    target = target.splitText(best.index);
  }
  if (target.data.length > exact.length) {
    target.splitText(exact.length);
  }

  const mark = doc.createElement('mark');
  mark.className = `relic-text-mark${id === 'pending:target' ? ' is-pending' : ''}`;
  mark.dataset.commentId = id;
  target.parentNode?.insertBefore(mark, target);
  mark.appendChild(target);
  wireFrameMark(mark, id, doc);
  return true;
}

export function unwrapFrameQuotes(root: HTMLElement, id?: string): void {
  const selector =
    id !== undefined
      ? `mark.relic-text-mark[data-comment-id="${id}"]`
      : 'mark.relic-text-mark';
  for (const mark of Array.from(root.querySelectorAll(selector))) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    while (mark.firstChild !== null) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }
}

/** The scrolling document's size in pixels, or undefined before it has one. */
function documentSize(
  doc: Document
): { readonly width: number; readonly height: number } | undefined {
  const width = Math.max(
    doc.documentElement.scrollWidth,
    doc.body?.scrollWidth ?? 0
  );
  const height = Math.max(
    doc.documentElement.scrollHeight,
    doc.body?.scrollHeight ?? 0
  );
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * The layer every box and pin is drawn on, sized to the scrolling document,
 * together with that size. Undefined before the document has a body or a
 * size, which is a mark with nowhere to land rather than an error.
 */
function frameOverlay(doc: Document):
  | {
      readonly overlay: HTMLElement;
      readonly docWidth: number;
      readonly docHeight: number;
    }
  | undefined {
  if (!doc.body) return undefined;
  ensureFrameStyles(doc);
  const size = documentSize(doc);
  if (size === undefined) return undefined;

  let overlay = doc.getElementById('relic-frame-overlay');
  if (!overlay) {
    overlay = doc.createElement('div');
    overlay.id = 'relic-frame-overlay';
    overlay.style.cssText =
      'position: absolute; left: 0; top: 0; pointer-events: none; z-index: 99999;';
    doc.body.appendChild(overlay);
  }
  overlay.style.width = `${size.width}px`;
  overlay.style.height = `${size.height}px`;
  return { overlay, docWidth: size.width, docHeight: size.height };
}

export function paintFrameRegion(
  root: HTMLElement,
  rect: AnchorRect,
  id: string
): HTMLElement | undefined {
  const doc = root.ownerDocument;
  const layer = doc ? frameOverlay(doc) : undefined;
  if (!doc || layer === undefined) return undefined;
  const { overlay, docWidth, docHeight } = layer;
  clearFrameRegions(doc.body, id);

  const div = doc.createElement('div');
  div.className = `relic-region-mark${id === 'pending:target' ? ' is-pending' : ''}`;
  div.dataset.commentId = id;
  div.style.left = `${rect.x * docWidth}px`;
  div.style.top = `${rect.y * docHeight}px`;
  div.style.width = `${rect.w * docWidth}px`;
  div.style.height = `${rect.h * docHeight}px`;

  wireFrameMark(div, id, doc);

  overlay.appendChild(div);
  return div;
}

/**
 * Draw a point at a share of the scrolling document.
 *
 * Positioned by share and sized in pixels, so it is the same small marker on
 * a one-screen page and on a document eleven thousand pixels long. Drawing
 * it as a share-sized box is what made a point on a long document a strip
 * hundreds of pixels tall.
 */
export function paintFramePin(
  root: HTMLElement,
  point: { readonly x: number; readonly y: number },
  id: string
): HTMLElement | undefined {
  const doc = root.ownerDocument;
  const layer = doc ? frameOverlay(doc) : undefined;
  if (!doc || layer === undefined) return undefined;
  clearFrameRegions(doc.body, id);

  const pending = id === 'pending:target';
  const pin = doc.createElement('div');
  pin.className = `relic-pin-mark${pending ? ' is-pending' : ''}`;
  pin.dataset.commentId = id;
  pin.style.left = `${point.x * layer.docWidth}px`;
  pin.style.top = `${point.y * layer.docHeight}px`;
  // A point nobody has commented on yet has no comment to open.
  if (!pending) wireFrameMark(pin, id, doc);

  layer.overlay.appendChild(pin);
  return pin;
}

/**
 * How far, in the frame's own pixels, a pressed pointer travels before the
 * gesture is a drag rather than a click, and the smallest side a dragged box
 * keeps.
 *
 * Pixels and never a share of the document. A share of an eleven-thousand
 * pixel document is tens of pixels, and measuring it that way turned every
 * drag across a single line of text into a point.
 */
export const FRAME_DRAG_MIN_PX = 4;

export type FrameGesture =
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
  | { readonly kind: 'region'; readonly rect: AnchorRect };

/**
 * What a press and a release at two document positions placed, in unit
 * coordinates of the scrolling document.
 *
 * Positions are document pixels (`pageX`/`pageY`), so a mark placed while
 * scrolled stays on the element it was placed on after scrolling elsewhere.
 */
export function frameGestureTarget(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  docWidth: number,
  docHeight: number
): FrameGesture | undefined {
  if (!(docWidth > 0) || !(docHeight > 0)) return undefined;
  const clamp = (value: number, size: number): number =>
    Math.min(Math.max(value, 0), size);
  const x0 = clamp(start.x, docWidth);
  const y0 = clamp(start.y, docHeight);
  const x1 = clamp(end.x, docWidth);
  const y1 = clamp(end.y, docHeight);

  if (Math.hypot(x1 - x0, y1 - y0) < FRAME_DRAG_MIN_PX) {
    return { kind: 'point', x: x0 / docWidth, y: y0 / docHeight };
  }

  // A flat drag along a line of text is still a box the reader drew, so its
  // thin side is widened to the minimum rather than the drag thrown away.
  const width = Math.min(
    Math.max(Math.abs(x1 - x0), FRAME_DRAG_MIN_PX),
    docWidth
  );
  const height = Math.min(
    Math.max(Math.abs(y1 - y0), FRAME_DRAG_MIN_PX),
    docHeight
  );
  const x = Math.min(x0, x1, docWidth - width) / docWidth;
  const y = Math.min(y0, y1, docHeight - height) / docHeight;
  // Clamped again in unit space: the format refuses a box whose far edge
  // passes 1, and dividing back out of pixels can overshoot by a rounding
  // error.
  return {
    kind: 'region',
    rect: {
      x,
      y,
      w: Math.min(width / docWidth, 1 - x),
      h: Math.min(height / docHeight, 1 - y),
    },
  };
}

export function clearFrameRegions(root: HTMLElement, id?: string): void {
  const overlay = root.querySelector('#relic-frame-overlay');
  if (!overlay) return;
  if (id !== undefined) {
    for (const el of Array.from(
      overlay.querySelectorAll(`[data-comment-id="${id}"]`)
    )) {
      el.remove();
    }
  } else {
    overlay.replaceChildren();
  }
}

/**
 * Setup pointer, selection, and mark manipulation listeners inside the frame.
 */
/** How far down its travel the document in a window sits, or null when it cannot move. */
export function documentScrollFraction(
  doc: Document,
  win: Window
): number | null {
  const el = doc.scrollingElement ?? doc.documentElement;
  if (!el) return null;
  const scrollHeight = Math.max(
    el.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
  const clientHeight = win.innerHeight || el.clientHeight || 0;
  const travel = scrollHeight - clientHeight;
  if (!(travel > 0)) return null;
  const scrollTop = win.scrollY || el.scrollTop || doc.body?.scrollTop || 0;
  const clamped = Math.min(Math.max(scrollTop, 0), travel);
  return clamped / travel;
}

/** Put the document in a window at a fraction of its travel. */
function documentScrollTop(doc: Document, win: Window): number {
  const el = doc.scrollingElement ?? doc.documentElement;
  return win.scrollY || el?.scrollTop || doc.body?.scrollTop || 0;
}

function applyDocumentScrollTop(
  doc: Document,
  win: Window,
  target: number
): void {
  const el = doc.scrollingElement ?? doc.documentElement;
  if (!el) return;
  const scrollHeight = Math.max(
    el.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
  const clientHeight = win.innerHeight || el.clientHeight || 0;
  const travel = Math.max(scrollHeight - clientHeight, 0);
  const bounded = Math.round(Math.min(Math.max(target, 0), travel));
  const current = documentScrollTop(doc, win);
  if (Math.abs(current - bounded) <= 1) return;
  if (typeof win.scrollTo === 'function') {
    try {
      win.scrollTo({ top: bounded, behavior: 'instant' as ScrollBehavior });
    } catch {
      win.scrollTo(0, bounded);
    }
  }
  if (el.scrollTop !== bounded) el.scrollTop = bounded;
  if (doc.body && doc.body.scrollTop !== bounded) doc.body.scrollTop = bounded;
}

/** The frame's exact paired reference plus the proportional fallback. */
export function documentScrollPosition(
  doc: Document,
  win: Window
): ScrollPosition | null {
  const fraction = documentScrollFraction(doc, win);
  if (fraction === null) return null;
  const landmark = nearestScrollLandmark(doc);
  return {
    fraction,
    ...(landmark === undefined ? {} : { landmark }),
  };
}

/** Put a document at a paired mark when it has one, otherwise by fraction. */
export function applyDocumentScrollPosition(
  doc: Document,
  win: Window,
  position: ScrollPosition
): void {
  if (position.landmark !== undefined) {
    const delta = landmarkScrollDelta(doc, position.landmark);
    if (delta !== null) {
      const el = doc.scrollingElement ?? doc.documentElement;
      const scrollHeight = Math.max(
        el?.scrollHeight ?? 0,
        doc.body?.scrollHeight ?? 0
      );
      const clientHeight = win.innerHeight || el?.clientHeight || 0;
      const travel = Math.max(scrollHeight - clientHeight, 0);
      const exactTarget = documentScrollTop(doc, win) + delta;
      if (exactTarget >= 0 && exactTarget <= travel) {
        applyDocumentScrollTop(doc, win, exactTarget);
        return;
      }
    }
  }
  applyDocumentScrollFraction(doc, win, position.fraction);
}

export function applyDocumentScrollFraction(
  doc: Document,
  win: Window,
  fraction: number
): void {
  const el = doc.scrollingElement ?? doc.documentElement;
  if (!el) return;
  const scrollHeight = Math.max(
    el.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
  const clientHeight = win.innerHeight || el.clientHeight || 0;
  const travel = scrollHeight - clientHeight;
  if (!(travel > 0)) return;
  const bounded = Math.min(Math.max(fraction, 0), 1);
  applyDocumentScrollTop(doc, win, bounded * travel);
}

export function setupFrameInteraction(
  doc: Document,
  win: Window,
  postOutward: (msg: object) => void
): FrameInteraction {
  let armed = false;
  let startX = 0;
  let startY = 0;
  let isDown = false;
  // The box being drawn, shown while the pointer is down so the reader sees
  // what they are about to point at. Never carries a comment id, so nothing
  // that clears, pairs or lights marks can mistake it for one.
  let drawing: HTMLElement | undefined;
  const stopDrawing = (): void => {
    isDown = false;
    drawing?.remove();
    drawing = undefined;
  };
  let suppressScroll = false;
  let scrollResetTimer: number | undefined;
  // True from the moment a nonempty selection is reported until the frame
  // observes it collapse. The cleared message exists for the parent's open
  // popover, so it is sent only on the transition, never on every event
  // that merely happens while nothing is selected.
  let selectionLive = false;
  let trackedId: string | null = null;
  let trackRaf: number | undefined;

  const reportMarkRect = (
    document: Document,
    id: string
  ): FrameMarkRectMessage => {
    if (!document.body) {
      return { type: 'relic:frame-mark-rect', id };
    }
    const matching: HTMLElement[] = [];
    for (const el of Array.from(
      document.body.querySelectorAll('[data-comment-id]')
    )) {
      if ((el as HTMLElement).dataset?.commentId === id) {
        matching.push(el as HTMLElement);
      }
    }

    const candidates: { el: HTMLElement; rects: DOMRect[] }[] = [];
    for (const el of matching) {
      let clientRects: DOMRect[] = [];
      try {
        clientRects = Array.from(el.getClientRects?.() ?? []).filter(
          (r) => r.width > 0 || r.height > 0
        );
      } catch {
        clientRects = [];
      }
      if (clientRects.length > 0) {
        candidates.push({ el, rects: clientRects });
      } else {
        try {
          const b = el.getBoundingClientRect?.();
          if (b && (b.width > 0 || b.height > 0)) {
            candidates.push({ el, rects: [b as DOMRect] });
          }
        } catch {
          // ignore
        }
      }
    }

    if (candidates.length === 0) {
      return { type: 'relic:frame-mark-rect', id };
    }

    const isMark = candidates.some((c) => c.el.tagName === 'MARK');
    if (isMark) {
      const allRects: DOMRect[] = [];
      for (const c of candidates) {
        allRects.push(...c.rects);
      }
      const firstRect = allRects[0]!;
      const minLeft = Math.min(...allRects.map((r) => r.left));
      const minTop = Math.min(...allRects.map((r) => r.top));
      const maxRight = Math.max(
        ...allRects.map((r) => r.right ?? r.left + r.width)
      );
      const maxBottom = Math.max(
        ...allRects.map((r) => r.bottom ?? r.top + r.height)
      );
      const unionRect: FrameRect = {
        left: minLeft,
        top: minTop,
        width: maxRight - minLeft,
        height: maxBottom - minTop,
      };
      const first: FrameRect = {
        left: firstRect.left,
        top: firstRect.top,
        width: firstRect.width,
        height: firstRect.height,
      };
      return {
        type: 'relic:frame-mark-rect',
        id,
        rect: unionRect,
        first,
      };
    }

    const firstEl = candidates[0]!.el;
    const b = firstEl.getBoundingClientRect();
    return {
      type: 'relic:frame-mark-rect',
      id,
      rect: {
        left: b.left,
        top: b.top,
        width: b.width,
        height: b.height,
      },
    };
  };

  const reportTracked = (): void => {
    if (trackedId === null) return;
    const report = reportMarkRect(doc, trackedId);
    postOutward(report);
  };

  const scheduleTrackReport = (): void => {
    if (trackedId === null) return;
    if (typeof requestAnimationFrame === 'function') {
      if (trackRaf !== undefined) cancelAnimationFrame(trackRaf);
      trackRaf = requestAnimationFrame(() => {
        trackRaf = undefined;
        reportTracked();
      });
    } else {
      reportTracked();
    }
  };
  const readSelection = (): Selection | null => {
    return typeof win.getSelection === 'function'
      ? (win.getSelection() as Selection | null)
      : null;
  };

  const hasLiveSelection = (sel: Selection | null): sel is Selection => {
    return (
      sel !== null &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      sel.toString().trim().length > 0
    );
  };

  /** Take down the parent's popover exactly once, on the falling edge. */
  const reportSelectionCleared = (): void => {
    if (!selectionLive) return;
    selectionLive = false;
    postOutward({ type: 'relic:frame-selection-cleared' });
  };

  const handleScroll = (): void => {
    if (suppressScroll) return;
    const position = documentScrollPosition(doc, win);
    if (position === null) return;
    postOutward({ type: 'relic:frame-scroll', ...position });
  };

  // Guarded because this function is called with a stub window in the frame
  // interaction tests, which predate scroll syncing and supply only the
  // members they exercise. An unguarded call threw there and took two tests
  // with it, which is the signal that the stub is the contract this function
  // has always had.
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('scroll', handleScroll, { passive: true });
    win.addEventListener('scroll', () => scheduleTrackReport(), {
      passive: true,
    });
    win.addEventListener('resize', () => scheduleTrackReport());
  }
  doc.addEventListener('click', (event: MouseEvent) => {
    let node = event.target as Element | null;
    if (node?.nodeType !== 1) node = node?.parentElement ?? null;
    while (node !== null && node.tagName.toLowerCase() !== 'a') {
      node = node.parentElement;
    }
    if (node === null) return;

    // Every authored anchor is contained here. The frame never navigates and
    // never opens its own popup, even when the URL is rejected or pointing is
    // armed. Only a trusted reader action may ask the parent to navigate.
    event.preventDefault();
    if (armed || !event.isTrusted) return;

    const href = normaliseFrameExternalLink(node.getAttribute('href'));
    if (href === undefined) return;
    postOutward({ type: 'relic:open-link', href });
  });

  // A selection collapses by more paths than mouseup: clicking elsewhere,
  // a new armed drag, or the parent replacing the document. selectionchange
  // is the one event that covers all of them.
  doc.addEventListener('selectionchange', () => {
    if (hasLiveSelection(readSelection())) return;
    reportSelectionCleared();
  });

  doc.addEventListener('mousedown', (event: MouseEvent) => {
    if (!armed) return;
    // A posted mark is a control: pressing it opens its comment rather than
    // placing a new one on top of it.
    const target = event.target as Element | null;
    if (
      typeof target?.closest === 'function' &&
      target.closest('.relic-region-mark, .relic-pin-mark') !== null
    ) {
      return;
    }
    // Pointing, not selecting. Left to the browser, a drag across text
    // paints a text selection over the box being drawn, which reads as a
    // selection the reader never asked for.
    event.preventDefault?.();
    isDown = true;
    startX = event.pageX;
    startY = event.pageY;
  });

  doc.addEventListener('mousemove', (event: MouseEvent) => {
    if (!armed || !isDown) return;
    // Released outside the frame, where this document never hears the
    // mouseup. The next move with no button down ends the drag.
    if (typeof event.buttons === 'number' && (event.buttons & 1) === 0) {
      stopDrawing();
      return;
    }
    const layer = frameOverlay(doc);
    if (layer === undefined) return;
    const gesture = frameGestureTarget(
      { x: startX, y: startY },
      { x: event.pageX, y: event.pageY },
      layer.docWidth,
      layer.docHeight
    );
    if (gesture?.kind !== 'region') {
      if (drawing !== undefined) drawing.style.display = 'none';
      return;
    }
    // Repainting the marks empties the overlay, and the box with it.
    if (drawing === undefined || drawing.isConnected === false) {
      drawing = doc.createElement('div');
      drawing.className = 'relic-region-mark is-pending is-drawing';
      layer.overlay.appendChild(drawing);
    }
    const { rect } = gesture;
    drawing.style.display = 'block';
    drawing.style.left = `${rect.x * layer.docWidth}px`;
    drawing.style.top = `${rect.y * layer.docHeight}px`;
    drawing.style.width = `${rect.w * layer.docWidth}px`;
    drawing.style.height = `${rect.h * layer.docHeight}px`;
  });

  function handleSelection(): void {
    const sel = readSelection();
    if (!hasLiveSelection(sel)) {
      reportSelectionCleared();
      return;
    }
    const raw = sel.toString().trim();
    if (raw.length === 0) {
      reportSelectionCleared();
      return;
    }

    const exact = takeHeadUtf8(raw, COMMENT_ANCHOR_QUOTE_LIMIT_BYTES);
    if (exact.length === 0) {
      reportSelectionCleared();
      return;
    }

    const range = sel.getRangeAt(0);
    let prefix = '';
    let suffix = '';
    try {
      if (doc.body) {
        const preRange = doc.createRange();
        preRange.selectNodeContents(doc.body);
        preRange.setEnd(range.startContainer, range.startOffset);
        prefix = takeTailUtf8(
          preRange.toString(),
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
        );

        const postRange = doc.createRange();
        postRange.selectNodeContents(doc.body);
        postRange.setStart(range.endContainer, range.endOffset);
        suffix = takeHeadUtf8(
          postRange.toString(),
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
        );
      }
    } catch {
      // If range computation throws in an edge-case DOM state, proceed without context
    }

    // Geometry is measured now, while the selection is on screen; guarded
    // because stub ranges in the frame interaction tests carry no box.
    let rect: FrameRect | undefined;
    try {
      const getter = (range as Range).getBoundingClientRect;
      if (typeof getter === 'function') {
        const box = getter.call(range) as {
          left: number;
          top: number;
          width: number;
          height: number;
        };
        if (
          box &&
          [box.left, box.top, box.width, box.height].every(
            (value) => typeof value === 'number' && Number.isFinite(value)
          )
        ) {
          rect = {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          };
        }
      }
    } catch {
      // A selection that cannot be measured is still a selection worth
      // aiming a comment at, so proceed without the box.
    }

    // Copy gets the reader's whole selection, capped only at the transport
    // limit the parent's guard enforces. A selection past the cap arrives
    // flagged, so the parent can decline Copy rather than hand back a
    // truncated string without saying so.
    const byteLength = new TextEncoder().encode(raw).length;
    const truncated = byteLength > FRAME_SELECTION_TEXT_LIMIT_BYTES;
    const text = truncated
      ? takeHeadUtf8(raw, FRAME_SELECTION_TEXT_LIMIT_BYTES)
      : raw;

    const message: FrameSelectionMessage = {
      type: 'relic:frame-selection',
      exact,
      ...(prefix.length > 0 ? { prefix } : {}),
      ...(suffix.length > 0 ? { suffix } : {}),
      ...(rect === undefined ? {} : { rect }),
      ...(text.length > 0 ? { text } : {}),
      ...(truncated ? { truncated } : {}),
    };
    selectionLive = true;
    postOutward(message);
  }

  doc.addEventListener('mouseup', (event: MouseEvent) => {
    if (!armed) {
      // When pointing is disarmed, reading clicks pass through normally.
      // Check whether text was selected instead.
      handleSelection();
      return;
    }
    if (!isDown) return;
    let regionBox: FrameRect | undefined;
    if (drawing !== undefined) {
      try {
        const b = drawing.getBoundingClientRect?.();
        if (
          b &&
          Number.isFinite(b.left) &&
          Number.isFinite(b.top) &&
          Number.isFinite(b.width) &&
          Number.isFinite(b.height) &&
          b.width >= 0 &&
          b.height >= 0
        ) {
          regionBox = {
            left: b.left,
            top: b.top,
            width: b.width,
            height: b.height,
          };
        }
      } catch {
        // ignore
      }
    }
    stopDrawing();
    event.preventDefault?.();
    event.stopPropagation?.();

    const size = documentSize(doc);
    if (size === undefined) return;
    const gesture = frameGestureTarget(
      { x: startX, y: startY },
      { x: event.pageX, y: event.pageY },
      size.width,
      size.height
    );
    if (gesture === undefined) return;
    if (gesture.kind === 'region') {
      const msg: FrameRegionMessage = {
        type: 'relic:frame-region',
        rect: gesture.rect,
        ...(regionBox !== undefined ? { box: regionBox } : {}),
      };
      postOutward(msg);
    } else {
      const clientX = event.clientX ?? event.pageX ?? 0;
      const clientY = event.clientY ?? event.pageY ?? 0;
      const pointBox: FrameRect = {
        left: clientX - 10,
        top: clientY - 10,
        width: 20,
        height: 20,
      };
      const msg: FramePointMessage = {
        type: 'relic:frame-point',
        x: gesture.x,
        y: gesture.y,
        box: pointBox,
      };
      postOutward(msg);
    }
  });

  return {
    setArmed(nextArmed: boolean) {
      armed = nextArmed;
      if (!armed) stopDrawing();
      if (doc.documentElement) {
        doc.documentElement.classList.toggle('relic-pointing-active', armed);
      }
    },

    isArmed() {
      return armed;
    },

    onPaintMark(mark: FrameMarkPayload): boolean {
      if (!doc.body) return false;
      let placed = false;
      if (mark.kind === 'quote') {
        unwrapFrameQuotes(doc.body, mark.id);
        placed = wrapFrameQuote(
          doc.body,
          mark.exact,
          mark.prefix,
          mark.suffix,
          mark.id
        );
      } else if (mark.kind === 'region') {
        placed = paintFrameRegion(doc.body, mark.rect, mark.id) !== undefined;
      } else if (mark.kind === 'pin') {
        placed = paintFramePin(doc.body, mark, mark.id) !== undefined;
      }
      scheduleTrackReport();
      return placed;
    },

    onPaintMarks(marks: readonly FrameMarkPayload[]): boolean {
      let allPlaced = true;
      for (const mark of marks) {
        const placed = this.onPaintMark(mark);
        if (!placed) allPlaced = false;
      }
      scheduleTrackReport();
      return allPlaced;
    },

    onClearMark(id: string) {
      if (!doc.body) return;
      unwrapFrameQuotes(doc.body, id);
      clearFrameRegions(doc.body, id);
      scheduleTrackReport();
    },

    onClearMarks() {
      if (!doc.body) return;
      unwrapFrameQuotes(doc.body);
      clearFrameRegions(doc.body);
      scheduleTrackReport();
    },

    onRevealMark(msg: RevealMarkMessage) {
      if (!doc.body) return;
      if (msg.id) {
        const target = doc.body.querySelector(`[data-comment-id="${msg.id}"]`);
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
      if (msg.kind === 'quote' && msg.exact) {
        const quoteMark = doc.body.querySelector('mark.relic-text-mark');
        if (quoteMark instanceof HTMLElement) {
          quoteMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
      if (msg.kind === 'region' && msg.rect) {
        const docHeight = Math.max(
          doc.documentElement.scrollHeight,
          doc.body.scrollHeight
        );
        win.scrollTo({
          top: msg.rect.y * docHeight,
          behavior: 'smooth',
        });
      }
      if (msg.kind === 'pin' && msg.point) {
        const size = documentSize(doc);
        if (size === undefined) return;
        // Centred: a point at the very top edge of the window reads as the
        // window's edge rather than as a place in the document.
        win.scrollTo({
          top: Math.max(
            0,
            msg.point.y * size.height - (win.innerHeight || 0) / 2
          ),
          behavior: 'smooth',
        });
      }
    },

    onPairMark(id: string, active: boolean) {
      if (!doc.body) return;
      const targets = doc.body.querySelectorAll(`[data-comment-id="${id}"]`);
      for (const target of Array.from(targets)) {
        target.classList.toggle('is-paired', active);
      }
    },

    onRevealChange(changeId: string, top: number) {
      if (!doc.body) return;
      // Compared through `dataset` rather than matched in a selector, for
      // the same reason the active mark is: an id never gets interpolated
      // into a query this frame runs.
      let found: HTMLElement | undefined;
      for (const node of doc.body.querySelectorAll('[data-relic-change-id]')) {
        const element = node as HTMLElement;
        element.classList.remove('is-current-change');
        if (element.dataset?.['relicChangeId'] === changeId) found = element;
      }
      if (found === undefined) return;
      const current = win.scrollY ?? doc.documentElement?.scrollTop ?? 0;
      const offset = found.getBoundingClientRect().top;
      win.scrollTo?.({ top: Math.max(0, current + offset - top) });
      // Lit as well as scrolled to, because a reader sent to the eighth of
      // forty marked nodes cannot tell which one they were sent to.
      found.classList.add('is-current-change');
    },

    onQuietMarks(ids: readonly string[]) {
      if (!doc.body) return;
      const settled = new Set(ids);
      for (const mark of doc.body.querySelectorAll('[data-comment-id]')) {
        const id = (mark as HTMLElement).dataset?.commentId;
        mark.classList.toggle(
          'is-resolved',
          id !== undefined && settled.has(id)
        );
      }
    },
    onTrackMark(id: string | null) {
      trackedId = id;
      if (trackedId !== null) {
        reportTracked();
      } else {
        if (trackRaf !== undefined) {
          if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(trackRaf);
          }
          trackRaf = undefined;
        }
      }
    },

    onActiveMark(id: string | null) {
      if (!doc.body) return;
      if (id !== null) {
        const report = reportMarkRect(doc, id);
        postOutward(report);
      }
      for (const mark of Array.from(
        doc.body.querySelectorAll('[data-comment-id]')
      )) {
        const active =
          id !== null && (mark as HTMLElement).dataset?.commentId === id;
        mark.classList.toggle('is-active', active);
      }
    },

    onSetScroll(position: ScrollPosition) {
      suppressScroll = true;
      clearTimeout(scrollResetTimer);
      applyDocumentScrollPosition(doc, win, position);
      scrollResetTimer = win.setTimeout(() => {
        suppressScroll = false;
      }, 50) as unknown as number;
    },
  };
}

/**
 * Build the message handler.
 *
 * `write` is injected so the guard logic is testable without a DOM, and so
 * the one call that actually renders untrusted markup sits in a single named
 * place rather than inline in an event listener. `writeJsx` is injected for
 * the same reason: the guard does not care how a render lands, only that it
 * lands once. `annotate` is injected for the same reason again, and carries a
 * default so every existing call site keeps working.
 *
 * `interaction` handles comment mark painting, point/region arming, and reveal
 * requests once the frame has rendered.
 */
export function createSandboxHandler(
  write: (html: string) => void,
  writeJsx: (code: string) => void,
  annotate: (
    marks: readonly Mark[],
    anchors?: readonly Anchor[]
  ) => void = () => {},
  interaction?: FrameInteractionHandler
): (data: unknown) => boolean {
  let rendered = false;
  let annotated = false;

  return (data: unknown): boolean => {
    if (!rendered) {
      if (isRenderMessage(data)) {
        rendered = true;
        write(data.html);
        return true;
      }
      if (isRenderJsxMessage(data)) {
        rendered = true;
        writeJsx(data.code);
        return true;
      }
      return false;
    }

    if (!annotated && isAnnotateMessage(data)) {
      annotated = true;
      annotate(data.marks, data.anchors);
      return true;
    }

    if (isArmPointingMessage(data)) {
      interaction?.setArmed(data.armed);
      return true;
    }

    if (isPaintMarkMessage(data)) {
      return interaction?.onPaintMark(data.mark) ?? true;
    }

    if (isPaintMarksMessage(data)) {
      return interaction?.onPaintMarks(data.marks) ?? true;
    }

    if (isClearMarkMessage(data)) {
      interaction?.onClearMark(data.id);
      return true;
    }

    if (isClearMarksMessage(data)) {
      interaction?.onClearMarks();
      return true;
    }

    if (isRevealMarkMessage(data)) {
      interaction?.onRevealMark(data);
      return true;
    }
    if (isTrackMarkMessage(data)) {
      interaction?.onTrackMark?.(data.id);
      return true;
    }

    if (isActiveMarkMessage(data)) {
      interaction?.onActiveMark?.(data.id);
      return true;
    }
    if (isQuietMarksMessage(data)) {
      interaction?.onQuietMarks?.(data.ids);
      return true;
    }

    if (isRevealChangeMessage(data)) {
      interaction?.onRevealChange?.(data.changeId, data.top);
      return true;
    }

    if (isSetScrollMessage(data)) {
      interaction?.onSetScroll?.({
        fraction: data.fraction,
        ...(data.landmark === undefined ? {} : { landmark: data.landmark }),
      });
      return true;
    }
    return false;
  };
}

async function mountComponent(code: string): Promise<void> {
  const root = document.createElement('div');
  root.id = 'relic-root';
  document.body.replaceChildren(root);

  try {
    const sandboxGlobal = globalThis as { React?: typeof React };
    sandboxGlobal.React = React;
    const url = URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })
    );
    const module = await import(url);
    const component = module.default;
    if (typeof component !== 'function') {
      throw new Error('module has no default export to mount');
    }
    createRoot(root).render(React.createElement(component));
  } catch {
    const failure = document.createElement('div');
    failure.style.cssText =
      'font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;' +
      'padding: 2rem; color: #333;';
    failure.textContent = 'This component could not be rendered.';
    root.replaceChildren(failure);
  }
}

/**
 * Tell the parent what this frame ended up rendering.
 */
function reportTree(): void {
  window.parent.postMessage(
    { type: 'relic:tree', tree: captureTree(document.body) },
    '*'
  );
}

function scheduleReport(): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(reportTree));
    return;
  }
  window.setTimeout(reportTree, 0);
}

/**
 * Strip elements that create nested browsing contexts or external plugin realms.
 *
 * Chrome does not enforce CSP webrtc 'block' or prevent about:blank or srcdoc
 * subframes from instantiating unpatched WebRTC constructors. Stripping frame,
 * object, and embed markup prevents author HTML from creating fresh realms.
 */
export function sanitizeFrameHtml(rawHtml: string): string {
  if (typeof rawHtml !== 'string') return rawHtml;
  return rawHtml.replace(
    /<\s*\/?\s*(?:iframe|frame|object|embed|portal)\b(?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)/gi,
    ''
  );
}

/**
 * Contain WebRTC and worker egress channels in the sandboxed frame.
 *
 * Chrome ignores CSP webrtc 'block', allowing sandboxed frames to gather ICE
 * candidates and transmit STUN packets over UDP. This containment:
 * 1. Neutralizes WebRTC constructors and prototype methods on the frame's
 *    global and on whichever objects in its Window chain own them.
 * 2. Neutralizes Worker and SharedWorker constructors the same way.
 * 3. Overrides contentWindow and contentDocument on frame/object element prototypes.
 * 4. Prevents programmatic creation and DOM insertion of nested frame/object elements.
 */
export function installSandboxContainment(win: Window, _doc?: Document): void {
  const winRecord = win as unknown as Record<string, unknown>;
  if (!win || winRecord['__relicSandboxContained'] === true) {
    return;
  }
  try {
    Object.defineProperty(win, '__relicSandboxContained', {
      value: true,
      configurable: false,
      writable: false,
    });
  } catch {
    winRecord['__relicSandboxContained'] = true;
  }
  const rtcProps = [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCIceGatherer',
    'RTCIceTransport',
    'RTCDtlsTransport',
    'RTCSctpTransport',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'RTCDataChannel',
    'RTCRtpSender',
    'RTCRtpReceiver',
    'RTCPeerConnectionIceEvent',
  ] as const;

  for (const name of [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCIceGatherer',
    'RTCIceTransport',
    'RTCDtlsTransport',
    'RTCSctpTransport',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'RTCDataChannel',
    'RTCRtpSender',
    'RTCRtpReceiver',
  ] as const) {
    const cls = winRecord[name];
    if (typeof cls === 'function' && cls.prototype) {
      try {
        const proto = cls.prototype as Record<string, unknown>;
        proto.createOffer = () =>
          Promise.reject(new Error('WebRTC is disabled'));
        proto.setLocalDescription = () =>
          Promise.reject(new Error('WebRTC is disabled'));
        proto.createDataChannel = () => {
          throw new Error('WebRTC is disabled');
        };
        proto.addIceCandidate = () =>
          Promise.reject(new Error('WebRTC is disabled'));
      } catch {}
    }
  }

  const visited = new Set<unknown>();
  const collectChain = (start: unknown): unknown[] => {
    const chain: unknown[] = [];
    let cur = start;
    while (cur && (typeof cur === 'object' || typeof cur === 'function')) {
      if (visited.has(cur)) break;
      visited.add(cur);
      chain.push(cur);
      try {
        cur = Object.getPrototypeOf(cur);
      } catch {
        break;
      }
    }
    return chain;
  };

  const winWindow = winRecord['Window'] as
    | { prototype?: Record<string, unknown> }
    | undefined;

  // `win` is the frame's own global (both callers pass `window`, which is
  // globalThis there), so its chain plus Window.prototype's covers the realm.
  // Walking the caller's globalThis separately added nothing in the frame and
  // only contained the wrong realm when a caller passed another window.
  const targets: unknown[] = [
    ...collectChain(win),
    ...collectChain(winWindow?.prototype),
  ];

  // Lock each name on the global (the shadow every identifier lookup hits
  // first) and on any chain object that actually owns it. Prototypes that
  // merely inherit the name, such as Object.prototype or EventTarget.prototype,
  // are left alone: a non-writable value there makes every strict-mode
  // assignment of that property name on an ordinary object or DOM node throw.
  const hasOwn = Object.prototype.hasOwnProperty;
  const lockName = (record: Record<string, unknown>, prop: string) => {
    try {
      delete record[prop];
    } catch {}
    try {
      Object.defineProperty(record, prop, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {}
  };
  for (const target of targets) {
    const record = target as Record<string, unknown>;
    const isGlobal = target === win;
    for (const prop of [...rtcProps, 'Worker', 'SharedWorker']) {
      if (isGlobal || hasOwn.call(record, prop)) lockName(record, prop);
    }
  }

  const nullGetter = {
    get() {
      return null;
    },
    set() {},
    configurable: true,
    enumerable: false,
  };

  const iframeCtor = winRecord['HTMLIFrameElement'] as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (iframeCtor?.prototype) {
    try {
      Object.defineProperty(iframeCtor.prototype, 'contentWindow', nullGetter);
      Object.defineProperty(
        iframeCtor.prototype,
        'contentDocument',
        nullGetter
      );
    } catch {}
  }

  const frameCtor = winRecord['HTMLFrameElement'] as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (frameCtor?.prototype) {
    try {
      Object.defineProperty(frameCtor.prototype, 'contentWindow', nullGetter);
      Object.defineProperty(frameCtor.prototype, 'contentDocument', nullGetter);
    } catch {}
  }

  const objectCtor = winRecord['HTMLObjectElement'] as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (objectCtor?.prototype) {
    try {
      Object.defineProperty(objectCtor.prototype, 'contentWindow', nullGetter);
      Object.defineProperty(
        objectCtor.prototype,
        'contentDocument',
        nullGetter
      );
    } catch {}
  }

  const embedCtor = winRecord['HTMLEmbedElement'] as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (embedCtor?.prototype) {
    try {
      Object.defineProperty(embedCtor.prototype, 'getSVGDocument', {
        value() {
          return null;
        },
        configurable: false,
        writable: false,
      });
    } catch {}
  }
  const BLOCKED_TAGS: Record<string, true> = {
    iframe: true,
    frame: true,
    object: true,
    embed: true,
    portal: true,
  };

  const nodeCtor = winRecord['Node'] as
    | { prototype: Node; ELEMENT_NODE: number }
    | undefined;
  const elementNodeType = nodeCtor?.ELEMENT_NODE ?? 1;

  const isBlockedNode = (node: Node | null): boolean => {
    if (!node || node.nodeType !== elementNodeType) return false;
    const tag = ((node as Element).tagName || '').toLowerCase();
    if (BLOCKED_TAGS[tag]) return true;
    if (
      (node as Element).querySelector?.('iframe, frame, object, embed, portal')
    ) {
      return true;
    }
    return false;
  };
  const docCtor = winRecord['Document'] as { prototype: Document } | undefined;
  if (docCtor?.prototype) {
    const origCreateElement = docCtor.prototype.createElement;
    docCtor.prototype.createElement = function (
      this: Document,
      tagName: string,
      options?: ElementCreationOptions
    ): HTMLElement {
      if (typeof tagName === 'string' && BLOCKED_TAGS[tagName.toLowerCase()]) {
        throw new DOMException(
          `Frame creation is blocked: ${tagName}`,
          'SecurityError'
        );
      }
      return origCreateElement.call(this, tagName, options);
    };

    const origCreateElementNS = docCtor.prototype.createElementNS;
    docCtor.prototype.createElementNS = function (
      this: Document,
      ns: string | null,
      tagName: string,
      options?: ElementCreationOptions | string
    ): Element {
      if (typeof tagName === 'string' && BLOCKED_TAGS[tagName.toLowerCase()]) {
        throw new DOMException(
          `Frame creation is blocked: ${tagName}`,
          'SecurityError'
        );
      }
      return origCreateElementNS.call(
        this,
        ns as unknown as 'http://www.w3.org/1999/xhtml',
        tagName,
        options
      );
    } as typeof docCtor.prototype.createElementNS;
    const origDocWrite = docCtor.prototype.write;
    docCtor.prototype.write = function (
      this: Document,
      ...text: string[]
    ): void {
      const sanitized = text.map((t) =>
        typeof t === 'string' ? sanitizeFrameHtml(t) : t
      );
      origDocWrite.apply(this, sanitized as string[]);
    };

    const origDocWriteln = docCtor.prototype.writeln;
    docCtor.prototype.writeln = function (
      this: Document,
      ...text: string[]
    ): void {
      const sanitized = text.map((t) =>
        typeof t === 'string' ? sanitizeFrameHtml(t) : t
      );
      origDocWriteln.apply(this, sanitized as string[]);
    };

    const origAdoptNode = docCtor.prototype.adoptNode;
    if (origAdoptNode) {
      docCtor.prototype.adoptNode = function <T extends Node>(
        this: Document,
        node: T
      ): T {
        if (isBlockedNode(node)) {
          throw new DOMException(
            'Node adoption blocked: frame element',
            'SecurityError'
          );
        }
        return origAdoptNode.call(this, node) as T;
      };
    }

    const origImportNode = docCtor.prototype.importNode;
    if (origImportNode) {
      docCtor.prototype.importNode = function <T extends Node>(
        this: Document,
        node: T,
        deep?: boolean
      ): T {
        if (isBlockedNode(node)) {
          throw new DOMException(
            'Node import blocked: frame element',
            'SecurityError'
          );
        }
        return origImportNode.call(this, node, deep) as T;
      };
    }
  }

  const elCtor = winRecord['Element'] as { prototype: Element } | undefined;
  if (elCtor?.prototype) {
    const origInnerHtmlDesc = Object.getOwnPropertyDescriptor(
      elCtor.prototype,
      'innerHTML'
    );
    if (origInnerHtmlDesc?.set) {
      Object.defineProperty(elCtor.prototype, 'innerHTML', {
        get() {
          return origInnerHtmlDesc.get?.call(this);
        },
        set(val: string) {
          origInnerHtmlDesc.set?.call(this, sanitizeFrameHtml(val));
        },
        configurable: true,
        enumerable: true,
      });
    }

    const origOuterHtmlDesc = Object.getOwnPropertyDescriptor(
      elCtor.prototype,
      'outerHTML'
    );
    if (origOuterHtmlDesc?.set) {
      Object.defineProperty(elCtor.prototype, 'outerHTML', {
        get() {
          return origOuterHtmlDesc.get?.call(this);
        },
        set(val: string) {
          origOuterHtmlDesc.set?.call(this, sanitizeFrameHtml(val));
        },
        configurable: true,
        enumerable: true,
      });
    }

    const origInsertAdjacentHTML = elCtor.prototype.insertAdjacentHTML;
    elCtor.prototype.insertAdjacentHTML = function (
      this: Element,
      pos: InsertPosition,
      text: string
    ): void {
      origInsertAdjacentHTML.call(this, pos, sanitizeFrameHtml(text));
    };
    if ('append' in elCtor.prototype) {
      const origAppend = elCtor.prototype.append;
      elCtor.prototype.append = function (...nodes: (Node | string)[]): void {
        for (const n of nodes) {
          if (typeof n !== 'string' && isBlockedNode(n)) {
            throw new DOMException(
              'Node insertion blocked: frame element',
              'SecurityError'
            );
          }
        }
        origAppend.apply(this, nodes);
      };
    }

    if ('prepend' in elCtor.prototype) {
      const origPrepend = elCtor.prototype.prepend;
      elCtor.prototype.prepend = function (...nodes: (Node | string)[]): void {
        for (const n of nodes) {
          if (typeof n !== 'string' && isBlockedNode(n)) {
            throw new DOMException(
              'Node insertion blocked: frame element',
              'SecurityError'
            );
          }
        }
        origPrepend.apply(this, nodes);
      };
    }

    if ('replaceChildren' in elCtor.prototype) {
      const origReplaceChildren = elCtor.prototype.replaceChildren;
      elCtor.prototype.replaceChildren = function (
        ...nodes: (Node | string)[]
      ): void {
        for (const n of nodes) {
          if (typeof n !== 'string' && isBlockedNode(n)) {
            throw new DOMException(
              'Node insertion blocked: frame element',
              'SecurityError'
            );
          }
        }
        origReplaceChildren.apply(this, nodes);
      };
    }

    if ('insertAdjacentElement' in elCtor.prototype) {
      const origInsertAdjElem = elCtor.prototype.insertAdjacentElement;
      elCtor.prototype.insertAdjacentElement = function (
        where: InsertPosition,
        element: Element
      ): Element | null {
        if (isBlockedNode(element)) {
          throw new DOMException(
            'Node insertion blocked: frame element',
            'SecurityError'
          );
        }
        return origInsertAdjElem.call(this, where, element);
      };
    }
  }

  const rangeCtor = winRecord['Range'] as { prototype: Range } | undefined;
  if (rangeCtor?.prototype) {
    const origContextualFrag = rangeCtor.prototype.createContextualFragment;
    rangeCtor.prototype.createContextualFragment = function (
      this: Range,
      fragment: string
    ): DocumentFragment {
      return origContextualFrag.call(this, sanitizeFrameHtml(fragment));
    };
  }

  if (nodeCtor?.prototype) {
    const origAppendChild = nodeCtor.prototype.appendChild;
    nodeCtor.prototype.appendChild = function <T extends Node>(
      this: Node,
      child: T
    ): T {
      if (isBlockedNode(child)) {
        throw new DOMException('Node insertion blocked', 'SecurityError');
      }
      return origAppendChild.call(this, child) as T;
    };

    const origInsertBefore = nodeCtor.prototype.insertBefore;
    nodeCtor.prototype.insertBefore = function <T extends Node>(
      this: Node,
      newNode: T,
      refNode: Node | null
    ): T {
      if (isBlockedNode(newNode)) {
        throw new DOMException('Node insertion blocked', 'SecurityError');
      }
      return origInsertBefore.call(this, newNode, refNode) as T;
    };

    const origReplaceChild = nodeCtor.prototype.replaceChild;
    nodeCtor.prototype.replaceChild = function <T extends Node>(
      this: Node,
      newChild: Node,
      oldChild: T
    ): T {
      if (isBlockedNode(newChild)) {
        throw new DOMException('Node insertion blocked', 'SecurityError');
      }
      return origReplaceChild.call(this, newChild, oldChild) as T;
    };
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installSandboxContainment(window, document);
  let interaction: FrameInteraction | undefined;

  function initInteraction(): void {
    interaction = setupFrameInteraction(document, window, (msg) => {
      window.parent.postMessage(msg, '*');
    });
  }

  const handle = createSandboxHandler(
    (html) => {
      document.open();
      installSandboxContainment(window, document);
      // Install the capture listener before authored inline scripts execute
      // during document.write. A script-triggered anchor click must never win
      // the race and replace the rendered relic before interaction is wired.
      initInteraction();
      document.write(sanitizeFrameHtml(html));
      document.close();
      listen();
      scheduleReport();
    },
    (code) => {
      // React render and effects may run before the mount promise settles.
      initInteraction();
      void mountComponent(code).then(scheduleReport, scheduleReport);
    },
    (marks, anchors) => {
      const style = document.createElement('style');
      style.textContent = HIGHLIGHT_CSS;
      document.head.appendChild(style);
      applyMarks(document.body, marks);
      // After the marks, never before: `applyMarks` clears every authored
      // copy of the id attribute first, and anchors written ahead of that
      // sweep would be wiped by it.
      if (anchors !== undefined) applyAnchors(document.body, anchors);
    },
    {
      setArmed: (armed) => interaction?.setArmed(armed),
      onPaintMark: (mark) => interaction?.onPaintMark(mark) ?? false,
      onPaintMarks: (marks) => interaction?.onPaintMarks(marks) ?? false,
      onClearMark: (id) => interaction?.onClearMark(id),
      onClearMarks: () => interaction?.onClearMarks(),
      onRevealMark: (msg) => interaction?.onRevealMark(msg),
      onPairMark: (id, active) => interaction?.onPairMark(id, active),
      onTrackMark: (id) => interaction?.onTrackMark?.(id),
      onActiveMark: (id) => interaction?.onActiveMark?.(id),
      onRevealChange: (changeId, top) =>
        interaction?.onRevealChange?.(changeId, top),
      onSetScroll: (fraction) => interaction?.onSetScroll?.(fraction),
    }
  );

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window.parent) return;
    handle(event.data);
  };

  function listen(): void {
    window.addEventListener('message', onMessage);
  }
  listen();

  window.parent.postMessage({ type: 'relic:sandbox-ready' }, '*');
}
