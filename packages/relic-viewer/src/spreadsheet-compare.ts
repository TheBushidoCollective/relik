/**
 * Side-by-side comparison of two spreadsheets (plan B5, section 3.1, XLSX).
 *
 * Both versions go to the spreadsheet worker on this origin in one `compare`
 * message. The worker pairs the sheets and compares the cells by position
 * (`relic-format/xlsx-diff`). Each sheet is drawn as two grids that share one
 * width plan, so their geometry is identical and their selection and scroll
 * mirror each other.
 *
 * A version that is too large, unreadable or too slow to prepare is not
 * compared. The readable version is shown on its own, and the reason names the
 * version that could not be shown (plan section 9).
 *
 * Sheet names, cell text and formulas reach the page as text. Formulas are shown
 * and never evaluated. This module imports nothing from `main.ts`: the shell
 * supplies its services through `CompareUi`.
 */
import { isRecord } from '@relic/format';
import { TABLE_DRAWN_COLUMN_LIMIT } from '@relic/format/csv';
import {
  type Workbook,
  type WorkbookSheet,
  worksheetRowIndex,
} from '@relic/format/xlsx';
import {
  CELL_KIND,
  type CellChange,
  type SheetComparison,
  type WorkbookComparison,
} from '@relic/format/xlsx-diff';
import type { ChangeReport, CompareUi } from './compare-ui.ts';
import {
  type CompareCellState,
  type CompareTablePart,
  mountCompareTable,
} from './data-table.ts';
import { MAX_DIFF_BYTES } from './diff.ts';
import type { ChangeJump, RenderedChange } from './domdiff.ts';
import type { MarkKind } from './rendered-tree.ts';
import { mirrorScrollers } from './scroll-sync.ts';
import { cellReference } from './table-model.ts';
import type { TableSource } from './table-source.ts';
import type { ReadyView } from './viewer.ts';
import { visibleLabel } from './visible-label.ts';

/** How long a comparison may take to prepare before the left version is shown alone. */
const PREPARE_TIMEOUT_MS = 60_000;
/** The columns a grid draws. The parsed positions keep the same limit. */
const DRAWN_COLUMNS = TABLE_DRAWN_COLUMN_LIMIT;
/** A column is as wide as its longest text, within these bounds. */
const COLUMN_MIN_PX = 88;
const COLUMN_MAX_PX = 320;
const COLUMN_PADDING_PX = 24;
const COLUMN_PX_PER_CHARACTER = 8;
/** Characters of one cell that size its column. Longer text does not widen it. */
const COLUMN_CHARACTERS = 40;

/** Copy from plan section 3.5, verbatim. */
const COPY = {
  label: 'Spreadsheet comparison',
  reading: 'Reading both spreadsheets.',
  scope:
    'Cells are compared by position, by the value shown and the formula. Formatting, charts and images are not compared. A row or column inserted early shifts every cell after it.',
  noValue:
    'No changes to cell values or formulas. Formatting, charts and images are not compared.',
  chart: 'This sheet contains a chart, which is not compared.',
  tooManyRows: 'This sheet has more than 600,000 rows and cannot be compared.',
  timeout: 'This comparison took too long to prepare.',
  loadFailed: 'Relik could not load this comparison.',
} as const;

type Side = 'before' | 'after';
type Failure = 'too-large' | 'unreadable';

/** A version that could not be compared, and why. */
interface VersionFailure {
  readonly side: Side;
  readonly reason: Failure;
}

/** The parsed and compared workbooks the worker replies with. */
interface Compared {
  readonly before: Workbook;
  readonly after: Workbook;
  readonly comparison: WorkbookComparison;
}

interface Totals {
  readonly total: number;
  readonly summary: string;
}

interface Badge {
  readonly text: string;
  readonly tone: string;
}

let instances = 0;

function openAlone(version: number): string {
  return `Version ${version} is open here on its own.`;
}

/** The sentence that says why one version cannot be compared. */
function failedVersion(version: number, reason: Failure): string {
  return reason === 'too-large'
    ? `Version ${version} is too large to compare. Relik compares spreadsheets of up to 2,000,000 cells.`
    : `Version ${version} could not be read as a spreadsheet, so it cannot be compared.`;
}

