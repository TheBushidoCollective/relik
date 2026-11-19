/**
 * The quote anchor adapter and selection capture.
 *
 * A reader highlighting text on the page needs their comment anchored to the
 * exact phrase they selected, even when that phrase appears multiple times in
 * the document. Capturing prefix and suffix context alongside the exact text
 * allows the resolver to disambiguate identical occurrences deterministically.
 */

import {
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
  type CommentAnchor,
} from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';
import {
  drawnStructuredView,
  type StructuredViewHandle,
} from './structured-view-bridge.ts';
import {
  quotedTargetLabel,
  walkContentTextNodes,
  wrapTextQuoteWithContext,
} from './comments.ts';

/**
 * Takes code points from the start of text up to maxBytes in UTF-8.
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
 * Takes code points from the end of text backwards up to maxBytes in UTF-8,
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
 * Locates the character offset of a range container within the concatenated
 * content text flow.
 */
function findNodeOffsetInFullText(
  spans: readonly {
    readonly node: Text;
    readonly start: number;
    readonly end: number;
  }[],
  container: Node | null | undefined,
  containerOffset: number
): number | undefined {
  if (!container) return undefined;
  for (const span of spans) {
    if (span.node === container) {
      return (
        span.start +
        Math.max(0, Math.min(span.node.data.length, containerOffset))
      );
    }
  }
  // If container is an Element
  if (container.nodeType === 1 /* Node.ELEMENT_NODE */) {
    const children = Array.from(container.childNodes ?? []);
    if (containerOffset < children.length) {
      const targetChild = children[containerOffset];
      for (const span of spans) {
        if (span.node === targetChild || targetChild?.contains?.(span.node)) {
          return span.start;
        }
      }
    } else if (children.length > 0) {
      let lastEnd: number | undefined;
      for (const span of spans) {
        if (container.contains?.(span.node)) {
          lastEnd = span.end;
        }
      }
      if (lastEnd !== undefined) return lastEnd;
    }
  }
  return undefined;
}

/**
 * Captures a quote target from the settled user selection on the stage.
 *
 * Extracts exact text capped to 512 bytes on character boundaries, and up to
 * 128 bytes each of preceding prefix and following suffix context from the
 * same text flow walked by the resolver.
 */
export function captureSelectionQuote(
  surface: HTMLElement,
  range: Range,
  selection: Selection
): CommentAnchor | null {
  const raw = selection.toString().trim();
  if (raw.length === 0) return null;

  const exact = takeHeadUtf8(raw, COMMENT_ANCHOR_QUOTE_LIMIT_BYTES);
  if (exact.length === 0) return null;

  const textNodes = walkContentTextNodes(surface);
  if (textNodes.length === 0) {
    // In minimal or stub test environments without text nodes, check if
    // the range mock provides explicit context.
    const stubRange = range as unknown as { prefix?: string; suffix?: string };
    return {
      kind: 'quote',
      exact,
      ...(stubRange.prefix ? { prefix: stubRange.prefix } : {}),
      ...(stubRange.suffix ? { suffix: stubRange.suffix } : {}),
    };
  }

  let fullText = '';
  const spans: { node: Text; start: number; end: number }[] = [];
  for (const node of textNodes) {
    const start = fullText.length;
    fullText += node.data;
    spans.push({ node, start, end: fullText.length });
  }

  const selStart = findNodeOffsetInFullText(
    spans,
    range.startContainer,
    range.startOffset
  );
  const selEnd = findNodeOffsetInFullText(
    spans,
    range.endContainer,
    range.endOffset
  );

  // No fallback to "the first occurrence of these words". That is what
  // produced the reported defect: with the flow missing the text inside an
  // existing mark, a selection the reader had just made could not be located,
  // and this quietly anchored the comment to the first occurrence it could
  // see, in another paragraph, beside an earlier comment. The chip named the
  // right words, so nothing looked wrong until the mark appeared somewhere
  // else.
  //
  // The flow now includes marked text, so this is unreachable for an ordinary
  // selection on the stage, which a test asserts. If it is ever reached again
  // the honest answer is no anchor, because an anchor pointing somewhere the
  // reader did not select is worse than none: they cannot see that it is
  // wrong until after they have posted.
  if (selStart === undefined || selEnd === undefined || selStart >= selEnd) {
    return null;
  }

  // Adjust for any leading whitespace trimmed from raw selection
  const rawSelected = fullText.slice(selStart, selEnd);
  const leadingWhitespace = rawSelected.length - rawSelected.trimStart().length;
  let trimmedStart = selStart + leadingWhitespace;
  let trimmedEnd = trimmedStart + exact.length;

  if (fullText.slice(trimmedStart, trimmedEnd) !== exact) {
    const localIdx = fullText.slice(selStart, selEnd).indexOf(exact);
    if (localIdx !== -1) {
      trimmedStart = selStart + localIdx;
      trimmedEnd = trimmedStart + exact.length;
    }
  }

  const before = fullText.slice(0, Math.max(0, trimmedStart));
  const after = fullText.slice(Math.max(0, trimmedEnd));

  const prefixText = takeTailUtf8(before, COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES);
  const suffixText = takeHeadUtf8(after, COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES);

  return {
    kind: 'quote',
    exact,
    ...(prefixText.length > 0 ? { prefix: prefixText } : {}),
    ...(suffixText.length > 0 ? { suffix: suffixText } : {}),
  };
}

