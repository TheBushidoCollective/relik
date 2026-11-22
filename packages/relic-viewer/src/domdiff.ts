import { diffArrays } from 'diff';
import type { DiffSegment } from './diff.ts';
import {
  type Anchor,
  labelForTag,
  type Mark,
  type MarkKind,
  type NodePath,
  type TreeNode,
} from './rendered-tree.ts';

/**
 * Comparing two rendered documents.
 *
 * This runs on the service origin only, over trees each render frame reported
 * about itself, and it never sees markup. What it produces is two sets of
 * marks, one addressed at each side, plus a list of changes in the terms a
 * reader would use rather than the terms the source used.
 *
 * It is deliberately separate from `rendered-tree.ts`: that module ships into
 * the frame's inlined bundle, this one must not, and keeping the dependency on
 * the diff library here is what makes that true by construction.
 */

export interface RenderedChange {
  readonly kind: MarkKind;
  /** What a reader would call it: 'heading', 'paragraph', 'image'. */
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** Word-level pieces of `before` and `after`, for rows that show them. */
  readonly segments?: {
    readonly before: readonly DiffSegment[];
    readonly after: readonly DiffSegment[];
  };
  /** Where this row sits in `jumps`, so pressing it goes to the thing. */
  readonly jumpIndex?: number;
}

/**
 * One stop on the way through a comparison.
 *
 * Recorded in the order the walk emits them, which is the order the two
 * documents are read in: the comparison descends both trees in lockstep, so
 * a removal on one side and an addition on the other arrive interleaved
 * rather than in two separate runs. Sorting them afterwards by anything
 * this side can measure would be a guess at that order.
 */
export interface ChangeJump {
  /** Which pane holds the node. A removal exists only in the older one. */
  readonly side: 'before' | 'after';
  readonly changeId: string;
  readonly kind: MarkKind;
}

export interface TreeDiff {
  readonly changed: boolean;
  /** Element paths into the historical tree. */
  readonly removedMarks: readonly Mark[];
  /** Element paths into the current tree. */
  readonly addedMarks: readonly Mark[];
  /**
   * Matched content, paired so the two panes can be aligned on it.
   *
   * Changed nodes are too sparse to align by. A version that inserts two
   * paragraphs at the top and edits nothing else gives the scroll sync one
   * reference point, at the top, and every screen after it fell back to
   * matching page fractions, which are off by exactly the height of the
   * insertion. These are the nodes the diff already proved identical, so
   * agreeing on them costs nothing and is the thing a reader is looking at
   * most of the time.
   */
  readonly beforeAnchors: readonly Anchor[];
  readonly afterAnchors: readonly Anchor[];
  /** Every change, in reading order, addressable. */
  readonly jumps: readonly ChangeJump[];
  readonly additions: number;
  readonly removals: number;
  readonly changes: readonly RenderedChange[];
  readonly summary: string;
}

/**
 * How many changes are listed.
 *
 * A rewritten document changes every node, and a list of every one of them is
 * a wall rather than a summary. The count in the heading stays exact; the list
 * stops.
 */
export const MAX_LISTED_CHANGES = 40;

/** How much of a changed string is quoted before it is cut. */
const MAX_QUOTED = 160;

function quote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_QUOTED
    ? `${trimmed.slice(0, MAX_QUOTED)}\u2026`
    : trimmed;
}

function serialiseAttrs(node: TreeNode): string {
  return node.attrs.map(([name, value]) => `${name}=${value}`).join(' ');
}

/**
 * What makes two children the same child.
 *
 * Content, not shape. A key of tag and attributes alone would match any two
 * paragraphs at the same index, so inserting one near the top would report
 * every paragraph after it as changed. Including what the node renders means
 * the matcher finds the paragraphs that genuinely did not move, and the
 * leftovers are handled by pairing below.
 */
function contentKey(node: TreeNode): string {
  return node.tag === '#text'
    ? `#text:${node.text}`
    : `${node.tag}[${serialiseAttrs(node)}]${textOf(node).slice(0, 200)}`;
}

/** Elements accept an attribute; text nodes do not, so marks stop at one. */
function nearestElement(node: TreeNode, path: NodePath): NodePath {
  return node.tag === '#text' ? path.slice(0, -1) : path;
}

