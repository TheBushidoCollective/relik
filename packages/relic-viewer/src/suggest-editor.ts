import type {
  MarkdownDelimiterPair,
  SourceSegment,
} from './markdown-source.ts';
import {
  SuggestDraftModel,
  type DraftChange,
  type PendingSuggestion,
  type SuggestBlockKind,
  type SuggestCommit,
  type SuggestDraft,
} from './suggest-draft.ts';
import type { SuggestionSurface } from './suggestion-surface.ts';

export type SuggestUnavailable =
  | 'older'
  | 'too_large'
  | 'has_cr'
  | 'has_nul'
  | 'not_utf8'
  | 'layout';

export interface SuggestEditorOptions {
  readonly root: HTMLElement;
  readonly source: string;
  readonly segments: readonly SourceSegment[];
  readonly delimiters: readonly MarkdownDelimiterPair[];
  readonly version: number;
  readonly reader: string;
  readonly crlf?: boolean;
  readonly surface?: SuggestionSurface | undefined;
  readonly displayName?: string | null;
  readonly pending?: readonly PendingSuggestion[];
  /** Viewer chrome, outside the editable root. */
  readonly chrome: HTMLElement;
  readonly receiptHost?: HTMLElement;
  readonly unavailable?: SuggestUnavailable | null;
  readonly fileBytes?: number;
  readonly signedIn?: boolean;
  readonly onSignIn?: () => void;
  readonly onCommit: (commit: SuggestCommit) => void;
  readonly onRefusal: (message: string) => void;
  readonly onDraftChange: (draft: SuggestDraft | null) => void;
}

export interface SuggestReceipt {
  readonly struck: string;
  readonly inserted: string;
  readonly undo: () => void;
}

export interface SuggestEditor {
  readonly controls: HTMLElement;
  readonly suggesting: boolean;
  readonly draft: SuggestDraft | null;
  readonly unavailable: string | null;
  setSuggesting(on: boolean): boolean;
  /** Prepare the current draft for sealing without posting it or ending the draft. */
  prepare(): SuggestCommit;
  commit(): boolean;
  cancel(): void;
  /** Call only after the transport confirms the post. Never focuses the receipt. */
  showReceipt(receipt: SuggestReceipt): void;
  /** Replace painter output and pending facts together, outside an open draft. */
  updatePending(
    pending: readonly PendingSuggestion[],
    paint: () => void
  ): boolean;
  destroy(): void;
}

const LAYOUT = 'This document’s layout could not be matched to its source.';
const PAGE_CHANGED =
  'Suggesting stopped because the page changed unexpectedly.';
const INVALID_SELECTION = 'This selection could not be matched to the source.';
const FORMATTING =
  'Formatting isn’t part of a suggestion. Type the words; reply if the styling matters.';
const count = (n: number): string => n.toLocaleString('en-US');

export function suggestingUnavailable(
  reason: SuggestUnavailable,
  fileBytes?: number
): string {
  switch (reason) {
    case 'older':
      return 'Suggestions can only be made on the current version.';
    case 'too_large':
      return fileBytes === undefined
        ? 'Suggesting is off: suggestions work on files up to 1 MiB.'
        : `Suggesting is off: this file is ${(fileBytes / 1_048_576).toFixed(1)} MiB, and suggestions work on files up to 1 MiB.`;
    case 'has_cr':
    case 'has_nul':
      return 'Suggesting is off: this file contains carriage returns (CR) or NUL characters, which a suggestion can’t point at.';
    case 'not_utf8':
      return 'Suggesting is off: this file is not valid UTF-8.';
    case 'layout':
      return LAYOUT;
  }
}

type Point =
  | {
      kind: 'source';
      offset: number;
      block: number;
      blockKind: SuggestBlockKind;
    }
  | {
      kind: 'insertion';
      offset: number;
      block: number;
      id: string | null;
      blockKind: SuggestBlockKind;
    };

function parentElement(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function excluded(node: Node, boundary: Element): boolean {
  for (
    let el = parentElement(node);
    el && el !== boundary;
    el = el.parentElement
  ) {
    if (el.matches('ins[data-sg], [data-sg-decoration]')) return true;
  }
  return false;
}

function sourceText(element: Element): string {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!excluded(node, element)) text += node.nodeValue ?? '';
  }
  return text;
}

function segmentElements(root: HTMLElement): HTMLElement[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-seg]'));
  if (root.hasAttribute('data-seg')) elements.unshift(root);
  return elements;
}

