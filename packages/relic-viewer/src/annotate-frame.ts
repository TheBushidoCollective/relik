/**
 * Annotation bridge for sandboxed HTML and JSX relics.
 *
 * Framed relics render inside an opaque-origin iframe (`sandbox="allow-scripts"`
 * without `allow-same-origin`) on the usercontent origin. The parent window
 * holds the decryption key and comment ciphertext but cannot read into the
 * frame's DOM directly. The frame renders author-controlled content and runs
 * without network access, but cannot read parent storage or location.
 *
 * This module defines the bidirectional message protocol that connects them:
 *
 * 1. Outward (Frame to Parent):
 *    - `relic:frame-selection`: reader selected text inside the frame.
 *    - `relic:frame-point`: reader clicked a point while pointing was armed.
 *    - `relic:frame-region`: reader dragged a box while pointing was armed.
 *    - `relic:frame-mark-click`: reader clicked an existing mark inside the frame.
 *    - `relic:open-link`: reader activated a permitted external link.
 *
 * 2. Inward (Parent to Frame):
 *    - `relic:arm-pointing`: arm or disarm click/drag capture inside the frame.
 *    - `relic:paint-mark`: paint an individual mark (quote, region or pin) by ID.
 *    - `relic:paint-marks`: paint a batch of marks by ID.
 *    - `relic:clear-mark`: remove a mark by ID.
 *    - `relic:clear-marks`: remove all comment marks from the frame.
 *    - `relic:reveal-mark`: scroll the frame to bring a mark into view.
 *
 * Security guarantees:
 * Every message crossing the boundary is validated strictly. The parent validates
 * that `event.source` is the frame's `contentWindow` and verifies message shape.
 * The frame validates that `event.source` is `window.parent` and verifies message shape.
 * Marks are constructed using `document.createElement` and `textContent` (never `innerHTML`),
 * ensuring author content or quote text cannot inject markup.
 */

import {
  type AnchorRect,
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
  type CommentAnchor,
} from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';

/**
 * Take code points from the start of text up to maxBytes in UTF-8.
 *
 * Never cuts a multibyte character or surrogate pair in half, which would
 * produce invalid UTF-8 sequences or replacement characters.
 */
export function takeHeadUtf8(text: string, maxBytes: number): string {
  if (text.length === 0 || maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let totalBytes = 0;
  let endCodeUnit = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (totalBytes + charBytes > maxBytes) break;
    totalBytes += charBytes;
    endCodeUnit += char.length;
  }
  return text.slice(0, endCodeUnit);
}

/**
 * Take code points from the end of text backwards up to maxBytes in UTF-8,
 * preserving forward order in the result.
 *
 * Never cuts a multibyte character or surrogate pair in half.
 */
export function takeTailUtf8(text: string, maxBytes: number): string {
  if (text.length === 0 || maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const chars = Array.from(text);
  let totalBytes = 0;
  let startIdx = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    const charBytes = encoder.encode(char).length;
    if (totalBytes + charBytes > maxBytes) break;
    totalBytes += charBytes;
    startIdx = i;
  }
  return chars.slice(startIdx).join('');
}

/**
 * Validate that an object satisfies the AnchorRect contract:
 * x, y, w, h are finite numbers in the unit square, with positive area
 * and no overhang past 1.
 */
export function isValidAnchorRect(data: unknown): data is AnchorRect {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const w = candidate.w;
  const h = candidate.h;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return false;
  }
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return false;
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return false;
  if (x > 1 || y > 1) return false;
  if (x + w > 1.0001 || y + h > 1.0001) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Outward messages (Frame -> Parent)
// ---------------------------------------------------------------------------
/** Long enough for a real URL, bounded before it crosses the frame boundary. */
export const FRAME_EXTERNAL_LINK_LIMIT_BYTES = 8 * 1024;

/**
 * A reader-activated destination the parent may open outside the sandbox.
 *
 * Relative URLs stay inside the opaque frame, while executable and local
 * schemes would turn this narrow escape hatch into a second rendering path.
 * Canonicalising here and validating again in the parent keeps the message
 * contract identical on both sides of the boundary.
 */
