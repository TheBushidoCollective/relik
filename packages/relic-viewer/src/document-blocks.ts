/**
 * Reading the leaf blocks of a rendered document, and marking them, inside a
 * DOCX or EPUB frame.
 *
 * Like rendered-tree.ts this module reads nodes through a NodeLike shape, so a
 * stub can stand in for a DOM, and it is bundled only into the document frame
 * modules. It reads text and writes three attributes on the elements it found.
 * It never writes text or markup, and it compares nothing: the diff runs on the
 * service origin, in a lazy chunk.
 */
import {
  type DocumentBlock,
  type DocumentBlockKind,
  type DocumentBlockSnapshot,
  MAX_DOCUMENT_BLOCK_BYTES,
  MAX_DOCUMENT_BLOCKS,
  MAX_DOCUMENT_PARTS,
} from './frame-document-protocol.ts';
import { type Anchor, HIGHLIGHT_CSS, type Mark } from './rendered-tree.ts';

/**
 * Outlines for the two marks that need more than the tree's own rules. Added
 * keeps the solid outline from HIGHLIGHT_CSS, removed is dashed and struck
 * through, and changed is double. Both rules are `!important` like the rules
 * they follow, so the later one wins.
 *
 * The change Next change moved to is drawn as the shell draws it in a
 * same-origin pane: a heavier patina outline, here with a halo so it reads
 * against the changed block's own double outline. Comment styles are not in a
 * compare frame, so without this rule the current change looked like the rest.
 *
 * docx-preview zooms a page to fit the frame, and that scales the outline with
 * it. The rule divides by --relic-page-zoom, which the frame sets on each page
 * to that zoom, so the outline stays 3px on screen. EPUB frames set no
 * variable, so the fallback of 1 leaves their outline at 3px.
 */
export const DOCUMENT_HIGHLIGHT_CSS = `
[data-relic-diff='removed'] {
  outline-style: dashed !important;
  text-decoration: line-through !important;
}
[data-relic-diff='changed'] {
  outline-style: double !important;
  outline-width: 4px !important;
}
[data-relic-change-id].is-current-change {
  outline-style: solid !important;
  outline-width: calc(3px / var(--relic-page-zoom, 1)) !important;
  outline-color: rgb(31, 107, 100) !important;
  outline-offset: calc(3px / var(--relic-page-zoom, 1)) !important;
  box-shadow: 0 0 0 9px rgba(31, 107, 100, 0.22) !important;
}
`;

/**
 * The shape of a DOM node this module reads, so a stub can stand in for one.
 * Every member is optional and checked before use.
 */
interface NodeLike {
  readonly nodeType?: unknown;
  readonly tagName?: unknown;
  readonly nodeValue?: unknown;
  readonly childNodes?: unknown;
  readonly parentNode?: unknown;
  getAttribute?: (name: string) => unknown;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** How deep the walk recurses. Past this the document is refused, not partly read. */
const MAX_NESTING = 256;

// Tables keyed by tag name, which comes from the document. Each lookup asks
// `=== true` or `Object.hasOwn`, so a name such as `constructor` finds nothing.

/** Tags whose contents are never rendered, so never read. */
const SKIPPED_TAGS: Readonly<Record<string, true>> = {
  head: true,
  link: true,
  meta: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  title: true,
};

/**
 * Elements that are blocks. A block with no block inside it is one block of
 * its own. A block with block children is a container, and the loose text
 * between those children becomes a `text` block mapped to the container.
 */
const BLOCK_TAGS: Readonly<Record<string, true>> = {
  p: true,
  li: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  td: true,
  th: true,
  blockquote: true,
  pre: true,
  figcaption: true,
  caption: true,
  dt: true,
  dd: true,
  summary: true,
  address: true,
  div: true,
  section: true,
  article: true,
  aside: true,
  header: true,
  footer: true,
  main: true,
  figure: true,
  details: true,
};

/** The kind a tag gives its own block. Images and media are never containers. */
const OWN_KINDS: Readonly<Record<string, DocumentBlockKind>> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  li: 'list-item',
  td: 'table-cell',
  th: 'table-cell',
  blockquote: 'quote',
  pre: 'code',
  figcaption: 'caption',
  caption: 'caption',
  img: 'image',
  svg: 'image',
  picture: 'image',
  audio: 'media',
  video: 'media',
};

/**
 * The kind that a block's children inherit when their own tag gives none. A
 * paragraph inside a list item is a list item, and so on for cells and quotes.
 */
