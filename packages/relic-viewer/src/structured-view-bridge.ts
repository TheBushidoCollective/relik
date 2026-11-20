/**
 * The contract between the code route and the structured views (plan A0,
 * section 3 and section 5; `spec/viewer.md` section 1).
 *
 * A structured view draws a file as a table, a tree, a list of cues, or a
 * notebook. Each view module is loaded lazily and mounts into a root element
 * the route created. The source view is drawn into that root at once, so the
 * file is readable while the view loads, and it stays in place whenever a view
 * cannot show the file or when Suggesting switches the reader to Source.
 *
 * A view never writes a comment and never sees the relic key. It reports marks
 * and selections as the `CommentAnchor` values `@relic/format` defines, and it
 * keeps every mark on the A1 coordinates of the published file, so a sort, a
 * find or a scroll that moves a row leaves the mark on the record it was made on.
 *
 * View modules start as stubs that return nothing, so every file keeps drawing
 * the source view until its owner builds the view.
 */

import { type CommentAnchor, filenameExtension } from '@relic/format';
import { requestSurfaceSwap } from './suggestion-surface.ts';

/** A notebook whose whole text is larger than this is shown as text. */
export const NOTEBOOK_RENDER_LIMIT_BYTES = 50 * 1024 * 1024;

export const NOTEBOOK_TOO_LARGE_NOTICE =
  'This notebook is too large to show as a notebook, so its text is shown.';

/** The structured views a file can open in. */
export type StructuredKind = 'table' | 'tree' | 'cues' | 'notebook';

/** The line a structured view puts in its marker, so readers know no author code ran. */
export const STRUCTURED_MARKER_LABELS: Readonly<
  Record<StructuredKind, string>
> = {
  table: 'Shown as a table, no author code',
  tree: 'Shown as a tree, no author code',
  cues: 'Shown as subtitles, no author code',
  notebook: 'Rendered as a notebook, no author code',
};

/**
 * Looked up with `Object.hasOwn`, never by bare indexing: an inherited name
 * such as `constructor` must not match a file called `report.constructor`.
 */
const EXTENSION_KINDS: Readonly<Record<string, StructuredKind>> = {
  csv: 'table',
  tsv: 'table',
  json: 'tree',
  srt: 'cues',
  vtt: 'cues',
};

const MIMETYPE_KINDS: Readonly<Record<string, StructuredKind>> = {
  'text/csv': 'table',
  'text/tab-separated-values': 'table',
  'application/json': 'tree',
  'application/x-subrip': 'cues',
  'text/vtt': 'cues',
};

function ownKind(
  table: Readonly<Record<string, StructuredKind>>,
  key: string | undefined
): StructuredKind | undefined {
  if (key === undefined || !Object.hasOwn(table, key)) return undefined;
  return table[key];
}

/**
 * The structured view for a file on the code route, from its declared name and
 * type. The extension decides first; the declared type decides only when the
 * extension does not map. The bytes can still turn a file down inside the view,
 * which then shows its source.
 */
export function structuredKindFor(
  filename: string,
  mimetype: string
): StructuredKind | undefined {
  const byExtension = ownKind(EXTENSION_KINDS, filenameExtension(filename));
  if (byExtension !== undefined) return byExtension;
  const type = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  return ownKind(MIMETYPE_KINDS, type);
}

/**
 * Whether a file's whole text is an nbformat 4 notebook: an object whose
 * `nbformat` is 4 and whose `cells` is an array. This decides only the route.
 * The notebook view parses the notebook for display.
 */
export function isNbformat4Notebook(bytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  return record['nbformat'] === 4 && Array.isArray(record['cells']);
}

/** What a view module receives. */
export interface StructuredMount {
  /** The element the view draws into. It is empty when the view mounts. */
  readonly root: HTMLElement;
  readonly filename: string;
  readonly mimetype: string;
  /** The file's text, decoded once for the view. */
  readonly source: string;
  /** Draws the source view. Used while loading, on fallback, and for Source. */
  readonly sourceView: () => HTMLElement;
  /**
   * Returns the source view with a line saying why this view cannot show the
   * file. A view calls it and then returns `undefined`.
   */
  readonly reportUnshown: (reason: string) => void;
}

/** What a mounted view answers. Marks and selections are anchors, never DOM. */
export interface StructuredPart {
  /** Puts a mark on the view for this comment. Returns whether it landed. */
  paintMark(anchor: CommentAnchor, commentId: string): boolean;
  /** Removes every mark, so the next paint pass starts from nothing. */
  clearMarks(): void;
  /** The anchor for the reader's current selection, when the view has one. */
  selectionAnchor(): CommentAnchor | undefined;
  /** Brings the anchored cell, node, cue or notebook cell into view. */
  reveal(anchor: CommentAnchor, commentId?: string): void;
  /** Stops the view and frees its listeners. */
  dispose(): void;
}

/** What a view module exports. `undefined` means the module cannot show this file. */
export interface StructuredViewModule {
  mountView(mount: StructuredMount): StructuredPart | undefined;
}

/** What the route holds for a mounted structured view. */
export interface StructuredViewHandle extends StructuredPart {
  readonly kind: StructuredKind;
  /** True only while a structured view is drawn, so marks can be placed. */
  readonly structured: boolean;
  /** Settles once the view is drawn or the source view is shown. Never rejects. */
  readonly ready: Promise<void>;
  /** Replaces the structured view with the source view, until `showStructured`. */
  showSource(): void;
  /** Returns to the structured view after `showSource`, when this view can draw the file. */
  showStructured(): void;
  /** True while the source view stands in for the structured view by the reader's choice. */
  readonly showingSource: boolean;
  /** False once this view has refused the file, so there is no structured view to return to. */
  readonly structuredAvailable: boolean;
}