export function normaliseFrameExternalLink(href: unknown): string | undefined {
  if (typeof href !== 'string' || href.length === 0) return undefined;
  if (new TextEncoder().encode(href).length > FRAME_EXTERNAL_LINK_LIMIT_BYTES) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }

  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return undefined;
  return url.href;
}

export interface FrameOpenLinkMessage {
  readonly type: 'relic:open-link';
  readonly href: string;
}

export function isFrameOpenLinkMessage(
  data: unknown
): data is FrameOpenLinkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:open-link') return false;
  return normaliseFrameExternalLink(msg.href) === msg.href;
}

/**
 * A box in the frame's own client coordinates.
 *
 * The parent positions its own popover over the frame, so the frame reports
 * where a thing is and never what was said about it. That split is the whole
 * reason this type exists: a comment's plaintext must not cross into an
 * origin that runs the relic's code, and geometry is the only part of the
 * conversation that has to.
 *
 * `left` and `top` may be negative, because a mark scrolled above the frame's
 * viewport still has a position. The magnitude is bounded because these
 * numbers are written onto style properties on the other side.
 */
export interface FrameRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Far past any real viewport, and short of anything that breaks layout. */
export const FRAME_RECT_LIMIT_PX = 100_000;

export function isFrameRect(data: unknown): data is FrameRect {
  if (typeof data !== 'object' || data === null) return false;
  const rect = data as Record<string, unknown>;
  for (const key of ['left', 'top', 'width', 'height']) {
    const value = rect[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (Math.abs(value) > FRAME_RECT_LIMIT_PX) return false;
  }
  const width = rect.width as number;
  const height = rect.height as number;
  return width >= 0 && height >= 0;
}

/**
 * Longest selection the frame hands over for copying.
 *
 * The quote stored on a mark is capped at 512 bytes because a selection is
 * not a document. Copying has no such excuse: a reader who selected four
 * paragraphs and pressed Copy wants four paragraphs, and handing back the
 * first 512 bytes would be a silent lie about what they copied. This cap is
 * a transport bound rather than an editorial one, and a selection past it
 * arrives flagged so the parent can decline to offer Copy instead of
 * offering a truncated one.
 */
export const FRAME_SELECTION_TEXT_LIMIT_BYTES = 64 * 1024;

export interface FrameSelectionMessage {
  readonly type: 'relic:frame-selection';
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
  /**
   * Where the selection sits in the frame, so the parent can offer its
   * actions over the words rather than in a sidebar the reader is not
   * looking at. Optional, because a selection that cannot be measured is
   * still a selection worth aiming a comment at.
   */
  readonly rect?: FrameRect;
  /**
   * The selected text in full, for Copy. Distinct from `exact`, which is the
   * capped quote that goes on the mark: copying the mark's quote would hand
   * back less than was selected without saying so.
   */
  readonly text?: string;
  /** The selection ran past the transport cap, so `text` is not all of it. */
  readonly truncated?: boolean;
}

export function isFrameSelectionMessage(
  data: unknown
): data is FrameSelectionMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-selection') return false;
  if (typeof msg.exact !== 'string') return false;
  if (
    new TextEncoder().encode(msg.exact).length >
    COMMENT_ANCHOR_QUOTE_LIMIT_BYTES
  ) {
    return false;
  }
  if (
    msg.prefix !== undefined &&
    (typeof msg.prefix !== 'string' ||
      new TextEncoder().encode(msg.prefix).length >
        COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
  ) {
    return false;
  }
  if (
    msg.suffix !== undefined &&
    (typeof msg.suffix !== 'string' ||
      new TextEncoder().encode(msg.suffix).length >
        COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
  ) {
    return false;
  }
  if (msg.rect !== undefined && !isFrameRect(msg.rect)) return false;
  if (
    msg.text !== undefined &&
    (typeof msg.text !== 'string' ||
      new TextEncoder().encode(msg.text).length >
        FRAME_SELECTION_TEXT_LIMIT_BYTES)
  ) {
    return false;
  }
  if (msg.truncated !== undefined && typeof msg.truncated !== 'boolean') {
    return false;
  }
  return true;
}

/**
 * The selection went away inside the frame.
 *
 * Its own message rather than an empty selection, because "there is nothing
 * selected" and "here is a selection of nothing" are different claims, and
 * the parent has an open popover to take down on exactly one of them.
 */
export interface FrameSelectionClearedMessage {
  readonly type: 'relic:frame-selection-cleared';
}

export function isFrameSelectionClearedMessage(
  data: unknown
): data is FrameSelectionClearedMessage {
  if (typeof data !== 'object' || data === null) return false;
  return (
    (data as Record<string, unknown>).type === 'relic:frame-selection-cleared'
  );
}

export interface FramePointMessage {
  readonly type: 'relic:frame-point';
  readonly x: number;
  readonly y: number;
  /** The placed pin's box, in frame viewport coordinates. */
  readonly box?: FrameRect;
}

/** A unit coordinate on the frame's scrolling document: finite, in [0, 1]. */
export function isUnitPoint(x: unknown, y: unknown): boolean {
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

export function isFramePointMessage(data: unknown): data is FramePointMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-point') return false;
  if (!isUnitPoint(msg.x, msg.y)) return false;
  if (msg.box !== undefined && !isFrameRect(msg.box)) return false;
  return true;
}

export interface FrameRegionMessage {
  readonly type: 'relic:frame-region';
  readonly rect: AnchorRect;
  /** The drawn region at release, in frame viewport coordinates. */
  readonly box?: FrameRect;
}

export function isFrameRegionMessage(
  data: unknown
): data is FrameRegionMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-region') return false;
  if (!isValidAnchorRect(msg.rect)) return false;
  if (msg.box !== undefined && !isFrameRect(msg.box)) return false;
  return true;
}

/** Page to frame: report this mark's geometry now and after every scroll, resize or repaint, until told null. */
export interface TrackMarkMessage {
  readonly type: 'relic:track-mark';
  readonly id: string | null;
}

export function isTrackMarkMessage(data: unknown): data is TrackMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:track-mark') return false;
  if (msg.id === null) return true;
  return (
    typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= 256
  );
}

