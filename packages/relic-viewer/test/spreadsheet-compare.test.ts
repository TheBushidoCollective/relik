import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import JSZip from 'jszip';
import { parseXlsx } from '@relic/format/xlsx';
import {
  compareWorkbooks,
  XLSX_COMPARE_CELL_LIMIT,
} from '@relic/format/xlsx-diff';
import type { ChangeNav, ChangeReport, CompareUi } from '../src/compare-ui.ts';
import { contentFromBytes, type RelicContent } from '../src/content.ts';
import { MAX_DIFF_BYTES } from '../src/diff.ts';
import type { ChangeJump } from '../src/domdiff.ts';
import { changeSidebarContent, renderChangeList } from '../src/main.ts';
import { renderSpreadsheetComparison } from '../src/spreadsheet-compare.ts';
import type { ReadyView } from '../src/viewer.ts';

/**
 * A small DOM for this suite: elements, text, classes, attributes, listeners and
 * a tree. It has no layout, so assertions are about structure, state and copy.
 * How the grids look is proven in a browser.
 *
 * Waits are event waits, not clocks. Each stub that the module drives reports
 * its change, and a wait ends on the event it names.
 */

/** Wakes every wait that is pending on the next change. */
const wakers: (() => void)[] = [];

function changed(): void {
  for (const wake of wakers.splice(0)) wake();
}

function nextChange(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  wakers.push(resolve);
  return promise;
}

async function until(check: () => boolean): Promise<void> {
  while (!check()) await nextChange();
}

type Listener = (event: StubEvent) => void;

interface StubEvent {
  readonly type: string;
  readonly key?: string;
  readonly button?: number;
  target?: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function eventOf(
  type: string,
  init: {
    readonly key?: string;
    readonly button?: number;
    readonly target?: unknown;
  } = {}
): StubEvent {
  const event: StubEvent = {
    type,
    ...init,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

class StubText {
  parentNode: StubElement | undefined;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string) {
    this.data = value;
  }
}

class StubStyle {
  [property: string]: unknown;

  setProperty(name: string, value: string): void {
    this[name] = value;
  }
}

type StubNode = StubElement | StubText;

let focusedElement: StubElement | undefined;

class StubElement {
  readonly tagName: string;
  readonly children: StubNode[] = [];
  parentNode: StubElement | undefined;
  className = '';
  id = '';
  type = '';
  tabIndex = 0;
  hidden = false;
  disabled = false;
  isConnected = false;
  scrollTop = 0;
  scrollLeft = 0;
  clientHeight = 0;
  clientWidth = 0;
  focused = false;
  readonly dataset: Record<string, string> = {};
  readonly style = new StubStyle();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get classList() {
    const names = (): string[] =>
      this.className.split(/\s+/).filter((name) => name !== '');
    const write = (list: readonly string[]): void => {
      this.className = list.join(' ');
    };
    return {
      add: (...added: string[]): void =>
        write([...new Set([...names(), ...added])]),
      remove: (...removed: string[]): void =>
        write(names().filter((name) => !removed.includes(name))),
      toggle: (name: string, force?: boolean): boolean => {
        const has = names().includes(name);
        const next = force ?? !has;
        if (next && !has) write([...names(), name]);
        if (!next && has) write(names().filter((other) => other !== name));
        return next;
      },
      contains: (name: string): boolean => names().includes(name),
    };
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(new StubText(value));
  }

  appendChild<T extends StubNode>(child: T): T {
    const previous = child.parentNode;
    if (previous !== undefined)
      previous.children.splice(previous.children.indexOf(child), 1);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: (StubNode | string)[]): void {
    for (const node of nodes)
      this.appendChild(typeof node === 'string' ? new StubText(node) : node);
  }

  replaceChildren(...nodes: (StubNode | string)[]): void {
    for (const child of this.children) child.parentNode = undefined;
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((other) => other !== listener)
    );
  }

  dispatchEvent(event: StubEvent): boolean {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? [])
      listener(event);
    return !event.defaultPrevented;
  }

  focus(): void {
    this.focused = true;
    focusedElement = this;
  }

  /** The nearest element, this one included, that carries the class in `selector`. */
  closest(selector: string): StubElement | null {
    const name = selector.replace(/^\./, '');
    for (let node: StubElement | undefined = this; node; node = node.parentNode)
      if (node.classList.contains(name)) return node;
    return null;
  }
}

/**
 * The module and the grid read the DOM members the stub implements, and nothing
 * else. The declared type is the browser's, so the stub is handed over as one.
 */
function asHTML(element: StubElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function stubOf(element: HTMLElement): StubElement {
  return element as unknown as StubElement;
}

/** Every element under `node`, `node` included, in document order. */
function elementsUnder(node: StubElement): StubElement[] {
  return [
    node,
    ...elementChildren(node).flatMap((child) => elementsUnder(child)),
  ];
}

function elementChildren(node: StubElement): StubElement[] {
  return node.children.filter(
    (child): child is StubElement => child instanceof StubElement
  );
}

function withClass(node: StubElement, name: string): StubElement[] {
  return elementsUnder(node).filter((candidate) =>
    candidate.classList.contains(name)
  );
}

class StubObserver {
  static active: StubObserver[] = [];
  readonly callback: () => void;
  disconnected = false;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  observe(): void {
    StubObserver.active.push(this);
  }

  disconnect(): void {
    this.disconnected = true;
    StubObserver.active = StubObserver.active.filter((other) => other !== this);
  }
}

/** Runs every live observer, as the browser does after the page changes. */
function mutate(): void {
  for (const observer of [...StubObserver.active]) observer.callback();
}

interface TimerRecord {
  readonly id: number;
  readonly ms: number;
  readonly run: () => void;
  cleared: boolean;
}

const timers: TimerRecord[] = [];

interface CompareMessage {
  readonly type: 'compare';
  readonly before: ArrayBuffer;
  readonly after: ArrayBuffer;
}

function isCompareMessage(value: unknown): value is CompareMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'compare'
  );
}

