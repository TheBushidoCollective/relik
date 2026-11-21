import { afterAll, describe, expect, test } from 'bun:test';
import type {
  CommentPlaintext,
  SuggestionOutcome,
  SuggestionPayload,
} from '@relic/format';
import { emptyNotebookSourceOffsets } from '@relic/format/notebook';
import {
  codeSegments,
  renderMarkdownWithSource,
  type SourceSegment,
} from '../src/markdown-source.ts';
import {
  buildSuggestionViews,
  clearSuggestionPaint,
  paintSuggestions,
  renderAppliedView,
  renderSuggestionCard,
  SUGGESTION_LAYOUT_MISMATCH,
  SUGGESTION_NOT_FOUND,
  type SuggestionThreadRow,
} from '../src/suggestions.ts';
import { placeableSuggestionPaint } from '../src/suggestion-views.ts';

// Like the other viewer unit tests, use a structural DOM stub. Browser layout
// and event behavior are exercised by the integrating viewer path.
class TestNode {
  readonly childNodes: TestNode[] = [];
  parentNode: TestNode | null = null;
  readonly attributes = new Map<string, string>();
  className = '';
  data = '';
  constructor(
    readonly ownerDocument: TestDocument,
    readonly nodeType: number,
    readonly tagName = ''
  ) {}
  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3
      ? this.data
      : this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    if (this.nodeType === 3) {
      this.data = value;
      return;
    }
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  get classList(): {
    add: (...names: string[]) => void;
    contains: (name: string) => boolean;
  } {
    return {
      add: (...names) => {
        this.className = [
          ...new Set([
            ...this.className.split(/\s+/).filter(Boolean),
            ...names,
          ]),
        ].join(' ');
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }
  setAttribute(name: string, value: string): void {
    if (name === 'class') this.className = value;
    else this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return name === 'class'
      ? this.className
      : (this.attributes.get(name) ?? null);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  appendChild(child: TestNode): TestNode {
    return this.insertBefore(child, null);
  }
  append(...children: TestNode[]): void {
    for (const child of children) this.appendChild(child);
  }
  insertBefore(child: TestNode, before: TestNode | null): TestNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index =
      before === null
        ? this.childNodes.length
        : this.childNodes.indexOf(before);
    if (index < 0) throw new Error('reference node not found');
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: TestNode): TestNode {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error('child not found');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  matches(selector: string): boolean {
    if (this.nodeType !== 1) return false;
    const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const match of selector.matchAll(/\.([a-z0-9_-]+)/gi))
      if (!this.classList.contains(match[1]!)) return false;
    for (const match of selector.matchAll(
      /\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g
    )) {
      const actual = this.getAttribute(match[1]!);
      if (actual === null || (match[2] !== undefined && actual !== match[2]))
        return false;
    }
    return true;
  }
  querySelectorAll(selector: string): TestNode[] {
    const result: TestNode[] = [];
    const walk = (node: TestNode): void => {
      for (const child of node.childNodes) {
        if (selector.split(',').some((part) => child.matches(part.trim())))
          result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }
  querySelector(selector: string): TestNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
class TestDocument {
  createElement(tag: string): TestNode {
    return new TestNode(this, 1, tag.toUpperCase());
  }
  createTextNode(text: string): TestNode {
    const node = new TestNode(this, 3);
    node.data = text;
    return node;
  }
}
const testDocument = new TestDocument();
const documentLike = testDocument as unknown as Document;
const asElement = (node: TestNode): HTMLElement =>
  node as unknown as HTMLElement;

function decodeHtml(value: string): string {
  return value.replace(
    /&#(x[0-9a-f]+|\d+);|&(lt|gt|quot|apos|amp);/gi,
    (_, numeric: string | undefined, named: string | undefined) => {
      if (numeric)
        return String.fromCodePoint(
          numeric[0]?.toLowerCase() === 'x'
            ? parseInt(numeric.slice(1), 16)
            : parseInt(numeric, 10)
        );
      return (
        (
          { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<
            string,
            string
          >
        )[named ?? ''] ?? ''
      );
    }
  );
}

class TestParser {
  parseFromString(html: string): { body: TestNode } {
    const body = testDocument.createElement('body');
    const stack = [body];
    for (const part of html.matchAll(/<([^>]+)>|([^<]+)/g)) {
      const tag = part[1];
      if (tag === undefined) {
        stack[stack.length - 1]?.appendChild(
          testDocument.createTextNode(decodeHtml(part[2] ?? ''))
        );
      } else if (tag.startsWith('/')) {
        stack.pop();
      } else {
        const name = tag.match(/^[a-z0-9-]+/i)?.[0];
        if (!name) continue;
        const node = testDocument.createElement(name);
        for (const attr of tag
          .slice(name.length)
          .matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi))
          node.setAttribute(attr[1]!, decodeHtml(attr[2] ?? ''));
        stack[stack.length - 1]?.appendChild(node);
        if (!['hr', 'br', 'img', 'input'].includes(name.toLowerCase()))
          stack.push(node);
      }
    }
    return { body };
  }
}
const oldParser = globalThis.DOMParser;
Reflect.set(globalThis, 'DOMParser', TestParser);
afterAll(() => {
  Reflect.set(globalThis, 'DOMParser', oldParser);
});

function textRow(
  id: string,
  exact: string,
  replacement: string,
  options: {
    author?: string;
    version?: number;
    at?: string;
    mode?: SuggestionPayload['mode'];
    name?: string;
    resolution?: { at: string; by: string } | null;
  } = {}
): SuggestionThreadRow {
  return {
    id,
    author: options.author ?? `${id}@example.test`,
    version: options.version ?? 1,
    created_at: options.at ?? '2026-01-01T00:00:00Z',
    plaintext: {
      body: 'fallback',
      display_name: options.name ?? id,
      anchor: { kind: 'source', exact },
      suggestion: { v: 1, mode: options.mode ?? 'replace', replacement },
    },
    resolution: options.resolution ?? null,
  };
}
function answer(
  id: string,
  target: string,
  author: string,
  outcome: SuggestionOutcome | null,
  version = 2
): SuggestionThreadRow {
  const plaintext: CommentPlaintext = {
    body: `Note for ${target}`,
    display_name: null,
    addresses: target,
    suggestion_outcome: outcome,
  };
  return { id, author, version, created_at: '2026-01-02T00:00:00Z', plaintext };
}
function mappedRoot(source: string): {
  root: TestNode;
  segments: readonly SourceSegment[];
} {
  const mapped = renderMarkdownWithSource(source);
  return {
    root: new TestParser().parseFromString(mapped.html).body,
    segments: mapped.segments,
  };
}

test('chooses a placeable conflict member without losing the full thread', () => {
  const views = buildSuggestionViews(
    'Ada,other',
    [textRow('cross', 'Ada,other', 'x'), textRow('cell', 'other', 'changed')],
    1,
    1
  );
  expect(views.paint.map((view) => view.row.id)).toEqual(['cross']);
  const cellPaint = placeableSuggestionPaint(
    views,
    (view) => view.location.status === 'resolved' && view.location.start >= 4
  );
  expect(cellPaint.map((view) => view.row.id)).toEqual(['cell']);
  expect(cellPaint[0]?.conflict?.members).toEqual(['cross', 'cell']);
  const card = renderSuggestionCard(
    cellPaint[0]!,
    views,
    documentLike
  ) as unknown as TestNode;
  expect(card.querySelectorAll('.card-member')).toHaveLength(2);
});

test('applied notebook preview selects one empty-cell alternative', () => {
  const source =
    '{"nbformat":4,"cells":[{"cell_type":"code","source":[],"outputs":[]}]}';
  const rows = ['first', 'second'].map((id) => {
    const row = textRow(id, '[', JSON.stringify(id), { mode: 'after' });
    return {
      ...row,
      plaintext: {
        ...row.plaintext,
        anchor: {
          kind: 'source' as const,
          exact: '[',
          prefix: '"source":',
          suffix: '],"outputs"',
        },
      },
    };
  });
  const views = buildSuggestionViews(
    source,
    rows,
    1,
    1,
    null,
    emptyNotebookSourceOffsets(source)
  );
  expect(views.byId.get('first')?.conflict?.members).toEqual([
    'first',
    'second',
  ]);
  const applied = renderAppliedView(
    views,
    'code',
    documentLike
  ) as unknown as TestNode;
  expect(
    JSON.parse(applied.querySelector('.code-body')!.textContent).cells[0].source
  ).toEqual(['first']);
});

describe('suggestion views', () => {
  test('paints an insertion in an empty mapped segment', () => {
    const source = 'a,,b';
    const base = textRow('one', ',', 'x', { mode: 'after' });
    const row = {
      ...base,
      plaintext: {
        ...base.plaintext,
        anchor: {
          kind: 'source' as const,
          exact: ',',
          prefix: 'a',
          suffix: ',b',
        },
      },
    };
    const views = buildSuggestionViews(source, [row], 1, 1);
    const root = testDocument.createElement('div');
    const holder = testDocument.createElement('span');
    holder.setAttribute('data-seg', '0');
    root.appendChild(holder);
    const segments: SourceSegment[] = [
      { text: '', start: 2, end: 2, block: 4, kind: 'text' },
    ];
    expect(
      paintSuggestions(asElement(root), segments, views, 'markdown')
    ).toEqual({ ok: true });
    expect(holder.querySelector('ins')?.textContent).toBe('x');
  });

  test('paints decoded text while retaining source replacement', () => {
    const views = buildSuggestionViews(
      'abc',
      [textRow('one', 'b', 'x""y')],
      1,
      1
    );
    const { root, segments } = mappedRoot('abc');
    expect(
      paintSuggestions(asElement(root), segments, views, 'markdown')
    ).toEqual({ ok: true });
    expect(root.querySelector('ins')?.textContent).not.toBe('x"y');
    expect(
      paintSuggestions(
        asElement(root),
        segments,
        views,
        'markdown',
        (_block, text) => text.replaceAll('""', '"')
      )
    ).toEqual({ ok: true });
    expect(root.querySelector('ins')?.textContent).toBe('x"y');
    expect(views.pending[0]?.inserted).toBe('x""y');
  });

  test('uses publisher outcomes before resolution and replies, and ignores reader outcomes', () => {
    const source = 'one two three four five six seven eight nine ten';
    const rows: SuggestionThreadRow[] = [
      textRow('accepted', 'one', 'ONE', {
        resolution: { at: '2026-01-01', by: 'accepted@example.test' },
      }),
      textRow('superseded', 'two', 'TWO'),
      textRow('declined', 'three', 'THREE'),
      textRow('deferred', 'four', 'FOUR'),
      textRow('withdrawn', 'five', 'FIVE', {
        resolution: { at: '2026-01-01', by: 'withdrawn@example.test' },
      }),
      textRow('closed', 'six', 'SIX', {
        resolution: { at: '2026-01-01', by: 'publisher' },
      }),
      textRow('replied', 'seven', 'SEVEN'),
      textRow('reader-outcome', 'eight', 'EIGHT'),
      textRow('reader-reply', 'nine', 'NINE'),
      textRow('pending', 'ten', 'TEN'),
      answer('a', 'accepted', 'publisher', 'accepted'),
      answer('s', 'superseded', 'publisher', 'superseded'),
      answer('d', 'declined', 'publisher', 'declined'),
      answer('f', 'deferred', 'publisher', 'deferred'),
      answer('r', 'replied', 'publisher', null),
      answer('fraud', 'reader-outcome', 'reader@example.test', 'accepted'),
      answer('ordinary', 'reader-reply', 'reader@example.test', null),
    ];
    const current = buildSuggestionViews(source, rows, 1, 1);
    expect(
      current.views.map((view) => [view.row.id, view.state.state])
    ).toEqual([
      ['accepted', 'accepted'],
      ['closed', 'closed'],
      ['declined', 'declined'],
      ['deferred', 'deferred'],
      ['pending', 'pending'],
      ['reader-outcome', 'pending'],
      ['reader-reply', 'pending'],
      ['replied', 'replied'],
      ['superseded', 'superseded'],
      ['withdrawn', 'withdrawn'],
    ]);
    expect(current.byId.get('accepted')?.state.text).toBe('Accepted in v2');
    expect(current.byId.get('accepted')?.answerNote).toBe('Note for accepted');
    expect(current.byId.get('deferred')?.state.text).toBe(
      'Seen by the publisher, not applied yet'
    );
    expect(current.byId.get('declined')?.state.text).toBe('Not taken');
    const old = buildSuggestionViews(source, rows, 1, 2);
    expect(old.byId.get('reader-outcome')?.state.text).toBe(
      'No answer from the publisher is visible to you'
    );
    expect(old.olderVersionReason).toBe(
      'Suggestions can only be made on the current version.'
    );
    const card = renderSuggestionCard(
      old.byId.get('accepted')!,
      old,
      documentLike
    ) as unknown as TestNode;
    expect(card.textContent).toContain('Accepted in v2');
    expect(card.textContent).toContain('Note for accepted');
  });

  test('groups three conflicting alternatives and collapses identical duplicates', () => {
    const rows = [
      textRow('one', 'quick', 'rapid', { at: '2026-01-01', name: 'Priya' }),
      textRow('two', 'quick', 'fast', { at: '2026-01-02', name: 'Marcus' }),
      textRow('three', 'quick', 'swift', { at: '2026-01-03', name: 'Lena' }),
      textRow('duplicate', 'quick', 'rapid', { at: '2026-01-04', name: 'Sam' }),
    ];
    const views = buildSuggestionViews('the quick fox', rows, 1, 1);
    expect(views.paint.map((view) => view.row.id)).toEqual(['one']);
    expect(views.byId.get('one')?.conflict).toEqual({
      defaultId: 'one',
      members: ['one', 'two', 'three'],
    });
    expect(views.byId.get('one')?.also).toEqual(['duplicate']);
    expect(views.pending).toHaveLength(4);
    const { root, segments } = mappedRoot(views.source);
    expect(
      paintSuggestions(asElement(root), segments, views, 'markdown')
    ).toEqual({ ok: true });
    expect(
      root.querySelectorAll('sup').map((node) => node.textContent)
    ).toEqual(['3', 'also Sam']);
    const card = renderSuggestionCard(
      views.byId.get('one')!,
      views,
      documentLike
    ) as unknown as TestNode;
    expect(card.textContent).toContain(
      "The applied view shows Priya's (posted first)."
    );
    expect(card.querySelectorAll('.card-member')).toHaveLength(3);
    expect(card.textContent).toContain('Also suggested by Sam');
  });

  test('shows surrounding markdown syntax in the source line without interpreting it', () => {
    const views = buildSuggestionViews(
      'See **version 3.2** today',
      [textRow('version', 'version 3.2', 'version 3.3')],
      1,
      1
    );
    const view = views.byId.get('version')!;
    const card = renderSuggestionCard(
      view,
      views,
      documentLike
    ) as unknown as TestNode;
    expect(card.textContent).toContain('Source:');
    expect(card.textContent).toContain('**version 3.2**');
    expect(card.textContent).toContain('**version 3.3**');
    expect(card.querySelectorAll('strong')).toHaveLength(0);
    const codeCard = renderSuggestionCard(
      view,
      views,
      documentLike,
      'code'
    ) as unknown as TestNode;
    expect(codeCard.textContent).not.toContain('Source:');
  });

  test('bounds resolution and reports the remainder without inventing a lost passage', () => {
    const rows = Array.from({ length: 205 }, (_, n) => {
      const word = `word${String(n).padStart(3, '0')}`;
      return textRow(word, word, `edit${n}`);
    });
    const views = buildSuggestionViews(
      rows.map((row) => row.id).join(' '),
      rows,
      1,
      1
    );
    expect(views.inputs).toHaveLength(200);
    expect(views.paint).toHaveLength(200);
    expect(views.pending).toHaveLength(200);
    expect(views.overflowNote).toBe(
      '5 more suggestions are in the comments panel.'
    );
    expect(views.byId.get('word204')?.location.status).toBe('capped');
    const card = renderSuggestionCard(
      views.byId.get('word204')!,
      views,
      documentLike
    ) as unknown as TestNode;
    expect(card.textContent).not.toContain(SUGGESTION_NOT_FOUND);
  });

  test('keeps a pending suggestion visible when older settled suggestions fill the cap', () => {
    const settled = Array.from({ length: 200 }, (_, n) => {
      const id = `settled${String(n).padStart(3, '0')}`;
      return textRow(id, id, 'closed', {
        resolution: { at: '2026-01-02', by: 'publisher' },
      });
    });
    const pending = textRow('pending', 'fresh', 'new', { at: '2026-01-03' });
    const source = `${settled.map((row) => row.id).join(' ')} fresh`;
    const views = buildSuggestionViews(source, [...settled, pending], 1, 1);
    expect(views.byId.get('pending')?.location.status).toBe('resolved');
    expect(views.paint.some((view) => view.row.id === 'pending')).toBe(true);
    expect(views.pending.map((view) => view.id)).toEqual(['pending']);
    expect(views.overflow).toBe(1);
  });

  test('never paints an ambiguous or lost passage and explains it on the row', () => {
    const views = buildSuggestionViews(
      'same and same',
      [textRow('ambiguous', 'same', 'new'), textRow('lost', 'gone', 'new')],
      1,
      1
    );
    expect(views.paint).toHaveLength(0);
    expect(views.byId.get('ambiguous')?.location.status).toBe('ambiguous');
    expect(views.byId.get('lost')?.location.status).toBe('lost');
    const { root, segments } = mappedRoot(views.source);
    paintSuggestions(asElement(root), segments, views, 'markdown');
    expect(root.querySelectorAll('[data-sg-paint]')).toHaveLength(0);
    expect(
      (
        renderSuggestionCard(
          views.byId.get('lost')!,
          views,
          documentLike
        ) as unknown as TestNode
      ).textContent
    ).toContain(SUGGESTION_NOT_FOUND);
  });
});

describe('safe tracked and applied rendering', () => {
  test('paints hostile replacement and names as literal text, idempotently and without removing comment marks', () => {
    const hostile = '<script>alert(1)</script> **do not interpret**';
    const rows = [
      textRow('mine', 'original', hostile, {
        author: 'me@example.test',
        name: 'Me',
        at: '2026-01-01',
      }),
      textRow('other', 'original', hostile, {
        name: '</span><b>x</b>',
        at: '2026-01-02',
      }),
    ];
    const views = buildSuggestionViews(
      'an original sentence',
      rows,
      1,
      1,
      'ME@EXAMPLE.TEST'
    );
    const { root, segments } = mappedRoot(views.source);
    const holder = root.querySelector('[data-seg]')!;
    const text = holder.childNodes[0]!;
    holder.removeChild(text);
    const ordinaryMark = testDocument.createElement('mark');
    ordinaryMark.className = 'relic-text-mark';
    ordinaryMark.appendChild(text);
    holder.appendChild(ordinaryMark);
    for (let i = 0; i < 2; i++) {
      expect(
        paintSuggestions(asElement(root), segments, views, 'markdown')
      ).toEqual({ ok: true });
      expect(root.querySelectorAll('ins[data-sg]')).toHaveLength(1);
      expect(root.querySelector('ins')?.textContent).toBe(hostile);
      expect(root.querySelectorAll('script')).toHaveLength(0);
      expect(root.querySelectorAll('b')).toHaveLength(0);
      expect(root.querySelector('.sg-chip')?.textContent).toContain(
        '</span><b>x</b>'
      );
      expect(root.querySelector('.relic-text-mark')).toBe(ordinaryMark);
      expect(root.querySelector('.sg-chg')?.classList.contains('is-mine')).toBe(
        true
      );
    }
    const card = renderSuggestionCard(
      views.byId.get('mine')!,
      views,
      documentLike
    ) as unknown as TestNode;
    expect(card.querySelector('ins')?.textContent).toBe(hostile);
    expect(card.querySelectorAll('script')).toHaveLength(0);
    expect(card.querySelectorAll('b')).toHaveLength(0);
    expect(card.textContent).toContain('Source:');
    clearSuggestionPaint(asElement(root));
    expect(root.textContent).toBe(views.source);
    expect(root.querySelector('.relic-text-mark')).toBe(ordinaryMark);
    expect(root.querySelectorAll('[data-sg-paint]')).toHaveLength(0);
  });

  test('renders added and edited links without href while preserving unrelated links', () => {
    const source = 'Read old guide and [other](https://other.test).';
    const views = buildSuggestionViews(
      source,
      [textRow('link', 'old guide', '[new guide](https://example.test)')],
      1,
      1
    );
    const applied = renderAppliedView(
      views,
      'markdown',
      documentLike
    ) as unknown as TestNode;
    const links = applied.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBeNull();
    expect(links[0]?.getAttribute('title')).toBe('Link added by a suggestion');
    expect(links[1]?.getAttribute('href')).toBe('https://other.test');
    expect(applied.querySelector('.sg-applied')?.textContent).toBe('new guide');
    const changedUrl = buildSuggestionViews(
      '[guide](https://safe.test)',
      [textRow('url', 'safe', 'other')],
      1,
      1
    );
    const edited = renderAppliedView(
      changedUrl,
      'markdown',
      documentLike
    ) as unknown as TestNode;
    expect(edited.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(edited.querySelector('a')?.getAttribute('title')).toBe(
      'Link added by a suggestion'
    );
  });

  test('paints a multiline code range across existing syntax elements and renders applied code', () => {
    const source = 'const x = 1;\nnext();\n';
    const views = buildSuggestionViews(
      source,
      [textRow('code', '1;\nnext()', '2;\nfinish()')],
      1,
      1
    );
    const pre = testDocument.createElement('pre');
    pre.appendChild(testDocument.createTextNode('const x = '));
    const token = testDocument.createElement('span');
    token.className = 'tok-num';
    token.textContent = '1';
    pre.appendChild(token);
    pre.appendChild(testDocument.createTextNode(';\nnext();\n'));
    expect(
      paintSuggestions(asElement(pre), codeSegments(source), views, 'code')
    ).toEqual({ ok: true });
    expect(pre.querySelectorAll('del')).toHaveLength(2);
    expect(pre.querySelector('ins')?.textContent).toBe('2;\nfinish()');
    clearSuggestionPaint(asElement(pre));
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector('.tok-num')).toBe(token);
    const applied = renderAppliedView(
      views,
      'code',
      documentLike
    ) as unknown as TestNode;
    expect(applied.querySelector('.code-body')?.textContent).toBe(
      'const x = 2;\nfinish();\n'
    );
    expect(applied.querySelector('.sg-applied')?.textContent).toBe(
      '2;\nfinish()'
    );
  });

  test('marks a deletion that empties the whole document', () => {
    const views = buildSuggestionViews(
      'everything',
      [textRow('deletion', 'everything', '')],
      1,
      1
    );
    for (const kind of ['markdown', 'code'] as const) {
      const applied = renderAppliedView(
        views,
        kind,
        documentLike
      ) as unknown as TestNode;
      expect(
        applied.querySelector('.sg-applied-gap')?.getAttribute('data-sg')
      ).toBe('deletion');
    }
  });

  test('fails closed when a source segment no longer matches the document', () => {
    const views = buildSuggestionViews(
      'alpha beta',
      [textRow('edit', 'alpha', 'omega')],
      1,
      1
    );
    const { root, segments } = mappedRoot(views.source);
    root.querySelector('[data-seg]')!.textContent = 'different';
    expect(
      paintSuggestions(asElement(root), segments, views, 'markdown')
    ).toEqual({ ok: false, reason: SUGGESTION_LAYOUT_MISMATCH });
    expect(root.querySelectorAll('[data-sg-paint]')).toHaveLength(0);
  });
});