/** Frame to page: one mark's geometry in frame viewport coordinates. No rect when it is not laid out. */
export interface FrameMarkRectMessage {
  readonly type: 'relic:frame-mark-rect';
  readonly id: string;
  readonly rect?: FrameRect;
  readonly first?: FrameRect;
}

export function isFrameMarkRectMessage(
  data: unknown
): data is FrameMarkRectMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-mark-rect') return false;
  if (
    typeof msg.id !== 'string' ||
    msg.id.length === 0 ||
    msg.id.length > 256
  ) {
    return false;
  }
  if (msg.rect !== undefined && !isFrameRect(msg.rect)) return false;
  if (msg.first !== undefined && !isFrameRect(msg.first)) return false;
  return true;
}
export interface FrameMarkClickMessage {
  readonly type: 'relic:frame-mark-click';
  readonly id: string;
  /** Where the mark is, so the comment opens on it rather than beside it. */
  readonly rect?: FrameRect;
}

export function isFrameMarkClickMessage(
  data: unknown
): data is FrameMarkClickMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-mark-click') return false;
  if (
    typeof msg.id !== 'string' ||
    msg.id.length === 0 ||
    msg.id.length > 256
  ) {
    return false;
  }
  if (msg.rect !== undefined && !isFrameRect(msg.rect)) return false;
  return true;
}

/**
 * The pointer entered or left a mark inside the frame.
 *
 * `id` is null on leave. Hover is reported rather than inferred from
 * coordinates on this side, because the frame is the only place that knows
 * which of its own nodes the pointer is over.
 */
export interface FrameMarkHoverMessage {
  readonly type: 'relic:frame-mark-hover';
  readonly id: string | null;
  readonly rect?: FrameRect;
}

