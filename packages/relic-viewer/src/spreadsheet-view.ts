import { parseWritableCommentAnchor, type CommentAnchor } from '@relic/format';
import type {
  Workbook,
  WorkbookResult,
  WorkbookSheet,
} from '@relic/format/xlsx';
import { worksheetRowIndex } from '@relic/format/xlsx';
import { drawnColumnCount, markFits, mountDataTable } from './data-table.ts';
import {
  registerStructuredHandle,
  type StructuredPart,
  type StructuredViewHandle,
} from './structured-view-bridge.ts';
import type { TableSource } from './table-source.ts';
import { visibleLabel } from './visible-label.ts';
import { DOCUMENT_RENDER_LIMIT_BYTES } from './content.ts';
import type { ReadyView } from './viewer.ts';

const EMPTY_COLUMNS: readonly number[] = [];

export function sourceFor(sheet: WorkbookSheet): TableSource {
  function index(row: number, column: number): number {
    const rowIndex = worksheetRowIndex(sheet, row);
    if (rowIndex < 0) return -1;
    let low = sheet.rowStart[rowIndex] ?? 0,
      high = sheet.rowStart[rowIndex + 1] ?? low;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (sheet.cells[mid * 3]! < column) low = mid + 1;
      else high = mid;
    }
    return low < (sheet.rowStart[rowIndex + 1] ?? 0) &&
      sheet.cells[low * 3] === column
      ? low
      : -1;
  }
  let numericKinds: { all: Uint8Array; body: Uint8Array } | undefined;
  let cachedNeedle = '';
  let matchesByText = new Uint8Array(0);
  return {
    numericColumn(column, headerRow) {
      if (!numericKinds) {
        const all = new Uint8Array(sheet.columns);
        const body = new Uint8Array(sheet.columns);
        for (let r = 0; r < sheet.rowNumbers.length; r++) {
          for (let i = sheet.rowStart[r]!; i < sheet.rowStart[r + 1]!; i++) {
            const col = sheet.cells[i * 3]!;
            if ((sheet.texts[sheet.cells[i * 3 + 1]!] ?? '') === '') continue;
            const bit = Number.isNaN(sheet.numbers[i]!) ? 2 : 1;
            all[col] = all[col]! | bit;
            if (sheet.rowNumbers[r] !== 0) body[col] = body[col]! | bit;
          }
        }
        numericKinds = { all, body };
      }
      return (
        (headerRow ? numericKinds.body[column] : numericKinds.all[column]) === 1
      );
    },
    matchingColumns(record, needle, drawn, limit) {
      if (
        needle !== cachedNeedle ||
        matchesByText.length !== sheet.texts.length
      ) {
        cachedNeedle = needle;
        matchesByText = new Uint8Array(sheet.texts.length);
      }
      const r = worksheetRowIndex(sheet, record);
      if (r < 0) return EMPTY_COLUMNS;
      const matches: number[] = [];
      for (
        let i = sheet.rowStart[r]!;
        i < sheet.rowStart[r + 1]! && matches.length < limit;
        i++
      ) {
        const col = sheet.cells[i * 3]!;
        if (col >= drawn) break;
        const textIndex = sheet.cells[i * 3 + 1]!;
        let result = matchesByText[textIndex]!;
        if (result === 0) {
          result = (sheet.texts[textIndex] ?? '').toLowerCase().includes(needle)
            ? 2
            : 1;
          matchesByText[textIndex] = result;
        }
        if (result === 2) matches.push(col);
      }
      return matches;
    },
    records: sheet.rows,
    columns: sheet.columns,
    summary: 'Spreadsheet',
    commentable: canComment(sheet.name),
    sheet: sheet.name,
    text(row, col) {
      const i = index(row, col);
      return i < 0 ? '' : (sheet.texts[sheet.cells[i * 3 + 1]!] ?? '');
    },
    numeric(row, col) {
      const i = index(row, col);
      const n = i < 0 ? NaN : sheet.numbers[i]!;
      return Number.isNaN(n) ? undefined : n;
    },
    detail(row, col) {
      const i = index(row, col);
      return i < 0 ? undefined : sheet.details[sheet.cells[i * 3 + 2]! - 1];
    },
  };
}
function canComment(name: string): boolean {
  try {
    parseWritableCommentAnchor({ kind: 'cell', row: 1, col: 1, sheet: name });
    return true;
  } catch {
    return false;
  }
}

/** Handles a hidden-sheet menu selection; the placeholder selects nothing. */
export function selectHiddenSheet(
  value: string,
  draw: (index: number) => void
): void {
  if (value !== '') draw(Number(value));
}

