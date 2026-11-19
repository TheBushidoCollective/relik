/**
 * The table model shared by the CSV, TSV and spreadsheet views (plan A0,
 * section 3 and section 5).
 *
 * The rule the whole model exists for: a comment is kept on the record and the
 * column it was made on, in A1 coordinates of the published file, and never on
 * the position a row happens to be drawn at. A sort, a find, or a scroll moves
 * rows, so display positions are derived here from the record order and never
 * stored with a mark.
 */

import type { CellCommentAnchor } from '@relic/format';

/**
 * A table as the view holds it. `order` is the sort permutation: element `d`
 * is the 0-based record drawn at display index `d`. Absent means file order,
 * which is also what "back to file order" restores.
 */
export interface TableModel {
  /** Records in file order, record 1 first, including a header record. */
  readonly records: number;
  /** Columns, the widest record's field count. */
  readonly columns: number;
  /** Whether record 1 is drawn as the header row. */
  readonly headerRow: boolean;
  readonly order?: Uint32Array;
}

/** A1 column letters: 1 is A, 26 is Z, 27 is AA. */
export function columnLetters(col: number): string {
  let letters = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** A1 reference for one cell, such as `C14`. Both coordinates are 1-based. */
export function cellReference(row: number, col: number): string {
  return `${columnLetters(col)}${row}`;
}

/**
 * The display index a record is drawn at, or `-1` when the record is not in
 * the table. Linear, which is correct for any order; a view that needs it per
 * paint keeps its own inverse.
 */
export function displayIndexOf(model: TableModel, record: number): number {
  if (model.order === undefined) {
    return record >= 0 && record < model.records ? record : -1;
  }
  return model.order.indexOf(record);
}

/** The 0-based record drawn at a display index, or `-1` when out of range. */
export function recordAt(model: TableModel, displayIndex: number): number {
  if (displayIndex < 0 || displayIndex >= model.records) return -1;
  return model.order === undefined
    ? displayIndex
    : (model.order[displayIndex] ?? -1);
}

/**
 * Whether a cell comment covers the cell at `row` and `col`. Both are A1
 * coordinates of the published file, and an absent end means the same as its
 * start. Coordinates are never display positions, so the answer does not
 * change when the table is sorted.
 */
export function anchorCoversCell(
  anchor: Pick<CellCommentAnchor, 'row' | 'col' | 'row_end' | 'col_end'>,
  row: number,
  col: number
): boolean {
  const rowEnd = anchor.row_end ?? anchor.row;
  const colEnd = anchor.col_end ?? anchor.col;
  return (
    row >= anchor.row && row <= rowEnd && col >= anchor.col && col <= colEnd
  );
}

/** Display indexes `[first, end)` to draw for a list of fixed-height rows. */
export interface RowWindow {
  readonly first: number;
  readonly end: number;
}

/**
 * The rows to keep in the DOM: the ones the viewport shows, plus `overscan`
 * rows either side. Only these are drawn, which keeps a 50,000-row table to a
 * screenful of elements. Clamped to `[0, total]`.
 */
export function rowWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number
): RowWindow {
  if (total <= 0 || rowHeight <= 0) return { first: 0, end: 0 };
  const top = Math.min(
    total,
    Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight))
  );
  const first = Math.max(0, top - Math.max(0, overscan));
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  const end = Math.min(total, top + visible + Math.max(0, overscan));
  return { first, end: Math.max(first, end) };
}
