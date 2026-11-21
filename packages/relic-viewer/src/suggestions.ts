import { mergeSuggestions } from '@relic/format/suggestions';
import {
  codeSegments,
  renderMarkdownWithSource,
  type MarkdownDelimiterPair,
  type SourceSegment,
} from './markdown-source.ts';
import {
  SUGGESTION_NOT_FOUND,
  type SuggestionView,
  type SuggestionViews,
} from './suggestion-views.ts';

export {
  buildSuggestionViews,
  OLDER_VERSION_REASON,
  SUGGESTION_NOT_FOUND,
} from './suggestion-views.ts';
export type {
  SuggestionConflict,
  SuggestionLocation,
  SuggestionThreadRow,
  SuggestionView,
  SuggestionViews,
} from './suggestion-views.ts';
export { codeSegments, renderMarkdownWithSource } from './markdown-source.ts';
export { SuggestDraftModel } from './suggest-draft.ts';
export { SuggestTransport } from './suggest-transport.ts';

export const SUGGESTION_LAYOUT_MISMATCH =
  "This document's layout could not be matched to its source.";

const sourceDelimiters = new WeakMap<
  SuggestionViews,
  readonly MarkdownDelimiterPair[]
>();

type Leaf = {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
  readonly join: boolean;
  readonly block: number;
};

type PaintOperation = {
  readonly from: number;
  readonly to: number;
  readonly kind: 'strike' | 'insert' | 'applied' | 'gap';
  readonly view: SuggestionView;
  readonly decorate: boolean;
  readonly order: number;
  readonly block: number;
};

function textNodes(root: Node): Text[] {
  const found: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      found.push(node as Text);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return found;
}

/** The segment check runs before any marks are written, and fails closed. */
function sourceLeaves(
  root: HTMLElement,
  segments: readonly SourceSegment[],
  kind: 'markdown' | 'code'
): Leaf[] | null {
  const holders: Element[] =
    kind === 'code'
      ? [root]
      : [
          ...(root.getAttribute('data-seg') !== null ? [root] : []),
          ...Array.from(root.querySelectorAll('[data-seg]')),
        ];
  if (holders.length !== segments.length) return null;
  const leaves: Leaf[] = [];
  for (let i = 0; i < holders.length; i++) {
    const holder = holders[i];
    const segment = segments[i];
    if (
      !holder ||
      !segment ||
      (kind === 'markdown' && holder.getAttribute('data-seg') !== String(i)) ||
      holder.textContent !== segment.text
    )
      return null;
    if (segment.start === segment.end && holder.childNodes.length === 0)
      holder.appendChild(holder.ownerDocument.createTextNode(''));
    let offset = 0;
    for (const node of textNodes(holder)) {
      const length = node.data.length;
      const join = segment.kind === 'join' || segment.kind === 'escape';
      const start = join ? segment.start : segment.start + offset;
      const end = join ? segment.end : start + length;
      leaves.push({ node, start, end, join, block: segment.block });
      offset += length;
    }
  }
  return leaves;
}

function pointIn(
  leaf: Leaf,
  sourcePosition: number,
  side: 'before' | 'after'
): number {
  if (leaf.join) {
    if (sourcePosition <= leaf.start) return 0;
    if (sourcePosition >= leaf.end) return leaf.node.data.length;
    return side === 'before' ? 0 : leaf.node.data.length;
  }
  return Math.max(
    0,
    Math.min(leaf.node.data.length, sourcePosition - leaf.start)
  );
}

