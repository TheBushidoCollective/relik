import { indexZip, type ZipIndex } from './zip-index.ts';
import type { InflaterFn } from './otio-types.ts';
import { tokenizeSpreadsheetXml, type XmlEvents } from './xlsx-xml.ts';
import { numberKind, type NumberKind } from './xlsx-number.ts';
import { parseWorksheet } from './xlsx-sheet.ts';

export interface CellDetail {
  readonly formula?: string;
  readonly sharedFrom?: string;
  readonly type: 'number' | 'text' | 'date' | 'percent' | 'boolean' | 'error';
}
export interface WorkbookSheet {
  readonly name: string;
  readonly state: 'visible' | 'hidden' | 'veryHidden';
  readonly kind: 'worksheet' | 'chartsheet';
  readonly rows: number;
  readonly columns: number;
  readonly refused?: 'too-large';
  readonly rowStart: Uint32Array;
  readonly cells: Uint32Array;
  readonly numbers: Float64Array;
  readonly texts: string[];
  readonly details: CellDetail[];
}
export interface Workbook {
  readonly sheets: WorkbookSheet[];
  readonly date1904: boolean;
}
export type WorkbookResult =
  | { readonly ok: true; readonly workbook: Workbook }
  | {
      readonly ok: false;
      readonly reason: 'corrupt' | 'unsupported' | 'too-large';
    };
export const XLSX_LIMITS = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
} as const;
export const XLSX_CELL_LIMIT = 5_000_000;
export const XLSX_ROW_LIMIT = 600_000;
export const XLSX_SHEET_LIMIT = 256;
export const XLSX_STRING_LIMIT = 2_000_000;

export function local(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}
function attrsValue(
  attrs: ReadonlyMap<string, string>,
  name: string
): string | undefined {
  return attrs.get(name);
}
function xmlEvents(
  start: XmlEvents['start'],
  end: XmlEvents['end'] = () => {},
  text: XmlEvents['text'] = () => {}
): XmlEvents {
  return { start, end, text };
}
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function read(index: ZipIndex, path: string): Promise<string> {
  const result = await index.read(path);
  if (!result.ok)
    throw new Error(
      result.reason === 'entry-too-large' || result.reason === 'total-too-large'
        ? 'too-large'
        : 'corrupt'
    );
  return decode(result.bytes);
}
function targetPath(target: string): string {
  if (
    target.includes('\\') ||
    target.includes('?') ||
    target.includes('#') ||
    /^[a-z]+:/i.test(target)
  )
    throw new Error('corrupt');
  const pieces: string[] = [];
  for (const part of (target.startsWith('/')
    ? target.slice(1)
    : `xl/${target}`
  ).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!pieces.length) throw new Error('corrupt');
      pieces.pop();
    } else pieces.push(part);
  }
  return pieces.join('/');
}
interface Relationship {
  path: string;
  kind: string;
}
interface SheetSpec {
  name: string;
  state: WorkbookSheet['state'];
  id: string;
}