/** Load the workbook in a worker and attach the existing structured comment API. */
export function renderSpreadsheetRoute(
  root: HTMLElement,
  view: ReadyView,
  download: () => void
): void {
  let workbook: Workbook | undefined,
    part: StructuredPart | undefined,
    active = -1,
    disposed = false;
  const marks = new Map<string, CommentAnchor>();
  const { promise: ready, resolve: settle } = Promise.withResolvers<void>();
  const tabs = document.createElement('div');
  tabs.className = 'spreadsheet-tabs';
  tabs.setAttribute('role', 'tablist');
  const hidden = document.createElement('select');
  hidden.setAttribute('aria-label', 'Hidden sheets');
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  const note = document.createElement('p');
  note.textContent = 'Charts and images are not shown.';
  const table = document.createElement('div');
  root.replaceChildren(tabs, hidden, message, note, table);
  const worker = new Worker('/assets/spreadsheet-parse-worker.js', {
    type: 'module',
  });
  let finished = false;
  const observer = new MutationObserver(() => {
    if (!root.isConnected) handle.dispose();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timeout = window.setTimeout(
    () => fail('This spreadsheet took too long to load.'),
    30_000
  );
  const draw = (index: number): void => {
    if (!workbook || !workbook.sheets[index]) return;
    const sheet = workbook.sheets[index]!;
    active = index;
    part?.dispose();
    part = undefined;
    table.replaceChildren();
    for (const button of tabs.querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute(
        'aria-selected',
        String(Number(button.dataset['index']) === index)
      );
    hidden.value = sheet.state === 'visible' ? '' : String(index);
    if (sheet.refused)
      message.textContent =
        'This sheet has more than 600,000 rows and cannot be shown.';
    else if (sheet.kind === 'chartsheet')
      message.textContent = 'This sheet contains a chart, which is not shown.';
    else if (!canComment(sheet.name))
      message.textContent =
        'Comments are unavailable on this sheet because its name contains unsupported characters.';
    else message.textContent = '';
    if (
      sheet.refused ||
      sheet.kind === 'chartsheet' ||
      sheet.rows === 0 ||
      sheet.columns === 0
    ) {
      root.dispatchEvent(new CustomEvent('relic-repaint', { bubbles: true }));
      return;
    }
    part = mountDataTable(table, sourceFor(sheet), { filename: view.filename });
    for (const [id, anchor] of marks)
      if (anchor.kind === 'cell' && anchor.sheet === sheet.name)
        part.paintMark(anchor, id);
    root.dispatchEvent(new CustomEvent('relic-repaint', { bubbles: true }));
  };
  const handle: StructuredViewHandle = {
    kind: 'table',
    get structured() {
      return !!workbook && !disposed;
    },
    get structuredAvailable() {
      return !!workbook;
    },
    showingSource: false,
    ready,
    paintMark(anchor, id) {
      if (anchor.kind !== 'cell' || !workbook || anchor.sheet === undefined)
        return false;
      const sheet = workbook.sheets.find((item) => item.name === anchor.sheet);
      if (
        !sheet ||
        sheet.kind !== 'worksheet' ||
        sheet.refused ||
        !markFits(
          anchor,
          sheet.rows,
          drawnColumnCount(sourceFor(sheet)),
          sheet.name
        )
      )
        return false;
      marks.set(id, anchor);
      if (workbook.sheets[active] === sheet) part?.paintMark(anchor, id);
      return true;
    },
    clearMarks() {
      marks.clear();
      part?.clearMarks();
    },
    selectionAnchor() {
      return workbook && canComment(workbook.sheets[active]?.name ?? '')
        ? part?.selectionAnchor()
        : undefined;
    },
    reveal(anchor, id) {
      if (anchor.kind !== 'cell' || !workbook) return;
      const index = workbook.sheets.findIndex((s) => s.name === anchor.sheet);
      if (index < 0) return;
      if (index !== active) draw(index);
      part?.reveal(anchor, id);
    },
    showSource() {},
    showStructured() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      worker.terminate();
      part?.dispose();
      marks.clear();
      settle();
    },
  };
  registerStructuredHandle(root, handle);
  const fail = (reason: string): void => {
    if (disposed || finished) return;
    finished = true;
    window.clearTimeout(timeout);
    worker.terminate();
    message.textContent = reason;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Download';
    button.addEventListener('click', download);
    table.replaceChildren(button);
    settle();
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { bubbles: true, detail: 'error' })
    );
  };
  worker.onerror = () => fail('This spreadsheet could not be shown.');
  worker.onmessage = (event: MessageEvent<WorkbookResult>) => {
    if (disposed || finished) return;
    const result = event.data;
    if (!result.ok) {
      fail(
        result.reason === 'too-large'
          ? 'This spreadsheet is too large to show.'
          : 'This spreadsheet could not be shown.'
      );
      return;
    }
    finished = true;
    window.clearTimeout(timeout);
    worker.terminate();
    workbook = result.workbook;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Hidden sheets';
    hidden.append(placeholder);
    workbook.sheets.forEach((sheet, index) => {
      if (sheet.state === 'visible') {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.dataset['index'] = String(index);
        button.textContent = visibleLabel(sheet.name);
        button.addEventListener('click', () => draw(index));
        tabs.append(button);
      } else {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = visibleLabel(sheet.name);
        hidden.append(option);
      }
    });
    hidden.hidden = hidden.options.length <= 1;
    hidden.addEventListener('change', () =>
      selectHiddenSheet(hidden.value, draw)
    );
    const first = workbook.sheets.findIndex(
      (sheet) => sheet.state === 'visible'
    );
    draw(first < 0 ? 0 : first);
    settle();
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { bubbles: true, detail: 'ready' })
    );
  };
  void view.content.readWhole(DOCUMENT_RENDER_LIMIT_BYTES).then(
    (bytes) => {
      if (disposed || finished) return;
      if (!bytes) {
        fail('This spreadsheet is too large to show.');
        return;
      }
      const buffer =
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : new Uint8Array(bytes).buffer;
      worker.postMessage({ type: 'parse', bytes: buffer }, [buffer]);
    },
    () => fail('This spreadsheet could not be read.')
  );
}
