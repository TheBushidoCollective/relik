import { describe, expect, test } from 'bun:test';
import {
  annotateBlocks,
  collectBlocks,
  DOCUMENT_HIGHLIGHT_CSS,
  installHighlightCss,
} from '../src/document-blocks.ts';
import {
  type DocumentBlockSnapshot,
  isDocumentBlocksMessage,
  MAX_DOCUMENT_BLOCK_BYTES,
  MAX_DOCUMENT_BLOCKS,
  MAX_DOCUMENT_PARTS,
} from '../src/frame-document-protocol.ts';
import { type Anchor, HIGHLIGHT_CSS, type Mark } from '../src/rendered-tree.ts';

/** A stand-in for a DOM node, with the members document-blocks reads and writes. */
interface Stub {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly nodeValue?: string;
  readonly attributes: Map<string, string>;
  readonly childNodes: Stub[];
  parentNode: Stub | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function el(
  tag: string,
  attributes: Record<string, string> = {},
  children: Stub[] = []
): Stub {
  const attrs = new Map(Object.entries(attributes));
  const node: Stub = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: attrs,
    childNodes: children,
    parentNode: null,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => {
      attrs.set(name, value);
    },
    removeAttribute: (name) => {
      attrs.delete(name);
    },
  };
  for (const child of children) child.parentNode = node;
  return node;
}

function text(value: string): Stub {
  return {
    nodeType: 3,
    nodeValue: value,
    attributes: new Map(),
    childNodes: [],
    parentNode: null,
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
  };
}

/**
 * A DOCX page as docx-preview lays it out: the frame root, the wrapper, and a
 * page with its header, body, footnotes when there are any, and footer.
 */
function docxPage(body: Stub[], notes: Stub[] = []): Stub {
  const page = [
    el('header', {}, [el('p', {}, [text('Draft')])]),
    el('article', {}, body),
    ...(notes.length === 0 ? [] : [el('ol', {}, notes)]),
    el('footer', {}, [el('p', {}, [text('Page 1')])]),
  ];
  return el('div', { id: 'relic-document' }, [
    el('div', { class: 'docx-wrapper' }, [
      el('section', { class: 'docx' }, page),
    ]),
  ]);
}

/** The element that a snapshot's block sits on, typed as the snapshot types it. */
const elementAt = (snapshot: DocumentBlockSnapshot, index: number) =>
  snapshot.elements[index];

function mustRead(root: Stub, format: 'docx' | 'epub'): DocumentBlockSnapshot {
  const snapshot = collectBlocks(root, format);
  if (snapshot === null) throw new Error('expected a readable snapshot');
  return snapshot;
}

describe('collectBlocks on a DOCX page', () => {
  const image = el('img', { src: 'data:image/png;base64,AAAA' });
  const mixed = el('p', {}, [text('Before '), image, text(' after')]);
  const loose = el('div', {}, [
    text('Loose words'),
    el('p', {}, [text('Inside div')]),
  ]);
  const cells = el('table', {}, [
    el('tbody', {}, [
      el('tr', {}, [
        el('td', {}, [el('p', {}, [text('Cell one')])]),
        el('td', {}, [el('p', {}, [text('Cell two')])]),
      ]),
    ]),
  ]);
  const root = docxPage(
    [
      el('p', {}, [text('Opening paragraph')]),
      cells,
      el('p', {}, [text('   \n  ')]),
      mixed,
      loose,
    ],
    [el('li', {}, [el('p', {}, [text('Footnote text')])])]
  );

  test('reads body blocks and leaves out the header and footer', () => {
    const snapshot = mustRead(root, 'docx');
    expect(snapshot.blocks).toEqual([
      { kind: 'paragraph', text: 'Opening paragraph', part: 0 },
      { kind: 'table-cell', text: 'Cell one', part: 0 },
      { kind: 'table-cell', text: 'Cell two', part: 0 },
      { kind: 'text', text: 'Before', part: 0 },
      { kind: 'image', text: '', part: 0 },
      { kind: 'text', text: 'after', part: 0 },
      { kind: 'text', text: 'Loose words', part: 0 },
      { kind: 'paragraph', text: 'Inside div', part: 0 },
      { kind: 'list-item', text: 'Footnote text', part: 0 },
    ]);
    expect(
      isDocumentBlocksMessage({
        type: 'relic:document-blocks',
        blocks: snapshot.blocks,
      })
    ).toBe(true);
  });

  test('maps an image to its own element and mixed text to its container', () => {
    const snapshot = mustRead(root, 'docx');
    expect(elementAt(snapshot, 3)).toBe(mixed as unknown as Element);
    expect(elementAt(snapshot, 4)).toBe(image as unknown as Element);
    expect(elementAt(snapshot, 5)).toBe(mixed as unknown as Element);
    expect(elementAt(snapshot, 6)).toBe(loose as unknown as Element);
  });

  test('refuses a document with no page wrapper', () => {
    const bare = el('div', {}, [
      el('section', { class: 'docx' }, [
        el('article', {}, [el('p', {}, [text('x')])]),
      ]),
    ]);
    expect(collectBlocks(bare, 'docx')).toBeNull();
  });
});

