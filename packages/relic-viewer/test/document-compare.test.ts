import { afterEach, expect, jest, test } from 'bun:test';
import { crc32, planStoredZip } from '@relic/format';
import type {
  CompareUi,
  DocumentFrameHandle,
  PairedResult,
} from '../src/compare-ui.ts';
import { contentFromBytes } from '../src/content.ts';
import { documentComparisonSpec } from '../src/document-compare.ts';
import { DOCUMENT_BLOCKS_WAIT_MS } from '../src/document-route.ts';
import type {
  DocumentBlock,
  DocumentStateMessage,
  EpubBook,
  RenderDocumentMessage,
} from '../src/frame-document-protocol.ts';
import type { ReadyView } from '../src/viewer.ts';

/** Captured before any test installs fake timers, so the test's own waits stay real. */
const realSetTimeout = globalThis.setTimeout;

/** Resolves after a real macrotask, whatever fake timers the test has installed. */
function realDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  realSetTimeout(resolve, ms);
  return promise;
}

afterEach(() => jest.useRealTimers());

const DOCX_SCOPE =
  'Compares the text of paragraphs, lists and tables. Page headers and footers, formatting, layout and image content are not compared.';
const EPUB_SCOPE =
  'Compares the text of each chapter. Formatting, layout and image content are not compared.';
const NO_TEXT =
  'No text changes. Formatting, layout and image content are not compared.';
const UNREADABLE =
  'Both versions are shown. Relik could not read their text, so changes are not outlined.';
const TOO_LONG =
  'Both versions are shown. They are too long for Relik to outline their changes.';
const TOO_MANY =
  'Both versions are shown. They differ in too many places for Relik to outline the changes.';
const READY: DocumentStateMessage = {
  type: 'relic:document-state',
  state: 'ready',
};

/** A DOM element as far as the comparison builds, inserts and clicks it. */
class El extends EventTarget {
  className = '';
  readonly style = { height: '' };
  textContent = '';
  isConnected = false;
  removed = false;
  readonly children: El[] = [];
  readonly attributes = new Map<string, string>();
  constructor(readonly tagName: string) {
    super();
  }
  append(...nodes: El[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: El[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  remove(): void {
    this.removed = true;
  }
}

const el = (node: HTMLElement): El => node as unknown as El;

/** Stands in for the viewer's DOM and mutation observer for one test. */
function installDom(): { mutate(): void; restore(): void } {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const previousObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'MutationObserver'
  );
  const observed: { onMutation?: () => void } = {};
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        observed.onMutation = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tag: string) => new El(tag) },
  });
  return {
    mutate: () => observed.onMutation?.(),
    restore: () => {
      if (previousDocument)
        Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      if (previousObserver)
        Object.defineProperty(globalThis, 'MutationObserver', previousObserver);
      else Reflect.deleteProperty(globalThis, 'MutationObserver');
    },
  };
}

interface FrameProbe {
  readonly frame: El;
  readonly payload: RenderDocumentMessage;
  /** What the comparison asked this frame to do, in order. */
  readonly calls: string[];
  disposals: number;
  state(state: DocumentStateMessage): void;
  blocks(blocks: readonly DocumentBlock[] | null | 'invalid'): void;
}

/** The shell's services, with frames that record what they were asked to do. */
function probeUi(): { ui: CompareUi; frames: FrameProbe[] } {
  const frames: FrameProbe[] = [];
  const services: Pick<CompareUi, 'documentFrame' | 'download'> = {
    documentFrame: (_view, payload, _transfer, onState, onBlocks) => {
      const frame = new El('iframe');
      const probe: FrameProbe = {
        frame,
        payload,
        calls: [],
        disposals: 0,
        state: onState,
        blocks: onBlocks,
      };
      frames.push(probe);
      const handle: DocumentFrameHandle = {
        frame: frame as unknown as HTMLIFrameElement,
        linkConfirm: new El('div') as unknown as HTMLElement,
        linkRemembered: new El('div') as unknown as HTMLElement,
        dispose: () => {
          probe.disposals += 1;
        },
        annotate: (marks, anchors) => {
          probe.calls.push(`annotate:${marks.length}:${anchors?.length ?? 0}`);
        },
        setScroll: (position) => {
          probe.calls.push(`scroll:${position.fraction}`);
        },
        revealChange: (changeId, top) => {
          probe.calls.push(`reveal:${changeId}:${top}`);
        },
      };
      return handle;
    },
    download: () => {},
  };
  return { ui: services as CompareUi, frames };
}