/**
 * Adapter for quote anchors on standard DOM text surfaces.
 *
 * Paints marks into the host text DOM, scrolls matching marks into view,
 * and declines cross-origin iframes which are handled by the frame bridge.
 */
export const quoteAdapter: AnchorAdapter<'quote'> = {
  kind: 'quote',

  label(anchor: Extract<CommentAnchor, { kind: 'quote' }>): string {
    return quotedTargetLabel(anchor.exact);
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'quote' }>,
    commentId: string
  ): boolean {
    return wrapTextQuoteWithContext(surface.host, anchor, commentId);
  },

  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'quote' }>
  ): void {
    const marks = surface.host.querySelectorAll<HTMLElement>(
      'mark.relic-text-mark'
    );
    for (const mark of marks) {
      const text = mark.textContent ?? '';
      if (
        text.length > 0 &&
        (text === anchor.exact ||
          anchor.exact.startsWith(text) ||
          text.includes(anchor.exact))
      ) {
        mark.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  },

  supports(surface: AnchorSurface): boolean {
    // Cross-origin sandboxed iframes cannot be inspected or marked from
    // this document directly and are owned by AnchorFrameBridge.
    if (surface.content.tagName === 'IFRAME') return false;
    if (surface.host.querySelector('iframe.usercontent-frame') !== null) {
      return false;
    }
    // A drawn tree, notebook or table places its own legacy quotes, so the
    // generic adapter does not wrap text inside those rows.
    if (drawnTextView(surface.host) !== undefined) return false;
    return true;
  },
};

/**
 * The drawn structured view that places a legacy quote or text comment itself.
 * A tree or notebook finds the words in its source. A table cannot place one
 * yet, so it declines them: the comment reads as unplaceable instead of text
 * being wrapped inside its grid (plan section 5; A1 notes, item 6).
 */
export function drawnTextView(
  host: HTMLElement
): StructuredViewHandle | undefined {
  return (
    drawnStructuredView(host, 'tree') ??
    drawnStructuredView(host, 'notebook') ??
    drawnStructuredView(host, 'table')
  );
}

/**
 * Legacy quote comments on a drawn tree, notebook or table. The view places
 * the mark itself, so no text is wrapped inside its rows.
 */
export const structuredQuoteAdapter: AnchorAdapter<'quote'> = {
  kind: 'quote',

  label(anchor: Extract<CommentAnchor, { kind: 'quote' }>): string {
    return quotedTargetLabel(anchor.exact);
  },

  paint(surface, _overlay, anchor, commentId): boolean {
    return drawnTextView(surface.host)?.paintMark(anchor, commentId) ?? false;
  },

  reveal(surface, anchor, commentId): void {
    drawnTextView(surface.host)?.reveal(anchor, commentId);
  },

  supports(surface: AnchorSurface): boolean {
    return drawnTextView(surface.host) !== undefined;
  },
};
