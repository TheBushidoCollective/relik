import { parseWritableCommentAnchor, type CommentAnchor } from '@relic/format';
import type {
  Workbook,
  WorkbookResult,
  WorkbookSheet,
} from '@relic/format/xlsx';
import { drawnColumnCount, markFits, mountDataTable } from './data-table.ts';
import {
  registerStructuredHandle,
  type StructuredPart,
  type StructuredViewHandle,
} from './structured-view-bridge.ts';
import type { TableSource } from './table-source.ts';
import type { ReadyView } from './viewer.ts';

function sourceFor(sheet: WorkbookSheet): TableSource {
  function index(row: number, column: number): number {
    let low = sheet.rowStart[row] ?? 0,
      high = sheet.rowStart[row + 1] ?? low;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (sheet.cells[mid * 3]! < column) low = mid + 1;
      else high = mid;
    }
    return low < (sheet.rowStart[row + 1] ?? 0) &&
      sheet.cells[low * 3] === column
      ? low
      : -1;
  }
  return {
    records: sheet.rows,
    columns: sheet.columns,
    summary: 'Spreadsheet',
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
    )
      return;
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
      worker.terminate();
      part?.dispose();
      marks.clear();
      settle();
    },
  };
  registerStructuredHandle(root, handle);
  const fail = (reason: string): void => {
    if (disposed) return;
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
    if (disposed) return;
    const result = event.data;
    if (!result.ok) {
      fail(
        result.reason === 'too-large'
          ? 'This spreadsheet is too large to show.'
          : 'This spreadsheet could not be shown.'
      );
      return;
    }
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
        button.textContent = sheet.name;
        button.addEventListener('click', () => draw(index));
        tabs.append(button);
      } else {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = sheet.name;
        hidden.append(option);
      }
    });
    hidden.hidden = hidden.options.length <= 1;
    hidden.addEventListener('change', () => {
      if (hidden.value !== '') draw(Number(hidden.value));
    });
    const first = workbook.sheets.findIndex(
      (sheet) => sheet.state === 'visible'
    );
    draw(first < 0 ? 0 : first);
    settle();
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { bubbles: true, detail: 'ready' })
    );
  };
  void view.content.read(0, view.content.size).then(
    (bytes) => {
      if (disposed) return;
      const copy = new Uint8Array(bytes);
      worker.postMessage({ type: 'parse', bytes: copy.buffer }, [copy.buffer]);
    },
    () => fail('This spreadsheet could not be read.')
  );
}