/** A ready version with only the fields a document comparison reads. */
function viewOf(version: number, bytes: Uint8Array): ReadyView {
  return {
    version,
    filename: 'book.epub',
    content: contentFromBytes(bytes),
  } as unknown as ReadyView;
}

/** Waits, a macrotask at a time, until the condition holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) await realDelay(0);
  expect(condition()).toBe(true);
}

/** Lets queued promise work run to its next wait, without touching a timer. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5000; i++) await Promise.resolve();
}

/** The diff of two versions, which the test expects to exist. */
function diffed(
  result: PairedResult
): Exclude<PairedResult, { readonly unavailable: string }> {
  if ('unavailable' in result)
    throw new Error(`no diff: ${result.unavailable}`);
  return result;
}

/** The controls of a Chapters list, in order: a button that jumps, or a line. */
function chapterControls(preface: HTMLElement): El[] {
  const section = el(preface).children.find(
    (child) => child.className === 'diff-chapters'
  );
  const list = section?.children[1];
  return (list?.children ?? []).map((item) => item.children[0]!);
}

function zip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const encoder = new TextEncoder();
  const data = entries.map(([name, text]) => ({
    name,
    bytes: encoder.encode(text),
  }));
  const layout = planStoredZip(
    data.map(({ name, bytes }) => ({
      name,
      size: bytes.length,
      crc32: crc32(bytes),
    }))
  );
  const result = new Uint8Array(layout.totalBytes);
  let offset = 0;
  for (let i = 0; i < data.length; i++) {
    const header = layout.localHeaders[i]!;
    result.set(header, offset);
    offset += header.length;
    result.set(data[i]!.bytes, offset);
    offset += data[i]!.bytes.length;
  }
  result.set(layout.centralDirectory, offset);
  offset += layout.centralDirectory.length;
  result.set(layout.end, offset);
  return result;
}

const DOCX = zip([
  [
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ],
  [
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  ],
  [
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  ],
]);

const EPUB = zip([
  [
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  ],
  [
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>River journal</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  ],
  [
    'OEBPS/ch1.xhtml',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>We crossed at dawn.</p></body></html>',
  ],
]);

const DRM = zip([['META-INF/rights.xml', '<rights/>']]);

/** Version 1 of the quarterly plan, from the S6b fixture. */
const DOCX_V1: DocumentBlock[] = [
  { kind: 'heading', text: 'Quarterly plan', part: 0 },
  { kind: 'paragraph', text: 'Revenue grew in every region.', part: 0 },
  { kind: 'paragraph', text: 'Hiring stays flat.', part: 0 },
  { kind: 'table-cell', text: 'Region', part: 0 },
  { kind: 'table-cell', text: 'Target', part: 0 },
  { kind: 'table-cell', text: 'West', part: 0 },
  { kind: 'table-cell', text: '120', part: 0 },
  {
    kind: 'paragraph',
    text: 'This sentence is removed in version 2.',
    part: 0,
  },
  { kind: 'image', text: '', part: 0 },
];

/** Version 2 of the quarterly plan, from the S6b fixture. */
const DOCX_V2: DocumentBlock[] = [
  { kind: 'heading', text: 'Quarterly plan', part: 0 },
  {
    kind: 'paragraph',
    text: 'Revenue grew in every region except the north.',
    part: 0,
  },
  { kind: 'paragraph', text: 'Hiring stays flat.', part: 0 },
  { kind: 'table-cell', text: 'Region', part: 0 },
  { kind: 'table-cell', text: 'Target', part: 0 },
  { kind: 'table-cell', text: 'West', part: 0 },
  { kind: 'table-cell', text: '135', part: 0 },
  { kind: 'image', text: '', part: 0 },
  { kind: 'paragraph', text: 'Launch in May.', part: 0 },
];

