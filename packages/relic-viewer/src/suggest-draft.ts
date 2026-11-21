import {
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
  SUGGESTION_REPLACEMENT_LIMIT_BYTES,
  type CommentPlaintext,
  type SuggestionMode,
  type SuggestionPayload,
} from '@relic/format';
import { locate, suggestionFallbackBody } from '@relic/format/suggestions';
import { takeHeadUtf8, takeTailUtf8 } from './annotate-quote.ts';
import type {
  MarkdownDelimiterPair,
  SourceSegment,
} from './markdown-source.ts';

export type SuggestBlockKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'quote'
  | 'table-cell'
  | 'fenced-code'
  | 'csv-quoted'
  | 'csv-bare'
  | 'cue'
  | 'nb-markdown'
  | 'nb-code'
  | 'nb-raw'
  | 'code';

/** Positions are UTF-16 source offsets, except positions inside an insertion. */
export interface PendingSuggestion {
  readonly id: string;
  readonly author: string;
  readonly displayName: string;
  readonly version: number;
  /** The edited source range, not the adjacent anchor of an insertion. */
  readonly start: number;
  readonly end: number;
  readonly inserted: string;
}

export interface SuggestDraftOptions {
  readonly source: string;
  readonly segments: readonly SourceSegment[];
  readonly delimiters: readonly MarkdownDelimiterPair[];
  readonly version: number;
  readonly reader: string;
  readonly crlf?: boolean;
  readonly pending?: readonly PendingSuggestion[];
  readonly encode?: (
    block: number,
    text: string,
    start: number,
    end: number
  ) =>
    | { readonly ok: true; readonly source: string }
    | { readonly ok: false; readonly refusal: SuggestRefusal };
  readonly decode?: (block: number, source: string) => string;
  readonly emptyAnchor?: (
    block: number,
    position: number
  ) =>
    | {
        readonly start: number;
        readonly end: number;
        readonly mode: 'before' | 'after';
      }
    | undefined;
}

export interface SuggestDraft {
  readonly start: number;
  readonly end: number;
  readonly struck: string;
  readonly inserted: string;
  readonly block: number;
  readonly blockKind: SuggestBlockKind;
  readonly existingId: string | null;
  readonly struckBytes: number;
  readonly insertedBytes: number;
}

export type SuggestRefusalCode =
  | 'others-insertion'
  | 'crosses-formatting'
  | 'crosses-blocks'
  | 'quote-too-long'
  | 'too-long'
  | 'newline-here'
  | 'pipe-in-cell'
  | 'delimiter-in-cell'
  | 'quote-in-cell'
  | 'markup-in-cue'
  | 'ends-cue'
  | 'not-editable'
  | 'line-break-in-crlf-file'
  | 'repeats'
  | 'tab-here'
  | 'invalid-range'
  | 'invalid-character'
  | 'empty-source'
  | 'edit-edge';

export interface SuggestRefusal {
  readonly kind: 'refused';
  readonly code: SuggestRefusalCode;
  readonly message: string;
}

export type DraftChange =
  | { readonly kind: 'changed'; readonly draft: SuggestDraft }
  | { readonly kind: 'unchanged' }
  | SuggestRefusal;

export type SuggestCommit =
  | {
      readonly kind: 'save';
      readonly plaintext: CommentPlaintext;
      readonly existingId: string | null;
    }
  | { readonly kind: 'delete'; readonly existingId: string }
  | { readonly kind: 'empty' }
  | SuggestRefusal;

export type DraftEvent =
  | { readonly type: 'caret'; readonly block: number | null }
  | { readonly type: 'focus-left' | 'suggesting-off' | 'shortcut' | 'escape' };

export type DraftEventResult =
  | { readonly kind: 'none' | 'cancelled' }
  | { readonly kind: 'commit'; readonly result: SuggestCommit };

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;
const number = (n: number): string => n.toLocaleString('en-US');

function refused(code: SuggestRefusalCode, message: string): SuggestRefusal {
  return { kind: 'refused', code, message };
}
const crlfLineBreak = (): SuggestRefusal =>
  refused(
    'line-break-in-crlf-file',
    'A suggestion cannot insert a line break in a CRLF file.'
  );

const formatting = (): SuggestRefusal =>
  refused(
    'crosses-formatting',
    'A suggestion can’t cross formatting or a link. Select inside it, or around it.'
  );
