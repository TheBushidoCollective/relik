import { indexZip, type ZipIndex } from '@relic/format/zip-index';
import { scanForbiddenDtd } from '@relic/format/xml';
import type { RelicContent } from './content.ts';
import type {
  DocumentBlock,
  DocumentStateMessage,
  EpubBook,
  RenderDocumentMessage,
} from './frame-document-protocol.ts';
import { frameModuleText } from './frame-modules.ts';

const LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 10000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};

export interface DocumentFrame {
  readonly frame: HTMLIFrameElement;
  readonly linkConfirm: HTMLElement;
  readonly linkRemembered: HTMLElement;
  dispose(): void;
}

/** How long a comparison frame may take to report its blocks once it is ready. */
export const DOCUMENT_BLOCKS_WAIT_MS = 10_000;

/** What a comparison learns about one version. */
export type DocumentSnapshotResult =
  | {
      readonly kind: 'blocks';
      readonly blocks: readonly DocumentBlock[];
      /** The package the parent read, for an EPUB. */
      readonly book?: EpubBook;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'failed'
        | 'protected'
        | 'too-large'
        | 'invalid'
        | 'timeout';
    };

/**
 * Opens a frame for one document. A comparison frame reports its blocks through
 * `onBlocks`. A frame that was not asked to compare never calls it.
 */
export type CreateDocumentFrame = (
  payload: RenderDocumentMessage,
  transfer: Transferable[],
  onState: (state: DocumentStateMessage) => void,
  onBlocks: (blocks: readonly DocumentBlock[] | null | 'invalid') => void
) => DocumentFrame;

export interface DocumentParts {
  readonly ok?: true;
  readonly parts: readonly string[];
  readonly xmlParts: ReadonlySet<string>;
  readonly book?: EpubBook;
}

// Selectors must scan package metadata before parsing it.
export type SelectDocumentParts = (
  index: ZipIndex,
  signal?: AbortSignal
) => Promise<
  | DocumentParts
  | {
      readonly ok: false;
      readonly reason: 'protected' | 'corrupt' | 'too-large';
    }
>;
export type DocumentWatchdog = ((state: DocumentStateMessage) => void) & {
  cancel(): void;
};

/** Accept the first state only. A timeout closes the same gate. */
export function documentWatchdog(
  onState: (state: DocumentStateMessage) => void,
  delay = 30000
): DocumentWatchdog {
  let settled = false;
  const timer = setTimeout(
    () =>
      finish({
        type: 'relic:document-state',
        state: 'failed',
        reason: 'corrupt',
      }),
    delay
  );
  function finish(state: DocumentStateMessage): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onState(state);
  }
  finish.cancel = () => {
    settled = true;
    clearTimeout(timer);
  };
  return finish;
}

/**
 * Mounts one document in its own frame. Given `compare`, the frame is asked to
 * report its blocks, and the mount reports exactly one snapshot: the blocks, or
 * the reason there are none. A render that fails takes its frame away. Every
 * other outcome leaves the frame on screen.
 */
