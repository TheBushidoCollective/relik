/**
 * A DOCX or EPUB comparison, side by side.
 *
 * Each version is mounted through the document route in its own frame, and the
 * frame reports its text and nothing else. The diff of that text runs here, on
 * the service origin, and a frame is only ever told which blocks to mark. This
 * module loads with the comparison shell and never sees markup.
 */
import { readEpubPackage } from '@relic/format/epub-package';
import {
  type BlockDiff,
  type ChapterRow,
  chapterRows,
  diffBlocks,
  epubDiffOptions,
} from './blockdiff.ts';
import type {
  CompareUi,
  ComparisonPane,
  DocumentFrameHandle,
  PairedComparisonSpec,
  PairedResult,
} from './compare-ui.ts';
import { selectDocxParts } from './document-payload-docx.ts';
import {
  type CreateDocumentFrame,
  type DocumentSnapshotResult,
  mountDocumentRoute,
} from './document-route.ts';
import type { DocumentBlock, EpubBook } from './frame-document-protocol.ts';
import type { ReadyView } from './viewer.ts';

/** One version as the comparison reads it: its blocks, and for a book its package. */
export interface DocumentSnapshot {
  readonly blocks: readonly DocumentBlock[];
  readonly book?: EpubBook;
}

/** A book with both halves present, which the chapter list needs. */
interface BookVersion {
  readonly blocks: readonly DocumentBlock[];
  readonly book: EpubBook;
}

/** The stage waits this long for both snapshots before it gives up on outlines. */
const SNAPSHOT_TIMEOUT_MS = 45_000;

const DOCX_SCOPE =
  'Compares the text of paragraphs, lists and tables. Page headers and footers, formatting, layout and image content are not compared.';
const EPUB_SCOPE =
  'Compares the text of each chapter. Formatting, layout and image content are not compared.';
const UNREADABLE =
  'Both versions are shown. Relik could not read their text, so changes are not outlined.';
const TOO_LONG =
  'Both versions are shown. They are too long for Relik to outline their changes.';
const TOO_MANY =
  'Both versions are shown. They differ in too many places for Relik to outline the changes.';

type Unavailable = Extract<
  DocumentSnapshotResult,
  { readonly kind: 'unavailable' }
>['reason'];

/** Why a version has no outlines, naming the version whose render it is. */
function unavailableCopy(reason: Unavailable, version: number): string {
  switch (reason) {
    case 'failed':
      return `Version ${version} could not be shown, so changes are not outlined.`;
    case 'protected':
      return `Version ${version} is protected by DRM, so changes are not outlined.`;
    case 'too-large':
      return TOO_LONG;
    case 'invalid':
    case 'timeout':
      return UNREADABLE;
  }
}

function documentPane(
  format: 'docx' | 'epub',
  view: ReadyView,
  ui: CompareUi
): ComparisonPane<DocumentSnapshot> {
  const element = document.createElement('div');
  element.className = format === 'docx' ? 'doc doc-document' : 'doc doc-html';
  // The comparison pane sizes its frame to this wrapper, so the wrapper fills it.
  element.style.height = '100%';
  const pending = Promise.withResolvers<DocumentSnapshot | null>();
  let frame: DocumentFrameHandle | undefined;
  let failure: string | undefined;
  let answered = false;
  const answer = (result: DocumentSnapshotResult): void => {
    if (answered) return;
    answered = true;
    if (result.kind === 'unavailable') {
      failure = unavailableCopy(result.reason, view.version);
      pending.resolve(null);
    } else if (format === 'docx' || result.book !== undefined) {
      pending.resolve({
        blocks: result.blocks,
        ...(result.book === undefined ? {} : { book: result.book }),
      });
    } else {
      // A book without its package has no chapters to compare.
      failure = UNREADABLE;
      pending.resolve(null);
    }
  };
  const createFrame: CreateDocumentFrame = (
    payload,
    transfer,
    onState,
    onBlocks
  ) => {
    frame = ui.documentFrame(view, payload, transfer, onState, onBlocks);
    return frame;
  };
  // The stage inserts this pane after it is built. Mounting waits for that
  // insertion, because a route gives up on a root that is not yet connected.
  queueMicrotask(() => {
    mountDocumentRoute(
      element,
      view.content,
      format,
      format === 'docx' ? selectDocxParts : readEpubPackage,
      createFrame,
      () => ui.download(view),
      { onSnapshot: answer }
    ).catch(() => answer({ kind: 'unavailable', reason: 'failed' }));
  });
  return {
    element,
    snapshot: pending.promise,
    failure: () => failure,
    annotate: (marks, anchors) => frame?.annotate(marks, anchors),
    setScroll: (position) => frame?.setScroll(position),
    revealChange: (changeId, top) => {
      if (frame === undefined) return false;
      frame.revealChange(changeId, top);
      return true;
    },
  };
}

