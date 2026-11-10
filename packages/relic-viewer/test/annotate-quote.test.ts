/**
 * Tests for quote anchor resolving, painting, and context-aware disambiguation.
 *
 * A reader highlighting text on the page needs their comment anchored to the
 * exact occurrence they selected, even when that phrase appears multiple times
 * in the document. These tests assert that context resolves the correct
 * occurrence, that frozen text anchors remain unchanged, that missing quotes
 * return false safely, and that character boundaries are never split.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CommentAnchor } from '@relic/format';
import type { AnchorSurface } from '../src/anchoring.ts';
import {
  captureSelectionQuote,
  quoteAdapter,
  takeHeadUtf8,
  takeTailUtf8,
} from '../src/annotate-quote.ts';
import {
  unwrapTextQuotes,
  walkContentTextNodes,
  wrapTextQuote,
  wrapTextQuoteWithContext,
} from '../src/comments.ts';
import { contentFromBytes } from '../src/content.ts';
import {
  findSourceQuote,
  mountTextWindow,
  textWindowFor,
  type WindowMark,
} from '../src/text-window.ts';

// A minimal, complete DOM tree for testing text manipulation and tree-walking.
class TestNode extends EventTarget {
  parentElement: TestElement | null = null;
  parentNode: TestElement | null = null;

  contains(other: TestNode): boolean {
    let curr: TestNode | null = other;
    while (curr !== null) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
}

class TestText extends TestNode {
  readonly nodeType = 3;
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(val: string) {
    this.data = val;
  }

  splitText(offset: number): TestText {
    const head = this.data.slice(0, offset);
    const tail = this.data.slice(offset);
    this.data = head;
    const next = new TestText(tail);
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx !== -1) {
        this.parentNode.childNodes.splice(idx + 1, 0, next);
        next.parentNode = this.parentNode;
        next.parentElement = this.parentElement;
      }
    }
    return next;
  }
}

class TestElement extends TestNode {
  /** Real elements have it, and the content flow excludes anything carrying it. */
  hidden = false;
  readonly nodeType = 1;
  readonly tagName: string;
  className = '';
  readonly dataset: Record<string, string> = {};
  get firstChild(): TestElement | TestText | null {
    return this.childNodes[0] ?? null;
  }
  readonly childNodes: (TestElement | TestText)[] = [];
  scrolledIntoView = false;
  focused = false;
  clientHeight = 40;
  private readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  focus(): void {
    this.focused = true;
  }

  append(...children: (TestElement | TestText)[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: (TestElement | TestText)[]): void {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...children);
  }

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get children(): TestElement[] {
    return this.childNodes.filter(
      (c): c is TestElement => c instanceof TestElement
    );
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(val: string) {
    this.childNodes.length = 0;
    if (val.length > 0) {
      this.appendChild(new TestText(val));
    }
  }

  readonly classList = {
    add: (...classes: string[]): void => {
      const parts = this.className.split(' ').filter(Boolean);
      for (const cls of classes) {
        if (!parts.includes(cls)) parts.push(cls);
      }
      this.className = parts.join(' ');
    },
    remove: (cls: string): void => {
      this.className = this.className
        .split(' ')
        .filter((c) => c && c !== cls)
        .join(' ');
    },
    contains: (cls: string): boolean => {
      return this.className.split(' ').filter(Boolean).includes(cls);
    },
    toggle: (cls: string, on?: boolean): void => {
      const active = on ?? !this.classList.contains(cls);
      if (active) this.classList.add(cls);
      else this.classList.remove(cls);
    },
  };

  appendChild<T extends TestElement | TestText>(child: T): T {
    if (child instanceof TestElement && child.tagName === '#FRAGMENT') {
      this.append(...child.childNodes);
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    this.childNodes.push(child);
    child.parentNode = this;
    child.parentElement = this;
    return child;
  }

  insertBefore<T extends TestElement | TestText>(
    newChild: T,
    refChild: TestElement | TestText | null
  ): T {
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    if (refChild === null) {
      return this.appendChild(newChild);
    }
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) {
      return this.appendChild(newChild);
    }
    this.childNodes.splice(idx, 0, newChild);
    newChild.parentNode = this;
    newChild.parentElement = this;
    return newChild;
  }

  removeChild<T extends TestElement | TestText>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  normalize(): void {
    const normalized: (TestElement | TestText)[] = [];
    let prevText: TestText | null = null;
    for (const child of this.childNodes) {
      if (child instanceof TestText) {
        if (child.data.length === 0) continue;
        if (prevText) {
          prevText.data += child.data;
        } else {
          prevText = child;
          normalized.push(child);
        }
      } else {
        prevText = null;
        child.normalize();
        normalized.push(child);
      }
    }
    this.childNodes.length = 0;
    this.childNodes.push(...normalized);
  }

  closest(selector: string): TestElement | null {
    const matchers = selector.split(',').map((s) => s.trim());
    let curr: TestElement | null = this;
    while (curr !== null) {
      for (const m of matchers) {
        if (matchesSelector(curr, m)) return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll<T extends TestElement = TestElement>(selector: string): T[] {
    const results: T[] = [];
    const matchers = selector.split(',').map((s) => s.trim());
    function search(elem: TestElement): void {
      for (const child of elem.childNodes) {
        if (child instanceof TestElement) {
          for (const m of matchers) {
            if (matchesSelector(child, m)) {
              results.push(child as unknown as T);
              break;
            }
          }
          search(child);
        }
      }
    }
    search(this);
    return results;
  }

  scrollIntoView(_options?: { block?: string }): void {
    this.scrolledIntoView = true;
  }
}

function matchesSelector(elem: TestElement, selector: string): boolean {
  if (selector === 'iframe.usercontent-frame') {
    return (
      elem.tagName === 'IFRAME' && elem.classList.contains('usercontent-frame')
    );
  }
  if (selector === 'mark.relic-text-mark') {
    return (
      elem.tagName === 'MARK' && elem.classList.contains('relic-text-mark')
    );
  }
  // The overlay and control classes the content flow excludes. Listed rather
  // than reduced to a generic class check so an added selector has to be
  // taught here too, instead of silently falling through to the tag branch.
  for (const cls of [
    'comment-pins',
    'comment-region',
    'mark-bubble',
    'mark-hint',
    'mark-quote-action',
    'text-window-tools',
    'text-window',
    'text-window-page',
    'text-window-row',
    'text-window-scroll',
  ]) {
    if (selector === `.${cls}`) return elem.classList.contains(cls);
  }
  if (selector === 'pre.raw') {
    return elem.tagName === 'PRE' && elem.classList.contains('raw');
  }
  if (selector === '[hidden]') {
    return elem.hidden;
  }
  if (selector === 'script') {
    return elem.tagName === 'SCRIPT';
  }
  if (selector === 'style') {
    return elem.tagName === 'STYLE';
  }
  if (selector.startsWith('mark[')) {
    if (elem.tagName !== 'MARK') return false;
    const match = /data-comment-id="([^"]+)"/.exec(selector);
    return match ? elem.dataset.commentId === match[1] : true;
  }
  if (selector.startsWith('[')) {
    const match = /data-comment-id="([^"]+)"/.exec(selector);
    // No blanket true for an attribute this stub has not been taught. That
    // made every element match `[hidden]`, which emptied the content flow and
    // failed five tests for a reason that had nothing to do with the code.
    return match !== null && elem.dataset.commentId === match[1];
  }
  return elem.tagName === selector.toUpperCase();
}

