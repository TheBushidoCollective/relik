import type { CommentAnchor } from '@relic/format';
import type { RelicContent } from './content.ts';

/**
 * The eager shell's half of the windowed source view. Indexing, scanning and
 * rendering live in `text-window.ts`, loaded only for over-limit documents.
 */
export interface WindowMark {
  readonly id: string;
  readonly anchor: CommentAnchor;
  readonly resolved?: boolean;
}
export interface TextWindowHandle {
  readonly ready: Promise<void>;
  setMarks(marks: readonly WindowMark[]): void;
  reveal(id: string): Promise<void>;
  dispose(): void;
}

const handles = new WeakMap<HTMLElement, TextWindowHandle>();

export function textWindowFor(host: HTMLElement): TextWindowHandle | undefined {
  const root = host.matches?.('.text-window')
    ? host
    : host.querySelector<HTMLElement>('.text-window');
  return root ? handles.get(root) : undefined;
}

/**
 * Registers synchronously, so a caller can tell windowed marks from ordinary
 * text marks at once, and marks arriving before the renderer loads are kept.
 */
export function mountTextWindow(
  root: HTMLElement,
  content: RelicContent
): TextWindowHandle {
  root.classList.add('doc', 'text-window');
  let view: TextWindowHandle | undefined;
  let marks: readonly WindowMark[] | undefined;
  let disposed = false;
  let observer: MutationObserver | undefined;
  const loaded = import('./text-window.ts').then(
    ({ renderTextWindow }) => {
      // A view disposed while its renderer loaded must never mount.
      if (disposed) return;
      view = renderTextWindow(root, content);
      if (marks) view.setMarks(marks);
      return view;
    },
    (error: unknown) => {
      if (!disposed) {
        root.textContent = 'Source could not be loaded.';
        root.dispatchEvent(
          new CustomEvent('relic:render-state', {
            bubbles: true,
            detail: 'error',
          })
        );
      }
      throw error;
    }
  );
  const ready = loaded.then((loadedView) => loadedView?.ready);
  // Failure is reported on the root; an unawaited handle must not also throw.
  ready.catch(() => {});
  const handle: TextWindowHandle = {
    ready,
    setMarks(next) {
      if (view) view.setMarks(next);
      else marks = next;
    },
    reveal: (id) => loaded.then((loadedView) => loadedView?.reveal(id)),
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      view?.dispose();
      handles.delete(root);
    },
  };
  handles.set(root, handle);
  root.addEventListener('cleanup', () => handle.dispose(), { once: true });
  if (typeof MutationObserver === 'function') {
    let connected = root.isConnected;
    observer = new MutationObserver(() => {
      connected ||= root.isConnected;
      if (connected && !root.isConnected) handle.dispose();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  return handle;
}