const BOOK_V2: EpubBook = {
  title: 'River journal',
  progression: 'default',
  layout: 'reflowable',
  resources: [],
  spine: [
    { path: 'ch1.xhtml', linear: true },
    { path: 'ch2.xhtml', linear: true },
    { path: 'ch3.xhtml', linear: true },
  ],
  toc: [
    { label: 'Opening', path: 'ch1.xhtml', depth: 0 },
    { label: 'The crossing', path: 'ch2.xhtml', depth: 0 },
    { label: 'Interlude', path: 'ch3.xhtml', depth: 0 },
  ],
  pageList: [],
};

/** Version 3 of the book: chapter 3 removed, chapter 4 added at the end. */
const BOOK_V3: EpubBook = {
  title: 'River journal',
  progression: 'default',
  layout: 'reflowable',
  resources: [],
  spine: [
    { path: 'ch1.xhtml', linear: true },
    { path: 'ch2.xhtml', linear: true },
    { path: 'ch4.xhtml', linear: true },
  ],
  toc: [
    { label: 'Opening', path: 'ch1.xhtml', depth: 0 },
    { label: 'The crossing', path: 'ch2.xhtml', depth: 0 },
    { label: 'Afterword', path: 'ch4.xhtml', depth: 0 },
  ],
  pageList: [],
};

/** Blocks of the EPUB fixture, chapter by chapter in render order. */
const BOOK_V2_BLOCKS: DocumentBlock[] = [
  { kind: 'heading', text: 'Opening', part: 0 },
  {
    kind: 'paragraph',
    text: 'The ferry had stopped running by the time we reached the bank.',
    part: 0,
  },
  { kind: 'heading', text: 'The crossing', part: 1 },
  { kind: 'paragraph', text: 'We crossed at dawn.', part: 1 },
  {
    kind: 'paragraph',
    text: 'Nobody spoke until the far bank was under our boots.',
    part: 1,
  },
  { kind: 'heading', text: 'Interlude', part: 2 },
  {
    kind: 'paragraph',
    text: 'A short letter home, written on the back of a feed receipt.',
    part: 2,
  },
];

const BOOK_V3_BLOCKS: DocumentBlock[] = [
  { kind: 'heading', text: 'Opening', part: 0 },
  {
    kind: 'paragraph',
    text: 'The ferry had stopped running by the time we reached the bank.',
    part: 0,
  },
  { kind: 'heading', text: 'The crossing', part: 1 },
  { kind: 'paragraph', text: 'We crossed at noon.', part: 1 },
  {
    kind: 'paragraph',
    text: 'Nobody spoke until the far bank was under our boots.',
    part: 1,
  },
  { kind: 'heading', text: 'Afterword', part: 2 },
  {
    kind: 'paragraph',
    text: 'The bridge went in two years later. I still take the long way round.',
    part: 2,
  },
];

test('each format names its label, scope, timeout and fallback exactly', () => {
  const { ui } = probeUi();
  expect(documentComparisonSpec('docx', ui)).toMatchObject({
    mode: 'docx',
    label: 'Document comparison',
    scope: DOCX_SCOPE,
    snapshotTimeoutMs: 45_000,
    sync: 'frame',
    unavailable: UNREADABLE,
  });
  expect(documentComparisonSpec('epub', ui)).toMatchObject({
    mode: 'epub',
    label: 'Book comparison',
    scope: EPUB_SCOPE,
    snapshotTimeoutMs: 45_000,
    sync: 'frame',
    unavailable: UNREADABLE,
  });
});

test('a pane mounts once it is inserted, and resolves to the blocks its frame reports', async () => {
  const dom = installDom();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('docx', ui).pane(viewOf(2, DOCX));
    expect(pane.element.className).toBe('doc doc-document');
    expect(pane.element.style.height).toBe('100%');
    // The stage inserts the pane after it is built, so the mount waits for it.
    el(pane.element).isConnected = true;
    await until(() => frames.length === 1);
    const frame = frames[0]!;
    expect(frame.payload.compare).toBe(true);
    frame.state(READY);
    frame.blocks(DOCX_V1);
    expect(await pane.snapshot).toEqual({ blocks: DOCX_V1 });
  } finally {
    dom.restore();
  }
});

