import { describe, expect, test } from 'bun:test';
import {
  anchorCoversCell,
  cellReference,
  columnLetters,
  displayIndexOf,
  recordAt,
  rowWindow,
  type TableModel,
} from '../src/table-model.ts';

// The model keeps marks on A1 coordinates of the file, so these tests check
// the mapping a sort, a find and a scroll depend on: a record keeps its
// coordinates, and only its display position moves.

describe('A1 coordinates', () => {
  test('column letters run A to Z, then AA, then AAA', () => {
    expect(columnLetters(1)).toBe('A');
    expect(columnLetters(26)).toBe('Z');
    expect(columnLetters(27)).toBe('AA');
    expect(columnLetters(702)).toBe('ZZ');
    expect(columnLetters(703)).toBe('AAA');
  });

  test('a cell reference is its column letters then its 1-based row', () => {
    expect(cellReference(14, 3)).toBe('C14');
    expect(cellReference(1, 1)).toBe('A1');
    expect(cellReference(1048576, 16384)).toBe('XFD1048576');
  });
});

describe('anchorCoversCell', () => {
  const single = { row: 14, col: 3 };
  const range = { row: 4, col: 2, row_end: 9, col_end: 4 };

  test('a single cell covers only itself', () => {
    expect(anchorCoversCell(single, 14, 3)).toBe(true);
    expect(anchorCoversCell(single, 14, 4)).toBe(false);
    expect(anchorCoversCell(single, 13, 3)).toBe(false);
  });

  test('a range covers its inclusive corners and nothing outside', () => {
    expect(anchorCoversCell(range, 4, 2)).toBe(true);
    expect(anchorCoversCell(range, 9, 4)).toBe(true);
    expect(anchorCoversCell(range, 10, 4)).toBe(false);
    expect(anchorCoversCell(range, 5, 1)).toBe(false);
  });

  test('an absent end means the same as its start', () => {
    expect(anchorCoversCell({ row: 2, col: 3, row_end: 5 }, 5, 3)).toBe(true);
    expect(anchorCoversCell({ row: 2, col: 3, row_end: 5 }, 5, 4)).toBe(false);
  });
});

describe('the sort permutation keeps marks on their records', () => {
  // Records 0 to 4 in file order. Sorted descending by a key that puts record 3
  // first, then record 0, then the rest in file order.
  const sorted: TableModel = {
    records: 5,
    columns: 2,
    headerRow: true,
    order: Uint32Array.from([3, 0, 1, 2, 4]),
  };
  const fileOrder: TableModel = { records: 5, columns: 2, headerRow: true };

  test('file order maps each record to its own display index', () => {
    for (let record = 0; record < 5; record += 1) {
      expect(displayIndexOf(fileOrder, record)).toBe(record);
      expect(recordAt(fileOrder, record)).toBe(record);
    }
  });

  test('a sorted table draws record 3 first and still knows its record', () => {
    expect(recordAt(sorted, 0)).toBe(3);
    expect(displayIndexOf(sorted, 3)).toBe(0);
    expect(displayIndexOf(sorted, 0)).toBe(1);
  });

  test('a mark made on record 3 still covers the same cell after the sort', () => {
    // Record 3 is file row 4 (A1 row numbers start at 1 and record 0 is row 1).
    const anchor = { row: 4, col: 2 };
    const record = 3;
    expect(anchorCoversCell(anchor, record + 1, 2)).toBe(true);
    expect(displayIndexOf(sorted, record)).toBe(0);
  });

  test('a record outside the table has no display index', () => {
    expect(displayIndexOf(sorted, 9)).toBe(-1);
    expect(recordAt(sorted, 9)).toBe(-1);
    expect(recordAt(fileOrder, -1)).toBe(-1);
  });
});

describe('rowWindow: only the visible rows are drawn', () => {
  test('a screenful of a long table is a screenful of rows plus overscan', () => {
    // 50,000 rows of 20px, a 400px viewport scrolled to 2,000px.
    expect(rowWindow(50_000, 2_000, 400, 20, 2)).toEqual({
      first: 98,
      end: 122,
    });
  });

  test('the window is clamped at the top and at the end of the table', () => {
    expect(rowWindow(100, 0, 200, 20, 3)).toEqual({ first: 0, end: 13 });
    expect(rowWindow(100, 1_000_000, 200, 20, 3)).toEqual({
      first: 97,
      end: 100,
    });
  });

  test('an empty table or a nonsense row height draws nothing', () => {
    expect(rowWindow(0, 0, 400, 20, 2)).toEqual({ first: 0, end: 0 });
    expect(rowWindow(10, 0, 400, 0, 2)).toEqual({ first: 0, end: 0 });
  });
});
