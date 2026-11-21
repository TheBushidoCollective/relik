/**
 * The cue list for `.srt` and `.vtt` (plan A3; sections 5 and 7; the mock's
 * subtitle states S1 to S4).
 *
 * Every cue is drawn with DOM nodes and `textContent`. A cue's bold, italic
 * and underline runs map to fixed elements, and every other character is text.
 * Bidirectional and control characters show as visible escapes.
 *
 * A cue, or a range of cues, is commented through the selection. A click or a
 * keypress selects the cue's text, and the route's selection offer asks
 * `selectionAnchor()` for the `time` anchor. A selection that stays inside one
 * cue and does not cover it is left to the quote adapter.
 */

import type { CommentAnchor } from '@relic/format';
import {
  type SubtitleBlock,
  type SubtitleCue,
  type SubtitleFile,
  type SubtitleSegment,
  parseSubtitles,
  subtitleFormatFor,
} from '@relic/format/subtitles';
import { isInvisible } from '@relic/format/structured-text';
import { subtitleClock } from './annotate-cue.ts';
import { cueSourceSegments } from './cue-suggest.ts';
import { registerSuggestionSurface } from './suggestion-surface.ts';
import type { SourceSegment } from './markdown-source.ts';
import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';

const STYLESHEET_ID = 'relic-cue-view-css';
const SVG_NS = 'http://www.w3.org/2000/svg';
const NOTICE_NOT_A_LIST =
  'This subtitle file is too large to show as a list of cues, so its text is shown.';
const NOTICE_NO_CUES = 'This file has no readable cues, so its text is shown.';

/** Each invisible character is written out as its code point, so it can be read. */
export function visibleText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += isInvisible(code)
      ? `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`
      : text.charAt(i);
  }
  return out;
}

/** `m:ss`, or `h:mm:ss` past an hour, for the summary line. */
function shortClock(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}`
    : `${minutes}:${secs}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function skippedNotice(count: number): string {
  return count === 1
    ? '1 block could not be read as a cue. View source to see it.'
    : `${count} blocks could not be read as cues. View source to see them.`;
}

function commentIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** A run of text as nodes: underline, then italic, then bold, each a plain element. */
function segmentNode(segment: SubtitleSegment, contents?: Node): Node {
  let node: Node =
    contents ?? document.createTextNode(visibleText(segment.text));
  if (segment.underline) {
    const span = el('span', 'u');
    span.append(node);
    node = span;
  }
  if (segment.italic) {
    const em = el('em');
    em.append(node);
    node = em;
  }
  if (segment.bold) {
    const strong = el('strong');
    strong.append(node);
    node = strong;
  }
  return node;
}

function stylesheet(): void {
  if (document.getElementById(STYLESHEET_ID) !== null) return;
  const link = document.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/assets/cue-view.css';
  document.head.append(link);
}

/** A part with nothing to mark: a refused file shows its source and notices. */
const INERT: StructuredPart = {
  paintMark: () => false,
  clearMarks: () => {},
  selectionAnchor: () => undefined,
  reveal: () => {},
  dispose: () => {},
};

interface CueRow {
  readonly cue: SubtitleCue;
  readonly row: HTMLLIElement;
  readonly text: HTMLElement;
  readonly add: HTMLButtonElement;
  readonly band: HTMLElement;
}

interface TimeSpan {
  readonly t: number;
  readonly t_end?: number;
}

function spanAnchor(start: number, end: number): CommentAnchor {
  return end > start
    ? { kind: 'time', t: start, t_end: end }
    : { kind: 'time', t: start };
}

export function mountView(mount: StructuredMount): StructuredPart | undefined {
  stylesheet();
  const parsed = parseSubtitles(
    mount.source,
    subtitleFormatFor(mount.filename, mount.mimetype)
  );
  if (!parsed.ok) {
    const notice = el(
      'p',
      'cues-notice',
      parsed.reason === 'no-cues' ? NOTICE_NO_CUES : NOTICE_NOT_A_LIST
    );
    const notices = [notice];
    if (parsed.skipped > 0)
      notices.push(el('p', 'cues-notice', skippedNotice(parsed.skipped)));
    mount.root.replaceChildren(...notices, mount.sourceView());
    return INERT;
  }
  return drawCues(mount, parsed.file);
}

/**
 * A time comment is drawn on at most this many cues. A span over a long file
 * would otherwise put one node on every cue; the mark's title says how many
 * were left unmarked.
 */
const CUE_MARKS_PER_COMMENT = 500;

