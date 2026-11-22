/**
 * Comparing two rendered documents block by block.
 *
 * This runs on the service origin only, in a lazy chunk, over the text each
 * frame reported. It never sees markup and never sees a frame. Its result has
 * the shape `domdiff.ts` produces, so the panes, the change list and the
 * navigator treat a document comparison like any other.
 *
 * It is dependency-light on purpose: the diff library does the two diffs,
 * relic-format supplies the EPUB render order, and the rest is types. No frame
 * module imports it, so none of it is inlined into `sandbox.html`.
 */
import { type Change, diffArrays, diffWordsWithSpace } from 'diff';
import {
  type EpubBook,
  epubRenderOrder,
} from '../../relic-format/src/epub-package.ts';
import type { DiffSegment } from './diff.ts';
import {
  type ChangeJump,
  MAX_LISTED_CHANGES,
  type RenderedChange,
  type TreeDiff,
} from './domdiff.ts';
import type {
  DocumentBlock,
  DocumentBlockKind,
} from './frame-document-protocol.ts';
import type { Anchor, Mark, MarkKind } from './rendered-tree.ts';
import { visibleLabel } from './visible-label.ts';

/**
 * Most edits one comparison may make: blocks removed plus blocks added.
 *
 * A count, not a clock. The same two documents give the same answer on every
 * machine, which a timeout would not. The diff runs on the main thread, and its
 * cost climbs faster than the count: 3,000 periodic edits over 50,000 blocks
 * took about 1.1 s on the development machine, and 5,000 took 4 to 6 s (plan
 * section 7). Hence 3,000.
 */
export const MAX_BLOCK_EDITS = 3_000;

/** Matched blocks handed to the scroll sync, on each side. */
export const MAX_DOCUMENT_ANCHORS = 1_000;

/** A changed pair's word diff stops here and falls back to plain quotes. */
const MAX_WORD_EDITS = 1_000;
/** A removed or added block is quoted at this many characters. */
const MAX_BLOCK_QUOTE = 160;
/** A changed pair shows at most this many characters per side. */
const MAX_PAIR_SIDE = 400;
/** Unchanged text longer than this is cut to the context beside a change. */
const CONTEXT_THRESHOLD = 80;
/** The context kept from unchanged text that touches a change. */
const CONTEXT = 40;
/**
 * The most characters per side one changed pair's word diff reads: its
 * differing span, widened to whole words, with the context around it. A pair
 * past this bound quotes plainly. The diff runs on the main thread, and its
 * cost grows with this bound times the edits it finds, at most
 * `MAX_WORD_EDITS`.
 */
const MAX_PAIR_WINDOW = 4_000;
/**
 * The unchanged text a window keeps beside its change: one more than
 * `CONTEXT_THRESHOLD`, so `excerpt` cuts a window run exactly when it would
 * cut the whole run.
 */
const CONTEXT_WINDOW = CONTEXT_THRESHOLD + 1;
const ELLIPSIS = '\u2026';

const NO_TEXT_CHANGES =
  'No text changes. Formatting, layout and image content are not compared.';

const KIND_LABEL: Readonly<Record<DocumentBlockKind, string>> = {
  paragraph: 'paragraph',
  heading: 'heading',
  'list-item': 'list item',
  'table-cell': 'table cell',
  quote: 'quote',
  code: 'code block',
  caption: 'caption',
  image: 'image',
  media: 'media',
  text: 'text',
};

export interface BlockDiffOptions {
  /**
   * Two blocks may pair only when their keys are equal. The default is the
   * render part, so every DOCX block (part 0) may pair. An EPUB keys by spine
   * path, so a chapter replaced by another never pairs across the boundary.
   */
  readonly partKey?: (side: 'before' | 'after', part: number) => string;
  /**
   * The chapter a part sits in. A change row names it: "paragraph in The
   * crossing". Undefined adds no name.
   */
  readonly partLabel?: (
    side: 'before' | 'after',
    part: number
  ) => string | undefined;
}