function diffDocuments(
  format: 'docx' | 'epub',
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  goTo?: (index: number) => void
): PairedResult {
  if (format === 'docx') {
    const diff = diffBlocks(before.blocks, after.blocks);
    return diff === 'too-many-changes' ? { unavailable: TOO_MANY } : diff;
  }
  if (before.book === undefined || after.book === undefined)
    return { unavailable: UNREADABLE };
  const diff = diffBlocks(
    before.blocks,
    after.blocks,
    epubDiffOptions(before.book, after.book)
  );
  if (diff === 'too-many-changes') return { unavailable: TOO_MANY };
  const preface = bookPreface(
    { blocks: before.blocks, book: before.book },
    { blocks: after.blocks, book: after.book },
    diff,
    goTo
  );
  return preface === undefined ? diff : { ...diff, preface };
}

/**
 * What a book's comparison says before its changes: a title line when the title
 * changed, and the chapter list when the text did. Nothing when neither did.
 */
function bookPreface(
  before: BookVersion,
  after: BookVersion,
  diff: BlockDiff,
  goTo?: (index: number) => void
): HTMLElement | undefined {
  const title = titleLine(before.book.title, after.book.title);
  if (title === undefined && !diff.changed) return undefined;
  const preface = document.createElement('div');
  if (title !== undefined) preface.append(title);
  if (diff.changed)
    preface.append(chapterList(chapterRows(before, after, diff), goTo));
  return preface;
}

/** The title line, when the title changed between the two versions. */
function titleLine(before: string, after: string): HTMLElement | undefined {
  const from = before.replace(/\s+/g, ' ').trim();
  const to = after.replace(/\s+/g, ' ').trim();
  if (from === to) return undefined;
  const line = document.createElement('p');
  line.className = 'diff-title-line';
  line.textContent = `The title changed from ${from} to ${to}.`;
  return line;
}

/**
 * The Chapters list: each changed, added or removed chapter in reading order,
 * then one line for the chapters that did not change.
 */
function chapterList(
  rows: readonly ChapterRow[],
  goTo?: (index: number) => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'diff-chapters';
  const heading = document.createElement('h2');
  heading.textContent = 'Chapters';
  const list = document.createElement('ul');
  let unchanged = 0;
  for (const row of rows) {
    if (row.status === 'unchanged') unchanged += 1;
    else list.append(chapterItem(row, goTo));
  }
  if (unchanged > 0) list.append(unchangedItem(unchanged));
  section.append(heading, list);
  return section;
}

/** A chapter that has a change to jump to is a button; any other is text. */
function chapterItem(
  row: ChapterRow,
  goTo?: (index: number) => void
): HTMLElement {
  const item = document.createElement('li');
  const jump = row.firstJump;
  const onPick =
    goTo === undefined || jump === undefined ? undefined : () => goTo(jump);
  const control = document.createElement(
    onPick === undefined ? 'div' : 'button'
  );
  control.className = `diff-chapter-row diff-chapter-${row.status}`;
  if (onPick !== undefined) {
    control.setAttribute('type', 'button');
    control.addEventListener('click', onPick);
  }
  const label = document.createElement('span');
  label.textContent = row.label;
  const state = document.createElement('span');
  state.className = 'diff-chapter-state';
  state.textContent = chapterState(row);
  control.append(label, state);
  item.append(control);
  return item;
}

function chapterState(row: ChapterRow): string {
  if (row.status === 'added') return 'added';
  if (row.status === 'removed') return 'removed';
  return row.changes === 1 ? '1 change' : `${row.changes} changes`;
}

function unchangedItem(count: number): HTMLElement {
  const item = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'diff-chapter-row diff-chapter-unchanged';
  const text = document.createElement('span');
  text.textContent =
    count === 1 ? '1 unchanged chapter' : `${count} unchanged chapters`;
  row.append(text);
  item.append(row);
  return item;
}

/**
 * The comparison of two versions of one DOCX or EPUB, for the shell to draw.
 * The shell's services come in through `ui`, which is how this lazy module
 * reaches frames and copy without importing the shell.
 */
export function documentComparisonSpec(
  format: 'docx' | 'epub',
  ui: CompareUi
): PairedComparisonSpec<DocumentSnapshot> {
  return {
    mode: format,
    label: format === 'docx' ? 'Document comparison' : 'Book comparison',
    scope: format === 'docx' ? DOCX_SCOPE : EPUB_SCOPE,
    snapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
    unavailable: UNREADABLE,
    sync: 'frame',
    pane: (view) => documentPane(format, view, ui),
    diff: (before, after, goTo) => diffDocuments(format, before, after, goTo),
  };
}
