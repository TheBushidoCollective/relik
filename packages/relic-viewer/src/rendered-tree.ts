/**
 * Capturing and marking a rendered DOM, on either side of the frame boundary.
 *
 * This module is bundled into both the service-origin viewer and the
 * network-denied usercontent frame, so it carries no dependencies at all. That
 * is not tidiness: the frame's bundle is inlined into its own page and a build
 * test asserts the comparison algorithm is absent from it, so anything imported
 * here lands in both places and has to be worth it in both.
 *
 * What crosses the boundary is defined here too. A frame reports its own
 * rendered structure as a `TreeNode`, which is tag names, an attribute
 * allowlist, and text. The parent replies with `Mark`s, which are a child-index
 * path and a kind and nothing else. Neither direction carries markup.
 */

/** A serialisable snapshot of a rendered DOM subtree. */
export interface TreeNode {
  /** Lowercase tag name, or '#text' for a text node. */
  readonly tag: string;
  /** Normalised text for a '#text' node, empty for an element. */
  readonly text: string;
  /** Reader-visible attributes, sorted by name. */
  readonly attrs: readonly (readonly [string, string])[];
  readonly children: readonly TreeNode[];
}

/** Child indices from the captured root, addressing one node. */
export type NodePath = readonly number[];

export type MarkKind = 'added' | 'removed' | 'changed';

export interface Mark {
  readonly path: NodePath;
  readonly kind: MarkKind;
  /** Same value on the two changed nodes one tree diff paired. */
  readonly syncId?: string;
  /**
   * This one change, addressable, so a reader can be taken to it.
   *
   * Deliberately not the sync id. Only paired nodes and anchors carry a
   * sync id, because an id the other side does not have makes the follower
   * fall back to the page fraction. A paragraph that exists on one side
   * only still has to be reachable by the jump control, so it gets a name
   * here and stays out of the alignment.
   */
  readonly changeId?: string;
}

/**
 * A point of reference on content that did not change.
 *
 * Scroll syncing used to have nothing to hold onto except changed nodes,
 * which is the wrong set: a version that adds two paragraphs at the top and
 * touches nothing else has exactly one changed region, at the very top, and
 * from the second screen onwards the two documents were aligned by page
 * fraction and therefore off by the height of the insertion.
 *
 * An anchor is the same node on both sides, agreed by the diff, carrying no
 * outline and no meaning for the reader. It exists so the follower can align
 * on the paragraph the leader is actually looking at.
 */
export interface Anchor {
  readonly path: NodePath;
  readonly syncId: string;
}

/** Frame to parent: what this frame actually rendered. */
export interface TreeMessage {
  readonly type: 'relic:tree';
  /** Null means the rendered structure exceeded the snapshot budget. */
  readonly tree: TreeNode | null;
}

/**
 * Parent to frame: bring one marked node to this height in your viewport.
 *
 * Carries an id the parent minted and a number. No content, in either
 * direction, which is the rule every message across this boundary follows.
 */
export interface RevealChangeMessage {
  readonly type: 'relic:reveal-change';
  readonly changeId: string;
  readonly top: number;
}

export function isRevealChangeMessage(
  data: unknown
): data is RevealChangeMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message['type'] !== 'relic:reveal-change') return false;
  const changeId = message['changeId'];
  if (typeof changeId !== 'string' || !/^c[0-9]+$/.test(changeId)) {
    return false;
  }
  const top = message['top'];
  return typeof top === 'number' && Number.isFinite(top) && Math.abs(top) < 1e5;
}

/** Parent to frame: which of your own nodes differ from the other version. */
export interface AnnotateMessage {
  readonly type: 'relic:annotate';
  readonly marks: readonly Mark[];
  /**
   * Unchanged content both sides agreed on, for aligning the scroll.
   *
   * Optional so a sender that predates them is still a valid message. It
   * carries paths and ids and no content, exactly like `marks`, which is
   * what keeps a second message type safe inside a frame that renders once.
   */
  readonly anchors?: readonly Anchor[];
}

/**
 * A snapshot must fit both limits in full. A partial tree could claim that
 * versions match when their differences were omitted.
 */
export const MAX_TREE_NODES = 5000;
export const MAX_TREE_BYTES = 8 * 1024 * 1024;

/**
 * Attributes a reader can see the effect of.
 *
 * A visual comparison should notice a changed image target or a changed colour,
 * so `src`, `class`, and `style` are in. Anything whose change a reader cannot
 * see is out, because it would inflate the count with something invisible.
 */