function pointLeaf(
  leaves: readonly Leaf[],
  position: number,
  side: 'before' | 'after'
): Leaf | undefined {
  const empty = leaves.find(
    (leaf) => leaf.start === position && leaf.end === position
  );
  if (empty) return empty;
  if (side === 'before') {
    return (
      leaves.find((leaf) => leaf.start <= position && position < leaf.end) ??
      leaves.find((leaf) => leaf.start >= position) ??
      leaves[leaves.length - 1]
    );
  }
  for (let i = leaves.length - 1; i >= 0; i--) {
    const leaf = leaves[i];
    if (leaf && leaf.start < position && position <= leaf.end) return leaf;
  }
  for (let i = leaves.length - 1; i >= 0; i--) {
    const leaf = leaves[i];
    if (leaf && leaf.end <= position) return leaf;
  }
  return leaves[0];
}

function addOperation(
  ops: Map<Text, PaintOperation[]>,
  leaf: Leaf,
  op: PaintOperation
): void {
  const list = ops.get(leaf.node) ?? [];
  list.push(op);
  ops.set(leaf.node, list);
}

function addRange(
  ops: Map<Text, PaintOperation[]>,
  leaves: readonly Leaf[],
  start: number,
  end: number,
  kind: 'strike' | 'applied',
  view: SuggestionView,
  order: number,
  decorate: boolean
): void {
  const matches = leaves.filter((leaf) => start < leaf.end && leaf.start < end);
  for (let i = 0; i < matches.length; i++) {
    const leaf = matches[i];
    if (!leaf) continue;
    addOperation(ops, leaf, {
      from: leaf.join ? 0 : Math.max(0, start - leaf.start),
      to: leaf.join
        ? leaf.node.data.length
        : Math.min(leaf.node.data.length, end - leaf.start),
      kind,
      view,
      order,
      decorate: decorate && i === matches.length - 1,
      block: leaf.block,
    });
  }
}

function addPoint(
  ops: Map<Text, PaintOperation[]>,
  leaves: readonly Leaf[],
  position: number,
  side: 'before' | 'after',
  kind: 'insert' | 'gap',
  view: SuggestionView,
  order: number,
  decorate: boolean
): void {
  const leaf = pointLeaf(leaves, position, side);
  if (!leaf) return;
  const offset = pointIn(leaf, position, side);
  addOperation(ops, leaf, {
    from: offset,
    to: offset,
    kind,
    view,
    order,
    decorate,
    block: leaf.block,
  });
}