/** Parses and compares the two versions as the real worker does, minus its size checks. */
async function workerAnswer(message: CompareMessage): Promise<unknown> {
  const options = { cellLimit: XLSX_COMPARE_CELL_LIMIT };
  const before = await parseXlsx(
    new Uint8Array(message.before),
    undefined,
    options
  );
  if (!before.ok) return { ok: false, side: 'before', reason: before.reason };
  const after = await parseXlsx(
    new Uint8Array(message.after),
    undefined,
    options
  );
  if (!after.ok) return { ok: false, side: 'after', reason: after.reason };
  return {
    ok: true,
    before: before.workbook,
    after: after.workbook,
    comparison: compareWorkbooks(before.workbook, after.workbook),
  };
}

type Answer = (worker: StubWorker, message: CompareMessage) => void;

/** Replies as the real worker would, a turn later. */
const answerWithComparison: Answer = (worker, message) => {
  void workerAnswer(message).then((data) => worker.reply(data));
};

/** How the next worker answers a comparison. A test may leave it silent, or make it fail. */
let answer: Answer = answerWithComparison;

/** The real worker, for the tests that check the message protocol end to end. */
const RealWorker = globalThis.Worker;
let realMode = false;
const realWorkers: Worker[] = [];

class StubWorker {
  static spawned: StubWorker[] = [];
  readonly url: string;
  onmessage: ((event: { data: unknown }) => void) | undefined;
  onerror: ((event: unknown) => void) | undefined;
  onmessageerror: ((event: unknown) => void) | undefined;
  readonly posted: {
    readonly message: unknown;
    readonly transfer: unknown[];
  }[] = [];
  terminated = false;
  readonly real: Worker | undefined;

  constructor(url: string) {
    this.url = url;
    StubWorker.spawned.push(this);
    if (realMode) {
      const worker = new RealWorker(
        new URL('../src/spreadsheet-parse-worker.ts', import.meta.url),
        { type: 'module' }
      );
      realWorkers.push(worker);
      worker.onmessage = (event: MessageEvent<unknown>) =>
        this.reply(event.data);
      worker.onerror = (event: ErrorEvent) => {
        this.onerror?.(event);
        changed();
      };
      this.real = worker;
    }
    changed();
  }

  /** The worker's reply to the module. */
  reply(data: unknown): void {
    this.onmessage?.({ data });
    changed();
  }

  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push({ message, transfer });
    if (this.real !== undefined) {
      this.real.postMessage(message, transfer as Transferable[]);
      return;
    }
    if (isCompareMessage(message)) answer(this, message);
  }

  terminate(): void {
    this.terminated = true;
    this.real?.terminate();
  }
}

/** A document stub with the nodes the suite needs. */
function stubDocument() {
  const body = new StubElement('body');
  body.isConnected = true;
  return {
    body,
    head: new StubElement('head'),
    documentElement: new StubElement('html'),
    get activeElement(): StubElement | undefined {
      return focusedElement;
    },
    createElement: (tag: string) => new StubElement(tag),
    createElementNS: (_namespace: string, tag: string) => new StubElement(tag),
    createTextNode: (text: string) => new StubText(text),
    querySelector: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
}

/** The globals this suite replaces, kept so each test hands them back. */
const saved = {
  document: globalThis.document,
  window: globalThis.window,
  Element: globalThis.Element,
  MutationObserver: globalThis.MutationObserver,
  Worker: globalThis.Worker,
};

beforeAll(() => {
  Object.assign(globalThis, {
    Element: StubElement,
    MutationObserver: StubObserver,
  });
});

afterAll(() => {
  Object.assign(globalThis, saved);
});

beforeEach(() => {
  timers.length = 0;
  wakers.length = 0;
  StubObserver.active = [];
  StubWorker.spawned = [];
  focusedElement = undefined;
  answer = answerWithComparison;
  realMode = false;
  Object.assign(globalThis, {
    document: stubDocument(),
    window: {
      setTimeout: (run: () => void, ms: number): number => {
        const id = timers.length + 1;
        timers.push({ id, ms, run, cleared: false });
        return id;
      },
      clearTimeout: (id: number | undefined): void => {
        for (const timer of timers) if (timer.id === id) timer.cleared = true;
      },
    },
    Worker: StubWorker,
  });
});

afterEach(() => {
  for (const worker of realWorkers.splice(0)) worker.terminate();
  Object.assign(globalThis, {
    document: saved.document,
    window: saved.window,
    Worker: saved.Worker,
  });
});

/** The shell's services for this suite: the real Changes list, a plain stage, and recorded single versions. */
interface Harness {
  readonly ui: CompareUi;
  readonly navs: FakeNav[];
  readonly singles: { readonly version: number; readonly reason: string }[];
}

class FakeNav implements ChangeNav {
  readonly element: HTMLElement;
  jumps: ArrayLike<ChangeJump> = [];
  position = -1;
  emptyNote: string | undefined;
  private readonly reveal: (jump: ChangeJump, top: number) => boolean;

  constructor(
    element: HTMLElement,
    reveal: (jump: ChangeJump, top: number) => boolean
  ) {
    this.element = element;
    this.reveal = reveal;
  }

  setJumps(jumps: ArrayLike<ChangeJump>, emptyNote?: string): void {
    this.jumps = jumps;
    this.position = -1;
    this.emptyNote = emptyNote;
  }

  goTo(index: number): void {
    if (this.jumps.length === 0) return;
    const wrapped =
      ((index % this.jumps.length) + this.jumps.length) % this.jumps.length;
    this.position = wrapped;
    this.reveal(this.jumps[wrapped]!, 120);
  }

  step(delta: 1 | -1): number | undefined {
    if (this.jumps.length === 0) return undefined;
    this.goTo(
      this.position < 0
        ? delta === 1
          ? 0
          : this.jumps.length - 1
        : this.position + delta
    );
    return this.position;
  }
}

function harness(): Harness {
  const navs: FakeNav[] = [];
  const singles: { version: number; reason: string }[] = [];
  const ui: CompareUi = {
    buildChangeNav: ({ reveal }) => {
      const nav = new FakeNav(asHTML(new StubElement('div')), reveal);
      navs.push(nav);
      return nav;
    },
    buildCompareStage: (options) => {
      const stage = new StubElement('div');
      stage.className = 'compare-stage';
      const beforePane = new StubElement('div');
      beforePane.className = 'compare-pane compare-pane-before';
      const afterPane = new StubElement('div');
      afterPane.className = 'compare-pane compare-pane-current';
      beforePane.appendChild(stubOf(options.before));
      afterPane.appendChild(stubOf(options.after));
      stage.append(beforePane, afterPane);
      const controls = new StubElement('div');
      controls.className = 'compare-controls';
      controls.append(stubOf(options.nav.element));
      return {
        stage: asHTML(stage),
        controls: asHTML(controls),
        beforePane: asHTML(beforePane),
        afterPane: asHTML(afterPane),
      };
    },
    renderChangeList,
    notice: (text) => {
      const note = new StubElement('p');
      note.textContent = text;
      return asHTML(note);
    },
    noChanges: (summary) => {
      const note = new StubElement('div');
      note.textContent = summary;
      return asHTML(note);
    },
    renderSingleVersion: (view: ReadyView, reason: string) => {
      singles.push({ version: view.version, reason });
      const wrap = new StubElement('div');
      wrap.className = 'diff-single';
      wrap.textContent = reason;
      changed();
      return asHTML(wrap);
    },
    documentFrame: () => {
      throw new Error('documents are not compared in this suite');
    },
    download: () => {
      throw new Error('downloads are not used in this suite');
    },
  };
  return { ui, navs, singles };
}

const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Cell = string | number | { readonly f: string; readonly v: number };

interface SheetFixture {
  readonly name: string;
  readonly sheetId?: number;
  readonly state?: 'hidden';
  readonly cells?: Readonly<Record<string, Cell>>;
  readonly chart?: true;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The zero-based column of A1 letters: A is 0, Z is 25, AA is 26. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const letter of letters) n = n * 26 + letter.charCodeAt(0) - 64;
  return n - 1;
}