export interface BlockDiff extends TreeDiff {
  /** Every change, listed or not: the sidebar count and the navigator. */
  readonly total: number;
  /** The side and part each jump sits in, index-aligned with `jumps`. */
  readonly jumpParts: readonly {
    readonly side: 'before' | 'after';
    readonly part: number;
  }[];
}

/**
 * Diff two documents' blocks in reading order.
 *
 * Returns `'too-many-changes'` past `MAX_BLOCK_EDITS`. Blocks are compared by
 * kind and text, so an image is the same image wherever it appears, and only
 * its presence and position count.
 */
export function diffBlocks(
  before: readonly DocumentBlock[],
  after: readonly DocumentBlock[],
  options: BlockDiffOptions = {}
): BlockDiff | 'too-many-changes' {
  const keys = internKeys(before, after);
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && keys.before[prefix] === keys.after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    keys.before[before.length - 1 - suffix] ===
      keys.after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const hunks = diffArrays(
    keys.before.slice(prefix, keys.before.length - suffix),
    keys.after.slice(prefix, keys.after.length - suffix),
    { maxEditLength: MAX_BLOCK_EDITS }
  );
  if (hunks === undefined) return 'too-many-changes';

  const walk = new BlockWalk(before, after, options);
  walk.keep(0, 0, prefix);
  let beforeAt = prefix;
  let afterAt = prefix;
  let at = 0;
  while (at < hunks.length) {
    const hunk = hunks[at];
    if (hunk === undefined) break;
    if (!hunk.added && !hunk.removed) {
      walk.keep(beforeAt, afterAt, hunk.count);
      beforeAt += hunk.count;
      afterAt += hunk.count;
      at += 1;
    } else if (hunk.added) {
      for (let k = 0; k < hunk.count; k += 1) walk.add(afterAt + k);
      afterAt += hunk.count;
      at += 1;
    } else {
      // A removal directly followed by an addition is one edit made in place.
      const next = hunks[at + 1];
      if (next?.added === true) {
        walk.replace(beforeAt, afterAt, hunk.count, next.count);
        beforeAt += hunk.count;
        afterAt += next.count;
        at += 2;
      } else {
        for (let k = 0; k < hunk.count; k += 1) walk.remove(beforeAt + k);
        beforeAt += hunk.count;
        at += 1;
      }
    }
  }
  walk.keep(before.length - suffix, after.length - suffix, suffix);

  const beforeAnchors: Anchor[] = [];
  const afterAnchors: Anchor[] = [];
  for (const [index, ordinal] of chooseAnchors(
    walk.keptBefore.length,
    walk.neighbours
  ).entries()) {
    const beforeBlock = walk.keptBefore[ordinal];
    const afterBlock = walk.keptAfter[ordinal];
    if (beforeBlock === undefined || afterBlock === undefined) continue;
    const syncId = `a${index}`;
    beforeAnchors.push({ path: [beforeBlock], syncId });
    afterAnchors.push({ path: [afterBlock], syncId });
  }

  const total = walk.jumps.length;
  return {
    changed: total > 0,
    removedMarks: walk.removedMarks,
    addedMarks: walk.addedMarks,
    // Kept even when nothing changed: two identical versions are still scrolled
    // together, and matching them costs nothing.
    beforeAnchors,
    afterAnchors,
    jumps: walk.jumps,
    jumpParts: walk.jumpParts,
    additions: walk.additions,
    removals: walk.removals,
    changes: walk.changes,
    summary: total === 0 ? NO_TEXT_CHANGES : summaryOf(walk),
    total,
  };
}

/**
 * Records the walk over the two block lists: one jump per change, one mark per
 * block, and a listed row for the first `MAX_LISTED_CHANGES` of them.
 */
