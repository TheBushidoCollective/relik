/**
 * The state behind the JSON tree view, with no DOM (plan A2, sections 4, 5, 7).
 *
 * The view draws only the rows this state lists as visible, so a 48,000-element
 * array costs a screenful of elements. Everything the view decides lives here
 * and is tested without a browser: which nodes are open, what is selected,
 * which node a comment anchor names, and the text the reader sees. Text from
 * the file is always shown through `visibleText`, so a bidi override or a
 * control character reads as an escape, not as a rearrangement of the page.
 */

import type { CommentAnchor, JsonTree, JsonTreeFailure } from '@relic/format';
import { findQuote, isInvisible } from '@relic/format/structured-text';

export { findQuote };

/** Above this many values, "Expand all" is off: opening everything would stall the page. */
export const TREE_EXPAND_ALL_LIMIT = 10_000;

/** A string value is shown this many characters in a row, then cut. */
export const TREE_VALUE_CUT_CHARS = 512;

/** The inspector shows at most this many characters of a long value. */
export const TREE_INSPECTOR_CUT_CHARS = 4096;

const NONE = -1;

/** Escapes C0 (tab and line feed too, as this view always did) and the shared invisible set. */
function needsEscape(code: number): boolean {
  return code <= 0x1f || isInvisible(code);
}

/**
 * The text as the reader sees it: control, bidi and line-separator characters
 * become visible `\uXXXX` escapes. Everything else is kept as written.
 */
export function visibleText(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    out += needsEscape(code)
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : character;
  }
  return out;
}

/**
 * A string value, cut at `TREE_VALUE_CUT_CHARS` code units and then escaped.
 * A cut that would split a surrogate pair drops the lone high half.
 */
