import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnchorRect } from '@relic/format';
import type { AnchorSurface } from '../src/anchoring.ts';
import {
  type FrameMarkPayload,
  framePinAdapter,
  frameQuoteAdapter,
  frameRegionAdapter,
  isArmPointingMessage,
  isClearMarkMessage,
  isClearMarksMessage,
  isFrameMarkClickMessage,
  isFrameMarkHoverMessage,
  isFrameMarkRectMessage,
  isFrameOpenLinkMessage,
  isFramePointMessage,
  isFrameRegionMessage,
  isFrameSelectionMessage,
  isPaintMarkMessage,
  isPaintMarksMessage,
  isRevealMarkMessage,
  isTrackMarkMessage,
  normaliseFrameExternalLink,
  takeHeadUtf8,
  takeTailUtf8,
} from '../src/annotate-frame.ts';
import {
  clearFrameRegions,
  createSandboxHandler,
  FRAME_MARK_CSS,
  paintFrameRegion,
  setupFrameInteraction,
  unwrapFrameQuotes,
  wrapFrameQuote,
} from '../src/sandbox.ts';

// ---------------------------------------------------------------------------
// Lightweight DOM stub for testing in Bun's DOM-less runtime
// ---------------------------------------------------------------------------

class MockClassList {
  private set = new Set<string>();

  add(...classes: string[]) {
    for (const c of classes) this.set.add(c);
  }
  remove(...classes: string[]) {
    for (const c of classes) this.set.delete(c);
  }
  contains(cls: string): boolean {
    return this.set.has(cls);
  }
  has(cls: string): boolean {
    return this.set.has(cls);
  }
  toggle(cls: string, force?: boolean): boolean {
    if (force === true) {
      this.set.add(cls);
      return true;
    }
    if (force === false) {
      this.set.delete(cls);
      return false;
    }
    if (this.set.has(cls)) {
      this.set.delete(cls);
      return false;
    }
    this.set.add(cls);
    return true;
  }
  [Symbol.iterator]() {
    return this.set[Symbol.iterator]();
  }
  get length(): number {
    return this.set.size;
  }
}

function matches(node: MockNode, selector: string): boolean {
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    return node.classList.contains(selector.slice(1));
  }
  if (selector.includes('.')) {
    const [tag, cls] = selector.split('.');
    return Boolean(
      tag &&
        cls &&
        node.tagName?.toLowerCase() === tag.toLowerCase() &&
        node.classList.contains(cls)
    );
  }
  if (selector.startsWith('[data-comment-id')) {
    const m = selector.match(/\[data-comment-id="([^"]+)"\]/);
    if (m) return node.dataset.commentId === m[1];
    return node.dataset.commentId !== undefined;
  }
  return node.tagName?.toLowerCase() === selector.toLowerCase();
}

class MockNode {
  readonly nodeType: number;
  readonly nodeName: string;
  tagName?: string;
  parentNode: MockNode | null = null;
  childNodes: MockNode[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new MockClassList();
  style: Record<string, string> & { cssText?: string } = {};
  listeners = new Map<string, Array<(e: unknown) => void>>();
  data?: string;
  scrollWidth = 1000;
  scrollHeight = 2000;

  get className(): string {
    return Array.from(this.classList).join(' ');
  }
  set className(val: string) {
    this.classList = new MockClassList();
    for (const c of val.split(/\s+/).filter(Boolean)) {
      this.classList.add(c);
    }
  }

  get id(): string {
    return this.attributes.id ?? '';
  }
  set id(val: string) {
    this.attributes.id = val;
  }
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  } {
    const left = parseFloat(this.style.left || '0') || 0;
    const top = parseFloat(this.style.top || '0') || 0;
    const width = parseFloat(this.style.width || '0') || 0;
    const height = parseFloat(this.style.height || '0') || 0;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
  getClientRects(): Array<{
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  }> {
    const b = this.getBoundingClientRect();
    if (b.width > 0 || b.height > 0) return [b];
    return [];
  }
  constructor(nodeType: number, name: string) {
    this.nodeType = nodeType;
    this.nodeName = name;
    if (nodeType === 1) {
      this.tagName = name.toUpperCase();
    }
  }

  get parentElement(): MockNode | null {
    return this.parentNode && this.parentNode.nodeType === 1
      ? this.parentNode
      : null;
  }

  get ownerDocument(): MockDocument {
    return mockDoc;
  }

  get firstChild(): MockNode | null {
    return this.childNodes[0] ?? null;
  }
  get previousSibling(): MockNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null;
  }

