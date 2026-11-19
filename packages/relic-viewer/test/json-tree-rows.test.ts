import { describe, expect, test } from 'bun:test';
import { type JsonTree, parseJsonTree } from '@relic/format';
import {
  breadcrumbFor,
  findQuote,
  JsonTreeState,
  keyLabel,
  nodeForAnchor,
  noticeFor,
  summaryText,
  TREE_VALUE_CUT_CHARS,
  valueLabel,
  valuePreview,
  visibleText,
} from '../src/json-tree-rows.ts';

function treeOf(text: string): JsonTree {
  const result = parseJsonTree(text);
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.tree;
}

function visibleLabels(state: JsonTreeState): string[] {
  const labels: string[] = [];
  for (let row = 0; row < state.rowCount; row += 1) {
    labels.push(keyLabel(state.tree, state.rowAt(row)));
  }
  return labels;
}

describe('visibleText: what the reader sees', () => {
  test('bidi overrides, isolates and controls become visible escapes', () => {
    expect(visibleText('a\u202eb\u2066c\u0007d\u009f')).toBe(
      'a\\u202eb\\u2066c\\u0007d\\u009f'
    );
    expect(visibleText('plain é 😀')).toBe('plain é 😀');
  });

  test('markup is text, so it is only ever shown as written', () => {
    expect(visibleText('<img src=x onerror=alert(1)>')).toBe(
      '<img src=x onerror=alert(1)>'
    );
  });
});

describe('valuePreview: long strings are cut and say so', () => {
  test('a value over the cut is shortened with an ellipsis', () => {
    const literal = `"${'a'.repeat(TREE_VALUE_CUT_CHARS + 10)}"`;
    expect(valuePreview(literal)).toBe(
      `"${'a'.repeat(TREE_VALUE_CUT_CHARS - 1)}…`
    );
  });

  test('a cut never leaves half a surrogate pair', () => {
    const literal = `"${'😀'.repeat(400)}"`;
    const preview = valuePreview(literal);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.includes('\ud83d…')).toBe(false);
  });
});

describe('labels and summary', () => {
  test('a container shows its child count, a key shows as written', () => {
    const tree = treeOf('{"a/b":[1,2],"c":{}}');
    expect(keyLabel(tree, tree.children(0)[0]!)).toBe('"a/b"');
    expect(valueLabel(tree, tree.children(0)[0]!)).toBe('[2]');
    expect(valueLabel(tree, tree.children(0)[1]!)).toBe('{0}');
  });

  test('an array element is labelled by its index, the root by $', () => {
    const tree = treeOf('[10,20]');
    expect(keyLabel(tree, tree.children(0)[1]!)).toBe('1');
    expect(keyLabel(tree, 0)).toBe('$');
  });

  test('the summary counts nodes, depth and duplicate keys', () => {
    expect(summaryText(treeOf('{"a":1,"a":{"b":[]}}'))).toBe(
      '4 nodes · depth 2 · 1 duplicate key'
    );
  });
});

describe('notices name the reason and the position', () => {
  test('a syntax error gives its line, column and reason', () => {
    const result = parseJsonTree('{\n  "a": 1\n  "b": 2\n}');
    if (result.ok) throw new Error('expected a refusal');
    expect(noticeFor(result.failure)).toBe(
      'This file could not be read as JSON, so its text is shown. Line 3, column 3: expected a comma or a closing brace.'
    );
  });

  test('deep nesting gets its own notice', () => {
    const deep = parseJsonTree('['.repeat(1001));
    if (deep.ok) throw new Error('expected a refusal');
    expect(noticeFor(deep.failure)).toBe(
      'This file is nested too deeply to show as a tree, so its text is shown.'
    );
  });
});

describe('the visible rows follow the default expansion', () => {
  test('the root, its children and the first object inside an object open', () => {
    const state = new JsonTreeState(
      treeOf(
        '{"schema":"s","device":{"id":1,"retry":{"n":1}},"crews":[{"id":2}]}'
      )
    );
    expect(visibleLabels(state)).toEqual([
      '$',
      '"schema"',
      '"device"',
      '"id"',
      '"retry"',
      '"n"',
      '"crews"',
      '0',
    ]);
  });

  test('an object inside an array starts closed, as the mock draws it', () => {
    const state = new JsonTreeState(treeOf('{"crews":[{"id":2}]}'));
    expect(visibleLabels(state)).toEqual(['$', '"crews"', '0']);
  });

  test('toggle opens and closes a branch, and does nothing for a leaf', () => {
    const tree = treeOf('{"a":{"b":{"c":[1,2]}}}');
    const state = new JsonTreeState(tree);
    const array = tree.resolve('/a/b/c');
    expect(state.rowCount).toBe(4);
    state.toggle(array);
    expect(state.rowCount).toBe(6);
    state.toggle(array);
    expect(state.rowCount).toBe(4);
    state.toggle(tree.resolve('/a/b/c/0'));
    expect(state.rowCount).toBe(4);
  });

  test('expand all opens everything, and is refused above the node limit', () => {
    const tree = treeOf('{"a":{"b":{"c":[1]}}}');
    const state = new JsonTreeState(tree);
    expect(state.expandAll()).toBe(true);
    expect(state.rowCount).toBe(tree.size);
    state.collapseAll();
    expect(state.rowCount).toBe(2);
    const big = treeOf(`[${'0,'.repeat(10_000)}0]`);
    expect(new JsonTreeState(big).expandAll()).toBe(false);
  });

  test('reveal opens every ancestor of a node that starts hidden', () => {
    const tree = treeOf('{"a":{"b":{"c":{"d":1}}}}');
    const state = new JsonTreeState(tree);
    const deepest = tree.resolve('/a/b/c/d');
    expect(state.rowOf(deepest)).toBe(-1);
    state.reveal(deepest);
    expect(state.rowOf(deepest)).toBeGreaterThanOrEqual(0);
  });
});

