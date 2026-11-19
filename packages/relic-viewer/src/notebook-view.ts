/**
 * The notebook view for `.ipynb` (plan A4, section 7; mock states N1 to N6).
 *
 * The model is `@relic/format/notebook`: it reads the file, decides what each
 * output is, and refuses a file it cannot show. This module only draws. Every
 * text is written with `textContent`, except markdown cells and markdown
 * outputs, which go through the viewer's escape-first renderer (`buildProse`,
 * the path plan section 2 names for markdown on the viewing origin). Image
 * outputs are blob URLs of bytes whose signature matched, typed by that
 * signature, never SVG.
 *
 * A comment anchors to a cell (`/cells/N`) or an output (`/cells/N/outputs/M`).
 * A quote inside a cell marks the cell or output that holds it.
 *
 * Refusal goes through `reportUnshown`, so the bridge draws the reason above
 * the source. The view then returns `undefined`, and the file is not marked as
 * a drawn view.
 */

import type { CommentAnchor } from '@relic/format';
import {
  type AnsiSpan,
  type Notebook,
  type NotebookBody,
  type NotebookCell,
  type NotebookOutput,
  type NotebookRefusal,
  type NotebookTarget,
  notebookPointer,
  notebookTarget,
  parseNotebook,
} from '@relic/format/notebook';
import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';
import { buildProse } from './text-views.ts';

const STYLESHEET_ID = 'relic-notebook-view-css';
const STYLESHEET_HREF = '/assets/notebook-view.css';

/** Each view gets its own id prefix, so two notebooks on one page never collide. */
let sequence = 0;

/** Text for a file the notebook view cannot show, given the reason it refused. */
export function notebookNotice(refusal: NotebookRefusal): string {
  switch (refusal.kind) {
    case 'json':
      switch (refusal.failure.kind) {
        case 'too-large':
        case 'too-many-nodes':
          return TOO_LARGE_NOTICE;
        case 'too-deep':
          return 'This notebook is nested too deeply to show as a notebook, so its text is shown.';
        case 'syntax':
          return `This notebook could not be read as JSON, so its text is shown. Line ${refusal.failure.line}, column ${refusal.failure.column}: ${refusal.failure.reason}.`;
      }
      return TOO_LARGE_NOTICE;
    case 'not-notebook':
      return "This file is named like a notebook, but it isn't one, so its text is shown.";
    case 'nbformat':
      return `This notebook uses nbformat ${refusal.found}, which this viewer does not show, so its text is shown.`;
    case 'too-many-cells':
    case 'too-many-outputs':
      return TOO_LARGE_NOTICE;
  }
}

const TOO_LARGE_NOTICE =
  'This notebook is too large to show as a notebook, so its text is shown.';

/** Pattern-matched to the image MIME type a signature names. */
const IMAGE_TYPE = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

const WITHHELD_TEXT = {
  html: 'This output is HTML (or a widget) and is not run here.',
  svg: 'This output is an SVG drawing, and SVG is not drawn here.',
  javascript: 'This output is JavaScript and is not run here.',
  latex: 'This output is LaTeX and is not typeset here.',
  widget: 'This output is HTML (or a widget) and is not run here.',
} as const;