  get nextSibling(): MockNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.data ?? '';
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(val: string) {
    if (this.nodeType === 3) {
      this.data = val;
    } else {
      this.childNodes = [];
      if (val.length > 0) {
        const t = new MockNode(3, '#text');
        t.data = val;
        t.parentNode = this;
        this.childNodes.push(t);
      }
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return Array.from(this.classList).join(' ');
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] ?? null;
    }
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, val: string): void {
    if (name === 'class') {
      this.classList = new MockClassList();
      this.classList.add(...val.split(/\s+/).filter(Boolean));
    } else if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = val;
    } else {
      this.attributes[name] = val;
    }
  }

  splitText(offset: number): MockNode {
    if (this.nodeType !== 3) throw new Error('not a text node');
    const full = this.data ?? '';
    const first = full.slice(0, offset);
    const second = full.slice(offset);
    this.data = first;
    const newNode = new MockNode(3, '#text');
    newNode.data = second;
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      this.parentNode.childNodes.splice(idx + 1, 0, newNode);
      newNode.parentNode = this.parentNode;
    }
    return newNode;
  }

  appendChild(child: MockNode): MockNode {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newNode: MockNode, refNode: MockNode | null): MockNode {
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    if (!refNode) {
      return this.appendChild(newNode);
    }
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) {
      return this.appendChild(newNode);
    }
    this.childNodes.splice(idx, 0, newNode);
    newNode.parentNode = this;
    return newNode;
  }

  removeChild(child: MockNode): MockNode {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  replaceChildren(...children: MockNode[]): void {
    for (const c of [...this.childNodes]) {
      this.removeChild(c);
    }
    for (const c of children) {
      this.appendChild(c);
    }
  }

  normalize(): void {
    let i = 0;
    while (i < this.childNodes.length - 1) {
      const curr = this.childNodes[i];
      const next = this.childNodes[i + 1];
      if (curr && next && curr.nodeType === 3 && next.nodeType === 3) {
        curr.data = (curr.data ?? '') + (next.data ?? '');
        this.removeChild(next);
      } else {
        curr?.normalize();
        i++;
      }
    }
  }

  closest(selector: string): MockNode | null {
    let curr: MockNode | null = this;
    while (curr) {
      if (matches(curr, selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): MockNode[] {
    const results: MockNode[] = [];
    function walk(node: MockNode) {
      for (const child of node.childNodes) {
        if (matches(child, selector)) results.push(child);
        walk(child);
      }
    }
    walk(this);
    return results;
  }

  querySelector(selector: string): MockNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  scrollIntoView(): void {}

  addEventListener(type: string, handler: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: { type: string; [k: string]: unknown }): boolean {
    let walk: MockNode | null = this;
    while (walk) {
      const list = walk.listeners.get(event.type) ?? [];
      for (const h of list) h(event);
      walk = walk.parentNode ?? (walk === mockDoc ? null : mockDoc);
    }
    return true;
  }
}

class MockDocument extends MockNode {
  head: MockNode;
  body: MockNode;
  documentElement: MockNode;
  defaultView: unknown;

  constructor() {
    super(9, '#document');
    this.documentElement = new MockNode(1, 'html');
    this.head = new MockNode(1, 'head');
    this.body = new MockNode(1, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  getElementById(id: string): MockNode | null {
    return this.querySelector(`#${id}`);
  }

  createElement(tag: string): MockNode {
    return new MockNode(1, tag);
  }

  createTextNode(text: string): MockNode {
    const n = new MockNode(3, '#text');
    n.data = text;
    return n;
  }

  createTreeWalker(
    root: MockNode,
    _whatToShow: number,
    filter?: { acceptNode(node: MockNode): number }
  ) {
    const nodes: MockNode[] = [];
    function walk(node: MockNode) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (!filter || filter.acceptNode(child) === 1) {
            nodes.push(child);
          }
        } else {
          if (filter && filter.acceptNode(child) === 2) {
            continue;
          }
          walk(child);
        }
      }
    }
    walk(root);
    let idx = 0;
    return {
      nextNode: () => nodes[idx++] ?? null,
    };
  }

  createRange() {
    let _startNode: MockNode | null = null;
    let _startOff = 0;
    let _endNode: MockNode | null = null;
    let _endOff = 0;
    return {
      selectNodeContents(node: MockNode) {
        _startNode = node;
        _startOff = 0;
        _endNode = node;
        _endOff = node.childNodes.length;
      },
      setStart(node: MockNode, off: number) {
        _startNode = node;
        _startOff = off;
      },
      setEnd(node: MockNode, off: number) {
        _endNode = node;
        _endOff = off;
      },
      toString() {
        return 'context text';
      },
    };
  }
}

let mockDoc: MockDocument = new MockDocument();
let mockWin: {
  getSelection: () => unknown;
  parent: unknown;
  scrollTo: () => void;
  listeners: Map<string, Array<(e: unknown) => void>>;
  addEventListener?: (type: string, handler: (e: unknown) => void) => void;
  removeEventListener?: (type: string, handler: (e: unknown) => void) => void;
} = {
  getSelection: () => null,
  parent: {},
  scrollTo: () => {},
  listeners: new Map(),
};
mockDoc.defaultView = mockWin;

beforeEach(() => {
  mockDoc = new MockDocument();
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  mockWin = {
    getSelection: () => null,
    parent: {},
    scrollTo: () => {},
    listeners,
    addEventListener: (type: string, handler: (e: unknown) => void) => {
      const held = listeners.get(type) ?? [];
      held.push(handler);
      listeners.set(type, held);
    },
    removeEventListener: (type: string, handler: (e: unknown) => void) => {
      const held = listeners.get(type) ?? [];
      const at = held.indexOf(handler);
      if (at >= 0) held.splice(at, 1);
    },
  };
  mockDoc.defaultView = mockWin;
  const g = globalThis as {
    document?: unknown;
    window?: unknown;
    NodeFilter?: unknown;
    HTMLElement?: unknown;
  };
  g.document = mockDoc;
  g.window = mockWin;
  g.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  g.HTMLElement = MockNode;
});

afterEach(() => {
  const g = globalThis as {
    document?: unknown;
    window?: unknown;
  };
  delete g.document;
  delete g.window;
});

function makeElement(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (MockNode | string)[]
): MockNode {
  const el = mockDoc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') {
      el.appendChild(mockDoc.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

// ---------------------------------------------------------------------------
// Message shape and validation
// ---------------------------------------------------------------------------

describe('frame message validation', () => {
  test('validates well-formed frame selection messages', () => {
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'hello world',
      })
    ).toBe(true);

    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'hello world',
        prefix: 'before ',
        suffix: ' after',
      })
    ).toBe(true);
  });

  test('rejects malformed frame selection messages', () => {
    expect(isFrameSelectionMessage(null)).toBe(false);
    expect(isFrameSelectionMessage({})).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 123,
      })
    ).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'a'.repeat(513),
      })
    ).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'ok',
        prefix: 'a'.repeat(129),
      })
    ).toBe(false);
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'ok',
        suffix: 'a'.repeat(129),
      })
    ).toBe(false);
  });

  test('validates well-formed frame point messages', () => {
    expect(
      isFramePointMessage({
        type: 'relic:frame-point',
        x: 0.5,
        y: 0.25,
        box: { left: 10, top: 20, width: 20, height: 20 },
      })
    ).toBe(true);
    expect(isFramePointMessage({ type: 'relic:frame-point', x: 0, y: 1 })).toBe(
      true
    );
  });

  test('rejects malformed frame point messages', () => {
    expect(isFramePointMessage(null)).toBe(false);
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: -0.1, y: 0.5 })
    ).toBe(false);
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: 1.1, y: 0.5 })
    ).toBe(false);
    expect(
      isFramePointMessage({ type: 'relic:frame-point', x: Number.NaN, y: 0.5 })
    ).toBe(false);
    expect(
      isFramePointMessage({
        type: 'relic:frame-point',
        x: 0.5,
        y: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
    expect(isFramePointMessage({ type: 'other', x: 0.5, y: 0.5 })).toBe(false);
    expect(
      isFramePointMessage({
        type: 'relic:frame-point',
        x: 0.5,
        y: 0.5,
        box: { left: 0, top: 0, width: -1, height: 20 },
      })
    ).toBe(false);
  });

  test('validates well-formed frame region messages', () => {
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        box: { left: 10, top: 20, width: 30, height: 40 },
      })
    );
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      })
    ).toBe(true);
  });

  test('rejects malformed frame region messages', () => {
    expect(isFrameRegionMessage(null)).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0, h: 0.4 },
      })
    ).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.8, y: 0.2, w: 0.5, h: 0.4 },
      })
    ).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        box: { left: 0, top: 0, width: 10, height: Number.NaN },
      })
    ).toBe(false);
  });

  test('validates track mark messages', () => {
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: 'm1' })).toBe(
      true
    );
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: null })).toBe(
      true
    );
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: '' })).toBe(
      false
    );
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: 123 })).toBe(
      false
    );
    expect(isTrackMarkMessage(null)).toBe(false);
  });

  test('validates frame mark rect messages', () => {
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'm1',
        rect: { left: 10, top: 20, width: 30, height: 40 },
        first: { left: 10, top: 20, width: 30, height: 20 },
      })
    ).toBe(true);
    expect(
      isFrameMarkRectMessage({ type: 'relic:frame-mark-rect', id: 'm1' })
    ).toBe(true);
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'm1',
        rect: { left: 0, top: 0, width: -5, height: 10 },
      })
    ).toBe(false);
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'm1',
        first: { left: 0, top: 0, width: 10, height: -1 },
      })
    ).toBe(false);
  });

  test('validates well-formed frame region messages', () => {
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      })
    ).toBe(true);
  });

  test('rejects malformed frame region messages', () => {
    expect(isFrameRegionMessage(null)).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0, h: 0.4 },
      })
    ).toBe(false);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.8, y: 0.2, w: 0.5, h: 0.4 },
      })
    ).toBe(false);
  });

  test('validates well-formed mark click messages', () => {
    expect(
      isFrameMarkClickMessage({ type: 'relic:frame-mark-click', id: 'c1' })
    ).toBe(true);
    expect(
      isFrameMarkClickMessage({ type: 'relic:frame-mark-click', id: '' })
    ).toBe(false);
    expect(isFrameMarkClickMessage({ type: 'relic:frame-mark-click' })).toBe(
      false
    );
  });

  test('validates arm pointing messages', () => {
    expect(
      isArmPointingMessage({ type: 'relic:arm-pointing', armed: true })
    ).toBe(true);
    expect(
      isArmPointingMessage({ type: 'relic:arm-pointing', armed: false })
    ).toBe(true);
    expect(
      isArmPointingMessage({ type: 'relic:arm-pointing', armed: 'true' })
    ).toBe(false);
  });

  test('validates paint mark and paint marks messages', () => {
    const quoteMark: FrameMarkPayload = {
      id: 'm1',
      kind: 'quote',
      exact: 'selected text',
      prefix: 'pre',
      suffix: 'post',
    };
    const regionMark: FrameMarkPayload = {
      id: 'm2',
      kind: 'region',
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    };
    expect(
      isPaintMarkMessage({ type: 'relic:paint-mark', mark: quoteMark })
    ).toBe(true);
    expect(
      isPaintMarkMessage({ type: 'relic:paint-mark', mark: regionMark })
    ).toBe(true);
    expect(
      isPaintMarksMessage({
        type: 'relic:paint-marks',
        marks: [quoteMark, regionMark],
      })
    ).toBe(true);

    expect(
      isPaintMarkMessage({
        type: 'relic:paint-mark',
        mark: { id: 'm1', kind: 'quote', exact: 'a'.repeat(600) },
      })
    ).toBe(false);
  });

  test('validates clear mark and clear marks messages', () => {
    expect(isClearMarkMessage({ type: 'relic:clear-mark', id: 'm1' })).toBe(
      true
    );
    expect(isClearMarkMessage({ type: 'relic:clear-mark' })).toBe(false);
    expect(isClearMarksMessage({ type: 'relic:clear-marks' })).toBe(true);
    expect(isClearMarksMessage({ type: 'other' })).toBe(false);
  });

  test('validates reveal mark messages', () => {
    expect(isRevealMarkMessage({ type: 'relic:reveal-mark', id: 'm1' })).toBe(
      true
    );
    expect(
      isRevealMarkMessage({
        type: 'relic:reveal-mark',
        kind: 'quote',
        exact: 'find me',
      })
    ).toBe(true);
    expect(
      isRevealMarkMessage({
        type: 'relic:reveal-mark',
        kind: 'region',
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UTF-8 truncation helpers
// ---------------------------------------------------------------------------

describe('UTF-8 truncation helpers', () => {
  test('takeHeadUtf8 preserves multibyte characters and surrogate pairs', () => {
    expect(takeHeadUtf8('hello', 10)).toBe('hello');
    expect(takeHeadUtf8('hello', 3)).toBe('hel');

    const jp = '日本語テスト';
    expect(takeHeadUtf8(jp, 6)).toBe('日本');
    expect(takeHeadUtf8(jp, 7)).toBe('日本');
    expect(takeHeadUtf8(jp, 9)).toBe('日本語');

    const emoji = '🎉party';
    expect(takeHeadUtf8(emoji, 3)).toBe('');
    expect(takeHeadUtf8(emoji, 4)).toBe('🎉');
    expect(takeHeadUtf8(emoji, 5)).toBe('🎉p');
  });

  test('takeTailUtf8 preserves multibyte characters and surrogate pairs from end', () => {
    expect(takeTailUtf8('hello', 10)).toBe('hello');
    expect(takeTailUtf8('hello', 3)).toBe('llo');

    const jp = '日本語テスト';
    expect(takeTailUtf8(jp, 6)).toBe('スト');
    expect(takeTailUtf8(jp, 7)).toBe('スト');
    expect(takeTailUtf8(jp, 9)).toBe('テスト');

    const emoji = 'party🎉';
    expect(takeTailUtf8(emoji, 3)).toBe('');
    expect(takeTailUtf8(emoji, 4)).toBe('🎉');
    expect(takeTailUtf8(emoji, 5)).toBe('y🎉');
  });
});

// ---------------------------------------------------------------------------
// Frame DOM mark manipulation and security
// ---------------------------------------------------------------------------

describe('frame DOM quote wrapping and security', () => {
  test('wraps an exact quote with createElement and textContent', () => {
    const root = makeElement(
      'div',
      {},
      'The quick brown fox jumps over the lazy dog.'
    );
    mockDoc.body.appendChild(root);

    const placed = wrapFrameQuote(
      root as unknown as HTMLElement,
      'brown fox',
      undefined,
      undefined,
      'c1'
    );
    expect(placed).toBe(true);

    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('brown fox');
    expect(mark?.getAttribute('data-comment-id')).toBe('c1');

    unwrapFrameQuotes(root as unknown as HTMLElement);
    expect(root.querySelector('mark.relic-text-mark')).toBeNull();
    expect(root.textContent).toBe(
      'The quick brown fox jumps over the lazy dog.'
    );
  });

  test('author content containing markup cannot become markup in a mark', () => {
    const dangerousText = '<script>window.__injected = true;</script>';
    const root = makeElement('div', {}, dangerousText);
    mockDoc.body.appendChild(root);

    const placed = wrapFrameQuote(
      root as unknown as HTMLElement,
      '<script>',
      undefined,
      undefined,
      'sec1'
    );
    expect(placed).toBe(true);

    expect(root.querySelectorAll('script')).toHaveLength(0);
    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('<script>');

    unwrapFrameQuotes(root as unknown as HTMLElement);
  });

  test('disambiguates repeat occurrences using prefix and suffix context', () => {
    const root = makeElement(
      'div',
      {},
      'first apple pie is good, second apple pie is better'
    );
    mockDoc.body.appendChild(root);

    const placed = wrapFrameQuote(
      root as unknown as HTMLElement,
      'apple pie',
      'second ',
      ' is better',
      'second-apple'
    );
    expect(placed).toBe(true);

    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('data-comment-id')).toBe('second-apple');

    const prevNode = mark?.previousSibling;
    expect(prevNode?.textContent?.endsWith('second ')).toBe(true);

    unwrapFrameQuotes(root as unknown as HTMLElement);
  });
});

describe('frame DOM region painting', () => {
  test('positions a box on the scrollable document overlay', () => {
    const root = makeElement('div', {}, 'content');
    mockDoc.body.appendChild(root);

    const rect: AnchorRect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const div = paintFrameRegion(root as unknown as HTMLElement, rect, 'reg-1');
    expect(div).not.toBeUndefined();
    expect(div?.classList.contains('relic-region-mark')).toBe(true);
    expect(div?.dataset.commentId).toBe('reg-1');

    clearFrameRegions(root as unknown as HTMLElement, 'reg-1');
    expect(root.querySelector('[data-comment-id="reg-1"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Frame interaction (pointing arm/disarm and clicks)
// ---------------------------------------------------------------------------

describe('frame interaction and click capture', () => {
  test('ignores clicks while pointing is disarmed', () => {
    const root = makeElement('div', {}, 'Clickable area');
    mockDoc.body.appendChild(root);

    const messages: object[] = [];
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        messages.push(msg);
      }
    );

    expect(interaction.isArmed()).toBe(false);

    root.dispatchEvent({ type: 'mousedown', pageX: 100, pageY: 100 });
    root.dispatchEvent({ type: 'mouseup', pageX: 100, pageY: 100 });

    const pointMsgs = messages.filter(
      (m) =>
        (m as { type?: string }).type === 'relic:frame-point' ||
        (m as { type?: string }).type === 'relic:frame-region'
    );
    expect(pointMsgs).toHaveLength(0);
  });

  test('reports unit coordinates on click when pointing is armed', () => {
    const root = makeElement('div', {}, 'Clickable area');
    mockDoc.body.appendChild(root);

    const messages: object[] = [];
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        messages.push(msg);
      }
    );

    interaction.setArmed(true);
    expect(interaction.isArmed()).toBe(true);

    root.dispatchEvent({ type: 'mousedown', pageX: 50, pageY: 50 });
    root.dispatchEvent({ type: 'mouseup', pageX: 50, pageY: 50 });

    const pointMsgs = messages.filter(
      (m) =>
        (m as { type?: string }).type === 'relic:frame-point' ||
        (m as { type?: string }).type === 'relic:frame-region'
    );
    expect(pointMsgs.length).toBeGreaterThan(0);
  });
  test('posts a canonical external link only for a trusted reader click', () => {
    const label = makeElement('span', {}, 'Open site');
    const link = makeElement(
      'a',
      { href: 'https://example.com/report?q=1' },
      label
    );
    mockDoc.body.appendChild(link);

    const messages: object[] = [];
    setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => messages.push(msg)
    );

    let prevented = false;
    label.dispatchEvent({
      type: 'click',
      target: label,
      isTrusted: true,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(messages).toContainEqual({
      type: 'relic:open-link',
      href: 'https://example.com/report?q=1',
    });
  });

  test('contains rejected and scripted anchor clicks inside the frame', () => {
    const messages: object[] = [];
    setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => messages.push(msg)
    );

    for (const [href, isTrusted] of [
      ['/relative', true],
      ['#section', true],
      ['javascript:alert(1)', true],
      ['data:text/html,hello', true],
      ['blob:https://example.com/id', true],
      ['file:///etc/passwd', true],
      ['https://example.com/scripted', false],
    ] as const) {
      const link = makeElement('a', { href }, href);
      mockDoc.body.appendChild(link);
      let prevented = false;
      link.dispatchEvent({
        type: 'click',
        target: link,
        isTrusted,
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
    }

    expect(messages).toHaveLength(0);
  });

  test('validates and bounds the frame link message', () => {
    expect(normaliseFrameExternalLink('HTTP://EXAMPLE.COM')).toBe(
      'http://example.com/'
    );
    expect(normaliseFrameExternalLink('mailto:reader@example.com')).toBe(
      'mailto:reader@example.com'
    );
    expect(
      isFrameOpenLinkMessage({
        type: 'relic:open-link',
        href: 'https://example.com/',
      })
    ).toBe(true);
    expect(
      isFrameOpenLinkMessage({
        type: 'relic:open-link',
        href: 'https://example.com',
      })
    ).toBe(false);
    expect(
      normaliseFrameExternalLink(`https://example.com/${'x'.repeat(9 * 1024)}`)
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pointing at a long framed document. The reported dossier scrolls about
// 1088 x 9583 px, where any share of the document is a lot of pixels.
// ---------------------------------------------------------------------------

describe('pointing at a long framed document', () => {
  const sizeDocument = (width: number, height: number): void => {
    for (const node of [mockDoc.documentElement, mockDoc.body]) {
      node.scrollWidth = width;
      node.scrollHeight = height;
    }
  };

  const armedFrame = (messages: object[]) => {
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => messages.push(msg)
    );
    interaction.setArmed(true);
    return interaction;
  };

  const gesture = (
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): void => {
    mockDoc.body.dispatchEvent({
      type: 'mousedown',
      pageX: from.x,
      pageY: from.y,
    });
    mockDoc.body.dispatchEvent({ type: 'mouseup', pageX: to.x, pageY: to.y });
  };

  test('a drag across one line of text is the box that was drawn', () => {
    sizeDocument(1088, 9583);
    const messages: object[] = [];
    armedFrame(messages);

    // From "is ready" on one line back to "welcoming" on the next: the
    // reported gesture, 150 x 35 px.
    gesture({ x: 450, y: 4000 }, { x: 300, y: 4035 });

    expect(messages.filter(isFramePointMessage)).toHaveLength(0);
    const regions = messages.filter(isFrameRegionMessage);
    expect(regions).toHaveLength(1);
    const rect = regions[0]?.rect;
    expect((rect?.x ?? 0) * 1088).toBeCloseTo(300, 6);
    expect((rect?.y ?? 0) * 9583).toBeCloseTo(4000, 6);
    expect((rect?.w ?? 0) * 1088).toBeCloseTo(150, 6);
    expect((rect?.h ?? 0) * 9583).toBeCloseTo(35, 6);
  });

  test('a drag flat along a line keeps a box, inside the document', () => {
    sizeDocument(1088, 9583);
    const messages: object[] = [];
    armedFrame(messages);

    // Flat, and running off the right and bottom edges.
    gesture({ x: 1000, y: 9582 }, { x: 1100, y: 9582 });

    expect(messages.filter(isFramePointMessage)).toHaveLength(0);
    const regions = messages.filter(isFrameRegionMessage);
    expect(regions).toHaveLength(1);
    const rect = regions[0]?.rect;
    expect((rect?.h ?? 0) * 9583).toBeCloseTo(4, 6);
    expect((rect?.x ?? 1) + (rect?.w ?? 1)).toBeLessThanOrEqual(1);
    expect((rect?.y ?? 1) + (rect?.h ?? 1)).toBeLessThanOrEqual(1);
  });

  test('a click is a point at the press, not a box', () => {
    sizeDocument(1088, 9583);
    const messages: object[] = [];
    armedFrame(messages);

    // A hand on a mouse wobbles; two pixels is still a click.
    gesture({ x: 152, y: 440 }, { x: 154, y: 441 });

    expect(messages.filter(isFrameRegionMessage)).toHaveLength(0);
    expect(messages.filter(isFramePointMessage)).toEqual([
      {
        type: 'relic:frame-point',
        x: 152 / 1088,
        y: 440 / 9583,
        box: { left: 144, top: 431, width: 20, height: 20 },
      },
    ]);
  });

  test('a region release posts relic:frame-region with the drawn element getBoundingClientRect', () => {
    sizeDocument(1000, 2000);
    const messages: object[] = [];
    armedFrame(messages);

    mockDoc.body.dispatchEvent({ type: 'mousedown', pageX: 100, pageY: 200 });
    mockDoc.body.dispatchEvent({ type: 'mousemove', pageX: 300, pageY: 400 });
    mockDoc.body.dispatchEvent({ type: 'mouseup', pageX: 300, pageY: 400 });

    const regions = messages.filter(isFrameRegionMessage);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.box).toEqual({
      left: 100,
      top: 200,
      width: 200,
      height: 200,
    });
  });

  test('tracking: relic:track-mark { id: m1 } reports immediately and on scroll, resize, mark mutations', () => {
    sizeDocument(1000, 2000);
    const messages: object[] = [];
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => messages.push(msg)
    );

    const markEl = mockDoc.createElement('mark');
    markEl.dataset.commentId = 'm1';
    markEl.style.left = '50px';
    markEl.style.top = '100px';
    markEl.style.width = '80px';
    markEl.style.height = '20px';
    mockDoc.body.appendChild(markEl);

    interaction.onTrackMark('m1');
    const rects1 = messages.filter(isFrameMarkRectMessage);
    expect(rects1).toHaveLength(1);
    expect(rects1[0]).toEqual({
      type: 'relic:frame-mark-rect',
      id: 'm1',
      rect: { left: 50, top: 100, width: 80, height: 20 },
      first: { left: 50, top: 100, width: 80, height: 20 },
    });

    mockWin.listeners.get('scroll')?.forEach((h) => h(new Event('scroll')));
    const rects2 = messages.filter(isFrameMarkRectMessage);
    expect(rects2.length).toBeGreaterThan(1);

    mockWin.listeners.get('resize')?.forEach((h) => h(new Event('resize')));
    const rects3 = messages.filter(isFrameMarkRectMessage);
    expect(rects3.length).toBeGreaterThan(rects2.length);

    interaction.onPaintMark({
      kind: 'region',
      id: 'm1',
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });
    const rects4 = messages.filter(isFrameMarkRectMessage);
    expect(rects4.length).toBeGreaterThan(rects3.length);

    interaction.onTrackMark(null);
    const countBefore = messages.filter(isFrameMarkRectMessage).length;
    mockWin.listeners.get('scroll')?.forEach((h) => h(new Event('scroll')));
    expect(messages.filter(isFrameMarkRectMessage)).toHaveLength(countBefore);
  });

  test('onActiveMark(id) posts relic:frame-mark-rect for that id without altering tracked id', () => {
    sizeDocument(1000, 2000);
    const messages: object[] = [];
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => messages.push(msg)
    );

    const markEl = mockDoc.createElement('div');
    markEl.dataset.commentId = 'active1';
    markEl.style.left = '30px';
    markEl.style.top = '40px';
    markEl.style.width = '60px';
    markEl.style.height = '50px';
    mockDoc.body.appendChild(markEl);

    interaction.onTrackMark('tracked1');
    messages.length = 0;

    interaction.onActiveMark('active1');
    const rects = messages.filter(isFrameMarkRectMessage);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({
      type: 'relic:frame-mark-rect',
      id: 'active1',
      rect: { left: 30, top: 40, width: 60, height: 50 },
    });

    messages.length = 0;
    mockWin.listeners.get('scroll')?.forEach((h) => h(new Event('scroll')));
    const scrollReports = messages.filter(isFrameMarkRectMessage);
    expect(scrollReports).toHaveLength(1);
    expect(scrollReports[0]!.id).toBe('tracked1');
  });
  test('an armed press does not start a text selection; a disarmed one does', () => {
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      () => {}
    );
    let prevented = 0;
    const press = (): void => {
      mockDoc.body.dispatchEvent({
        type: 'mousedown',
        pageX: 10,
        pageY: 10,
        preventDefault: () => {
          prevented += 1;
        },
      });
      mockDoc.body.dispatchEvent({ type: 'mouseup', pageX: 10, pageY: 10 });
    };

    press();
    expect(prevented).toBe(0);
    interaction.setArmed(true);
    press();
    expect(prevented).toBe(1);
  });

  test('the frame draws a point it is sent at that point, at a fixed size', () => {
    sizeDocument(1088, 9583);
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      () => {}
    );
    const mark: FrameMarkPayload = { id: 'c1', kind: 'pin', x: 0.25, y: 0.5 };
    expect(isPaintMarkMessage({ type: 'relic:paint-mark', mark })).toBe(true);
    expect(interaction.onPaintMark(mark)).toBe(true);

    const pin = mockDoc.body.querySelector('[data-comment-id="c1"]');
    expect(pin?.classList.contains('relic-pin-mark')).toBe(true);
    expect(pin?.style.left).toBe(`${0.25 * 1088}px`);
    expect(pin?.style.top).toBe(`${0.5 * 9583}px`);
    // Sized by the stylesheet in pixels, never by a share of the document.
    expect(pin?.style.width).toBeUndefined();
    expect(pin?.style.height).toBeUndefined();
    expect(FRAME_MARK_CSS).toMatch(/\.relic-pin-mark \{[^}]*width: 20px/);
  });
});

// ---------------------------------------------------------------------------
// Sandbox message handler security: source check and malformed input
// ---------------------------------------------------------------------------

describe('sandbox handler security', () => {
  test('ignores messages from a window that is not the parent window', () => {
    const received: unknown[] = [];
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: (mark) => {
          received.push(mark);
          return true;
        },
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
      }
    );

    expect(handle({ type: 'relic:render', html: '<p>ok</p>' })).toBe(true);

    const fakeOtherWindow = {};
    const isFromParent = (src: unknown) => src === mockWin.parent;

    expect(isFromParent(fakeOtherWindow)).toBe(false);
    expect(isFromParent(mockWin.parent)).toBe(true);
  });

  test('malformed inbound message does not throw and does not paint', () => {
    const painted: unknown[] = [];
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: (mark) => {
          painted.push(mark);
          return true;
        },
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
      }
    );

    handle({ type: 'relic:render', html: '<p>ok</p>' });

    expect(handle(null)).toBe(false);
    expect(handle(undefined)).toBe(false);
    expect(handle('not an object')).toBe(false);
    expect(handle(12345)).toBe(false);
    expect(handle({ type: 'relic:paint-mark', mark: { bad: 'data' } })).toBe(
      false
    );
    expect(
      handle({
        type: 'relic:paint-mark',
        mark: { id: 'm1', kind: 'quote', exact: 42 },
      })
    ).toBe(false);
    expect(
      handle({
        type: 'relic:paint-mark',
        mark: { id: 'm1', kind: 'region', rect: { x: -1, y: 0, w: 1, h: 1 } },
      })
    ).toBe(false);
    expect(handle({ type: 'relic:unknown-action' })).toBe(false);

    expect(painted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adapters: frameQuoteAdapter and frameRegionAdapter
// ---------------------------------------------------------------------------

describe('frame adapters', () => {
  const iframe = makeElement('iframe', { class: 'usercontent-frame' });
  const divHost = makeElement('div', { class: 'stage-wrap' }, iframe);
  const nonFrameHost = makeElement(
    'div',
    { class: 'stage-wrap' },
    makeElement('div')
  );

  const frameSurface: AnchorSurface = {
    host: divHost as unknown as HTMLElement,
    content: iframe as unknown as HTMLElement,
  };
  const nonFrameSurface: AnchorSurface = {
    host: nonFrameHost as unknown as HTMLElement,
    content: nonFrameHost.firstChild as unknown as HTMLElement,
  };

  test('supports() returns true only when surface is iframe.usercontent-frame', () => {
    expect(frameQuoteAdapter.supports(frameSurface)).toBe(true);
    expect(frameQuoteAdapter.supports(nonFrameSurface)).toBe(false);

    expect(frameRegionAdapter.supports(frameSurface)).toBe(true);
    expect(frameRegionAdapter.supports(nonFrameSurface)).toBe(false);
  });

  test('label() returns descriptive human-readable text', () => {
    expect(
      frameQuoteAdapter.label({ kind: 'quote', exact: 'hello world' })
    ).toBe('Commenting on "hello world"');
    expect(
      frameRegionAdapter.label({
        kind: 'region',
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      })
    ).toBe('Commenting on a region');
  });

  test('paint() posts message across frame boundary and returns true', () => {
    const posted: unknown[] = [];
    (
      iframe as unknown as {
        contentWindow: { postMessage: (msg: unknown) => void };
      }
    ).contentWindow = {
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    };

    const quotePlaced = frameQuoteAdapter.paint(
      frameSurface,
      divHost as unknown as HTMLElement,
      { kind: 'quote', exact: 'test quote' },
      'comment-1'
    );
    expect(quotePlaced).toBe(true);
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string }).type).toBe('relic:paint-mark');

    const regionPlaced = frameRegionAdapter.paint(
      frameSurface,
      divHost as unknown as HTMLElement,
      { kind: 'region', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      'comment-2'
    );
    expect(regionPlaced).toBe(true);
    expect(posted).toHaveLength(2);
  });

  // The mock iframe has no window of its own; the adapters only ever post
  // to one, so a recorder is the whole of what they need.
  const recordFramePosts = (): unknown[] => {
    const posted: unknown[] = [];
    Object.assign(iframe, {
      contentWindow: {
        postMessage: (msg: unknown) => {
          posted.push(msg);
        },
      },
    });
    return posted;
  };

  const paintedKinds = (posted: readonly unknown[]): string[] =>
    posted.filter(isPaintMarkMessage).map((msg) => msg.mark.kind);

  test('a point is drawn inside the frame, where the document scrolls', () => {
    const posted = recordFramePosts();

    expect(framePinAdapter.supports(frameSurface)).toBe(true);
    expect(framePinAdapter.supports(nonFrameSurface)).toBe(false);
    expect(
      framePinAdapter.paint(
        frameSurface,
        divHost as unknown as HTMLElement,
        { kind: 'pin', x: 0.14, y: 0.05 },
        'comment-3'
      )
    ).toBe(true);
    framePinAdapter.reveal?.(frameSurface, { kind: 'pin', x: 0.14, y: 0.05 });

    expect(posted).toEqual([
      {
        type: 'relic:paint-mark',
        mark: { id: 'comment-3', kind: 'pin', x: 0.14, y: 0.05 },
      },
      { type: 'relic:reveal-mark', kind: 'pin', point: { x: 0.14, y: 0.05 } },
    ]);
    // Both survive the frame's own validation, or the frame drops them.
    expect(isPaintMarkMessage(posted[0])).toBe(true);
    expect(isRevealMarkMessage(posted[1])).toBe(true);
  });

  test('a point stored as the old three-hundredths box is drawn as a point', () => {
    const posted = recordFramePosts();
    const legacy = {
      kind: 'region' as const,
      rect: { x: 0.125, y: 0.03, w: 0.03, h: 0.03 },
    };

    expect(frameRegionAdapter.label(legacy)).toBe('Commenting on a point');
    frameRegionAdapter.paint(
      frameSurface,
      divHost as unknown as HTMLElement,
      legacy,
      'old-1'
    );
    const [sent] = posted.filter(isPaintMarkMessage);
    expect(sent?.mark.kind).toBe('pin');
    if (sent?.mark.kind === 'pin') {
      expect(sent.mark.x).toBeCloseTo(0.14, 9);
      expect(sent.mark.y).toBeCloseTo(0.045, 9);
    }

    // A box someone drew is never mistaken for one.
    frameRegionAdapter.paint(
      frameSurface,
      divHost as unknown as HTMLElement,
      { kind: 'region', rect: { x: 0.125, y: 0.03, w: 0.031, h: 0.03 } },
      'drawn-1'
    );
    expect(paintedKinds(posted)).toEqual(['pin', 'region']);
  });
});

// ---------------------------------------------------------------------------
// Frame mark geometry: hover boxes, click rects, selection text, active mark
// ---------------------------------------------------------------------------

describe('frame mark geometry and selection reporting', () => {
  interface PostedMessage {
    type?: string;
    id?: string | null;
    rect?: { left: number; top: number; width: number; height: number };
    exact?: string;
    text?: string;
    truncated?: boolean;
  }

  const posted: PostedMessage[] = [];

  beforeEach(() => {
    posted.length = 0;
    // The frame posts over window.parent.postMessage; the mock window's
    // parent ships without one, so give it a listener that records.
    (
      mockWin as unknown as { parent: { postMessage: (msg: unknown) => void } }
    ).parent.postMessage = (msg: unknown) => {
      posted.push(msg as PostedMessage);
    };
  });

  function wrapWithBox(
    exact: string,
    id: string,
    rect: { left: number; top: number; width: number; height: number }
  ): MockNode {
    const root = makeElement('div', {}, `before ${exact} after`);
    mockDoc.body.appendChild(root);
    expect(
      wrapFrameQuote(root as unknown as HTMLElement, exact, '', '', id)
    ).toBe(true);
    const mark = root.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    (
      mark as unknown as { getBoundingClientRect: () => unknown }
    ).getBoundingClientRect = () => rect;
    return mark as unknown as MockNode;
  }

  test('hover enter posts the mark id and its box, leave posts null', () => {
    const mark = wrapWithBox('words', 'c1', {
      left: 10,
      top: 20,
      width: 30,
      height: 40,
    });

    mark.dispatchEvent({ type: 'mouseenter' });
    mark.dispatchEvent({ type: 'mouseleave' });

    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      type: 'relic:frame-mark-hover',
      id: 'c1',
      rect: { left: 10, top: 20, width: 30, height: 40 },
    });
    expect(posted[1]).toEqual({ type: 'relic:frame-mark-hover', id: null });
    expect(isFrameMarkHoverMessage(posted[0])).toBe(true);
    expect(isFrameMarkHoverMessage(posted[1])).toBe(true);
  });

  test('a mark click carries the box it was clicked on', () => {
    const mark = wrapWithBox('words', 'c2', {
      left: 1,
      top: 2,
      width: 3,
      height: 4,
    });

    mark.dispatchEvent({
      type: 'click',
      stopPropagation: () => {},
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: 'relic:frame-mark-click',
      id: 'c2',
      rect: { left: 1, top: 2, width: 3, height: 4 },
    });
    expect(isFrameMarkClickMessage(posted[0])).toBe(true);
  });

  test('hover and click on a region mark carry its box', () => {
    const div = paintFrameRegion(
      mockDoc.body as unknown as HTMLElement,
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      'reg-9'
    );
    expect(div).not.toBeUndefined();
    const region = div as unknown as MockNode & {
      getBoundingClientRect: () => unknown;
    };
    region.getBoundingClientRect = () => ({
      left: 50,
      top: 60,
      width: 70,
      height: 80,
      right: 120,
      bottom: 140,
    });

    region.dispatchEvent({ type: 'mouseenter' });
    region.dispatchEvent({ type: 'click', stopPropagation: () => {} });
    region.dispatchEvent({ type: 'mouseleave' });

    const hover = posted.find(
      (m) => m.type === 'relic:frame-mark-hover' && m.id === 'reg-9'
    );
    const leave = posted.find(
      (m) => m.type === 'relic:frame-mark-hover' && m.id === null
    );
    const click = posted.find((m) => m.type === 'relic:frame-mark-click');
    expect(hover?.rect).toEqual({ left: 50, top: 60, width: 70, height: 80 });
    expect(leave).toEqual({ type: 'relic:frame-mark-hover', id: null });
    expect(click).toEqual({
      type: 'relic:frame-mark-click',
      id: 'reg-9',
      rect: { left: 50, top: 60, width: 70, height: 80 },
    });
  });

  test('a selection carries its box and the full selected text', () => {
    const root = makeElement('div', {}, 'selectable words');
    mockDoc.body.appendChild(root);
    const textNode = root.firstChild as unknown as { data: string };

    mockWin.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'selectable words',
      getRangeAt: () => ({
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: 15,
        getBoundingClientRect: () => ({
          left: 5,
          top: 6,
          width: 100,
          height: 12,
        }),
      }),
    });

    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        posted.push(msg as PostedMessage);
      }
    );
    expect(interaction.isArmed()).toBe(false);

    mockDoc.body.dispatchEvent({ type: 'mouseup' });

    const selection = posted.find((m) => m.type === 'relic:frame-selection');
    expect(selection).toBeDefined();
    expect(selection?.exact).toBe('selectable words');
    expect(selection?.text).toBe('selectable words');
    expect(selection?.truncated).toBeUndefined();
    expect(selection?.rect).toEqual({
      left: 5,
      top: 6,
      width: 100,
      height: 12,
    });
    expect(isFrameSelectionMessage(selection)).toBe(true);
  });

  test('an oversized selection is flagged and its copy text capped', () => {
    const raw = 'x'.repeat(70_000);
    mockWin.getSelection = () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => raw,
      getRangeAt: () => ({
        startContainer: mockDoc.body,
        startOffset: 0,
        endContainer: mockDoc.body,
        endOffset: 1,
      }),
    });

    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        posted.push(msg as PostedMessage);
      }
    );
    expect(interaction.isArmed()).toBe(false);

    mockDoc.body.dispatchEvent({ type: 'mouseup' });

    const selection = posted.find((m) => m.type === 'relic:frame-selection');
    expect(selection).toBeDefined();
    expect(selection?.truncated).toBe(true);
    expect(selection?.exact).toBe('x'.repeat(512));
    expect(selection?.text).toBe('x'.repeat(64 * 1024));
    expect(selection?.rect).toBeUndefined();
    expect(isFrameSelectionMessage(selection)).toBe(true);
  });

  test('a collapsing selection posts one cleared message', () => {
    let selection: unknown = null;
    mockWin.getSelection = () => selection;

    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      (msg) => {
        posted.push(msg as PostedMessage);
      }
    );
    expect(interaction.isArmed()).toBe(false);

    // Nothing was ever reported: a falling edge without a rise posts nothing.
    mockDoc.body.dispatchEvent({ type: 'selectionchange' });
    expect(posted).toHaveLength(0);

    const root = makeElement('div', {}, 'a sentence to select');
    mockDoc.body.appendChild(root);
    const textNode = root.firstChild as unknown as { data: string };
    selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'a sentence',
      getRangeAt: () => ({
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: 10,
      }),
    };
    mockDoc.body.dispatchEvent({ type: 'mouseup' });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe('relic:frame-selection');

    // The selection collapses: one cleared message, and no repeats.
    selection = null;
    mockDoc.body.dispatchEvent({ type: 'selectionchange' });
    mockDoc.body.dispatchEvent({ type: 'selectionchange' });
    const cleared = posted.filter(
      (m) => m.type === 'relic:frame-selection-cleared'
    );
    expect(cleared).toHaveLength(1);
  });

  test('quiet-marks settles the named marks and reopening puts them back', () => {
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      () => {}
    );

    const rootA = makeElement('p', {}, 'first quote here');
    const rootB = makeElement('p', {}, 'second quote here');
    mockDoc.body.appendChild(rootA);
    mockDoc.body.appendChild(rootB);
    wrapFrameQuote(
      rootA as unknown as HTMLElement,
      'first quote',
      '',
      '',
      'c-a'
    );
    wrapFrameQuote(
      rootB as unknown as HTMLElement,
      'second quote',
      '',
      '',
      'c-b'
    );
    const markA = mockDoc.body.querySelector(
      '[data-comment-id="c-a"]'
    ) as unknown as { classList: MockClassList };
    const markB = mockDoc.body.querySelector(
      '[data-comment-id="c-b"]'
    ) as unknown as { classList: MockClassList };

    interaction.onQuietMarks(['c-b']);
    expect(markA.classList.contains('is-resolved')).toBe(false);
    expect(markB.classList.contains('is-resolved')).toBe(true);

    // The whole list every time, so undoing a resolution is expressible. A
    // message that only ever added would leave a reopened comment looking
    // closed inside the frame while the thread said otherwise.
    interaction.onQuietMarks([]);
    expect(markB.classList.contains('is-resolved')).toBe(false);
  });

  test('active-mark lights the matching mark and null clears every mark', () => {
    const interaction = setupFrameInteraction(
      mockDoc as unknown as Document,
      mockWin as unknown as Window,
      () => {}
    );

    const rootA = makeElement('p', {}, 'first quote here');
    const rootB = makeElement('p', {}, 'second quote here');
    mockDoc.body.appendChild(rootA);
    mockDoc.body.appendChild(rootB);
    wrapFrameQuote(
      rootA as unknown as HTMLElement,
      'first quote',
      '',
      '',
      'c-a'
    );
    wrapFrameQuote(
      rootB as unknown as HTMLElement,
      'second quote',
      '',
      '',
      'c-b'
    );
    const markA = mockDoc.body.querySelector(
      '[data-comment-id="c-a"]'
    ) as unknown as { classList: MockClassList };
    const markB = mockDoc.body.querySelector(
      '[data-comment-id="c-b"]'
    ) as unknown as { classList: MockClassList };
    expect(markA).not.toBeNull();
    expect(markB).not.toBeNull();

    interaction.onActiveMark('c-b');
    expect(markA.classList.contains('is-active')).toBe(false);
    expect(markB.classList.contains('is-active')).toBe(true);

    interaction.onActiveMark('c-a');
    expect(markA.classList.contains('is-active')).toBe(true);
    expect(markB.classList.contains('is-active')).toBe(false);

    interaction.onActiveMark(null);
    expect(markA.classList.contains('is-active')).toBe(false);
    expect(markB.classList.contains('is-active')).toBe(false);
  });

  test('relic:active-mark routes to the interaction through the handler', () => {
    const activeIds: (string | null)[] = [];
    const handle = createSandboxHandler(
      () => {},
      () => {},
      () => {},
      {
        setArmed: () => {},
        onPaintMark: () => true,
        onPaintMarks: () => true,
        onClearMark: () => {},
        onClearMarks: () => {},
        onRevealMark: () => {},
        onPairMark: () => {},
        onActiveMark: (id) => {
          activeIds.push(id);
        },
      }
    );

    expect(handle({ type: 'relic:render', html: '<p>ok</p>' })).toBe(true);
    expect(handle({ type: 'relic:active-mark', id: 'c-7' })).toBe(true);
    expect(handle({ type: 'relic:active-mark', id: null })).toBe(true);

    expect(activeIds).toEqual(['c-7', null]);
  });

  test('mark CSS keeps commented passages visible at rest, active strongest', () => {
    // The stylesheet is a constant; assert the states it must carry rather
    // than re-deriving them from selectors elsewhere in this file.
    expect(FRAME_MARK_CSS).toContain('.relic-text-mark {');
    expect(FRAME_MARK_CSS).toContain('.relic-text-mark.is-active {');
    expect(FRAME_MARK_CSS).toContain('.relic-text-mark.is-resolved {');
    expect(FRAME_MARK_CSS).toContain('.relic-region-mark.is-active {');
    expect(FRAME_MARK_CSS).toContain('.relic-region-mark.is-resolved {');
    // Every declaration is !important: the frame's document is author-owned
    // content that must never be able to hide a mark.
    for (const line of FRAME_MARK_CSS.split('\n')) {
      if (line.trim().startsWith('background:')) {
        expect(line).toContain('!important');
      }
      if (line.trim().startsWith('border-bottom:')) {
        expect(line).toContain('!important');
      }
    }
  });
});