export const VISIBLE_ATTRS: readonly string[] = [
  'alt',
  'class',
  'colspan',
  'height',
  'href',
  'rowspan',
  'src',
  'style',
  'title',
  'type',
  'value',
  'width',
];

/**
 * Tags whose contents are never rendered.
 *
 * A change inside one of these is invisible to a reader, so counting it would
 * report a change nobody can see. Reformatting a stylesheet is the obvious
 * case: every byte moved and no pixel did.
 */
const UNRENDERED_TAGS: Record<string, true> = {
  head: true,
  link: true,
  meta: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  title: true,
};

/** What a reader would call a tag, for the change list. */
const TAG_LABELS: Record<string, string> = {
  '#text': 'text',
  a: 'link',
  blockquote: 'quote',
  code: 'code block',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  hr: 'divider',
  img: 'image',
  li: 'list item',
  ol: 'list',
  p: 'paragraph',
  pre: 'code block',
  table: 'table',
  td: 'table cell',
  th: 'table cell',
  tr: 'table row',
  ul: 'list',
};

export function labelForTag(tag: string): string {
  return TAG_LABELS[tag] ?? 'element';
}

/**
 * The highlight, injected by the frame into the document it rendered.
 *
 * Every declaration is `!important` because the document being annotated is
 * the author's own page, its stylesheet would otherwise win, and a highlight a
 * reader cannot see is not a highlight. Outline rather than border, so nothing
 * reflows and a marked node stays where the unmarked one was.
 */
export const HIGHLIGHT_CSS = `
[data-relic-diff] {
  outline-offset: 2px !important;
}
[data-relic-diff='added'] {
  outline: 2px solid #1f6b64 !important;
  background-color: rgb(31 107 100 / 18%) !important;
}
[data-relic-diff='removed'] {
  outline: 2px solid #8c4a2f !important;
  background-color: rgb(140 74 47 / 18%) !important;
}
[data-relic-diff='changed'] {
  outline: 2px solid #8a6d1f !important;
  background-color: rgb(138 109 31 / 18%) !important;
}
`;

/** The shape of a DOM node this module reads, so a stub can stand in for one. */
interface NodeLike {
  readonly nodeType?: unknown;
  readonly tagName?: unknown;
  readonly nodeValue?: unknown;
  readonly childNodes?: unknown;
  getAttribute?: (name: string) => unknown;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function asNode(value: unknown): NodeLike | undefined {
  return typeof value === 'object' && value !== null
    ? (value as NodeLike)
    : undefined;
}

function childrenOf(node: NodeLike): readonly unknown[] {
  const list = node.childNodes;
  if (Array.isArray(list)) return list;
  if (
    typeof list === 'object' &&
    list !== null &&
    typeof (list as { length?: unknown }).length === 'number'
  ) {
    return Array.from(list as ArrayLike<unknown>);
  }
  return [];
}

/** The collapsed text a node contributes, or nothing if it contributes none. */
function textOfNode(node: NodeLike): string | undefined {
  if (node.nodeType !== TEXT_NODE) return undefined;
  const raw = typeof node.nodeValue === 'string' ? node.nodeValue : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length === 0 ? undefined : text;
}

/**
 * The children the capture keeps, which is also the index space a path walks.
 *
 * Both sides go through this one function on purpose. A path is a list of
 * child indices into a captured tree, and the capture drops whitespace and
 * unrendered tags, so resolving a path against raw `childNodes` would land on
 * a different node than the one the diff meant. That was a real defect: marks
 * were computed correctly and applied to the wrong nodes.
 */
function keptChildren(node: NodeLike): NodeLike[] {
  const kept: NodeLike[] = [];
  for (const value of childrenOf(node)) {
    const child = asNode(value);
    if (child === undefined) continue;
    if (child.nodeType === TEXT_NODE) {
      if (textOfNode(child) !== undefined) kept.push(child);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag =
      typeof child.tagName === 'string' ? child.tagName.toLowerCase() : '';
    if (UNRENDERED_TAGS[tag] === true) continue;
    kept.push(child);
  }
  return kept;
}

function attrsOf(node: NodeLike): readonly (readonly [string, string])[] {
  const read = node.getAttribute;
  if (typeof read !== 'function') return [];
  const found: [string, string][] = [];
  for (const name of VISIBLE_ATTRS) {
    const value = read.call(node, name);
    if (typeof value === 'string') found.push([name, value]);
  }
  return found;
}

/** Count UTF-8 without allocating another copy of a potentially large string. */
function remainingUtf8Bytes(value: string, remaining: number): number {
  if (value.length > remaining) return -1;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      remaining -= 1;
    } else if (code < 0x800) {
      remaining -= 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      remaining -= 4;
      i++;
    } else {
      remaining -= 3;
    }
    if (remaining < 0) return -1;
  }
  return remaining;
}

