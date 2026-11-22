/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { isRecord } from '@relic/format';
import { parseXlsx, type Workbook } from '@relic/format/xlsx';
import {
  compareWorkbooks,
  XLSX_COMPARE_CELL_LIMIT,
  XLSX_COMPARE_MAX_BYTES,
} from '@relic/format/xlsx-diff';

/** Every sheet buffer of these workbooks, so a reply moves them rather than copies them. */
function sheetBuffers(workbooks: readonly Workbook[]): Transferable[] {
  const transfers: Transferable[] = [];
  for (const workbook of workbooks)
    for (const sheet of workbook.sheets)
      transfers.push(
        sheet.rowNumbers.buffer as ArrayBuffer,
        sheet.rowStart.buffer as ArrayBuffer,
        sheet.cells.buffer as ArrayBuffer,
        sheet.numbers.buffer as ArrayBuffer
      );
  return transfers;
}

/** The version's bytes when they are an ArrayBuffer within the comparison limit, or why not. */
function checkedVersion(value: unknown): ArrayBuffer | 'corrupt' | 'too-large' {
  if (!(value instanceof ArrayBuffer)) return 'corrupt';
  return value.byteLength > XLSX_COMPARE_MAX_BYTES ? 'too-large' : value;
}

/**
 * Checks both versions, then parses and compares them. A version that cannot
 * be checked or read is refused with its side named, and the other is not parsed.
 */
async function compareVersions(
  request: Record<string, unknown>
): Promise<void> {
  const before = checkedVersion(request['before']);
  if (typeof before === 'string') {
    self.postMessage({ ok: false, side: 'before', reason: before });
    return;
  }
  const after = checkedVersion(request['after']);
  if (typeof after === 'string') {
    self.postMessage({ ok: false, side: 'after', reason: after });
    return;
  }
  const options = { cellLimit: XLSX_COMPARE_CELL_LIMIT };
  const parsedBefore = await parseXlsx(
    new Uint8Array(before),
    undefined,
    options
  );
  if (!parsedBefore.ok) {
    self.postMessage({
      ok: false,
      side: 'before',
      reason: parsedBefore.reason,
    });
    return;
  }
  const parsedAfter = await parseXlsx(
    new Uint8Array(after),
    undefined,
    options
  );
  if (!parsedAfter.ok) {
    self.postMessage({ ok: false, side: 'after', reason: parsedAfter.reason });
    return;
  }
  const comparison = compareWorkbooks(
    parsedBefore.workbook,
    parsedAfter.workbook
  );
  const transfers = sheetBuffers([parsedBefore.workbook, parsedAfter.workbook]);
  for (const sheet of comparison.sheets)
    transfers.push(sheet.positions.buffer as ArrayBuffer);
  self.postMessage(
    {
      ok: true,
      before: parsedBefore.workbook,
      after: parsedAfter.workbook,
      comparison,
    },
    transfers
  );
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isRecord(request)) return;
  if (request.type === 'compare') return compareVersions(request);
  if (request.type !== 'parse' || !(request.bytes instanceof ArrayBuffer))
    return;
  const result = await parseXlsx(new Uint8Array(request.bytes));
  if (!result.ok) {
    self.postMessage(result);
    return;
  }
  self.postMessage(result, sheetBuffers([result.workbook]));
});
