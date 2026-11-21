/**
 * Reads `.csv` and `.tsv` text into a table (plan A1, sections 3 and 4).
 *
 * RFC 4180, with the reader's own rules where the RFC is silent:
 *
 * - CRLF, LF and a lone CR outside quotes each end a record, so a file with
 *   mixed line endings reads the same as one with a single kind.
 * - By default a leading byte order mark is skipped and reported. Set
 *   `skipBom: false` when a decoder has already removed the file's BOM.
 * - A blank line is a record of one empty field. Record numbers are therefore
 *   the file's own row numbers, which is what a cell comment's `row` means.
 * - A quoted field may hold delimiters, quotes (doubled) and line breaks.
 * - A quote that appears inside an unquoted field, or that is followed by
 *   other text after its closing quote, is kept literally and flagged.
 *
 * The table keeps offsets, not copies. Each field is a span of the source text
 * plus two flags, so a 32 MiB file costs its text and three typed arrays, and
 * a value is decoded only when a view asks for it.
 *
 * Every scan is bounded: the byte, cell, column and row limits stop it early,
 * and an unclosed quote is refused with the line it opened on. Parsing never
 * throws on input; a refusal is a value the caller can show.
 */

/** A file larger than this, in UTF-8 bytes, is not read as a table. */
export const TABLE_BYTE_LIMIT = 32 * 1024 * 1024;
/** A table with more fields than this is not read as a table. */
export const TABLE_CELL_LIMIT = 5_000_000;
/** A table wider than this is not read as a table. */
export const TABLE_COLUMN_LIMIT = 16_384;
/**
 * A table with more records than this is not read as a table. Browsers cap an
 * element's height (Firefox at about 17.9 million pixels), and a table's scroll
 * height is its row count times the row height. 600,000 rows at 28 pixels is
 * 16.8 million pixels, under that cap in every browser the viewer supports.
 */
export const TABLE_ROW_LIMIT = 600_000;
/** Columns past this are not drawn; the rest of the file stays in the source. */
export const TABLE_DRAWN_COLUMN_LIMIT = 256;

/** The field was quoted, so its text is the span between the quotes, unescaped. */
export const FIELD_QUOTED = 1;
/** The field has a quote the reader could not place, so its text is literal. */
export const FIELD_STRAY = 2;

export type TableDelimiter = ',' | ';' | '\t' | '|';

const CANDIDATES: readonly TableDelimiter[] = [',', ';', '\t', '|'];

const DOUBLE_QUOTE = 34;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/** A parsed table. Field `f` of record `r` spans `recordStart[r] + f`. */
export interface CsvTable {
  /** The source text as read, byte order mark included. Spans index into it. */
  readonly text: string;
  readonly delimiter: TableDelimiter;
  readonly bom: boolean;
  /** Records, including a header record and blank lines. */
  readonly records: number;
  /** The widest record's field count. */
  readonly columns: number;
  /** Length `records + 1`; the fields of record `r` are `[recordStart[r], recordStart[r + 1])`. */
  readonly recordStart: Uint32Array;
  /** Raw start of each field, inclusive, quote included. */
  readonly fieldStart: Uint32Array;
  /** Raw end of each field, exclusive, quote included. */
  readonly fieldEnd: Uint32Array;
  /** `FIELD_QUOTED` and `FIELD_STRAY` bits per field. */
  readonly fieldFlags: Uint8Array;
}

export type TableParseFailure =
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'binary' }
  | {
      readonly ok: false;
      readonly reason: 'unclosed-quote';
      /** The line the quote opened on, counted from 1. */
      readonly line: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'too-large';
      readonly limit: 'bytes' | 'cells' | 'columns' | 'rows';
    };

export type TableParse =
  | { readonly ok: true; readonly table: CsvTable }
  | TableParseFailure;

export interface ParseTableOptions {
  /** A delimiter to use as given, or `'auto'` to choose from the text. */
  readonly delimiter?: TableDelimiter | 'auto';
  /** Set false when a decoder already removed the file's BOM. */
  readonly skipBom?: boolean;
}

/** A growable typed array, so a 5,000,000-field scan does not box every number. */
class Growable<T extends Uint32Array | Uint8Array> {
  #buffer: T;
  #length = 0;

  constructor(
    private readonly make: (size: number) => T,
    initial: number
  ) {
    this.#buffer = make(initial);
  }