export function valuePreview(source: string): string {
  if (source.length <= TREE_VALUE_CUT_CHARS) return visibleText(source);
  let cut = source.slice(0, TREE_VALUE_CUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${visibleText(cut)}…`;
}

/** The label for a node's key: the key as written, or the array index. */
export function keyLabel(tree: JsonTree, node: number): string {
  if (tree.parent(node) === -1) return '$';
  const written = tree.keySource(node);
  if (written !== undefined) return visibleText(written);
  return String(tree.index(node));
}

/** The label for a node's value: a count for a container, the source for anything else. */
export function valueLabel(tree: JsonTree, node: number): string {
  const kind = tree.kind(node);
  if (kind === 'object') return `{${tree.childCount(node)}}`;
  if (kind === 'array') return `[${tree.childCount(node)}]`;
  return valuePreview(tree.valueSource(node));
}

/** The summary line above the tree. Counts use grouping separators. */
export function summaryText(tree: JsonTree): string {
  const format = new Intl.NumberFormat('en-US');
  const parts = [`${format.format(tree.size)} nodes`, `depth ${tree.maxDepth}`];
  if (tree.duplicateCount > 0) {
    parts.push(
      `${format.format(tree.duplicateCount)} duplicate key${tree.duplicateCount === 1 ? '' : 's'}`
    );
  }
  if (tree.size > TREE_EXPAND_ALL_LIMIT) {
    parts.push(
      `Expand all is off above ${format.format(TREE_EXPAND_ALL_LIMIT)} nodes`
    );
  }
  return parts.join(' · ');
}

/** The notice shown above the source when a file cannot be drawn as a tree. */
export function noticeFor(failure: JsonTreeFailure): string {
  switch (failure.kind) {
    case 'too-large':
    case 'too-many-nodes':
      return 'This file is too large to show as a tree, so its text is shown.';
    case 'too-deep':
      return 'This file is nested too deeply to show as a tree, so its text is shown.';
    case 'syntax':
      return `This file could not be read as JSON, so its text is shown. Line ${failure.line}, column ${failure.column}: ${failure.reason}.`;
  }
}

/** One step of the breadcrumb: the node it names and the label it shows. */
export interface Crumb {
  readonly node: number;
  readonly label: string;
}

/** The path from the document to a node, root first. */
export function breadcrumbFor(tree: JsonTree, node: number): Crumb[] {
  const path: Crumb[] = [];
  for (let at = node; at !== NONE; at = tree.parent(at)) {
    path.push({
      node: at,
      label: tree.parent(at) === NONE ? '$' : keyLabel(tree, at),
    });
  }
  return path.reverse();
}

/**
 * The node a comment anchor names, or `undefined` when this tree cannot show
 * it. A `path` names its pointer. A quote, from a text view or a legacy
 * comment, names the node whose source text holds the quoted phrase, so a
 * comment made in Source mode still marks the value it was about.
 */
export function nodeForAnchor(
  tree: JsonTree,
  anchor: CommentAnchor
): number | undefined {
  switch (anchor.kind) {
    case 'path': {
      const node = tree.resolve(anchor.pointer);
      return node === NONE ? undefined : node;
    }
    case 'quote':
    case 'source': {
      const at = findQuote(
        tree.source,
        anchor.exact,
        anchor.prefix,
        anchor.suffix
      );
      return at === undefined ? undefined : nodeAtOrUndefined(tree, at);
    }
    case 'text': {
      const at = findQuote(tree.source, anchor.quote);
      return at === undefined ? undefined : nodeAtOrUndefined(tree, at);
    }
    default:
      return undefined;
  }
}

function nodeAtOrUndefined(tree: JsonTree, offset: number): number | undefined {
  const node = tree.nodeAt(offset);
  return node === NONE ? undefined : node;
}

/**
 * What the view shows and where the reader is in it. Expansion, selection and
 * marks are kept here; the visible list is rebuilt whenever expansion changes.
 */
export class JsonTreeState {
  readonly tree: JsonTree;
  readonly #expanded: Uint8Array;
  readonly #marks = new Map<number, Set<string>>();
  #visible: number[] = [];
  #selected = 0;

  constructor(tree: JsonTree) {
    this.tree = tree;
    this.#expanded = new Uint8Array(tree.size);
    // The root and its children open, and so does a first-level object inside an
    // object. An array element opens only when it is the root's or a member's
    // direct container, so long arrays of records start closed.
    for (let node = 0; node < tree.size; node += 1) {
      if (!tree.isContainer(node)) continue;
      const depth = tree.depth(node);
      const parent = tree.parent(node);
      const inObject = parent !== NONE && tree.kind(parent) === 'object';
      if (depth < 2 || (depth === 2 && inObject)) this.#expanded[node] = 1;
    }
    this.#rebuild();
  }

  /** How many rows the visible list holds. */
  get rowCount(): number {
    return this.#visible.length;
  }

  rowAt(row: number): number {
    return this.#visible[row] ?? NONE;
  }

  /** The row a node is drawn on, or `NONE` when a collapsed ancestor hides it. */
  rowOf(node: number): number {
    return this.#visible.indexOf(node);
  }

  get selected(): number {
    return this.#selected;
  }

  select(node: number): void {
    if (node >= 0 && node < this.tree.size) this.#selected = node;
  }

  isExpanded(node: number): boolean {
    return this.#expanded[node] === 1;
  }

  /** Opens or closes a container. A leaf, or an empty container, does nothing. */
  toggle(node: number): void {
    if (!this.hasChildren(node)) return;
    this.#expanded[node] = this.#expanded[node] === 1 ? 0 : 1;
    this.#rebuild();
  }

  /** Opens every container. Refused above the node limit. */
  expandAll(): boolean {
    if (this.tree.size > TREE_EXPAND_ALL_LIMIT) return false;
    for (let node = 0; node < this.tree.size; node += 1) {
      if (this.tree.isContainer(node)) this.#expanded[node] = 1;
    }
    this.#rebuild();
    return true;
  }

  /** Closes every container except the root, so the top level stays in view. */
  collapseAll(): void {
    this.#expanded.fill(0);
    if (this.tree.isContainer(0)) this.#expanded[0] = 1;
    this.#rebuild();
  }

  /** Opens every ancestor of a node, so the node is drawn. */
  reveal(node: number): void {
    for (
      let at = this.tree.parent(node);
      at !== NONE;
      at = this.tree.parent(at)
    ) {
      this.#expanded[at] = 1;
    }
    this.#rebuild();
  }

  hasChildren(node: number): boolean {
    return this.tree.isContainer(node) && this.tree.childCount(node) > 0;
  }

  /**
   * Moves the selection the way a WAI-ARIA tree does. Returns whether the key
   * was one this tree uses, so the caller can prevent its default.
   */
  move(
    key: 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'toggle'
  ): boolean {
    const row = this.rowOf(this.#selected);
    if (key === 'down') {
      this.select(this.rowAt(row + 1));
    } else if (key === 'up') {
      if (row > 0) this.select(this.rowAt(row - 1));
    } else if (key === 'home') {
      this.select(this.rowAt(0));
    } else if (key === 'end') {
      this.select(this.rowAt(this.rowCount - 1));
    } else if (key === 'right') {
      if (
        this.hasChildren(this.#selected) &&
        !this.isExpanded(this.#selected)
      ) {
        this.toggle(this.#selected);
      } else if (this.hasChildren(this.#selected)) {
        this.select(this.tree.firstChild(this.#selected));
      }
    } else if (key === 'left') {
      if (this.hasChildren(this.#selected) && this.isExpanded(this.#selected)) {
        this.toggle(this.#selected);
      } else if (this.tree.parent(this.#selected) !== NONE) {
        this.select(this.tree.parent(this.#selected));
      }
    } else {
      this.toggle(this.#selected);
    }
    return true;
  }

  /** The mark a comment puts on a node. Marks outlive collapse and expansion. */
  mark(node: number, commentId: string): void {
    const ids = this.#marks.get(node) ?? new Set<string>();
    ids.add(commentId);
    this.#marks.set(node, ids);
  }

  clearMarks(): void {
    this.#marks.clear();
  }

  marksOn(node: number): readonly string[] {
    return [...(this.#marks.get(node) ?? [])];
  }

  /**
   * The anchor for a node, or `undefined` when no pointer addresses it. An
   * ignored duplicate has none: a comment there would land on the value the
   * parser keeps, which is not the one the reader chose.
   */
  anchorFor(node: number): CommentAnchor | undefined {
    const pointer = this.tree.pointer(node);
    return pointer === undefined ? undefined : { kind: 'path', pointer };
  }

  selectionAnchor(): CommentAnchor | undefined {
    return this.anchorFor(this.#selected);
  }

  #rebuild(): void {
    const tree = this.tree;
    const visible: number[] = [];
    let node = 0;
    for (;;) {
      visible.push(node);
      const child =
        tree.isContainer(node) && this.#expanded[node] === 1
          ? tree.firstChild(node)
          : NONE;
      if (child !== NONE) {
        node = child;
        continue;
      }
      while (node !== 0 && tree.nextSibling(node) === NONE) {
        node = tree.parent(node);
      }
      if (node === 0) break;
      node = tree.nextSibling(node);
    }
    this.#visible = visible;
  }
}
