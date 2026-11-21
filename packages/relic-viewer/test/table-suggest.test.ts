import { describe, expect, test } from 'bun:test';
import { parseTable } from '@relic/format/csv';
import {
  emptyTableCellAnchor,
  encodeTableSuggestion,
  tableSuggestionCell,
} from '../src/table-suggest.ts';

function parse(text: string, delimiter: ',' | '\t' = ',') {
  const result = parseTable(text, { delimiter });
  if (!result.ok) throw new Error(result.reason);
  return result.table;
}

describe('table suggestion source mapping', () => {
  test('maps BOM, CRLF and doubled quotes to source offsets', () => {
    const table = parse('\ufeffname,note\r\nAda,"a ""quote"""\r\n');
    const cell = tableSuggestionCell(table, 1, 1)!;
    const source = table.text.slice(1).replaceAll('\r\n', '\n');
    expect(cell.kind).toBe('csv-quoted');
    expect(cell.editable).toBe(true);
    expect(cell.segments.map((segment) => segment.text).join('')).toBe(
      'a "quote"'
    );
    expect(
      cell.segments.filter((segment) => segment.kind === 'escape')
    ).toHaveLength(2);
    for (const segment of cell.segments) {
      expect(source.slice(segment.start, segment.end)).toBe(
        segment.kind === 'escape' ? '""' : segment.text
      );
    }
    expect(encodeTableSuggestion(table, cell, 'say "hi"')).toEqual({
      ok: true,
      source: 'say ""hi""',
    });
  });

  test('anchors empty bare and quoted fields without consuming neighbours', () => {
    const table = parse('a,b,c\r\n,,""\r\n');
    const first = tableSuggestionCell(table, 1, 0)!;
    const second = tableSuggestionCell(table, 1, 1)!;
    const third = tableSuggestionCell(table, 1, 2)!;
    for (const cell of [first, second, third]) {
      const anchor = emptyTableCellAnchor(
        table,
        cell,
        cell.segments[0]!.start
      )!;
      expect(anchor.end - anchor.start).toBe(1);
      expect(anchor.mode === 'before' ? anchor.start : anchor.end).toBe(
        cell.segments[0]!.start
      );
    }
  });

  test('rejects malformed quote, embedded CR and bidi controls', () => {
    const table = parse('a,b,c\r\nstray"quote,"line\r\nbreak",a\u202eb\r\n');
    for (let column = 0; column < 3; column++) {
      const cell = tableSuggestionCell(table, 1, column)!;
      expect(cell.editable).not.toBe(true);
      expect(encodeTableSuggestion(table, cell, 'x').ok).toBe(false);
    }
  });

  test('refuses delimiters, quote and line breaks in bare cells and tab in TSV', () => {
    const table = parse('a,b\r\nx,y\r\n');
    const bare = tableSuggestionCell(table, 1, 0)!;
    for (const text of [',', '"', '\n', '\r'])
      expect(encodeTableSuggestion(table, bare, text).ok).toBe(false);
    const tsv = parse('a\tb\n"x"\ty\n', '\t');
    expect(
      encodeTableSuggestion(tsv, tableSuggestionCell(tsv, 1, 0)!, '\t').ok
    ).toBe(false);
    expect(encodeTableSuggestion(table, bare, 'safe')).toEqual({
      ok: true,
      source: 'safe',
    });
  });
});