function element(
  doc: Document,
  tag: string,
  className: string,
  text?: string
): HTMLElement {
  const result = doc.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function displayName(view: SuggestionView): string {
  return view.row.plaintext.display_name || view.row.author;
}

function changeWrapper(
  doc: Document,
  view: SuggestionView,
  older: boolean
): HTMLElement {
  const wrap = element(doc, 'span', 'sg-chg');
  if (view.mine) wrap.classList.add('is-mine');
  if (view.conflict) wrap.classList.add('is-conflict');
  if (older) {
    if (view.state.state === 'accepted') wrap.classList.add('is-out-ok');
    else if (
      ['superseded', 'declined', 'withdrawn', 'closed'].includes(
        view.state.state
      )
    )
      wrap.classList.add('is-out-quiet');
  }
  wrap.setAttribute('data-sg-paint', 'wrap');
  wrap.setAttribute('data-sg-id', view.row.id);
  wrap.setAttribute('tabindex', '0');
  wrap.setAttribute(
    'aria-label',
    `Suggestion by ${displayName(view)}: ${view.state.text}`
  );
  return wrap;
}

function chip(
  doc: Document,
  text: string,
  className: string,
  title: string
): HTMLElement {
  const result = element(
    doc,
    'sup',
    `sg-chip${className ? ` ${className}` : ''}`,
    text
  );
  result.setAttribute('data-sg-paint', 'decoration');
  result.setAttribute('data-sg-decoration', '');
  result.setAttribute('contenteditable', 'false');
  result.setAttribute('title', title);
  return result;
}

function decorate(
  wrap: HTMLElement,
  view: SuggestionView,
  views: SuggestionViews
): void {
  const doc = wrap.ownerDocument;
  if (view.conflict) {
    const count = view.conflict.members.length;
    wrap.appendChild(
      chip(doc, String(count), '', `${count} suggestions on this passage`)
    );
  }
  if (view.also.length) {
    const names = view.also.flatMap((id) => {
      const other = views.byId.get(id);
      return other ? [displayName(other)] : [];
    });
    if (names.length)
      wrap.appendChild(
        chip(
          doc,
          `also ${names.join(', ')}`,
          'is-soft',
          `Also suggested by ${names.join(', ')}`
        )
      );
  }
  if (views.olderVersionReason) {
    wrap.appendChild(
      chip(
        doc,
        view.state.text,
        `is-out${view.state.state === 'accepted' ? ' is-ok' : ''}`,
        view.state.text
      )
    );
  } else if (view.mine) {
    wrap.appendChild(chip(doc, 'you', 'is-soft', 'Your suggestion'));
  }
}

function paintNodes(
  ops: Map<Text, PaintOperation[]>,
  views: SuggestionViews,
  decode?: (block: number, source: string) => string
): void {
  for (const [node, operations] of ops) {
    const parent = node.parentNode;
    if (!parent) continue;
    const doc = node.ownerDocument;
    const sourceText = node.data;
    operations.sort(
      (a, b) =>
        a.from - b.from ||
        (a.from === a.to ? -1 : 1) - (b.from === b.to ? -1 : 1) ||
        a.order - b.order
    );
    let cursor = 0;
    for (const op of operations) {
      if (op.from > cursor) {
        parent.insertBefore(
          doc.createTextNode(sourceText.slice(cursor, op.from)),
          node
        );
        cursor = op.from;
      }
      if (op.kind === 'strike' || op.kind === 'applied') {
        const from = Math.max(cursor, op.from);
        if (from >= op.to) continue;
        if (op.kind === 'applied') {
          const mark = element(
            doc,
            'span',
            'sg-applied',
            sourceText.slice(from, op.to)
          );
          mark.setAttribute('data-sg', op.view.row.id);
          parent.insertBefore(mark, node);
        } else {
          const wrap = changeWrapper(
            doc,
            op.view,
            views.olderVersionReason !== null
          );
          const del = element(
            doc,
            'del',
            'sg-del',
            sourceText.slice(from, op.to)
          );
          del.setAttribute('data-sg', op.view.row.id);
          del.setAttribute('data-sg-paint', 'struck');
          wrap.appendChild(del);
          if (op.decorate) decorate(wrap, op.view, views);
          parent.insertBefore(wrap, node);
        }
        cursor = op.to;
      } else if (op.kind === 'insert') {
        const wrap = changeWrapper(
          doc,
          op.view,
          views.olderVersionReason !== null
        );
        const ins = element(
          doc,
          'ins',
          'sg-ins',
          decode?.(op.block, op.view.input?.suggestion.replacement ?? '') ??
            op.view.input?.suggestion.replacement ??
            ''
        );
        ins.setAttribute('data-sg', op.view.row.id);
        ins.setAttribute('data-sg-paint', 'inserted');
        wrap.appendChild(ins);
        if (op.decorate) decorate(wrap, op.view, views);
        parent.insertBefore(wrap, node);
      } else {
        const gap = element(doc, 'span', 'sg-applied-gap');
        gap.setAttribute('data-sg', op.view.row.id);
        gap.setAttribute('title', 'Text removed by a suggestion');
        parent.insertBefore(gap, node);
      }
    }
    if (cursor < sourceText.length)
      parent.insertBefore(doc.createTextNode(sourceText.slice(cursor)), node);
    parent.removeChild(node);
  }
}

/** Remove only nodes made by this painter, retaining existing comment marks. */
export function clearSuggestionPaint(root: HTMLElement): void {
  const marked = Array.from(root.querySelectorAll('[data-sg-paint]')).reverse();
  for (const node of marked) {
    const parent = node.parentNode;
    if (!parent) continue;
    const role = node.getAttribute('data-sg-paint');
    if (role === 'inserted' || role === 'decoration') {
      parent.removeChild(node);
    } else {
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    }
  }
}

export type SuggestionPaintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: typeof SUGGESTION_LAYOUT_MISMATCH };