const blocks = (): SuggestRefusal =>
  refused(
    'crosses-blocks',
    'A suggestion stays inside one paragraph. Select within a single block.'
  );
const editEdge = (): SuggestRefusal =>
  refused(
    'edit-edge',
    'That reaches past your own suggestion. Leave it, then start a new one beside it.'
  );
const invalidRange = (): SuggestRefusal =>
  refused(
    'invalid-range',
    'This selection could not be matched to the source.'
  );

function quoteLimit(length: number): SuggestRefusal {
  return refused(
    'quote-too-long',
    `That strikes ${number(length)} bytes. A suggestion can strike up to 512.`
  );
}

function insertionLimit(length: number): SuggestRefusal {
  return refused(
    'too-long',
    `That would insert ${number(length)} bytes. A suggestion can insert up to 2,048.`
  );
}

function newlineRefusal(kind: SuggestBlockKind): SuggestRefusal {
  const inside =
    kind === 'list'
      ? 'a list item'
      : kind === 'quote'
        ? 'a quote'
        : kind === 'table-cell'
          ? 'a table cell'
          : 'a heading';
  return refused(
    'newline-here',
    `A line break can’t go inside ${inside}. Suggest the words, and reply if the layout should change.`
  );
}

function validReplacement(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code <= 0x08 ||
      (code >= 0x0b && code <= 0x1f) ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

// ES2022's standard library declarations do not include Intl.Segmenter.
type GraphemePart = { readonly segment: string; readonly index: number };
type GraphemeSegmenter = {
  segment(text: string): {
    containing(index: number): GraphemePart | undefined;
  };
};
const intlWithSegmenter = Intl as unknown as {
  Segmenter: new (
    locale: string,
    options: { granularity: 'grapheme' }
  ) => GraphemeSegmenter;
};
const graphemes = new intlWithSegmenter.Segmenter('und', {
  granularity: 'grapheme',
});

function graphemeBefore(text: string, position: number): number | null {
  if (position <= 0) return null;
  const part = graphemes.segment(text).containing(position - 1);
  return part && part.index + part.segment.length === position
    ? part.index
    : null;
}

function graphemeAfter(text: string, position: number): number | null {
  const part = graphemes.segment(text).containing(position);
  return part && part.index === position
    ? part.index + part.segment.length
    : null;
}

function boundary(text: string, position: number): boolean {
  return (
    position === 0 ||
    position === text.length ||
    graphemeAfter(text, position) !== null
  );
}

/** No DOM nodes or rendered HTML enter this model. */
export class SuggestDraftModel {
  private current: SuggestDraft | null = null;
  private readonly pending: readonly PendingSuggestion[];

  constructor(private readonly options: SuggestDraftOptions) {
    this.pending = options.pending ?? [];
  }

  get draft(): SuggestDraft | null {
    return this.current;
  }

  private makeDraft(
    start: number,
    end: number,
    inserted: string,
    block: number,
    blockKind: SuggestBlockKind,
    existingId: string | null
  ): SuggestDraft {
    const struck = this.options.source.slice(start, end);
    return {
      start,
      end,
      struck,
      inserted,
      block,
      blockKind,
      existingId,
      struckBytes: bytes(struck),
      insertedBytes: bytes(inserted),
    };
  }

  private segmentAt(
    position: number,
    side: 'start' | 'end',
    block?: number
  ): SourceSegment | undefined {
    return this.options.segments.find(
      (segment) =>
        (block === undefined || segment.block === block) &&
        (side === 'start'
          ? segment.start <= position && position < segment.end
          : segment.start < position && position <= segment.end)
    );
  }

  private rangeBlock(
    start: number,
    end: number,
    blockHint?: number
  ): number | SuggestRefusal {
    const { source, segments, delimiters } = this.options;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > source.length ||
      !boundary(source, start) ||
      !boundary(source, end)
    )
      return invalidRange();
    if (start === end) {
      const segment =
        this.segmentAt(start, 'start', blockHint) ??
        this.segmentAt(start, 'end', blockHint) ??
        segments.find(
          (item) =>
            item.start === start &&
            item.end === end &&
            (blockHint === undefined || item.block === blockHint)
        );
      if (!segment) return invalidRange();
      if (
        (segment.kind === 'join' || segment.kind === 'escape') &&
        start !== segment.start &&
        start !== segment.end
      )
        return formatting();
      return segment.block;
    }
    const first = this.segmentAt(start, 'start', blockHint);
    const last = this.segmentAt(end, 'end', blockHint);
    if (!first || !last) return invalidRange();
    if (first.block !== last.block) return blocks();
    if (
      segments.some(
        (segment) =>
          segment.start < end &&
          segment.end > start &&
          segment.block !== first.block
      )
    )
      return blocks();
    if (
      ((first.kind === 'join' || first.kind === 'escape') &&
        start !== first.start) ||
      ((last.kind === 'join' || last.kind === 'escape') && end !== last.end)
    )
      return formatting();
    const coverage: { start: number; end: number }[] = segments
      .filter(
        (segment) =>
          segment.block === first.block &&
          segment.start < end &&
          segment.end > start
      )
      .map((segment) => ({ start: segment.start, end: segment.end }));
    for (const pair of delimiters) {
      if (pair.block !== first.block) continue;
      const intersects = (part: { start: number; end: number }): boolean =>
        start < part.end && end > part.start;
      const covers = (part: { start: number; end: number }): boolean =>
        start <= part.start && end >= part.end;
      const open = intersects(pair.open);
      const close = intersects(pair.close);
      if (
        open !== close ||
        (open && (!covers(pair.open) || !covers(pair.close)))
      )
        return formatting();
      if (open && close) {
        coverage.push(pair.open, pair.close);
        if (
          (pair.kind === 'link' || pair.kind === 'image') &&
          source[pair.close.end] === '('
        ) {
          const targetEnd = source.indexOf(')', pair.close.end + 1);
          if (targetEnd !== -1 && targetEnd < end) {
            coverage.push({ start: pair.close.end, end: targetEnd + 1 });
          }
        }
      }
    }
    // Text joins may have invisible source between their segments, such as a
    // blockquote marker. Never consume that markup as if it were visible text.
    coverage.sort((a, b) => a.start - b.start);
    let covered = start;
    for (const range of coverage) {
      if (range.start > covered) return formatting();
      covered = Math.max(covered, range.end);
    }
    if (covered < end) return formatting();
    return first.block;
  }

  private accept(candidate: SuggestDraft): DraftChange {
    const block = this.rangeBlock(
      candidate.start,
      candidate.end,
      candidate.block
    );
    if (typeof block !== 'number') return block;
    const encoded = this.options.encode?.(
      candidate.block,
      candidate.inserted,
      candidate.start,
      candidate.end
    );
    if (encoded && !encoded.ok) return encoded.refusal;
    if (
      encoded?.ok &&
      bytes(encoded.source) > SUGGESTION_REPLACEMENT_LIMIT_BYTES
    )
      return insertionLimit(bytes(encoded.source));
    if (candidate.struckBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES)
      return quoteLimit(candidate.struckBytes);
    if (candidate.insertedBytes > SUGGESTION_REPLACEMENT_LIMIT_BYTES)
      return insertionLimit(candidate.insertedBytes);
    if (this.options.crlf && /[\r\n]/.test(candidate.inserted))
      return crlfLineBreak();
    if (!validReplacement(candidate.inserted))
      return refused(
        'invalid-character',
        'This suggestion contains unsupported characters.'
      );
    if (
      candidate.inserted.includes('\n') &&
      candidate.blockKind !== 'paragraph' &&
      candidate.blockKind !== 'code' &&
      candidate.blockKind !== 'fenced-code'
    )
      return newlineRefusal(candidate.blockKind);
    if (
      candidate.inserted.includes('\t') &&
      candidate.blockKind !== 'code' &&
      candidate.blockKind !== 'fenced-code'
    )
      return refused('tab-here', 'Tab works only in code.');
    if (
      candidate.blockKind === 'table-cell' &&
      candidate.inserted.includes('|')
    ) {
      return refused(
        'pipe-in-cell',
        'A | would split this table cell. Use another character, or reply describing the change.'
      );
    }
    this.current = candidate;
    return { kind: 'changed', draft: candidate };
  }

  /** Replace a source selection, or insert at a collapsed source offset. */
  replace(
    start: number,
    end: number,
    text: string,
    blockKind: SuggestBlockKind
  ): DraftChange {
    const block = this.rangeBlock(start, end);
    if (typeof block !== 'number') return block;
    let draft = this.current;
    if (draft && (draft.block !== block || draft.blockKind !== blockKind))
      return blocks();
    if (!draft) {
      const matches = this.pending.filter(
        (item) =>
          item.version === this.options.version &&
          item.author.toLowerCase() === this.options.reader.toLowerCase() &&
          item.start <= end &&
          item.end >= start
      );
      if (matches.length > 1) return editEdge();
      const own = matches[0];
      if (own)
        draft = this.makeDraft(
          own.start,
          own.end,
          this.options.decode?.(block, own.inserted) ?? own.inserted,
          block,
          blockKind,
          own.id
        );
    }
    if (!draft)
      return this.accept(
        this.makeDraft(start, end, text, block, blockKind, null)
      );
    if (start >= draft.end) {
      return this.accept(
        this.makeDraft(
          draft.start,
          end,
          draft.inserted +
            (this.options.decode?.(
              block,
              this.options.source.slice(draft.end, start)
            ) ?? this.options.source.slice(draft.end, start)) +
            text,
          block,
          blockKind,
          draft.existingId
        )
      );
    }
    if (end <= draft.start) {
      return this.accept(
        this.makeDraft(
          start,
          draft.end,
          text +
            (this.options.decode?.(
              block,
              this.options.source.slice(end, draft.start)
            ) ?? this.options.source.slice(end, draft.start)) +
            draft.inserted,
          block,
          blockKind,
          draft.existingId
        )
      );
    }
    if (start <= draft.start && end >= draft.end) {
      return this.accept(
        this.makeDraft(start, end, text, block, blockKind, draft.existingId)
      );
    }
    return editEdge();
  }

  /** Edit offsets inside a rendered insertion. Omit commentId for the open draft. */
  editInsertion(
    start: number,
    end: number,
    text: string,
    blockKind: SuggestBlockKind,
    commentId?: string
  ): DraftChange {
    let draft = this.current;
    if (commentId !== undefined) {
      const pending = this.pending.find(
        (item) => item.id === commentId && item.version === this.options.version
      );
      if (!pending) return invalidRange();
      if (pending.author.toLowerCase() !== this.options.reader.toLowerCase()) {
        return refused(
          'others-insertion',
          `That text is ${pending.displayName}’s suggestion. Reply to it instead.`
        );
      }
      if (draft && draft.existingId !== commentId) return editEdge();
      if (!draft) {
        const block = this.rangeBlock(pending.start, pending.end);
        if (typeof block !== 'number') return block;
        draft = this.makeDraft(
          pending.start,
          pending.end,
          this.options.decode?.(block, pending.inserted) ?? pending.inserted,
          block,
          blockKind,
          pending.id
        );
      }
    }
    if (
      !draft ||
      draft.blockKind !== blockKind ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > draft.inserted.length ||
      !boundary(draft.inserted, start) ||
      !boundary(draft.inserted, end)
    )
      return invalidRange();
    return this.accept(
      this.makeDraft(
        draft.start,
        draft.end,
        draft.inserted.slice(0, start) + text + draft.inserted.slice(end),
        draft.block,
        draft.blockKind,
        draft.existingId
      )
    );
  }

  enter(start: number, end: number, blockKind: SuggestBlockKind): DraftChange {
    if (this.options.crlf) return crlfLineBreak();
    if (
      blockKind !== 'paragraph' &&
      blockKind !== 'code' &&
      blockKind !== 'fenced-code'
    )
      return newlineRefusal(blockKind);
    return this.replace(
      start,
      end,
      blockKind === 'paragraph' ? '\n\n' : '\n',
      blockKind
    );
  }

  tab(start: number, end: number, blockKind: SuggestBlockKind): DraftChange {
    if (blockKind !== 'code' && blockKind !== 'fenced-code')
      return refused('tab-here', 'Tab works only in code.');
    return this.replace(start, end, '\t', blockKind);
  }

  /** Backspace or Delete at the outside of the insertion extends its strike. */
  extendStrike(direction: 'left' | 'right'): DraftChange {
    const draft = this.current;
    if (!draft) return { kind: 'unchanged' };
    const position = direction === 'left' ? draft.start : draft.end;
    const segment = this.segmentAt(
      position,
      direction === 'left' ? 'end' : 'start',
      draft.block
    );
    if (!segment) {
      const hasTextBeyond = this.options.segments.some(
        (item) =>
          item.block === draft.block &&
          (direction === 'left' ? item.end < position : item.start > position)
      );
      return hasTextBeyond ? formatting() : { kind: 'unchanged' };
    }
    let adjacent: number | null;
    if (segment.kind === 'join' || segment.kind === 'escape')
      adjacent = direction === 'left' ? segment.start : segment.end;
    else
      adjacent =
        direction === 'left'
          ? graphemeBefore(this.options.source, position)
          : graphemeAfter(this.options.source, position);
    if (adjacent === null) return invalidRange();
    return this.accept(
      this.makeDraft(
        direction === 'left' ? adjacent : draft.start,
        direction === 'right' ? adjacent : draft.end,
        draft.inserted,
        draft.block,
        draft.blockKind,
        draft.existingId
      )
    );
  }

  /** Build the sealed plaintext only after checking that its source anchor resolves here. */
  commit(displayName: string | null): SuggestCommit {
    const draft = this.current;
    if (!draft) return { kind: 'empty' };
    const encoded = this.options.encode?.(
      draft.block,
      draft.inserted,
      draft.start,
      draft.end
    );
    if (encoded && !encoded.ok) return encoded.refusal;
    const replacement = encoded?.ok ? encoded.source : draft.inserted;
    if (draft.struck === replacement) {
      return draft.existingId === null
        ? { kind: 'empty' }
        : { kind: 'delete', existingId: draft.existingId };
    }
    const { source } = this.options;
    let start = draft.start;
    let end = draft.end;
    let mode: SuggestionMode = 'replace';
    if (start === end) {
      const previous = this.segmentAt(start, 'end', draft.block);
      const next = this.segmentAt(start, 'start', draft.block);
      const empty = this.options.emptyAnchor?.(draft.block, start);
      if (empty) {
        if (
          !Number.isInteger(empty.start) ||
          !Number.isInteger(empty.end) ||
          empty.start < 0 ||
          empty.end > source.length ||
          empty.start >= empty.end ||
          (empty.mode === 'before'
            ? empty.start !== start
            : empty.end !== start)
        )
          return invalidRange();
        start = empty.start;
        end = empty.end;
        mode = empty.mode;
      } else if (previous) {
        const found =
          previous.kind === 'join' || previous.kind === 'escape'
            ? previous.start
            : graphemeBefore(source, start);
        if (found === null) return invalidRange();
        start = found;
        mode = 'after';
      } else if (next) {
        const found =
          next.kind === 'join' || next.kind === 'escape'
            ? next.end
            : graphemeAfter(source, end);
        if (found === null) return invalidRange();
        end = found;
        mode = 'before';
      } else {
        return refused(
          'empty-source',
          'There is no source text to anchor this suggestion.'
        );
      }
    }
    const exact = source.slice(start, end);
    if (!exact || exact.includes('\r')) return invalidRange();
    if (bytes(exact) > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES)
      return quoteLimit(bytes(exact));
    const prefix = takeTailUtf8(
      source.slice(source.lastIndexOf('\r', start - 1) + 1, start),
      COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
    );
    const suffix = takeHeadUtf8(
      source.slice(
        end,
        source.indexOf('\r', end) < 0
          ? source.length
          : source.indexOf('\r', end)
      ),
      COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
    );
    const found = locate(source, exact, prefix, suffix);
    if (
      found.status !== 'resolved' ||
      found.start !== start ||
      found.end !== end
    ) {
      return refused(
        'repeats',
        'This passage repeats in the source. Select a longer passage.'
      );
    }
    const suggestion: SuggestionPayload = {
      v: 1,
      mode,
      replacement,
    };
    return {
      kind: 'save',
      existingId: draft.existingId,
      plaintext: {
        body: suggestionFallbackBody(exact, suggestion),
        display_name: displayName,
        addresses: null,
        anchor: {
          kind: 'source',
          exact,
          ...(prefix ? { prefix } : {}),
          ...(suffix ? { suffix } : {}),
        },
        suggestion,
      },
    };
  }

  cancel(): void {
    this.current = null;
  }

  event(event: DraftEvent, displayName: string | null): DraftEventResult {
    if (event.type === 'escape') {
      if (!this.current) return { kind: 'none' };
      this.cancel();
      return { kind: 'cancelled' };
    }
    if (
      !this.current ||
      (event.type === 'caret' && event.block === this.current.block)
    )
      return { kind: 'none' };
    return { kind: 'commit', result: this.commit(displayName) };
  }
}
