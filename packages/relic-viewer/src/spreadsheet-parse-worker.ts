/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { isRecord } from '@relic/format';
import { parseXlsx } from '@relic/format/xlsx';

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (
    !isRecord(request) ||
    request.type !== 'parse' ||
    !(request.bytes instanceof ArrayBuffer)
  )
    return;
  const result = await parseXlsx(new Uint8Array(request.bytes));
  if (!result.ok) {
    self.postMessage(result);
    return;
  }
  const transfers: Transferable[] = [];
  for (const sheet of result.workbook.sheets) {
    transfers.push(
      sheet.rowNumbers.buffer as ArrayBuffer,
      sheet.rowStart.buffer as ArrayBuffer,
      sheet.cells.buffer as ArrayBuffer,
      sheet.numbers.buffer as ArrayBuffer
    );
  }
  self.postMessage(result, transfers);
});