test('a pane that is never inserted never mounts a frame', async () => {
  const dom = installDom();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('docx', ui).pane(viewOf(2, DOCX));
    await realDelay(20);
    expect(frames).toHaveLength(0);
    expect(await pane.snapshot).toBeNull();
    expect(pane.failure?.()).toBe(
      'Version 2 could not be shown, so changes are not outlined.'
    );
  } finally {
    dom.restore();
  }
});

test('a DRM book keeps its card in its pane and names the version as protected', async () => {
  const dom = installDom();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('epub', ui).pane(viewOf(2, DRM));
    el(pane.element).isConnected = true;
    expect(await pane.snapshot).toBeNull();
    expect(pane.failure?.()).toBe(
      'Version 2 is protected by DRM, so changes are not outlined.'
    );
    expect(frames).toHaveLength(0);
    expect(el(pane.element).children[0]?.children[0]?.textContent).toBe(
      'This ebook is protected by DRM and cannot be shown.'
    );
  } finally {
    dom.restore();
  }
});

test('a render that fails names its version and takes its frame away', async () => {
  const dom = installDom();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('docx', ui).pane(viewOf(3, DOCX));
    el(pane.element).isConnected = true;
    await until(() => frames.length === 1);
    frames[0]!.state({
      type: 'relic:document-state',
      state: 'failed',
      reason: 'corrupt',
    });
    expect(await pane.snapshot).toBeNull();
    expect(pane.failure?.()).toBe(
      'Version 3 could not be shown, so changes are not outlined.'
    );
    expect(frames[0]!.frame.removed).toBe(true);
  } finally {
    dom.restore();
  }
});

test('an oversize or unreadable version keeps both renders and says so', async () => {
  const dom = installDom();
  try {
    const cases = [
      [null, TOO_LONG],
      ['invalid', UNREADABLE],
    ] as const;
    for (const [reply, copy] of cases) {
      const { ui, frames } = probeUi();
      const pane = documentComparisonSpec('docx', ui).pane(viewOf(2, DOCX));
      el(pane.element).isConnected = true;
      await until(() => frames.length === 1);
      frames[0]!.state(READY);
      frames[0]!.blocks(reply);
      expect(await pane.snapshot).toBeNull();
      expect(pane.failure?.()).toBe(copy);
      expect(frames[0]!.frame.removed).toBe(false);
    }
  } finally {
    dom.restore();
  }
});

test('a version whose blocks never arrive times out and keeps its render', async () => {
  const dom = installDom();
  jest.useFakeTimers();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('docx', ui).pane(viewOf(2, DOCX));
    el(pane.element).isConnected = true;
    await flushMicrotasks();
    expect(frames).toHaveLength(1);
    frames[0]!.state(READY);
    jest.advanceTimersByTime(DOCUMENT_BLOCKS_WAIT_MS);
    expect(await pane.snapshot).toBeNull();
    expect(pane.failure?.()).toBe(UNREADABLE);
    expect(frames[0]!.frame.removed).toBe(false);
  } finally {
    jest.useRealTimers();
    dom.restore();
  }
});

test('detaching a pane before its blocks arrive settles it as failed and disposes its frame', async () => {
  const dom = installDom();
  jest.useFakeTimers();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('docx', ui).pane(viewOf(2, DOCX));
    el(pane.element).isConnected = true;
    await flushMicrotasks();
    expect(frames).toHaveLength(1);
    frames[0]!.state(READY);
    el(pane.element).isConnected = false;
    dom.mutate();
    expect(frames[0]!.disposals).toBe(1);
    expect(await pane.snapshot).toBeNull();
    expect(pane.failure?.()).toBe(
      'Version 2 could not be shown, so changes are not outlined.'
    );
  } finally {
    jest.useRealTimers();
    dom.restore();
  }
});

