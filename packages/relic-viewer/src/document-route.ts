import { indexZip, type ZipIndex } from '@relic/format/zip-index';
import { scanForbiddenDtd } from '@relic/format/xml';
import type { RelicContent } from './content.ts';
import type {
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
export type CreateDocumentFrame = (
  payload: RenderDocumentMessage,
  transfer: Transferable[],
  onState: (state: DocumentStateMessage) => void
) => DocumentFrame;

export interface DocumentParts {
  readonly ok?: true;
  readonly parts: readonly string[];
  readonly xmlParts: ReadonlySet<string>;
  readonly book?: EpubBook;
}

// Selectors must scan package metadata before parsing it.
export type SelectDocumentParts = (index: ZipIndex) => Promise<
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

export async function mountDocumentRoute(
  root: HTMLElement,
  content: RelicContent,
  format: 'docx' | 'epub',
  selectParts: SelectDocumentParts,
  createFrame: CreateDocumentFrame,
  download: () => void
): Promise<void> {
  let disposed = false;
  let handle: DocumentFrame | undefined;
  let finish: DocumentWatchdog | undefined;
  const observer =
    typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(() => {
          if (!root.isConnected) dispose();
        });
  observer?.observe(document, { childList: true, subtree: true });
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    finish?.cancel();
    handle?.dispose();
    handle = undefined;
  }
  const fail = () => {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = 'This document could not be shown.';
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
  try {
    if (!root.isConnected) {
      dispose();
      return;
    }
    const result = await indexZip(content, LIMITS);
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
    if (!result.ok) throw new Error(result.reason);
    const index = result.index;
    const selection = await selectParts(index);
    if (selection.ok === false) throw new Error(selection.reason);
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
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
    };
    finish = documentWatchdog((state) => {
      if (state.state === 'failed') {
        const frame = handle?.frame;
        dispose();
        frame?.remove();
        fail();
      } else {
        root.dispatchEvent(new CustomEvent('relic-repaint', { bubbles: true }));
      }
    });
    handle = createFrame(payload, buffers, finish);
    root.replaceChildren(
      handle.linkRemembered,
      handle.linkConfirm,
      handle.frame
    );
  } catch {
    dispose();
    if (root.isConnected) fail();
  }
}
