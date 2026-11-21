/**
 * The tree view for `.json` (plan A2, sections 4, 5 and 7).
 *
 * Every value in the file is drawn as text through `textContent`, never as
 * markup, so a key such as `<img onerror>` is a string the reader sees. Only
 * the rows in the window are in the DOM. Expansion, selection and marks live in
 * `JsonTreeState`, which the tests drive without a browser.
 *
 * A file the reader cannot show as a tree gets the reason above its source,
 * and that source is the view. The reason is a notice in the same root, so the
 * reader is told why instead of seeing a silent fallback.
 */

import { parseJsonTree, type CommentAnchor } from '@relic/format';
import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';
import { structuredViewFor } from './structured-view-bridge.ts';
import {
  breadcrumbFor,
  JsonTreeState,
  keyLabel,
  nodeForAnchor,
  noticeFor,
  pointerWritable,
  summaryText,
  TREE_EXPAND_ALL_LIMIT,
  TREE_INSPECTOR_CUT_CHARS,
  TREE_VALUE_CUT_CHARS,
  valueLabel,
  visibleText,
} from './json-tree-rows.ts';
import { rowWindow } from './table-model.ts';
import { visibleLabel } from './visible-label.ts';

const ROW_HEIGHT = 24;
const INDENT = 16;
const OVERSCAN = 8;
const STYLESHEET_ID = 'relic-json-tree-css';
const STYLESHEET_HREF = '/assets/json-tree-view.css';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MARK_PATH = 'M2 3h12v8H7l-3 3v-3H2z';

/** Each view gets its own id prefix, so two trees on one page never collide. */
let sequence = 0;

export function mountView(mount: StructuredMount): StructuredPart | undefined {
  const parsed = parseJsonTree(mount.source);
  if (!parsed.ok) return noticePart(mount, noticeFor(parsed.failure));
  return drawTree(mount, new JsonTreeState(parsed.tree));
}

/**
 * The part for a file that cannot be drawn as a tree: the reason, then the
 * source. Its marks are refused, because no tree holds them.
 */
function noticePart(mount: StructuredMount, text: string): StructuredPart {
  const doc = mount.root.ownerDocument;
  const notice = el(doc, 'p', 'structured-notice', text);
  notice.setAttribute('role', 'status');
  mount.root.replaceChildren(notice, mount.sourceView());
  return {
    paintMark: () => false,
    clearMarks: () => {},
    selectionAnchor: () => undefined,
    reveal: () => {},
    dispose: () => {},
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, label: string): HTMLButtonElement {
  const node = el(doc, 'button', 'jt-button', label);
  node.type = 'button';
  return node;
}

function markIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', MARK_PATH);
  svg.append(path);
  return svg;
}

function ensureStylesheet(
  doc: Document,
  onLoad: () => void,
  signal: AbortSignal
): void {
  if (doc.getElementById(STYLESHEET_ID) !== null) return;
  const link = doc.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = STYLESHEET_HREF;
  link.addEventListener('load', onLoad, { signal });
  doc.head.append(link);
}

const KEY_MOVES: Readonly<
  Record<string, 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'toggle'>
> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  Enter: 'toggle',
  ' ': 'toggle',
};

/**
 * Why Comment is off for the selected value. A shadowed key is not the one
 * that counts. Otherwise the path itself is the problem: the format's
 * `pointer()` returns nothing for a key that holds a NUL or a CR, which the
 * writer refuses, and for a path longer than the anchor limit.
 */
function commentBlockedReason(
  shadowed: boolean,
  path: string | undefined
): string {
  if (shadowed) {
    return 'A later key with this name is the one that counts. Comment on that one.';
  }
  if (path === undefined || !pointerWritable(path)) {
    return 'A comment cannot name this value: its path holds a NUL or carriage return, or is longer than 512 bytes.';
  }
  return 'This value cannot be commented on.';
}

