import { describe, expect, test } from 'bun:test';
import { type JsonTree, parseJsonTree } from '../src/json-tree.ts';

function treeOf(text: string): JsonTree {
  const result = parseJsonTree(text);
  if (!result.ok)
    throw new Error(`expected a tree: ${JSON.stringify(result.failure)}`);
  return result.tree;
}

describe('JsonTree duplicate flags: only a key with an earlier twin is flagged', () => {
  test('a unique key is not a duplicate, and the repeated pair both are', () => {
    const tree = treeOf('{"a":1,"b":2,"a":3}');
    const [first, middle, last] = tree.children(0);
    expect(tree.isDuplicated(middle!)).toBe(false);
    expect(tree.isShadowed(middle!)).toBe(false);
    expect(tree.isDuplicated(first!)).toBe(true);
    expect(tree.isShadowed(first!)).toBe(true);
    expect(tree.isDuplicated(last!)).toBe(true);
    expect(tree.isShadowed(last!)).toBe(false);
    expect(tree.duplicateCount).toBe(1);
  });

  test('members of an object with no repeated key are never flagged', () => {
    const tree = treeOf('{"a":1,"b":2}');
    expect(tree.children(0).map((node) => tree.isDuplicated(node))).toEqual([
      false,
      false,
    ]);
    expect(tree.duplicateCount).toBe(0);
  });
});

describe('JsonTree.pointer: refuses what the anchor writer refuses, and stops at the cap', () => {
  test('a key with a carriage return or a NUL has no pointer, and LF stays addressable', () => {
    const cr = treeOf('{"a\\rb":1}');
    expect(cr.pointer(cr.children(0)[0]!)).toBeUndefined();
    const nul = treeOf('{"a\\u0000b":1}');
    expect(nul.pointer(nul.children(0)[0]!)).toBeUndefined();
    const lf = treeOf('{"a\\nb":1}');
    expect(lf.pointer(lf.children(0)[0]!)).toBe('/a\nb');
  });

  test('a pointer over 512 bytes has none, and a deep path of long keys stops at the cap', () => {
    const long = 'k'.repeat(300);
    const deep = treeOf(`{"${long}":{"${long}":1}}`);
    expect(deep.pointer(deep.resolve(`/${long}/${long}`))).toBeUndefined();
    expect(deep.pointer(deep.resolve(`/${long}`))).toBe(`/${long}`);
  });

  test('the cap counts escaped bytes, so a slash costs two', () => {
    const fits = treeOf(JSON.stringify({ [`${'/'.repeat(255)}`]: 1 }));
    expect(fits.pointer(fits.children(0)[0]!)).toBe(`/${'~1'.repeat(255)}`);
    const over = treeOf(JSON.stringify({ [`${'/'.repeat(256)}`]: 1 }));
    expect(over.pointer(over.children(0)[0]!)).toBeUndefined();
  });

  test('a path of short keys is refused once its running total passes 512 bytes', () => {
    const tree = treeOf(`${'{"a":'.repeat(300)}1${'}'.repeat(300)}`);
    expect(tree.pointer(tree.resolve('/a'.repeat(200)))).toBe('/a'.repeat(200));
    expect(tree.pointer(tree.resolve('/a'.repeat(257)))).toBeUndefined();
  });
});
