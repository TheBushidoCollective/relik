import { describe, expect, test } from 'bun:test';
import {
  diffTrees,
  MAX_LISTED_CHANGES,
  type RenderedChange,
} from '../src/domdiff.ts';
import {
  applyAnchors,
  applyMarks,
  captureTree as captureBoundedTree,
  isAnnotateMessage,
  isTreeMessage,
  MAX_TREE_BYTES,
  MAX_TREE_NODES,
  type Mark,
  type TreeNode,
} from '../src/rendered-tree.ts';

function captureTree(root: unknown): TreeNode {
  const tree = captureBoundedTree(root);
  if (tree === null) throw new Error('fixture exceeds the tree budget');
  return tree;
}

function element(tag: string, ...children: TreeNode[]): TreeNode {
  return { tag, text: '', attrs: [], children };
}

function attributed(
  tag: string,
  attrs: readonly (readonly [string, string])[],
  ...children: TreeNode[]
): TreeNode {
  return { tag, text: '', attrs, children };
}

function text(value: string): TreeNode {
  return { tag: '#text', text: value, attrs: [], children: [] };
}

/**
 * A DOM stand-in, because Bun tests run without a DOM and `captureTree` is
 * written against the shape of a node rather than against a library.
 */
class NodeStub {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: NodeStub[] = [];
  readonly attrs: Record<string, string> = {};
  readonly marks: string[] = [];