  push(value: number): void {
    if (this.#length === this.#buffer.length) {
      const next = this.make(this.#buffer.length * 2);
      next.set(this.#buffer);
      this.#buffer = next;
    }
    this.#buffer[this.#length++] = value;
  }

  get length(): number {
    return this.#length;
  }

  /** The filled prefix, sized exactly; a copy only when the buffer has slack. */
  finish(): T {
    return this.#buffer.length === this.#length
      ? this.#buffer
      : (this.#buffer.slice(0, this.#length) as T);
  }
}

/** UTF-8 length of a string, counted without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** 1-based line number of the character at `index`. LF, CRLF and a lone CR each end a line. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    const code = text.charCodeAt(i);
    if (code === LINE_FEED) line++;
    else if (code === CARRIAGE_RETURN && text.charCodeAt(i + 1) !== LINE_FEED)
      line++;
  }
  return line;
}

/**
 * Field counts for the records in `[start, end)`, for one candidate delimiter.
 * Quotes are toggled on every `"`, which is exact for RFC 4180 because a doubled
 * quote toggles twice. Used only to choose a delimiter.
 */
function fieldCounts(
  text: string,
  start: number,
  end: number,
  delimiter: number
): number[] {
  const counts: number[] = [];
  let inQuotes = false;
  let width = 1;
  let open = false;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === DOUBLE_QUOTE) {
      inQuotes = !inQuotes;
      open = true;
    } else if (!inQuotes && code === delimiter) {
      width++;
      open = true;
    } else if (!inQuotes && (code === LINE_FEED || code === CARRIAGE_RETURN)) {
      if (code === CARRIAGE_RETURN && text.charCodeAt(i + 1) === LINE_FEED) i++;
      counts.push(width);
      width = 1;
      open = false;
    } else {
      open = true;
    }
  }
  if (open) counts.push(width);
  return counts;
}

/**
 * The delimiter whose field count agrees across the most records. A candidate
 * that splits every record the same way more than once wins. Ties go to the
 * earlier candidate, so `,` wins a file where nothing decides.
 */
function sniffDelimiter(text: string, start: number): TableDelimiter {
  const end = Math.min(text.length, start + 64 * 1024);
  let best: TableDelimiter = ',';
  let bestScore = 0;
  for (const candidate of CANDIDATES) {
    const counts = fieldCounts(text, start, end, candidate.charCodeAt(0));
    const frequency = new Map<number, number>();
    for (const count of counts) {
      if (count > 1) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    }
    let score = 0;
    for (const n of frequency.values()) score = Math.max(score, n);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** The delimiter an auto-detected table would use for this source. */
export function detectTableDelimiter(
  text: string,
  skipBom = true
): TableDelimiter {
  return sniffDelimiter(text, skipBom && text.charCodeAt(0) === 0xfeff ? 1 : 0);
}

type ScanOutcome =
  | {
      readonly ok: true;
      readonly recordStart: Uint32Array;
      readonly fieldStart: Uint32Array;
      readonly fieldEnd: Uint32Array;
      readonly fieldFlags: Uint8Array;
      readonly columns: number;
    }
  | TableParseFailure;

/** Scans the records from `start`. The only function that reads field boundaries. */
function scan(text: string, start: number, delimiter: string): ScanOutcome {
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  const recordStart = new Growable(
    (size) => new Uint32Array(size),
    Math.max(16, Math.ceil(n / 64))
  );
  const fieldStart = new Growable(
    (size) => new Uint32Array(size),
    Math.max(64, Math.ceil(n / 16))
  );
  const fieldEnd = new Growable(
    (size) => new Uint32Array(size),
    Math.max(64, Math.ceil(n / 16))
  );
  const fieldFlags = new Growable(
    (size) => new Uint8Array(size),
    Math.max(64, Math.ceil(n / 16))
  );
  let columns = 0;
  let pos = start;

  do {
    recordStart.push(fieldStart.length);
    let width = 0;
    for (;;) {
      const fs = pos;
      let fe: number;
      let flags = 0;
      if (pos < n && text.charCodeAt(pos) === DOUBLE_QUOTE) {
        let j = pos + 1;
        let closeAt = -1;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) break;
          if (q + 1 < n && text.charCodeAt(q + 1) === DOUBLE_QUOTE) {
            j = q + 2;
            continue;
          }
          closeAt = q;
          break;
        }
        if (closeAt < 0) {
          return {
            ok: false,
            reason: 'unclosed-quote',
            line: lineOf(text, pos),
          };
        }
        const after = closeAt + 1;
        if (after >= n || isBoundary(text.charCodeAt(after), d)) {
          fe = after;
          flags = FIELD_QUOTED;
        } else {
          // Text after the closing quote: the whole field is literal.
          let k = after;
          while (k < n && !isBoundary(text.charCodeAt(k), d)) k++;
          fe = k;
          flags = FIELD_STRAY;
        }
      } else {
        let k = pos;
        while (k < n) {
          const code = text.charCodeAt(k);
          if (isBoundary(code, d)) break;
          if (code === DOUBLE_QUOTE) flags |= FIELD_STRAY;
          k++;
        }
        fe = k;
      }
      pos = fe;
      fieldStart.push(fs);
      fieldEnd.push(fe);
      fieldFlags.push(flags);
      width++;
      if (fieldStart.length > TABLE_CELL_LIMIT) {
        return { ok: false, reason: 'too-large', limit: 'cells' };
      }
      if (pos >= n) break;
      const code = text.charCodeAt(pos);
      if (code === d) {
        pos++;
        continue;
      }
      if (code === CARRIAGE_RETURN) {
        pos++;
        if (pos < n && text.charCodeAt(pos) === LINE_FEED) pos++;
        break;
      }
      // Only a line feed is left: the boundary check admits no other character.
      pos++;
      break;
    }
    if (width > columns) columns = width;
    if (columns > TABLE_COLUMN_LIMIT) {
      return { ok: false, reason: 'too-large', limit: 'columns' };
    }
    if (recordStart.length > TABLE_ROW_LIMIT) {
      return { ok: false, reason: 'too-large', limit: 'rows' };
    }
  } while (pos < n);

  recordStart.push(fieldStart.length);
  return {
    ok: true,
    recordStart: recordStart.finish(),
    fieldStart: fieldStart.finish(),
    fieldEnd: fieldEnd.finish(),
    fieldFlags: fieldFlags.finish(),
    columns,
  };
}

function isBoundary(code: number, delimiter: number): boolean {
  return code === delimiter || code === LINE_FEED || code === CARRIAGE_RETURN;
}

/**
 * Reads CSV or TSV text. Returns a table, or the reason it cannot be shown as
 * one. Never throws, whatever the text holds.
 */
export function parseTable(
  text: string,
  options: ParseTableOptions = {}
): TableParse {
  const bom = options.skipBom !== false && text.charCodeAt(0) === 0xfeff;
  const start = bom ? 1 : 0;
  if (start >= text.length) return { ok: false, reason: 'empty' };
  if (text.indexOf('\0') >= 0) return { ok: false, reason: 'binary' };
  if (utf8ByteLength(text) > TABLE_BYTE_LIMIT) {
    return { ok: false, reason: 'too-large', limit: 'bytes' };
  }
  const requested = options.delimiter ?? 'auto';
  const delimiter =
    requested === 'auto' ? sniffDelimiter(text, start) : requested;
  const outcome = scan(text, start, delimiter);
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    table: {
      text,
      delimiter,
      bom,
      records: outcome.recordStart.length - 1,
      columns: outcome.columns,
      recordStart: outcome.recordStart,
      fieldStart: outcome.fieldStart,
      fieldEnd: outcome.fieldEnd,
      fieldFlags: outcome.fieldFlags,
    },
  };
}