test('an EPUB resolves to its blocks and to the package the parent read', async () => {
  const dom = installDom();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('epub', ui).pane(viewOf(2, EPUB));
    el(pane.element).isConnected = true;
    await until(() => frames.length === 1);
    frames[0]!.state(READY);
    frames[0]!.blocks(BOOK_V2_BLOCKS);
    const snapshot = await pane.snapshot;
    expect(snapshot?.blocks).toEqual(BOOK_V2_BLOCKS);
    expect(snapshot?.book?.title).toBe('River journal');
    expect(snapshot?.book?.spine).toEqual([
      { path: 'OEBPS/ch1.xhtml', linear: true },
    ]);
  } finally {
    dom.restore();
  }
});

test('annotation, scroll, and reveal reach the frame once it exists', async () => {
  const dom = installDom();
  try {
    const { ui, frames } = probeUi();
    const pane = documentComparisonSpec('docx', ui).pane(viewOf(2, DOCX));
    el(pane.element).isConnected = true;
    expect(pane.revealChange?.('d0', 40)).toBe(false);
    await until(() => frames.length === 1);
    frames[0]!.state(READY);
    frames[0]!.blocks(DOCX_V1);
    await pane.snapshot;
    pane.annotate(
      [{ path: [0], kind: 'removed', changeId: 'c0' }],
      [{ path: [1], syncId: 'a0' }]
    );
    pane.setScroll?.({ fraction: 0.5 });
    expect(pane.revealChange?.('d0', 40)).toBe(true);
    expect(frames[0]!.calls).toEqual([
      'annotate:1:1',
      'scroll:0.5',
      'reveal:d0:40',
    ]);
  } finally {
    dom.restore();
  }
});

test('a DOCX reads its own result, with no chapter preface', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const result = diffed(
      documentComparisonSpec('docx', ui).diff(
        { blocks: DOCX_V1 },
        { blocks: DOCX_V2 }
      )
    );
    expect(result.summary).toBe('1 added, 1 removed, 2 changed.');
    expect(result.total).toBe(4);
    expect('preface' in result).toBe(false);
  } finally {
    dom.restore();
  }
});

test('identical DOCX versions read as no text changes', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const result = diffed(
      documentComparisonSpec('docx', ui).diff(
        { blocks: DOCX_V1 },
        { blocks: DOCX_V1 }
      )
    );
    expect(result.changed).toBe(false);
    expect(result.summary).toBe(NO_TEXT);
    expect('preface' in result).toBe(false);
  } finally {
    dom.restore();
  }
});

test('an EPUB chapter list says what changed, and its rows jump to it', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const jumps: number[] = [];
    const result = diffed(
      documentComparisonSpec('epub', ui).diff(
        { blocks: BOOK_V2_BLOCKS, book: BOOK_V2 },
        { blocks: BOOK_V3_BLOCKS, book: BOOK_V3 },
        (index) => {
          jumps.push(index);
        }
      )
    );
    expect(result.summary).toBe('2 added, 2 removed, 1 changed.');
    expect(result.total).toBe(5);
    expect(result.changes[0]?.label).toBe('paragraph in The crossing');

    const preface = el(result.preface as HTMLElement);
    // The titles match, so the only thing above the list is its heading.
    expect(preface.children.map((child) => child.className)).toEqual([
      'diff-chapters',
    ]);
    const section = preface.children[0]!;
    expect(section.children[0]?.textContent).toBe('Chapters');
    const controls = chapterControls(result.preface as HTMLElement);
    expect(controls.map((control) => control.tagName)).toEqual([
      'button',
      'button',
      'button',
      'div',
    ]);
    expect(
      controls
        .slice(0, 3)
        .map((control) => [
          control.children[0]?.textContent,
          control.children[1]?.textContent,
          control.className,
        ])
    ).toEqual([
      ['The crossing', '1 change', 'diff-chapter-row diff-chapter-changed'],
      ['Interlude', 'removed', 'diff-chapter-row diff-chapter-removed'],
      ['Afterword', 'added', 'diff-chapter-row diff-chapter-added'],
    ]);
    expect(controls[3]?.children[0]?.textContent).toBe('1 unchanged chapter');

    for (const control of controls.slice(0, 3)) {
      control.dispatchEvent(new Event('click'));
    }
    expect(jumps).toEqual([0, 1, 3]);
  } finally {
    dom.restore();
  }
});