class BlockWalk {
  readonly removedMarks: Mark[] = [];
  readonly addedMarks: Mark[] = [];
  readonly jumps: ChangeJump[] = [];
  readonly jumpParts: { side: 'before' | 'after'; part: number }[] = [];
  readonly changes: RenderedChange[] = [];
  /** Shared blocks in reading order: `keptBefore[i]` is `keptAfter[i]`. */
  readonly keptBefore: number[] = [];
  readonly keptAfter: number[] = [];
  /**
   * Positions in `kept` beside a change. Anchors keep these first, so the
   * scroll sync always has a reference on each side of every change.
   */
  readonly neighbours = new Set<number>();
  additions = 0;
  removals = 0;
  changed = 0;

  private readonly before: readonly DocumentBlock[];
  private readonly after: readonly DocumentBlock[];
  private readonly partKey: (side: 'before' | 'after', part: number) => string;
  private readonly partLabel:
    | ((side: 'before' | 'after', part: number) => string | undefined)
    | undefined;
  private pairs = 0;
  private inChange = false;

  constructor(
    before: readonly DocumentBlock[],
    after: readonly DocumentBlock[],
    options: BlockDiffOptions
  ) {
    this.before = before;
    this.after = after;
    this.partKey = options.partKey ?? ((_side, part) => String(part));
    this.partLabel = options.partLabel;
  }

  /** A run both versions share. */
  keep(beforeStart: number, afterStart: number, count: number): void {
    if (count === 0) return;
    if (this.inChange) {
      this.neighbours.add(this.keptBefore.length);
      this.inChange = false;
    }
    for (let k = 0; k < count; k += 1) {
      this.keptBefore.push(beforeStart + k);
      this.keptAfter.push(afterStart + k);
    }
  }

  remove(index: number): void {
    const block = blockAt(this.before, index);
    this.startChange();
    const changeId = this.jump('before', block.part, 'removed');
    this.removedMarks.push({ path: [index], kind: 'removed', changeId });
    this.removals += 1;
    if (this.changes.length < MAX_LISTED_CHANGES) {
      this.changes.push({
        kind: 'removed',
        label: this.label('before', block),
        before: quote(block.text),
        after: '',
        jumpIndex: this.jumps.length - 1,
      });
    }
  }

  add(index: number): void {
    const block = blockAt(this.after, index);
    this.startChange();
    const changeId = this.jump('after', block.part, 'added');
    this.addedMarks.push({ path: [index], kind: 'added', changeId });
    this.additions += 1;
    if (this.changes.length < MAX_LISTED_CHANGES) {
      this.changes.push({
        kind: 'added',
        label: this.label('after', block),
        before: '',
        after: quote(block.text),
        jumpIndex: this.jumps.length - 1,
      });
    }
  }

  /**
   * A removal followed by an addition is a modification, not a deletion and an
   * insertion. Positions pair up in order, but only where the two blocks can
   * pair. Any other position reads as a removal, then an addition.
   */
  replace(
    beforeStart: number,
    afterStart: number,
    removed: number,
    added: number
  ): void {
    const paired = Math.min(removed, added);
    let step = 0;
    while (step < paired) {
      if (this.canPair(beforeStart + step, afterStart + step)) {
        this.pair(beforeStart + step, afterStart + step);
        step += 1;
        continue;
      }
      let end = step;
      while (
        end < paired &&
        !this.canPair(beforeStart + end, afterStart + end)
      ) {
        end += 1;
      }
      for (let k = step; k < end; k += 1) this.remove(beforeStart + k);
      for (let k = step; k < end; k += 1) this.add(afterStart + k);
      step = end;
    }
    for (let k = paired; k < removed; k += 1) this.remove(beforeStart + k);
    for (let k = paired; k < added; k += 1) this.add(afterStart + k);
  }

