import { describe, expect, test } from 'bun:test';
import { parseTable } from '@relic/format/csv';
import {
  anchorForRect,
  markFits,
  rectText,
  RangeCopyTooLargeError,
} from '../src/data-table.ts';
import { csvTableSource } from '../src/table-source.ts';

describe('table source', () => {
  test('range copy guards formula-like cells but not plain numbers', () => {
    const parsed = parseTable(
      '"=HYPERLINK(""x"")",+1+1,-2+3,-5,+3.2,@SUM(A1),\t=1, =1,,"=a\nb",＝1'
    );
    if (!parsed.ok) throw new Error('fixture refused');
    const table = csvTableSource(parsed.table);
    // Embedded separators and quotes are quoted as one TSV field.
    expect(rectText(table, { r0: 0, r1: 0, c0: 0, c1: 10 })).toBe(
      [
        '"\'=HYPERLINK(""x"")"',
        "'+1+1",
        "'-2+3",
        '-5',
        '+3.2',
        "'@SUM(A1)",
        '"\t=1"',
        ' =1',
        '',
        '"\'=a\nb"',
        '＝1',
      ].join('\t')
    );
    expect(rectText(table, { r0: 0, r1: 0, c0: 0, c1: 0 })).toBe(
      '=HYPERLINK("x")'
    );
  });

  test('range copy refuses excessive cells or output, while single copy remains raw', () => {
    const value = 'x'.repeat(4 * 1024 * 1024 + 1);
    const table = {
      records: 100001,
      columns: 2,
      summary: 'Spreadsheet',
      text: () => value,
      numeric: () => undefined,
    };
    expect(() => rectText(table, { r0: 0, r1: 100000, c0: 0, c1: 0 })).toThrow(
      RangeCopyTooLargeError
    );
    expect(() => rectText(table, { r0: 0, r1: 0, c0: 0, c1: 1 })).toThrow(
      RangeCopyTooLargeError
    );
    expect(rectText(table, { r0: 0, r1: 0, c0: 0, c1: 0 })).toBe(value);
  });

  test('sheet anchors match only the same sheet', () => {
    const anchor = anchorForRect({ r0: 0, r1: 1, c0: 1, c1: 2 }, 'Q3');
    expect(anchor).toEqual({
      kind: 'cell',
      row: 1,
      col: 2,
      row_end: 2,
      col_end: 3,
      sheet: 'Q3',
    });
    expect(markFits(anchor, 2, 3, 'Q3')).toBe(true);
    expect(markFits(anchor, 2, 3, 'Q4')).toBe(false);
    expect(markFits({ kind: 'cell', row: 1, col: 1 }, 2, 3, 'Q3')).toBe(false);
  });
});