/**
 * Tags worth anchoring.
 *
 * Block-level content, because that is what a reader scrolls to and what has
 * a stable top. Anchoring inline nodes would put a reference on every
 * emphasis and link in the document, multiply the work the scroll handler
 * does on every frame, and align the panes on a word rather than on the
 * paragraph the word is in.
 */
const ANCHOR_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'img',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
  'video',
]);

interface Collector {
  readonly removed: Mark[];
  readonly added: Mark[];
  readonly beforeAnchors: Anchor[];
  readonly afterAnchors: Anchor[];
  readonly jumps: ChangeJump[];
  nextChangeId: number;
  readonly changes: RenderedChange[];
  additions: number;
  removals: number;
  /** Counted separately from `changes`, which stops at the list cap. */
  changedCount: number;
  /** Sequence shared by the two mark arrays, unique inside one diff. */
  nextSyncId: number;
  /**
   * Anchors count separately.
   *
   * The `a` prefix already keeps the two namespaces from colliding, and a
   * shared counter would make a change's id depend on how much unchanged
   * content happened to precede it. Ids that move when nothing about the
   * change moved are a needless way to break anything holding one.
   */
  nextAnchorId: number;
}

/**
 * Record a mark, and say whether it was new.
 *
 * The caller needs to know, because a jump entry belongs to a node rather
 * than to a call: a heading whose text and attributes both changed reaches
 * here twice and is one stop, not two.
 */
function mark(
  into: Mark[],
  path: NodePath,
  kind: MarkKind,
  syncId?: string,
  changeId?: string
): boolean {
  const key = path.join('.');
  // One element, one mark. A changed heading whose text also moved would
  // otherwise be marked twice and outlined twice. If that earlier mark had no
  // counterpart and this pass finds one, enrich rather than duplicate it.
  const at = into.findIndex((existing) => existing.path.join('.') === key);
  if (at !== -1) {
    const existing = into[at];
    if (
      existing !== undefined &&
      existing.syncId === undefined &&
      syncId !== undefined
    ) {
      into[at] = { ...existing, syncId };
    }
    return false;
  }
  into.push({
    path,
    kind,
    ...(syncId === undefined ? {} : { syncId }),
    ...(changeId === undefined ? {} : { changeId }),
  });
  return true;
}

/** One stop, named, on whichever side carries it. */
function jump(
  into: Collector,
  side: 'before' | 'after',
  kind: MarkKind
): string {
  const changeId = `c${into.nextChangeId}`;
  into.nextChangeId += 1;
  into.jumps.push({ side, changeId, kind });
  return changeId;
}

/** Give the two nodes one identity only when the diff actually paired them. */
function markPair(
  into: Collector,
  beforePath: NodePath,
  afterPath: NodePath,
  beforeKind: MarkKind = 'changed',
  afterKind: MarkKind = 'changed'
): number | undefined {
  const syncId = `d${into.nextSyncId}`;
  into.nextSyncId += 1;
  // The stop is recorded against the newer side, because that is the text a
  // reader is deciding about. The older pane follows through the sync, so
  // both are on screen either way.
  const changeId = `c${into.nextChangeId}`;
  const fresh = mark(into.added, afterPath, afterKind, syncId, changeId);
  mark(into.removed, beforePath, beforeKind, syncId);
  if (!fresh) return undefined;
  into.nextChangeId += 1;
  into.jumps.push({ side: 'after', changeId, kind: afterKind });
  return into.jumps.length - 1;
}

/**
 * Agree on one unchanged node, so both panes can be aligned on it.
 *
 * The two sides always mean the same node by the same name, which is the
 * whole point: the follower resolves the leader's id in its own document.
 */
function anchorPair(
  into: Collector,
  before: TreeNode,
  beforePath: NodePath,
  afterPath: NodePath
): void {
  if (before.tag === '#text') return;
  if (!ANCHOR_TAGS.has(before.tag)) return;
  const syncId = `a${into.nextAnchorId}`;
  into.nextAnchorId += 1;
  into.beforeAnchors.push({ path: beforePath, syncId });
  into.afterAnchors.push({ path: afterPath, syncId });
}