function moreCells(count: number): string {
  return count === 1
    ? '1 more changed cell on this sheet. Use Next change to reach them.'
    : `${count} more changed cells on this sheet. Use Next change to reach them.`;
}

/** The cells that changed on one sheet: value, formula-only, added and removed. */
function cellCountOf(entry: SheetComparison): number {
  return entry.added + entry.removed + entry.changed + entry.formula;
}

/** The "3 cells changed, 1 added, 1 removed." sentence. Zero terms are left out. */
function cellSentence(cells: WorkbookComparison['cells']): string {
  const parts: string[] = [];
  if (cells.changed > 0)
    parts.push(
      `${cells.changed} ${cells.changed === 1 ? 'cell' : 'cells'} changed`
    );
  if (cells.added > 0) parts.push(`${cells.added} added`);
  if (cells.removed > 0) parts.push(`${cells.removed} removed`);
  return parts.length === 0 ? '' : `${parts.join(', ')}.`;
}

/**
 * The sheet-level result. The noun sits on the first term, as the copy has it:
 * "1 sheet added, 1 removed, 1 renamed." and "1 sheet renamed." alone.
 */
function sheetSentence(comparison: WorkbookComparison): string {
  const terms: [number, string][] = [
    [comparison.sheetsAdded, 'added'],
    [comparison.sheetsRemoved, 'removed'],
    [comparison.sheetsRenamed, 'renamed'],
    [comparison.sheetsHidden, 'hidden'],
    [comparison.sheetsShown, 'shown'],
  ];
  const parts = terms
    .filter(([count]) => count > 0)
    .map(([count, verb], index) =>
      index === 0
        ? `${count} ${count === 1 ? 'sheet' : 'sheets'} ${verb}`
        : `${count} ${verb}`
    );
  return parts.length === 0 ? '' : `${parts.join(', ')}.`;
}

/**
 * The workbook's total and its result line. Each changed cell counts once,
 * formula-only edits included, and each sheet-level change counts once. The
 * sidebar shows the total; navigation counts only the active sheet's cells.
 */
function totalsOf(comparison: WorkbookComparison): Totals {
  const { cells } = comparison;
  const cellChanges = cells.added + cells.removed + cells.changed;
  const sheetChanges =
    comparison.sheetsAdded +
    comparison.sheetsRemoved +
    comparison.sheetsRenamed +
    comparison.sheetsHidden +
    comparison.sheetsShown;
  const total = cellChanges + sheetChanges;
  if (total === 0) return { total, summary: COPY.noValue };
  return {
    total,
    summary: [cellSentence(cells), sheetSentence(comparison)]
      .filter((part) => part !== '')
      .join(' '),
  };
}

/** The sheet the strip opens on: the first one with a change, else the first. */
function defaultSheetOf(sheets: readonly SheetComparison[]): number {
  const first = sheets.findIndex(
    (entry) =>
      entry.status === 'changed' ||
      entry.status === 'added' ||
      entry.status === 'removed'
  );
  return first < 0 ? 0 : first;
}

/** The badges that follow a sheet's name in the strip. */
function badgesFor(entry: SheetComparison): Badge[] {
  const badges: Badge[] = [];
  if (entry.status === 'added')
    badges.push({ text: 'added', tone: 'is-added' });
  if (entry.status === 'removed')
    badges.push({ text: 'removed', tone: 'is-removed' });
  if (entry.renamedFrom !== undefined)
    badges.push({
      text: `renamed from ${visibleLabel(entry.renamedFrom)}`,
      tone: '',
    });
  if (entry.state !== undefined) {
    if (entry.state.after !== 'visible')
      badges.push({ text: 'hidden', tone: '' });
    else if (entry.state.before !== 'visible')
      badges.push({ text: 'shown', tone: '' });
  }
  const changes = cellCountOf(entry);
  if (changes > 0)
    badges.push({
      text: `${changes} ${changes === 1 ? 'change' : 'changes'}`,
      tone: 'is-changes',
    });
  if (entry.notCompared !== undefined)
    badges.push({ text: 'not compared', tone: '' });
  return badges;
}

