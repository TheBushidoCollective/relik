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

/** Posts one reply, moving the buffers in `transfers` to the page rather than copying them. */
type Post = (message: unknown, transfers?: Transferable[]) => void;

/**
 * Checks both versions, then parses and compares them. A version that cannot
 * be checked or read is refused with its side named, and the other is not parsed.
 */
async function compareVersions(
  request: Record<string, unknown>,
  post: Post
): Promise<void> {
  const before = checkedVersion(request['before']);
  if (typeof before === 'string') {
    post({ ok: false, side: 'before', reason: before });
    return;
  }
  const after = checkedVersion(request['after']);
  if (typeof after === 'string') {
    post({ ok: false, side: 'after', reason: after });
    return;
  }
  const options = { cellLimit: XLSX_COMPARE_CELL_LIMIT };
  const parsedBefore = await parseXlsx(
    new Uint8Array(before),
    undefined,
    options
  );
  if (!parsedBefore.ok) {
    post({ ok: false, side: 'before', reason: parsedBefore.reason });
    return;
  }
  const parsedAfter = await parseXlsx(
    new Uint8Array(after),
    undefined,
    options
  );
  if (!parsedAfter.ok) {
    post({ ok: false, side: 'after', reason: parsedAfter.reason });
    return;
  }
  const comparison = compareWorkbooks(
    parsedBefore.workbook,
    parsedAfter.workbook
  );
  const transfers = sheetBuffers([parsedBefore.workbook, parsedAfter.workbook]);
  for (const sheet of comparison.sheets)
    transfers.push(sheet.positions.buffer as ArrayBuffer);
  post(
    {
      ok: true,
      before: parsedBefore.workbook,
      after: parsedAfter.workbook,
      comparison,
    },
    transfers
  );
}

/**
 * Answers one request. A throw while answering, such as an allocation that
 * fails or a reply the page cannot receive, becomes a corrupt reply with no
 * side. Without that the page would learn of the failure only from its timeout.
 */
export async function answer(request: unknown, post: Post): Promise<void> {
  if (!isRecord(request)) return;
  try {
    if (request.type === 'compare') return await compareVersions(request, post);
    if (request.type !== 'parse' || !(request.bytes instanceof ArrayBuffer))
      return;
    const result = await parseXlsx(new Uint8Array(request.bytes));
    if (result.ok) post(result, sheetBuffers([result.workbook]));
    else post(result);
  } catch {
    post({ ok: false, reason: 'corrupt' });
  }
}

self.addEventListener('message', (event: MessageEvent<unknown>) =>
  answer(event.data, (message, transfers) =>
    self.postMessage(message, transfers ?? [])
  )
);
