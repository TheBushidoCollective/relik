import type { CellDetail, WorkbookSheet } from './xlsx.ts';
import { tokenizeSpreadsheetXml } from './xlsx-xml.ts';
import { displayNumber, type NumberKind } from './xlsx-number.ts';
import { translateSharedFormula } from './xlsx-formula.ts';

interface SheetOptions {
  name: string;
  state: WorkbookSheet['state'];
  sharedStrings: string[];
  styles: NumberKind[];
  date1904: boolean;
  remaining: number;
}
interface Cell {
  column: number;
  type: string;
  style: number;
  value: string;
  inline: string;
  formula: string;
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

/** Read one sheet at a time, retaining only typed-array cells and interned text. */
export function parseWorksheet(
  xml: string,
  options: SheetOptions
): { sheet: WorkbookSheet; cellCount: number } {
  let capacity = 256,
    count = 0,
    rows = 0,
    columns = 0,
    row = 0,
    lastColumn = -1,
    filledRow = 0;
  let cells = new Uint32Array(capacity * 3),
    numbers = new Float64Array(capacity);
  const starts = new Uint32Array(600001);
  const texts: string[] = [],
    textIndex = new Map<string, number>();
  const details: CellDetail[] = [],
    detailIndex = new Map<string, number>();
  const masters = new Map<string, { formula: string; ref: string }>();
  let current: Cell | undefined,
    capture: 'v' | 't' | 'f' | undefined,
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
      if (cell.value !== '0' && cell.value !== '1') throw new Error('corrupt');
      text = cell.value === '1' ? 'TRUE' : 'FALSE';
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
    let formula = cell.formula || undefined,
      sharedFrom: string | undefined;
    if (cell.formulaKind === 'shared' && cell.sharedId !== undefined) {
      if (formula) masters.set(cell.sharedId, { formula, ref: cell.reference });
      else {
        const master = masters.get(cell.sharedId);
        if (!master) throw new Error('corrupt');
        formula = translateSharedFormula(
          master.formula,
          master.ref,
          cell.reference
        );
        sharedFrom = master.ref;
      }
    }
    const i = count - 1;
    cells[i * 3] = cell.column;
    cells[i * 3 + 1] = intern(text);
    cells[i * 3 + 2] = detail({
      type,
      ...(formula ? { formula } : {}),
      ...(sharedFrom ? { sharedFrom } : {}),
    });
    numbers[i] = numeric;
    current = undefined;
  };
  tokenizeSpreadsheetXml(xml, {
    start(name, attrs) {
      const n = name.slice(name.lastIndexOf(':') + 1);
      if (n === 'row') {
        const next = attrs.has('r') ? Number(attrs.get('r')) : row + 1;
        if (!Number.isInteger(next) || next <= row || next > 1048576)
          throw new Error('corrupt');
        row = next;
        rows = Math.max(rows, row);
        lastColumn = -1;
        if (row > 600000) refused = true;
        if (!refused) while (filledRow < row - 1) starts[++filledRow] = count;
      } else if (n === 'c') {
        if (current || row === 0) throw new Error('corrupt');
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
          reference: ref,
        };
      } else if (current && (n === 'v' || n === 't' || n === 'f')) {
        capture = n;
        if (n === 'f') {
          current.formulaKind = attrs.get('t');
          current.sharedId = attrs.get('si');
        }
      }
    },
    end(name) {
      const n = name.slice(name.lastIndexOf(':') + 1);
      if (n === 'v' || n === 't' || n === 'f') capture = undefined;
      else if (n === 'c') finishCell();
      else if (n === 'row' && !refused) starts[++filledRow] = count;
    },
    text(value) {
      if (!current) return;
      if (capture === 'v') current.value += value;
      else if (capture === 't') current.inline += value;
      else if (capture === 'f') current.formula += value;
    },
  });
  if (current) throw new Error('corrupt');
  if (refused)
    return {
      cellCount: count,
      sheet: {
        name: options.name,
        state: options.state,
        kind: 'worksheet',
        rows,
        columns,
        refused: 'too-large',
        rowStart: new Uint32Array(1),
        cells: new Uint32Array(),
        numbers: new Float64Array(),
        texts: [],
        details: [],
      },
    };
  return {
    cellCount: count,
    sheet: {
      name: options.name,
      state: options.state,
      kind: 'worksheet',
      rows,
      columns,
      rowStart: starts.slice(0, rows + 1),
      cells: cells.slice(0, count * 3),
      numbers: numbers.slice(0, count),
      texts,
      details,
    },
  };
}