  private pair(beforeIndex: number, afterIndex: number): void {
    const before = blockAt(this.before, beforeIndex);
    const after = blockAt(this.after, afterIndex);
    this.startChange();
    const syncId = `d${this.pairs}`;
    this.pairs += 1;
    const changeId = this.jump('after', after.part, 'changed');
    this.removedMarks.push({
      path: [beforeIndex],
      kind: 'changed',
      syncId,
    });
    this.addedMarks.push({
      path: [afterIndex],
      kind: 'changed',
      syncId,
      changeId,
    });
    this.changed += 1;
    if (this.changes.length < MAX_LISTED_CHANGES) {
      const quotes = pairQuotes(before.text, after.text);
      this.changes.push({
        kind: 'changed',
        label: this.label('after', after),
        before: quotes.before,
        after: quotes.after,
        ...(quotes.segments === undefined ? {} : { segments: quotes.segments }),
        jumpIndex: this.jumps.length - 1,
      });
    }
  }

  private canPair(beforeIndex: number, afterIndex: number): boolean {
    const before = blockAt(this.before, beforeIndex);
    const after = blockAt(this.after, afterIndex);
    return (
      this.partKey('before', before.part) === this.partKey('after', after.part)
    );
  }

  /** The neighbour before a change run is the last block kept before it. */
  private startChange(): void {
    if (this.inChange) return;
    this.inChange = true;
    const last = this.keptBefore.length - 1;
    if (last >= 0) this.neighbours.add(last);
  }

  private jump(side: 'before' | 'after', part: number, kind: MarkKind): string {
    const changeId = `c${this.jumps.length}`;
    this.jumps.push({ side, changeId, kind });
    this.jumpParts.push({ side, part });
    return changeId;
  }

  private label(side: 'before' | 'after', block: DocumentBlock): string {
    const kind = KIND_LABEL[block.kind];
    const chapter = this.partLabel?.(side, block.part);
    return chapter === undefined ? kind : `${kind} in ${chapter}`;
  }
}

function summaryOf(walk: BlockWalk): string {
  const terms: string[] = [];
  if (walk.additions > 0) terms.push(`${walk.additions} added`);
  if (walk.removals > 0) terms.push(`${walk.removals} removed`);
  if (walk.changed > 0) terms.push(`${walk.changed} changed`);
  return `${terms.join(', ')}.`;
}

function blockAt(
  blocks: readonly DocumentBlock[],
  index: number
): DocumentBlock {
  const block = blocks[index];
  if (block === undefined) throw new Error(`no block at ${index}`);
  return block;
}

/** One integer per distinct (kind, text) across both sides. */
function internKeys(
  before: readonly DocumentBlock[],
  after: readonly DocumentBlock[]
): { readonly before: number[]; readonly after: number[] } {
  const byKind = new Map<DocumentBlockKind, Map<string, number>>();
  let next = 0;
  const key = (block: DocumentBlock): number => {
    let texts = byKind.get(block.kind);
    if (texts === undefined) {
      texts = new Map();
      byKind.set(block.kind, texts);
    }
    let found = texts.get(block.text);
    if (found === undefined) {
      found = next;
      next += 1;
      texts.set(block.text, found);
    }
    return found;
  };
  return { before: before.map(key), after: after.map(key) };
}

/**
 * Which kept blocks become anchors, as positions in the kept list, ascending.
 *
 * Every kept block when they fit. Otherwise each change's neighbours come
 * first, then an even stride across the rest, and the total never passes
 * `MAX_DOCUMENT_ANCHORS`.
 */
function chooseAnchors(
  count: number,
  neighbours: ReadonlySet<number>
): number[] {
  if (count <= MAX_DOCUMENT_ANCHORS) {
    return Array.from({ length: count }, (_, at) => at);
  }
  const near = [...neighbours].sort((x, y) => x - y);
  if (near.length >= MAX_DOCUMENT_ANCHORS) {
    return spread(near, MAX_DOCUMENT_ANCHORS);
  }
  // Stride over the positions that are not neighbours, so no sample lands on
  // one twice and the total reaches the cap exactly.
  const others: number[] = [];
  for (let at = 0; at < count; at += 1) {
    if (!neighbours.has(at)) others.push(at);
  }
  const room = MAX_DOCUMENT_ANCHORS - near.length;
  return [...near, ...spread(others, room)].sort((x, y) => x - y);
}