describe('collectBlocks on an EPUB', () => {
  const root = el('div', { id: 'relic-document' }, [
    el('p', { role: 'status' }, [
      text('Some images exceed the reader size limit.'),
    ]),
    el('article', { 'data-epub-chapter': '0' }, [
      el('h1', {}, [text('One')]),
      el('p', {}, [text('Hello')]),
    ]),
    el('section', {}, [el('p', {}, [text('Stray section')])]),
    el('article', { 'data-epub-chapter': '2' }, [el('p', {}, [text('Later')])]),
    el('article', {}, [el('p', {}, [text('Unnumbered')])]),
    el('div', { class: 'chrome' }, [el('p', {}, [text('Reader chrome')])]),
  ]);

  test('reads only numbered chapter articles, with part from data-epub-chapter', () => {
    const snapshot = mustRead(root, 'epub');
    expect(snapshot.blocks).toEqual([
      { kind: 'heading', text: 'One', part: 0 },
      { kind: 'paragraph', text: 'Hello', part: 0 },
      { kind: 'paragraph', text: 'Later', part: 2 },
    ]);
    expect(
      isDocumentBlocksMessage({
        type: 'relic:document-blocks',
        blocks: snapshot.blocks,
      })
    ).toBe(true);
  });

  test('refuses a chapter part that is not a render index', () => {
    for (const part of ['2000', 'abc', '-1', '01', '']) {
      const bad = el('div', {}, [
        el('article', { 'data-epub-chapter': part }, [
          el('p', {}, [text('x')]),
        ]),
      ]);
      expect(collectBlocks(bad, 'epub')).toBeNull();
    }
    const last = el('div', {}, [
      el('article', { 'data-epub-chapter': String(MAX_DOCUMENT_PARTS - 1) }, [
        el('p', {}, [text('x')]),
      ]),
    ]);
    expect(collectBlocks(last, 'epub')?.blocks[0]?.part).toBe(
      MAX_DOCUMENT_PARTS - 1
    );
  });

  test('refuses a document with no chapter', () => {
    expect(
      collectBlocks(el('div', {}, [el('p', {}, [text('x')])]), 'epub')
    ).toBeNull();
  });
});

describe('collectBlocks budgets', () => {
  test('a full block budget is read and one more block refuses the whole snapshot', () => {
    const paragraphs = (count: number) =>
      Array.from({ length: count }, (_, i) => el('p', {}, [text(`p${i}`)]));
    const full = docxPage(paragraphs(MAX_DOCUMENT_BLOCKS));
    expect(mustRead(full, 'docx').blocks).toHaveLength(MAX_DOCUMENT_BLOCKS);
    expect(
      collectBlocks(docxPage(paragraphs(MAX_DOCUMENT_BLOCKS + 1)), 'docx')
    ).toBeNull();
  });

  test('a full text budget in UTF-8 bytes is read and one byte more refuses it', () => {
    const ascii = 'a'.repeat(MAX_DOCUMENT_BLOCK_BYTES);
    const fits = mustRead(docxPage([el('p', {}, [text(ascii)])]), 'docx');
    expect(
      isDocumentBlocksMessage({
        type: 'relic:document-blocks',
        blocks: fits.blocks,
      })
    ).toBe(true);
    expect(
      collectBlocks(docxPage([el('p', {}, [text(`${ascii}a`)])]), 'docx')
    ).toBeNull();

    // Two-byte characters count twice: half as many characters fill the budget.
    const accented = 'é'.repeat(MAX_DOCUMENT_BLOCK_BYTES / 2);
    expect(
      isDocumentBlocksMessage({
        type: 'relic:document-blocks',
        blocks: mustRead(docxPage([el('p', {}, [text(accented)])]), 'docx')
          .blocks,
      })
    ).toBe(true);
    expect(
      collectBlocks(docxPage([el('p', {}, [text(`${accented}é`)])]), 'docx')
    ).toBeNull();
  });

  test('the text budget is shared across every block of a version', () => {
    const half = 'a'.repeat(MAX_DOCUMENT_BLOCK_BYTES / 2);
    const root = docxPage([
      el('p', {}, [text(half)]),
      el('p', {}, [text(`${half}b`)]),
    ]);
    expect(collectBlocks(root, 'docx')).toBeNull();
  });

  test('nesting past the walk limit refuses the document', () => {
    const nest = (depth: number): Stub => {
      let node = el('p', {}, [text('deep')]);
      for (let i = 0; i < depth; i++) node = el('div', {}, [node]);
      return node;
    };
    expect(collectBlocks(docxPage([nest(200)]), 'docx')).not.toBeNull();
    expect(collectBlocks(docxPage([nest(300)]), 'docx')).toBeNull();
  });
});

