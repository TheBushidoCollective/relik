/**
 * Types for the side-by-side comparison shell and the lazy modules it loads.
 *
 * Types only. This file has no runtime code and imports nothing at runtime,
 * so a lazily loaded comparison module can name these shapes without loading
 * the viewer's main module.
 */
import type { ChangeJump, RenderedChange, TreeDiff } from './domdiff.ts';
import type {
  DocumentBlock,
  DocumentStateMessage,
  RenderDocumentMessage,
} from './frame-document-protocol.ts';
import type { Anchor, Mark } from './rendered-tree.ts';
import type { ScrollPosition } from './scroll-landmark.ts';
import type { ReadyView } from './viewer.ts';

/** What the shell shows beside one comparison: its changes and their count. */
export interface ChangeReport {
  readonly changes: readonly RenderedChange[];
  /** The count the sidebar shows. It can exceed `changes.length`. */
  readonly total: number;
  readonly summary: string;
  readonly onJump?: (index: number) => void;
  readonly preface?: HTMLElement;
}

/** One side of a paired comparison, with its snapshot and its marks. */
export interface ComparisonPane<S> {
  readonly element: HTMLElement;
  /** Resolves to this side's snapshot, or to null when it could not be read. */
  readonly snapshot: Promise<S | null>;
  /** Why this side could not be shown, once it could not. */
  failure?(): string | undefined;
  annotate(marks: readonly Mark[], anchors: readonly Anchor[]): void;
  readonly setScroll?: (p: ScrollPosition) => void;
  readonly revealChange?: (changeId: string, top: number) => boolean;
}

/** A diff of two snapshots, or the reason there is none to show. */
export type PairedResult =
  | (TreeDiff & { readonly total: number; readonly preface?: HTMLElement })
  | { readonly unavailable: string };

/** What one kind of paired comparison needs from the shell. */
export interface PairedComparisonSpec<S> {
  readonly mode: 'markdown' | 'rendered' | 'docx' | 'epub';
  readonly label: string;
  /** The line that says what is compared and what is not. */
  readonly scope?: string;
  readonly snapshotTimeoutMs: number;
  /** The copy shown when the comparison cannot be drawn. */
  readonly unavailable: string;
  /** Whether the panes keep their scroll in step by landmarks or by frames. */
  readonly sync: 'landmark' | 'frame';
  pane(view: ReadyView): ComparisonPane<S>;
  diff(before: S, after: S): PairedResult;
}

/** Previous and next change controls, with the current position. */
export interface ChangeNav {
  readonly element: HTMLElement;
  setJumps(jumps: ArrayLike<ChangeJump>): void;
  goTo(index: number): void;
  /** Moves by one change and returns where it landed, if there is one. */
  step(delta: 1 | -1): number | undefined;
}

export interface CompareStageOptions {
  readonly before: HTMLElement;
  readonly after: HTMLElement;
  readonly current: ReadyView;
  readonly historical: ReadyView;
  readonly nav: ChangeNav;
}

export interface CompareStage {
  readonly stage: HTMLElement;
  readonly controls: HTMLElement;
  readonly beforePane: HTMLElement;
  readonly afterPane: HTMLElement;
}

/** A document in its own frame, and the handle a comparison drives it with. */
export interface DocumentFrameHandle {
  readonly frame: HTMLIFrameElement;
  readonly linkConfirm: HTMLElement;
  readonly linkRemembered: HTMLElement;
  dispose(): void;
  annotate(m: readonly Mark[], a?: readonly Anchor[]): void;
  setScroll(p: ScrollPosition): void;
  revealChange(id: string, top: number): void;
}

/** The services a lazy comparison module receives from the shell. */
export interface CompareUi {
  buildCompareStage(o: CompareStageOptions): CompareStage;
  buildChangeNav(d: {
    readonly reveal: (jump: ChangeJump, top: number) => boolean;
  }): ChangeNav;
  renderChangeList(
    changes: readonly RenderedChange[],
    onJump?: (i: number) => void,
    more?: number
  ): HTMLElement;
  notice(text: string): HTMLElement;
  noChanges(summary: string): HTMLElement;
  renderSingleVersion(view: ReadyView, reason: string): HTMLElement;
  documentFrame(
    view: ReadyView,
    payload: RenderDocumentMessage,
    transfer: Transferable[],
    onState: (s: DocumentStateMessage) => void,
    onBlocks: (b: readonly DocumentBlock[] | null | 'invalid') => void
  ): DocumentFrameHandle;
  download(view: ReadyView): void;
}