function matchesLayout(
  root: HTMLElement,
  segments: readonly SourceSegment[]
): boolean {
  const elements = segmentElements(root);
  if (elements.length !== segments.length) return false;
  let previous = 0;
  return elements.every((element, i) => {
    const segment = segments[i]!;
    const valid =
      element.getAttribute('data-seg') === String(i) &&
      !element.parentElement?.closest('[data-seg]') &&
      segment.start >= previous &&
      segment.end >= segment.start &&
      sourceText(element) === segment.text;
    previous = segment.end;
    return valid;
  });
}

function blockKind(node: Node, root: HTMLElement): SuggestBlockKind {
  const el = parentElement(node);
  if (root.matches('pre.code-body')) return 'code';
  if (el?.closest('td, th')) return 'table-cell';
  if (el?.closest('li')) return 'list';
  if (el?.closest('blockquote')) return 'quote';
  if (el?.closest('h1, h2, h3, h4, h5, h6')) return 'heading';
  if (el?.closest('pre')) return 'fenced-code';
  return 'paragraph';
}

function localOffset(segment: SourceSegment, offset: number): number {
  if (segment.kind === 'join' || segment.kind === 'escape')
    return offset <= segment.start ? 0 : segment.text.length;
  return Math.max(0, Math.min(segment.text.length, offset - segment.start));
}

function sourceOffset(segment: SourceSegment, offset: number): number {
  if (segment.kind === 'join' || segment.kind === 'escape')
    return offset === 0 ? segment.start : segment.end;
  return segment.start + offset;
}

function offsetWithin(
  element: Element,
  node: Node,
  offset: number,
  ignoreInsertions: boolean
): number | null {
  try {
    const range = element.ownerDocument.createRange();
    range.setStart(element, 0);
    range.setEnd(node, offset);
    const fragment = range.cloneContents();
    if (ignoreInsertions) {
      for (const el of fragment.querySelectorAll(
        'ins[data-sg], [data-sg-decoration]'
      ))
        el.remove();
    }
    return fragment.textContent?.length ?? 0;
  } catch {
    return null;
  }
}

function pointAt(
  root: HTMLElement,
  segments: readonly SourceSegment[],
  node: Node,
  offset: number,
  side: 'start' | 'end',
  surface?: SuggestionSurface
): Point | null {
  if (!root.contains(node)) return null;
  const element = parentElement(node);
  const insertion = element?.closest<HTMLElement>('ins[data-sg]');
  if (insertion && root.contains(insertion)) {
    const inside = offsetWithin(insertion, node, offset, false);
    if (inside === null) return null;
    const holder = insertion.closest<HTMLElement>('[data-seg]');
    const segment =
      segments[holder ? segmentElements(root).indexOf(holder) : -1];
    if (!segment) return null;
    return {
      kind: 'insertion',
      offset: inside,
      block: segment.block,
      id: insertion.hasAttribute('data-sg-draft')
        ? null
        : insertion.getAttribute('data-sg'),
      blockKind:
        surface?.blockKind(segment.block) ?? blockKind(insertion, root),
    };
  }
  const all = segmentElements(root);
  let segmentElement = element?.closest<HTMLElement>('[data-seg]') ?? null;
  let local: number | null = null;
  if (segmentElement && root.contains(segmentElement)) {
    local = offsetWithin(segmentElement, node, offset, true);
  } else {
    let before: HTMLElement | null = null;
    let after: HTMLElement | null = null;
    for (const candidate of all) {
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(candidate);
      let comparison: number;
      try {
        comparison = range.comparePoint(node, offset);
      } catch {
        return null;
      }
      if (comparison < 0) {
        after = candidate;
        break;
      }
      if (comparison > 0) before = candidate;
      else {
        segmentElement = candidate;
        local = offsetWithin(candidate, node, offset, true);
        break;
      }
    }
    if (!segmentElement) {
      segmentElement = side === 'start' ? (after ?? before) : (before ?? after);
      if (segmentElement)
        local =
          segmentElement === after ? 0 : sourceText(segmentElement).length;
    }
  }
  if (!segmentElement || local === null) return null;
  const index = all.indexOf(segmentElement);
  const segment = segments[index];
  if (!segment || local < 0 || local > segment.text.length) return null;
  if (segment.kind === 'escape' && local !== 0 && local !== segment.text.length)
    return null;
  return {
    kind: 'source',
    offset: sourceOffset(segment, local),
    block: segment.block,
    blockKind:
      surface?.blockKind(segment.block) ?? blockKind(segmentElement, root),
  };
}