const loaders: Readonly<
  Record<StructuredKind, () => Promise<StructuredViewModule>>
> = {
  table: () => import('./csv-view.ts'),
  tree: () => import('./json-tree-view.ts'),
  cues: () => import('./cue-view.ts'),
  notebook: () => import('./notebook-view.ts'),
};

const handles = new WeakMap<HTMLElement, StructuredViewHandle>();

/** The handle for a structured view inside `host`, drawn or not. */
export function structuredViewFor(
  host: HTMLElement
): StructuredViewHandle | undefined {
  const root = host.matches?.('.structured-view')
    ? host
    : host.querySelector<HTMLElement>('.structured-view');
  return root ? handles.get(root) : undefined;
}

/**
 * The handle for a structured view of `kind` inside `host`, only when that
 * view is drawn. Anchor adapters use this, so a mark is never offered to a
 * view that cannot place it.
 */
export function drawnStructuredView(
  host: HTMLElement,
  kind: StructuredKind
): StructuredViewHandle | undefined {
  const handle = structuredViewFor(host);
  return handle?.kind === kind && handle.structured ? handle : undefined;
}

/**
 * Registers the view synchronously, so marks arriving before the view loads
 * can be asked of it at once. The source view is drawn immediately; the
 * structured view replaces it when the module mounts.
 *
 * Settles `ready` and dispatches `relic:render-state` ('ready') on the root
 * once the view is drawn or the source is shown, so the stage waits for it the
 * way it waits for a model or a PDF.
 */
export function mountStructuredView(
  root: HTMLElement,
  kind: StructuredKind,
  mount: Omit<StructuredMount, 'root' | 'reportUnshown'>
): StructuredViewHandle {
  root.classList.add('structured-view', `structured-${kind}`);
  root.replaceChildren(mount.sourceView());

  let part: StructuredPart | undefined;
  let drawn = false;
  let disposed = false;
  let wantsSource = false;
  let refused = false;
  let loaded: StructuredViewModule | undefined;
  let unshownReason: string | undefined;
  const sourceWithNotice = (): HTMLElement => {
    const source = mount.sourceView();
    if (unshownReason === undefined) return source;
    const note = document.createElement('p');
    note.className = 'structured-notice';
    note.setAttribute('role', 'status');
    note.textContent = unshownReason;
    const wrap = document.createElement('div');
    wrap.append(note, source);
    return wrap;
  };
  const { promise: ready, resolve: settle } = Promise.withResolvers<void>();

  const drop = (): void => {
    part?.dispose();
    part = undefined;
    drawn = false;
  };
  const replaceWithSource = (): void => {
    drop();
    root.replaceChildren(mount.sourceView());
  };
  /**
   * Tells the page which view is on screen. The route's toggle follows it, and
   * the marks are painted again, because a view drawn again starts with none.
   */
  const announce = (): void => {
    root.dispatchEvent(
      new CustomEvent('relic:structured-state', {
        bubbles: true,
        detail: drawn ? 'structured' : 'source',
      })
    );
  };
  /** Draws the loaded module into the root, or the source with the reason it cannot. */
  const draw = (): boolean => {
    if (loaded === undefined || disposed || wantsSource) return false;
    if (!requestSurfaceSwap(root)) {
      wantsSource = true;
      return false;
    }
    drop();
    root.replaceChildren();
    unshownReason = undefined;
    try {
      const mounted = loaded.mountView({
        ...mount,
        root,
        reportUnshown: (reason) => {
          unshownReason = reason;
        },
      });
      if (mounted === undefined) {
        refused = true;
        root.replaceChildren(sourceWithNotice());
      } else {
        refused = false;
        part = mounted;
        drawn = true;
      }
    } catch {
      // A view that throws leaves a partly drawn root. The source replaces it.
      refused = true;
      root.replaceChildren(mount.sourceView());
    }
    return true;
  };
  const finish = (): void => {
    settle();
    root.dispatchEvent(
      new CustomEvent('relic:render-state', { bubbles: true, detail: 'ready' })
    );
  };

  loaders[kind]().then(
    (module) => {
      loaded = module;
      if (!disposed && !wantsSource && draw()) announce();
      finish();
    },
    () => {
      // The module did not load. The source view already stands in the root.
      finish();
    }
  );

  const handle: StructuredViewHandle = {
    kind,
    get structured() {
      return drawn;
    },
    get showingSource() {
      return wantsSource;
    },
    get structuredAvailable() {
      return !refused;
    },
    ready,
    paintMark: (anchor, commentId) =>
      part?.paintMark(anchor, commentId) ?? false,
    clearMarks: () => part?.clearMarks(),
    selectionAnchor: () => part?.selectionAnchor(),
    reveal: (anchor, commentId) => part?.reveal(anchor, commentId),
    showSource() {
      if (!requestSurfaceSwap(root)) return;
      wantsSource = true;
      replaceWithSource();
      announce();
    },
    showStructured() {
      if (!wantsSource) return;
      wantsSource = false;
      // Before the module has loaded, the load draws the view itself.
      if (loaded !== undefined && !disposed && draw()) announce();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      drop();
      handles.delete(root);
    },
  };
  handles.set(root, handle);
  root.addEventListener('cleanup', () => handle.dispose(), { once: true });
  return handle;
}
