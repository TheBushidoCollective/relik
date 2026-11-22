/**
 * Cell comparison for two parsed workbooks (spec B5 section 3.1, XLSX row).
 *
 * Cells are compared by A1 position inside each paired sheet, with no row or
 * column alignment: a row inserted early reads as every later cell changed. A
 * cell is filled when it has display text or a formula. Values and formulas
 * are compared as text, and no formula is ever evaluated.
 */
import { TABLE_DRAWN_COLUMN_LIMIT } from './csv.ts';
import type { Workbook, WorkbookSheet } from './xlsx.ts';

/** Parsed cells per version, enforced during parse through `parseXlsx`'s `cellLimit`. */
export const XLSX_COMPARE_CELL_LIMIT = 2_000_000;
/** Bytes per version. Equal to the viewer's `MAX_DIFF_BYTES`, which its test asserts. */
export const XLSX_COMPARE_MAX_BYTES = 16 * 1024 * 1024;
/** Changes listed per sheet, in row-major order. */
export const XLSX_LISTED_CELL_CHANGES = 200;
/** Characters of cell text listed before a cut. A cut text ends with an ellipsis. */
export const XLSX_LISTED_TEXT_CHARS = 160;

/** The kind codes stored in `SheetComparison.positions`. */
export const CELL_KIND = {
  added: 1,
  removed: 2,
  changed: 3,
  formula: 4,
} as const;
export type CellKind = keyof typeof CELL_KIND;

export interface CellChange {
  /** Zero-based. */
  readonly row: number;
  /** Zero-based. */
  readonly col: number;
  readonly kind: CellKind;
  /** What the cell showed before, or its formula when nothing was shown. Empty when added. */
  readonly before: string;
  /** What the cell shows after. Empty when removed. */
  readonly after: string;
}

export interface SheetComparison {
  readonly status:
    | 'unchanged'
    | 'changed'
    | 'added'
    | 'removed'
    | 'not-compared';
  /** Index into `before.sheets`, when the sheet exists in the before version. */
  readonly before?: number;
  /** Index into `after.sheets`, when the sheet exists in the after version. */
  readonly after?: number;
  /** The before name, when the sheet was renamed. */
  readonly renamedFrom?: string;
  /** Both visibility states, for a sheet paired across the two versions. */
  readonly state?: {
    readonly before: WorkbookSheet['state'];
    readonly after: WorkbookSheet['state'];
  };
  /** Why cells are not compared: a chart, or more rows than the limit. */
  readonly notCompared?: 'chartsheet' | 'too-large';
  readonly added: number;
  readonly removed: number;
  /** Value changes, not counting formula-only changes. */
  readonly changed: number;
  /** Formula-only changes: the displayed value is equal and the formula is not. */
  readonly formula: number;
  /** `[row, col, kind]` triples in row-major order, for the drawn columns only. */
  readonly positions: Uint32Array;
  /** The first changes in row-major order, at most `XLSX_LISTED_CELL_CHANGES`. */
  readonly listed: readonly CellChange[];
}

export interface WorkbookComparison {
  readonly sheets: readonly SheetComparison[];
  readonly changed: boolean;
  /** Paired sheets only. `changed` includes formula-only changes. */
  readonly cells: { added: number; removed: number; changed: number };
  readonly sheetsAdded: number;
  readonly sheetsRemoved: number;
  readonly sheetsRenamed: number;
  readonly sheetsHidden: number;
  readonly sheetsShown: number;
}

interface CellWalk {
  readonly same: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly formula: number;
  readonly positions: Uint32Array;
  readonly listed: readonly CellChange[];
}

interface Pairing {
  /** For each before sheet, the after sheet it pairs with, or -1. */
  readonly ofBefore: Int32Array;
  /** For each after sheet, the before sheet it pairs with, or -1. */
  readonly ofAfter: Int32Array;
  /** Walks found while pairing by `sheetId`, keyed by after index. */
  readonly walks: Map<number, CellWalk>;
}

/** Why cells are not compared for these sheets. A chart outranks an oversize sheet. */
function notComparedFor(
  sheets: readonly WorkbookSheet[]
): 'chartsheet' | 'too-large' | undefined {
  if (sheets.some((sheet) => sheet.kind === 'chartsheet')) return 'chartsheet';
  if (sheets.some((sheet) => sheet.refused !== undefined)) return 'too-large';
  return undefined;
}