/** Fields in a record. A ragged record has fewer than `table.columns`. */
export function recordWidth(table: CsvTable, record: number): number {
  return table.recordStart[record + 1]! - table.recordStart[record]!;
}

/**
 * The index of a cell's field, or `-1` when the record is shorter than the
 * column, which is how a ragged row reads a missing cell.
 */
function fieldIndex(table: CsvTable, record: number, column: number): number {
  if (record < 0 || record >= table.records || column < 0) return -1;
  const field = table.recordStart[record]! + column;
  return field < table.recordStart[record + 1]! ? field : -1;
}

/** The decoded text of a cell. A missing cell reads as the empty string. */
export function cellText(
  table: CsvTable,
  record: number,
  column: number
): string {
  const field = fieldIndex(table, record, column);
  if (field < 0) return '';
  const start = table.fieldStart[field]!;
  const end = table.fieldEnd[field]!;
  const flags = table.fieldFlags[field]!;
  if (flags & FIELD_QUOTED) {
    return table.text.slice(start + 1, end - 1).replaceAll('""', '"');
  }
  return table.text.slice(start, end);
}

/** The `FIELD_*` flags of a cell, or `0` for a missing cell. */
export function cellFlags(
  table: CsvTable,
  record: number,
  column: number
): number {
  const field = fieldIndex(table, record, column);
  return field < 0 ? 0 : table.fieldFlags[field]!;
}

/** Whether a cell's text is a plain number: an optional sign, digits, an optional fraction with `.` or `,`, and an optional exponent. */
export function isNumericText(value: string): boolean {
  return /^[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}

/** The value of a number written by {@link isNumericText}, with `,` read as the decimal separator. */
export function numericValue(value: string): number {
  return Number(value.replace(',', '.'));
}

const DELIMITER_NAMES: Readonly<Record<TableDelimiter, string>> = {
  ',': 'comma-separated',
  ';': 'semicolon-separated',
  '\t': 'tab-separated',
  '|': 'pipe-separated',
};

/** A name for a delimiter, for the summary line a reader sees. */
export function delimiterName(delimiter: TableDelimiter): string {
  return DELIMITER_NAMES[delimiter];
}
