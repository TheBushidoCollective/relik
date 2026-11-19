import { describe, expect, test } from 'bun:test';
import {
  cellFlags,
  cellText,
  FIELD_QUOTED,
  FIELD_STRAY,
  isNumericText,
  numericValue,
  parseTable,
  recordWidth,
  TABLE_CELL_LIMIT,
  TABLE_ROW_LIMIT,
  utf8ByteLength,
  type CsvTable,
} from '../src/csv.ts';

/** The table a parse produced; throws if the text was refused. */
function table(
  text: string,
  delimiter?: ',' | ';' | '\t' | '|' | 'auto'
): CsvTable {
  const parsed = parseTable(text, delimiter === undefined ? {} : { delimiter });
  if (!parsed.ok) throw new Error(`expected a table, got ${parsed.reason}`);
  return parsed.table;
}

/** Every cell of a table as text, record by record. */
function grid(parsed: CsvTable): string[][] {
  const rows: string[][] = [];
  for (let r = 0; r < parsed.records; r++) {
    const row: string[] = [];
    for (let c = 0; c < recordWidth(parsed, r); c++) {
      row.push(cellText(parsed, r, c));
    }
    rows.push(row);
  }
  return rows;
}

describe('parseTable: RFC 4180 reading', () => {
  test('reads a plain comma file, record by record', () => {
    const parsed = table('name,qty\nbolt,4\nnut,12\n');
    expect(parsed.delimiter).toBe(',');
    expect(parsed.records).toBe(3);
    expect(parsed.columns).toBe(2);
    expect(grid(parsed)).toEqual([
      ['name', 'qty'],
      ['bolt', '4'],
      ['nut', '12'],
    ]);
  });

  test('a file with no trailing newline reads the same as one with it', () => {
    expect(grid(table('a,b\nc,d'))).toEqual(grid(table('a,b\nc,d\n')));
  });

  test('quoted fields keep delimiters, doubled quotes and line breaks', () => {
    const parsed = table('k,v\n"a, b","say ""hi"""\n"line 1\nline 2",x\n');
    expect(grid(parsed)).toEqual([
      ['k', 'v'],
      ['a, b', 'say "hi"'],
      ['line 1\nline 2', 'x'],
    ]);
    expect(cellFlags(parsed, 1, 0)).toBe(FIELD_QUOTED);
  });

  test('an empty quoted field is a field, not a missing one', () => {
    const parsed = table('a,"",c\n');
    expect(recordWidth(parsed, 0)).toBe(3);
    expect(cellText(parsed, 0, 1)).toBe('');
  });

  test('CRLF, LF and mixed line endings read the same records', () => {
    const lf = grid(table('a,b\nc,d\ne,f\n'));
    expect(grid(table('a,b\r\nc,d\r\ne,f\r\n'))).toEqual(lf);
    expect(grid(table('a,b\r\nc,d\ne,f\r'))).toEqual(lf);
  });

  test('a lone CR outside quotes ends a record, a CR inside quotes is kept', () => {
    const parsed = table('a,"x\ry"\rb,c');
    expect(parsed.records).toBe(2);
    expect(cellText(parsed, 0, 1)).toBe('x\ry');
    expect(cellText(parsed, 1, 0)).toBe('b');
  });

  test('a byte order mark is skipped and reported, never read as data', () => {
    const parsed = table('\uFEFFname,qty\nbolt,4\n');
    expect(parsed.bom).toBe(true);
    expect(cellText(parsed, 0, 0)).toBe('name');
    expect(parsed.records).toBe(2);
  });

  test('a blank line is a record, so record numbers are the file rows', () => {
    const parsed = table('a\n\nb\n');
    expect(parsed.records).toBe(3);
    expect(recordWidth(parsed, 1)).toBe(1);
    expect(cellText(parsed, 1, 0)).toBe('');
    expect(cellText(parsed, 2, 0)).toBe('b');
  });

  test('ragged rows render: a short record reads its missing cells as empty', () => {
    const parsed = table('a,b,c\n1\n4,5,6,7\n');
    expect(parsed.columns).toBe(4);
    expect(recordWidth(parsed, 1)).toBe(1);
    expect(cellText(parsed, 1, 2)).toBe('');
    expect(cellFlags(parsed, 1, 2)).toBe(0);
    expect(cellText(parsed, 2, 3)).toBe('7');
  });

  test('a quote inside an unquoted field is kept literally and flagged', () => {
    const parsed = table('a,5" pipe,c\n');
    expect(cellText(parsed, 0, 1)).toBe('5" pipe');
    expect(cellFlags(parsed, 0, 1) & FIELD_STRAY).toBe(FIELD_STRAY);
    expect(cellFlags(parsed, 0, 0)).toBe(0);
  });

  test('text after a closing quote is literal and flagged, never silently dropped', () => {
    const parsed = table('"ab"cd,e\n');
    expect(cellText(parsed, 0, 0)).toBe('"ab"cd');
    expect(cellFlags(parsed, 0, 0) & FIELD_STRAY).toBe(FIELD_STRAY);
    expect(cellText(parsed, 0, 1)).toBe('e');
  });

  test('a trailing delimiter makes an empty last field', () => {
    const parsed = table('a,b,\n');
    expect(recordWidth(parsed, 0)).toBe(3);
    expect(cellText(parsed, 0, 2)).toBe('');
  });

  test('offsets point at the raw field, so a later suggestion can locate it', () => {
    const text = 'x,"y,z",w\n';
    const parsed = table(text);
    expect(text.slice(parsed.fieldStart[1]!, parsed.fieldEnd[1]!)).toBe(
      '"y,z"'
    );
  });
});