/** A cell with display text or a formula. Any other cell is not part of the sheet. */
function filled(sheet: WorkbookSheet, cell: number): boolean {
  return (
    sheet.texts[sheet.cells[cell * 3 + 1]!] !== '' ||
    sheet.details[sheet.cells[cell * 3 + 2]! - 1]!.formula !== undefined
  );
}

/**
 * What a listed change shows for one cell: its formula with `=` when
 * `asFormula` is set, otherwise its display text, or its formula when the cell
 * displays nothing. A shared formula names the cell it is shared from, so two
 * rows with the same formula text still read as different. Formulas are shown
 * as text and never evaluated.
 */
function shownText(
  sheet: WorkbookSheet,
  cell: number,
  asFormula: boolean
): string {
  const text = sheet.texts[sheet.cells[cell * 3 + 1]!] ?? '';
  const { formula, sharedFrom } =
    sheet.details[sheet.cells[cell * 3 + 2]! - 1]!;
  if (formula === undefined) return text;
  if (!asFormula && text !== '') return text;
  return sharedFrom === undefined
    ? `=${formula}`
    : `=${formula} (shared from ${sharedFrom})`;
}

/** Cuts listed text to `XLSX_LISTED_TEXT_CHARS` code points, so no surrogate pair is split. */
function listedText(text: string): string {
  let end = 0;
  for (let n = 0; n < XLSX_LISTED_TEXT_CHARS && end < text.length; n++)
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  return end < text.length ? `${text.slice(0, end)}…` : text;
}

/**
 * Walks two readable sheets row by row, then column by column, and records
 * each changed cell. Rows and columns are sorted by the parser, so this is one
 * merge with no allocation per cell.
 */
function walkCells(before: WorkbookSheet, after: WorkbookSheet): CellWalk {
  const counts = { same: 0, added: 0, removed: 0, changed: 0, formula: 0 };
  let positions = new Uint32Array(3 * 64);
  let triples = 0;
  const listed: CellChange[] = [];
  const record = (
    row: number,
    col: number,
    kind: CellKind,
    beforeCell: number,
    afterCell: number
  ): void => {
    counts[kind]++;
    if (col < TABLE_DRAWN_COLUMN_LIMIT) {
      if (triples * 3 === positions.length) {
        const grown = new Uint32Array(Math.max(positions.length * 2, 3 * 64));
        grown.set(positions);
        positions = grown;
      }
      positions[triples * 3] = row;
      positions[triples * 3 + 1] = col;
      positions[triples * 3 + 2] = CELL_KIND[kind];
      triples++;
    }
    if (listed.length < XLSX_LISTED_CELL_CHANGES) {
      const asFormula = kind === 'formula';
      listed.push({
        row,
        col,
        kind,
        before:
          beforeCell < 0
            ? ''
            : listedText(shownText(before, beforeCell, asFormula)),
        after:
          afterCell < 0
            ? ''
            : listedText(shownText(after, afterCell, asFormula)),
      });
    }
  };
  const beforeRows = before.rowNumbers.length;
  const afterRows = after.rowNumbers.length;
  let i = 0;
  let j = 0;
  while (i < beforeRows || j < afterRows) {
    const rowB =
      i < beforeRows ? before.rowNumbers[i]! : Number.POSITIVE_INFINITY;
    const rowA =
      j < afterRows ? after.rowNumbers[j]! : Number.POSITIVE_INFINITY;
    if (rowB < rowA) {
      for (let k = before.rowStart[i]!; k < before.rowStart[i + 1]!; k++)
        if (filled(before, k))
          record(rowB, before.cells[k * 3]!, 'removed', k, -1);
      i++;
    } else if (rowA < rowB) {
      for (let k = after.rowStart[j]!; k < after.rowStart[j + 1]!; k++)
        if (filled(after, k)) record(rowA, after.cells[k * 3]!, 'added', -1, k);
      j++;
    } else {
      let p = before.rowStart[i]!;
      const pEnd = before.rowStart[i + 1]!;
      let q = after.rowStart[j]!;
      const qEnd = after.rowStart[j + 1]!;
      while (p < pEnd || q < qEnd) {
        const colB = p < pEnd ? before.cells[p * 3]! : Number.POSITIVE_INFINITY;
        const colA = q < qEnd ? after.cells[q * 3]! : Number.POSITIVE_INFINITY;
        if (colB < colA) {
          if (filled(before, p)) record(rowB, colB, 'removed', p, -1);
          p++;
        } else if (colA < colB) {
          if (filled(after, q)) record(rowB, colA, 'added', -1, q);
          q++;
        } else {
          const wasFilled = filled(before, p);
          const nowFilled = filled(after, q);
          if (wasFilled && nowFilled) {
            const was = before.details[before.cells[p * 3 + 2]! - 1]!;
            const now = after.details[after.cells[q * 3 + 2]! - 1]!;
            if (
              before.texts[before.cells[p * 3 + 1]!] !==
              after.texts[after.cells[q * 3 + 1]!]
            )
              record(rowB, colB, 'changed', p, q);
            else if (
              was.formula !== now.formula ||
              was.sharedFrom !== now.sharedFrom
            )
              record(rowB, colB, 'formula', p, q);
            else counts.same++;
          } else if (wasFilled) record(rowB, colB, 'removed', p, -1);
          else if (nowFilled) record(rowB, colB, 'added', -1, q);
          p++;
          q++;
        }
      }
      i++;
      j++;
    }
  }
  return {
    same: counts.same,
    added: counts.added,
    removed: counts.removed,
    changed: counts.changed,
    formula: counts.formula,
    positions: positions.slice(0, triples * 3),
    listed,
  };
}