function drawCues(mount: StructuredMount, file: SubtitleFile): StructuredPart {
  const root = mount.root;
  const doc = root.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;

  const cueRows: CueRow[] = [];
  const allRows: HTMLLIElement[] = [];
  const speakers = new Set<string>();
  let duration = 0;
  let chosen: CueRow | undefined;
  const source =
    mount.source.charCodeAt(0) === 0xfeff
      ? mount.source.slice(1)
      : mount.source;
  const mappedSegments: SourceSegment[] = [];
  const editableBlocks = new Set<number>();
  const redraw: (() => void)[] = [];

  const density = el('div', 'cues-density');
  density.setAttribute('aria-hidden', 'true');
  density.title =
    'Where the cues fall in the media. Patina marks commented cues.';
  const list = el('ol', 'cues');
  list.setAttribute('aria-label', 'Cues');

  for (const entry of file.entries) {
    if (entry.kind === 'cue') duration = Math.max(duration, entry.end);
  }

  for (const entry of file.entries) {
    if (entry.kind === 'cue') {
      const row = el('li', 'cue');
      row.dataset['cueIndex'] = String(entry.index);
      row.tabIndex = -1;
      const time = el(
        'span',
        'cue-time',
        `${subtitleClock(entry.start)} \u2192 ${subtitleClock(entry.end)}`
      );
      const text = el('span', 'cue-text');
      if (entry.speaker !== undefined) {
        speakers.add(entry.speaker);
        text.append(el('span', 'cue-speaker', visibleText(entry.speaker)));
      }
      const content = el('span', 'cue-content');
      const pieces = cueSourceSegments(source, entry);
      const editable =
        !entry.truncated &&
        pieces.map((piece) => piece.text).join('') === entry.text &&
        visibleText(entry.text) === entry.text;
      const first = mappedSegments.length;
      if (editable) {
        mappedSegments.push(...pieces);
        editableBlocks.add(entry.index);
      } else {
        content.setAttribute('contenteditable', 'false');
      }
      const drawContent = (): void => {
        content.replaceChildren();
        if (!editable) {
          for (const segment of entry.segments)
            content.append(segmentNode(segment));
          return;
        }
        let piece = 0;
        for (const segment of entry.segments) {
          const holder = doc.createDocumentFragment();
          let remaining = segment.text.length;
          while (remaining > 0 && piece < pieces.length) {
            const item = pieces[piece]!;
            const span = el('span');
            span.dataset['seg'] = String(first + piece);
            span.textContent = item.text;
            holder.append(span);
            remaining -= item.text.length;
            piece++;
          }
          content.append(segmentNode(segment, holder));
        }
      };
      drawContent();
      redraw.push(drawContent);
      text.append(content);
      const add = el('button', 'cm-add');
      add.type = 'button';
      add.title = `Comment on cue ${entry.index}`;
      add.setAttribute('aria-label', `Comment on cue ${entry.index}`);
      add.append(commentIcon());
      text.append(add);
      row.append(
        el('span', 'cue-i', String(entry.index)),
        time,
        el('span', 'cue-dur', `${(entry.end - entry.start).toFixed(1)} s`),
        text
      );
      const band = el('span');
      if (duration > 0) {
        band.style.left = `${(entry.start / duration) * 100}%`;
        band.style.width = `${((entry.end - entry.start) / duration) * 100}%`;
      }
      density.append(band);
      const cueRow: CueRow = { cue: entry, row, text, add, band };
      cueRows.push(cueRow);
      allRows.push(row);
      list.append(row);
    } else {
      const row = blockRow(entry);
      list.append(row);
      allRows.push(row);
    }
  }
  const firstRow = allRows[0];
  if (firstRow !== undefined) firstRow.tabIndex = 0;

  const summary = el(
    'span',
    'cues-summary',
    [
      `${file.cueCount} ${file.cueCount === 1 ? 'cue' : 'cues'}`,
      shortClock(duration),
      speakers.size > 0
        ? `${speakers.size} ${speakers.size === 1 ? 'speaker' : 'speakers'}`
        : '',
      file.format === 'vtt' ? 'WebVTT' : 'SubRip',
    ]
      .filter((part) => part !== '')
      .join(' \u00b7 ')
  );
  const find = el('input', 'cues-find');
  find.type = 'search';
  find.placeholder = 'Find in subtitles';
  find.setAttribute('aria-label', 'Find in subtitles');
  const findCount = el('span', 'cues-find-count');
  // No View source here: the route's own toggle above the view offers it and
  // follows which view is on screen. A second control said the same thing twice.
  const bar = el('div', 'cues-bar');
  bar.append(summary, find, findCount);

  const notices: HTMLElement[] = [];
  if (file.skipped > 0)
    notices.push(el('p', 'cues-notice', skippedNotice(file.skipped)));

  root.replaceChildren(bar, ...notices, density, list);
  const unregister = registerSuggestionSurface(root, {
    root: list,
    segments: () => mappedSegments,
    blockKind: () => 'cue',
    editable: (block) =>
      editableBlocks.has(block)
        ? true
        : {
            kind: 'refused',
            code: 'not-editable',
            message: 'This cue cannot be edited safely.',
          },
    repaint: () => {
      for (const draw of redraw) draw();
    },
  });

  const visibleRows = (): HTMLLIElement[] =>
    allRows.filter((row) => !row.hidden);

  const focusRow = (row: HTMLLIElement): void => {
    for (const other of allRows) other.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
  };

  const rowOf = (target: EventTarget | null): HTMLLIElement | null => {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLLIElement>('li.cue');
  };

  const selectRow = (row: HTMLElement): void => {
    const found = cueRows.find((candidate) => candidate.row === row);
    if (found === undefined) return;
    const selection = doc.getSelection();
    if (selection === null) return;
    const range = doc.createRange();
    range.selectNodeContents(found.text);
    selection.removeAllRanges();
    selection.addRange(range);
    for (const other of cueRows) {
      other.row.classList.toggle('is-selected', other === found);
    }
    chosen = found;
  };

  list.addEventListener(
    'click',
    (event) => {
      const row = rowOf(event.target);
      if (row === null || row.classList.contains('is-block')) return;
      const selection = doc.getSelection();
      const dragged =
        selection !== null &&
        !selection.isCollapsed &&
        selection.toString() !== '' &&
        !(event.target as Element).closest('.cm-add');
      if (dragged) return;
      selectRow(row);
    },
    { signal }
  );

  list.addEventListener(
    'keydown',
    (event) => {
      const current = rowOf(event.target);
      if (current === null) return;
      const visible = visibleRows();
      const at = visible.indexOf(current);
      if (at < 0) return;
      let next: HTMLLIElement | undefined;
      if (event.key === 'ArrowDown')
        next = visible[Math.min(at + 1, visible.length - 1)];
      else if (event.key === 'ArrowUp') next = visible[Math.max(at - 1, 0)];
      else if (event.key === 'Home') next = visible[0];
      else if (event.key === 'End') next = visible[visible.length - 1];
      else if (
        (event.key === 'Enter' || event.key === ' ') &&
        !current.classList.contains('is-block')
      ) {
        event.preventDefault();
        selectRow(current);
        return;
      } else return;
      event.preventDefault();
      if (next !== undefined) focusRow(next);
    },
    { signal }
  );

  const applyFind = (): void => {
    const query = find.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const cueRow of cueRows) {
      const hit =
        query === '' || cueRow.cue.text.toLocaleLowerCase().includes(query);
      cueRow.row.hidden = !hit;
      if (hit) matches += 1;
    }
    for (const row of allRows) {
      if (row.classList.contains('is-block')) row.hidden = query !== '';
    }
    findCount.textContent =
      query === '' ? '' : `${matches} ${matches === 1 ? 'match' : 'matches'}`;
  };
  find.addEventListener('input', applyFind, { signal });
  find.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const visible = visibleRows().filter(
        (row) => !row.classList.contains('is-block')
      );
      if (visible.length === 0) return;
      const at = visible.indexOf(doc.activeElement as HTMLLIElement);
      focusRow(visible[(at + 1) % visible.length] as HTMLLIElement);
    },
    { signal }
  );

  doc.addEventListener(
    'selectionchange',
    () => {
      if (chosen === undefined) return;
      const selection = doc.getSelection();
      const still =
        selection !== null &&
        !selection.isCollapsed &&
        selection.containsNode(chosen.text, true);
      if (still) return;
      chosen.row.classList.remove('is-selected');
      chosen = undefined;
    },
    { signal }
  );

  /** The cue rows a span of seconds overlaps: a moment, or a range. */
  const overlapping = (anchor: TimeSpan): CueRow[] => {
    const lo = anchor.t;
    const hi = anchor.t_end ?? anchor.t;
    return cueRows.filter((cueRow) =>
      hi > lo
        ? cueRow.cue.start < hi && cueRow.cue.end > lo
        : cueRow.cue.start <= lo && lo <= cueRow.cue.end
    );
  };

  const selectionAnchor = (): CommentAnchor | undefined => {
    const selection = doc.getSelection();
    if (selection === null || selection.rangeCount === 0) return undefined;
    if (selection.isCollapsed) return undefined;
    const range = selection.getRangeAt(0);
    // `intersectsNode` also answers true for a range that only touches the
    // node's edge, which would take in a neighbouring cue the reader did not
    // select. A cue counts when the range holds at least one of its characters.
    const takesIn = (cueRow: CueRow): boolean => {
      const text = cueTextRange(cueRow.text, doc);
      return (
        text !== undefined &&
        range.compareBoundaryPoints(Range.END_TO_START, text) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, text) > 0
      );
    };
    const touched = cueRows.filter(takesIn);
    const first = touched[0];
    const last = touched[touched.length - 1];
    if (first === undefined || last === undefined) return undefined;
    if (first === last) {
      // A selection ends at a text offset. The element's end boundary comes after
      // the comment button, so it sorts after any selection that covers every
      // character, and the covers check would refuse it. Compare with the text.
      const whole = cueTextRange(first.text, doc);
      if (whole === undefined) return undefined;
      const covers =
        range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0;
      if (!covers) return undefined;
    }
    return spanAnchor(first.cue.start, last.cue.end);
  };

  /** The mark nodes each comment put on the cues, so a repaint touches only its own. */
  const markNodes = new Map<string, HTMLElement[]>();

  /** Removes one comment's mark nodes from the cues. */
  const unmark = (commentId: string): void => {
    for (const node of markNodes.get(commentId) ?? []) node.remove();
    markNodes.delete(commentId);
  };

  const paintMark = (anchor: CommentAnchor, commentId: string): boolean => {
    if (anchor.kind !== 'time') return false;
    const hits = overlapping(anchor);
    if (hits.length === 0) return false;
    unmark(commentId);
    // A span over the whole file would otherwise put a node on every cue.
    const shown = hits.slice(0, CUE_MARKS_PER_COMMENT);
    const title =
      shown.length < hits.length
        ? `Commented. This comment spans ${hits.length} cues; the first ${shown.length} are marked.`
        : 'Commented';
    const nodes: HTMLElement[] = [];
    for (const hit of shown) {
      const mark = el('span', 'cue-mark');
      mark.dataset['commentId'] = commentId;
      mark.title = title;
      hit.text.insertBefore(mark, hit.add);
      hit.row.classList.add('is-commented');
      hit.band.classList.add('is-commented');
      nodes.push(mark);
    }
    markNodes.set(commentId, nodes);
    return true;
  };

  const clearMarks = (): void => {
    for (const nodes of markNodes.values()) {
      for (const node of nodes) node.remove();
    }
    markNodes.clear();
    for (const cueRow of cueRows) {
      cueRow.row.classList.remove('is-commented', 'is-active');
      cueRow.band.classList.remove('is-commented');
    }
  };

  const reveal = (anchor: CommentAnchor, commentId?: string): void => {
    if (anchor.kind !== 'time') return;
    const hit = overlapping(anchor)[0];
    if (hit === undefined) return;
    hit.row.scrollIntoView({ block: 'center' });
    if (commentId === undefined) return;
    for (const [id, nodes] of markNodes) {
      for (const node of nodes) {
        node.classList.toggle('is-active', id === commentId);
      }
    }
  };

  return {
    paintMark,
    clearMarks,
    selectionAnchor,
    reveal,
    dispose: () => {
      unregister();
      controller.abort();
    },
  };
}

function blockRow(block: SubtitleBlock): HTMLLIElement {
  const row = el('li', 'cue is-block');
  row.tabIndex = -1;
  const kind =
    block.kind === 'note'
      ? 'NOTE'
      : block.kind === 'style'
        ? 'STYLE'
        : 'REGION';
  row.append(
    el('span', 'cue-i'),
    el('span', 'cue-kind', kind),
    el('span', 'cue-dur'),
    el('span', 'cue-text', visibleText(block.text))
  );
  return row;
}

/**
 * A range from the first to the last character of a cue's text, leaving out the
 * comment button that follows it. Undefined when the cue has no text at all.
 */
function cueTextRange(text: HTMLElement, doc: Document): Range | undefined {
  const walker = doc.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  let first: Text | undefined;
  let last: Text | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    first ??= node as Text;
    last = node as Text;
  }
  if (first === undefined || last === undefined) return undefined;
  const range = doc.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  return range;
}