const CONTEXTS: Readonly<Record<string, DocumentBlockKind>> = {
  li: 'list-item',
  td: 'table-cell',
  th: 'table-cell',
  blockquote: 'quote',
};

/** A DOCX page's header and footer are chrome, not body text. */
const DOCX_SKIPPED: Readonly<Record<string, true>> = {
  header: true,
  footer: true,
};
const NO_SKIPS: Readonly<Record<string, true>> = {};

const MARK_KINDS: Readonly<Record<string, true>> = {
  added: true,
  changed: true,
  removed: true,
};

/** A document that cannot be read whole. Thrown, then turned into `null`. */
class Unreadable extends Error {}

/**
 * A step of the walk. Loose text waits for the block that will own it. A block
 * waits for the part it belongs to, which only the scope knows.
 */
type Piece =
  | {
      readonly raw: string;
      readonly kind?: undefined;
      readonly element?: undefined;
    }
  | {
      readonly raw: string;
      readonly kind: DocumentBlockKind;
      readonly element: NodeLike;
    };

interface Scope {
  readonly element: NodeLike;
  readonly part: number;
  readonly skipped: Readonly<Record<string, true>>;
}

function asNode(value: unknown): NodeLike | undefined {
  return typeof value === 'object' && value !== null
    ? (value as NodeLike)
    : undefined;
}

function childrenOf(node: NodeLike): readonly unknown[] {
  const list = node.childNodes;
  if (Array.isArray(list)) return list;
  // A NodeList is array-like: indexed and sized, with no array methods.
  if (
    typeof list === 'object' &&
    list !== null &&
    'length' in list &&
    typeof list.length === 'number'
  )
    return Array.from(list as ArrayLike<unknown>);
  return [];
}

function tagOf(node: NodeLike): string {
  return typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
}

function attributeOf(node: NodeLike, name: string): string | undefined {
  const value = node.getAttribute?.(name);
  return typeof value === 'string' ? value : undefined;
}

function hasClass(node: NodeLike, name: string): boolean {
  return (attributeOf(node, 'class') ?? '').split(/\s+/).includes(name);
}

/**
 * The UTF-8 bytes left in `budget` after `value`, or -1 once it no longer fits.
 * Counted from the code units, so nothing is encoded. This is the same count as
 * the validator in frame-document-protocol.ts, which refuses a message over budget.
 */
function spendUtf8(value: string, budget: number): number {
  if (value.length > budget) return -1;
  let left = budget;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) left -= 1;
    else if (code < 0x800) left -= 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      left -= 4;
      i++;
    } else left -= 3;
    if (left < 0) return -1;
  }
  return left;
}