/**
 * Pairs sheets in this order: the same name; the same name ignoring case (a
 * rename); the same `sheetId` where at least half of the larger sheet's filled
 * cells are unchanged (a rename). Anything left is added or removed.
 */
function pairSheets(
  before: readonly WorkbookSheet[],
  after: readonly WorkbookSheet[]
): Pairing {
  const ofBefore = new Int32Array(before.length).fill(-1);
  const ofAfter = new Int32Array(after.length).fill(-1);
  const walks = new Map<number, CellWalk>();
  const link = (b: number, a: number): void => {
    ofBefore[b] = a;
    ofAfter[a] = b;
  };

  const exact = new Map<string, number>();
  for (let a = 0; a < after.length; a++) exact.set(after[a]!.name, a);
  for (let b = 0; b < before.length; b++) {
    const a = exact.get(before[b]!.name);
    if (a !== undefined && ofAfter[a] === -1) link(b, a);
  }

  const lower = new Map<string, number>();
  for (let a = 0; a < after.length; a++)
    if (ofAfter[a] === -1) lower.set(after[a]!.name.toLowerCase(), a);
  for (let b = 0; b < before.length; b++) {
    if (ofBefore[b] !== -1) continue;
    const a = lower.get(before[b]!.name.toLowerCase());
    if (a !== undefined && ofAfter[a] === -1) link(b, a);
  }

  const filledCounts = new Map<WorkbookSheet, number>();
  const filledIn = (sheet: WorkbookSheet): number => {
    let count = filledCounts.get(sheet);
    if (count === undefined) {
      count = 0;
      for (let cell = 0; cell < sheet.cells.length / 3; cell++)
        if (filled(sheet, cell)) count++;
      filledCounts.set(sheet, count);
    }
    return count;
  };
  for (let b = 0; b < before.length; b++) {
    const sheet = before[b]!;
    if (
      ofBefore[b] !== -1 ||
      sheet.kind !== 'worksheet' ||
      sheet.refused !== undefined ||
      sheet.sheetId === undefined
    )
      continue;
    const sheetFilled = filledIn(sheet);
    let best: { readonly a: number; readonly walk: CellWalk } | undefined;
    for (let a = 0; a < after.length; a++) {
      const candidate = after[a]!;
      if (
        ofAfter[a] !== -1 ||
        candidate.kind !== 'worksheet' ||
        candidate.refused !== undefined ||
        candidate.sheetId !== sheet.sheetId
      )
        continue;
      const candidateFilled = filledIn(candidate);
      const larger = Math.max(sheetFilled, candidateFilled);
      if (2 * Math.min(sheetFilled, candidateFilled) < larger) continue;
      const walk = walkCells(sheet, candidate);
      if (2 * walk.same < larger) continue;
      if (best === undefined || walk.same > best.walk.same) best = { a, walk };
    }
    if (best !== undefined) {
      link(b, best.a);
      walks.set(best.a, best.walk);
    }
  }
  return { ofBefore, ofAfter, walks };
}