describe('annotateBlocks', () => {
  /**
   * Three paragraphs in a DOCX page. The second carries authored mark attributes
   * and a nested authored id, and an aside outside the page carries another.
   */
  function fixture(): {
    snapshot: DocumentBlockSnapshot;
    blocks: readonly Stub[];
    aside: Stub;
    nested: Stub;
  } {
    const nested = el('span', { 'data-relic-change-id': 'c5' }, [text('B')]);
    const blocks = [
      el('p', {}, [text('A')]),
      el('p', { 'data-relic-sync-id': 'd77', 'data-relic-diff': 'added' }, [
        nested,
      ]),
      el('p', {}, [text('C')]),
    ];
    const page = docxPage(blocks);
    const aside = el('aside', {
      'data-relic-diff': 'added',
      'data-relic-sync-id': 'd9',
    });
    const body = el('body', {}, [page, aside]);
    el('html', {}, [body]);
    const snapshot = mustRead(page, 'docx');
    return { snapshot, blocks, aside, nested };
  }

  test('clears authored mark attributes across the whole tree before marking', () => {
    const { snapshot, blocks, aside, nested } = fixture();
    const marks: Mark[] = [
      { path: [0], kind: 'changed', syncId: 'd1', changeId: 'c1' },
    ];
    expect(annotateBlocks(snapshot, marks, [])).toBe(1);
    expect(blocks[0]!.attributes.get('data-relic-diff')).toBe('changed');
    expect(blocks[0]!.attributes.get('data-relic-sync-id')).toBe('d1');
    expect(blocks[0]!.attributes.get('data-relic-change-id')).toBe('c1');
    expect([...blocks[1]!.attributes.keys()]).toEqual([]);
    expect([...nested.attributes.keys()]).toEqual([]);
    expect([...aside.attributes.keys()]).toEqual([]);
  });

  test('ignores a path that is out of range, names more than one block, or has an unknown kind', () => {
    const { snapshot, blocks } = fixture();
    const marks = [
      { path: [3], kind: 'added' },
      { path: [0, 0], kind: 'added' },
      { path: [], kind: 'added' },
      { path: [-1], kind: 'added' },
      { path: [2], kind: 'bogus' },
      { path: [1], kind: 'removed' },
    ] as unknown as Mark[];
    expect(annotateBlocks(snapshot, marks, [])).toBe(1);
    expect(blocks[1]!.attributes.get('data-relic-diff')).toBe('removed');
    expect([...blocks[0]!.attributes.keys()]).toEqual([]);
    expect([...blocks[2]!.attributes.keys()]).toEqual([]);
  });

  test('an anchor skips a block that is already marked, and an out-of-range one', () => {
    const { snapshot, blocks } = fixture();
    const anchors: Anchor[] = [
      { path: [0], syncId: 'a1' },
      { path: [2], syncId: 'a2' },
      { path: [5], syncId: 'a3' },
    ];
    annotateBlocks(snapshot, [{ path: [0], kind: 'added' }], anchors);
    expect([...blocks[0]!.attributes.keys()]).toEqual(['data-relic-diff']);
    expect(blocks[2]!.attributes.get('data-relic-sync-id')).toBe('a2');
    expect(blocks[2]!.attributes.has('data-relic-diff')).toBe(false);
  });
});

describe('installHighlightCss', () => {
  test('appends the document rules after the tree rules', () => {
    const appended: { textContent: string }[] = [];
    const doc = {
      createElement: () => ({ textContent: '' }),
      head: { append: (node: { textContent: string }) => appended.push(node) },
    } as unknown as Pick<Document, 'createElement' | 'head'>;
    installHighlightCss(doc);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.textContent).toBe(
      HIGHLIGHT_CSS + DOCUMENT_HIGHLIGHT_CSS
    );
    expect(DOCUMENT_HIGHLIGHT_CSS).toContain('dashed');
    expect(DOCUMENT_HIGHLIGHT_CSS).toContain('line-through');
    expect(DOCUMENT_HIGHLIGHT_CSS).toContain('double');
  });
});
