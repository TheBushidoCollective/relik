import type { CellDetail, WorkbookSheet } from './xlsx.ts';
import { tokenizeSpreadsheetXml } from './xlsx-xml.ts';
import { displayNumber, type NumberKind } from './xlsx-number.ts';

interface SheetOptions {
  name: string;
  state: WorkbookSheet['state'];
  sharedStrings: string[];
  styles: NumberKind[];
  date1904: boolean;
  remaining: number;
  textPool?: { texts: string[]; index: Map<string, number> };
  remainingDetailBytes?: number;
}
interface Cell {
  column: number;
  type: string;
  style: number;
  value: string;
  inline: string;
  formula: string;
  valueSeen: boolean;
  formulaSeen: boolean;
  inlineContainerSeen: boolean;
  inlinePlainSeen: boolean;
  inlineRichSeen: boolean;
  inlineRunTextSeen: boolean;
  formulaKind?: string | undefined;
  sharedId?: string | undefined;
  reference: string;
}
function coordinate(ref: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
  if (!match) throw new Error('corrupt');
  let col = 0;
  for (const ch of match[1]!) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (col > 16384 || row > 1048576) throw new Error('corrupt');
  return { row, column: col - 1 };
}
function cellReference(row: number, column: number): string {
  let n = column + 1;
  let letters = '';
  while (n > 0) {
    n--;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return `${letters}${row}`;
}

/** Read one sheet at a time, retaining only typed-array cells and interned text. */
export function parseWorksheet(
  xml: string,
  options: SheetOptions
): { sheet: WorkbookSheet; cellCount: number; detailBytes: number } {
  let capacity = 256,
    count = 0,
    rows = 0,
    columns = 0,
    row = 0,
    lastColumn = -1,
    populatedRows = 0,
    rowFirst = 0;
  let cells = new Uint32Array(capacity * 3),
    numbers = new Float64Array(capacity);
  let rowCapacity = 256;
  let rowNumbers = new Uint32Array(rowCapacity);
  let starts = new Uint32Array(rowCapacity + 1);
  const path: string[] = [];
  const { texts, index: textIndex } = options.textPool ?? {
    texts: [],
    index: new Map<string, number>(),
  };
  const details: CellDetail[] = [],
    detailIndex = new Map<string, number>();
  const masters = new Map<string, { formula: string; ref: string }>();
  const sharedDetails = new Map<string, number>();
  let detailBytes = 0;
  let current: Cell | undefined,
    capture: 'v' | 't' | 'f' | undefined,
    captureDepth = 0,
    refused = false;
  const intern = (value: string): number => {
    const old = textIndex.get(value);
    if (old !== undefined) return old;
    const n = texts.length;
    texts.push(value);
    textIndex.set(value, n);
    return n;
  };
  const detail = (value: CellDetail): number => {
    const key = JSON.stringify(value),
      old = detailIndex.get(key);
    if (old !== undefined) return old + 1;
    const n = details.length;
    detailBytes += key.length * 2;
    if (detailBytes > (options.remainingDetailBytes ?? 16 * 1024 * 1024))
      throw new Error('too-large');
    details.push(value);
    detailIndex.set(key, n);
    return n + 1;
  };
  const finishCell = (): void => {
    const cell = current;
    if (!cell) throw new Error('corrupt');
    if (++count > options.remaining) throw new Error('too-large');
    if (refused) {
      current = undefined;
      return;
    }
    if (count > capacity) {
      capacity = Math.min(options.remaining, capacity * 2);
      const nextCells = new Uint32Array(capacity * 3);
      nextCells.set(cells);
      cells = nextCells;
      const nextNumbers = new Float64Array(capacity);
      nextNumbers.set(numbers);
      numbers = nextNumbers;
    }
    let text = '',
      numeric = Number.NaN;
    let type: CellDetail['type'] = 'text';
    if (cell.type === 's') {
      if (
        !/^\d+$/.test(cell.value) ||
        Number(cell.value) >= options.sharedStrings.length
      )
        throw new Error('corrupt');
      text = options.sharedStrings[Number(cell.value)]!;
    } else if (cell.type === 'inlineStr') text = cell.inline;
    else if (cell.type === 'str' || cell.type === 'd') {
      text = cell.value;
      type = cell.type === 'd' ? 'date' : 'text';
    } else if (cell.type === 'b') {
      if (
        (cell.value === '' && cell.valueSeen) ||
        (cell.value !== '' && cell.value !== '0' && cell.value !== '1')
      )
        throw new Error('corrupt');
      text = cell.value === '' ? '' : cell.value === '1' ? 'TRUE' : 'FALSE';
      type = 'boolean';
    } else if (cell.type === 'e') {
      text = cell.value;
      type = 'error';
    } else if (cell.type === 'n' || cell.type === '') {
      if (cell.value !== '') {
        numeric = Number(cell.value);
        if (!Number.isFinite(numeric)) throw new Error('corrupt');
        type = options.styles[cell.style] ?? 'number';
        text = displayNumber(numeric, type, options.date1904);
      } else {
        type = 'number';
      }
    } else throw new Error('corrupt');
    const formula = cell.formula || undefined;
    let detailId: number | undefined;
    if (cell.formulaKind === 'shared' && cell.sharedId !== undefined) {
      if (formula) {
        if (masters.has(cell.sharedId)) throw new Error('corrupt');
        masters.set(cell.sharedId, { formula, ref: cell.reference });
      } else {
        const master = masters.get(cell.sharedId);
        if (!master) throw new Error('corrupt');
        const key = `${cell.sharedId}:${type}`;
        detailId = sharedDetails.get(key);
        if (detailId === undefined) {
          detailId = detail({
            type,
            formula: master.formula,
            sharedFrom: master.ref,
          });
          sharedDetails.set(key, detailId);
        }
      }
    }
    const i = count - 1;
    cells[i * 3] = cell.column;
    cells[i * 3 + 1] = intern(text);
    cells[i * 3 + 2] =
      detailId ?? detail({ type, ...(formula ? { formula } : {}) });
    numbers[i] = numeric;
    current = undefined;
  };
  tokenizeSpreadsheetXml(xml, {
    start(name, attrs, namespaces) {
      const split = name.indexOf(':');
      const prefix = split < 0 ? '' : name.slice(0, split);
      const uri = namespaces.get(prefix);
      if (prefix && uri === undefined) throw new Error('corrupt');
      const local = split < 0 ? name : name.slice(split + 1);
      const allowed =
        uri === 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' ||
        uri === 'http://purl.oclc.org/ooxml/spreadsheetml/main';
      const n = allowed ? local : `!${local}`;
      path.push(n);
      if (capture !== undefined) throw new Error('corrupt');
      if (path.length === 1 && n !== 'worksheet') throw new Error('corrupt');
      if (n === 'row' && path.join('/') === 'worksheet/sheetData/row') {
        const next = attrs.has('r') ? Number(attrs.get('r')) : row + 1;
        if (!Number.isInteger(next) || next <= row || next > 1048576)
          throw new Error('corrupt');
        row = next;
        rows = Math.max(rows, row);
        lastColumn = -1;
        if (row > 600000) refused = true;
        rowFirst = count;
      } else if (n === 'c' && path.join('/') === 'worksheet/sheetData/row/c') {
        if (current) throw new Error('corrupt');
        const ref = attrs.get('r') ?? '';
        const pos = ref ? coordinate(ref) : { row, column: lastColumn + 1 };
        if (pos.row !== row || pos.column <= lastColumn || pos.column >= 16384)
          throw new Error('corrupt');
        lastColumn = pos.column;
        columns = Math.max(columns, pos.column + 1);
        const style = Number(attrs.get('s') ?? '0');
        if (!Number.isInteger(style) || style < 0) throw new Error('corrupt');
        current = {
          column: pos.column,
          type: attrs.get('t') ?? '',
          style,
          value: '',
          inline: '',
          formula: '',
          valueSeen: false,
          formulaSeen: false,
          inlineContainerSeen: false,
          inlinePlainSeen: false,
          inlineRichSeen: false,
          inlineRunTextSeen: false,
          reference: ref || cellReference(row, pos.column),
        };
      } else if (current && path.join('/') === 'worksheet/sheetData/row/c/is') {
        if (current.inlineContainerSeen) throw new Error('corrupt');
        current.inlineContainerSeen = true;
      } else if (
        current &&
        path.join('/') === 'worksheet/sheetData/row/c/is/r'
      ) {
        if (current.inlinePlainSeen) throw new Error('corrupt');
        current.inlineRichSeen = true;
        current.inlineRunTextSeen = false;
      } else if (
        current &&
        (((n === 'v' || n === 'f') &&
          path.join('/') === `worksheet/sheetData/row/c/${n}`) ||
          (n === 't' &&
            (path.join('/') === 'worksheet/sheetData/row/c/is/t' ||
              path.join('/') === 'worksheet/sheetData/row/c/is/r/t')))
      ) {
        if (n === 'v') {
          if (current.valueSeen) throw new Error('corrupt');
          current.valueSeen = true;
        } else if (n === 'f') {
          if (current.formulaSeen) throw new Error('corrupt');
          current.formulaSeen = true;
        } else if (n === 't') {
          if (path.join('/') === 'worksheet/sheetData/row/c/is/t') {
            if (current.inlinePlainSeen || current.inlineRichSeen)
              throw new Error('corrupt');
            current.inlinePlainSeen = true;
          } else {
            if (current.inlinePlainSeen || current.inlineRunTextSeen)
              throw new Error('corrupt');
            current.inlineRunTextSeen = true;
          }
        }
        capture = n;
        captureDepth = path.length;
        if (n === 'f') {
          current.formulaKind = attrs.get('t');
          current.sharedId = attrs.get('si');
        }
      }
    },
    end(name) {
      const n = name.slice(name.lastIndexOf(':') + 1);
      const joined = path.join('/');
      if (
        (n === 'v' || n === 't' || n === 'f') &&
        capture === n &&
        captureDepth === path.length
      )
        capture = undefined;
      else if (joined === 'worksheet/sheetData/row/c') finishCell();
      else if (
        joined === 'worksheet/sheetData/row' &&
        !refused &&
        count > rowFirst
      ) {
        if (populatedRows === rowCapacity) {
          rowCapacity *= 2;
          const nextRows = new Uint32Array(rowCapacity);
          nextRows.set(rowNumbers);
          rowNumbers = nextRows;
          const nextStarts = new Uint32Array(rowCapacity + 1);
          nextStarts.set(starts);
          starts = nextStarts;
        }
        rowNumbers[populatedRows] = row - 1;
        starts[++populatedRows] = count;
      }
      path.pop();
    },
    text(value) {
      if (!current) return;
      if (capture === 'v') current.value += value;
      else if (capture === 't') current.inline += value;
      else if (capture === 'f') {
        if (current.formula.length + value.length > 65_536)
          throw new Error('too-large');
        current.formula += value;
      }
    },
  });
  if (current) throw new Error('corrupt');
  if (refused)
    return {
      cellCount: count,
      detailBytes: 0,
      sheet: {
        name: options.name,
        state: options.state,
        kind: 'worksheet',
        rows,
        columns,
        refused: 'too-large',
        rowNumbers: new Uint32Array(),
        rowStart: new Uint32Array(1),
        cells: new Uint32Array(),
        numbers: new Float64Array(),
        texts: [],
        details: [],
      },
    };
  return {
    cellCount: count,
    detailBytes,
    sheet: {
      name: options.name,
      state: options.state,
      kind: 'worksheet',
      rows,
      columns,
      rowNumbers: rowNumbers.slice(0, populatedRows),
      rowStart: starts.slice(0, populatedRows + 1),
      cells: cells.slice(0, count * 3),
      numbers: numbers.slice(0, count),
      texts,
      details,
    },
  };
}
