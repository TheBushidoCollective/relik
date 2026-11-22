/**
 * The table view for `.csv` and `.tsv` (plan A1, sections 5 and 7).
 *
 * The view draws the records of a parsed table as a grid: a sticky header, row
 * numbers, column letters, and only the rows on screen in the DOM. It holds no
 * comments. Marks arrive as `CellCommentAnchor` values through `paintMark`, and
 * a selection leaves as one through `selectionAnchor`. Both are in A1
 * coordinates of the published file, and a mark is painted on the record it was
 * made on, so a sort moves the mark with its cell.
 *
 * A selection is also written into the document's own Selection, as a range
 * over its first and last cells. The stage's comment offer reads that selection
 * on mouseup and keyup, so a cell or a range is offered exactly as text is.
 *
 * Every cell's text goes in through `textContent`. No attacker text reaches
 * `innerHTML` or an attribute: the only attributes set are record and column
 * numbers, and classes and ARIA values this module chooses.
 */

import type { CellCommentAnchor, CommentAnchor } from '@relic/format';
import {
  isNumericText,
  TABLE_COLUMN_LIMIT,
  TABLE_DRAWN_COLUMN_LIMIT,
} from '@relic/format/csv';
import { isInvisible } from '@relic/format/structured-text';
import type { StructuredPart } from './structured-view-bridge.ts';
import type { TableSource } from './table-source.ts';
import { LABEL_DISPLAY_LIMIT } from './visible-label.ts';
import {
  hasTableInvisible,
  tableCellSurface,
  tableFieldAtRange,
  tableSuggestionCell,
} from './table-suggest.ts';
import { paintSuggestions } from './suggestions.ts';
import type { SuggestionView, SuggestionViews } from './suggestion-views.ts';
import {
  registerSuggestionSurface,
  requestSurfaceSwap,
} from './suggestion-surface.ts';
import {
  anchorCoversCell,
  columnLetters,
  displayIndexOf,
  recordAt,
  rowWindow,
  type TableModel,
} from './table-model.ts';

export const ROW_HEIGHT = 28;
export const HEAD_HEIGHT = 36;
const ROW_NUMBER_WIDTH = 56;
const OVERSCAN = 6;
const FIND_LIMIT = 10_000;
const MIN_COLUMN_WIDTH = 88;
const MAX_COLUMN_WIDTH = 320;
const SAMPLE_RECORDS = 200;
const FIND_DELAY_MS = 150;
const STYLESHEET_HREF = '/assets/data-table.css';

/** A table model. An absent order stays absent, so file order is the default. */
function modelOf(
  table: TableSource,
  headerRow: boolean,
  order: Uint32Array | undefined
): TableModel {
  return {
    records: table.records,
    columns: table.columns,
    headerRow,
    ...(order === undefined ? {} : { order }),
  };
}

/**
 * Text as a reader sees it. Bidirectional controls and control characters
 * become visible escapes, so a cell cannot reorder or hide the text around it.
 */
export function visibleText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += isInvisible(code) ? `\\u{${code.toString(16).toUpperCase()}}` : char;
  }
  return out;
}

/** Cell, header and inspector text shows at most this many source characters. */
export const DISPLAY_CUT_CHARS = 512;

/**
 * Text as the grid shows it: cut to `DISPLAY_CUT_CHARS` before it is escaped,
 * so a long cell costs a bounded render. Copy takes the whole cell.
 */