function selectionPoints(
  root: HTMLElement,
  segments: readonly SourceSegment[],
  surface?: SuggestionSurface
): [Point, Point] | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = pointAt(
    root,
    segments,
    range.startContainer,
    range.startOffset,
    'start',
    surface
  );
  const end = pointAt(
    root,
    segments,
    range.endContainer,
    range.endOffset,
    'end',
    surface
  );
  return start && end ? [start, end] : null;
}

function textNodes(element: Element): Text[] {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const result: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!excluded(node, element)) result.push(node as Text);
  }
  return result;
}

function wrapStrike(element: HTMLElement, from: number, to: number): void {
  let cursor = 0;
  for (const node of textNodes(element)) {
    const value = node.data;
    const start = Math.max(0, from - cursor);
    const end = Math.min(value.length, to - cursor);
    cursor += value.length;
    if (start >= end) continue;
    const fragment = element.ownerDocument.createDocumentFragment();
    if (start)
      fragment.append(
        element.ownerDocument.createTextNode(value.slice(0, start))
      );
    const del = element.ownerDocument.createElement('del');
    del.className = 'sg-del is-draft';
    del.setAttribute('data-sg-draft', '');
    del.append(element.ownerDocument.createTextNode(value.slice(start, end)));
    fragment.append(del);
    if (end < value.length)
      fragment.append(element.ownerDocument.createTextNode(value.slice(end)));
    node.replaceWith(fragment);
  }
}

function insertAt(
  element: HTMLElement,
  offset: number,
  insertion: HTMLElement
): void {
  let remaining = offset;
  const nodes = textNodes(element);
  for (const node of nodes) {
    if (remaining <= node.length) {
      const range = element.ownerDocument.createRange();
      const draftDel = node.parentElement?.closest('del[data-sg-draft]');
      if (remaining === node.length && draftDel && element.contains(draftDel))
        range.setStartAfter(draftDel);
      else range.setStart(node, remaining);
      range.collapse(true);
      range.insertNode(insertion);
      return;
    }
    remaining -= node.length;
  }
  element.append(insertion);
}