test('without a jump, chapter rows are text, not buttons', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const result = diffed(
      documentComparisonSpec('epub', ui).diff(
        { blocks: BOOK_V2_BLOCKS, book: BOOK_V2 },
        { blocks: BOOK_V3_BLOCKS, book: BOOK_V3 }
      )
    );
    const controls = chapterControls(result.preface as HTMLElement);
    expect(controls[0]?.tagName).toBe('div');
    expect(controls[0]?.className).toBe(
      'diff-chapter-row diff-chapter-changed'
    );
  } finally {
    dom.restore();
  }
});

test('a retitled book with unchanged text shows the title line and no chapter list', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const retitled: EpubBook = {
      ...BOOK_V2,
      title: 'River journal: second edition',
    };
    const result = diffed(
      documentComparisonSpec('epub', ui).diff(
        { blocks: BOOK_V2_BLOCKS, book: BOOK_V2 },
        { blocks: BOOK_V2_BLOCKS, book: retitled }
      )
    );
    expect(result.changed).toBe(false);
    expect(result.summary).toBe(NO_TEXT);
    const preface = el(result.preface as HTMLElement);
    expect(preface.children.map((child) => child.className)).toEqual([
      'diff-title-line',
    ]);
    expect(preface.children[0]?.textContent).toBe(
      'The title changed from River journal to River journal: second edition.'
    );
  } finally {
    dom.restore();
  }
});

test('a chapter without a contents title is named by its position', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const named: EpubBook = {
      ...BOOK_V2,
      spine: [
        { path: 'ch1.xhtml', linear: true },
        { path: 'ch2.xhtml', linear: true },
      ],
      toc: [{ label: 'Opening', path: 'ch1.xhtml', depth: 0 }],
    };
    const result = diffed(
      documentComparisonSpec('epub', ui).diff(
        {
          blocks: [
            { kind: 'heading', text: 'Opening', part: 0 },
            { kind: 'paragraph', text: 'one', part: 1 },
          ],
          book: named,
        },
        {
          blocks: [
            { kind: 'heading', text: 'Opening', part: 0 },
            { kind: 'paragraph', text: 'two', part: 1 },
          ],
          book: named,
        }
      )
    );
    expect(result.changes[0]?.label).toBe('paragraph in Section 2');
    expect(
      chapterControls(result.preface as HTMLElement)[0]?.children[0]
        ?.textContent
    ).toBe('Section 2');
  } finally {
    dom.restore();
  }
});

test('a title change with changed text shows the title line above the chapter list', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const result = diffed(
      documentComparisonSpec('epub', ui).diff(
        { blocks: BOOK_V2_BLOCKS, book: BOOK_V2 },
        {
          blocks: BOOK_V3_BLOCKS,
          book: { ...BOOK_V3, title: 'River journal: second edition' },
        }
      )
    );
    const preface = el(result.preface as HTMLElement);
    expect(preface.children.map((child) => child.className)).toEqual([
      'diff-title-line',
      'diff-chapters',
    ]);
  } finally {
    dom.restore();
  }
});

test('too many edits are named, not outlined', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    const many = (prefix: string): DocumentBlock[] =>
      Array.from(
        { length: 2_501 },
        (_, i): DocumentBlock => ({
          kind: 'paragraph',
          text: `${prefix} ${i}`,
          part: 0,
        })
      );
    expect(
      documentComparisonSpec('docx', ui).diff(
        { blocks: many('before') },
        { blocks: many('after') }
      )
    ).toEqual({ unavailable: TOO_MANY });
  } finally {
    dom.restore();
  }
});

test('a book without its package cannot be compared chapter by chapter', () => {
  const dom = installDom();
  try {
    const { ui } = probeUi();
    expect(
      documentComparisonSpec('epub', ui).diff(
        { blocks: BOOK_V2_BLOCKS },
        { blocks: BOOK_V3_BLOCKS, book: BOOK_V3 }
      )
    ).toEqual({ unavailable: UNREADABLE });
  } finally {
    dom.restore();
  }
});