export async function mountDocumentRoute(
  root: HTMLElement,
  content: RelicContent,
  format: 'docx' | 'epub',
  selectParts: SelectDocumentParts,
  createFrame: CreateDocumentFrame,
  download: () => void,
  compare?: { readonly onSnapshot: (result: DocumentSnapshotResult) => void }
): Promise<void> {
  let disposed = false;
  let reported = false;
  let book: EpubBook | undefined;
  let cancelBlocksWait: (() => void) | undefined;
  const controller = new AbortController();
  let handle: DocumentFrame | undefined;
  let finish: DocumentWatchdog | undefined;
  const observer =
    typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(() => {
          if (!root.isConnected) dispose();
        });
  observer?.observe(document, { childList: true, subtree: true });
  // A comparison hears one answer, whatever ends the mount. The first one wins.
  const report = (result: DocumentSnapshotResult): void => {
    if (reported || compare === undefined) return;
    reported = true;
    cancelBlocksWait?.();
    compare.onSnapshot(result);
  };
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // A mount that ends before it reports still settles its comparison.
    report({ kind: 'unavailable', reason: 'failed' });
    controller.abort();
    observer?.disconnect();
    finish?.cancel();
    cancelBlocksWait?.();
    handle?.dispose();
    handle = undefined;
  }
  const fail = (
    reason?:
      | Extract<DocumentStateMessage, { state: 'failed' }>['reason']
      | 'protected'
  ) => {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent =
      reason === 'protected'
        ? 'This ebook is protected by DRM and cannot be shown.'
        : reason === 'image-dimensions-unknown'
          ? 'This document contains an image whose dimensions could not be checked. Download it to view it.'
          : 'This document could not be shown.';
    const button = document.createElement('button');
    button.className = 'primary';
    button.type = 'button';
    button.textContent = 'Download';
    button.addEventListener('click', download);
    card.append(title, button);
    root.replaceChildren(card);
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { detail: 'error', bubbles: true })
    );
  };
  // Past this wait, the comparison goes on without outlines and both frames
  // stay on screen.
  const awaitBlocks = (): void => {
    const timer = setTimeout(
      () => report({ kind: 'unavailable', reason: 'timeout' }),
      DOCUMENT_BLOCKS_WAIT_MS
    );
    cancelBlocksWait = () => clearTimeout(timer);
  };
  const onBlocks = (
    blocks: readonly DocumentBlock[] | null | 'invalid'
  ): void => {
    if (blocks === null) report({ kind: 'unavailable', reason: 'too-large' });
    else if (blocks === 'invalid')
      report({ kind: 'unavailable', reason: 'invalid' });
    else
      report({
        kind: 'blocks',
        blocks,
        ...(book === undefined ? {} : { book }),
      });
  };
  try {
    if (!root.isConnected) {
      dispose();
      return;
    }
    const result = await indexZip(
      content,
      LIMITS,
      undefined,
      controller.signal
    );
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
    if (!result.ok) throw new Error(result.reason);
    const index = result.index;
    const selection = await selectParts(index, controller.signal);
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
    if (selection.ok === false) {
      // A protected book is named as protected. Any other refusal shows the
      // same card a failed render shows, so the comparison says the same.
      report({
        kind: 'unavailable',
        reason: selection.reason === 'protected' ? 'protected' : 'failed',
      });
      dispose();
      fail(selection.reason);
      return;
    }
    book = selection.book;
    const selected = new Set(selection.parts);
    if (
      selected.size !== selection.parts.length ||
      [...selection.xmlParts].some((name) => !selected.has(name))
    )
      throw new Error('Invalid document part selection');
    const entries: [string, Uint8Array][] = [];
    const buffers: Transferable[] = [];
    for (const name of selection.parts) {
      const info = index.entries.get(name);
      if (info?.kind !== 'file') throw new Error('Missing document part');
      const read = await index.read(name);
      if (disposed || !root.isConnected) {
        dispose();
        return;
      }
      if (!read.ok) throw new Error(read.reason);
      if (selection.xmlParts.has(name) && scanForbiddenDtd(read.bytes, format))
        throw new Error('Forbidden DTD');
      const bytes = read.bytes;
      if (!(bytes.buffer instanceof ArrayBuffer))
        throw new Error('Invalid entry buffer');
      entries.push([name, bytes]);
      buffers.push(bytes.buffer);
    }
    const module = await frameModuleText(format);
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
    const payload: RenderDocumentMessage = {
      type: 'relic:render-document',
      format,
      module,
      entries,
      ...(selection.book === undefined ? {} : { book: selection.book }),
      ...(compare === undefined ? {} : { compare: true as const }),
    };
    finish = documentWatchdog((state) => {
      if (disposed || !root.isConnected) {
        dispose();
        return;
      }
      if (state.state === 'failed') {
        const frame = handle?.frame;
        report({ kind: 'unavailable', reason: 'failed' });
        dispose();
        frame?.remove();
        fail(state.reason);
      } else {
        if (compare !== undefined) awaitBlocks();
        root.dispatchEvent(new CustomEvent('relic-repaint', { bubbles: true }));
      }
    });
    const created = createFrame(payload, buffers, finish, onBlocks);
    if (disposed) {
      created.dispose();
      return;
    }
    handle = created;
    if (!root.isConnected) {
      dispose();
      return;
    }
    root.replaceChildren(
      handle.linkRemembered,
      handle.linkConfirm,
      handle.frame
    );
  } catch {
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
    report({ kind: 'unavailable', reason: 'failed' });
    dispose();
    fail();
  }
}