function collectRemoved(
  node: TreeNode,
  path: NodePath,
  into: Collector,
  syncId?: string
): number | undefined {
  const changeId = jump(into, 'before', 'removed');
  const fresh = mark(
    into.removed,
    nearestElement(node, path),
    'removed',
    syncId,
    changeId
  );
  // Counted per change, the same unit the change list and the navigator
  // count. Counting tree nodes instead made one comparison report two
  // different totals: a paragraph and its text are two nodes and one thing
  // a reader would say was added, so "4 added, 1 changed" sat above a list
  // of three rows and a navigator saying 3 changes.
  if (fresh) into.removals += 1;
  if (!fresh) {
    into.jumps.pop();
    into.nextChangeId -= 1;
    return undefined;
  }
  return into.jumps.length - 1;
}

function collectAdded(
  node: TreeNode,
  path: NodePath,
  into: Collector,
  syncId?: string
): number | undefined {
  const changeId = jump(into, 'after', 'added');
  const fresh = mark(
    into.added,
    nearestElement(node, path),
    'added',
    syncId,
    changeId
  );
  if (fresh) into.additions += 1;
  if (!fresh) {
    into.jumps.pop();
    into.nextChangeId -= 1;
    return undefined;
  }
  return into.jumps.length - 1;
}

function compare(
  before: TreeNode,
  after: TreeNode,
  beforePath: NodePath,
  afterPath: NodePath,
  parentTag: string,
  into: Collector
): void {
  if (before.tag === '#text' && after.tag === '#text') {
    if (before.text === after.text) return;
    const jumpIndex = markPair(
      into,
      beforePath.slice(0, -1),
      afterPath.slice(0, -1)
    );
    into.changedCount += 1;
    if (into.changes.length < MAX_LISTED_CHANGES) {
      into.changes.push({
        ...(jumpIndex === undefined ? {} : { jumpIndex }),
        kind: 'changed',
        label: labelForTag(parentTag),
        before: quote(before.text),
        after: quote(after.text),
      });
    }
    return;
  }

  if (before.tag !== after.tag) {
    const syncId = `d${into.nextSyncId}`;
    into.nextSyncId += 1;
    collectRemoved(before, beforePath, into, syncId);
    collectAdded(after, afterPath, into, syncId);
    return;
  }

  const beforeAttrs = serialiseAttrs(before);
  const afterAttrs = serialiseAttrs(after);
  if (beforeAttrs !== afterAttrs) {
    const jumpIndex = markPair(into, beforePath, afterPath);
    into.changedCount += 1;
    if (into.changes.length < MAX_LISTED_CHANGES) {
      into.changes.push({
        ...(jumpIndex === undefined ? {} : { jumpIndex }),
        kind: 'changed',
        label: labelForTag(before.tag),
        before: quote(beforeAttrs),
        after: quote(afterAttrs),
      });
    }
  }

  const changes = diffArrays(
    before.children.map(contentKey),
    after.children.map(contentKey)
  );
  let beforeIndex = 0;
  let afterIndex = 0;

  for (let at = 0; at < changes.length; at++) {
    const change = changes[at];
    if (change === undefined) continue;
    const count = change.count ?? change.value.length;

    if (change.added !== true && change.removed !== true) {
      for (let step = 0; step < count; step++) {
        const beforeChild = before.children[beforeIndex + step];
        const afterChild = after.children[afterIndex + step];
        if (beforeChild !== undefined && afterChild !== undefined) {
          // Matched by content, which is what makes it worth aligning on.
          // Recorded before the recursion so a container is anchored even
          // when something inside it turns out to have changed: the change
          // gets its own paired id and wins the attribute, and the
          // container keeps the panes together everywhere around it.
          anchorPair(
            into,
            beforeChild,
            [...beforePath, beforeIndex + step],
            [...afterPath, afterIndex + step]
          );
          compare(
            beforeChild,
            afterChild,
            [...beforePath, beforeIndex + step],
            [...afterPath, afterIndex + step],
            before.tag,
            into
          );
        }
      }
      beforeIndex += count;
      afterIndex += count;
      continue;
    }

    // A removed run immediately followed by an added run is a modification,
    // not a deletion and an insertion. Without this pairing, editing a word
    // in a heading would report the whole heading gone and a new one arrived,
    // and a page whose every paragraph was edited would report nothing
    // changed and everything replaced.
    const next = changes[at + 1];
    if (
      change.removed === true &&
      next?.added === true &&
      change.value.length > 0
    ) {
      const nextCount = next.count ?? next.value.length;
      const paired = Math.min(count, nextCount);
      for (let step = 0; step < paired; step++) {
        const beforeChild = before.children[beforeIndex + step];
        const afterChild = after.children[afterIndex + step];
        if (beforeChild === undefined || afterChild === undefined) continue;
        compare(
          beforeChild,
          afterChild,
          [...beforePath, beforeIndex + step],
          [...afterPath, afterIndex + step],
          before.tag,
          into
        );
      }
      for (let step = paired; step < count; step++) {
        removeChild(before, beforePath, beforeIndex + step, into);
      }
      for (let step = paired; step < nextCount; step++) {
        addChild(after, afterPath, afterIndex + step, into);
      }
      beforeIndex += count;
      afterIndex += nextCount;
      at += 1;
      continue;
    }

    if (change.removed === true) {
      for (let step = 0; step < count; step++) {
        removeChild(before, beforePath, beforeIndex + step, into);
      }
      beforeIndex += count;
      continue;
    }

    for (let step = 0; step < count; step++) {
      addChild(after, afterPath, afterIndex + step, into);
    }
    afterIndex += count;
  }
}