function installTestDom(): void {
  (globalThis as { NodeFilter?: unknown }).NodeFilter = {
    SHOW_TEXT: 4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  };
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => new TestText(text),
    createDocumentFragment: () => new TestElement('#fragment'),
    createTreeWalker: (
      root: TestNode,
      _whatToShow: number,
      filter?: { acceptNode(n: TestNode): number }
    ) => {
      const textNodes: TestText[] = [];
      function collect(node: TestNode): void {
        if (node instanceof TestText) {
          if (!filter || filter.acceptNode(node) === 1) {
            textNodes.push(node);
          }
          return;
        }
        if (node instanceof TestElement) {
          for (const child of [...node.childNodes]) {
            collect(child);
          }
        }
      }
      collect(root);
      let idx = 0;
      return {
        nextNode: (): TestText | null => {
          if (idx < textNodes.length) {
            const next = textNodes[idx];
            idx++;
            return next ?? null;
          }
          return null;
        },
      };
    },
  };
}

function clearTestDom(): void {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { NodeFilter?: unknown }).NodeFilter;
}

describe('quote anchor adapter and context-aware resolver', () => {
  beforeEach(installTestDom);
  afterEach(clearTestDom);

  describe('windowed source comments', () => {
    test.each([
      ['identical', 'alpha beta gamma', 'alpha beta gamma'],
      ['contained', 'alpha beta gamma', 'beta'],
      ['crossing', 'alpha beta', 'beta gamma'],
      ['across rows', 'beta gamma\ndelta', 'gamma\ndelta epsilon'],
    ])(
      '%s ranges retain both navigable identities',
      async (_name, first, second) => {
        const source =
          'earlier source\n'.repeat(90) +
          'alpha beta gamma\ndelta epsilon\nend';
        const root = new TestElement('div');
        const handle = mountTextWindow(
          root as unknown as HTMLElement,
          contentFromBytes(new TextEncoder().encode(source))
        );
        try {
          await handle.ready;
          expect(textWindowFor(root as unknown as HTMLElement)).toBe(handle);
          const page = root.querySelector('.text-window-page')!;
          const scroll = root.querySelector('.text-window-scroll')!;
          const marks: WindowMark[] = [
            {
              id: 'second',
              anchor: { kind: 'quote', exact: second! },
              resolved: true,
            },
            { id: 'first', anchor: { kind: 'quote', exact: first! } },
          ];
          handle.setMarks(marks);
          let count: number | undefined;
          for (const id of ['first', 'second']) {
            // Leave the target window before navigating each comment. A retained
            // position alone is insufficient: its own mark must survive repaint.
            const { promise: painted, resolve } = Promise.withResolvers<void>();
            root.addEventListener('relic:text-window-paint', () => resolve(), {
              once: true,
            });
            (scroll as unknown as HTMLInputElement).value = '0';
            scroll.dispatchEvent(new Event('input'));
            await painted;
            expect(page.textContent).toBe('earlier source\nearlier source\n');
            page.focused = false;
            await handle.reveal(id);
            expect(page.focused).toBe(true);
            expect(page.textContent).toBe('alpha beta gamma\ndelta epsilon\n');
            for (const mark of marks) {
              const parts = page.querySelectorAll(
                `mark[data-comment-id="${mark.id}"]`
              );
              expect(parts.length).toBeGreaterThan(0);
              expect(parts.map((part) => part.textContent).join('')).toBe(
                mark.anchor.kind === 'quote' ? mark.anchor.exact : ''
              );
              expect(
                parts.every(
                  (part) =>
                    part.classList.contains('is-resolved') === !!mark.resolved
                )
              ).toBe(true);
            }
            const nextCount = page.querySelectorAll(
              'mark.relic-text-mark'
            ).length;
            if (count !== undefined) expect(nextCount).toBe(count);
            count = nextCount;
          }
          // Capturing inside nested marks must still see source once, not
          // duplicated overlap text or the window's Line/Go/status controls.
          const selected = walkContentTextNodes(
            page as unknown as HTMLElement
          ).find((node) => node.data.includes('beta'))!;
          const offset = selected.data.indexOf('beta');
          const quote = captureSelectionQuote(
            root as unknown as HTMLElement,
            {
              startContainer: selected,
              startOffset: offset,
              endContainer: selected,
              endOffset: offset + 'beta'.length,
            } as unknown as Range,
            { toString: () => 'beta' } as unknown as Selection
          );
          expect(quote).toEqual({
            kind: 'quote',
            exact: 'beta',
            prefix: 'alpha ',
            suffix: ' gamma\ndelta epsilon\n',
          });
          handle.setMarks([]);
          await handle.reveal('first');
          expect(page.querySelectorAll('mark.relic-text-mark')).toHaveLength(0);
          expect(page.textContent).toBe('alpha beta gamma\ndelta epsilon\n');
        } finally {
          handle.dispose();
        }
      }
    );

    test.each([
      [0, 'source'],
      [0, 'alpha'],
      [90, 'source'],
      [90, 'alpha'],
    ] as const)(
      'capture near displayed row %i excludes tools for %s',
      async (firstRow, exact) => {
        const lines = Array.from(
          { length: 100 },
          (_, row) =>
            `source ${String(row).padStart(3, '0')}: alpha beta gamma\n`
        );
        const source = lines.join('');
        const content = contentFromBytes(new TextEncoder().encode(source));
        const root = new TestElement('div');
        const handle = mountTextWindow(root as unknown as HTMLElement, content);
        try {
          await handle.ready;
          handle.setMarks([
            { id: 'seed', anchor: { kind: 'text', quote: lines[firstRow]! } },
          ]);
          await handle.reveal('seed');
          const page = root.querySelector('.text-window-page')!;
          const tools = root.querySelector('.text-window-tools')!;
          expect(tools.textContent).toContain('LineGo');
          const text = page.querySelector('mark[data-comment-id="seed"]')!
            .childNodes[0] as TestText;
          const offset = text.data.indexOf(exact);
          expect(offset).toBeGreaterThanOrEqual(0);
          const anchor = captureSelectionQuote(
            root as unknown as HTMLElement,
            {
              startContainer: text,
              startOffset: offset,
              endContainer: text,
              endOffset: offset + exact.length,
            } as unknown as Range,
            { toString: () => exact } as unknown as Selection
          );
          expect(anchor?.kind).toBe('quote');
          const quote = anchor as Extract<CommentAnchor, { kind: 'quote' }>;
          expect(quote.exact).toBe(exact);
          expect(quote.prefix ?? '').toBe(page.textContent.slice(0, offset));
          expect(quote.suffix).toBe(
            page.textContent.slice(offset + exact.length)
          );
          expect(
            walkContentTextNodes(root as unknown as HTMLElement)
              .map((node) => node.data)
              .join('')
          ).toBe(page.textContent);
          const start = lines.slice(0, firstRow).join('').length + offset;
          expect(await findSourceQuote(content, quote)).toEqual({
            start,
            end: start + exact.length,
          });
          handle.setMarks([{ id: 'captured', anchor: quote }]);
          await handle.reveal('captured');
          expect(
            page.querySelector('mark[data-comment-id="captured"]')?.textContent
          ).toBe(exact);
          expect(page.textContent).toBe(
            lines.slice(firstRow, firstRow + 2).join('')
          );
        } finally {
          handle.dispose();
        }
      }
    );
  });

  test('headline case: document contains the same phrase three times and context names the second', () => {
    // The defect: wrapTextQuote wrapped the first occurrence unconditionally.
    // When a phrase occurs multiple times, the resolver must use prefix/suffix
    // context to land on the second occurrence.
    const stage = new TestElement('div');
    stage.className = 'stage-wrap';

    const p1 = new TestElement('p');
    p1.textContent = 'First observation: not measured in a browser.';
    const p2 = new TestElement('p');
    p2.textContent = 'Second observation: not measured in a browser.';
    const p3 = new TestElement('p');
    p3.textContent = 'Third observation: not measured in a browser.';
    stage.appendChild(p1);
    stage.appendChild(p2);
    stage.appendChild(p3);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const overlay = new TestElement('div');
    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'not measured in a browser',
      prefix: 'Second observation: ',
      suffix: '.',
    };

    const placed = quoteAdapter.paint(
      surface,
      overlay as unknown as HTMLElement,
      anchor,
      'comment-2'
    );
    expect(placed).toBe(true);

    // Paragraph 1 must NOT have the mark.
    expect(p1.querySelector('mark.relic-text-mark')).toBeNull();

    // Paragraph 2 MUST have the mark.
    const mark = p2.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.dataset.commentId).toBe('comment-2');
    expect(mark?.textContent).toBe('not measured in a browser');

    // Paragraph 3 must NOT have the mark.
    expect(p3.querySelector('mark.relic-text-mark')).toBeNull();
  });

  test('proves the defect: ignoring context lands on the wrong (first) occurrence', () => {
    // When context is absent, the resolver falls back to first-occurrence,
    // which highlights paragraph 1 rather than paragraph 2.
    const stage = new TestElement('div');
    const p1 = new TestElement('p');
    p1.textContent = 'First observation: not measured in a browser.';
    const p2 = new TestElement('p');
    p2.textContent = 'Second observation: not measured in a browser.';
    stage.appendChild(p1);
    stage.appendChild(p2);

    const anchorWithoutContext = {
      exact: 'not measured in a browser',
    };

    const placed = wrapTextQuoteWithContext(
      stage as unknown as ParentNode,
      anchorWithoutContext,
      'comment-no-context'
    );
    expect(placed).toBe(true);

    // Without context, it lands on the first paragraph.
    expect(p1.querySelector('mark.relic-text-mark')).not.toBeNull();
    expect(p2.querySelector('mark.relic-text-mark')).toBeNull();
  });

  test('frozen text anchor still lands on the first occurrence unchanged', () => {
    // Stored legacy text comments must continue to paint on the first occurrence.
    const stage = new TestElement('div');
    const p1 = new TestElement('p');
    p1.textContent = 'First: not measured in a browser.';
    const p2 = new TestElement('p');
    p2.textContent = 'Second: not measured in a browser.';
    stage.appendChild(p1);
    stage.appendChild(p2);

    const placed = wrapTextQuote(
      stage as unknown as ParentNode,
      'not measured in a browser',
      'legacy-text-id'
    );
    expect(placed).toBe(true);

    expect(p1.querySelector('mark.relic-text-mark')).not.toBeNull();
    expect(p2.querySelector('mark.relic-text-mark')).toBeNull();
  });

  test('a quote no longer present returns false rather than throwing or marking wrong runs', () => {
    // When a relic is republished and earlier text was deleted, paint must
    // return false so the thread can display the unplaceable note.
    const stage = new TestElement('div');
    const p1 = new TestElement('p');
    p1.textContent = 'Content currently on the page.';
    stage.appendChild(p1);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'deleted text from an older version',
      prefix: 'context before ',
      suffix: ' context after',
    };

    const placed = quoteAdapter.paint(
      surface,
      new TestElement('div') as unknown as HTMLElement,
      anchor,
      'deleted-comment'
    );
    expect(placed).toBe(false);
    expect(stage.querySelector('mark')).toBeNull();
  });

  test('quotes spanning across inline elements resolve and wrap cleanly', () => {
    // A reader highlighting across emphasis (e.g. `the <em>third</em> paragraph`)
    // must still resolve across text node boundaries.
    const stage = new TestElement('div');
    const p = new TestElement('p');
    const lead = new TestText('the ');
    const em = new TestElement('em');
    em.appendChild(new TestText('third'));
    const trail = new TestText(' paragraph of the document');

    p.appendChild(lead);
    p.appendChild(em);
    p.appendChild(trail);
    stage.appendChild(p);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'the third paragraph',
      suffix: ' of the document',
    };

    const placed = quoteAdapter.paint(
      surface,
      new TestElement('div') as unknown as HTMLElement,
      anchor,
      'inline-comment'
    );
    expect(placed).toBe(true);

    const marks = stage.querySelectorAll('mark.relic-text-mark');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    for (const mark of marks) {
      expect(mark.dataset.commentId).toBe('inline-comment');
    }
    expect(marks.map((m) => m.textContent).join('')).toBe(
      'the third paragraph'
    );

    // Unwrapping cleanly restores the text flow.
    unwrapTextQuotes(stage as unknown as ParentNode);
    expect(stage.querySelectorAll('mark')).toHaveLength(0);
    expect(p.textContent).toBe('the third paragraph of the document');
  });

  /**
   * Where a mark actually landed, as a character offset into the document's
   * own text.
   *
   * Asserting the marked string is not enough when the document repeats it:
   * every occurrence gives the same string, which is how the reported defect
   * stayed invisible. The offset names which one.
   */
  function markOffset(root: TestElement, id: string): number | null {
    let seen = 0;
    let found: number | null = null;
    const walk = (elem: TestElement, insideId: string | null): void => {
      for (const child of elem.childNodes) {
        if (child instanceof TestText) {
          if (insideId === id && found === null) found = seen;
          seen += child.data.length;
        } else if (child instanceof TestElement) {
          walk(child, child.dataset.commentId ?? insideId);
        }
      }
    };
    walk(root, root.dataset.commentId ?? null);
    return found;
  }

  test('resolution does not depend on which comments are already painted', () => {
    /**
     * The reported defect, at the unit. A reader who had already commented,
     * then selected text inside their own mark, got a comment anchored beside
     * the earlier one: the text flow used to skip marked text, so the document
     * a comment resolved against changed shape depending on what was painted.
     *
     * The guarantee is that it does not. The same anchor resolved against a
     * clean document and against one already carrying a mark over those very
     * words has to land at the same place, so the anchor here deliberately
     * names the occurrence the earlier mark covers.
     */
    const build = (): { stage: TestElement; p: TestElement } => {
      const stage = new TestElement('div');
      const p = new TestElement('p');
      p.textContent = 'the target text repeated here and target text here';
      stage.appendChild(p);
      return { stage, p };
    };

    const anchor = { exact: 'target text', prefix: 'the ' };

    const clean = build();
    expect(
      wrapTextQuoteWithContext(
        clean.stage as unknown as ParentNode,
        anchor,
        'the-mark'
      )
    ).toBe(true);
    const cleanOffset = markOffset(clean.stage, 'the-mark');
    expect(cleanOffset).toBe(4);

    const painted = build();
    expect(
      wrapTextQuoteWithContext(
        painted.stage as unknown as ParentNode,
        { exact: 'the target text' },
        'earlier-mark'
      )
    ).toBe(true);
    expect(
      wrapTextQuoteWithContext(
        painted.stage as unknown as ParentNode,
        anchor,
        'the-mark'
      )
    ).toBe(true);

    // The same place, not merely the same words. Under the old flow this was
    // 34: the occurrence in the tail, because the one the reader meant was
    // hidden inside the earlier mark.
    expect(markOffset(painted.stage, 'the-mark')).toBe(cleanOffset);

    unwrapTextQuotes(painted.stage as unknown as ParentNode);
    expect(painted.p.textContent).toBe(
      'the target text repeated here and target text here'
    );
  });

  test('two comments on the same words both paint rather than one vanishing', () => {
    /**
     * Overlap used to be dropped, on a rule about nesting that repaint already
     * handles by unwrapping first. A dropped mark tells a reader their comment
     * points at something this page cannot show, with the text in front of
     * them.
     */
    const stage = new TestElement('div');
    const p = new TestElement('p');
    p.textContent = 'the target text repeated here and target text here';
    stage.appendChild(p);

    expect(
      wrapTextQuoteWithContext(
        stage as unknown as ParentNode,
        { exact: 'the target text' },
        'first-mark'
      )
    ).toBe(true);
    expect(
      wrapTextQuoteWithContext(
        stage as unknown as ParentNode,
        { exact: 'target text', prefix: 'the ' },
        'second-mark'
      )
    ).toBe(true);

    expect(markOffset(stage, 'first-mark')).toBe(0);
    expect(markOffset(stage, 'second-mark')).toBe(4);

    unwrapTextQuotes(stage as unknown as ParentNode);
    expect(stage.querySelectorAll('mark')).toHaveLength(0);
    expect(p.textContent).toBe(
      'the target text repeated here and target text here'
    );
  });

  test('capture records the selection the reader made, inside an existing mark', () => {
    /**
     * The reported path. The reader had commented, so their words carried a
     * mark; they highlighted new text inside it and commented again, and the
     * second comment pointed where the first one did.
     *
     * Capture used to read a flow with marked text removed, so the container
     * of this selection was not in it at all, and the context it wrote out
     * described a different occurrence entirely. The context has to describe
     * the occurrence the reader selected, so the anchor cannot be satisfied by
     * the other one.
     */
    const stage = new TestElement('div');
    const p = new TestElement('p');
    p.textContent = 'the target text repeated here and target text here';
    stage.appendChild(p);

    // An earlier comment marks the opening phrase, exactly as the page would.
    expect(
      wrapTextQuoteWithContext(
        stage as unknown as ParentNode,
        { exact: 'the target text' },
        'earlier-mark'
      )
    ).toBe(true);

    // The reader selects "target text" inside that mark.
    const marked = stage.querySelectorAll('mark.relic-text-mark')[0];
    const inside = marked?.childNodes[0] as TestText;
    expect(inside.data).toContain('target text');
    const at = inside.data.indexOf('target text');

    const anchor = captureSelectionQuote(
      stage as unknown as HTMLElement,
      {
        startContainer: inside,
        startOffset: at,
        endContainer: inside,
        endOffset: at + 'target text'.length,
      } as unknown as Range,
      { toString: () => 'target text' } as unknown as Selection
    );

    expect(anchor).not.toBeNull();
    expect(anchor?.kind).toBe('quote');
    const quote = anchor as Extract<CommentAnchor, { kind: 'quote' }>;
    expect(quote.exact).toBe('target text');
    // The words before it in the document, which is what distinguishes the
    // occurrence the reader chose from the one further along.
    expect(quote.prefix).toBe('the ');

    // And the captured anchor resolves back to that same place on a clean
    // page: capture and resolution reading one document is the whole point.
    const fresh = new TestElement('div');
    const freshP = new TestElement('p');
    freshP.textContent = 'the target text repeated here and target text here';
    fresh.appendChild(freshP);
    expect(
      wrapTextQuoteWithContext(
        fresh as unknown as ParentNode,
        quote,
        'round-trip'
      )
    ).toBe(true);
    expect(markOffset(fresh, 'round-trip')).toBe(4);
  });

  test('the hidden markdown source is not part of the document', () => {
    /**
     * The Markdown view keeps the source in a hidden `pre.raw` beside the
     * rendered prose, for the source toggle. It used to be in the text flow,
     * which put the whole document in there twice: every phrase got a second
     * candidate, and a quote at the end of the prose took its trailing
     * context from source the reader cannot see.
     */
    const stage = new TestElement('div');
    const prose = new TestElement('article');
    const para = new TestElement('p');
    para.textContent = 'ends on the last words.';
    prose.appendChild(para);
    const raw = new TestElement('pre');
    raw.classList.add('raw');
    raw.hidden = true;
    raw.textContent = '# Heading\n\nends on the last words.';
    stage.appendChild(prose);
    stage.appendChild(raw);

    const at = para.textContent.indexOf('last words');
    const text = para.childNodes[0] as TestText;
    const anchor = captureSelectionQuote(
      stage as unknown as HTMLElement,
      {
        startContainer: text,
        startOffset: at,
        endContainer: text,
        endOffset: at + 'last words'.length,
      } as unknown as Range,
      { toString: () => 'last words' } as unknown as Selection
    );

    const quote = anchor as Extract<CommentAnchor, { kind: 'quote' }>;
    expect(quote.exact).toBe('last words');
    // What follows in the document, and nothing beyond its end.
    expect(quote.suffix ?? '').toBe('.');

    // And the mark lands in the prose the reader is looking at.
    expect(
      wrapTextQuoteWithContext(
        stage as unknown as ParentNode,
        quote,
        'prose-mark'
      )
    ).toBe(true);
    const marks = stage.querySelectorAll('mark[data-comment-id="prose-mark"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.closest('pre.raw')).toBeNull();
  });

  test('label wording matches the chip wording and abbreviates over 60 characters', () => {
    const shortAnchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'a short quote',
    };
    expect(quoteAdapter.label(shortAnchor)).toBe(
      'Commenting on "a short quote"'
    );

    const longAnchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'x'.repeat(80),
    };
    const label = quoteAdapter.label(longAnchor);
    expect(label.length).toBeLessThan(100);
    expect(label).toContain('…');
  });

  test('reveal scrolls the painted mark into view', () => {
    const stage = new TestElement('div');
    const p = new TestElement('p');
    p.textContent = 'some target text to reveal';
    stage.appendChild(p);

    const surface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: stage as unknown as HTMLElement,
    };

    const anchor: Extract<CommentAnchor, { kind: 'quote' }> = {
      kind: 'quote',
      exact: 'target text',
    };

    quoteAdapter.paint(
      surface,
      new TestElement('div') as unknown as HTMLElement,
      anchor,
      'reveal-test'
    );

    const mark = stage.querySelector('mark.relic-text-mark');
    expect(mark).not.toBeNull();
    expect(mark?.scrolledIntoView).toBe(false);

    quoteAdapter.reveal?.(surface, anchor);
    expect(mark?.scrolledIntoView).toBe(true);
  });

  test('supports returns false when the stage holds an iframe.usercontent-frame', () => {
    const stage = new TestElement('div');
    const iframe = new TestElement('iframe');
    iframe.classList.add('usercontent-frame');
    stage.appendChild(iframe);

    const framedSurface: AnchorSurface = {
      host: stage as unknown as HTMLElement,
      content: iframe as unknown as HTMLElement,
    };
    expect(quoteAdapter.supports(framedSurface)).toBe(false);

    const standardStage = new TestElement('div');
    const standardSurface: AnchorSurface = {
      host: standardStage as unknown as HTMLElement,
      content: standardStage as unknown as HTMLElement,
    };
    expect(quoteAdapter.supports(standardSurface)).toBe(true);
  });

  describe('UTF-8 character boundary truncation', () => {
    test('takeHeadUtf8 never cuts multibyte characters in half', () => {
      // 3-byte CJK: '日' (3 bytes), '本' (3 bytes), '語' (3 bytes)
      expect(takeHeadUtf8('日本語', 2)).toBe('');
      expect(takeHeadUtf8('日本語', 3)).toBe('日');
      expect(takeHeadUtf8('日本語', 5)).toBe('日');
      expect(takeHeadUtf8('日本語', 6)).toBe('日本');

      // 4-byte surrogate pair emoji: '😀' (4 bytes)
      expect(takeHeadUtf8('hello 😀 world', 8)).toBe('hello ');
      expect(takeHeadUtf8('hello 😀 world', 10)).toBe('hello 😀');
    });

    test('takeTailUtf8 preserves characters from the end without cutting boundaries', () => {
      // 3-byte CJK
      expect(takeTailUtf8('日本語', 2)).toBe('');
      expect(takeTailUtf8('日本語', 3)).toBe('語');
      expect(takeTailUtf8('日本語', 5)).toBe('語');
      expect(takeTailUtf8('日本語', 6)).toBe('本語');

      // 4-byte emoji
      expect(takeTailUtf8('hello 😀 world', 8)).toBe(' world');
      expect(takeTailUtf8('hello 😀 world', 10)).toBe('😀 world');
      expect(takeTailUtf8('hello 😀 world', 11)).toBe(' 😀 world');
    });
  });
});