/** The matching elements under `root`, in document order, none inside another match. */
function elementsWhere(
  root: NodeLike,
  matches: (node: NodeLike) => boolean
): NodeLike[] {
  const found: NodeLike[] = [];
  const pending: unknown[] = [];
  const kids = childrenOf(root);
  for (let i = kids.length - 1; i >= 0; i--) pending.push(kids[i]);
  while (pending.length > 0) {
    const node = asNode(pending.pop());
    if (node === undefined || node.nodeType !== ELEMENT_NODE) continue;
    if (matches(node)) {
      found.push(node);
      continue;
    }
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return found;
}

/**
 * DOCX pages, in order: `.docx-wrapper > section.docx`. Each page is one scope,
 * and every page is part 0.
 */
function docxScopes(root: NodeLike): Scope[] {
  const scopes: Scope[] = [];
  for (const wrapper of elementsWhere(root, (node) =>
    hasClass(node, 'docx-wrapper')
  )) {
    for (const value of childrenOf(wrapper)) {
      const page = asNode(value);
      if (
        page !== undefined &&
        page.nodeType === ELEMENT_NODE &&
        tagOf(page) === 'section' &&
        hasClass(page, 'docx')
      ) {
        scopes.push({ element: page, part: 0, skipped: DOCX_SKIPPED });
      }
    }
  }
  return scopes;
}

/**
 * EPUB chapters, in render order. A chapter is `article[data-epub-chapter]`, and
 * its part is that attribute. Undefined when a chapter's part cannot be read.
 */
function epubScopes(root: NodeLike): Scope[] | undefined {
  const scopes: Scope[] = [];
  for (const article of elementsWhere(
    root,
    (node) =>
      tagOf(node) === 'article' &&
      attributeOf(node, 'data-epub-chapter') !== undefined
  )) {
    const raw = attributeOf(article, 'data-epub-chapter') ?? '';
    const part = /^(?:0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(part < MAX_DOCUMENT_PARTS)) return undefined;
    scopes.push({ element: article, part, skipped: NO_SKIPS });
  }
  return scopes;
}

/** Accumulates one version's blocks. Any budget overrun throws `Unreadable`. */
class Reader {
  readonly blocks: DocumentBlock[] = [];
  readonly elements: Element[] = [];
  private pieces: Piece[] = [];
  private structure = 0;
  private bytesLeft = MAX_DOCUMENT_BLOCK_BYTES;

  /**
   * Reads one scope's blocks in reading order and appends them. Each element
   * that can hold a block raises `structure` when it is entered. An element
   * whose entry raised it by exactly one had no block inside, so it is a leaf.
   * That decides leaf or container in one pass.
   */
  scope(scope: Scope): void {
    this.pieces = [];
    this.children(scope.element, undefined, 1, scope.skipped);
    this.regroup(0, scope.element);
    for (const piece of this.pieces) {
      // Regrouping has claimed every loose run, so only blocks remain.
      if (piece.kind === undefined) continue;
      const text = piece.raw.replace(/\s+/g, ' ').trim();
      if (text === '' && piece.kind !== 'image' && piece.kind !== 'media')
        continue;
      if (this.blocks.length >= MAX_DOCUMENT_BLOCKS) throw new Unreadable();
      this.bytesLeft = spendUtf8(text, this.bytesLeft);
      if (this.bytesLeft < 0) throw new Unreadable();
      this.blocks.push({ kind: piece.kind, text, part: scope.part });
      // The walk reads through NodeLike, but every element it reaches is the
      // document's own Element. This is the one place they are typed as such.
      this.elements.push(piece.element as unknown as Element);
    }
    this.pieces = [];
  }

  private children(
    node: NodeLike,
    context: DocumentBlockKind | undefined,
    depth: number,
    skipped: Readonly<Record<string, true>>
  ): void {
    for (const value of childrenOf(node)) {
      const child = asNode(value);
      if (child === undefined) continue;
      if (child.nodeType === TEXT_NODE) {
        const raw = child.nodeValue;
        if (typeof raw === 'string') this.pieces.push({ raw });
      } else if (
        child.nodeType === ELEMENT_NODE &&
        skipped[tagOf(child)] !== true
      ) {
        this.visit(child, context, depth);
      }
    }
  }

  private visit(
    node: NodeLike,
    context: DocumentBlockKind | undefined,
    depth: number
  ): void {
    if (depth > MAX_NESTING) throw new Unreadable();
    const tag = tagOf(node);
    if (SKIPPED_TAGS[tag] === true) return;
    // A line break reads as the space it stands for in running text, so
    // "one<br>Line" is "one Line", not "oneLine".
    if (tag === 'br') {
      this.pieces.push({ raw: ' ' });
      return;
    }
    const own = Object.hasOwn(OWN_KINDS, tag) ? OWN_KINDS[tag] : undefined;
    if (own === 'image' || own === 'media') {
      this.structure += 1;
      this.pieces.push({ raw: '', kind: own, element: node });
      return;
    }
    if (BLOCK_TAGS[tag] !== true) {
      // Inline, so its text belongs to whichever block holds it.
      this.children(node, context, depth + 1, NO_SKIPS);
      return;
    }
    const start = this.pieces.length;
    const before = this.structure;
    this.structure += 1;
    const inner = Object.hasOwn(CONTEXTS, tag) ? CONTEXTS[tag] : undefined;
    this.children(node, inner ?? context, depth + 1, NO_SKIPS);
    if (this.structure === before + 1) {
      let raw = '';
      for (let i = start; i < this.pieces.length; i++)
        raw += this.pieces[i]!.raw;
      this.pieces.length = start;
      this.pieces.push({
        raw,
        kind: own ?? context ?? 'paragraph',
        element: node,
      });
    } else {
      this.regroup(start, node);
    }
  }

  /**
   * Turns each run of loose text in `pieces[start..]` into a `text` block that
   * belongs to `owner`, and leaves the blocks in place and in order.
   */
  private regroup(start: number, owner: NodeLike): void {
    const kept: Piece[] = [];
    let run: string | undefined;
    for (let i = start; i < this.pieces.length; i++) {
      const piece = this.pieces[i]!;
      if (piece.kind === undefined) {
        run = (run ?? '') + piece.raw;
        continue;
      }
      if (run !== undefined) {
        kept.push({ raw: run, kind: 'text', element: owner });
        run = undefined;
      }
      kept.push(piece);
    }
    if (run !== undefined)
      kept.push({ raw: run, kind: 'text', element: owner });
    this.pieces.length = start;
    for (const piece of kept) this.pieces.push(piece);
  }
}

/**
 * Snapshot a rendered document's leaf blocks, in reading order.
 *
 * `root` is the frame's own document root. DOCX reads each page's body, leaving
 * out its header and footer. EPUB reads each `article[data-epub-chapter]` and
 * nothing else, so the status line and the reader's chrome stay out.
 *
 * Returns `null`, never a partial snapshot, when the document is over the block
 * or text budget, nests too deeply, has no readable scope, or has a part that
 * cannot be a render index. A comparison of a partial read could say two
 * versions match when parts of them were never read.
 */
export function collectBlocks(
  root: unknown,
  format: 'docx' | 'epub'
): DocumentBlockSnapshot | null {
  const top = asNode(root);
  if (top === undefined) return null;
  const scopes = format === 'docx' ? docxScopes(top) : epubScopes(top);
  if (scopes === undefined || scopes.length === 0) return null;
  const reader = new Reader();
  try {
    for (const scope of scopes) reader.scope(scope);
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
  return { blocks: reader.blocks, elements: reader.elements };
}

/** The node at a single-index path into a snapshot, or undefined for any other path. */
function blockAt(
  snapshot: DocumentBlockSnapshot,
  path: readonly number[]
): NodeLike | undefined {
  if (path.length !== 1) return undefined;
  const index = path[0]!;
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  if (index >= snapshot.elements.length) return undefined;
  return asNode(snapshot.elements[index]);
}

/** The root of the tree `node` sits in, which is the document itself when attached. */
function topOf(node: NodeLike): NodeLike {
  let top = node;
  let parent = asNode(top.parentNode);
  while (parent !== undefined) {
    top = parent;
    parent = asNode(top.parentNode);
  }
  return top;
}

/** Remove every authored mark attribute under `top`, iteratively. */
function clearAuthored(top: NodeLike): void {
  const pending: unknown[] = [top];
  while (pending.length > 0) {
    const node = asNode(pending.pop());
    if (node === undefined) continue;
    node.removeAttribute?.('data-relic-diff');
    node.removeAttribute?.('data-relic-sync-id');
    node.removeAttribute?.('data-relic-change-id');
    for (const child of childrenOf(node)) pending.push(child);
  }
}

/**
 * Mark a document's blocks, and nothing else.
 *
 * A path is a single block index. A mark that is not one, or whose index is out
 * of range, is skipped rather than thrown, because the message came from outside
 * and a stale index must not take the frame down. An anchor never overwrites a
 * block that is already marked, so a change keeps the id the two sides agreed on.
 * Returns how many marks landed.
 */
export function annotateBlocks(
  snapshot: DocumentBlockSnapshot,
  marks: readonly Mark[],
  anchors: readonly Anchor[]
): number {
  // Authored attributes are cleared before anything is painted, across the whole
  // tree the blocks sit in, the way applyMarks clears the rendered tree.
  const tops = new Set<NodeLike>();
  for (const element of snapshot.elements) {
    const node = asNode(element);
    if (node !== undefined) tops.add(topOf(node));
  }
  for (const top of tops) clearAuthored(top);

  let applied = 0;
  for (const mark of marks) {
    const node = blockAt(snapshot, mark.path);
    if (
      node === undefined ||
      MARK_KINDS[mark.kind] !== true ||
      typeof node.setAttribute !== 'function'
    )
      continue;
    node.setAttribute('data-relic-diff', mark.kind);
    if (typeof mark.syncId === 'string')
      node.setAttribute('data-relic-sync-id', mark.syncId);
    if (typeof mark.changeId === 'string')
      node.setAttribute('data-relic-change-id', mark.changeId);
    applied += 1;
  }
  for (const anchor of anchors) {
    const node = blockAt(snapshot, anchor.path);
    if (
      node === undefined ||
      typeof anchor.syncId !== 'string' ||
      typeof node.setAttribute !== 'function'
    )
      continue;
    if (attributeOf(node, 'data-relic-diff') !== undefined) continue;
    node.setAttribute('data-relic-sync-id', anchor.syncId);
  }
  return applied;
}

/**
 * Adds the outline rules to a document frame: the tree's rules first, then the
 * document's. Called once, by the frame module's `annotate`, before any marks.
 */
export function installHighlightCss(
  doc: Pick<Document, 'createElement' | 'head'>
): void {
  const style = doc.createElement('style');
  style.textContent = HIGHLIGHT_CSS + DOCUMENT_HIGHLIGHT_CSS;
  doc.head.append(style);
}