function cellXml(ref: string, cell: Cell): string {
  if (typeof cell === 'string')
    return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
  if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
  return `<c r="${ref}"><f>${escapeXml(cell.f)}</f><v>${cell.v}</v></c>`;
}

function sheetXml(cells: Readonly<Record<string, Cell>>): string {
  const rows = new Map<number, [number, string, Cell][]>();
  for (const [ref, cell] of Object.entries(cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!match) throw new Error(`bad reference ${ref}`);
    const row = Number(match[2]);
    rows.set(row, [
      ...(rows.get(row) ?? []),
      [columnIndex(match[1]!), ref, cell],
    ]);
  }
  const body = [...rows.keys()]
    .sort((a, b) => a - b)
    .map((row) => {
      const inRow = rows.get(row)!.sort((a, b) => a[0] - b[0]);
      return `<row r="${row}">${inRow
        .map(([, ref, cell]) => cellXml(ref, cell))
        .join('')}</row>`;
    })
    .join('');
  return `<worksheet xmlns="${SPREADSHEET}"><sheetData>${body}</sheetData></worksheet>`;
}

async function workbook(sheets: readonly SheetFixture[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const entries: string[] = [];
  const relations: string[] = [];
  sheets.forEach((sheet, index) => {
    const n = index + 1;
    const id = `rId${n}`;
    const attributes = [
      `name="${escapeXml(sheet.name)}"`,
      sheet.sheetId === undefined ? '' : `sheetId="${sheet.sheetId}"`,
      sheet.state === undefined ? '' : `state="${sheet.state}"`,
    ].filter((attribute) => attribute !== '');
    entries.push(`<sheet ${attributes.join(' ')} r:id="${id}"/>`);
    if (sheet.chart) {
      relations.push(
        `<Relationship Id="${id}" Type="${RELATIONSHIPS}/chartsheet" Target="chartsheets/sheet${n}.xml"/>`
      );
      zip.file(`xl/chartsheets/sheet${n}.xml`, '<chartsheet/>');
    } else {
      relations.push(
        `<Relationship Id="${id}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${n}.xml"/>`
      );
      zip.file(`xl/worksheets/sheet${n}.xml`, sheetXml(sheet.cells ?? {}));
    }
  });
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${SPREADSHEET}" xmlns:r="${RELATIONSHIPS}"><sheets>${entries.join('')}</sheets></workbook>`
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations.join('')}</Relationships>`
  );
  return zip.generateAsync({ type: 'uint8array' });
}

/** Version 1 of the B5 spec fixture (plan section 6). */
const QUARTER_V1: SheetFixture[] = [
  {
    name: 'Q3',
    sheetId: 1,
    cells: {
      A1: 'Region',
      B1: 'Plan',
      A2: 'West',
      B2: 1000,
      E2: { f: 'SUM(B2:C3)', v: 2200 },
      A3: 'East',
      C3: 1200,
      E3: { f: 'B2*2', v: 2000 },
      B7: 'Draft note',
    },
  },
  { name: 'Old data', sheetId: 2, cells: { A1: 'Legacy' } },
  { name: 'Hidden', sheetId: 3, state: 'hidden', cells: { A1: 'x' } },
];

/** Version 2 of the B5 spec fixture: Q3 renamed to Q3 budget, Summary added. */
const QUARTER_V2: SheetFixture[] = [
  {
    name: 'Q3 budget',
    sheetId: 1,
    cells: {
      A1: 'Region',
      B1: 'Plan',
      A2: 'West',
      B2: 1000,
      E2: { f: 'SUM(B2:C3)*1', v: 2250 },
      A3: 'East',
      C3: 1250,
      E3: { f: 'B2+B2', v: 2000 },
      D5: 'Total',
    },
  },
  { name: 'Hidden', sheetId: 3, state: 'hidden', cells: { A1: 'y' } },
  { name: 'Summary', sheetId: 4, cells: { A1: 'Totals' } },
];

const FIXTURE_SUMMARY =
  '4 cells changed, 1 added, 1 removed. 1 sheet added, 1 removed, 1 renamed.';

const SCOPE =
  'Cells are compared by position, by the value shown and the formula. Formatting, charts and images are not compared. A row or column inserted early shifts every cell after it.';

/** A view of one version, as the viewer hands it to a comparison. */
function viewOf(
  version: number,
  content: RelicContent,
  currentVersion = 3,
  filename = 'budget.xlsx'
): ReadyView {
  return {
    filename,
    declaredMimetype:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content,
    document: undefined,
    route: 'spreadsheet',
    downgradeNotice: undefined,
    shareUrl: 'https://relik.example/aaaaaaaaaaaaaaaaaaaaaaaaaa#key',
    version,
    currentVersion,
    versionDigest: '0'.repeat(64),
  };
}

/** A version whose bytes cannot be read, though its size is known. */
function unreadableContent(bytes: Uint8Array): RelicContent {
  return {
    ...contentFromBytes(bytes),
    readWhole: () => Promise.reject(new Error('the content store is gone')),
  };
}

/** A version over the comparison ceiling. Its bytes are never read. */
function oversizeContent(): RelicContent {
  return contentFromBytes(new Uint8Array(MAX_DIFF_BYTES + 1));
}

function tabsOf(root: StubElement): StubElement[] {
  const [strip] = withClass(root, 'spreadsheet-tabs');
  return strip ? elementChildren(strip) : [];
}

function gridsOf(root: StubElement): StubElement[] {
  return withClass(root, 'dt-grid');
}

function cellAt(
  grid: StubElement,
  record: number,
  column: number
): StubElement | undefined {
  return withClass(grid, 'dt-cell').find(
    (cell) =>
      cell.dataset['r'] === String(record) &&
      cell.dataset['c'] === String(column)
  );
}

function paneOf(
  root: StubElement,
  side: 'before' | 'after'
): StubElement | undefined {
  return withClass(
    root,
    side === 'before' ? 'compare-pane-before' : 'compare-pane-current'
  )[0];
}

/** The address the cellbar of one pane shows, such as `C3`. */
function addressOf(
  root: StubElement,
  side: 'before' | 'after'
): string | undefined {
  const pane = paneOf(root, side);
  return pane ? withClass(pane, 'dt-addr')[0]?.textContent : undefined;
}

function paneText(root: StubElement, side: 'before' | 'after'): string {
  return paneOf(root, side)?.textContent ?? '';
}

function sidebarRows(report: ChangeReport): StubElement {
  return stubOf(changeSidebarContent(report)!);
}

/** Renders a comparison with its report recorded, as the shell does. */
function start(
  current: ReadyView,
  historical: ReadyView,
  shell: Harness,
  reports: ChangeReport[] = []
): StubElement {
  return stubOf(
    renderSpreadsheetComparison(current, historical, shell.ui, (report) => {
      reports.push(report);
      changed();
    })
  );
}

async function sheetsReady(root: StubElement): Promise<void> {
  await until(() => tabsOf(root).length > 0);
}

/** Two sheets of `count` changed cells, each in column A. */
function changedColumn(count: number, prefix: string): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `A${index + 1}`,
      `${prefix}${index + 1}`,
    ])
  );
}

describe('spreadsheet comparison: strip, badges and the default sheet', () => {
  test('lists the sheets in comparison order with their badges, and opens the first with a change', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);

    const tabs = tabsOf(root);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Q3 budgetrenamed from Q35 changes',
      'Hiddenhidden1 change',
      'Summaryadded',
      'Old dataremoved',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    const [strip] = withClass(root, 'spreadsheet-tabs');
    expect(strip?.getAttribute('role')).toBe('tablist');
    expect(strip?.getAttribute('aria-label')).toBe(
      'Sheets in version 2 and version 3'
    );
    const [stage] = withClass(root, 'compare-stage');
    expect(stage?.id).not.toBe('');
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(stage?.id);
    expect(stage?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
  });

  test('reports the workbook total and the exact summary, with the active sheet changes', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell,
      reports
    );
    await sheetsReady(root);

    const report = reports.at(-1)!;
    expect(report.total).toBe(9);
    expect(report.summary).toBe(FIXTURE_SUMMARY);
    expect(report.changes.map((change) => change.label)).toEqual([
      'E2',
      'C3',
      'E3 formula',
      'D5',
      'B7',
    ]);
    expect(report.changes.map((change) => change.kind)).toEqual([
      'changed',
      'changed',
      'changed',
      'added',
      'removed',
    ]);
    expect(report.more?.count).toBe(0);
    expect(report.more?.copy(3)).toBe(
      '3 more changed cells on this sheet. Use Next change to reach them.'
    );
    expect(stubOf(report.preface!).textContent).toBe(SCOPE);
    expect(withClass(root, 'diff-summary')[0]?.textContent).toContain(
      FIXTURE_SUMMARY
    );
  });

  test('moves the strip with the arrow, Home and End keys, keeping one tab stop', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);
    const tabs = tabsOf(root);
    const press = (name: string, tab: StubElement): void => {
      tab.dispatchEvent(eventOf('keydown', { key: name }));
    };

    press('ArrowRight', tabs[0]!);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(tabs[1]!.focused).toBe(true);

    press('End', tabs[1]!);
    expect(tabs[3]!.getAttribute('aria-selected')).toBe('true');
    press('ArrowRight', tabs[3]!);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    press('ArrowLeft', tabs[0]!);
    expect(tabs[3]!.getAttribute('aria-selected')).toBe('true');
    press('Home', tabs[3]!);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');

    const ignored = eventOf('keydown', { key: 'a' });
    tabs[0]!.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('spreadsheet comparison: grids, placeholders and cell states', () => {
  test('draws the two grids with one geometry, and each cell state on the side it belongs to', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);

    const [left, right] = gridsOf(root);
    expect(left?.getAttribute('aria-label')).toContain(
      'Version 2 of budget.xlsx, sheet Q3'
    );
    expect(right?.getAttribute('aria-label')).toContain(
      'Version 3 of budget.xlsx, sheet Q3 budget'
    );
    expect(left?.getAttribute('aria-rowcount')).toBe(
      right?.getAttribute('aria-rowcount')
    );
    expect(left?.getAttribute('aria-colcount')).toBe(
      right?.getAttribute('aria-colcount')
    );
    expect(left?.style['--dt-tracks']).toBe(right?.style['--dt-tracks']);
    expect(left?.dataset['file']).toBe('budget.xlsx');

    const stateOf = (
      grid: StubElement | undefined,
      record: number,
      column: number
    ) =>
      cellAt(grid!, record, column)
        ?.className.split(' ')
        .find((name) => name.startsWith('dt-diff-'));
    // Records and columns are zero-based: E2 is record 1, column 4.
    expect(stateOf(left, 1, 4)).toBe('dt-diff-changed');
    expect(stateOf(right, 1, 4)).toBe('dt-diff-changed');
    expect(stateOf(left, 2, 4)).toBe('dt-diff-formula');
    expect(stateOf(right, 2, 4)).toBe('dt-diff-formula');
    expect(stateOf(right, 4, 3)).toBe('dt-diff-added');
    expect(stateOf(left, 4, 3)).toBeUndefined();
    expect(stateOf(left, 6, 1)).toBe('dt-diff-removed');
    expect(stateOf(right, 6, 1)).toBeUndefined();
    expect(cellAt(left!, 1, 4)?.textContent).toBe('2200 (changed)');
    expect(cellAt(right!, 2, 4)?.textContent).toBe('2000 (formula changed)');
  });

  test('mirrors a cell selection from one grid to the other', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);
    const [left, right] = gridsOf(root);
    const cell = cellAt(left!, 2, 2)!;
    left!.dispatchEvent(eventOf('mousedown', { button: 0, target: cell }));

    expect(addressOf(root, 'before')).toBe('C3');
    expect(addressOf(root, 'after')).toBe('C3');
    expect(cellAt(right!, 2, 2)?.classList.contains('is-active')).toBe(true);
  });

  test('moves to a change with the navigation, selecting its cell in both grids', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);
    const nav = shell.navs.at(-1)!;
    expect(nav.jumps.length).toBe(5);
    expect(nav.jumps[2]).toEqual({
      side: 'after',
      changeId: '2',
      kind: 'changed',
    });
    expect(nav.jumps[4]).toEqual({
      side: 'before',
      changeId: '4',
      kind: 'removed',
    });

    nav.goTo(2);
    expect(addressOf(root, 'before')).toBe('E3');
    expect(addressOf(root, 'after')).toBe('E3');
    nav.step(1);
    expect(addressOf(root, 'before')).toBe('D5');
  });

  test('places a placeholder for an added sheet on the left and a removed sheet on the right', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);
    const tabs = tabsOf(root);

    tabs[2]!.dispatchEvent(eventOf('click'));
    expect(paneText(root, 'before')).toBe('This sheet is not in version 2.');
    expect(gridsOf(root)).toHaveLength(1);
    expect(gridsOf(root)[0]?.getAttribute('aria-label')).toContain(
      'Version 3 of'
    );

    tabs[3]!.dispatchEvent(eventOf('click'));
    expect(paneText(root, 'after')).toBe('This sheet is not in version 3.');
    expect(gridsOf(root)).toHaveLength(1);
    expect(gridsOf(root)[0]?.getAttribute('aria-label')).toContain(
      'Version 2 of'
    );
  });

  test('states a chart and an oversize sheet as not compared on both sides', async () => {
    const shell = harness();
    const before = await workbook([
      { name: 'Chart1', sheetId: 1, chart: true },
      { name: 'Long', sheetId: 2, cells: { A1: 'start', A600001: 'end' } },
    ]);
    const after = await workbook([
      { name: 'Chart1', sheetId: 1, cells: { A1: 'chart data' } },
      { name: 'Long', sheetId: 2, cells: { A1: 'start', A600001: 'end' } },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell
    );
    await sheetsReady(root);
    const tabs = tabsOf(root);

    expect(tabs[0]?.textContent).toContain('not compared');
    expect(paneText(root, 'before')).toBe(
      'This sheet contains a chart, which is not compared.'
    );
    expect(paneText(root, 'after')).toBe(
      'This sheet contains a chart, which is not compared.'
    );
    expect(gridsOf(root)).toHaveLength(0);

    tabs[1]!.dispatchEvent(eventOf('click'));
    expect(paneText(root, 'before')).toBe(
      'This sheet has more than 600,000 rows and cannot be compared.'
    );
    expect(paneText(root, 'after')).toBe(
      'This sheet has more than 600,000 rows and cannot be compared.'
    );
  });

  test('shows a sheet name with a bidi character escaped, and cell markup as text', async () => {
    const shell = harness();
    const before = await workbook([
      {
        name: 'Notes\u202Etxt',
        sheetId: 1,
        cells: { A1: 'Comment', A2: 'Fine as is' },
      },
    ]);
    const after = await workbook([
      {
        name: 'Notes\u202Etxt',
        sheetId: 1,
        cells: { A1: 'Comment', A2: '<img src=x onerror=alert(1)>' },
      },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell
    );
    await sheetsReady(root);

    const [tab] = tabsOf(root);
    expect(tab?.textContent).toContain('Notes\\u202etxt');
    expect(tab?.textContent).not.toContain('\u202E');
    const [leftGrid, rightGrid] = gridsOf(root);
    for (const grid of [leftGrid!, rightGrid!])
      expect(elementsUnder(grid).some((node) => node.tagName === 'IMG')).toBe(
        false
      );
    expect(cellAt(rightGrid!, 1, 0)?.textContent).toContain(
      '<img src=x onerror=alert(1)>'
    );
  });
});

describe('spreadsheet comparison: changes, the list and the summary', () => {
  test('lists more than 200 changes on a sheet, with the cell more row', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      { name: 'Big', sheetId: 1, cells: changedColumn(205, 'a') },
    ]);
    const after = await workbook([
      { name: 'Big', sheetId: 1, cells: changedColumn(205, 'b') },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);

    const report = reports.at(-1)!;
    expect(report.total).toBe(205);
    expect(report.summary).toBe('205 cells changed.');
    expect(report.changes).toHaveLength(200);
    expect(report.more?.count).toBe(5);
    const list = sidebarRows(report);
    expect(withClass(list, 'diff-change')).toHaveLength(200);
    expect(
      withClass(list, 'diff-change-more').map((row) => row.textContent)
    ).toEqual([
      '5 more changed cells on this sheet. Use Next change to reach them.',
    ]);
  });

  test('says singular for one more changed cell', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      { name: 'Big', sheetId: 1, cells: changedColumn(201, 'a') },
    ]);
    const after = await workbook([
      { name: 'Big', sheetId: 1, cells: changedColumn(201, 'b') },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);
    expect(
      withClass(sidebarRows(reports.at(-1)!), 'diff-change-more').map(
        (row) => row.textContent
      )
    ).toEqual([
      '1 more changed cell on this sheet. Use Next change to reach them.',
    ]);
  });

  test('keeps a cell past the 256 drawn columns in the list, without a jump', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      { name: 'Wide', sheetId: 1, cells: { JA1: 'old', A2: 'same' } },
    ]);
    const after = await workbook([
      { name: 'Wide', sheetId: 1, cells: { JA1: 'new', A2: 'changed' } },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);

    const report = reports.at(-1)!;
    expect(report.total).toBe(2);
    const [past, drawn] = report.changes;
    expect(past?.label).toBe('JA1');
    expect(past?.jumpIndex).toBeUndefined();
    expect(drawn?.label).toBe('A2');
    expect(drawn?.jumpIndex).toBe(0);
    const [pastRow] = withClass(sidebarRows(report), 'diff-change');
    expect(pastRow?.textContent).toContain(
      'JA1 is past the 256 columns drawn here.'
    );
    expect(pastRow?.classList.contains('is-linked')).toBe(false);
  });

  test('reports no value change, with the scope line beneath the summary', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const cells = { A1: 'Region', B2: 1000 };
    const root = start(
      viewOf(
        3,
        contentFromBytes(await workbook([{ name: 'Q3', sheetId: 1, cells }]))
      ),
      viewOf(
        2,
        contentFromBytes(await workbook([{ name: 'Q3', sheetId: 1, cells }]))
      ),
      shell,
      reports
    );
    await sheetsReady(root);
    const report = reports.at(-1)!;
    expect(report.total).toBe(0);
    expect(report.summary).toBe(
      'No changes to cell values or formulas. Formatting, charts and images are not compared.'
    );
    expect(changeSidebarContent(report)).toBe(report.preface);
    expect(withClass(root, 'diff-summary')[0]?.textContent).toContain(
      report.summary
    );
  });

  test('reports a sheet-level change alone in the summary', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const cells = { A1: 'Region' };
    const root = start(
      viewOf(
        3,
        contentFromBytes(
          await workbook([{ name: 'Quarter', sheetId: 1, cells }])
        )
      ),
      viewOf(
        2,
        contentFromBytes(await workbook([{ name: 'Q3', sheetId: 1, cells }]))
      ),
      shell,
      reports
    );
    await sheetsReady(root);
    expect(reports.at(-1)?.total).toBe(1);
    expect(reports.at(-1)?.summary).toBe('1 sheet renamed.');
  });

  test('lists the changes beneath the grids when there is no sidebar to hand them to', async () => {
    const shell = harness();
    const root = stubOf(
      renderSpreadsheetComparison(
        viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
        viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
        shell.ui
      )
    );
    await sheetsReady(root);
    const [result] = withClass(root, 'diff-rendered-result');
    expect(
      withClass(result!, 'diff-change').map((row) => row.textContent)
    ).toEqual([
      'changedE222002250',
      'changedC312001250',
      'changedE3 formula=B2*2=B2+B2',
      'addedD5Total',
      'removedB7Draft note',
    ]);
    expect(
      withClass(result!, 'diff-scope').map((line) => line.textContent)
    ).toEqual([SCOPE]);
  });
});

describe('spreadsheet comparison: versions that cannot be compared', () => {
  test('does not send an oversize version to the worker, and shows the other version alone', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, oversizeContent()),
      shell
    );
    await until(() => shell.singles.length > 0);

    expect(StubWorker.spawned).toHaveLength(0);
    expect(shell.singles).toEqual([
      {
        version: 3,
        reason:
          'Version 2 is too large to compare. Relik compares spreadsheets of up to 2,000,000 cells. Version 3 is open here on its own.',
      },
    ]);
    expect(root.textContent).toBe(shell.singles[0]!.reason);
  });

  test('shows the older version alone with its own failure when both are oversize', async () => {
    const shell = harness();
    start(viewOf(3, oversizeContent()), viewOf(2, oversizeContent()), shell);
    await until(() => shell.singles.length > 0);
    expect(shell.singles).toEqual([
      {
        version: 2,
        reason:
          'Version 2 is too large to compare. Relik compares spreadsheets of up to 2,000,000 cells.',
      },
    ]);
    expect(StubWorker.spawned).toHaveLength(0);
  });

  test('names the older version the worker cannot read, and shows the newer one', async () => {
    const shell = harness();
    answer = (worker) =>
      void Promise.resolve().then(() =>
        worker.reply({ ok: false, side: 'before', reason: 'too-large' })
      );
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles.at(-1)).toEqual({
      version: 3,
      reason:
        'Version 2 is too large to compare. Relik compares spreadsheets of up to 2,000,000 cells. Version 3 is open here on its own.',
    });
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });

  test('names the newer version the worker cannot read, and shows the older one', async () => {
    const shell = harness();
    answer = (worker) =>
      void Promise.resolve().then(() =>
        worker.reply({ ok: false, side: 'after', reason: 'corrupt' })
      );
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles.at(-1)).toEqual({
      version: 2,
      reason:
        'Version 3 could not be read as a spreadsheet, so it cannot be compared. Version 2 is open here on its own.',
    });
  });

  test('treats a version whose bytes cannot be read as unreadable', async () => {
    const shell = harness();
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, unreadableContent(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles).toEqual([
      {
        version: 3,
        reason:
          'Version 2 could not be read as a spreadsheet, so it cannot be compared. Version 3 is open here on its own.',
      },
    ]);
    expect(StubWorker.spawned).toHaveLength(0);
  });

  test('shows the older version alone after 60 seconds without an answer, and ends the worker', async () => {
    const shell = harness();
    answer = () => {};
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => StubWorker.spawned.length > 0);
    const timer = timers.find(
      (candidate) => candidate.ms === 60_000 && !candidate.cleared
    );
    expect(timer).toBeDefined();
    timer!.run();

    expect(shell.singles).toEqual([
      {
        version: 2,
        reason:
          'This comparison took too long to prepare. Version 2 is open here on its own.',
      },
    ]);
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });

  test('shows the older version alone when the worker cannot be loaded', async () => {
    const shell = harness();
    answer = (worker) =>
      void Promise.resolve().then(() => {
        worker.onerror?.({ type: 'error' });
        changed();
      });
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles).toEqual([
      {
        version: 2,
        reason:
          'Relik could not load this comparison. Version 2 is open here on its own.',
      },
    ]);
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });

  test('treats a reply without a comparison as a failure to load', async () => {
    const shell = harness();
    answer = (worker) =>
      void Promise.resolve().then(() => worker.reply({ ok: true }));
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles.at(-1)?.reason).toBe(
      'Relik could not load this comparison. Version 2 is open here on its own.'
    );
  });
});

describe('spreadsheet comparison: worker and stage lifecycle', () => {
  test('ends the worker, and clears its timer, when the result arrives', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);
    const worker = StubWorker.spawned[0]!;
    expect(worker.terminated).toBe(true);
    expect(worker.posted[0]?.message).toMatchObject({ type: 'compare' });
    expect(worker.posted[0]?.transfer).toHaveLength(2);
    expect(timers.find((candidate) => candidate.ms === 60_000)?.cleared).toBe(
      true
    );
  });

  test('ends a pending comparison when its stage is replaced, and ignores a late reply', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    answer = () => {};
    const root = stubOf(
      renderSpreadsheetComparison(
        viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
        viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
        shell.ui,
        (report) => reports.push(report)
      )
    );
    await until(() => StubWorker.spawned.length > 0);
    const worker = StubWorker.spawned[0]!;

    root.isConnected = true;
    mutate();
    root.isConnected = false;
    mutate();
    expect(worker.terminated).toBe(true);
    expect(StubObserver.active).toHaveLength(0);

    worker.reply({ ok: false, side: 'before', reason: 'too-large' });
    expect(shell.singles).toEqual([]);
    expect(reports).toEqual([]);
    expect(root.children).toHaveLength(5);
  });

  test('disconnects its observer and ends its worker when a finished stage is replaced', async () => {
    const shell = harness();
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await sheetsReady(root);
    expect(StubObserver.active).toHaveLength(1);
    root.isConnected = true;
    mutate();
    root.isConnected = false;
    mutate();
    expect(StubObserver.active).toHaveLength(0);
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });
});

describe('spreadsheet comparison: the real worker', () => {
  test('compares the fixture through the spreadsheet worker', async () => {
    realMode = true;
    const shell = harness();
    const reports: ChangeReport[] = [];
    const root = start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell,
      reports
    );
    await sheetsReady(root);

    expect(reports.at(-1)?.total).toBe(9);
    expect(reports.at(-1)?.summary).toBe(FIXTURE_SUMMARY);
    expect(
      tabsOf(root).map((tab) => tab.getAttribute('aria-selected'))
    ).toEqual(['true', 'false', 'false', 'false']);
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });

  test('shows the other version alone when the worker refuses a corrupt version', async () => {
    realMode = true;
    const shell = harness();
    start(
      viewOf(3, contentFromBytes(new TextEncoder().encode('not a workbook'))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles).toEqual([
      {
        version: 2,
        reason:
          'Version 3 could not be read as a spreadsheet, so it cannot be compared. Version 2 is open here on its own.',
      },
    ]);
  });
});

describe('spreadsheet comparison: text the Changes list shows', () => {
  test('escapes a bidi override and an escape character in a listed value and formula, as the grid does', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      {
        name: 'Ledger',
        sheetId: 1,
        cells: { A1: 'ok', B1: { f: 'SUM(1,2)', v: 3 } },
      },
    ]);
    const after = await workbook([
      {
        name: 'Ledger',
        sheetId: 1,
        cells: {
          A1: 'ok\u202Eabc\u001B',
          B1: { f: 'SUM(1,2)\u202E\u001B', v: 3 },
        },
      },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);

    const report = reports.at(-1)!;
    expect(
      report.changes.map((change) => [
        change.label,
        change.before,
        change.after,
      ])
    ).toEqual([
      ['A1', 'ok', 'ok\\u{202E}abc\\u{1B}'],
      ['B1 formula', '=SUM(1,2)', '=SUM(1,2)\\u{202E}\\u{1B}'],
    ]);
    const list = sidebarRows(report).textContent;
    expect(list).toContain('ok\\u{202E}abc\\u{1B}');
    expect(list).toContain('=SUM(1,2)\\u{202E}\\u{1B}');
    expect(list).not.toContain('\u202E');
    expect(list).not.toContain('\u001B');
  });

  test('names changes past the drawn columns, and the nav says so when none can be reached', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      { name: 'Wide', sheetId: 1, cells: { JA1: 'a', JB1: 'b', JC1: 'c' } },
    ]);
    const after = await workbook([
      { name: 'Wide', sheetId: 1, cells: { JA1: 'x', JB1: 'y', JC1: 'z' } },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);

    const report = reports.at(-1)!;
    expect(report.total).toBe(3);
    expect(report.changes.map((change) => change.label)).toEqual([
      'JA1',
      'JB1',
      'JC1',
    ]);
    expect(report.more?.count).toBe(0);
    expect(shell.navs.at(-1)?.emptyNote).toBe(
      '3 changes past the 256 columns drawn here'
    );
  });

  test('counts the unlisted changes past the drawn columns apart from the reachable ones', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      {
        name: 'Big',
        sheetId: 1,
        cells: {
          ...changedColumn(205, 'a'),
          JA206: 'old',
          JA207: 'old',
          JA208: 'old',
          JA209: 'old',
        },
      },
    ]);
    const after = await workbook([
      {
        name: 'Big',
        sheetId: 1,
        cells: {
          ...changedColumn(205, 'b'),
          JA206: 'new',
          JA207: 'new',
          JA208: 'new',
          JA209: 'new',
        },
      },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);

    const report = reports.at(-1)!;
    expect(report.total).toBe(209);
    expect(report.changes).toHaveLength(200);
    expect(report.more?.count).toBe(9);
    const copy =
      '5 more changed cells on this sheet. Use Next change to reach them. 4 changed cells are past the 256 columns drawn here.';
    expect(report.more?.copy(9)).toBe(copy);
    expect(
      withClass(sidebarRows(report), 'diff-change-more').map(
        (row) => row.textContent
      )
    ).toEqual([copy]);
    expect(shell.navs.at(-1)?.emptyNote).toBeUndefined();
  });
});

describe('spreadsheet comparison: lone sheets and replies that cannot be read', () => {
  test('shows an added chartsheet as added and not compared, and opens it', async () => {
    const shell = harness();
    const reports: ChangeReport[] = [];
    const before = await workbook([
      { name: 'Main', sheetId: 1, cells: { A1: 'x' } },
    ]);
    const after = await workbook([
      { name: 'Main', sheetId: 1, cells: { A1: 'x' } },
      { name: 'Chart', sheetId: 2, chart: true },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell,
      reports
    );
    await sheetsReady(root);

    const tabs = tabsOf(root);
    expect(tabs[1]?.textContent).toBe('Chartaddednot compared');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(paneText(root, 'after')).toBe(
      'This sheet contains a chart, which is not compared.'
    );
    expect(paneText(root, 'before')).toBe('This sheet is not in version 2.');
    expect(reports.at(-1)?.summary).toBe('1 sheet added.');
  });

  test('shows a removed oversize sheet as removed and not compared, and opens it', async () => {
    const shell = harness();
    const before = await workbook([
      { name: 'Main', sheetId: 1, cells: { A1: 'x' } },
      { name: 'Long', sheetId: 2, cells: { A1: 'start', A600001: 'end' } },
    ]);
    const after = await workbook([
      { name: 'Main', sheetId: 1, cells: { A1: 'x' } },
    ]);
    const root = start(
      viewOf(3, contentFromBytes(after)),
      viewOf(2, contentFromBytes(before)),
      shell
    );
    await sheetsReady(root);

    const tabs = tabsOf(root);
    expect(tabs[1]?.textContent).toBe('Longremovednot compared');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(paneText(root, 'before')).toBe(
      'This sheet has more than 600,000 rows and cannot be compared.'
    );
    expect(paneText(root, 'after')).toBe('This sheet is not in version 3.');
  });

  test('shows the older version alone when the worker replies corrupt without naming a side', async () => {
    const shell = harness();
    answer = (worker) =>
      void Promise.resolve().then(() =>
        worker.reply({ ok: false, reason: 'corrupt' })
      );
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles).toEqual([
      {
        version: 2,
        reason:
          'Relik could not load this comparison. Version 2 is open here on its own.',
      },
    ]);
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });

  test('shows the older version alone when the worker reply cannot be read', async () => {
    const shell = harness();
    answer = (worker) =>
      void Promise.resolve().then(() => {
        worker.onmessageerror?.({ type: 'messageerror' });
        changed();
      });
    start(
      viewOf(3, contentFromBytes(await workbook(QUARTER_V2))),
      viewOf(2, contentFromBytes(await workbook(QUARTER_V1))),
      shell
    );
    await until(() => shell.singles.length > 0);
    expect(shell.singles).toEqual([
      {
        version: 2,
        reason:
          'Relik could not load this comparison. Version 2 is open here on its own.',
      },
    ]);
    expect(StubWorker.spawned[0]?.terminated).toBe(true);
  });
});