export function isFrameMarkHoverMessage(
  data: unknown
): data is FrameMarkHoverMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:frame-mark-hover') return false;
  if (msg.id !== null) {
    if (
      typeof msg.id !== 'string' ||
      msg.id.length === 0 ||
      msg.id.length > 256
    ) {
      return false;
    }
  }
  if (msg.rect !== undefined && !isFrameRect(msg.rect)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Inward messages (Parent -> Frame)
// ---------------------------------------------------------------------------

/**
 * Which mark the reader is presently looking at, or null for none.
 *
 * Sent when a row in the thread is clicked, so the thing a comment covers is
 * lit inside the frame too. Without it, clicking a comment about text in a
 * sandboxed relic scrolls to a mark that looks like every other mark.
 */
export interface ActiveMarkMessage {
  readonly type: 'relic:active-mark';
  readonly id: string | null;
}

export function isActiveMarkMessage(data: unknown): data is ActiveMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:active-mark') return false;
  if (msg.id === null) return true;
  return (
    typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= 256
  );
}

/**
 * Which marks are settled, so they can go quiet inside the frame.
 *
 * The whole list every time rather than one id at a time, because a
 * resolution can be undone and a message that only ever added would leave a
 * reopened comment looking closed. This origin knows which comments are
 * settled and the frame owns the marks, so the fact has to cross and the
 * text does not.
 */
export interface QuietMarksMessage {
  readonly type: 'relic:quiet-marks';
  readonly ids: readonly string[];
}

export function isQuietMarksMessage(data: unknown): data is QuietMarksMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:quiet-marks') return false;
  if (!Array.isArray(msg.ids)) return false;
  return msg.ids.every(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 256
  );
}

export interface ArmPointingMessage {
  readonly type: 'relic:arm-pointing';
  readonly armed: boolean;
}

export function isArmPointingMessage(
  data: unknown
): data is ArmPointingMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'relic:arm-pointing' && typeof msg.armed === 'boolean';
}

export type FrameMarkPayload =
  | {
      readonly id: string;
      readonly kind: 'quote';
      readonly exact: string;
      readonly prefix?: string;
      readonly suffix?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'region';
      readonly rect: AnchorRect;
    }
  | {
      readonly id: string;
      readonly kind: 'pin';
      readonly x: number;
      readonly y: number;
    };

export function isValidFrameMarkPayload(
  data: unknown
): data is FrameMarkPayload {
  if (typeof data !== 'object' || data === null) return false;
  const mark = data as Record<string, unknown>;
  if (
    typeof mark.id !== 'string' ||
    mark.id.length === 0 ||
    mark.id.length > 256
  ) {
    return false;
  }
  if (mark.kind === 'quote') {
    if (typeof mark.exact !== 'string') return false;
    if (
      new TextEncoder().encode(mark.exact).length >
      COMMENT_ANCHOR_QUOTE_LIMIT_BYTES
    ) {
      return false;
    }
    if (
      mark.prefix !== undefined &&
      (typeof mark.prefix !== 'string' ||
        new TextEncoder().encode(mark.prefix).length >
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
    ) {
      return false;
    }
    if (
      mark.suffix !== undefined &&
      (typeof mark.suffix !== 'string' ||
        new TextEncoder().encode(mark.suffix).length >
          COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES)
    ) {
      return false;
    }
    return true;
  }
  if (mark.kind === 'region') {
    return isValidAnchorRect(mark.rect);
  }
  if (mark.kind === 'pin') {
    return isUnitPoint(mark.x, mark.y);
  }
  return false;
}

export interface PaintMarkMessage {
  readonly type: 'relic:paint-mark';
  readonly mark: FrameMarkPayload;
}

export function isPaintMarkMessage(data: unknown): data is PaintMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:paint-mark') return false;
  return isValidFrameMarkPayload(msg.mark);
}

export interface PaintMarksMessage {
  readonly type: 'relic:paint-marks';
  readonly marks: readonly FrameMarkPayload[];
}

export function isPaintMarksMessage(data: unknown): data is PaintMarksMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:paint-marks') return false;
  if (!Array.isArray(msg.marks)) return false;
  return msg.marks.every(isValidFrameMarkPayload);
}