describe('keyboard moves follow the ARIA tree pattern', () => {
  test('down, up, home and end walk the visible rows', () => {
    const state = new JsonTreeState(treeOf('{"a":1,"b":2,"c":3}'));
    state.move('down');
    expect(keyLabel(state.tree, state.selected)).toBe('"a"');
    state.move('end');
    expect(keyLabel(state.tree, state.selected)).toBe('"c"');
    state.move('up');
    expect(keyLabel(state.tree, state.selected)).toBe('"b"');
    state.move('home');
    expect(state.selected).toBe(0);
  });

  test('right expands a closed branch, then enters it; left leaves and closes', () => {
    const tree = treeOf('{"a":{"b":{"c":[1]}}}');
    const state = new JsonTreeState(tree);
    const array = tree.resolve('/a/b/c');
    state.select(array);
    state.move('right');
    expect(state.isExpanded(array)).toBe(true);
    state.move('right');
    expect(state.selected).toBe(tree.children(array)[0]!);
    state.move('left');
    expect(state.selected).toBe(array);
    state.move('left');
    expect(state.isExpanded(array)).toBe(false);
  });

  test('toggle opens the selected container', () => {
    const tree = treeOf('[[[[1]]]]');
    const state = new JsonTreeState(tree);
    const closed = tree.resolve('/0/0');
    state.select(closed);
    expect(state.isExpanded(closed)).toBe(false);
    state.move('toggle');
    expect(state.isExpanded(closed)).toBe(true);
  });
});

describe('anchors: a path names its node, a quote names the node it sits in', () => {
  test('a selected node gives its path anchor, and an ignored duplicate gives none', () => {
    const tree = treeOf('{"a":1,"a":2,"o":{"x":3}}');
    const state = new JsonTreeState(tree);
    state.select(tree.resolve('/a'));
    expect(state.selectionAnchor()).toEqual({ kind: 'path', pointer: '/a' });
    state.select(tree.children(0)[0]!);
    expect(state.selectionAnchor()).toBeUndefined();
    state.select(tree.resolve('/o/x'));
    expect(state.selectionAnchor()).toEqual({ kind: 'path', pointer: '/o/x' });
  });

  test('a path anchor resolves to the node it names, and an unknown one to nothing', () => {
    const tree = treeOf('{"a/b":[5]}');
    expect(nodeForAnchor(tree, { kind: 'path', pointer: '/a~1b/0' })).toBe(
      tree.resolve('/a~1b/0')
    );
    expect(
      nodeForAnchor(tree, { kind: 'path', pointer: '/missing' })
    ).toBeUndefined();
  });

  test('a quote with context picks the occurrence that matches it', () => {
    const tree = treeOf('{"x":"apple","y":"apple"}');
    expect(
      nodeForAnchor(tree, {
        kind: 'quote',
        exact: 'apple',
        prefix: '"y":"',
        suffix: '"}',
      })
    ).toBe(tree.children(0)[1]);
    expect(
      nodeForAnchor(tree, {
        kind: 'quote',
        exact: 'apple',
        prefix: '"z":"',
        suffix: '"',
      })
    ).toBeUndefined();
  });

  test('a text or source anchor finds its phrase in the source', () => {
    const tree = treeOf('{"n":42}');
    expect(nodeForAnchor(tree, { kind: 'text', quote: '42' })).toBe(
      tree.children(0)[0]
    );
    expect(
      nodeForAnchor(tree, { kind: 'source', exact: 'nope' })
    ).toBeUndefined();
  });

  test('findQuote never matches an empty phrase', () => {
    expect(findQuote('abc', '')).toBeUndefined();
  });

  test('marks survive collapse and expansion, and are cleared on request', () => {
    const tree = treeOf('{"a":{"b":1}}');
    const state = new JsonTreeState(tree);
    const leaf = tree.resolve('/a/b');
    state.mark(leaf, 'c1');
    state.collapseAll();
    expect(state.marksOn(leaf)).toEqual(['c1']);
    state.reveal(leaf);
    expect(state.marksOn(leaf)).toEqual(['c1']);
    state.clearMarks();
    expect(state.marksOn(leaf)).toEqual([]);
  });

  test('breadcrumbs run from the document to the node', () => {
    const tree = treeOf('{"queue":{"retry":[{"max":5}]}}');
    const node = tree.resolve('/queue/retry/0/max');
    expect(breadcrumbFor(tree, node).map((crumb) => crumb.label)).toEqual([
      '$',
      '"queue"',
      '"retry"',
      '0',
      '"max"',
    ]);
  });
});