/** Paint on the already-mounted source map, after ordinary comment marks. */
export function paintSuggestions(
  root: HTMLElement,
  segments: readonly SourceSegment[],
  views: SuggestionViews,
  kind: 'markdown' | 'code',
  decode?: (block: number, source: string) => string
): SuggestionPaintResult {
  clearSuggestionPaint(root);
  const leaves = sourceLeaves(root, segments, kind);
  if (!leaves) return { ok: false, reason: SUGGESTION_LAYOUT_MISMATCH };
  const ops = new Map<Text, PaintOperation[]>();
  views.paint.forEach((view, order) => {
    if (view.location.status !== 'resolved' || !view.input) return;
    const { start, end } = view.location;
    const replacement = view.input.suggestion.replacement;
    if (start < end)
      addRange(
        ops,
        leaves,
        start,
        end,
        'strike',
        view,
        order,
        replacement === ''
      );
    if (replacement !== '') {
      const side = view.input.suggestion.mode === 'before' ? 'before' : 'after';
      addPoint(ops, leaves, end, side, 'insert', view, order, true);
    }
  });
  paintNodes(ops, views, decode);
  return { ok: true };
}

interface AppliedRange {
  readonly start: number;
  readonly end: number;
  readonly view: SuggestionView;
}

function appliedRanges(
  views: SuggestionViews,
  appliedIds: ReadonlySet<string>
): AppliedRange[] {
  const ranges: AppliedRange[] = [];
  let delta = 0;
  for (const resolved of views.resolved) {
    if (resolved.status !== 'resolved' || !appliedIds.has(resolved.id))
      continue;
    const view = views.byId.get(resolved.id);
    if (!view?.input) continue;
    const start = resolved.start + delta;
    const end = start + view.input.suggestion.replacement.length;
    ranges.push({ start, end, view });
    delta +=
      view.input.suggestion.replacement.length -
      (resolved.end - resolved.start);
  }
  return ranges;
}

function overlapsLink(
  range: AppliedRange,
  start: number,
  end: number
): boolean {
  return range.start === range.end
    ? range.start >= start && range.start <= end
    : range.start < end && range.end > start;
}

function disableEditedLinks(
  body: HTMLElement,
  source: string,
  segments: readonly SourceSegment[],
  delimiters: readonly MarkdownDelimiterPair[],
  ranges: readonly AppliedRange[]
): void {
  const pairs = delimiters.filter((delimiter) => delimiter.kind === 'link');
  for (const anchor of Array.from(body.querySelectorAll('a'))) {
    const child = anchor.querySelector('[data-seg]');
    const index = Number(child?.getAttribute('data-seg'));
    const segment = child ? segments[index] : undefined;
    if (!segment) continue;
    const pair = pairs.find(
      (candidate) =>
        candidate.open.end <= segment.start &&
        segment.end <= candidate.close.start
    );
    if (!pair) continue;
    const closeParen = source.indexOf(')', pair.close.end);
    const end = closeParen < 0 ? pair.close.end : closeParen + 1;
    if (!ranges.some((range) => overlapsLink(range, pair.open.start, end)))
      continue;
    anchor.removeAttribute('href');
    anchor.setAttribute('title', 'Link added by a suggestion');
  }
}