export interface ClearMarkMessage {
  readonly type: 'relic:clear-mark';
  readonly id: string;
}

export function isClearMarkMessage(data: unknown): data is ClearMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'relic:clear-mark' && typeof msg.id === 'string';
}

export interface ClearMarksMessage {
  readonly type: 'relic:clear-marks';
}

export function isClearMarksMessage(data: unknown): data is ClearMarksMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'relic:clear-marks';
}

export interface RevealMarkMessage {
  readonly type: 'relic:reveal-mark';
  readonly id?: string;
  readonly kind?: 'quote' | 'region' | 'pin';
  readonly exact?: string;
  readonly rect?: AnchorRect;
  readonly point?: { readonly x: number; readonly y: number };
}

export function isRevealMarkMessage(data: unknown): data is RevealMarkMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'relic:reveal-mark') return false;
  if (msg.id !== undefined && typeof msg.id !== 'string') return false;
  if (
    msg.kind !== undefined &&
    msg.kind !== 'quote' &&
    msg.kind !== 'region' &&
    msg.kind !== 'pin'
  ) {
    return false;
  }
  if (msg.exact !== undefined && typeof msg.exact !== 'string') return false;
  if (msg.rect !== undefined && !isValidAnchorRect(msg.rect)) return false;
  if (msg.point !== undefined) {
    if (typeof msg.point !== 'object' || msg.point === null) return false;
    const point = msg.point as Record<string, unknown>;
    if (!isUnitPoint(point.x, point.y)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Adapters for iframe.usercontent-frame
// ---------------------------------------------------------------------------

function isFrameSurface(surface: AnchorSurface): boolean {
  const content = surface.content;
  if (!content || typeof content !== 'object') return false;
  if (
    typeof HTMLIFrameElement !== 'undefined' &&
    content instanceof HTMLIFrameElement
  ) {
    return content.classList.contains('usercontent-frame');
  }
  if ('tagName' in content && typeof content.tagName === 'string') {
    if (content.tagName.toUpperCase() !== 'IFRAME') return false;
    if (
      'classList' in content &&
      content.classList &&
      typeof content.classList === 'object'
    ) {
      const cl = content.classList;
      if ('contains' in cl && typeof cl.contains === 'function') {
        return Boolean(cl.contains('usercontent-frame'));
      }
    }
    if ('className' in content && typeof content.className === 'string') {
      return content.className.includes('usercontent-frame');
    }
  }
  return false;
}

function frameWindow(surface: AnchorSurface): Window | undefined {
  const content = surface.content;
  if (content && typeof content === 'object' && 'contentWindow' in content) {
    const win = content.contentWindow;
    if (win && typeof win === 'object' && 'postMessage' in win) {
      return win as Window;
    }
  }
  return undefined;
}

/**
 * Adapter for quote anchors targeting text rendered inside a sandboxed iframe.
 *
 * Claims kind 'quote' strictly when the rendered stage holds an iframe.usercontent-frame.
 * Forwards paint and reveal instructions across postMessage to the frame shim.
 */
export const frameQuoteAdapter: AnchorAdapter<'quote'> = {
  kind: 'quote',

  label(anchor: Extract<CommentAnchor, { kind: 'quote' }>): string {
    const plain = anchor.exact.replace(
      /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g,
      ''
    );
    const shown =
      plain.length > 60 ? `${plain.slice(0, 60).trimEnd()}…` : plain;
    return `Commenting on "${shown}"`;
  },

  supports(surface: AnchorSurface): boolean {
    return isFrameSurface(surface);
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'quote' }>,
    commentId: string
  ): boolean {
    if (!isFrameSurface(surface)) return false;
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:paint-mark',
        mark: {
          id: commentId,
          kind: 'quote',
          exact: anchor.exact,
          ...(anchor.prefix ? { prefix: anchor.prefix } : {}),
          ...(anchor.suffix ? { suffix: anchor.suffix } : {}),
        },
      } satisfies PaintMarkMessage,
      '*'
    );
    return true;
  },

  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'quote' }>
  ): void {
    if (!isFrameSurface(surface)) return;
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:reveal-mark',
        kind: 'quote',
        exact: anchor.exact,
      } satisfies RevealMarkMessage,
      '*'
    );
  },
};