/** Parse XLSX without evaluating formulas, following external links, or using DOMParser. */
export async function parseXlsx(
  bytes: Uint8Array,
  inflater?: InflaterFn
): Promise<WorkbookResult> {
  try {
    const indexed = await indexZip(bytes, XLSX_LIMITS, inflater);
    if (!indexed.ok)
      return {
        ok: false,
        reason: [
          'total-too-large',
          'entry-too-large',
          'too-many-entries',
          'directory-too-large',
        ].includes(indexed.reason)
          ? 'too-large'
          : 'corrupt',
      };
    const index = indexed.index;
    const relationships = new Map<string, Relationship>();
    tokenizeSpreadsheetXml(
      await read(index, 'xl/_rels/workbook.xml.rels'),
      xmlEvents((name, attrs) => {
        if (local(name) !== 'Relationship') return;
        const id = attrsValue(attrs, 'Id'),
          target = attrsValue(attrs, 'Target'),
          type = attrsValue(attrs, 'Type');
        if (!id || !target || !type || relationships.has(id))
          throw new Error('corrupt');
        if (attrs.get('TargetMode') === 'External') return;
        relationships.set(id, {
          path: targetPath(target),
          kind: type.slice(type.lastIndexOf('/') + 1),
        });
      })
    );
    let date1904 = false;
    const sheets: SheetSpec[] = [],
      seen = new Set<string>();
    tokenizeSpreadsheetXml(
      await read(index, 'xl/workbook.xml'),
      xmlEvents((name, attrs) => {
        if (local(name) === 'workbookPr')
          date1904 =
            attrs.get('date1904') === '1' || attrs.get('date1904') === 'true';
        if (local(name) !== 'sheet') return;
        const sheetName = attrs.get('name'),
          id = attrs.get('r:id');
        const state = attrs.get('state') ?? 'visible';
        if (
          !sheetName ||
          !id ||
          !['visible', 'hidden', 'veryHidden'].includes(state) ||
          seen.has(sheetName.toLowerCase())
        )
          throw new Error('corrupt');
        seen.add(sheetName.toLowerCase());
        sheets.push({
          name: sheetName,
          id,
          state: state as SheetSpec['state'],
        });
        if (sheets.length > XLSX_SHEET_LIMIT) throw new Error('too-large');
      })
    );
    if (!sheets.length) throw new Error('corrupt');
    const byKind = (kind: string): Relationship | undefined =>
      [...relationships.values()].find((r) => r.kind === kind);
    const strings: string[] = [];
    const shared = byKind('sharedStrings');
    if (shared) {
      let inItem = false,
        inText = false,
        text = '';
      tokenizeSpreadsheetXml(
        await read(index, shared.path),
        xmlEvents(
          (name) => {
            const n = local(name);
            if (n === 'si') {
              inItem = true;
              text = '';
            } else if (inItem && n === 't') inText = true;
          },
          (name) => {
            const n = local(name);
            if (n === 't') inText = false;
            else if (n === 'si') {
              strings.push(text);
              inItem = false;
              if (strings.length > XLSX_STRING_LIMIT)
                throw new Error('too-large');
            }
          },
          (value) => {
            if (inText) text += value;
          }
        )
      );
    }
    const formats = new Map<number, string>();
    const styles: NumberKind[] = [];
    const styleRel = byKind('styles');
    if (styleRel) {
      let inCellXfs = false;
      tokenizeSpreadsheetXml(
        await read(index, styleRel.path),
        xmlEvents(
          (name, attrs) => {
            const n = local(name);
            if (n === 'numFmt') {
              const id = Number(attrs.get('numFmtId'));
              const code = attrs.get('formatCode');
              if (Number.isInteger(id) && code !== undefined)
                formats.set(id, code);
            } else if (n === 'cellXfs') inCellXfs = true;
            else if (n === 'xf' && inCellXfs) {
              const id = Number(attrs.get('numFmtId') ?? '0');
              styles.push(numberKind(id, formats.get(id)));
            }
          },
          (name) => {
            if (local(name) === 'cellXfs') inCellXfs = false;
          }
        )
      );
    }
    const result: WorkbookSheet[] = [];
    let totalCells = 0;
    for (const spec of sheets) {
      const rel = relationships.get(spec.id);
      if (!rel || (rel.kind !== 'worksheet' && rel.kind !== 'chartsheet'))
        throw new Error('corrupt');
      if (rel.kind === 'chartsheet') {
        result.push({
          name: spec.name,
          state: spec.state,
          kind: 'chartsheet',
          rows: 0,
          columns: 0,
          rowStart: new Uint32Array(1),
          cells: new Uint32Array(),
          numbers: new Float64Array(),
          texts: [],
          details: [],
        });
      } else {
        const parsed = parseWorksheet(await read(index, rel.path), {
          name: spec.name,
          state: spec.state,
          sharedStrings: strings,
          styles,
          date1904,
          remaining: XLSX_CELL_LIMIT - totalCells,
        });
        totalCells += parsed.cellCount;
        result.push(parsed.sheet);
      }
    }
    return { ok: true, workbook: { sheets: result, date1904 } };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message === 'too-large'
          ? 'too-large'
          : 'corrupt',
    };
  }
}
