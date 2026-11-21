import { indexZip } from '@relic/format/zip-index';
import { scanForbiddenDtd } from '@relic/format/xml';
import type { RelicContent } from './content.ts';
import type {
  DocumentStateMessage,
  RenderDocumentMessage,
} from './frame-document-protocol.ts';
import { frameModuleText } from './frame-modules.ts';

const LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 10000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};
const XML_PART = /(?:\.xml|\.rels|\.xhtml|\.html|\.htm|\.opf|\.ncx|\.svg)$/i;

export interface DocumentFrame {
  readonly frame: HTMLIFrameElement;
  readonly linkConfirm: HTMLElement;
  readonly linkRemembered: HTMLElement;
}
export type CreateDocumentFrame = (
  payload: RenderDocumentMessage,
  transfer: Transferable[],
  onState: (state: DocumentStateMessage) => void
) => DocumentFrame;

/** Accept the first state only. A timeout closes the same gate. */
export function documentWatchdog(
  onState: (state: DocumentStateMessage) => void,
  delay = 30000
): (state: DocumentStateMessage) => void {
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
  return finish;
}

export async function mountDocumentRoute(
  root: HTMLElement,
  content: RelicContent,
  format: 'docx' | 'epub',
  createFrame: CreateDocumentFrame,
  download: () => void
): Promise<void> {
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
    const result = await indexZip(content, LIMITS);
    if (!result.ok) throw new Error(result.reason);
    const index = result.index;
    if (
      format === 'epub' &&
      (index.entries.has('META-INF/rights.xml') ||
        index.entries.has('META-INF/license.lcpl') ||
        index.entries.has('META-INF/encryption.xml'))
    )
      throw new Error('Protected ebook');
    const entries: [string, Uint8Array][] = [];
    const buffers: Transferable[] = [];
    for (const [name, info] of index.entries) {
      if (info.kind !== 'file') continue;
      const read = await index.read(name);
      if (!read.ok) throw new Error(read.reason);
      if (XML_PART.test(name) && scanForbiddenDtd(read.bytes, format))
        throw new Error('Forbidden DTD');
      const bytes = read.bytes;
      if (!(bytes.buffer instanceof ArrayBuffer))
        throw new Error('Invalid entry buffer');
      entries.push([name, bytes]);
      buffers.push(bytes.buffer);
    }
    const module = await frameModuleText(format);
    if (!root.isConnected) return;
    const payload: RenderDocumentMessage = {
      type: 'relic:render-document',
      format,
      module,
      entries,
    };
    let handle: DocumentFrame;
    const finish = documentWatchdog((state) => {
      if (state.state === 'failed') {
        handle.frame.remove();
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
    if (root.isConnected) fail();
  }
}