export function mountView(mount: StructuredMount): StructuredPart | undefined {
  const parsed = parseNotebook(mount.source);
  if (!parsed.ok) {
    mount.reportUnshown(notebookNotice(parsed.refusal));
    return undefined;
  }
  return drawNotebook(mount, parsed.notebook);
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

function ensureStylesheet(doc: Document): void {
  if (doc.getElementById(STYLESHEET_ID) !== null) return;
  const link = doc.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = STYLESHEET_HREF;
  doc.head.append(link);
}

function sizeLine(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function keyOf(target: NotebookTarget): string {
  return target.output === undefined
    ? `c:${target.cell}`
    : `o:${target.cell}:${target.output}`;
}

function targetOfKey(key: string): NotebookTarget | undefined {
  const parts = key.split(':');
  if (parts[0] === 'c' && parts.length === 2) return { cell: Number(parts[1]) };
  if (parts[0] === 'o' && parts.length === 3)
    return { cell: Number(parts[1]), output: Number(parts[2]) };
  return undefined;
}

function drawNotebook(
  mount: StructuredMount,
  notebook: Notebook
): StructuredPart {
  const root = mount.root;
  const doc = root.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  const prefix = `nb${++sequence}`;
  ensureStylesheet(doc);

  /** Every element a mark can sit on, by its key. Rebuilt blocks replace their entry. */
  const elements = new Map<string, HTMLElement>();
  const marks = new Map<string, Set<string>>();
  const revealed = new Set<string>();
  const blobs: string[] = [];
  let selected: NotebookTarget | undefined;
  let active: HTMLElement | undefined;

  const count = new Intl.NumberFormat('en-US');
  const summary = el(
    doc,
    'p',
    'nb-summary',
    `${count.format(notebook.cells.length)} cells · nbformat ${notebook.nbformat} · ${sizeLine(notebook.bytes)}`
  );
  const list = el(doc, 'ol', 'nb');
  list.setAttribute('aria-label', 'Notebook cells');
  list.id = `${prefix}-cells`;
  root.replaceChildren(summary, list);

  const commentButton = (
    label: string,
    target: NotebookTarget
  ): HTMLButtonElement => {
    const button = el(doc, 'button', 'nb-comment', label);
    button.type = 'button';
    button.dataset['pointer'] = notebookPointer(target);
    return button;
  };

  const note = (text: string): HTMLElement => el(doc, 'p', 'nb-note', text);

  const spanNodes = (spans: readonly AnsiSpan[]): Node[] =>
    spans.map((span) => {
      const classes = [
        span.fg === undefined ? '' : `ansi-fg-${span.fg}`,
        span.bg === undefined ? '' : `ansi-bg-${span.bg}`,
        span.bold ? 'ansi-bold' : '',
        span.italic ? 'ansi-italic' : '',
        span.underline ? 'ansi-underline' : '',
      ].filter((name) => name !== '');
      if (classes.length === 0) return doc.createTextNode(span.text);
      const node = el(doc, 'span', classes.join(' '), span.text);
      return node;
    });

  const bodyNodes = (body: NotebookBody, key: string): Node[] => {
    switch (body.kind) {
      case 'empty':
        return [el(doc, 'span', 'nb-empty', 'No text to show.')];
      case 'stream':
        return [
          ...spanNodes(body.spans),
          ...(body.truncated ? [note('Output truncated.')] : []),
        ];
      case 'text':
      case 'json':
        return [
          el(doc, 'span', 'nb-text', body.text.text),
          ...truncatedNote(body.text.truncated),
        ];
      case 'markdown':
        return [
          buildProse(body.text.text),
          ...truncatedNote(body.text.truncated),
        ];
      case 'image': {
        const url = URL.createObjectURL(
          new Blob([body.bytes as BlobPart], { type: IMAGE_TYPE[body.format] })
        );
        blobs.push(url);
        const img = el(doc, 'img');
        img.src = url;
        img.alt = `Image output, ${body.format.toUpperCase()}`;
        img.decoding = 'async';
        return [img];
      }
      case 'image-refused':
        return [
          note(
            body.reason === 'size' || body.reason === 'count'
              ? 'This image output is too large to show here.'
              : 'This image output could not be shown.'
          ),
        ];
      case 'error':
        return [
          ...(body.spans.length > 0
            ? spanNodes(body.spans)
            : [el(doc, 'span', 'nb-err-name', `${body.name}: ${body.value}`)]),
          ...(body.truncated ? [note('Output truncated.')] : []),
        ];
      case 'withheld': {
        if (!revealed.has(key)) {
          const message = el(doc, 'div', 'nb-withheld');
          message.append(
            el(doc, 'p', undefined, WITHHELD_TEXT[body.withheld]),
            showTextButton(key)
          );
          return [message];
        }
        const shown = body.plain ?? body.source;
        return [
          el(doc, 'span', 'nb-text', shown.text),
          ...truncatedNote(shown.truncated),
        ];
      }
    }
  };

  const truncatedNote = (truncated: boolean): Node[] =>
    truncated ? [note('Text cut at 1 MiB. View source to see the rest.')] : [];

  const showTextButton = (key: string): HTMLButtonElement => {
    const button = el(doc, 'button', 'nb-show-text', 'Show as text');
    button.type = 'button';
    button.dataset['key'] = key;
    return button;
  };

  const outputLabel = (output: NotebookOutput): string => {
    const body = output.body;
    switch (body.kind) {
      case 'stream':
        return body.stream;
      case 'error':
        return 'error · ANSI colour removed';
      case 'image':
        return IMAGE_TYPE[body.format];
      case 'image-refused':
        return body.declared;
      case 'markdown':
        return 'text/markdown';
      case 'text':
        return 'text/plain';
      case 'json':
        return 'application/json';
      case 'withheld':
        return body.label;
      case 'empty':
        return '';
    }
  };

  const outputBlock = (
    cell: NotebookCell,
    output: NotebookOutput
  ): HTMLElement => {
    const key = `o:${cell.index}:${output.index}`;
    const body = output.body;
    const withheldShut = body.kind === 'withheld' && !revealed.has(key);
    const classes = [
      'nb-out',
      `is-${body.kind}`,
      body.kind === 'stream' && body.stream === 'stderr' ? 'is-stderr' : '',
      withheldShut ? 'is-placeholder' : '',
    ].filter((name) => name !== '');
    const block = el(doc, 'div', classes.join(' '));
    block.dataset['key'] = key;
    block.tabIndex = -1;
    const kind = el(doc, 'span', 'nb-out-kind', outputLabel(output));
    const target = { cell: cell.index, output: output.index };
    const tools = el(doc, 'div', 'nb-tools');
    tools.append(
      commentButton(
        `Comment on output ${output.index + 1} of cell ${cell.index + 1}`,
        target
      )
    );
    block.append(kind, ...bodyNodes(body, key), tools);
    return block;
  };

  const outputWrap = (
    cell: NotebookCell,
    output: NotebookOutput
  ): HTMLElement => {
    const wrap = el(doc, 'div', 'nb-out-wrap');
    const showsCount =
      output.outputType !== 'stream' &&
      output.outputType !== 'error' &&
      cell.executionCount !== undefined;
    const gutter = el(
      doc,
      'div',
      'nb-gutter is-out',
      showsCount ? `Out[${cell.executionCount}]:` : ''
    );
    const block = outputBlock(cell, output);
    elements.set(block.dataset['key'] ?? '', block);
    wrap.append(gutter, block);
    return wrap;
  };

  const cellItem = (cell: NotebookCell): HTMLLIElement => {
    const item = el(doc, 'li', `nb-cell is-${cell.kind}`);
    item.dataset['cell'] = String(cell.index);
    const input = el(doc, 'div', 'nb-input');
    const gutterText =
      cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]:` : '';
    const gutter = el(doc, 'div', 'nb-gutter', gutterText);
    const box = el(doc, 'div', 'nb-box');
    const key = `c:${cell.index}`;
    box.dataset['key'] = key;
    box.tabIndex = cell.index === 0 ? 0 : -1;
    if (cell.kind === 'markdown') {
      box.append(buildProse(cell.source.text));
      if (cell.source.truncated) box.append(...truncatedNote(true));
    } else {
      const pre = el(doc, 'pre', 'nb-src', cell.source.text);
      box.append(pre, ...truncatedNote(cell.source.truncated));
    }
    const tools = el(doc, 'div', 'nb-tools');
    tools.append(
      commentButton(`Comment on cell ${cell.index + 1}`, { cell: cell.index })
    );
    box.append(tools);
    elements.set(key, box);
    input.append(gutter, box);
    item.append(input);
    for (const output of cell.outputs) item.append(outputWrap(cell, output));
    if (cell.omittedOutputs > 0) {
      item.append(
        note(
          cell.omittedOutputs === 1
            ? '1 more output is not shown. View source to see it.'
            : `${count.format(cell.omittedOutputs)} more outputs are not shown. View source to see them.`
        )
      );
    }
    return item;
  };

  for (const cell of notebook.cells) list.append(cellItem(cell));

  /** Puts the badge for one element's marks on it, dropping its stale badge. */
  const refreshMark = (key: string, element: HTMLElement): void => {
    for (const child of Array.from(element.children)) {
      if (
        child.classList.contains('nb-mark') ||
        child.classList.contains('nb-mark-n')
      )
        child.remove();
    }
    const total = marks.get(key)?.size ?? 0;
    element.classList.toggle('is-commented', total > 0);
    if (total === 0) return;
    const badge =
      total === 1
        ? el(doc, 'span', 'nb-mark', undefined)
        : el(doc, 'span', 'nb-mark-n', String(total));
    badge.title = total === 1 ? 'Commented' : `${total} comments`;
    element.append(badge);
  };

  /** Puts the badge for every painted mark on its element, and drops the stale ones. */
  const refreshMarks = (): void => {
    for (const [key, element] of elements) refreshMark(key, element);
  };

  const elementFor = (target: NotebookTarget): HTMLElement | undefined =>
    elements.get(keyOf(target));

  const select = (target: NotebookTarget): void => {
    const previous = selected === undefined ? undefined : elementFor(selected);
    previous?.classList.remove('is-selected');
    selected = target;
    elementFor(target)?.classList.add('is-selected');
  };

  const toggleText = (key: string): void => {
    const target = targetOfKey(key);
    const block = elements.get(key);
    if (
      target === undefined ||
      block === undefined ||
      target.output === undefined
    )
      return;
    revealed.add(key);
    const cell = notebook.cells[target.cell];
    const output = cell?.outputs[target.output];
    if (cell === undefined || output === undefined) return;
    const wrap = block.parentElement;
    const next = outputWrap(cell, output);
    if (wrap !== null) wrap.replaceWith(next);
    refreshMarks();
  };

  list.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element;
      const comment = target.closest<HTMLButtonElement>('.nb-comment');
      if (comment !== null) {
        const anchor: CommentAnchor = {
          kind: 'path',
          pointer: comment.dataset['pointer'] ?? '',
        };
        root.dispatchEvent(
          new CustomEvent('relic:structured-comment', {
            bubbles: true,
            detail: { anchor },
          })
        );
        return;
      }
      const show = target.closest<HTMLButtonElement>('.nb-show-text');
      if (show !== null) {
        toggleText(show.dataset['key'] ?? '');
        return;
      }
      const block = target.closest<HTMLElement>('.nb-out');
      const box = target.closest<HTMLElement>('.nb-box');
      const key = block?.dataset['key'] ?? box?.dataset['key'];
      const chosen = key === undefined ? undefined : targetOfKey(key);
      if (chosen !== undefined) select(chosen);
    },
    { signal }
  );

  list.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const cell = (event.target as Element).closest<HTMLLIElement>(
        'li.nb-cell'
      );
      if (cell === null) return;
      const cells = Array.from(
        list.querySelectorAll<HTMLLIElement>(':scope > li.nb-cell')
      );
      const at = cells.indexOf(cell);
      const next = cells[event.key === 'ArrowDown' ? at + 1 : at - 1];
      const box = next?.querySelector<HTMLElement>('.nb-box');
      if (next === undefined || box === null || box === undefined) return;
      event.preventDefault();
      for (const other of cells) {
        other
          .querySelector<HTMLElement>('.nb-box')
          ?.setAttribute('tabindex', '-1');
      }
      box.tabIndex = 0;
      box.focus({ preventScroll: false });
      const chosen = targetOfKey(box.dataset['key'] ?? '');
      if (chosen !== undefined) select(chosen);
    },
    { signal }
  );

  refreshMarks();

  return {
    paintMark(anchor: CommentAnchor, commentId: string): boolean {
      const target = notebookTarget(notebook, anchor);
      if (target === undefined) return false;
      const key = keyOf(target);
      const element = elements.get(key);
      if (element === undefined) return false;
      const ids = marks.get(key) ?? new Set<string>();
      ids.add(commentId);
      marks.set(key, ids);
      refreshMark(key, element);
      return true;
    },
    clearMarks(): void {
      marks.clear();
      refreshMarks();
    },
    selectionAnchor(): CommentAnchor | undefined {
      const selection = doc.getSelection();
      if (
        selection !== null &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        root.contains(selection.getRangeAt(0).commonAncestorContainer)
      )
        return undefined;
      if (selected === undefined) return undefined;
      return { kind: 'path', pointer: notebookPointer(selected) };
    },
    reveal(anchor: CommentAnchor): void {
      const target = notebookTarget(notebook, anchor);
      if (target === undefined) return;
      select(target);
      const element = elementFor(target);
      if (element === undefined) return;
      active?.classList.remove('is-active');
      element.classList.add('is-active');
      active = element;
      element.scrollIntoView({ block: 'center' });
    },
    dispose(): void {
      controller.abort();
      for (const url of blobs) URL.revokeObjectURL(url);
      blobs.length = 0;
      elements.clear();
    },
  };
}