/**
 * Snapshot what a document actually rendered.
 *
 * Text is collapsed to single spaces and trimmed, and whitespace-only text is
 * dropped entirely, because this feeds a visual comparison and reindenting a
 * source file moves no pixel. Without it, reformatting a document would report
 * every line as changed and the result would be a source diff wearing a
 * rendered diff's clothes.
 *
 * The cost is named rather than hidden: a change that is only inline spacing,
 * a word separator gained or lost between two inline elements, reads here as
 * no change. That is the same trade in both directions, and reflow noise is
 * the far more common case.
 */
export function captureTree(root: unknown): TreeNode | null {
  let nodes = MAX_TREE_NODES;
  let bytes = MAX_TREE_BYTES;
  let unavailable = false;

  const account = (value: string): boolean => {
    bytes = remainingUtf8Bytes(value, bytes);
    if (bytes >= 0) return true;
    unavailable = true;
    return false;
  };

  const walk = (value: unknown): TreeNode | undefined => {
    const node = asNode(value);
    if (node === undefined) return undefined;

    if (node.nodeType === TEXT_NODE) {
      const text = textOfNode(node);
      if (text === undefined) return undefined;
      if (nodes === 0 || !account('#text') || !account(text)) {
        unavailable = true;
        return undefined;
      }
      nodes--;
      return { tag: '#text', text, attrs: [], children: [] };
    }

    if (node.nodeType !== ELEMENT_NODE) return undefined;
    const tag =
      typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
    if (UNRENDERED_TAGS[tag] === true) return undefined;
    if (nodes === 0 || !account(tag)) {
      unavailable = true;
      return undefined;
    }
    nodes--;
    const attrs = attrsOf(node);
    for (const [name, value] of attrs) {
      if (!account(name) || !account(value)) return undefined;
    }

    const children: TreeNode[] = [];
    for (const child of keptChildren(node)) {
      const captured = walk(child);
      if (unavailable) return undefined;
      if (captured !== undefined) children.push(captured);
    }
    return { tag, text: '', attrs, children };
  };

  const tree = walk(root);
  if (unavailable) return null;
  return tree ?? { tag: '#root', text: '', attrs: [], children: [] };
}

/**
 * Mark this document's own nodes, and nothing else.
 *
 * This function never reads or writes text or markup. That is the whole reason
 * a second message type is safe inside a frame that renders exactly once: the
 * channel cannot change what the document says, only how it is outlined.
 *
 * A path that no longer resolves is skipped rather than thrown, because the
 * document may have moved under the parent and a stale path must not take the
 * frame down. Returns how many marks actually landed.
 */
export function applyMarks(root: unknown, marks: readonly Mark[]): number {
  let applied = 0;

  // A relic is untrusted and may have authored this attribute itself. Clear
  // every copy before painting the ids produced by our own diff; otherwise an
  // author could steer comparison scrolling to an unrelated element simply
  // by guessing `d0`.
  const clearAuthoredSyncIds = (value: unknown): void => {
    const node = asNode(value);
    if (node === undefined) return;
    node.removeAttribute?.('data-relic-sync-id');
    node.removeAttribute?.('data-relic-change-id');
    for (const child of childrenOf(node)) clearAuthoredSyncIds(child);
  };
  clearAuthoredSyncIds(root);

  for (const mark of marks) {
    let node = asNode(root);
    for (const index of mark.path) {
      if (node === undefined) break;
      node = keptChildren(node)[index];
    }
    if (node === undefined) continue;
    if (node.nodeType !== ELEMENT_NODE) continue;
    if (typeof node.setAttribute !== 'function') continue;
    node.setAttribute('data-relic-diff', mark.kind);
    if (mark.syncId !== undefined) {
      node.setAttribute('data-relic-sync-id', mark.syncId);
    }
    if (mark.changeId !== undefined) {
      node.setAttribute('data-relic-change-id', mark.changeId);
    }
    applied += 1;
  }

  return applied;
}

/**
 * Put the shared ids on unchanged content.
 *
 * Separate from `applyMarks` and always run after it, because that function
 * clears every authored `data-relic-sync-id` first: a relic is untrusted and
 * could otherwise steer comparison scrolling by guessing an id. Running this
 * first would have its own anchors wiped by that sweep.
 *
 * Only the id is written. An anchor that also wrote `data-relic-diff` would
 * outline half the document as changed.
 */