/** Where the strip moves for a key, or `undefined` for a key it does not use. */
function tabTarget(
  key: string,
  index: number,
  count: number
): number | undefined {
  switch (key) {
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'ArrowRight':
      return (index + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/** The index of a sheet's cell in one version, or -1 when the cell is empty. */
function cellIndex(sheet: WorkbookSheet, row: number, column: number): number {
  const rowIndex = worksheetRowIndex(sheet, row);
  if (rowIndex < 0) return -1;
  const end = sheet.rowStart[rowIndex + 1]!;
  let low = sheet.rowStart[rowIndex]!;
  let high = end;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sheet.cells[mid * 3]! < column) low = mid + 1;
    else high = mid;
  }
  return low < end && sheet.cells[low * 3] === column ? low : -1;
}

/**
 * The index of a changed cell in `positions`, a row-major list of
 * `[row, column, kind]` triples, or -1 when the cell did not change.
 */
function positionOf(
  positions: Uint32Array,
  row: number,
  column: number
): number {
  const count = positions.length / 3;
  const key = row * DRAWN_COLUMNS + column;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midKey =
      positions[mid * 3]! * DRAWN_COLUMNS + positions[mid * 3 + 1]!;
    if (midKey < key) low = mid + 1;
    else high = mid;
  }
  return low < count &&
    positions[low * 3] === row &&
    positions[low * 3 + 1] === column
    ? low
    : -1;
}

/** One version's grid source, padded to the pair's shared dimensions. */
function tableFor(
  sheet: WorkbookSheet,
  records: number,
  columns: number
): TableSource {
  return {
    records,
    columns,
    summary: 'Spreadsheet',
    sheet: sheet.name,
    text(record, column) {
      const i = cellIndex(sheet, record, column);
      return i < 0 ? '' : (sheet.texts[sheet.cells[i * 3 + 1]!] ?? '');
    },
    numeric(record, column) {
      const i = cellIndex(sheet, record, column);
      const value = i < 0 ? Number.NaN : sheet.numbers[i]!;
      return Number.isNaN(value) ? undefined : value;
    },
    detail(record, column) {
      const i = cellIndex(sheet, record, column);
      return i < 0 ? undefined : sheet.details[sheet.cells[i * 3 + 2]! - 1];
    },
  };
}

/**
 * The state a grid paints for one cell of one side. An added cell marks only
 * the current side, and a removed cell only the historical one.
 */
function stateOf(
  positions: Uint32Array,
  side: Side
): (record: number, column: number) => CompareCellState | undefined {
  return (record, column) => {
    const at = positionOf(positions, record, column);
    if (at < 0) return undefined;
    const kind = positions[at * 3 + 2];
    if (kind === CELL_KIND.added) return side === 'after' ? 'added' : undefined;
    if (kind === CELL_KIND.removed)
      return side === 'before' ? 'removed' : undefined;
    return kind === CELL_KIND.formula ? 'formula' : 'changed';
  };
}

/**
 * The jumps Next change steps through: the active sheet's changed cells in
 * row-major order. Built on access, so a sheet with many changes costs no
 * allocation per change.
 */
function jumpsOf(positions: Uint32Array): ArrayLike<ChangeJump> {
  const count = positions.length / 3;
  const jumpAt = (index: number): ChangeJump => {
    const kind = positions[index * 3 + 2];
    const markKind: MarkKind =
      kind === CELL_KIND.added
        ? 'added'
        : kind === CELL_KIND.removed
          ? 'removed'
          : 'changed';
    return {
      side: markKind === 'removed' ? 'before' : 'after',
      changeId: String(index),
      kind: markKind,
    };
  };
  const target: ArrayLike<ChangeJump> = { length: count };
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'length') return count;
      if (typeof property !== 'string') return undefined;
      const index = Number(property);
      return Number.isInteger(index) &&
        index >= 0 &&
        index < count &&
        String(index) === property
        ? jumpAt(index)
        : undefined;
    },
  });
}

/**
 * One listed change as a row of the Changes list. A cell past the drawn columns
 * has no jump and shows the reason instead of its text.
 */