/**
 * The box this viewer used to store for a click on a framed relic.
 *
 * Until a click there placed a pin, it was saved as a region three
 * hundredths of the document wide and three hundredths tall, centred on the
 * click. Both sides are shares of the whole scrolling document, so on a long
 * document the "point" was a strip sixty pixels wide and hundreds tall
 * running down the page. A posted anchor is sealed under the relic's key by
 * whoever wrote it and cannot be rewritten, so it is drawn as what the
 * reader placed: a point at the box's centre. A dragged box never has these
 * exact sides, because its sides are the distance the pointer travelled.
 */
export function legacyFramePoint(
  rect: AnchorRect
): { readonly x: number; readonly y: number } | undefined {
  if (rect.w !== 0.03 || rect.h !== 0.03) return undefined;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * Adapter for region anchors targeting a box on a sandboxed iframe.
 *
 * Coordinates are unit rectangles relative to the frame's scrolling document box.
 * Claims kind 'region' strictly when the rendered stage holds an iframe.usercontent-frame.
 */
export const frameRegionAdapter: AnchorAdapter<'region'> = {
  kind: 'region',

  label(anchor: Extract<CommentAnchor, { kind: 'region' }>): string {
    return legacyFramePoint(anchor.rect) === undefined
      ? 'Commenting on a region'
      : 'Commenting on a point';
  },

  supports(surface: AnchorSurface): boolean {
    return isFrameSurface(surface);
  },

  paint(
    surface: AnchorSurface,
    overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'region' }>,
    commentId: string
  ): boolean {
    if (!isFrameSurface(surface)) return false;
    const point = legacyFramePoint(anchor.rect);
    if (point !== undefined) {
      return framePinAdapter.paint(
        surface,
        overlay,
        { kind: 'pin', ...point },
        commentId
      );
    }
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:paint-mark',
        mark: {
          id: commentId,
          kind: 'region',
          rect: anchor.rect,
        },
      } satisfies PaintMarkMessage,
      '*'
    );
    return true;
  },
  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'region' }>
  ): void {
    if (!isFrameSurface(surface)) return;
    const point = legacyFramePoint(anchor.rect);
    if (point !== undefined) {
      framePinAdapter.reveal?.(surface, { kind: 'pin', ...point });
      return;
    }
    const win = frameWindow(surface);
    win?.postMessage(
      {
        type: 'relic:reveal-mark',
        kind: 'region',
        rect: anchor.rect,
      } satisfies RevealMarkMessage,
      '*'
    );
  },
};

/**
 * Adapter for a point placed on a sandboxed iframe.
 *
 * A point on the page's own DOM is drawn by the stage over its own scroll.
 * A framed relic scrolls inside the frame, out of this origin's reach, so a
 * pin drawn out here would stay put while the passage it marks scrolled
 * away. The frame draws it instead, at the stored share of its scrolling
 * document and at a fixed size in pixels, which is what makes it a point on
 * a document of any length.
 */
export const framePinAdapter: AnchorAdapter<'pin'> = {
  kind: 'pin',

  label(_anchor: Extract<CommentAnchor, { kind: 'pin' }>): string {
    return 'Commenting on a point';
  },

  supports(surface: AnchorSurface): boolean {
    return isFrameSurface(surface);
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'pin' }>,
    commentId: string
  ): boolean {
    if (!isFrameSurface(surface)) return false;
    frameWindow(surface)?.postMessage(
      {
        type: 'relic:paint-mark',
        mark: { id: commentId, kind: 'pin', x: anchor.x, y: anchor.y },
      } satisfies PaintMarkMessage,
      '*'
    );
    return true;
  },

  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'pin' }>
  ): void {
    if (!isFrameSurface(surface)) return;
    frameWindow(surface)?.postMessage(
      {
        type: 'relic:reveal-mark',
        kind: 'pin',
        point: { x: anchor.x, y: anchor.y },
      } satisfies RevealMarkMessage,
      '*'
    );
  },
};