/** `wanted` entries spread evenly across `list`, which holds that many. */
function spread(list: readonly number[], wanted: number): number[] {
  const picked: number[] = [];
  for (let k = 0; k < wanted; k += 1) {
    const at = list[Math.floor((k * list.length) / wanted)];
    if (at !== undefined) picked.push(at);
  }
  return picked;
}

interface PairQuotes {
  readonly before: string;
  readonly after: string;
  readonly segments?: {
    readonly before: readonly DiffSegment[];
    readonly after: readonly DiffSegment[];
  };
}

/**
 * What a changed pair shows: its word diff cut to the context beside each
 * change, or plain quotes when the words differ too much to pair up.
 *
 * Neither block is diffed whole. The word diff reads one window per side: the
 * differing span, widened to whole words and to a little unchanged text. A
 * block of any length therefore costs what its changed words cost, and a pair
 * whose window passes `MAX_PAIR_WINDOW` quotes plainly without a diff.
 */
function pairQuotes(before: string, after: string): PairQuotes {
  if (before === after) return sameQuotes(before);
  const bounds = pairBounds(before, after);
  const words =
    bounds === undefined
      ? undefined
      : diffWordsWithSpace(
          before.slice(bounds.from, bounds.to),
          after.slice(bounds.from, bounds.afterTo),
          { maxEditLength: MAX_WORD_EDITS }
        );
  if (words === undefined) {
    return { before: capText(before), after: capText(after) };
  }
  const pieces = excerpt(words.map(segmentOf));
  const beforeSide = capSide(pieces.filter((piece) => piece.kind !== 'added'));
  const afterSide = capSide(pieces.filter((piece) => piece.kind !== 'removed'));
  return {
    before: textOf(beforeSide),
    after: textOf(afterSide),
    segments: { before: beforeSide, after: afterSide },
  };
}

function segmentOf(change: Change): DiffSegment {
  if (change.added) return { kind: 'added', text: change.value };
  if (change.removed) return { kind: 'removed', text: change.value };
  return { kind: 'unchanged', text: change.value };
}

/**
 * Cuts each unchanged run longer than `CONTEXT_THRESHOLD` to the characters
 * beside the changes that touch it. A paragraph with one edit at character
 * 2,500 then shows that edit, not its first 400 characters.
 *
 * Decided on the window's diff, so text removed from one side still leaves its
 * gap marked on the other.
 */
function excerpt(pieces: readonly DiffSegment[]): DiffSegment[] {
  const changed = pieces.map((piece) => piece.kind !== 'unchanged');
  return pieces.map((piece, at) => {
    if (piece.kind !== 'unchanged' || piece.text.length <= CONTEXT_THRESHOLD) {
      return piece;
    }
    const followsChange = changed[at - 1] === true;
    const precedesChange = changed[at + 1] === true;
    const head = piece.text.slice(0, cutEnd(piece.text, CONTEXT));
    const tail = piece.text.slice(cutStart(piece.text, CONTEXT));
    if (followsChange && precedesChange) {
      return { kind: 'unchanged', text: `${head}${ELLIPSIS}${tail}` };
    }
    if (followsChange) {
      return { kind: 'unchanged', text: `${head}${ELLIPSIS}` };
    }
    if (precedesChange) {
      return { kind: 'unchanged', text: `${ELLIPSIS}${tail}` };
    }
    return piece;
  });
}

/** Keeps one side to `MAX_PAIR_SIDE` characters, ellipsis included. */
function capSide(pieces: readonly DiffSegment[]): DiffSegment[] {
  if (textOf(pieces).length <= MAX_PAIR_SIDE) return [...pieces];
  const kept: DiffSegment[] = [];
  let room = MAX_PAIR_SIDE - ELLIPSIS.length;
  for (const piece of pieces) {
    if (piece.text.length <= room) {
      kept.push(piece);
      room -= piece.text.length;
      continue;
    }
    const end = cutEnd(piece.text, room);
    if (end > 0)
      kept.push({ kind: piece.kind, text: piece.text.slice(0, end) });
    break;
  }
  kept.push({ kind: 'unchanged', text: ELLIPSIS });
  return kept;
}