/** A sheet that exists in one version only. */
function lone(
  sheet: WorkbookSheet,
  side: 'before' | 'after',
  index: number
): SheetComparison {
  const notCompared = notComparedFor([sheet]);
  let status: SheetComparison['status'] =
    side === 'after' ? 'added' : 'removed';
  if (notCompared !== undefined) status = 'not-compared';
  return {
    status,
    ...(side === 'after' ? { after: index } : { before: index }),
    ...(notCompared === undefined ? {} : { notCompared }),
    added: 0,
    removed: 0,
    changed: 0,
    formula: 0,
    positions: new Uint32Array(0),
    listed: [],
  };
}

/**
 * Compares two parsed workbooks. Sheets are listed in the after version's
 * order, followed by the sheets only the before version has.
 */
export function compareWorkbooks(
  before: Workbook,
  after: Workbook
): WorkbookComparison {
  const { ofBefore, ofAfter, walks } = pairSheets(before.sheets, after.sheets);
  const sheets: SheetComparison[] = [];
  const cells = { added: 0, removed: 0, changed: 0 };
  const sheetCounts = { added: 0, removed: 0, renamed: 0, hidden: 0, shown: 0 };
  for (let a = 0; a < after.sheets.length; a++) {
    const current = after.sheets[a]!;
    const b = ofAfter[a]!;
    if (b === -1) {
      sheetCounts.added++;
      sheets.push(lone(current, 'after', a));
      continue;
    }
    const previous = before.sheets[b]!;
    const notCompared = notComparedFor([previous, current]);
    const walk =
      notCompared === undefined
        ? (walks.get(a) ?? walkCells(previous, current))
        : undefined;
    const renamed = previous.name !== current.name;
    const wasVisible = previous.state === 'visible';
    const isVisible = current.state === 'visible';
    const visibilityChanged = wasVisible !== isVisible;
    if (renamed) sheetCounts.renamed++;
    if (visibilityChanged && wasVisible) sheetCounts.hidden++;
    if (visibilityChanged && isVisible) sheetCounts.shown++;
    let status: SheetComparison['status'] = 'unchanged';
    if (notCompared !== undefined) status = 'not-compared';
    else if (
      renamed ||
      visibilityChanged ||
      (walk !== undefined &&
        walk.added + walk.removed + walk.changed + walk.formula > 0)
    )
      status = 'changed';
    if (walk !== undefined) {
      cells.added += walk.added;
      cells.removed += walk.removed;
      cells.changed += walk.changed + walk.formula;
    }
    sheets.push({
      status,
      before: b,
      after: a,
      ...(renamed ? { renamedFrom: previous.name } : {}),
      state: { before: previous.state, after: current.state },
      ...(notCompared === undefined ? {} : { notCompared }),
      added: walk?.added ?? 0,
      removed: walk?.removed ?? 0,
      changed: walk?.changed ?? 0,
      formula: walk?.formula ?? 0,
      positions: walk?.positions ?? new Uint32Array(0),
      listed: walk?.listed ?? [],
    });
  }
  for (let b = 0; b < before.sheets.length; b++) {
    if (ofBefore[b] !== -1) continue;
    sheetCounts.removed++;
    sheets.push(lone(before.sheets[b]!, 'before', b));
  }
  const cellChanges = cells.added + cells.removed + cells.changed;
  const sheetChanges =
    sheetCounts.added +
    sheetCounts.removed +
    sheetCounts.renamed +
    sheetCounts.hidden +
    sheetCounts.shown;
  return {
    sheets,
    changed: cellChanges > 0 || sheetChanges > 0,
    cells,
    sheetsAdded: sheetCounts.added,
    sheetsRemoved: sheetCounts.removed,
    sheetsRenamed: sheetCounts.renamed,
    sheetsHidden: sheetCounts.hidden,
    sheetsShown: sheetCounts.shown,
  };
}