function removeChild(
  parent: TreeNode,
  path: NodePath,
  index: number,
  into: Collector
): void {
  const child = parent.children[index];
  if (child === undefined) return;
  const jumpIndex = collectRemoved(child, [...path, index], into);
  if (into.changes.length < MAX_LISTED_CHANGES) {
    into.changes.push({
      ...(jumpIndex === undefined ? {} : { jumpIndex }),
      kind: 'removed',
      label: labelForTag(child.tag),
      before: quote(textOf(child)),
      after: '',
    });
  }
}

function addChild(
  parent: TreeNode,
  path: NodePath,
  index: number,
  into: Collector
): void {
  const child = parent.children[index];
  if (child === undefined) return;
  const jumpIndex = collectAdded(child, [...path, index], into);
  if (into.changes.length < MAX_LISTED_CHANGES) {
    into.changes.push({
      ...(jumpIndex === undefined ? {} : { jumpIndex }),
      kind: 'added',
      label: labelForTag(child.tag),
      before: '',
      after: quote(textOf(child)),
    });
  }
}

/** Everything a node renders as text, for naming it in the change list. */
function textOf(node: TreeNode): string {
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join(' ');
}

function plural(count: number, word: string): string {
  return `${count} ${word}`;
}

export function diffTrees(before: TreeNode, after: TreeNode): TreeDiff {
  const into: Collector = {
    removed: [],
    added: [],
    beforeAnchors: [],
    afterAnchors: [],
    changes: [],
    additions: 0,
    removals: 0,
    changedCount: 0,
    nextSyncId: 0,
    nextAnchorId: 0,
    jumps: [],
    nextChangeId: 0,
  };
  compare(before, after, [], [], '#root', into);

  const changed =
    into.additions > 0 || into.removals > 0 || into.changedCount > 0;

  if (!changed) {
    return {
      changed: false,
      removedMarks: [],
      addedMarks: [],
      // Kept even here. Two versions that render identically are still two
      // documents being scrolled together, and anchoring them on their own
      // content costs nothing and is exactly as correct as it looks.
      beforeAnchors: into.beforeAnchors,
      afterAnchors: into.afterAnchors,
      jumps: [],
      additions: 0,
      removals: 0,
      changes: [],
      // Deliberately not the byte-identical wording `diff.ts` uses. Two
      // different sources can render the same page, and calling their content
      // identical would be a lie about bytes nobody compared.
      summary: 'No changes. These versions render identically.',
    };
  }

  // Added, removed, changed, in that order, because that is how the spec
  // states the copy and how a reader scans it.
  const terms: string[] = [];
  if (into.additions > 0) terms.push(plural(into.additions, 'added'));
  if (into.removals > 0) terms.push(plural(into.removals, 'removed'));
  if (into.changedCount > 0) terms.push(plural(into.changedCount, 'changed'));

  return {
    changed: true,
    removedMarks: into.removed,
    addedMarks: into.added,
    beforeAnchors: into.beforeAnchors,
    afterAnchors: into.afterAnchors,
    jumps: into.jumps,
    additions: into.additions,
    removals: into.removals,
    changes: into.changes,
    summary: `${terms.join(', ')}.`,
  };
}
