import { FIELD_QUOTED, FIELD_STRAY, type CsvTable } from '@relic/format/csv';
import type { SourceSegment } from './markdown-source.ts';
import type { SuggestBlockKind, SuggestRefusal } from './suggest-draft.ts';
import type { SuggestionSurface } from './suggestion-surface.ts';

/** Source offsets are UTF-16 offsets into the source with its BOM removed. */
export interface TableSuggestionCell {
  readonly segments: readonly SourceSegment[];
  readonly kind: Extract<SuggestBlockKind, 'csv-quoted' | 'csv-bare'>;
  readonly editable: true | SuggestRefusal;
  readonly field: number;
}

const notEditable: SuggestRefusal = {
  kind: 'refused',
  code: 'not-editable',
  message: 'This cell cannot be edited safely.',
};
const bidi = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const carriageReturns = new WeakMap<CsvTable, readonly number[]>();

/** Translate a parser offset into the BOM-free, LF-normalized suggestion source. */
function suggestionOffset(table: CsvTable, offset: number): number {
  let positions = carriageReturns.get(table);
  if (!positions) {
    const found: number[] = [];
    for (
      let index = table.text.indexOf('\r');
      index >= 0;
      index = table.text.indexOf('\r', index + 1)
    ) {
      if (table.text[index + 1] === '\n') found.push(index);
    }
    positions = found;
    carriageReturns.set(table, positions);
  }
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid]! < offset) lo = mid + 1;
    else hi = mid;
  }
  return offset - (table.bom ? 1 : 0) - lo;
}

/** Map a physical record and column, independent of display sort order. */
export function tableSuggestionCell(
  table: CsvTable,
  record: number,
  column: number
): TableSuggestionCell | undefined {
  if (
    !Number.isInteger(record) ||
    !Number.isInteger(column) ||
    record < 0 ||
    record >= table.records ||
    column < 0
  )
    return undefined;
  const field = table.recordStart[record]! + column;
  if (field >= table.recordStart[record + 1]!) return undefined;
  const flags = table.fieldFlags[field]!;
  const quoted = (flags & FIELD_QUOTED) !== 0;
  const start = table.fieldStart[field]! + (quoted ? 1 : 0);
  const end = table.fieldEnd[field]! - (quoted ? 1 : 0);
  const raw = table.text.slice(start, end);
  const segments: SourceSegment[] = [];
  const add = (
    from: number,
    to: number,
    kind: SourceSegment['kind'],
    text: string
  ): void => {
    segments.push({
      text,
      start: suggestionOffset(table, from),
      end: suggestionOffset(table, to),
      block: field,
      kind,
    });
  };
  let pos = start;
  if (quoted) {
    while (pos < end) {
      const quote = table.text.indexOf('""', pos);
      if (quote < 0 || quote + 2 > end) break;
      if (quote > pos) add(pos, quote, 'text', table.text.slice(pos, quote));
      add(quote, quote + 2, 'escape', '"');
      pos = quote + 2;
    }
  }
  if (pos < end || segments.length === 0)
    add(pos, end, 'text', table.text.slice(pos, end));
  return {
    segments,
    kind: quoted ? 'csv-quoted' : 'csv-bare',
    editable:
      flags & FIELD_STRAY || raw.includes('\r') || bidi.test(raw)
        ? notEditable
        : true,
    field,
  };
}

/** Find the field containing a resolved edit without depending on display order. */
export function tableFieldAtRange(
  table: CsvTable,
  start: number,
  end: number
): number | undefined {
  let lo = 0;
  let hi = table.fieldStart.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (suggestionOffset(table, table.fieldStart[mid]!) <= start) lo = mid + 1;
    else hi = mid;
  }
  const field = lo - 1;
  if (field < 0) return undefined;
  const quoted = (table.fieldFlags[field]! & FIELD_QUOTED) !== 0;
  const from = suggestionOffset(
    table,
    table.fieldStart[field]! + (quoted ? 1 : 0)
  );
  const to = suggestionOffset(table, table.fieldEnd[field]! - (quoted ? 1 : 0));
  return start >= from && end >= start && end <= to ? field : undefined;
}

/** Anchor an empty field on its own quote or an adjacent field delimiter. */
export function emptyTableCellAnchor(
  table: CsvTable,
  cell: TableSuggestionCell,
  position: number
):
  | {
      readonly start: number;
      readonly end: number;
      readonly mode: 'before' | 'after';
    }
  | undefined {
  const segment = cell.segments[0];
  if (
    !segment ||
    cell.editable !== true ||
    segment.start !== segment.end ||
    position !== segment.start
  )
    return undefined;
  const shift = table.bom ? 1 : 0;
  const rawPosition = table.fieldStart[cell.field]!;
  if (cell.kind === 'csv-quoted') {
    return { start: position - 1, end: position, mode: 'after' };
  }
  if (table.text[rawPosition] === table.delimiter)
    return { start: position, end: position + 1, mode: 'before' };
  if (rawPosition > shift && table.text[rawPosition - 1] === table.delimiter)
    return { start: position - 1, end: position, mode: 'after' };
  return undefined;
}

/** Encode visible insertion text without creating a new field or record. */
export function encodeTableSuggestion(
  table: CsvTable,
  cell: TableSuggestionCell,
  text: string
):
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly refusal: SuggestRefusal } {
  if (cell.editable !== true) return { ok: false, refusal: cell.editable };
  const refuse = (
    code: 'delimiter-in-cell' | 'quote-in-cell',
    message: string
  ) => ({
    ok: false as const,
    refusal: { kind: 'refused' as const, code, message },
  });
  if (table.delimiter === '\t' && text.includes('\t'))
    return refuse('delimiter-in-cell', 'A tab would split this cell.');
  if (cell.kind === 'csv-quoted')
    return { ok: true, source: text.replaceAll('"', '""') };
  if (text.includes(table.delimiter) || /[\r\n]/.test(text))
    return refuse(
      'delimiter-in-cell',
      'The delimiter or line break would split this cell.'
    );
  if (text.includes('"'))
    return refuse(
      'quote-in-cell',
      'A quote cannot be inserted in an unquoted cell.'
    );
  return { ok: true, source: text };
}

/** A single-cell editor remains mounted while the virtual table redraws. */
export function tableCellSurface(
  table: CsvTable,
  cell: TableSuggestionCell,
  root: HTMLElement
): SuggestionSurface {
  const render = (): void => {
    const spans = cell.segments.map((segment, index) => {
      const span = root.ownerDocument.createElement('span');
      span.dataset['seg'] = String(index);
      span.append(root.ownerDocument.createTextNode(segment.text));
      return span;
    });
    root.replaceChildren(...spans);
  };
  render();
  return {
    root,
    clipPaint: true,
    segments: () => cell.segments,
    blockKind: () => cell.kind,
    editable: () => cell.editable,
    acceptsSelection: (node) =>
      root.contains(node) ? cell.editable : notEditable,
    encode: (_block, text) => encodeTableSuggestion(table, cell, text),
    decode: (_block, source) =>
      cell.kind === 'csv-quoted' ? source.replaceAll('""', '"') : source,
    emptyAnchor: (_block, position) =>
      emptyTableCellAnchor(table, cell, position),
    repaint: render,
  };
}