function drawTree(
  mount: StructuredMount,
  state: JsonTreeState
): StructuredPart {
  const doc = mount.root.ownerDocument;
  const win = doc.defaultView ?? window;
  const tree = state.tree;
  const prefix = `jt${++sequence}`;
  const controller = new AbortController();
  const { signal } = controller;

  const summary = el(doc, 'p', 'jt-summary', summaryText(tree));
  const expandAll = button(doc, 'Expand all');
  expandAll.disabled = tree.size > TREE_EXPAND_ALL_LIMIT;
  const collapseAll = button(doc, 'Collapse all');
  const toolbar = el(doc, 'div', 'jt-toolbar');
  toolbar.append(expandAll, collapseAll);

  const crumbs = el(doc, 'nav', 'jt-crumbs');
  crumbs.setAttribute('aria-label', 'Path to the selected value');
  const pointer = el(doc, 'span', 'jt-pointer');
  const copyPath = button(doc, 'Copy path');
  const copyValue = button(doc, 'Copy value');
  const comment = button(doc, 'Comment');
  const suggest = button(doc, 'Suggest edit');
  const actions = el(doc, 'div', 'jt-actions');
  actions.append(pointer, copyPath, copyValue, comment, suggest);
  const bar = el(doc, 'div', 'jt-bar');
  bar.append(crumbs, actions);

  const inspector = el(doc, 'div', 'jt-inspector');
  inspector.hidden = true;
  const status = el(doc, 'p', 'jt-status');
  status.setAttribute('role', 'status');

  const scroller = el(doc, 'div', 'jt-scroll');
  scroller.id = `${prefix}-tree`;
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'tree');
  scroller.setAttribute(
    'aria-label',
    `JSON, ${new Intl.NumberFormat('en-US').format(tree.size)} values`
  );
  const spacer = el(doc, 'div', 'jt-spacer');
  const rows = el(doc, 'div', 'jt-rows');
  spacer.append(rows);
  scroller.append(spacer);

  mount.root.replaceChildren(
    summary,
    toolbar,
    bar,
    inspector,
    scroller,
    status
  );

  const rowId = (node: number): string => `${prefix}-${node}`;

  const rowElement = (row: number): HTMLElement => {
    const node = state.rowAt(row);
    const kind = tree.kind(node);
    const item = el(doc, 'div', `jt-row jt-${kind}`);
    item.id = rowId(node);
    item.dataset['node'] = String(node);
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-level', String(tree.depth(node) + 1));
    const parent = tree.parent(node);
    const siblings = parent === -1 ? 1 : tree.childCount(parent);
    item.setAttribute('aria-setsize', String(siblings));
    item.setAttribute(
      'aria-posinset',
      String(parent === -1 ? 1 : tree.index(node) + 1)
    );
    if (state.hasChildren(node)) {
      item.setAttribute('aria-expanded', String(state.isExpanded(node)));
    }
    const selected = node === state.selected;
    item.setAttribute('aria-selected', String(selected));
    if (selected) item.classList.add('jt-selected');
    item.style.top = `${row * ROW_HEIGHT}px`;
    item.style.paddingLeft = `${tree.depth(node) * INDENT + 4}px`;

    const twist = el(doc, 'span', 'jt-twist');
    twist.setAttribute('aria-hidden', 'true');
    if (state.hasChildren(node)) {
      twist.classList.add(state.isExpanded(node) ? 'jt-open' : 'jt-closed');
    } else {
      twist.classList.add('jt-leaf');
    }
    item.append(twist, el(doc, 'span', 'jt-key', keyLabel(tree, node)));
    if (parent !== -1) item.append(el(doc, 'span', 'jt-sep', ': '));
    item.append(el(doc, 'span', `jt-value jt-${kind}`, valueLabel(tree, node)));

    if (tree.isShadowed(node)) {
      item.append(el(doc, 'span', 'jt-dup', 'DUPLICATE KEY · IGNORED'));
    } else if (tree.isDuplicated(node)) {
      item.append(el(doc, 'span', 'jt-dup', 'DUPLICATE KEY · THIS ONE COUNTS'));
    }
    const marks = state.marksOn(node);
    if (marks.length > 0) {
      const badge = el(doc, 'span', 'jt-mark');
      badge.title = `${marks.length} comment${marks.length === 1 ? '' : 's'}`;
      badge.append(markIcon(doc));
      item.append(badge);
    }
    return item;
  };

  const renderCrumbs = (): void => {
    const path = breadcrumbFor(tree, state.selected);
    const parts: Node[] = [];
    path.forEach((crumb, index) => {
      if (index > 0) parts.push(el(doc, 'span', 'jt-sep', '›'));
      if (index === path.length - 1) {
        const current = el(doc, 'span', 'jt-crumb-current', crumb.label);
        current.setAttribute('aria-current', 'location');
        parts.push(current);
      } else {
        const link = button(doc, crumb.label);
        link.classList.add('jt-crumb');
        link.dataset['node'] = String(crumb.node);
        parts.push(link);
      }
    });
    crumbs.replaceChildren(...parts);

    const path0 = tree.pointer(state.selected);
    pointer.textContent =
      path0 === undefined
        ? 'No path addresses this value'
        : visibleLabel(path0);
    copyPath.disabled = path0 === undefined;
    comment.disabled = state.selectionAnchor() === undefined;
    comment.title = comment.disabled
      ? commentBlockedReason(tree.isShadowed(state.selected), path0)
      : '';

    const selectedKind = tree.kind(state.selected);
    const literal = tree.valueSource(state.selected);
    if (selectedKind === 'string' && literal.length > TREE_VALUE_CUT_CHARS) {
      const shown = literal.slice(0, TREE_INSPECTOR_CUT_CHARS);
      const count = new Intl.NumberFormat('en-US').format(literal.length);
      const suffix =
        literal.length > TREE_INSPECTOR_CUT_CHARS
          ? ` … first ${TREE_INSPECTOR_CUT_CHARS.toLocaleString('en-US')} of ${count} characters. Copy value has all of it.`
          : '';
      inspector.textContent = `${visibleText(shown)}${suffix}`;
      inspector.hidden = false;
    } else {
      inspector.textContent = '';
      inspector.hidden = true;
    }
  };

  const updateActive = (): void => {
    const row = state.rowOf(state.selected);
    if (row === -1) {
      scroller.removeAttribute('aria-activedescendant');
    } else {
      scroller.setAttribute('aria-activedescendant', rowId(state.selected));
    }
  };

  /** The rows a render would draw now. A scroll that keeps them is not a redraw. */
  const windowKey = (): string => {
    const window = rowWindow(
      state.rowCount,
      scroller.scrollTop,
      scroller.clientHeight,
      ROW_HEIGHT,
      OVERSCAN
    );
    return `${window.first}:${window.end}:${state.rowCount}`;
  };
  let drawnWindow = '';

  const render = (): void => {
    spacer.style.height = `${state.rowCount * ROW_HEIGHT}px`;
    const window = rowWindow(
      state.rowCount,
      scroller.scrollTop,
      scroller.clientHeight,
      ROW_HEIGHT,
      OVERSCAN
    );
    const drawn: HTMLElement[] = [];
    for (let row = window.first; row < window.end; row += 1) {
      drawn.push(rowElement(row));
    }
    rows.replaceChildren(...drawn);
    renderCrumbs();
    updateActive();
    drawnWindow = windowKey();
  };

  /** Scrolls the selected row into the window, so the arrow keys never lose it. */
  const keepSelectedInView = (): void => {
    const row = state.rowOf(state.selected);
    if (row === -1) return;
    const top = row * ROW_HEIGHT;
    if (top < scroller.scrollTop) {
      scroller.scrollTop = top;
    } else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    }
  };

  /** Collapsing can hide the selection; it moves to the nearest open ancestor. */
  const selectVisible = (): void => {
    let node = state.selected;
    while (state.rowOf(node) === -1 && tree.parent(node) !== -1) {
      node = tree.parent(node);
    }
    state.select(node);
  };

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const copyText = async (text: string, done: string): Promise<void> => {
    try {
      await win.navigator.clipboard.writeText(text);
      setStatus(done);
    } catch {
      setStatus('Copy failed. Select the text in the tree instead.');
    }
  };

  scroller.addEventListener(
    'scroll',
    () => {
      if (windowKey() !== drawnWindow) render();
    },
    {
      signal,
      passive: true,
    }
  );
  win.addEventListener('resize', () => render(), { signal });

  scroller.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      const item = target.closest<HTMLElement>('.jt-row');
      if (
        item === null ||
        item === undefined ||
        item.dataset['node'] === undefined
      )
        return;
      const node = Number(item.dataset['node']);
      if (target.closest('.jt-twist') !== null) {
        state.toggle(node);
      } else {
        state.select(node);
      }
      scroller.focus({ preventScroll: true });
      render();
    },
    { signal }
  );

  scroller.addEventListener(
    'keydown',
    (event) => {
      const move = KEY_MOVES[event.key];
      if (move === undefined) return;
      event.preventDefault();
      state.move(move);
      keepSelectedInView();
      render();
      keepSelectedInView();
    },
    { signal }
  );

  crumbs.addEventListener(
    'click',
    (event) => {
      const target = (event.target as Element).closest<HTMLElement>(
        '.jt-crumb'
      );
      if (target === null || target.dataset['node'] === undefined) return;
      state.select(Number(target.dataset['node']));
      render();
    },
    { signal }
  );

  expandAll.addEventListener(
    'click',
    () => {
      state.expandAll();
      render();
    },
    { signal }
  );
  collapseAll.addEventListener(
    'click',
    () => {
      state.collapseAll();
      selectVisible();
      render();
    },
    { signal }
  );

  copyPath.addEventListener(
    'click',
    () => {
      const path = tree.pointer(state.selected);
      if (path !== undefined)
        void copyText(visibleText(path), 'Copied the path.');
    },
    { signal }
  );
  copyValue.addEventListener(
    'click',
    () => {
      void copyText(
        visibleText(tree.valueSource(state.selected)),
        'Copied the value.'
      );
    },
    { signal }
  );
  suggest.addEventListener(
    'click',
    () => {
      const start = tree.valueStart(state.selected);
      const end = tree.valueEnd(state.selected);
      const handle = structuredViewFor(mount.root);
      handle?.showSource();
      if (!handle?.showingSource) return;
      const body = mount.root.querySelector<HTMLElement>('pre.code-body');
      if (!body || body.textContent !== tree.source) return;
      const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let first: [Node, number] | undefined;
      let last: [Node, number] | undefined;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!first && start >= offset && start <= offset + length)
          first = [node, start - offset];
        if (end >= offset && end <= offset + length) {
          last = [node, end - offset];
          break;
        }
        offset += length;
      }
      if (!first || !last) return;
      const range = doc.createRange();
      range.setStart(...first);
      range.setEnd(...last);
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      body.scrollIntoView({ block: 'nearest' });
    },
    { signal }
  );
  comment.addEventListener(
    'click',
    () => {
      const anchor = state.selectionAnchor();
      if (anchor === undefined) return;
      // From the control, so the composer opens beside it, not the whole tree.
      comment.dispatchEvent(
        new CustomEvent('relic:structured-comment', {
          bubbles: true,
          detail: { anchor },
        })
      );
    },
    { signal }
  );

  ensureStylesheet(doc, render, signal);
  render();

  return {
    paintMark(anchor: CommentAnchor, commentId: string): boolean {
      const node = nodeForAnchor(tree, anchor);
      if (node === undefined) return false;
      state.mark(node, commentId);
      render();
      return true;
    },
    clearMarks(): void {
      state.clearMarks();
      render();
    },
    selectionAnchor(): CommentAnchor | undefined {
      return state.selectionAnchor();
    },
    reveal(anchor: CommentAnchor): void {
      const node = nodeForAnchor(tree, anchor);
      if (node === undefined) return;
      state.reveal(node);
      state.select(node);
      render();
      keepSelectedInView();
      render();
    },
    dispose(): void {
      controller.abort();
    },
  };
}