export function displayText(value: string): string {
  if (value.length <= DISPLAY_CUT_CHARS) return visibleText(value);
  let cut = value.slice(0, DISPLAY_CUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${visibleText(cut)}…`;
}

/**
 * A selection as the clipboard receives it: the grid's escape form for every
 * control, CR and bidi character. Tab and LF stay, since they separate cells
 * and rows. Without this an ESC[201~ in a cell ends a terminal's paste early.
 */
export function clipboardText(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const keep = code === 0x09 || code === 0x0a;
    out +=
      !keep && isInvisible(code)
        ? `\\u{${code.toString(16).toUpperCase()}}`
        : character;
  }
  return out;
}

/** A label's text: the display text, cut to the label length. */
function labelText(value: string): string {
  const shown = displayText(value);
  return shown.length > LABEL_DISPLAY_LIMIT
    ? `${shown.slice(0, LABEL_DISPLAY_LIMIT).trimEnd()}…`
    : shown;
}
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly column: number;
  readonly direction: SortDirection;
}

/** A cell by record and column, both 0-based. */
export interface CellRef {
  readonly record: number;
  readonly column: number;
}

/** The anchor and the focus of a selection. A single cell has both on one cell. */
export interface Selection {
  readonly anchor: CellRef;
  readonly focus: CellRef;
}

/** The rectangle of a selection, 0-based and inclusive. */
export interface SelectionRect {
  readonly r0: number;
  readonly r1: number;
  readonly c0: number;
  readonly c1: number;
}

/**
 * Whether every non-empty value in a column, below the header, is a number.
 * A column with no values at all is not numeric, so it sorts as text.
 */
export function isNumericColumn(
  table: TableSource,
  column: number,
  headerRow: boolean
): boolean {
  if (table.numericColumn) return table.numericColumn(column, headerRow);
  let seen = false;
  for (let record = headerRow ? 1 : 0; record < table.records; record++) {
    const value = table.text(record, column);
    if (value === '') continue;
    if (table.numeric(record, column) === undefined) return false;
    seen = true;
  }
  return seen;
}

/**
 * The sort permutation for a column: element `d` is the record drawn at display
 * index `d`. The header record stays at index 0. Empty values sort last in both
 * directions. A tie keeps file order, because the sort is stable.
 */
export function sortOrder(
  table: TableSource,
  headerRow: boolean,
  sort: SortState
): Uint32Array {
  const first = headerRow ? 1 : 0;
  const count = table.records - first;
  const numeric = isNumericColumn(table, sort.column, headerRow);
  const texts: string[] = new Array<string>(count);
  const numbers = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const text = table.text(first + i, sort.column);
    texts[i] = text;
    numbers[i] =
      numeric && text !== '' ? table.numeric(first + i, sort.column)! : 0;
  }
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  const direction = sort.direction === 'asc' ? 1 : -1;
  const positions = Array.from({ length: count }, (_, i) => i);
  positions.sort((a, b) => {
    const emptyA = texts[a] === '';
    const emptyB = texts[b] === '';
    if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
    const compared = numeric
      ? numbers[a]! - numbers[b]!
      : collator.compare(texts[a]!, texts[b]!);
    return compared * direction;
  });
  const order = new Uint32Array(table.records);
  for (let record = 0; record < first; record++) order[record] = record;
  for (let i = 0; i < count; i++) order[first + i] = first + positions[i]!;
  return order;
}

/** Columns drawn: the first `TABLE_DRAWN_COLUMN_LIMIT` of the table. */
export function drawnColumnCount(table: TableSource): number {
  return Math.min(table.columns, TABLE_DRAWN_COLUMN_LIMIT);
}

/**
 * Pixel widths for the drawn columns, from the longest of the first records. A
 * width is never narrower than a header or wider than a screen column.
 */
export function columnWidths(table: TableSource, drawn: number): number[] {
  const widths: number[] = [];
  const sample = Math.min(table.records, SAMPLE_RECORDS);
  for (let column = 0; column < drawn; column++) {
    let longest = 0;
    for (let record = 0; record < sample; record++) {
      longest = Math.max(longest, table.text(record, column).length);
    }
    const width = Math.round(Math.min(longest, 40) * 7.4) + 24;
    widths.push(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
  }
  return widths;
}

/** The rectangle a selection covers, in file order. */
export function selectionRect(selection: Selection): SelectionRect {
  return {
    r0: Math.min(selection.anchor.record, selection.focus.record),
    r1: Math.max(selection.anchor.record, selection.focus.record),
    c0: Math.min(selection.anchor.column, selection.focus.column),
    c1: Math.max(selection.anchor.column, selection.focus.column),
  };
}

/**
 * The cell comment anchor for a rectangle, in A1 coordinates. A single cell
 * carries no end, which the contract reads as the same cell.
 */
export function anchorForRect(
  rect: SelectionRect,
  sheet?: string
): CellCommentAnchor {
  const single = rect.r0 === rect.r1 && rect.c0 === rect.c1;
  return {
    kind: 'cell',
    ...(sheet === undefined ? {} : { sheet }),
    row: rect.r0 + 1,
    col: rect.c0 + 1,
    ...(single ? {} : { row_end: rect.r1 + 1, col_end: rect.c1 + 1 }),
  };
}

/**
 * Whether a cell anchor lies inside a table with `records` records and `drawn`
 * drawn columns, on the same sheet as the source.
 * A cell past the drawn columns is refused, because it could not be shown.
 */
export function markFits(
  anchor: CellCommentAnchor,
  records: number,
  drawn: number,
  sheet?: string
): boolean {
  if (anchor.sheet !== sheet) return false;
  const rowEnd = anchor.row_end ?? anchor.row;
  const colEnd = anchor.col_end ?? anchor.col;
  return (
    anchor.row >= 1 &&
    rowEnd >= anchor.row &&
    rowEnd <= records &&
    anchor.col >= 1 &&
    colEnd >= anchor.col &&
    colEnd <= drawn
  );
}

/**
 * Cells whose text holds the query, in display order, up to a limit. Only the
 * drawn columns are searched, so every hit can be shown.
 */
export function findCells(
  table: TableSource,
  model: TableModel,
  drawn: number,
  query: string
): CellRef[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const hits: CellRef[] = [];
  for (let display = 0; display < model.records; display++) {
    const record = recordAt(model, display);
    if (table.matchingColumns) {
      for (const column of table.matchingColumns(
        record,
        needle,
        drawn,
        FIND_LIMIT - hits.length
      ))
        hits.push({ record, column });
      if (hits.length >= FIND_LIMIT) return hits;
      continue;
    }
    for (let column = 0; column < drawn; column++) {
      if (table.text(record, column).toLowerCase().includes(needle)) {
        hits.push({ record, column });
        if (hits.length >= FIND_LIMIT) return hits;
      }
    }
  }
  return hits;
}
export const RANGE_COPY_CELL_LIMIT = 100_000;
export const RANGE_COPY_CHAR_LIMIT = 8 * 1024 * 1024;
export class RangeCopyTooLargeError extends Error {
  constructor() {
    super('This range is too large to copy. Select a smaller range.');
  }
}

/** The text a copy puts on the clipboard for a rectangle: tabs between cells, newlines between rows. */
export function rectText(table: TableSource, rect: SelectionRect): string {
  const rows: string[] = [];
  const range = rect.r0 !== rect.r1 || rect.c0 !== rect.c1;
  if (
    range &&
    (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) > RANGE_COPY_CELL_LIMIT
  )
    throw new RangeCopyTooLargeError();
  let outputLength = 0;
  for (let record = rect.r0; record <= rect.r1; record++) {
    const cells: string[] = [];
    for (let column = rect.c0; column <= rect.c1; column++) {
      const text = table.text(record, column);
      if (!range) {
        cells.push(text);
        continue;
      }
      if (record !== rect.r0 || column !== rect.c0) outputLength++;
      if (text.length > RANGE_COPY_CHAR_LIMIT - outputLength)
        throw new RangeCopyTooLargeError();
      const guarded =
        /^[=+\-@]/.test(text) && !isNumericText(text) ? `'${text}` : text;
      const field = /[\t\r\n"]/.test(guarded)
        ? `"${guarded.replace(/"/g, '""')}"`
        : guarded;
      for (const character of field) {
        const code = character.codePointAt(0) ?? 0;
        outputLength +=
          code !== 9 && code !== 10 && isInvisible(code)
            ? `\\u{${code.toString(16).toUpperCase()}}`.length
            : character.length;
        if (outputLength > RANGE_COPY_CHAR_LIMIT)
          throw new RangeCopyTooLargeError();
      }
      cells.push(field);
    }
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

interface Mark {
  readonly anchor: CellCommentAnchor;
  readonly id: string;
}

interface Coverage {
  readonly count: number;
  readonly ranged: boolean;
  readonly edges: ReadonlySet<string>;
}

const NO_EDGES: ReadonlySet<string> = new Set<string>();

/** Whether a mark covers one cell and no other. */
function isPointAnchor(anchor: CellCommentAnchor): boolean {
  return (
    (anchor.row_end ?? anchor.row) === anchor.row &&
    (anchor.col_end ?? anchor.col) === anchor.col
  );
}

/**
 * The marks a table paints, indexed for the cells they cover. A single-cell
 * mark is found by its row, and only ranges are scanned, so painting one cell
 * costs the marks that can reach it rather than every mark on the table.
 */
class MarkIndex {
  readonly #byId = new Map<string, Mark>();
  readonly #points = new Map<number, Set<Mark>>();
  readonly #ranges = new Set<Mark>();

  /** Adds or replaces the mark with this id. Returns the anchor it replaced. */
  put(id: string, anchor: CellCommentAnchor): CellCommentAnchor | undefined {
    const replaced = this.remove(id);
    const mark: Mark = { anchor, id };
    this.#byId.set(id, mark);
    if (isPointAnchor(anchor)) {
      const row = this.#points.get(anchor.row) ?? new Set<Mark>();
      row.add(mark);
      this.#points.set(anchor.row, row);
    } else {
      this.#ranges.add(mark);
    }
    return replaced;
  }

  /** Removes the mark with this id. Returns the anchor it held. */
  remove(id: string): CellCommentAnchor | undefined {
    const mark = this.#byId.get(id);
    if (mark === undefined) return undefined;
    this.#byId.delete(id);
    if (isPointAnchor(mark.anchor)) {
      const row = this.#points.get(mark.anchor.row);
      row?.delete(mark);
      if (row !== undefined && row.size === 0) {
        this.#points.delete(mark.anchor.row);
      }
    } else {
      this.#ranges.delete(mark);
    }
    return mark.anchor;
  }

  clear(): void {
    this.#byId.clear();
    this.#points.clear();
    this.#ranges.clear();
  }

  /** The marks covering one cell, 1-based as anchors are. */
  coverage(row: number, col: number): Coverage {
    let count = 0;
    let ranged = false;
    let edges: Set<string> | undefined;
    const take = (mark: Mark): void => {
      if (!anchorCoversCell(mark.anchor, row, col)) return;
      count++;
      const rowEnd = mark.anchor.row_end ?? mark.anchor.row;
      const colEnd = mark.anchor.col_end ?? mark.anchor.col;
      if (rowEnd === mark.anchor.row && colEnd === mark.anchor.col) return;
      ranged = true;
      edges ??= new Set<string>();
      if (row === mark.anchor.row) edges.add('mk-t');
      if (row === rowEnd) edges.add('mk-b');
      if (col === mark.anchor.col) edges.add('mk-l');
      if (col === colEnd) edges.add('mk-r');
    };
    for (const mark of this.#points.get(row) ?? []) take(mark);
    for (const mark of this.#ranges) take(mark);
    return { count, ranged, edges: edges ?? NO_EDGES };
  }
}

/** Builds an element with a class and text set through `textContent`. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const formatter = new Intl.NumberFormat('en-US');

/** Set once the table's stylesheet has applied, or has failed to load. */
let tableStylesReady = false;
let tableStyles: Promise<void> | undefined;

/**
 * Adds the table's stylesheet once. The promise settles when its styles apply,
 * or when the file fails to load, so a table is never held back for good.
 */
function loadTableStyles(): Promise<void> {
  if (tableStyles !== undefined) return tableStyles;
  const { promise, resolve } = Promise.withResolvers<void>();
  const settled = (): void => {
    tableStylesReady = true;
    resolve();
  };
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLESHEET_HREF;
  link.setAttribute('data-dt-css', '');
  link.addEventListener('load', settled, { once: true });
  link.addEventListener('error', settled, { once: true });
  document.head.appendChild(link);
  tableStyles = promise;
  return promise;
}

/**
 * Draws a parsed table into `root` and returns the part the route drives. The
 * root is cleared first; the caller owns it.
 */
export function mountDataTable(
  root: HTMLElement,
  table: TableSource,
  options: { readonly filename: string; readonly autoDelimiter?: boolean }
): StructuredPart {
  // Drawn before its stylesheet applies, the table lays out unstyled and moves
  // under the reader's pointer when the styles arrive. It stays hidden until then.
  if (!tableStylesReady) {
    root.style.visibility = 'hidden';
    void loadTableStyles().then(() => {
      root.style.visibility = '';
    });
  }
  const drawn = drawnColumnCount(table);
  const widths = columnWidths(table, drawn);
  const totalWidth = ROW_NUMBER_WIDTH + widths.reduce((sum, w) => sum + w, 0);
  const columnLeft: number[] = [];
  for (let column = 0, left = ROW_NUMBER_WIDTH; column < drawn; column++) {
    columnLeft.push(left);
    left += widths[column]!;
  }

  let headerRow = true;
  let sort: SortState | undefined;
  let model: TableModel = modelOf(table, headerRow, undefined);
  let numericCache: boolean[] | undefined;
  const numericColumn = (column: number): boolean => {
    numericCache ??= Array.from({ length: drawn }, (_, c) =>
      isNumericColumn(table, c, headerRow)
    );
    return numericCache[column] ?? false;
  };

  const marks = new MarkIndex();
  let selection: Selection | undefined;
  let findHits: CellRef[] = [];
  let findCurrent = -1;
  let findKeys = new Set<number>();
  let dragging = false;
  let disposed = false;
  let frame = 0;
  let findTimer = 0;
  let findGeneration = 0;
  let navigationGeneration = 0;
  /** The `bodyKey` the rows on screen were drawn with. */
  let drawnKey = '';
  let suggestionViews: SuggestionViews | undefined;
  let suggestionCells = new Map<number, SuggestionView[]>();
  const unsafeSuggestions = (field: number): boolean =>
    suggestionCells
      .get(field)
      ?.some((change) =>
        hasTableInvisible(change.input?.suggestion.replacement ?? '')
      ) ?? false;

  const keyOf = (record: number, column: number): number =>
    record * TABLE_COLUMN_LIMIT + column;
  const bodyIndex = new Map<number, HTMLElement>();
  const headIndex = new Map<number, HTMLElement>();

  // ---- static skeleton ------------------------------------------------------
  root.classList.add('dt');
  root.replaceChildren();
  const bar = element('div', 'dt-bar');
  const summary = element(
    'p',
    'dt-summary',
    `${formatter.format(table.records - (headerRow ? 1 : 0))} rows · ` +
      `${formatter.format(table.columns)} columns · ` +
      table.summary
  );
  summary.setAttribute('aria-live', 'polite');
  const headerToggle = element('label', 'dt-toggle');
  const headerBox = element('input');
  headerBox.type = 'checkbox';
  headerBox.checked = true;
  headerToggle.append(
    headerBox,
    document.createTextNode(' First row is a header')
  );
  const find = element('input', 'dt-find');
  find.type = 'search';
  find.placeholder = 'Find in table';
  find.setAttribute('aria-label', 'Find in table');
  const findCount = element('span', 'dt-find-count');
  findCount.setAttribute('role', 'status');
  bar.append(summary, headerToggle, find, findCount);
  root.append(bar);

  if (table.columns > drawn) {
    const notice = element(
      'p',
      'dt-notice',
      `Only the first ${formatter.format(drawn)} of ` +
        `${formatter.format(table.columns)} columns are drawn. ` +
        (table.csv
          ? 'The source view shows all of them.'
          : 'Download the spreadsheet to inspect all columns.')
    );
    root.append(notice);
  }

  const grid = element('div', 'dt-grid');
  grid.setAttribute('role', 'grid');
  grid.setAttribute(
    'aria-label',
    `${labelText(options.filename)}, ${formatter.format(table.records)} records`
  );
  grid.setAttribute('aria-rowcount', String(table.records));
  grid.setAttribute('aria-colcount', String(drawn + 1));
  grid.style.setProperty(
    '--dt-tracks',
    [`${ROW_NUMBER_WIDTH}px`, ...widths.map((w) => `${w}px`)].join(' ')
  );
  const head = element('div', 'dt-head');
  head.setAttribute('role', 'row');
  head.style.width = `${totalWidth}px`;
  const body = element('div', 'dt-body');
  body.style.width = `${totalWidth}px`;
  grid.append(head, body);
  root.append(grid);

  const cellbar = element('div', 'dt-cellbar');
  cellbar.setAttribute('aria-live', 'polite');
  root.append(cellbar);

  let closeCellEditor: (() => void) | undefined;
  const openCellEditor = (record: number, column: number): void => {
    const csv = table.csv;
    const cell = csv && tableSuggestionCell(csv, record, column);
    if (
      !csv ||
      !cell ||
      cell.editable !== true ||
      unsafeSuggestions(cell.field)
    )
      return;
    if (!requestSurfaceSwap(root, 'table-cell')) return;
    closeCellEditor?.();
    const panel = element('div', 'dt-suggest-editor');
    const title = element(
      'p',
      'dt-suggest-title',
      `Suggest an edit to ${columnLetters(column + 1)}${record + 1}`
    );
    const editorRoot = element('div', 'dt-suggest-text');
    editorRoot.setAttribute('aria-label', 'Cell suggestion');
    const close = element('button', 'dt-suggest-close', 'Close');
    close.type = 'button';
    panel.append(title, editorRoot, close);
    root.append(panel);
    const unregister = registerSuggestionSurface(
      root,
      tableCellSurface(csv, cell, editorRoot, options.autoDelimiter)
    );
    closeCellEditor = () => {
      unregister();
      panel.remove();
      closeCellEditor = undefined;
      root.dispatchEvent(
        new CustomEvent('relic:structured-state', { bubbles: true })
      );
    };
    close.addEventListener('click', () => {
      if (requestSurfaceSwap(root, 'table-cell')) closeCellEditor?.();
    });
    root.dispatchEvent(
      new CustomEvent('relic:table-suggest', { bubbles: true })
    );
  };

  // ---- selection helpers ----------------------------------------------------
  const sortedNow = (): boolean => sort !== undefined;
  const selectOne = (record: number, column: number): void => {
    selection = {
      anchor: { record, column },
      focus: { record, column },
    };
  };
  const extendTo = (record: number, column: number): void => {
    if (selection === undefined || sortedNow()) {
      selectOne(record, column);
      return;
    }
    selection = { anchor: selection.anchor, focus: { record, column } };
  };

  /** The rendered element for a cell: the body row if drawn, else the header. */
  const elementAt = (record: number, column: number): HTMLElement | undefined =>
    bodyIndex.get(keyOf(record, column)) ??
    (record === 0 ? headIndex.get(column) : undefined);

  const syncDomSelection = (force: boolean): void => {
    if (typeof document === 'undefined') return;
    const live = document.getSelection();
    if (live === null) return;
    if (
      live.anchorNode &&
      root.querySelector('.dt-suggest-editor')?.contains(live.anchorNode)
    )
      return;
    const inside = live.anchorNode !== null && root.contains(live.anchorNode);
    if (selection === undefined) {
      if (inside) live.removeAllRanges();
      return;
    }
    // Another part of the page holds the selection: do not take it back.
    if (!force && !inside && !live.isCollapsed) return;
    const rect = selectionRect(selection);
    const start = elementAt(rect.r0, rect.c0);
    const end = elementAt(rect.r1, rect.c1);
    if (start === undefined || end === undefined) return;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.childNodes.length);
    live.removeAllRanges();
    live.addRange(range);
  };

  /** Scrolls the grid so the display row and column are on screen. */
  const reveal = (display: number, column: number): void => {
    const first = headerRow ? 1 : 0;
    if (display >= first) {
      // Rows sit in the body, which starts below the sticky head, so a row at
      // `top` shows under the head once `scrollTop` equals `top`.
      const top = (display - first) * ROW_HEIGHT;
      const shown = grid.scrollTop;
      const viewport = viewportHeight();
      if (top < shown) grid.scrollTop = top;
      else if (top + ROW_HEIGHT > shown + viewport) {
        grid.scrollTop = top + ROW_HEIGHT - viewport;
      }
    }
    const left = columnLeft[column] ?? ROW_NUMBER_WIDTH;
    const right = left + (widths[column] ?? 0);
    if (left < grid.scrollLeft + ROW_NUMBER_WIDTH) {
      grid.scrollLeft = Math.max(0, left - ROW_NUMBER_WIDTH);
    } else if (right > grid.scrollLeft + grid.clientWidth) {
      grid.scrollLeft = right - grid.clientWidth;
    }
  };

  const viewportHeight = (): number =>
    grid.clientHeight > 0 ? grid.clientHeight - HEAD_HEIGHT : 480;

  // ---- painting -------------------------------------------------------------
  const paintCell = (
    cell: HTMLElement,
    record: number,
    column: number,
    role: 'body' | 'head'
  ): void => {
    const row = record + 1;
    const col = column + 1;
    const cover = marks.coverage(row, col);
    const isSelected =
      selection !== undefined &&
      inRect(selectionRect(selection), record, column);
    const isActive =
      selection !== undefined &&
      selection.focus.record === record &&
      selection.focus.column === column;
    const key = keyOf(record, column);
    const classes = ['dt-cell'];
    if (role === 'head') classes.push('dt-hcell');
    if (numericColumn(column) && table.numeric(record, column) !== undefined) {
      classes.push('is-num');
    }
    if (cover.count > 0) classes.push('is-marked');
    if (cover.ranged) classes.push('is-range');
    for (const edge of cover.edges) classes.push(edge);
    if (isSelected) classes.push('is-sel');
    if (isActive) classes.push('is-active');
    if (findKeys.has(key)) classes.push('is-find');
    if (
      findCurrent >= 0 &&
      findHits[findCurrent]?.record === record &&
      findHits[findCurrent]?.column === column
    ) {
      classes.push('is-find-cur');
    }
    cell.className = classes.join(' ');
    cell.dataset['r'] = String(record);
    cell.dataset['c'] = String(column);
    cell.setAttribute('aria-selected', String(isSelected));
    cell.tabIndex = isActive ? 0 : -1;
    if (cover.count > 1) cell.dataset['marks'] = String(cover.count);
    else delete cell.dataset['marks'];
  };

  const inRect = (
    rect: SelectionRect,
    record: number,
    column: number
  ): boolean =>
    record >= rect.r0 &&
    record <= rect.r1 &&
    column >= rect.c0 &&
    column <= rect.c1;

  const buildCell = (
    record: number,
    column: number,
    role: 'body' | 'head'
  ): HTMLElement => {
    const cell = element('div');
    cell.setAttribute('role', role === 'head' ? 'columnheader' : 'gridcell');
    cell.setAttribute('aria-colindex', String(column + 2));
    const value = table.text(record, column);
    if (role === 'head') {
      const letter = element('span', 'dt-letter', columnLetters(column + 1));
      const name = element(
        'span',
        'dt-text',
        headerRow ? displayText(value) : ''
      );
      cell.append(letter, name);
      const sorted = sort !== undefined && sort.column === column;
      if (sorted) {
        const indicator = element('span', 'dt-sort');
        indicator.dataset['dir'] = sort?.direction ?? 'asc';
        cell.append(indicator);
      }
      if (table.commentable !== false) {
        const commentButton = element('button', 'dt-hc-comment');
        commentButton.type = 'button';
        commentButton.setAttribute(
          'aria-label',
          `Comment on column ${columnLetters(column + 1)}`
        );
        commentButton.title = `Comment on column ${columnLetters(column + 1)}`;
        cell.append(commentButton);
      }
    } else if (value === '') {
      cell.append(element('span', 'dt-text dt-blank', 'blank'));
    } else {
      cell.append(element('span', 'dt-text', displayText(value)));
    }
    const csv = table.csv;
    const field = csv && csv.recordStart[record]! + column;
    const changes =
      field === undefined ? undefined : suggestionCells.get(field);
    const mapped = csv && changes && tableSuggestionCell(csv, record, column);
    const text = changes && cell.querySelector<HTMLElement>('.dt-text');
    if (
      csv &&
      mapped &&
      changes &&
      suggestionViews &&
      text &&
      mapped.editable === true &&
      (role !== 'head' || headerRow) &&
      displayText(value) === value
    ) {
      text.classList.remove('dt-blank');
      const surface = tableCellSurface(csv, mapped, text);
      paintSuggestions(
        text,
        mapped.segments,
        { ...suggestionViews, paint: changes },
        'markdown',
        (block, source) =>
          visibleText(surface.decode?.(block, source) ?? source)
      );
      for (const mark of text.querySelectorAll<HTMLElement>('[data-sg-id]')) {
        const id = mark.dataset['sgId'];
        if (id) mark.dataset['commentId'] = id;
      }
    }
    if (changes?.length && mapped && text && (role !== 'head' || headerRow)) {
      const ids = new Set<string>();
      for (const change of changes) {
        for (const id of change.conflict?.members ?? [change.row.id]) {
          ids.add(id);
          for (const duplicate of suggestionViews?.byId.get(id)?.also ?? [])
            ids.add(duplicate);
        }
      }
      const members = [...ids];
      const first = members[0]!;
      const count = members.length;
      const indicator = element(
        'button',
        'dt-suggestion-indicator',
        count > 1 ? String(count) : 'Edit'
      );
      indicator.type = 'button';
      indicator.dataset['sgId'] = first;
      indicator.dataset['commentId'] = first;
      if (count > 1) indicator.dataset['clusterMembers'] = members.join(' ');
      indicator.setAttribute(
        'aria-label',
        count > 1
          ? `Open suggestion, ${count} changes in this cell`
          : 'Open suggestion'
      );
      cell.append(indicator);
    }
    paintCell(cell, record, column, role);
    return cell;
  };

  const renderHead = (): void => {
    const cells: HTMLElement[] = [];
    headIndex.clear();
    cells.push(element('div', 'dt-corner', headerRow ? '1' : ''));
    for (let column = 0; column < drawn; column++) {
      const cell = buildCell(0, column, 'head');
      headIndex.set(column, cell);
      cells.push(cell);
    }
    head.replaceChildren(...cells);
  };

  /**
   * What a body render depends on from the scroll: the drawn window, the rows
   * pinned by a selection, and the row count. Equal keys draw the same rows.
   */
  const bodyKey = (): string => {
    const first = headerRow ? 1 : 0;
    const bodyCount = model.records - first;
    const window = rowWindow(
      bodyCount,
      Math.max(0, grid.scrollTop - HEAD_HEIGHT),
      viewportHeight(),
      ROW_HEIGHT,
      OVERSCAN
    );
    const pins = selection ? [selection.anchor, selection.focus] : [];
    const pinRows = pins.map(
      (pin) => displayIndexOf(model, pin.record) - first
    );
    return [bodyCount, window.first, window.end, ...pinRows].join(':');
  };

  const renderBody = (): void => {
    const first = headerRow ? 1 : 0;
    const bodyCount = model.records - first;
    body.style.height = `${bodyCount * ROW_HEIGHT}px`;
    bodyIndex.clear();
    const shown = Math.max(0, grid.scrollTop - HEAD_HEIGHT);
    const window = rowWindow(
      bodyCount,
      shown,
      viewportHeight(),
      ROW_HEIGHT,
      OVERSCAN
    );
    const wanted = new Set<number>();
    for (let i = window.first; i < window.end; i++) wanted.add(i);
    // The rows holding a selection's corners stay in the DOM, so a range can
    // be drawn and offered even when it runs off the screen.
    const pins: CellRef[] = selection
      ? [selection.anchor, selection.focus]
      : [];
    for (const pin of pins) {
      const i = displayIndexOf(model, pin.record) - first;
      if (i >= 0 && i < bodyCount) wanted.add(i);
    }
    const rows: HTMLElement[] = [];
    for (const i of [...wanted].sort((a, b) => a - b)) {
      rows.push(buildRow(first + i, i));
    }
    body.replaceChildren(...rows);
    drawnKey = bodyKey();
  };

  const buildRow = (display: number, index: number): HTMLElement => {
    const record = recordAt(model, display);
    const row = element('div', 'dt-row');
    row.setAttribute('role', 'row');
    row.setAttribute('aria-rowindex', String(record + 1));
    row.style.top = `${index * ROW_HEIGHT}px`;
    row.style.width = `${totalWidth}px`;
    const number = element('div', 'dt-rn', String(record + 1));
    number.setAttribute('role', 'rowheader');
    row.append(number);
    for (let column = 0; column < drawn; column++) {
      const cell = buildCell(record, column, 'body');
      bodyIndex.set(keyOf(record, column), cell);
      row.append(cell);
    }
    return row;
  };

  const renderCellbar = (): void => {
    const cells: HTMLElement[] = [];
    if (selection === undefined) {
      cells.push(
        element('p', 'dt-hint', 'Select a cell to comment on it, or copy it.')
      );
    } else {
      const rect = selectionRect(selection);
      const single = rect.r0 === rect.r1 && rect.c0 === rect.c1;
      const address = single
        ? `${columnLetters(rect.c0 + 1)}${rect.r0 + 1}`
        : `${columnLetters(rect.c0 + 1)}${rect.r0 + 1}:${columnLetters(rect.c1 + 1)}${rect.r1 + 1}`;
      const addressEl = element('p', 'dt-addr', address);
      cells.push(addressEl);
      if (single) {
        const value = table.text(rect.r0, rect.c0);
        const columnName = headerRow ? table.text(0, rect.c0) : '';
        const detail = table.detail?.(rect.r0, rect.c0);
        const meta = detail ? ` · ${detail.type}` : '';
        cells.push(
          element(
            'p',
            'dt-sub',
            (columnName === ''
              ? `Row ${rect.r0 + 1}`
              : `Row ${rect.r0 + 1}, ${labelText(columnName)}`) + meta
          )
        );
        cells.push(
          element(
            'pre',
            'dt-value',
            (value === '' ? '(blank)' : displayText(value)) +
              (detail?.formula
                ? `\n${detail.sharedFrom ? 'Shared master formula' : 'Formula'}: ${displayText(detail.formula)}`
                : '') +
              (detail?.sharedFrom ? `\nShared from: ${detail.sharedFrom}` : '')
          )
        );
      } else {
        cells.push(
          element(
            'p',
            'dt-sub',
            `${formatter.format(rect.r1 - rect.r0 + 1)} rows by ${formatter.format(rect.c1 - rect.c0 + 1)} columns`
          )
        );
      }
      if (single && table.csv) {
        const mapped = tableSuggestionCell(table.csv, rect.r0, rect.c0);
        const suggest = element('button', 'dt-suggest', 'Suggest edit');
        suggest.type = 'button';
        const unsafe = mapped && unsafeSuggestions(mapped.field);
        suggest.disabled = !mapped || mapped.editable !== true || !!unsafe;
        if (mapped && mapped.editable !== true)
          suggest.title = mapped.editable.message;
        else if (unsafe)
          suggest.title =
            'A suggestion in this cell contains invisible characters.';
        suggest.addEventListener('click', () =>
          openCellEditor(rect.r0, rect.c0)
        );
        cells.push(suggest);
      }
      const copy = element('button', 'dt-copy', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        try {
          const text = clipboardText(rectText(table, rect));
          void navigator.clipboard?.writeText(text).catch(() => undefined);
        } catch (error) {
          if (!(error instanceof RangeCopyTooLargeError)) throw error;
          copy.textContent = error.message;
          copy.setAttribute('aria-label', error.message);
        }
      });
      cells.push(copy);
    }
    cellbar.replaceChildren(...cells);
  };

  /** Redraws everything from state, then puts the document's selection back on the cells. */
  const update = (focusActive: boolean): void => {
    if (disposed) return;
    renderHead();
    renderBody();
    renderCellbar();
    syncDomSelection(false);
    if (focusActive && selection !== undefined) {
      const focus = elementAt(selection.focus.record, selection.focus.column);
      focus?.focus({ preventScroll: true });
    }
  };
  const onSuggestionViews = (event: Event): void => {
    if (!(event instanceof CustomEvent) || !table.csv) return;
    const next = event.detail as SuggestionViews;
    suggestionViews = next;
    suggestionCells = new Map();
    for (const result of next.resolved) {
      if (result.status !== 'resolved') continue;
      const view = next.byId.get(result.id);
      if (!view || view.location.status !== 'resolved') continue;
      const field = tableFieldAtRange(
        table.csv,
        view.location.start,
        view.location.end
      );
      if (field === undefined) continue;
      const changes = suggestionCells.get(field) ?? [];
      if (
        view.conflict &&
        changes.some(
          (other) => other.conflict?.defaultId === view.conflict?.defaultId
        )
      )
        continue;
      changes.push(view);
      suggestionCells.set(field, changes);
    }
    update(false);
  };
  root.addEventListener('relic:table-suggestion-views', onSuggestionViews);

  const scheduleUpdate = (): void => {
    if (frame !== 0 || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // A scroll inside the drawn window puts the same rows on screen.
      if (bodyKey() !== drawnKey) update(false);
    });
  };

  const setHeaderRow = (next: boolean): void => {
    headerRow = next;
    numericCache = undefined;
    model = {
      ...model,
      headerRow,
      order: sort === undefined ? undefined : sortOrder(table, headerRow, sort),
    };
    summary.textContent =
      `${formatter.format(table.records - (headerRow ? 1 : 0))} rows · ` +
      `${formatter.format(table.columns)} columns · ` +
      table.summary;
    update(false);
    if (find.value.trim()) runFind(find.value);
  };

  const cycleSort = (column: number): void => {
    if (sort === undefined || sort.column !== column) {
      sort = { column, direction: 'asc' };
    } else if (sort.direction === 'asc') {
      sort = { column, direction: 'desc' };
    } else {
      sort = undefined;
    }
    model = {
      ...model,
      order: sort === undefined ? undefined : sortOrder(table, headerRow, sort),
    };
    // Sorting moves the rows a selection was made on, so the selection goes.
    selection = undefined;
    update(false);
    if (find.value.trim()) runFind(find.value);
  };

  const gotoHit = (index: number): void => {
    const hit = findHits[index];
    if (hit === undefined) return;
    findCurrent = index;
    selectOne(hit.record, hit.column);
    reveal(displayIndexOf(model, hit.record), hit.column);
    findCount.textContent = `${index + 1} of ${formatter.format(findHits.length)}`;
    update(false);
  };

  const runFind = (
    query: string,
    searchNavigation = navigationGeneration
  ): void => {
    const generation = ++findGeneration;
    window.clearTimeout(findTimer);
    const needle = query.trim().toLowerCase();
    const searchModel = model;
    const finish = (hits: CellRef[]): void => {
      if (disposed || generation !== findGeneration || searchModel !== model)
        return;
      findHits = hits;
      findKeys = new Set(hits.map((hit) => keyOf(hit.record, hit.column)));
      findCurrent = -1;
      if (!needle) {
        findCount.textContent = '';
        update(false);
        return;
      }
      if (!hits.length) {
        findCount.textContent = 'No matches';
        update(false);
        return;
      }
      if (navigationGeneration === searchNavigation) {
        gotoHit(0);
      } else {
        findCount.textContent = `${formatter.format(hits.length)} ${hits.length === 1 ? 'match' : 'matches'}`;
        update(false);
      }
      if (hits.length >= FIND_LIMIT)
        findCount.textContent = `More than ${formatter.format(FIND_LIMIT)} matches`;
    };
    if (!needle || !table.matchingColumns) {
      finish(findCells(table, searchModel, drawn, query));
      return;
    }
    const hits: CellRef[] = [];
    let display = 0;
    findCount.textContent = 'Searching';
    const batch = (): void => {
      if (disposed || generation !== findGeneration || searchModel !== model)
        return;
      const deadline = performance.now() + 8;
      let rows = 0;
      while (
        display < searchModel.records &&
        hits.length < FIND_LIMIT &&
        rows++ < 256 &&
        performance.now() < deadline
      ) {
        const record = recordAt(searchModel, display++);
        for (const column of table.matchingColumns!(
          record,
          needle,
          drawn,
          FIND_LIMIT - hits.length
        ))
          hits.push({ record, column });
      }
      if (display < searchModel.records && hits.length < FIND_LIMIT)
        findTimer = window.setTimeout(batch, 0);
      else finish(hits);
    };
    batch();
  };

  // ---- events ---------------------------------------------------------------
  const cellOf = (target: EventTarget | null): HTMLElement | undefined =>
    target instanceof Element
      ? (target.closest<HTMLElement>('[data-c]') ?? undefined)
      : undefined;

  const endDrag = (): void => {
    dragging = false;
    document.removeEventListener('mouseup', endDrag);
    syncDomSelection(true);
  };

  grid.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-comment-id]')) return;
    const cell = cellOf(target);
    if (cell === undefined) return;
    navigationGeneration++;
    event.preventDefault();
    const column = Number(cell.dataset['c']);
    if (cell.classList.contains('dt-hcell')) {
      // A header is a sort on click, and a comment through its own button.
      if (target.closest('.dt-hc-comment') !== null) {
        selectOne(0, column);
        update(false);
      }
      return;
    }
    const record = Number(cell.dataset['r']);
    if (event.shiftKey && selection !== undefined) extendTo(record, column);
    else selectOne(record, column);
    dragging = true;
    document.addEventListener('mouseup', endDrag);
    update(true);
  });

  grid.addEventListener('mousemove', (event) => {
    if (!dragging || sortedNow()) return;
    const cell = cellOf(event.target);
    if (cell === undefined || cell.classList.contains('dt-hcell')) return;
    const record = Number(cell.dataset['r']);
    const column = Number(cell.dataset['c']);
    if (selection?.focus.record === record && selection.focus.column === column)
      return;
    extendTo(record, column);
    update(false);
  });

  grid.addEventListener('mouseup', () => {
    if (dragging) endDrag();
  });

  head.addEventListener('click', (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('[data-comment-id]')
    )
      return;
    const cell =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.dt-hcell')
        : null;
    if (!cell) return;
    cycleSort(Number(cell.dataset['c']));
  });

  head.addEventListener('mousedown', (event) => {
    // A comment button selects its column header. Any other press is a sort on click.
    const button =
      event.target instanceof Element
        ? event.target.closest('.dt-hc-comment')
        : null;
    if (button !== null) event.stopPropagation();
  });

  head.addEventListener(
    'click',
    (event) => {
      // A column's comment button comments on that column's first row, the
      // anchor a selection of the header gives. It never sorts the column.
      if (!(event.target instanceof Element)) return;
      const comment = event.target.closest<HTMLElement>('.dt-hc-comment');
      if (comment === null) return;
      if (table.commentable === false) return;
      event.stopPropagation();
      const column = Number(
        comment.closest<HTMLElement>('.dt-hcell')?.dataset['c']
      );
      if (!Number.isInteger(column)) return;
      selectOne(0, column);
      update(false);
      // From the column's header cell, so the composer opens beside it rather
      // than beside the whole table. The update above may have redrawn it.
      (headIndex.get(column) ?? root).dispatchEvent(
        new CustomEvent('relic:structured-comment', {
          bubbles: true,
          detail: {
            anchor: anchorForRect(
              { r0: 0, r1: 0, c0: column, c1: column },
              table.sheet
            ),
          },
        })
      );
    },
    true
  );

  grid.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      navigationGeneration++;
      event.preventDefault();
      selection = undefined;
      update(false);
      return;
    }
    const current = selection?.focus ?? {
      record: recordAt(model, headerRow ? 1 : 0),
      column: 0,
    };
    const display = displayIndexOf(model, current.record);
    const last = model.records - 1;
    const step = Math.max(1, Math.floor(viewportHeight() / ROW_HEIGHT));
    let nextDisplay = display;
    let nextColumn = current.column;
    switch (event.key) {
      case 'ArrowUp':
        nextDisplay = Math.max(0, display - 1);
        break;
      case 'ArrowDown':
        nextDisplay = Math.min(last, display + 1);
        break;
      case 'ArrowLeft':
        nextColumn = Math.max(0, current.column - 1);
        break;
      case 'ArrowRight':
        nextColumn = Math.min(drawn - 1, current.column + 1);
        break;
      case 'Home':
        if (event.ctrlKey || event.metaKey) nextDisplay = 0;
        nextColumn = 0;
        break;
      case 'End':
        if (event.ctrlKey || event.metaKey) nextDisplay = last;
        nextColumn = drawn - 1;
        break;
      case 'PageUp':
        nextDisplay = Math.max(0, display - step);
        break;
      case 'PageDown':
        nextDisplay = Math.min(last, display + step);
        break;
      default:
        return;
    }
    navigationGeneration++;
    event.preventDefault();
    const record = recordAt(model, nextDisplay);
    if (event.shiftKey && selection !== undefined && !sortedNow()) {
      selection = {
        anchor: selection.anchor,
        focus: { record, column: nextColumn },
      };
    } else {
      selectOne(record, nextColumn);
    }
    reveal(nextDisplay, nextColumn);
    update(true);
  });

  grid.addEventListener('scroll', scheduleUpdate);

  headerBox.addEventListener('change', () => setHeaderRow(headerBox.checked));

  find.addEventListener('input', () => {
    findGeneration++;
    window.clearTimeout(findTimer);
    findHits = [];
    findKeys.clear();
    findCurrent = -1;
    findCount.textContent = '';
    update(false);
    const searchNavigation = navigationGeneration;
    findTimer = window.setTimeout(
      () => runFind(find.value, searchNavigation),
      FIND_DELAY_MS
    );
  });
  find.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (findHits.length === 0) return;
      const delta = event.shiftKey ? -1 : 1;
      gotoHit((findCurrent + delta + findHits.length) % findHits.length);
    } else if (event.key === 'Escape') {
      find.value = '';
      runFind('');
    }
  });
  // A key or click in the find box is not a selection in the table.
  for (const type of ['keyup', 'mouseup'] as const) {
    bar.addEventListener(type, (event) => event.stopPropagation());
    cellbar.addEventListener(type, (event) => event.stopPropagation());
  }

  // ---- first paint ----------------------------------------------------------
  update(false);

  /**
   * Repaints the drawn cells a mark covered before it changed and covers now.
   * A single cell is found directly; a range visits the drawn cells only, so a
   * comment costs its own cells rather than a rebuild of the window.
   */
  const repaintCovered = (
    ...anchors: readonly (CellCommentAnchor | undefined)[]
  ): void => {
    for (const anchor of anchors) {
      if (anchor === undefined) continue;
      if (isPointAnchor(anchor)) {
        const record = anchor.row - 1;
        const column = anchor.col - 1;
        const cell = elementAt(record, column);
        if (cell !== undefined) {
          paintCell(
            cell,
            record,
            column,
            cell.classList.contains('dt-hcell') ? 'head' : 'body'
          );
        }
        continue;
      }
      for (const [key, cell] of bodyIndex) {
        const record = Math.floor(key / TABLE_COLUMN_LIMIT);
        const column = key % TABLE_COLUMN_LIMIT;
        if (anchorCoversCell(anchor, record + 1, column + 1)) {
          paintCell(cell, record, column, 'body');
        }
      }
      for (const [column, cell] of headIndex) {
        if (anchorCoversCell(anchor, 1, column + 1)) {
          paintCell(cell, 0, column, 'head');
        }
      }
    }
  };

  return {
    paintMark(anchor: CommentAnchor, commentId: string): boolean {
      if (anchor.kind !== 'cell') return false;
      if (!markFits(anchor, table.records, drawn, table.sheet)) return false;
      const replaced = marks.put(commentId, anchor);
      repaintCovered(replaced, anchor);
      return true;
    },
    clearMarks(): void {
      marks.clear();
      update(false);
    },
    selectionAnchor(): CommentAnchor | undefined {
      if (selection === undefined || typeof document === 'undefined')
        return undefined;
      const live = document.getSelection();
      if (live === null || live.isCollapsed || live.anchorNode === null)
        return undefined;
      if (
        !grid.contains(live.anchorNode) ||
        !live.focusNode ||
        !grid.contains(live.focusNode)
      )
        return undefined;
      return anchorForRect(selectionRect(selection), table.sheet);
    },
    reveal(anchor: CommentAnchor): void {
      if (
        anchor.kind !== 'cell' ||
        !markFits(anchor, table.records, drawn, table.sheet)
      )
        return;
      navigationGeneration++;
      const top = anchor.row - 1;
      const left = anchor.col - 1;
      // A sorted table holds one cell selected, since a range is not contiguous.
      selection = sortedNow()
        ? {
            anchor: { record: top, column: left },
            focus: { record: top, column: left },
          }
        : {
            anchor: { record: top, column: left },
            focus: {
              record: (anchor.row_end ?? anchor.row) - 1,
              column: (anchor.col_end ?? anchor.col) - 1,
            },
          };
      reveal(displayIndexOf(model, top), left);
      update(false);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      selection = undefined;
      syncDomSelection(false);
      document.removeEventListener('mouseup', endDrag);
      root.removeEventListener(
        'relic:table-suggestion-views',
        onSuggestionViews
      );
      closeCellEditor?.();
      if (frame !== 0) cancelAnimationFrame(frame);
      window.clearTimeout(findTimer);
    },
  };
}
