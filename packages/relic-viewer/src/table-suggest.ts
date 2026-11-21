import { FIELD_QUOTED, FIELD_STRAY, type CsvTable } from '@relic/format/csv';
import type { SourceSegment } from './markdown-source.ts';
import type { SuggestBlockKind, SuggestRefusal } from './suggest-draft.ts';

/** Source mapping for one existing field. Offsets exclude the file's BOM. */
export interface TableSuggestionCell {
  readonly segments: readonly SourceSegment[];
  readonly kind: Extract<SuggestBlockKind, 'csv-quoted' | 'csv-bare'>;
  readonly editable: true | SuggestRefusal;
}

const notEditable: SuggestRefusal = {
  kind: 'refused',
  code: 'not-editable',
  message: 'This cell cannot be edited safely.',
};

const bidi = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

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
  const shift = table.bom ? 1 : 0;
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
      start: from - shift,
      end: to - shift,
      block: field,
      kind,
    });
  };
  let pos = start;
  if (quoted) {
    while (pos < end) {
      const quote = table.text.indexOf('""', pos);
      if (quote < 0 || quote >= end) break;
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
  };
}