/** The window a changed pair's word diff reads, as offsets into the texts. */
interface PairBounds {
  /** Where the window starts in both texts. */
  readonly from: number;
  /** Where it ends in `before`. */
  readonly to: number;
  /** Where it ends in `after`. */
  readonly afterTo: number;
}

/**
 * The window a changed pair's word diff reads. Each end is a token edge, so
 * the window tokenizes as the whole text does, and each side keeps
 * `CONTEXT_WINDOW` characters of unchanged text beside its change. Undefined
 * when an edge is too far away, or the window passes `MAX_PAIR_WINDOW`.
 */
function pairBounds(before: string, after: string): PairBounds | undefined {
  const offset = after.length - before.length;
  const { head, tail } = sharedEnds(before, after);
  // The first change begins at or after the nearest edge at or before the
  // first difference, so the context reaches `CONTEXT_WINDOW` before it.
  const start = nearestEdge(before, after, head, 0, -1);
  if (start === undefined) return undefined;
  const from =
    start <= CONTEXT_WINDOW
      ? 0
      : nearestEdge(before, after, start - CONTEXT_WINDOW, 0, -1);
  // The last change ends at or before the nearest edge after the shared tail.
  const end = nearestEdge(before, after, before.length - tail, offset, 1);
  if (from === undefined || end === undefined) return undefined;
  const to =
    end + CONTEXT_WINDOW >= before.length
      ? before.length
      : nearestEdge(before, after, end + CONTEXT_WINDOW, offset, 1);
  if (to === undefined) return undefined;
  const afterTo = to + offset;
  if (to - from > MAX_PAIR_WINDOW || afterTo - from > MAX_PAIR_WINDOW) {
    return undefined;
  }
  return { from, to, afterTo };
}

/** The code units two texts share at their start and at their end. */
function sharedEnds(
  before: string,
  after: string
): { readonly head: number; readonly tail: number } {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before.charCodeAt(head) === after.charCodeAt(head)) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < limit - head &&
    before.charCodeAt(before.length - 1 - tail) ===
      after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1;
  }
  return { head, tail };
}

/**
 * The token edge nearest `at`, moving one code unit at a time in direction
 * `step`, for at most `MAX_PAIR_WINDOW` code units. `offset` maps `at` onto
 * `after`: 0 when `at` counts from the start, the length difference when it
 * counts from the end.
 */
function nearestEdge(
  before: string,
  after: string,
  at: number,
  offset: number,
  step: 1 | -1
): number | undefined {
  let x = at;
  for (let moved = 0; moved <= MAX_PAIR_WINDOW; moved += 1) {
    const y = x + offset;
    if (x < 0 || x > before.length || y < 0 || y > after.length) {
      return undefined;
    }
    if (isTokenEdge(before, x) && isTokenEdge(after, y)) return x;
    x += step;
  }
  return undefined;
}

/**
 * Whether the word tokenizer splits between `at - 1` and `at`. The start and
 * the end of a text always do. The tokenizer keeps a run of word characters
 * together, a run of blanks, a CRLF and one astral character, and splits
 * everywhere else. Exported so a test can hold it to the tokenizer.
 */
export function isTokenEdge(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return true;
  const a = text.charCodeAt(at - 1);
  const b = text.charCodeAt(at);
  if (isHighSurrogate(a) && isLowSurrogate(b)) return false;
  if (isWordCode(a) && isWordCode(b)) return false;
  if (a === 0x0d && b === 0x0a) return false;
  // A run of blanks stays one token; a line break is a token of its own.
  const blankA = isSpaceCode(a) && a !== 0x0a && a !== 0x0d;
  const blankB = isSpaceCode(b) && b !== 0x0a && b !== 0x0d;
  return !(blankA && blankB);
}