/** A detached, read-only document. IDs on faint marks let the caller offer Reply. */
export function renderAppliedView(
  views: SuggestionViews,
  kind: 'markdown' | 'code',
  doc: Document = document
): HTMLElement {
  const merged = mergeSuggestions(
    views.source,
    views.resolved,
    views.inputs,
    'defaults'
  );
  const ranges = appliedRanges(
    views,
    new Set(merged.applied.map((item) => item.id))
  );
  let root: HTMLElement;
  let paintRoot: HTMLElement;
  let segments: readonly SourceSegment[];
  if (kind === 'markdown') {
    const mapped = renderMarkdownWithSource(merged.text);
    // The renderer escapes source before generating its fixed markup. Parsing a
    // detached document never uses an HTML assignment on the key-holding page.
    const parsed = new DOMParser().parseFromString(mapped.html, 'text/html');
    disableEditedLinks(
      parsed.body,
      merged.text,
      mapped.segments,
      mapped.delimiters,
      ranges
    );
    root = element(doc, 'article', 'prose');
    while (parsed.body.firstChild) root.appendChild(parsed.body.firstChild);
    paintRoot = root;
    segments = mapped.segments;
  } else {
    root = element(doc, 'div', 'code');
    const gutter = element(
      doc,
      'pre',
      'gutter',
      merged.text
        .split('\n')
        .map((_, i) => String(i + 1))
        .join('\n')
    );
    gutter.setAttribute('aria-hidden', 'true');
    paintRoot = element(doc, 'pre', 'code-body', merged.text);
    root.append(gutter, paintRoot);
    segments = codeSegments(merged.text);
  }
  const leaves = sourceLeaves(paintRoot, segments, kind);
  if (leaves?.length === 0) {
    for (const range of ranges) {
      if (range.start !== range.end) continue;
      const gap = element(doc, 'span', 'sg-applied-gap');
      gap.setAttribute('data-sg', range.view.row.id);
      gap.setAttribute('title', 'Text removed by a suggestion');
      paintRoot.appendChild(gap);
    }
  } else if (leaves) {
    const ops = new Map<Text, PaintOperation[]>();
    ranges.forEach((range, order) => {
      if (range.start < range.end)
        addRange(
          ops,
          leaves,
          range.start,
          range.end,
          'applied',
          range.view,
          order,
          false
        );
      else
        addPoint(
          ops,
          leaves,
          range.start,
          'after',
          'gap',
          range.view,
          order,
          false
        );
    });
    paintNodes(ops, views);
  }
  return root;
}

function cardRow(
  doc: Document,
  label: string,
  contents: readonly Node[]
): HTMLElement {
  const row = element(doc, 'div', 'card-row');
  row.appendChild(element(doc, 'span', 'k', label));
  const value = element(doc, 'span', 'v');
  value.append(...contents);
  row.appendChild(value);
  return row;
}

function containsMarkdown(text: string): boolean {
  return /(?:\*\*|~~|`|\[[^\]]+\]\([^)]*\)|(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|>\s|```)|\*[^*]+\*)/.test(
    text
  );
}