describe('parseTable: delimiter choice', () => {
  test('a semicolon file with decimal commas is read by its semicolons', () => {
    const parsed = table('artikel;prijs;aantal\nbout;12,50;4\nmoer;0,75;12\n');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.columns).toBe(3);
    expect(cellText(parsed, 1, 1)).toBe('12,50');
  });

  test('a tab file is read by its tabs even when the text holds commas', () => {
    const parsed = table('name\tnote\nbolt\tsmall, steel\n');
    expect(parsed.delimiter).toBe('\t');
    expect(cellText(parsed, 1, 1)).toBe('small, steel');
  });

  test('a pipe file is found by sniffing', () => {
    expect(table('a|b|c\n1|2|3\n').delimiter).toBe('|');
  });

  test('a forced delimiter is used as given, even when another would fit better', () => {
    const parsed = table('a,b;c\n', '\t');
    expect(parsed.delimiter).toBe('\t');
    expect(recordWidth(parsed, 0)).toBe(1);
  });

  test('a file with no delimiter at all is one column', () => {
    const parsed = table('just some words\nand more\n');
    expect(parsed.columns).toBe(1);
    expect(parsed.records).toBe(2);
  });
});

describe('parseTable: refusals, not acceptances', () => {
  test('an unclosed quote is refused with the line it opened on', () => {
    expect(parseTable('a,b\nc,"never closed\nd,e\n')).toEqual({
      ok: false,
      reason: 'unclosed-quote',
      line: 2,
    });
  });

  test('an unclosed quote on a CRLF file counts each CRLF as one line', () => {
    expect(parseTable('a,b\r\nc,d\r\ne,"open\r\n')).toEqual({
      ok: false,
      reason: 'unclosed-quote',
      line: 3,
    });
  });

  test('a NUL byte refuses the file as binary', () => {
    expect(parseTable('a,b\0\n')).toEqual({ ok: false, reason: 'binary' });
  });

  test('an empty file, or one holding only a byte order mark, is refused as empty', () => {
    expect(parseTable('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseTable('\uFEFF')).toEqual({ ok: false, reason: 'empty' });
  });

  test('HTML in cells is data: it is text, and nothing here interprets it', () => {
    const parsed = table(
      'name,note\n<img src=x onerror=alert(1)>,"<script>x</script>"\n'
    );
    expect(cellText(parsed, 1, 0)).toBe('<img src=x onerror=alert(1)>');
    expect(cellText(parsed, 1, 1)).toBe('<script>x</script>');
  });

  test('a file over the byte limit is refused before any scan', () => {
    const text = 'a'.repeat(32 * 1024 * 1024 + 1);
    expect(parseTable(text)).toEqual({
      ok: false,
      reason: 'too-large',
      limit: 'bytes',
    });
  });

  test('a table over the cell limit is refused once it passes the limit', () => {
    // Ten columns a row keeps the row count under the row limit, so the cell
    // limit is the one that trips.
    const row = `${'a,'.repeat(9)}a\n`;
    const text = row.repeat(TABLE_CELL_LIMIT / 10 + 1);
    expect(parseTable(text)).toEqual({
      ok: false,
      reason: 'too-large',
      limit: 'cells',
    });
  });

  test('a table at exactly the cell limit is accepted', () => {
    const row = `${'a,'.repeat(9)}a\n`;
    const parsed = parseTable(row.repeat(TABLE_CELL_LIMIT / 10));
    expect(parsed.ok).toBe(true);
  });

  test('a table over the column limit is refused', () => {
    const text = `${'a,'.repeat(16_384)}a\n`;
    expect(parseTable(text)).toEqual({
      ok: false,
      reason: 'too-large',
      limit: 'columns',
    });
  });

  test('a table over the row limit is refused', () => {
    const text = 'a\n'.repeat(TABLE_ROW_LIMIT + 1);
    expect(parseTable(text)).toEqual({
      ok: false,
      reason: 'too-large',
      limit: 'rows',
    });
  });
});

describe('parseTable: pathological inputs are bounded, with timings recorded', () => {
  test('50,000 rows by 256 columns is 12.8 million cells: refused, and quickly', () => {
    // Single-character values keep the file under the byte limit, so the
    // cell limit is what refuses it.
    const row = `${'x,'.repeat(255)}x\n`;
    const text = row.repeat(50_000);
    const started = performance.now();
    const parsed = parseTable(text);
    const elapsed = performance.now() - started;
    console.log(`csv: 50,000x256 refused in ${elapsed.toFixed(1)} ms`);
    expect(parsed).toEqual({ ok: false, reason: 'too-large', limit: 'cells' });
    expect(elapsed).toBeLessThan(4000);
  });

  test('50,000 rows by 100 columns is exactly at the cell limit: read in full', () => {
    const row = Array.from({ length: 100 }, (_, c) => `v${c}`).join(',');
    const text = `${row}\n`.repeat(50_000);
    const started = performance.now();
    const parsed = parseTable(text);
    const elapsed = performance.now() - started;
    console.log(`csv: 50,000x100 read in ${elapsed.toFixed(1)} ms`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.table.records).toBe(50_000);
      expect(parsed.table.columns).toBe(100);
    }
    expect(elapsed).toBeLessThan(4000);
  });

  test('an unterminated quote at the start of a large file is refused after one scan', () => {
    const text = `"open\n${'x,y,z\n'.repeat(400_000)}`;
    const started = performance.now();
    const parsed = parseTable(text);
    const elapsed = performance.now() - started;
    console.log(
      `csv: unclosed quote over ${text.length} chars refused in ${elapsed.toFixed(1)} ms`
    );
    expect(parsed).toEqual({ ok: false, reason: 'unclosed-quote', line: 1 });
    expect(elapsed).toBeLessThan(4000);
  });

  test('a quote on every line pairs across lines and is flagged, never mis-split', () => {
    // `"a` opens, the next line's quote closes it, and the `a` after that
    // quote makes the field stray. Every record is still read, bounded.
    const parsed = parseTable('"a\n'.repeat(200_000));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.table.records).toBe(100_000);
      expect(cellFlags(parsed.table, 0, 0) & FIELD_STRAY).toBe(FIELD_STRAY);
    }
  });
});

describe('utf8ByteLength and number reading', () => {
  test('counts the bytes that encoding would produce, surrogate pairs included', () => {
    for (const sample of ['abc', 'é', '€', '😀', 'a😀é€']) {
      expect(utf8ByteLength(sample)).toBe(
        new TextEncoder().encode(sample).length
      );
    }
  });

  test('a number is a plain number, with an optional decimal comma', () => {
    expect(isNumericText('12')).toBe(true);
    expect(isNumericText('-3.5')).toBe(true);
    expect(isNumericText('12,50')).toBe(true);
    expect(isNumericText('1e3')).toBe(true);
    expect(isNumericText('')).toBe(false);
    expect(isNumericText('12 kg')).toBe(false);
    expect(isNumericText('$5')).toBe(false);
    expect(numericValue('12,50')).toBe(12.5);
  });
});