  constructor(tag: string, children: NodeStub[] = []) {
    this.tagName = tag.toUpperCase();
    this.childNodes = children;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    if (name === 'data-relic-diff') this.marks.push(value);
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
}

class TextStub {
  readonly nodeType = 3;
  readonly childNodes: never[] = [];
  constructor(readonly nodeValue: string) {}
}

describe('capturing what a document rendered', () => {
  test('collapses whitespace and drops whitespace-only text', () => {
    // A visual comparison must not notice reindentation, because reindenting
    // moves no pixel.
    const loose = new NodeStub('p', [
      new TextStub('\n   Hello\n   world\n '),
    ] as unknown as NodeStub[]);
    const tight = new NodeStub('p', [
      new TextStub('Hello world'),
    ] as unknown as NodeStub[]);

    expect(diffTrees(captureTree(loose), captureTree(tight)).changed).toBe(
      false
    );
  });

  test('drops the tags whose contents are never rendered', () => {
    const withScript = new NodeStub('body', [
      new NodeStub('script', [new TextStub('fetch("/one")')] as never),
      new NodeStub('p', [new TextStub('same')] as never),
    ]);
    const withOtherScript = new NodeStub('body', [
      new NodeStub('script', [new TextStub('fetch("/two")')] as never),
      new NodeStub('p', [new TextStub('same')] as never),
    ]);

    const result = diffTrees(
      captureTree(withScript),
      captureTree(withOtherScript)
    );
    expect(result.changed).toBe(false);
    expect(result.summary).toBe(
      'No changes. These versions render identically.'
    );
  });

  test('reads only the attributes a reader can see the effect of', () => {
    const node = new NodeStub('img');
    node.attrs['src'] = 'blob:one';
    node.attrs['data-internal'] = 'ignored';
    node.attrs['alt'] = 'a chart';

    const captured = captureTree(node);
    expect(captured.attrs).toEqual([
      ['alt', 'a chart'],
      ['src', 'blob:one'],
    ]);
  });

  test('reports an unavailable snapshot when the node budget is exceeded', () => {
    const root = new NodeStub(
      'div',
      Array.from({ length: MAX_TREE_NODES - 1 }, () => new NodeStub('p'))
    );
    expect(captureBoundedTree(root)?.children).toHaveLength(MAX_TREE_NODES - 1);
    root.childNodes.push(new NodeStub('p'));
    expect(captureBoundedTree(root)).toBeNull();
  });

  test('uses one UTF-8 budget for tags, text and attributes without clipping', () => {
    // The fields consume 14 bytes; the final three characters use nine.
    const value = 'a'.repeat(MAX_TREE_BYTES - 23) + 'é記😀';
    const root = new NodeStub('p', [new TextStub(value)] as never);
    root.attrs['alt'] = 'Cover';
    const tree = captureBoundedTree(root);
    expect(tree).not.toBeNull();
    expect(tree?.children[0]?.text).toBe(value);
    expect(isTreeMessage({ type: 'relic:tree', tree })).toBe(true);

    root.attrs['alt'] = 'Cover!';
    expect(captureBoundedTree(root)).toBeNull();
    const tooLarge = {
      tag: 'p',
      text: '',
      attrs: [['alt', 'Cover!']],
      children: [{ tag: '#text', text: value, attrs: [], children: [] }],
    };
    expect(isTreeMessage({ type: 'relic:tree', tree: tooLarge })).toBe(false);
    expect(isTreeMessage({ type: 'relic:tree', tree: null })).toBe(true);
  });
});

/** A change row without its stop index, for the tests about its wording. */
function described(change: RenderedChange | undefined): unknown {
  if (change === undefined) return undefined;
  const { jumpIndex: _jumpIndex, ...rest } = change;
  return rest;
}

/**
 * A mark without its stop name.
 *
 * These tests are about which nodes got marked and which pairs the diff
 * agreed on. Addressing for the jump control is asserted on its own, below,
 * so it does not have to be restated in every one of them.
 */
function placement(marks: readonly Mark[]): unknown[] {
  return marks.map(({ path, kind, syncId }) => ({
    path,
    kind,
    ...(syncId === undefined ? {} : { syncId }),
  }));
}

describe('anchoring the panes on content that did not change', () => {
  test('matched blocks are paired, so there is something to align on', () => {
    const before = element(
      'body',
      element('p', text('one')),
      element('p', text('two'))
    );
    const after = element(
      'body',
      element('p', text('inserted at the top')),
      element('p', text('one')),
      element('p', text('two'))
    );

    const result = diffTrees(before, after);
    // The reader's complaint in one assertion: a version that only inserts
    // at the top used to leave the rest of the document with no reference
    // point at all, so from the second screen down the panes were aligned
    // by page fraction and off by the height of the insertion.
    expect(result.beforeAnchors.length).toBeGreaterThan(0);
    expect(result.beforeAnchors.map((a) => a.syncId)).toEqual(
      result.afterAnchors.map((a) => a.syncId)
    );
  });

  test('the same unchanged paragraph is one id on both sides', () => {
    const before = element('body', element('p', text('one')));
    const after = element('body', element('p', text('one')));
    const result = diffTrees(before, after);
    const [beforeAnchor] = result.beforeAnchors;
    const [afterAnchor] = result.afterAnchors;
    expect(beforeAnchor?.syncId).toBe(afterAnchor?.syncId as string);
    // Different paths, because the two documents are not the same object.
    expect(beforeAnchor?.path).toEqual([0]);
    expect(afterAnchor?.path).toEqual([0]);
  });

  test('anchors are named apart from changes, so neither can claim the other', () => {
    const before = element(
      'body',
      element('p', text('one')),
      element('p', text('keep'))
    );
    const after = element(
      'body',
      element('p', text('ONE')),
      element('p', text('keep'))
    );
    const result = diffTrees(before, after);
    for (const anchor of result.afterAnchors) {
      expect(anchor.syncId.startsWith('a')).toBe(true);
    }
    for (const mark of result.addedMarks) {
      if (mark.syncId !== undefined)
        expect(mark.syncId.startsWith('d')).toBe(true);
    }
  });

  test('inline runs are not anchored, because a pane aligns on blocks', () => {
    const before = element('body', element('p', element('em', text('same'))));
    const after = element('body', element('p', element('em', text('same'))));
    const result = diffTrees(before, after);
    expect(result.afterAnchors.map((a) => a.path)).toEqual([[0]]);
  });

  test('a change keeps its own id when a container is anchored around it', () => {
    const root = new NodeStub('BODY', [new NodeStub('P'), new NodeStub('P')]);
    applyMarks(root, [{ path: [1], kind: 'changed', syncId: 'd3' }]);
    applyAnchors(root, [
      { path: [0], syncId: 'a0' },
      { path: [1], syncId: 'a1' },
    ]);
    // The changed node keeps the id the two panes agreed on for the change.
    // Overwriting it would align them on the container instead, which is
    // the thing the change is inside rather than the change.
    expect(root.childNodes[1]?.getAttribute('data-relic-sync-id')).toBe('d3');
    expect(root.childNodes[0]?.getAttribute('data-relic-sync-id')).toBe('a0');
  });

  test('an anchor wearing a change name is refused on the wire', () => {
    expect(
      isAnnotateMessage({
        type: 'relic:annotate',
        marks: [],
        anchors: [{ path: [0], syncId: 'a0' }],
      })
    ).toBe(true);
    expect(
      isAnnotateMessage({
        type: 'relic:annotate',
        marks: [],
        anchors: [{ path: [0], syncId: 'd0' }],
      })
    ).toBe(false);
  });
});

describe('comparing two rendered documents', () => {
  test('identical trees report rendering identically, not an empty result', () => {
    const tree = element('body', element('p', text('same')));
    const result = diffTrees(tree, structuredClone(tree));

    expect(result.changed).toBe(false);
    expect(result.summary).toBe(
      'No changes. These versions render identically.'
    );
    expect(placement(result.addedMarks)).toEqual([]);
    expect(placement(result.removedMarks)).toEqual([]);
    expect(result.changes.map(described)).toEqual([]);
  });

  test('an added paragraph marks the current side and not the historical one', () => {
    const before = element('body', element('p', text('one')));
    const after = element(
      'body',
      element('p', text('one')),
      element('p', text('two'))
    );

    const result = diffTrees(before, after);
    expect(result.changed).toBe(true);
    // One thing a reader would say was added, not two tree nodes. The
    // paragraph and its text are one change, and the summary sits above a
    // list and a navigator that both count it once.
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(0);
    expect(placement(result.addedMarks)).toEqual([
      { path: [1], kind: 'added' },
    ]);
    expect(placement(result.removedMarks)).toEqual([]);
    expect(result.summary).toBe('1 added.');
    expect(result.changes).toHaveLength(1);
    expect(described(result.changes[0])).toEqual({
      kind: 'added',
      label: 'paragraph',
      before: '',
      after: 'two',
    });
  });

  test('a removed paragraph is the mirror of an added one', () => {
    const before = element(
      'body',
      element('p', text('one')),
      element('p', text('two'))
    );
    const after = element('body', element('p', text('one')));

    const result = diffTrees(before, after);
    expect(result.removals).toBe(1);
    expect(result.additions).toBe(0);
    expect(result.summary).toBe('1 removed.');
    expect(placement(result.removedMarks)).toEqual([
      { path: [1], kind: 'removed' },
    ]);
    expect(placement(result.addedMarks)).toEqual([]);
    expect(result.changes[0]?.kind).toBe('removed');
  });

  test('changed heading text marks both sides and names the heading', () => {
    const before = element('body', element('h1', text('Q3 report')));
    const after = element('body', element('h1', text('Q4 report')));

    const result = diffTrees(before, after);
    expect(result.changed).toBe(true);
    // The mark lands on the element, because an attribute cannot be set on a
    // text node.
    expect(placement(result.removedMarks)).toEqual([
      { path: [0], kind: 'changed', syncId: 'd0' },
    ]);
    expect(placement(result.addedMarks)).toEqual([
      { path: [0], kind: 'changed', syncId: 'd0' },
    ]);
    expect(result.summary).toBe('1 changed.');
    expect(result.changes.map(described)).toEqual([
      {
        kind: 'changed',
        label: 'heading',
        before: 'Q3 report',
        after: 'Q4 report',
      },
    ]);
  });

  test('a changed image target is a change, because a reader sees it', () => {
    const before = element('body', attributed('img', [['src', 'blob:one']]));
    const after = element('body', attributed('img', [['src', 'blob:two']]));

    const result = diffTrees(before, after);
    expect(result.changed).toBe(true);
    expect(described(result.changes[0])).toEqual({
      kind: 'changed',
      label: 'image',
      before: 'src=blob:one',
      after: 'src=blob:two',
    });
  });

  test('a change deep inside a section is not a whole replaced section', () => {
    // The child key is shallow on purpose: folding descendants into it would
    // turn one changed word into a removed section and an added one.
    const before = element(
      'section',
      element('h2', text('Detail')),
      element('p', text('before'))
    );
    const after = element(
      'section',
      element('h2', text('Detail')),
      element('p', text('after'))
    );

    const result = diffTrees(before, after);
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
    expect(placement(result.addedMarks)).toEqual([
      { path: [1], kind: 'changed', syncId: 'd0' },
    ]);
  });

  test('paired changed nodes carry the same landmark id and one-sided changes do not', () => {
    const before = element(
      'body',
      element('p', text('before')),
      element('p', text('kept'))
    );
    const after = element(
      'body',
      element('p', text('after')),
      element('p', text('kept')),
      element('p', text('added only'))
    );

    const result = diffTrees(before, after);
    const changedBefore = result.removedMarks.find(
      (mark) => mark.kind === 'changed'
    );
    const changedAfter = result.addedMarks.find(
      (mark) => mark.kind === 'changed'
    );
    const addedOnly = result.addedMarks.find((mark) => mark.kind === 'added');

    expect(changedBefore?.syncId).toBeDefined();
    expect(changedAfter?.syncId).toBe(changedBefore?.syncId);
    expect(addedOnly?.syncId).toBeUndefined();
  });

  test('the change list stops while the counts stay exact', () => {
    const many = (label: string): TreeNode =>
      element(
        'body',
        ...Array.from({ length: MAX_LISTED_CHANGES + 20 }, (_value, index) =>
          element('p', text(`${label} ${index}`))
        )
      );

    const result = diffTrees(many('before'), many('after'));
    expect(result.changes).toHaveLength(MAX_LISTED_CHANGES);
    expect(result.summary).toBe(`${MAX_LISTED_CHANGES + 20} changed.`);
  });
});

describe('marking a document from a path', () => {
  test('applies a mark to the addressed element', () => {
    const child = new NodeStub('p');
    const root = new NodeStub('body', [new NodeStub('h1'), child]);

    expect(applyMarks(root, [{ path: [1], kind: 'added', syncId: 'd3' }])).toBe(
      1
    );
    expect(child.marks).toEqual(['added']);
    expect(child.attrs['data-relic-sync-id']).toBe('d3');
  });

  test('clears authored landmark ids before applying the diff-owned ids', () => {
    const unmarked = new NodeStub('p');
    const changed = new NodeStub('p');
    unmarked.attrs['data-relic-sync-id'] = 'd0';
    changed.attrs['data-relic-sync-id'] = 'd999';
    const root = new NodeStub('body', [unmarked, changed]);

    applyMarks(root, [{ path: [1], kind: 'changed', syncId: 'd4' }]);

    expect(unmarked.attrs['data-relic-sync-id']).toBeUndefined();
    expect(changed.attrs['data-relic-sync-id']).toBe('d4');
  });

  test('skips a path that no longer resolves instead of throwing', () => {
    // The document may have moved under the parent, and a stale path must not
    // take the frame down.
    const root = new NodeStub('body', [new NodeStub('p')]);

    expect(applyMarks(root, [{ path: [9, 9], kind: 'removed' }])).toBe(0);
  });

  test('marks the root when the path is empty', () => {
    const root = new NodeStub('body');

    expect(applyMarks(root, [{ path: [], kind: 'changed' }])).toBe(1);
    expect(root.marks).toEqual(['changed']);
  });

  test('a path lands on the node the capture meant, past dropped children', () => {
    // Found in a browser, not here: the capture drops whitespace text and
    // unrendered tags, so a path resolved against raw childNodes landed on a
    // different node than the diff addressed. Both sides now walk the same
    // filtered index space, and this pretty-printed shape is what proves it.
    const target = new NodeStub('p', [
      new TextStub('after') as unknown as NodeStub,
    ]);
    const pretty = (): NodeStub =>
      new NodeStub('body', [
        new TextStub('\n  ') as unknown as NodeStub,
        new NodeStub('style', [
          new TextStub('p { color: red }') as unknown as NodeStub,
        ]),
        new TextStub('\n  ') as unknown as NodeStub,
        new NodeStub('h1', [new TextStub('Title') as unknown as NodeStub]),
        new TextStub('\n  ') as unknown as NodeStub,
        target,
        new TextStub('\n') as unknown as NodeStub,
      ]);

    const before = new NodeStub('body', [
      new NodeStub('h1', [new TextStub('Title') as unknown as NodeStub]),
      new NodeStub('p', [new TextStub('before') as unknown as NodeStub]),
    ]);
    const live = pretty();

    const diff = diffTrees(captureTree(before), captureTree(live));
    expect(diff.changed).toBe(true);
    expect(applyMarks(live, diff.addedMarks)).toBe(diff.addedMarks.length);
    // The changed paragraph, not the heading and not a whitespace node.
    expect(target.marks).toEqual(['changed']);
  });
});

describe('validating what crosses the frame boundary', () => {
  test('accepts a well-formed annotate message', () => {
    expect(
      isAnnotateMessage({
        type: 'relic:annotate',
        marks: [
          { path: [0, 2], kind: 'added' },
          { path: [], kind: 'changed', syncId: 'd0' },
        ],
      })
    ).toBe(true);
  });

  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['a missing marks array', { type: 'relic:annotate' }],
    ['a non-array marks', { type: 'relic:annotate', marks: 'all' }],
    [
      'a negative path index',
      { type: 'relic:annotate', marks: [{ path: [-1], kind: 'added' }] },
    ],
    [
      'a fractional path index',
      { type: 'relic:annotate', marks: [{ path: [1.5], kind: 'added' }] },
    ],
    [
      'a string path index',
      { type: 'relic:annotate', marks: [{ path: ['1'], kind: 'added' }] },
    ],
    [
      'an unknown kind',
      { type: 'relic:annotate', marks: [{ path: [0], kind: 'replaced' }] },
    ],
    [
      'a kind carrying markup',
      {
        type: 'relic:annotate',
        marks: [{ path: [0], kind: '<script>alert(1)</script>' }],
      },
    ],
    [
      'an arbitrary landmark id',
      {
        type: 'relic:annotate',
        marks: [{ path: [0], kind: 'changed', syncId: '<script>' }],
      },
    ],
    [
      'a non-string landmark id',
      {
        type: 'relic:annotate',
        marks: [{ path: [0], kind: 'changed', syncId: 7 }],
      },
    ],
    ['the wrong type', { type: 'relic:render', marks: [] }],
    ['nothing at all', null],
  ];

  for (const [what, message] of rejected) {
    test(`rejects ${what}`, () => {
      expect(isAnnotateMessage(message)).toBe(false);
    });
  }

  test('rejects the whole message when only the second mark is malformed', () => {
    // Salvaging the valid half would invent an intent nobody sent.
    expect(
      isAnnotateMessage({
        type: 'relic:annotate',
        marks: [
          { path: [0], kind: 'added' },
          { path: [0], kind: 'nope' },
        ],
      })
    ).toBe(false);
  });

  test('is strict about a reported tree as well', () => {
    expect(
      isTreeMessage({
        type: 'relic:tree',
        tree: { tag: 'p', text: '', attrs: [], children: [] },
      })
    ).toBe(true);
    expect(isTreeMessage({ type: 'relic:tree', tree: '<p>hi</p>' })).toBe(
      false
    );
    expect(
      isTreeMessage({
        type: 'relic:tree',
        tree: { tag: 'p', text: '', attrs: [['src']], children: [] },
      })
    ).toBe(false);
    expect(
      isTreeMessage({
        type: 'relic:tree',
        tree: { tag: 'p', text: '', attrs: [], children: [{ tag: 1 }] },
      })
    ).toBe(false);
  });
});