/** The word characters the tokenizer keeps together. */
function isWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0xad ||
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2c6) ||
    (code >= 0x2c8 && code <= 0x2d7) ||
    (code >= 0x2de && code <= 0x2ff) ||
    (code >= 0x1e00 && code <= 0x1eff)
  );
}

/** Whitespace as `\s` matches it, one code unit at a time. */
function isSpaceCode(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** A pair whose text did not change: its one unchanged run, cut as a run is. */
function sameQuotes(text: string): PairQuotes {
  const shown = capText(text);
  return {
    before: shown,
    after: shown,
    segments: {
      before: [{ kind: 'unchanged', text: shown }],
      after: [{ kind: 'unchanged', text: shown }],
    },
  };
}

/** One side as plain text, cut to `MAX_PAIR_SIDE` with an ellipsis. */
function capText(text: string): string {
  if (text.length <= MAX_PAIR_SIDE) return text;
  const cut = text.slice(0, cutEnd(text, MAX_PAIR_SIDE - ELLIPSIS.length));
  return `${cut}${ELLIPSIS}`;
}

function textOf(pieces: readonly DiffSegment[]): string {
  return pieces.map((piece) => piece.text).join('');
}

/** The quote a removed or added block shows, as `domdiff.ts` quotes a node. */
function quote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_BLOCK_QUOTE
    ? `${trimmed.slice(0, cutEnd(trimmed, MAX_BLOCK_QUOTE))}${ELLIPSIS}`
    : trimmed;
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/** The longest prefix of `limit` code units that keeps each pair whole. */
function cutEnd(text: string, limit: number): number {
  const end = Math.min(limit, text.length);
  return end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1))
    ? end - 1
    : end;
}

/** Where the last `count` code units start, past any split surrogate pair. */
function cutStart(text: string, count: number): number {
  const start = Math.max(0, text.length - count);
  return start > 0 && isLowSurrogate(text.charCodeAt(start))
    ? start + 1
    : start;
}

export interface RenderedChapter {
  /** The spine path the render part reads from. */
  readonly path: string;
  /**
   * The contents title, escaped and cut as `visibleLabel` shows it, or
   * "Section {n}" when the book names none.
   */
  readonly label: string;
}

/**
 * Each render part of a book, in the order the frame renders them. A part is
 * an index into this list, so every reader of a part goes through here.
 */
export function renderedChapters(
  book: Pick<EpubBook, 'spine' | 'toc'>
): readonly RenderedChapter[] {
  const titles = new Map<string, string>();
  const offer = (entry: { readonly path: string; readonly label: string }) => {
    const label = entry.label.replace(/\s+/g, ' ').trim();
    if (label !== '' && !titles.has(entry.path))
      titles.set(entry.path, visibleLabel(label));
  };
  // An entry for the whole file names it. A fragment entry names it only when
  // no whole-file entry does.
  for (const entry of book.toc) if (entry.fragment === undefined) offer(entry);
  for (const entry of book.toc) offer(entry);
  return epubRenderOrder(book).map((item, index) => ({
    path: item.path,
    label: titles.get(item.path) ?? `Section ${index + 1}`,
  }));
}

/**
 * Diff options for two EPUB books. A block pairs only inside the same chapter,
 * and a change row names its chapter the way the chapter list does.
 */
export function epubDiffOptions(
  before: Pick<EpubBook, 'spine' | 'toc'>,
  after: Pick<EpubBook, 'spine' | 'toc'>
): BlockDiffOptions {
  const chapters = {
    before: renderedChapters(before),
    after: renderedChapters(after),
  };
  return {
    partKey: (side, part) =>
      chapters[side][part]?.path ?? `\u0000${side}:${part}`,
    partLabel: (side, part) =>
      chapters[side][part]?.label ?? `Section ${part + 1}`,
  };
}

export interface ChapterRow {
  readonly path: string;
  readonly label: string;
  readonly status: 'added' | 'removed' | 'changed' | 'unchanged';
  /** Changes inside the chapter, counted on either side. */
  readonly changes: number;
  /** The first of those changes, which the row jumps to. */
  readonly firstJump?: number;
}