function rowFor(change: CellChange, positions: Uint32Array): RenderedChange {
  const kind: MarkKind = change.kind === 'formula' ? 'changed' : change.kind;
  const reference = cellReference(change.row + 1, change.col + 1);
  const label = change.kind === 'formula' ? `${reference} formula` : reference;
  if (change.col >= DRAWN_COLUMNS) {
    const note = `${reference} is past the ${DRAWN_COLUMNS} columns drawn here.`;
    return kind === 'changed'
      ? {
          kind,
          label,
          before: '',
          after: '',
          segments: { before: [{ kind: 'unchanged', text: note }], after: [] },
        }
      : {
          kind,
          label,
          before: kind === 'removed' ? note : '',
          after: kind === 'added' ? note : '',
        };
  }
  const jumpIndex = positionOf(positions, change.row, change.col);
  return {
    kind,
    label,
    before: change.before,
    after: change.after,
    ...(jumpIndex < 0 ? {} : { jumpIndex }),
  };
}

/** One pixel width per drawn column, from the longest text either version shows in it. */
function widthsFor(
  sheets: readonly WorkbookSheet[],
  columns: number
): number[] {
  const drawn = Math.min(columns, DRAWN_COLUMNS);
  const longest = new Uint8Array(drawn);
  for (const sheet of sheets) {
    const cells = sheet.cells.length / 3;
    for (let i = 0; i < cells; i++) {
      const column = sheet.cells[i * 3]!;
      if (column >= drawn) continue;
      const characters = Math.min(
        sheet.texts[sheet.cells[i * 3 + 1]!]?.length ?? 0,
        COLUMN_CHARACTERS
      );
      if (characters > longest[column]!) longest[column] = characters;
    }
  }
  return Array.from(longest, (characters) =>
    Math.min(
      COLUMN_MAX_PX,
      Math.max(
        COLUMN_MIN_PX,
        COLUMN_PADDING_PX + characters * COLUMN_PX_PER_CHARACTER
      )
    )
  );
}

/** The copy for a sheet that has no grid, or `undefined` when its cells can be drawn. */
function notComparedCopy(
  entry: SheetComparison,
  sheet: WorkbookSheet
): string | undefined {
  const reason =
    entry.notCompared ??
    (sheet.kind === 'chartsheet'
      ? 'chartsheet'
      : sheet.refused === undefined
        ? undefined
        : 'too-large');
  if (reason === undefined) return undefined;
  return reason === 'chartsheet' ? COPY.chart : COPY.tooManyRows;
}

function placeholder(text: string): HTMLElement {
  const note = document.createElement('p');
  note.className = 'dt-placeholder';
  note.textContent = text;
  return note;
}

function paragraph(className: string, text: string): HTMLElement {
  const line = document.createElement('p');
  line.className = className;
  line.textContent = text;
  return line;
}

/** The sheet's name as the strip and the Changes list show it. */
function sheetNameOf(reply: Compared, entry: SheetComparison): string {
  const after =
    entry.after === undefined ? undefined : reply.after.sheets[entry.after];
  const before =
    entry.before === undefined ? undefined : reply.before.sheets[entry.before];
  return (after ?? before)?.name ?? '';
}

/**
 * The bytes the worker takes. A view that covers its whole buffer is moved
 * rather than copied, and any other view is copied.
 */
function transferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : new Uint8Array(bytes).buffer;
}

/** Whether a worker reply has the shape of a compared pair, checked before anything is drawn. */
function isCompared(
  value: Record<string, unknown>
): value is Record<string, unknown> & Compared {
  const { before, after, comparison } = value;
  return (
    isRecord(before) &&
    Array.isArray(before['sheets']) &&
    isRecord(after) &&
    Array.isArray(after['sheets']) &&
    isRecord(comparison) &&
    Array.isArray(comparison['sheets'])
  );
}

/**
 * Reports when the comparison's stage is taken out of the page. A newer render
 * replaces the stage, and a comparison nobody can see must not keep a worker
 * running or hold on to its grids.
 */
