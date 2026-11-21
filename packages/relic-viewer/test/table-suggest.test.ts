import { describe, expect, test } from 'bun:test';
import { parseTable } from '@relic/format/csv';
import { SuggestDraftModel } from '../src/suggest-draft.ts';
import {
  emptyTableCellAnchor,
  encodeTableSuggestion,
  tableSuggestionCell,
} from '../src/table-suggest.ts';
import { TABLE_SUGGEST_CRLF } from './table-suggest-fixture.ts';

function parse(text: string, delimiter: ',' | '\t' = ',') {
  const result = parseTable(text, { delimiter });
  if (!result.ok) throw new Error(result.reason);
  return result.table;
}
function cellModel(text: string, record: number, column: number) {
  const table = parse(text);
  const cell = tableSuggestionCell(table, record, column);
  if (!cell) throw new Error('missing fixture cell');
  const source = table.text.replace(/^\ufeff/, '').replaceAll('\r\n', '\n');
  return {
    table,
    cell,
    model: new SuggestDraftModel({
      source,
      segments: cell.segments,
      delimiters: [],
      version: 1,
      reader: 'reader@example.test',
      encode: (_block, value, start, end) =>
        encodeTableSuggestion(table, cell, value, start, end),
    }),
  };
}

describe('table suggestion source mapping', () => {
  test('rejects a draft that changes the auto-detected delimiter', () => {
    const source = 'a,b;c\r\nrow;target\r\n';
    const result = parseTable(source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.table.delimiter).toBe(';');
    const cell = tableSuggestionCell(result.table, 1, 1)!;
    const start = cell.segments[0]!.start;
    const end = cell.segments[0]!.end;
    expect(
      encodeTableSuggestion(result.table, cell, 'x,y', start, end, true)
    ).toMatchObject({ ok: false, refusal: { code: 'delimiter-in-cell' } });
    expect(
      encodeTableSuggestion(result.table, cell, 'x,y', start, end, false)
    ).toEqual({ ok: true, source: 'x,y' });
    expect(
      encodeTableSuggestion(result.table, cell, 'safe', start, end, true)
    ).toEqual({ ok: true, source: 'safe' });
  });

  test('keeps a second BOM as data and maps the decoded source exactly', () => {
    const decoded = new TextDecoder().decode(
      new TextEncoder().encode('\ufeff\ufeffname,note\r\nAda,cat\r\n')
    );
    const result = parseTable(decoded, { skipBom: false });
    if (!result.ok) throw new Error(result.reason);
    expect(result.table.bom).toBe(false);
    const first = tableSuggestionCell(result.table, 0, 0)!;
    expect(first.segments[0]!.text.startsWith('\ufeff')).toBe(true);
    const cell = tableSuggestionCell(result.table, 1, 1)!;
    const source = decoded.replaceAll('\r\n', '\n');
    expect(source.slice(cell.segments[0]!.start, cell.segments[0]!.end)).toBe(
      'cat'
    );
  });

  test('refuses invisible original characters and typed replacements', () => {
    for (const hidden of ['\u0007', '\u0085', '\u200f', '\u2028']) {
      const table = parse(`a,b\nx,hi${hidden}there\n`);
      expect(tableSuggestionCell(table, 1, 1)!.editable).toMatchObject({
        code: 'not-editable',
      });
      const safe = tableSuggestionCell(table, 1, 0)!;
      const offset = safe.segments[0]!.start;
      expect(
        encodeTableSuggestion(table, safe, hidden, offset, offset)
      ).toMatchObject({ ok: false, refusal: { code: 'invalid-character' } });
    }
  });
  test('refuses to edit a blank row without an insertion anchor', () => {
    const table = parse('name\r\n\r\nlast\r\n');
    const blank = tableSuggestionCell(table, 1, 0)!;
    expect(blank.editable).toMatchObject({ code: 'not-editable' });
    const withDelimiter = parse('a,b\r\n,\r\n');
    expect(tableSuggestionCell(withDelimiter, 1, 0)!.editable).toBe(true);
  });

  test('whole-cell deletion cannot remove the final bare single-field row', () => {
    for (const source of ['id\r\n42', '\ufeffid\r\n42', '42']) {
      const record = source.includes('\n') ? 1 : 0;
      const { cell, model } = cellModel(source, record, 0);
      const start = cell.segments[0]!.start;
      const end = cell.segments[cell.segments.length - 1]!.end;
      expect(model.replace(start, end, '', 'csv-bare')).toMatchObject({
        kind: 'refused',
        code: 'not-editable',
      });
      expect(model.draft).toBeNull();
    }
    for (const source of ['id\r\n42\r\n', 'id,value\r\nx,42']) {
      const { cell, model } = cellModel(
        source,
        1,
        source.includes(',') ? 1 : 0
      );
      expect(
        model.replace(
          cell.segments[0]!.start,
          cell.segments[0]!.end,
          '',
          'csv-bare'
        ).kind
      ).toBe('changed');
    }
  });

  test('refuses to remove a physical line from an LF quoted cell', () => {
    const { table, cell, model } = cellModel(
      'name,note\nAda,"first\nsecond"\n',
      1,
      1
    );
    const start = cell.segments[0]!.start;
    const end = cell.segments[cell.segments.length - 1]!.end;
    expect(cell.editable).toBe(true);
    expect(
      model.replace(start, end, 'single line', 'csv-quoted')
    ).toMatchObject({
      kind: 'refused',
      code: 'newline-here',
    });
    expect(model.draft).toBeNull();
    expect(encodeTableSuggestion(table, cell, 'one\ntwo', start, end)).toEqual({
      ok: true,
      source: 'one\ntwo',
    });
    expect(model.replace(start, start + 5, 'updated', 'csv-quoted').kind).toBe(
      'changed'
    );
  });
  test('maps BOM, CRLF and doubled quotes to source offsets', () => {
    const table = parse(TABLE_SUGGEST_CRLF);
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
    expect(
      encodeTableSuggestion(
        table,
        cell,
        'say "hi"',
        cell.segments[0]!.start,
        cell.segments[0]!.start
      )
    ).toEqual({
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
      expect(
        encodeTableSuggestion(
          table,
          cell,
          'x',
          cell.segments[0]!.start,
          cell.segments[0]!.start
        ).ok
      ).toBe(false);
    }
  });

  test('refuses delimiters, quote and line breaks in bare cells and tab in TSV', () => {
    const table = parse('a,b\r\nx,y\r\n');
    const bare = tableSuggestionCell(table, 1, 0)!;
    for (const text of [',', '"', '\n', '\r'])
      expect(
        encodeTableSuggestion(
          table,
          bare,
          text,
          bare.segments[0]!.start,
          bare.segments[0]!.start
        ).ok
      ).toBe(false);
    const tsv = parse('a\tb\n"x"\ty\n', '\t');
    const quoted = tableSuggestionCell(tsv, 1, 0)!;
    expect(
      encodeTableSuggestion(
        tsv,
        quoted,
        '\t',
        quoted.segments[0]!.start,
        quoted.segments[0]!.start
      ).ok
    ).toBe(false);
    expect(
      encodeTableSuggestion(
        table,
        bare,
        'safe',
        bare.segments[0]!.start,
        bare.segments[0]!.start
      )
    ).toEqual({
      ok: true,
      source: 'safe',
    });
  });
});