function placeCaret(insertion: HTMLElement, offset: number): void {
  const selection = insertion.ownerDocument.getSelection();
  if (!selection) return;
  const text =
    insertion.firstChild ??
    insertion.appendChild(insertion.ownerDocument.createTextNode(''));
  const range = insertion.ownerDocument.createRange();
  range.setStart(
    text,
    Math.max(0, Math.min(text.textContent?.length ?? 0, offset))
  );
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function graphemeNeighbor(
  text: string,
  position: number,
  direction: 'left' | 'right'
): number | null {
  const Segmenter = (
    Intl as unknown as {
      Segmenter: new (
        locale: string,
        options: { granularity: 'grapheme' }
      ) => {
        segment(input: string): {
          containing(
            index: number
          ): { index: number; segment: string } | undefined;
        };
      };
    }
  ).Segmenter;
  const segment = new Segmenter('und', { granularity: 'grapheme' })
    .segment(text)
    .containing(direction === 'left' ? position - 1 : position);
  if (!segment) return null;
  return direction === 'left'
    ? segment.index
    : segment.index + segment.segment.length;
}

export function mountSuggestEditor(
  options: SuggestEditorOptions
): SuggestEditor {
  const { root, source, segments, delimiters, version, reader, chrome } =
    options;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win)
    throw new Error('The suggestion editor requires a document window.');
  const encoder = new TextEncoder();
  let pending = options.pending ?? [];
  let model = new SuggestDraftModel({
    source,
    segments,
    delimiters,
    version,
    reader,
    crlf: options.crlf ?? false,
    pending,
  });
  let on = false;
  let destroyed = false;
  let composing = false;
  let compositionOffset = 0;
  let compositionLength = 0;
  let compositionBaseLength = 0;
  let draftIns: HTMLElement | null = null;
  let hiddenInsertions: { element: HTMLElement; hidden: boolean }[] = [];
  let snapshot: Node | null = null;
  let unavailable = options.unavailable
    ? suggestingUnavailable(options.unavailable, options.fileBytes)
    : null;
  if (!unavailable && encoder.encode(source).length > 1_048_576)
    unavailable = suggestingUnavailable(
      'too_large',
      options.fileBytes ?? encoder.encode(source).length
    );
  if (!unavailable && /[\r\0]/.test(source))
    unavailable = suggestingUnavailable('has_cr');

  // Code views use the pre itself as the single source segment.
  if (
    root.matches('pre.code-body') &&
    segments.length === 1 &&
    !root.hasAttribute('data-seg') &&
    !root.querySelector('[data-seg]')
  )
    root.setAttribute('data-seg', '0');
  if (!unavailable && !matchesLayout(root, segments)) unavailable = LAYOUT;
  root.removeAttribute('contenteditable');

  const controls = doc.createElement('div');
  controls.className = 'sg-strip';
  const group = doc.createElement('div');
  group.className = 'sg-seg';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Reading mode');
  const reading = doc.createElement('button');
  reading.type = 'button';
  reading.textContent = 'Reading';
  const suggesting = doc.createElement('button');
  suggesting.type = 'button';
  suggesting.textContent = 'Suggesting';
  group.append(reading, suggesting);
  const notice = doc.createElement('span');
  notice.className = 'sg-strip-meta';
  notice.setAttribute('role', 'status');
  controls.append(group, notice);
  chrome.append(controls);
  const hint = doc.createElement('div');
  hint.className = 'sg-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  hint.hidden = true;
  chrome.append(hint);
  let refusal: HTMLElement | null = null;
  let receipt: HTMLElement | null = null;

  function displayRefusal(message: string, code?: string): void {
    refusal?.remove();
    refusal = doc.createElement('div');
    refusal.className = 'popover sg-refusal';
    refusal.setAttribute('role', 'alert');
    const text = doc.createElement('p');
    text.textContent = message;
    refusal.append(text);
    if (code) {
      const detail = doc.createElement('code');
      detail.className = 'sg-refusal-code';
      detail.textContent = `refused · ${code}`;
      refusal.append(detail);
    }
    chrome.append(refusal);
    options.onRefusal(message);
  }

  function updateControls(): void {
    reading.setAttribute('aria-pressed', String(!on));
    suggesting.setAttribute('aria-pressed', String(on));
    suggesting.disabled = unavailable !== null;
    suggesting.title = unavailable ?? '';
    notice.textContent = unavailable ?? (on ? 'Type to suggest changes.' : '');
  }

  function updateHint(): void {
    hint.replaceChildren();
    const draft = model.draft;
    hint.hidden = !draft;
    if (!draft) return;
    const add = (text: string, near = false): void => {
      const part = doc.createElement('span');
      if (near) part.className = 'is-near';
      part.textContent = text;
      hint.append(part);
    };
    if (draft.existingId) add('Editing your suggestion');
    add('Esc cancels');
    const leave =
      draft.blockKind === 'code' || draft.blockKind === 'fenced-code'
        ? 'Leave these lines to post'
        : draft.blockKind === 'list'
          ? 'Leave the item to post'
          : draft.blockKind === 'quote'
            ? 'Leave the quote to post'
            : draft.blockKind === 'table-cell'
              ? 'Leave the cell to post'
              : draft.blockKind === 'heading'
                ? 'Leave the heading to post'
                : 'Leave the paragraph to post';
    add(leave);
    add(`Struck ${count(draft.struckBytes)} / 512 B`, draft.struckBytes >= 410);
    add(
      `Inserted ${count(draft.insertedBytes)} / 2,048 B`,
      draft.insertedBytes >= 1639
    );
  }

  function stopUnexpected(): void {
    observer.disconnect();
    on = false;
    composing = false;
    root.removeAttribute('contenteditable');
    model.cancel();
    draftIns = null;
    hint.hidden = true;
    updateControls();
    options.onDraftChange(null);
    displayRefusal(PAGE_CHANGED);
  }

  function reverse(records: readonly MutationRecord[]): boolean {
    try {
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]!;
        if (record.type === 'characterData')
          record.target.nodeValue = record.oldValue;
        else if (record.type === 'attributes') {
          const el = record.target as Element;
          if (record.oldValue === null)
            el.removeAttribute(record.attributeName!);
          else el.setAttribute(record.attributeName!, record.oldValue);
        } else {
          for (const node of Array.from(record.addedNodes)) {
            if (node.parentNode !== record.target) return false;
            record.target.removeChild(node);
          }
          const reference =
            record.nextSibling?.parentNode === record.target
              ? record.nextSibling
              : record.previousSibling?.parentNode === record.target
                ? record.previousSibling.nextSibling
                : null;
          for (const node of Array.from(record.removedNodes))
            record.target.insertBefore(node, reference);
        }
      }
      return snapshot !== null && root.isEqualNode(snapshot);
    } catch {
      return false;
    }
  }

  function observe(): void {
    if (on)
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        attributes: true,
        attributeOldValue: true,
      });
  }

  function handleMutations(records: readonly MutationRecord[]): void {
    if (!on || records.length === 0) return;
    observer.disconnect();
    const insideComposition =
      composing &&
      draftIns &&
      records.every(
        (record) =>
          (record.target === draftIns || draftIns!.contains(record.target)) &&
          record.type !== 'attributes' &&
          (record.type !== 'childList' ||
            [...record.addedNodes, ...record.removedNodes].every(
              (node) => node.nodeType === 3
            ))
      ) &&
      Array.from(draftIns.childNodes).every((node) => node.nodeType === 3);
    if (insideComposition && draftIns && model.draft) {
      const change = model.editInsertion(
        0,
        model.draft.inserted.length,
        draftIns.textContent ?? '',
        model.draft.blockKind
      );
      if (change.kind === 'changed') {
        compositionLength = Math.max(
          0,
          change.draft.inserted.length - compositionBaseLength
        );
        snapshot = root.cloneNode(true);
        updateHint();
        options.onDraftChange(change.draft);
        observe();
        return;
      }
      if (change.kind === 'refused')
        displayRefusal(change.message, change.code);
    }
    if (!reverse(records)) {
      stopUnexpected();
      return;
    }
    observe();
  }

  const observer = new win.MutationObserver((records) =>
    handleMutations(records)
  );

  function mutate(action: () => void): boolean {
    const queued = observer.takeRecords();
    if (queued.length) handleMutations(queued);
    if (!on) return false;
    observer.disconnect();
    try {
      action();
      snapshot = root.cloneNode(true);
      observe();
      return true;
    } catch {
      stopUnexpected();
      return false;
    }
  }

  function clearDrawing(): void {
    for (const el of Array.from(root.querySelectorAll('ins[data-sg-draft]')))
      el.remove();
    for (const el of Array.from(root.querySelectorAll('del[data-sg-draft]')))
      el.replaceWith(...Array.from(el.childNodes));
    for (const entry of hiddenInsertions) entry.element.hidden = entry.hidden;
    hiddenInsertions = [];
    for (const element of segmentElements(root)) element.normalize();
    draftIns = null;
  }

  function renderDraft(caret: number): void {
    const draft = model.draft;
    if (!draft) return;
    if (
      !mutate(() => {
        clearDrawing();
        if (draft.existingId) {
          for (const ins of Array.from(
            root.querySelectorAll<HTMLElement>('ins[data-sg]')
          )) {
            if (ins.getAttribute('data-sg') === draft.existingId) {
              hiddenInsertions.push({ element: ins, hidden: ins.hidden });
              ins.hidden = true;
            }
          }
        }
        const elements = segmentElements(root);
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i]!;
          if (
            segment.block !== draft.block ||
            segment.start >= draft.end ||
            segment.end <= draft.start
          )
            continue;
          wrapStrike(
            elements[i]!,
            localOffset(segment, Math.max(segment.start, draft.start)),
            localOffset(segment, Math.min(segment.end, draft.end))
          );
        }
        let index = segments.findIndex(
          (segment) =>
            segment.block === draft.block &&
            segment.start < draft.end &&
            segment.end >= draft.end
        );
        if (index < 0)
          index = segments.findIndex(
            (segment) =>
              segment.block === draft.block &&
              segment.start <= draft.end &&
              segment.end >= draft.end
          );
        if (index < 0) throw new Error('draft has no source segment');
        const ins = doc.createElement('ins');
        ins.className = 'sg-ins is-draft';
        ins.setAttribute('data-sg', '');
        ins.setAttribute('data-sg-draft', '');
        ins.append(doc.createTextNode(draft.inserted));
        insertAt(
          elements[index]!,
          localOffset(segments[index]!, draft.end),
          ins
        );
        draftIns = ins;
        placeCaret(ins, caret);
      })
    )
      return;
    updateHint();
    options.onDraftChange(draft);
  }

  function changed(result: DraftChange, caret: number): void {
    if (result.kind === 'refused') displayRefusal(result.message, result.code);
    else if (result.kind === 'changed') {
      refusal?.remove();
      refusal = null;
      renderDraft(caret);
    }
  }

  function commitDraft(): boolean {
    if (!model.draft) return true;
    const result = model.commit(options.displayName ?? null);
    if (result.kind === 'refused') {
      displayRefusal(result.message, result.code);
      return false;
    }
    if (!mutate(clearDrawing)) return false;
    model.cancel();
    updateHint();
    options.onDraftChange(null);
    if (result.kind !== 'empty') options.onCommit(result);
    return true;
  }

  function cancelDraft(): void {
    if (!model.draft) return;
    if (!mutate(clearDrawing)) return;
    model.cancel();
    composing = false;
    updateHint();
    options.onDraftChange(null);
  }

  function setSuggesting(want: boolean): boolean {
    if (destroyed) return false;
    if (want && unavailable) {
      displayRefusal(unavailable);
      return false;
    }
    if (want && options.signedIn === false) {
      options.onSignIn?.();
      return false;
    }
    if (want === on) return true;
    if (!want && !commitDraft()) return false;
    if (want && !matchesLayout(root, segments)) {
      unavailable = LAYOUT;
      updateControls();
      displayRefusal(LAYOUT);
      return false;
    }
    observer.disconnect();
    on = want;
    if (on) root.setAttribute('contenteditable', 'true');
    else root.removeAttribute('contenteditable');
    snapshot = root.cloneNode(true);
    observe();
    updateControls();
    return true;
  }

  function applyInput(type: string, text: string): void {
    const points = selectionPoints(root, segments, options.surface);
    if (!points) {
      displayRefusal(INVALID_SELECTION, 'invalid-range');
      return;
    }
    const [start, end] = points;
    for (const point of points) {
      const allowed = options.surface?.editable(point.block);
      if (allowed && allowed !== true) {
        displayRefusal(allowed.message, allowed.code);
        return;
      }
    }
    if (
      start.kind === 'insertion' &&
      end.kind === 'insertion' &&
      start.id === end.id
    ) {
      const draft = model.draft;
      if (
        (type === 'deleteContentBackward' || type === 'deleteContentForward') &&
        start.offset === end.offset
      ) {
        const direction = type === 'deleteContentBackward' ? 'left' : 'right';
        const value = start.id
          ? (pending.find((item) => item.id === start.id)?.inserted ?? '')
          : (draft?.inserted ?? '');
        if (
          (direction === 'left' && start.offset === 0) ||
          (direction === 'right' && start.offset === value.length)
        ) {
          if (start.id && !draft) {
            const init = model.editInsertion(
              start.offset,
              end.offset,
              '',
              start.blockKind,
              start.id
            );
            if (init.kind === 'refused') {
              changed(init, 0);
              return;
            }
          }
          changed(model.extendStrike(direction), start.offset);
          return;
        }
        const adjacent = graphemeNeighbor(value, start.offset, direction);
        if (adjacent === null) return;
        const a = Math.min(adjacent, start.offset),
          b = Math.max(adjacent, start.offset);
        changed(
          model.editInsertion(a, b, '', start.blockKind, start.id ?? undefined),
          a
        );
        return;
      }
      const replacement =
        type === 'insertParagraph' || type === 'insertLineBreak'
          ? start.blockKind === 'paragraph'
            ? '\n\n'
            : '\n'
          : type.startsWith('delete')
            ? ''
            : text;
      changed(
        model.editInsertion(
          start.offset,
          end.offset,
          replacement,
          start.blockKind,
          start.id ?? undefined
        ),
        start.offset + replacement.length
      );
      return;
    }
    if (start.kind !== 'source' || end.kind !== 'source') {
      displayRefusal(INVALID_SELECTION, 'invalid-range');
      return;
    }
    let a = start.offset,
      b = end.offset;
    if (
      (type === 'deleteContentBackward' || type === 'deleteContentForward') &&
      a === b
    ) {
      const direction = type === 'deleteContentBackward' ? 'left' : 'right';
      const segment = segments.find(
        (item) =>
          item.block === start.block &&
          (direction === 'left'
            ? item.start < a && item.end >= a
            : item.start <= a && item.end > a)
      );
      if (!segment) return;
      const adjacent =
        segment.kind === 'join' || segment.kind === 'escape'
          ? direction === 'left'
            ? segment.start
            : segment.end
          : graphemeNeighbor(source, a, direction);
      if (adjacent === null) return;
      a = Math.min(a, adjacent);
      b = Math.max(b, adjacent);
    }
    const prior = model.draft;
    const base =
      prior && a >= prior.end
        ? prior.inserted.length + source.slice(prior.end, a).length
        : 0;
    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      const value = start.blockKind === 'paragraph' ? '\n\n' : '\n';
      changed(model.enter(a, b, start.blockKind), base + value.length);
    } else if (type === 'insertTab')
      changed(model.tab(a, b, start.blockKind), base + 1);
    else {
      const replacement = type.startsWith('delete') ? '' : text;
      changed(
        model.replace(a, b, replacement, start.blockKind),
        base + replacement.length
      );
    }
  }

  function transferText(
    transfer: DataTransfer | null,
    drop: boolean
  ): string | null {
    if (!transfer) return null;
    const types = Array.from(transfer.types, (type) => type.toLowerCase());
    if ((drop && types.includes('text/html')) || !types.includes('text/plain'))
      return null;
    return transfer.getData('text/plain');
  }

  function beforeInput(event: Event): void {
    if (!on) return;
    const input = event as InputEvent;
    const type = input.inputType;
    if (input.cancelable) input.preventDefault();
    if (type === 'insertCompositionText' && composing && !input.cancelable)
      return;
    if (!input.cancelable) {
      displayRefusal(FORMATTING, 'formatting input');
      return;
    }
    if (type === 'insertFromPaste' || type === 'insertFromDrop') {
      const text = transferText(input.dataTransfer, type === 'insertFromDrop');
      if (text === null) {
        displayRefusal(FORMATTING, 'formatting input');
        return;
      }
      applyInput(type, text);
    } else if (type === 'insertText' || type === 'insertReplacementText')
      applyInput(type, input.data ?? '');
    else if (
      type === 'insertParagraph' ||
      type === 'insertLineBreak' ||
      type === 'deleteContentBackward' ||
      type === 'deleteContentForward' ||
      type === 'deleteByCut' ||
      type === 'deleteContent'
    )
      applyInput(type, '');
    else if (type === 'insertCompositionText' && composing && model.draft) {
      const text = input.data ?? '';
      const change = model.editInsertion(
        compositionOffset,
        compositionOffset + compositionLength,
        text,
        model.draft.blockKind
      );
      if (change.kind === 'changed') compositionLength = text.length;
      changed(change, compositionOffset + compositionLength);
    } else displayRefusal(FORMATTING, 'formatting input');
  }

  function clipboard(event: Event): void {
    if (!on) return;
    const isDrop = event.type === 'drop';
    const transfer = isDrop
      ? (event as DragEvent).dataTransfer
      : (event as ClipboardEvent).clipboardData;
    event.preventDefault();
    const text = transferText(transfer, isDrop);
    if (text === null) displayRefusal(FORMATTING, 'formatting input');
    else applyInput(isDrop ? 'insertFromDrop' : 'insertFromPaste', text);
  }

  function keydown(event: KeyboardEvent): void {
    if (!on) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelDraft();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Tab' && !event.shiftKey) {
      const points = selectionPoints(root, segments, options.surface);
      if (
        points &&
        (points[0].blockKind === 'code' ||
          points[0].blockKind === 'fenced-code')
      ) {
        event.preventDefault();
        applyInput('insertTab', '\t');
      }
    }
  }

  function selectionChange(): void {
    if (!on || !model.draft || composing) return;
    const selection = doc.getSelection();
    if (!selection?.focusNode || !root.contains(selection.focusNode)) return;
    const point = pointAt(
      root,
      segments,
      selection.focusNode,
      selection.focusOffset,
      'start',
      options.surface
    );
    if (point?.kind === 'source' && point.block !== model.draft.block)
      commitDraft();
    else if (
      point?.kind === 'insertion' &&
      point.id !== null &&
      point.id !== model.draft.existingId
    )
      commitDraft();
  }

  function focusOut(event: FocusEvent): void {
    if (
      on &&
      (!event.relatedTarget || !root.contains(event.relatedTarget as Node))
    )
      commitDraft();
  }

  function compositionStart(): void {
    if (!on) return;
    const points = selectionPoints(root, segments, options.surface);
    if (!points) return;
    const [start, end] = points;
    for (const point of points) {
      const allowed = options.surface?.editable(point.block);
      if (allowed && allowed !== true) {
        displayRefusal(allowed.message, allowed.code);
        return;
      }
    }
    if (start.kind === 'source' && end.kind === 'source') {
      const result = model.replace(
        start.offset,
        end.offset,
        '',
        start.blockKind
      );
      if (result.kind === 'refused') {
        displayRefusal(result.message, result.code);
        return;
      }
      if (result.kind === 'changed') renderDraft(0);
    } else if (
      start.kind === 'insertion' &&
      end.kind === 'insertion' &&
      start.id === end.id
    ) {
      const result = model.editInsertion(
        start.offset,
        end.offset,
        '',
        start.blockKind,
        start.id ?? undefined
      );
      if (result.kind === 'refused') {
        displayRefusal(result.message, result.code);
        return;
      }
      if (result.kind === 'changed') renderDraft(start.offset);
    } else {
      displayRefusal(INVALID_SELECTION, 'invalid-range');
      return;
    }
    compositionOffset = start.kind === 'insertion' ? start.offset : 0;
    compositionLength = 0;
    compositionBaseLength = model.draft?.inserted.length ?? 0;
    composing = draftIns !== null;
  }

  function compositionEnd(): void {
    const queued = observer.takeRecords();
    if (queued.length) handleMutations(queued);
    composing = false;
  }

  reading.addEventListener('click', () => setSuggesting(false));
  suggesting.addEventListener('click', () => setSuggesting(true));
  root.addEventListener('beforeinput', beforeInput);
  root.addEventListener('paste', clipboard);
  root.addEventListener('drop', clipboard);
  root.addEventListener('keydown', keydown);
  root.addEventListener('focusout', focusOut);
  root.addEventListener('compositionstart', compositionStart);
  root.addEventListener('compositionend', compositionEnd);
  doc.addEventListener('selectionchange', selectionChange);
  updateControls();
  if (unavailable === LAYOUT) options.onRefusal(LAYOUT);

  return {
    controls,
    get suggesting() {
      return on;
    },
    get draft() {
      return model.draft;
    },
    get unavailable() {
      return unavailable;
    },
    setSuggesting,
    prepare: () => model.commit(options.displayName ?? null),
    commit: commitDraft,
    cancel: cancelDraft,
    showReceipt(value) {
      receipt?.remove();
      receipt = doc.createElement('section');
      receipt.className = 'sg-dock sg-receipt';
      receipt.setAttribute('role', 'status');
      receipt.setAttribute('aria-live', 'polite');
      receipt.setAttribute('aria-label', 'Suggestion receipt');
      const head = doc.createElement('div');
      head.className = 'rc-head';
      const title = doc.createElement('strong');
      title.textContent = 'Suggestion posted';
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'rc-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('mousedown', (event) => event.preventDefault());
      close.addEventListener('click', () => {
        receipt?.remove();
        receipt = null;
      });
      head.append(title, close);
      receipt.append(head);
      const body = doc.createElement('div');
      body.className = 'rc-body';
      for (const [label, valueText, tag, cls] of [
        ['Struck', value.struck, 'del', 'sg-del'],
        ['Inserted', value.inserted, 'ins', 'sg-ins'],
      ] as const) {
        if (!valueText) continue;
        const row = doc.createElement('div');
        row.className = 'card-row';
        const key = doc.createElement('span');
        key.className = 'k';
        key.textContent = label;
        const text = doc.createElement(tag);
        text.className = cls;
        text.textContent = valueText;
        row.append(key, text);
        body.append(row);
      }
      receipt.append(body);
      const tools = doc.createElement('div');
      tools.className = 'popover-tools';
      const undo = doc.createElement('button');
      undo.type = 'button';
      undo.className = 'popover-action';
      undo.textContent = 'Undo';
      undo.addEventListener('mousedown', (event) => event.preventDefault());
      undo.addEventListener('click', () => value.undo());
      tools.append(undo);
      receipt.append(tools);
      (options.receiptHost ?? chrome).append(receipt);
    },
    updatePending(next, paint) {
      if (model.draft || destroyed) return false;
      const update = (): void => {
        paint();
        pending = next;
        model = new SuggestDraftModel({
          source,
          segments,
          delimiters,
          version,
          reader,
          crlf: options.crlf ?? false,
          pending,
        });
      };
      if (on) {
        if (!mutate(update)) return false;
      } else update();
      if (!matchesLayout(root, segments)) {
        unavailable = LAYOUT;
        if (on) {
          observer.disconnect();
          on = false;
          root.removeAttribute('contenteditable');
        }
        updateControls();
        displayRefusal(LAYOUT);
        return false;
      }
      return true;
    },
    destroy() {
      if (destroyed) return;
      if (on && !commitDraft()) return;
      destroyed = true;
      observer.disconnect();
      root.removeAttribute('contenteditable');
      root.removeEventListener('beforeinput', beforeInput);
      root.removeEventListener('paste', clipboard);
      root.removeEventListener('drop', clipboard);
      root.removeEventListener('keydown', keydown);
      root.removeEventListener('focusout', focusOut);
      root.removeEventListener('compositionstart', compositionStart);
      root.removeEventListener('compositionend', compositionEnd);
      doc.removeEventListener('selectionchange', selectionChange);
      controls.remove();
      hint.remove();
      refusal?.remove();
      receipt?.remove();
    },
  };
}