/** Pieces for the existing shared row/card, not a second comment renderer. */
export function renderSuggestionCard(
  view: SuggestionView,
  views: SuggestionViews,
  doc: Document = document,
  kind: 'markdown' | 'code' = 'markdown'
): HTMLElement {
  const card = element(doc, 'div', 'sg-card-pieces');
  const input = view.input;
  const suggestion = view.row.plaintext.suggestion;
  if (suggestion) {
    const diff = element(doc, 'div', 'card-diff');
    if (suggestion.mode === 'replace' && input?.exact)
      diff.appendChild(element(doc, 'del', 'sg-del', input.exact));
    if (suggestion.replacement)
      diff.appendChild(element(doc, 'ins', 'sg-ins', suggestion.replacement));
    card.appendChild(diff);
    const struck = suggestion.mode === 'replace' ? (input?.exact ?? '') : '';
    let sourceBefore = struck;
    let sourceAfter = suggestion.replacement;
    let hasSyntax =
      containsMarkdown(sourceBefore) || containsMarkdown(sourceAfter);
    if (kind === 'markdown' && input && view.location.status === 'resolved') {
      const start = view.location.start;
      const end = view.location.end;
      let delimiters = sourceDelimiters.get(views);
      if (!delimiters) {
        delimiters = renderMarkdownWithSource(views.source).delimiters;
        sourceDelimiters.set(views, delimiters);
      }
      const pair = delimiters.find(
        (item) => item.open.end <= start && end <= item.close.start
      );
      if (pair) {
        let sourceEnd = pair.close.end;
        if (pair.kind === 'link' || pair.kind === 'image') {
          const closeParen = views.source.indexOf(')', sourceEnd);
          if (closeParen >= 0) sourceEnd = closeParen + 1;
        }
        sourceBefore = views.source.slice(pair.open.start, sourceEnd);
        sourceAfter =
          views.source.slice(pair.open.start, start) +
          suggestion.replacement +
          views.source.slice(end, sourceEnd);
        hasSyntax = true;
      }
    }
    if (kind === 'markdown' && input && hasSyntax) {
      card.appendChild(
        cardRow(doc, 'Source:', [
          element(doc, 'code', '', sourceBefore),
          doc.createTextNode(' → '),
          element(doc, 'code', '', sourceAfter),
        ])
      );
    }
  }
  if (view.also.length) {
    const people = view.also.flatMap((id) => {
      const other = views.byId.get(id);
      return other ? [`${displayName(other)} (${other.row.author})`] : [];
    });
    if (people.length)
      card.appendChild(
        cardRow(doc, 'Also', [
          doc.createTextNode(`Also suggested by ${people.join(', ')}`),
        ])
      );
  }
  const status = element(doc, 'span', 'card-status');
  const tone =
    view.state.state === 'accepted'
      ? ' is-ok'
      : [
            'pending',
            'superseded',
            'declined',
            'withdrawn',
            'closed',
            'unanswered',
          ].includes(view.state.state)
        ? ' is-soft'
        : '';
  status.appendChild(
    element(doc, 'span', `comment-badge${tone}`, view.state.text)
  );
  if (view.state.state === 'pending') {
    status.appendChild(
      element(
        doc,
        'span',
        '',
        view.mine
          ? 'Waiting for the publisher. To change it, type in it while Suggesting.'
          : 'Waiting for the publisher. A reply does not settle it.'
      )
    );
  }
  card.appendChild(cardRow(doc, 'State', [status]));
  if (view.answerNote) {
    const notes = element(doc, 'ol', 'card-replies');
    notes.setAttribute('aria-label', 'Publisher note');
    const note = element(doc, 'li', '');
    note.appendChild(element(doc, 'p', 'card-reply-body', view.answerNote));
    notes.appendChild(note);
    card.appendChild(notes);
  }
  if (
    view.location.status === 'ambiguous' ||
    view.location.status === 'lost' ||
    view.location.status === 'unsupported'
  ) {
    card.appendChild(
      element(doc, 'p', 'comment-unplaceable', SUGGESTION_NOT_FOUND)
    );
  }
  if (view.conflict && view.conflict.defaultId === view.row.id) {
    const members = element(doc, 'ol', 'card-members');
    const firstName = displayName(view).split(/\s+/)[0] ?? displayName(view);
    card.appendChild(
      element(
        doc,
        'p',
        'card-note',
        `The applied view shows ${firstName}'s (posted first).`
      )
    );
    for (const id of view.conflict.members) {
      const member = views.byId.get(id);
      if (!member?.input) continue;
      const item = element(doc, 'li', 'card-member');
      item.appendChild(
        element(doc, 'span', 'card-member-who', displayName(member))
      );
      const open = element(
        doc,
        'button',
        'popover-action',
        views.olderVersionReason ? 'Open' : 'Reply'
      );
      open.setAttribute('type', 'button');
      open.setAttribute('data-sg-open', id);
      item.appendChild(open);
      const text = element(doc, 'span', 'card-member-text');
      text.appendChild(
        element(doc, 'ins', 'sg-ins', member.input.suggestion.replacement)
      );
      item.appendChild(text);
      members.appendChild(item);
    }
    card.appendChild(members);
  }
  return card;
}
