/**
 * `cell` anchors on a spreadsheet (plan section 5, MCP side). The viewer writes
 * a sheet's name and the A1 coordinates it draws, and this resolver reads the
 * same cells through `parseXlsx`, the parser the viewer's worker runs.
 *
 * Read-only. A cell reports the value the file caches, never the result of a
 * formula, and no external link or connection is opened: the parser skips
 * external relationships and reads only the parts the workbook names. Every
 * limit is the parser's own, so a workbook it refuses is not resolved either.
 *
 * The parse runs on the MCP's main thread, where the viewer runs it in a worker,
 * so a large workbook holds the event loop while it parses. The limits are the
 * viewer's, the parse is cached per decrypted version, and it cannot be
 * interrupted. That is accepted for now; running it in a worker with a deadline
 * is the follow-up.
 */

import type { CellCommentAnchor } from '@relic/format';
import {
  parseXlsx,
  type WorkbookResult,
  worksheetCellIndex,
  XLSX_ROW_LIMIT,
} from '@relic/format/xlsx';
import { cellName } from './comments.ts';
import { nodeInflater } from './node-inflater.ts';
import {
  type CellResolution,
  CELL_HEADER_LIMIT_BYTES,
  CELL_TEXT_LIMIT_BYTES,
  capBytes,
} from './resolve-structured.ts';
import { jsonLine } from './untrusted-text.ts';

const workbooks = new WeakMap<Uint8Array, Promise<WorkbookResult>>();

/** One parse per decrypted version, shared by every comment on that version. */
function workbookFor(content: Uint8Array): Promise<WorkbookResult> {
  let pending = workbooks.get(content);
  if (pending === undefined) {
    pending = parseXlsx(content, nodeInflater);
    workbooks.set(content, pending);
  }
  return pending;
}

function notFound(why: string): CellResolution {
  return {
    kind: 'cell',
    status: 'unresolvable',
    explanation: `The cell is not found in this version: ${why}`,
  };
}

/** Resolves one spreadsheet cell or range against the workbook it was written on. */
export async function resolveWorkbookCell(
  content: Uint8Array,
  anchor: CellCommentAnchor
): Promise<CellResolution> {
  if (anchor.sheet === undefined) {
    return notFound(
      'a cell on a spreadsheet names its sheet, and this one does not.'
    );
  }
  const parsed = await workbookFor(content);
  if (!parsed.ok) {
    return notFound(
      parsed.reason === 'too-large'
        ? 'the spreadsheet is over a size limit.'
        : 'the spreadsheet cannot be read.'
    );
  }
  const sheet = parsed.workbook.sheets.find(
    (candidate) => candidate.name === anchor.sheet
  );
  if (sheet === undefined) {
    return notFound(
      `this workbook has no sheet named ${jsonLine(anchor.sheet)}.`
    );
  }
  if (sheet.kind === 'chartsheet') {
    return notFound(
      `sheet ${jsonLine(sheet.name)} is a chart sheet, which has no cells.`
    );
  }
  if (sheet.refused !== undefined) {
    return notFound(
      `sheet ${jsonLine(sheet.name)} has more than ${XLSX_ROW_LIMIT} rows, so its cells are not read.`
    );
  }

  const endRow = anchor.row_end ?? anchor.row;
  const endCol = anchor.col_end ?? anchor.col;
  const where = `sheet ${jsonLine(sheet.name)}`;
  if (endRow < anchor.row || endCol < anchor.col) {
    return notFound('the range ends before it starts.');
  }
  if (anchor.row > sheet.rows) {
    return notFound(
      `row ${anchor.row} is past the last row of ${where}, which has ${sheet.rows} row(s).`
    );
  }
  if (endRow > sheet.rows) {
    return notFound(
      `the range runs to row ${endRow}, past the last row of ${where}, which has ${sheet.rows} row(s).`
    );
  }
  if (anchor.col > sheet.columns) {
    return notFound(
      `column ${anchor.col} is past the last column of ${where}, which has ${sheet.columns} column(s).`
    );
  }
  if (endCol > sheet.columns) {
    return notFound(
      `the range runs to column ${endCol}, past the last column of ${where}, which has ${sheet.columns} column(s).`
    );
  }

  // Coordinates are 1-based A1 positions; the parser's indices are zero-based.
  const valueAt = (row: number, column: number): string => {
    const index = worksheetCellIndex(sheet, row - 1, column - 1);
    return index < 0 ? '' : (sheet.texts[sheet.cells[index * 3 + 1]!] ?? '');
  };
  const text = capBytes(valueAt(anchor.row, anchor.col), CELL_TEXT_LIMIT_BYTES);
  const header = capBytes(valueAt(1, anchor.col), CELL_HEADER_LIMIT_BYTES);
  return {
    kind: 'cell',
    status: 'resolved',
    sheet: sheet.name,
    address: cellName(anchor.row, anchor.col),
    text: text.text,
    text_truncated: text.truncated,
    header: header.text,
    header_truncated: header.truncated,
    ...(anchor.row_end === undefined && anchor.col_end === undefined
      ? {}
      : { range: { row_end: endRow, col_end: endCol } }),
  };
}