function watchDetach(root: HTMLElement, detached: () => void): () => void {
  if (
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined' ||
    !document.body
  )
    return () => {};
  let attached = root.isConnected;
  const observer = new MutationObserver(() => {
    if (root.isConnected) {
      attached = true;
      return;
    }
    if (!attached) return;
    observer.disconnect();
    detached();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** The Changes list, for a render with no sidebar to hand its rows to. */
function changeList(
  ui: CompareUi,
  rows: readonly RenderedChange[],
  onJump: (index: number) => void,
  more: number
): HTMLElement {
  const list = ui.renderChangeList(rows, onJump);
  if (more > 0) {
    const row = document.createElement('li');
    row.className = 'diff-change-more';
    row.textContent = moreCells(more);
    list.appendChild(row);
  }
  return list;
}

/**
 * Side-by-side comparison of two spreadsheets.
 *
 * The returned element shows a loading state at once, then the sheet strip and
 * the two grids of its active sheet. `onChanges` receives the workbook's total
 * and the active sheet's changes, and again whenever the active sheet changes.
 * Without `onChanges`, the changes appear beneath the grids instead.
 */
export function renderSpreadsheetComparison(
  current: ReadyView,
  historical: ReadyView,
  ui: CompareUi,
  onChanges?: (report: ChangeReport) => void
): HTMLElement {
  const instance = ++instances;
  const panelId = `spreadsheet-compare-${instance}-panel`;
  const tabIdOf = (index: number): string =>
    `spreadsheet-compare-${instance}-tab-${index}`;

  const root = document.createElement('section');
  root.className = 'diff-view diff-view-xlsx';

  const heading = document.createElement('div');
  heading.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = COPY.label;
  const counts = document.createElement('span');
  counts.textContent = COPY.reading;
  heading.append(label, counts);

  const leftSlot = document.createElement('div');
  leftSlot.append(placeholder(COPY.reading));
  const rightSlot = document.createElement('div');
  rightSlot.append(placeholder(COPY.reading));

  const nav = ui.buildChangeNav({
    reveal: (jump, top) => reveal(jump, top),
  });
  const stage = ui.buildCompareStage({
    before: leftSlot,
    after: rightSlot,
    current,
    historical,
    nav,
  });
  const stripHost = document.createElement('div');
  const result = document.createElement('div');
  result.className = 'diff-rendered-result';
  root.append(heading, stage.controls, stripHost, stage.stage, result);

  let disposed = false;
  let settled = false;
  let worker: Worker | undefined;
  let timer: number | undefined;
  let loaded: Compared | undefined;
  let totals: Totals = { total: 0, summary: COPY.noValue };
  let tabs: HTMLButtonElement[] = [];
  let active = -1;
  let activePositions: Uint32Array = new Uint32Array(0);
  let leftPart: CompareTablePart | undefined;
  let rightPart: CompareTablePart | undefined;
  let releaseMirror: (() => void) | undefined;
  const widthPlans = new Map<number, number[]>();
  const stopWatching = watchDetach(root, dispose);

  /** Ends the worker's part of the comparison: the worker is terminated and its timer cleared. */
  function settle(): void {
    settled = true;
    window.clearTimeout(timer);
    timer = undefined;
    worker?.terminate();
    worker = undefined;
  }

  function releaseParts(): void {
    releaseMirror?.();
    releaseMirror = undefined;
    leftPart?.dispose();
    rightPart?.dispose();
    leftPart = undefined;
    rightPart = undefined;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopWatching();
    settle();
    releaseParts();
  }

  /** Replaces the comparison with one readable version and the reason it is alone. */
  function showAlone(view: ReadyView, reason: string): void {
    if (disposed) return;
    settle();
    releaseParts();
    root.replaceChildren(ui.renderSingleVersion(view, reason));
    onChanges?.({ changes: [], total: 0, summary: reason });
  }

  /**
   * Shows the version that can be read, and says which one cannot. When the
   * historical version fails, the current one is shown, and the reverse.
   */
  function showFailure(failure: VersionFailure): void {
    const [failed, shown] =
      failure.side === 'before' ? [historical, current] : [current, historical];
    showAlone(
      shown,
      `${failedVersion(failed.version, failure.reason)} ${openAlone(shown.version)}`
    );
  }

  function loadFailed(): void {
    showAlone(
      historical,
      `${COPY.loadFailed} ${openAlone(historical.version)}`
    );
  }

  /** Reads one version's bytes, or says why they cannot be compared. */
  async function readVersion(view: ReadyView): Promise<Uint8Array | Failure> {
    try {
      return (await view.content.readWhole(MAX_DIFF_BYTES)) ?? 'too-large';
    } catch {
      return 'unreadable';
    }
  }

  function onReply(data: unknown): void {
    if (settled || disposed) return;
    settle();
    if (!isRecord(data)) {
      loadFailed();
    } else if (data['ok'] === true && isCompared(data)) {
      build(data);
    } else if (data['ok'] === false) {
      refused(data);
    } else {
      loadFailed();
    }
  }

  /** The worker refused one version, and says which side it was and why. */
  function refused(reply: Record<string, unknown>): void {
    const reason: Failure =
      reply['reason'] === 'too-large' ? 'too-large' : 'unreadable';
    if (reply['side'] === 'before') showFailure({ side: 'before', reason });
    else if (reply['side'] === 'after') showFailure({ side: 'after', reason });
    else loadFailed();
  }

  function startWorker(before: ArrayBuffer, after: ArrayBuffer): void {
    try {
      worker = new Worker('/assets/spreadsheet-parse-worker.js', {
        type: 'module',
      });
    } catch {
      loadFailed();
      return;
    }
    const spawned = worker;
    spawned.onmessage = (event: MessageEvent<unknown>) => onReply(event.data);
    spawned.onerror = () => {
      if (settled || disposed) return;
      loadFailed();
    };
    timer = window.setTimeout(() => {
      if (settled || disposed) return;
      showAlone(historical, `${COPY.timeout} ${openAlone(historical.version)}`);
    }, PREPARE_TIMEOUT_MS);
    try {
      spawned.postMessage({ type: 'compare', before, after }, [before, after]);
    } catch {
      loadFailed();
    }
  }

  async function start(): Promise<void> {
    const [before, after] = await Promise.all([
      readVersion(historical),
      readVersion(current),
    ]);
    if (disposed) return;
    if (typeof before === 'string' && typeof after === 'string') {
      // Neither version can be compared. The older one shows its own failure.
      showAlone(historical, failedVersion(historical.version, before));
    } else if (typeof before === 'string') {
      showFailure({ side: 'before', reason: before });
    } else if (typeof after === 'string') {
      showFailure({ side: 'after', reason: after });
    } else {
      startWorker(transferable(before), transferable(after));
    }
  }

  /** Builds the strip for a comparison the worker has read, and opens its first sheet. */
  function build(reply: Compared): void {
    if (disposed) return;
    loaded = reply;
    totals = totalsOf(reply.comparison);
    const { sheets } = reply.comparison;
    if (sheets.length === 0) {
      counts.textContent = COPY.noValue;
      leftSlot.replaceChildren(placeholder(COPY.noValue));
      rightSlot.replaceChildren(placeholder(COPY.noValue));
      onChanges?.({
        changes: [],
        total: 0,
        summary: COPY.noValue,
        preface: paragraph('diff-scope', COPY.scope),
      });
      return;
    }
    tabs = sheets.map((entry, index) => tabFor(entry, index, reply));
    const strip = document.createElement('div');
    strip.className = 'spreadsheet-tabs';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute(
      'aria-label',
      `Sheets in version ${historical.version} and version ${current.version}`
    );
    strip.append(...tabs);
    stripHost.replaceChildren(strip);
    stage.stage.id = panelId;
    stage.stage.setAttribute('role', 'tabpanel');
    select(defaultSheetOf(sheets));
  }

  function tabFor(
    entry: SheetComparison,
    index: number,
    reply: Compared
  ): HTMLButtonElement {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = tabIdOf(index);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panelId);
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    const name = document.createElement('span');
    name.textContent = visibleLabel(sheetNameOf(reply, entry));
    tab.append(name);
    for (const badge of badgesFor(entry)) {
      const meta = document.createElement('span');
      meta.className =
        badge.tone === '' ? 'dt-sheet-meta' : `dt-sheet-meta ${badge.tone}`;
      meta.textContent = badge.text;
      tab.append(meta);
    }
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event: KeyboardEvent) => {
      const target = tabTarget(event.key, index, tabs.length);
      if (target === undefined) return;
      event.preventDefault();
      select(target);
      tabs[target]?.focus();
    });
    return tab;
  }

  /** Makes one sheet active: the roving tab stop, the grids, the list and the navigation. */
  function select(index: number): void {
    if (disposed || loaded === undefined) return;
    if (index !== active) {
      active = index;
      mountSheet(loaded, index);
    }
    tabs.forEach((tab, at) => {
      tab.setAttribute('aria-selected', String(at === index));
      tab.tabIndex = at === index ? 0 : -1;
    });
    stage.stage.setAttribute('aria-labelledby', tabIdOf(index));
  }

  /** The sheet's width plan, computed once and kept while the strip is open. */
  function widthPlanFor(
    index: number,
    sheets: readonly WorkbookSheet[],
    columns: number
  ): number[] {
    let plan = widthPlans.get(index);
    if (plan === undefined) {
      plan = widthsFor(sheets, columns);
      widthPlans.set(index, plan);
    }
    return plan;
  }

  function mountSheet(reply: Compared, index: number): void {
    releaseParts();
    const entry = reply.comparison.sheets[index]!;
    const beforeSheet =
      entry.before === undefined
        ? undefined
        : reply.before.sheets[entry.before];
    const afterSheet =
      entry.after === undefined ? undefined : reply.after.sheets[entry.after];
    const drawable =
      entry.notCompared === undefined
        ? [beforeSheet, afterSheet].filter(
            (sheet): sheet is WorkbookSheet => sheet !== undefined
          )
        : [];
    // Both grids take the same rows and columns, padded to the larger version.
    const records = Math.max(0, ...drawable.map((sheet) => sheet.rows));
    const columns = Math.max(0, ...drawable.map((sheet) => sheet.columns));
    const widths =
      drawable.length === 0 ? [] : widthPlanFor(index, drawable, columns);

    const pane = (
      side: Side,
      sheet: WorkbookSheet | undefined,
      version: number,
      other: () => CompareTablePart | undefined
    ): { readonly element: HTMLElement; readonly part?: CompareTablePart } => {
      if (sheet === undefined)
        return {
          element: placeholder(`This sheet is not in version ${version}.`),
        };
      const copy = notComparedCopy(entry, sheet);
      if (copy !== undefined) return { element: placeholder(copy) };
      const element = document.createElement('div');
      const part = mountCompareTable(
        element,
        tableFor(sheet, records, columns),
        {
          filename: current.filename,
          label: `Version ${version} of ${current.filename}, sheet ${sheet.name}`,
          widths,
          state: stateOf(entry.positions, side),
          onSelect: (row, column) => other()?.select(row, column),
        }
      );
      return { element, part };
    };

    const left = pane(
      'before',
      beforeSheet,
      historical.version,
      () => rightPart
    );
    const right = pane('after', afterSheet, current.version, () => leftPart);
    leftPart = left.part;
    rightPart = right.part;
    leftSlot.replaceChildren(left.element);
    rightSlot.replaceChildren(right.element);
    if (leftPart !== undefined && rightPart !== undefined)
      releaseMirror = mirrorScrollers([leftPart.scroller, rightPart.scroller]);
    activePositions = entry.positions;
    nav.setJumps(jumpsOf(entry.positions));
    deliver(entry);
  }

  /** Hands the active sheet's changes to the shell, or lists them when there is no shell. */
  function deliver(entry: SheetComparison): void {
    counts.textContent = totals.summary;
    const rows = entry.listed.map((change) => rowFor(change, entry.positions));
    const more = cellCountOf(entry) - entry.listed.length;
    const scope = paragraph('diff-scope', COPY.scope);
    if (onChanges !== undefined) {
      onChanges({
        changes: rows,
        total: totals.total,
        summary: totals.summary,
        onJump: nav.goTo,
        preface: scope,
        more: { count: more, copy: moreCells },
      });
      return;
    }
    const parts: HTMLElement[] = [scope];
    if (rows.length > 0 || more > 0)
      parts.push(changeList(ui, rows, nav.goTo, more));
    result.replaceChildren(...parts);
  }

  /** Moves to a change: selects its cell in both grids and scrolls both to it. */
  function reveal(jump: ChangeJump, top: number): boolean {
    const index = Number(jump.changeId);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index * 3 + 2 >= activePositions.length
    )
      return false;
    const row = activePositions[index * 3]!;
    const column = activePositions[index * 3 + 1]!;
    (leftPart ?? rightPart)?.select(row, column);
    leftPart?.reveal(row, column, top);
    rightPart?.reveal(row, column, top);
    return leftPart !== undefined || rightPart !== undefined;
  }

  void start();
  return root;
}