/**
 * One row per chapter, in reading order, with chapters that repeat in the spine
 * merged into one. Removed chapters sit before added ones in the same gap.
 */
export function chapterRows(
  before: {
    readonly blocks: readonly DocumentBlock[];
    readonly book: EpubBook;
  },
  after: { readonly blocks: readonly DocumentBlock[]; readonly book: EpubBook },
  diff: BlockDiff
): readonly ChapterRow[] {
  const beforeChapters = renderedChapters(before.book);
  const afterChapters = renderedChapters(after.book);

  const counted = new Map<string, { changes: number; firstJump: number }>();
  for (const [jump, { side, part }] of diff.jumpParts.entries()) {
    const chapters = side === 'before' ? beforeChapters : afterChapters;
    const path = chapters[part]?.path;
    if (path === undefined) continue;
    const seen = counted.get(path);
    if (seen === undefined) counted.set(path, { changes: 1, firstJump: jump });
    else seen.changes += 1;
  }

  const beforeLabels = firstLabels(beforeChapters);
  const afterLabels = firstLabels(afterChapters);
  const rows: ChapterRow[] = [];
  for (const path of chapterOrder(beforeChapters, afterChapters)) {
    const beforeLabel = beforeLabels.get(path);
    const afterLabel = afterLabels.get(path);
    // The newer name wins when a chapter was renamed.
    const label = afterLabel ?? beforeLabel;
    if (label === undefined) continue;
    const changes = counted.get(path);
    let status: ChapterRow['status'];
    if (afterLabel === undefined) status = 'removed';
    else if (beforeLabel === undefined) status = 'added';
    else status = changes === undefined ? 'unchanged' : 'changed';
    rows.push({
      path,
      label,
      status,
      changes: changes?.changes ?? 0,
      ...(changes === undefined ? {} : { firstJump: changes.firstJump }),
    });
  }
  return rows;
}

function firstLabels(
  chapters: readonly RenderedChapter[]
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const chapter of chapters) {
    if (!labels.has(chapter.path)) labels.set(chapter.path, chapter.label);
  }
  return labels;
}

/**
 * Chapter paths in reading order. Walking the new book, each chapter it shares
 * with the old book closes a gap. The gap lists the old book's removals, then
 * the new book's additions, the order the block walk reads them in.
 */
function chapterOrder(
  before: readonly RenderedChapter[],
  after: readonly RenderedChapter[]
): string[] {
  const beforeIndex = new Map<string, number>();
  for (const [index, chapter] of before.entries()) {
    if (!beforeIndex.has(chapter.path)) beforeIndex.set(chapter.path, index);
  }
  const inBefore = new Set(beforeIndex.keys());
  const inAfter = new Set(after.map((chapter) => chapter.path));

  const order: string[] = [];
  const seen = new Set<string>();
  const emit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    order.push(path);
  };
  const gap = (
    removed: readonly RenderedChapter[],
    added: readonly RenderedChapter[]
  ): void => {
    for (const chapter of removed) {
      if (!inAfter.has(chapter.path)) emit(chapter.path);
    }
    for (const chapter of added) {
      if (!inBefore.has(chapter.path)) emit(chapter.path);
    }
  };

  let beforeFrom = 0;
  let afterFrom = 0;
  for (const [index, chapter] of after.entries()) {
    const at = beforeIndex.get(chapter.path);
    if (at === undefined) continue;
    // A shared chapter the old book had earlier was reordered: keep it where
    // the new book puts it and leave the gaps alone.
    if (at < beforeFrom) {
      emit(chapter.path);
      continue;
    }
    gap(before.slice(beforeFrom, at), after.slice(afterFrom, index));
    emit(chapter.path);
    beforeFrom = at + 1;
    afterFrom = index + 1;
  }
  gap(before.slice(beforeFrom), after.slice(afterFrom));
  return order;
}