export function applyAnchors(
  root: unknown,
  anchors: readonly Anchor[]
): number {
  let applied = 0;
  for (const anchor of anchors) {
    let node = asNode(root);
    for (const index of anchor.path) {
      if (node === undefined) break;
      node = keptChildren(node)[index];
    }
    if (node === undefined) continue;
    if (node.nodeType !== ELEMENT_NODE) continue;
    if (typeof node.setAttribute !== 'function') continue;
    // A changed node already carries its own paired id and outline. Writing
    // an anchor over it would replace the id the two sides agreed on for the
    // change with one agreed for the container, and the change would stop
    // being the thing the panes align on.
    if (node.getAttribute?.('data-relic-diff') !== null) continue;
    node.setAttribute('data-relic-sync-id', anchor.syncId);
    applied += 1;
  }
  return applied;
}

function isTreeNode(value: unknown): value is TreeNode {
  const pending: unknown[] = [value];
  let nodes = 0;
  let bytes = MAX_TREE_BYTES;
  const account = (text: string): boolean => {
    bytes = remainingUtf8Bytes(text, bytes);
    return bytes >= 0;
  };

  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== 'object' || item === null) return false;
    const node = item as Record<string, unknown>;
    const keys = Object.keys(node);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          key !== 'tag' &&
          key !== 'text' &&
          key !== 'attrs' &&
          key !== 'children'
      )
    )
      return false;
    if (typeof node['tag'] !== 'string' || !account(node['tag'])) return false;
    if (typeof node['text'] !== 'string' || !account(node['text']))
      return false;
    if (
      !Array.isArray(node['attrs']) ||
      node['attrs'].length > VISIBLE_ATTRS.length ||
      Object.keys(node['attrs']).length !== node['attrs'].length
    )
      return false;
    for (const attr of node['attrs']) {
      if (
        !Array.isArray(attr) ||
        attr.length !== 2 ||
        Object.keys(attr).length !== 2
      )
        return false;
      if (
        typeof attr[0] !== 'string' ||
        typeof attr[1] !== 'string' ||
        !account(attr[0]) ||
        !account(attr[1])
      )
        return false;
    }
    if (
      !Array.isArray(node['children']) ||
      nodes + 1 + pending.length + node['children'].length > MAX_TREE_NODES ||
      Object.keys(node['children']).length !== node['children'].length
    )
      return false;
    nodes++;
    for (const child of node['children']) pending.push(child);
  }
  return true;
}

export function isTreeMessage(data: unknown): data is TreeMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message['type'] === 'relic:tree' &&
    (message['tree'] === null || isTreeNode(message['tree']))
  );
}

const MARK_KINDS: Record<string, true> = {
  added: true,
  changed: true,
  removed: true,
};

/**
 * Validate an annotate message totally.
 *
 * One malformed entry rejects the whole message rather than being filtered out.
 * A partially valid message from an opaque origin is attacker input, and
 * salvaging part of it invents an intent nobody sent.
 */
export function isAnnotateMessage(data: unknown): data is AnnotateMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message['type'] !== 'relic:annotate') return false;
  const marks = message['marks'];
  if (!Array.isArray(marks)) return false;

  for (const entry of marks) {
    if (typeof entry !== 'object' || entry === null) return false;
    const mark = entry as Record<string, unknown>;
    if (MARK_KINDS[String(mark['kind'])] !== true) return false;
    const syncId = mark['syncId'];
    if (
      syncId !== undefined &&
      (typeof syncId !== 'string' || !/^d[0-9]+$/.test(syncId))
    ) {
      return false;
    }
    const changeId = mark['changeId'];
    if (
      changeId !== undefined &&
      (typeof changeId !== 'string' || !/^c[0-9]+$/.test(changeId))
    ) {
      return false;
    }
    if (!isNodePath(mark['path'])) return false;
  }

  const anchors = message['anchors'];
  if (anchors !== undefined) {
    if (!Array.isArray(anchors)) return false;
    for (const entry of anchors) {
      if (typeof entry !== 'object' || entry === null) return false;
      const anchor = entry as Record<string, unknown>;
      // Anchors are minted in their own namespace, so a message cannot
      // smuggle one in wearing a change's name and take over the identity
      // the two panes agreed on for that change.
      const syncId = anchor['syncId'];
      if (typeof syncId !== 'string' || !/^a[0-9]+$/.test(syncId)) {
        return false;
      }
      if (!isNodePath(anchor['path'])) return false;
    }
  }

  return true;
}

function isNodePath(value: unknown): value is NodePath {
  if (!Array.isArray(value)) return false;
  for (const index of value) {
    if (typeof index !== 'number') return false;
    if (!Number.isSafeInteger(index) || index < 0) return false;
  }
  return true;
}
