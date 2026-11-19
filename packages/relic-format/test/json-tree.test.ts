import { describe, expect, test } from 'bun:test';
import {
  escapePointerToken,
  JSON_TREE_MAX_BYTES,
  JSON_TREE_MAX_DEPTH,
  JSON_TREE_MAX_NODES,
  type JsonTree,
  type JsonTreeResult,
  parseJsonTree,
  parsePointerTokens,
  pointerFromTokens,
} from '../src/json-tree.ts';
import { parseWritableCommentAnchor } from '../src/comments.ts';

function treeOf(text: string): JsonTree {
  const result: JsonTreeResult = parseJsonTree(text);
  if (!result.ok)
    throw new Error(`expected a tree: ${JSON.stringify(result.failure)}`);
  return result.tree;
}

function failureOf(text: string) {
  const result = parseJsonTree(text);
  if (result.ok) throw new Error('expected a refusal');
  return result.failure;
}

/** The value a tree holds, with a repeated key kept by its last occurrence. */
function materialize(tree: JsonTree, node = 0): unknown {
  switch (tree.kind(node)) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const child of tree.children(node)) {
        Object.defineProperty(out, tree.key(child) ?? '', {
          value: materialize(tree, child),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    case 'array':
      return tree.children(node).map((child) => materialize(tree, child));
    case 'number':
      return Number(tree.valueSource(node));
    case 'string':
      return JSON.parse(tree.valueSource(node)) as string;
    case 'boolean':
      return tree.valueSource(node) === 'true';
    case 'null':
      return null;
  }
}

describe('parseJsonTree: the shape of a document', () => {
  test('nodes, kinds, keys, child counts and pointers', () => {
    const tree = treeOf('{"a":[1,"x",true,null],"b":{"c":1.50}}');
    expect(tree.kind(0)).toBe('object');
    expect(tree.childCount(0)).toBe(2);
    const [a, b] = tree.children(0);
    expect(tree.key(a!)).toBe('a');
    expect(tree.kind(a!)).toBe('array');
    expect(tree.children(a!).map((n) => tree.kind(n))).toEqual([
      'number',
      'string',
      'boolean',
      'null',
    ]);
    expect(tree.pointer(tree.children(a!)[1]!)).toBe('/a/1');
    expect(tree.pointer(0)).toBe('');
    const c = tree.children(b!)[0]!;
    expect(tree.key(c)).toBe('c');
    expect(tree.depth(c)).toBe(2);
    expect(tree.maxDepth).toBe(2);
  });

  test('a top-level scalar and an empty container are documents', () => {
    expect(treeOf('"hi"').kind(0)).toBe('string');
    expect(treeOf('  42  ').valueSource(0)).toBe('42');
    expect(treeOf('{}').childCount(0)).toBe(0);
    expect(treeOf('[ ]').kind(0)).toBe('array');
  });

  test('a document keeps every source offset, so a node is found by its text', () => {
    const text = '{"a": 1,\n "bb": [true]}';
    const tree = treeOf(text);
    const bb = tree.children(0)[1]!;
    expect(tree.keySource(bb)).toBe('"bb"');
    expect(text.slice(tree.valueStart(bb), tree.valueEnd(bb))).toBe('[true]');
    const offset = text.indexOf('true');
    expect(tree.nodeAt(offset)).toBe(tree.children(bb)[0]!);
    expect(tree.nodeAt(text.indexOf(' 1') + 1)).toBe(tree.children(0)[0]!);
    expect(tree.nodeAt(text.indexOf('{'))).toBe(0);
    expect(tree.nodeAt(text.length)).toBe(-1);
  });
});

describe('parseJsonTree: duplicate keys stay visible', () => {
  test('the earlier duplicate is kept and shadowed, the later one counts', () => {
    const tree = treeOf('{"a":1,"b":2,"a":3}');
    expect(tree.size).toBe(4);
    const [first, second, last] = tree.children(0);
    expect(tree.isShadowed(first!)).toBe(true);
    expect(tree.isDuplicated(first!)).toBe(true);
    expect(tree.isShadowed(second!)).toBe(false);
    expect(tree.isShadowed(last!)).toBe(false);
    expect(tree.isDuplicated(last!)).toBe(true);
    expect(tree.duplicateCount).toBe(1);
  });

  test('a pointer addresses the last occurrence only, and an ignored one has none', () => {
    const tree = treeOf('{"a":1,"a":3}');
    const [first, last] = tree.children(0);
    expect(tree.pointer(first!)).toBeUndefined();
    expect(tree.pointer(last!)).toBe('/a');
    expect(tree.valueSource(tree.resolve('/a'))).toBe('3');
  });

  test('a node under an ignored duplicate has no pointer either', () => {
    const tree = treeOf('{"o":{"x":1},"o":{"x":2}}');
    const [ignored] = tree.children(0);
    expect(tree.pointer(tree.children(ignored!)[0]!)).toBeUndefined();
  });

  test('a key repeated three times shadows the first two', () => {
    const tree = treeOf('{"k":1,"k":2,"k":3}');
    expect(tree.children(0).map((n) => tree.isShadowed(n))).toEqual([
      true,
      true,
      false,
    ]);
    expect(tree.duplicateCount).toBe(2);
  });

  test('the same key in two different objects is not a duplicate', () => {
    const tree = treeOf('[{"k":1},{"k":2}]');
    expect(tree.duplicateCount).toBe(0);
  });
});

describe('parseJsonTree: numbers keep their source text', () => {
  test('digits beyond a double are not rounded', () => {
    const literals = [
      '12345678901234567890123',
      '-0',
      '1e400',
      '0.1000000000000000055511151231257827021181583404541015625',
      '-1.5E+10',
    ];
    const tree = treeOf(`[${literals.join(',')}]`);
    expect(tree.children(0).map((n) => tree.valueSource(n))).toEqual(literals);
  });
});

describe('parseJsonTree: keys and pointers', () => {
  test('keys decode their escapes, and pointers escape / and ~', () => {
    const tree = treeOf('{"a/b":1,"c~d":2,"":3,"e\\u0041":4,"\\/":5}');
    expect(tree.children(0).map((n) => tree.key(n))).toEqual([
      'a/b',
      'c~d',
      '',
      'eA',
      '/',
    ]);
    expect(tree.pointer(tree.children(0)[0]!)).toBe('/a~1b');
    expect(tree.pointer(tree.children(0)[1]!)).toBe('/c~0d');
    expect(tree.pointer(tree.children(0)[2]!)).toBe('/');
  });

  test('every node round-trips through its pointer', () => {
    const tree = treeOf(
      '{"a/b":[{"~":{"~0":null,"~1":[true,false]}}],"":{"é😀":"x"},"k":[0,1,2]}'
    );
    for (let node = 0; node < tree.size; node += 1) {
      const pointer = tree.pointer(node);
      expect(pointer).toBeDefined();
      expect(tree.resolve(pointer!)).toBe(node);
    }
  });

  test('pointer tokens round-trip through the escape rules', () => {
    const tokens = ['', '/', '~', '~0', '~1', '~01', 'a/b~c', 'é😀'];
    const pointer = pointerFromTokens(tokens);
    expect(parsePointerTokens(pointer)).toEqual(tokens);
    expect(escapePointerToken('~1')).toBe('~01');
  });

  test('a pointer that is not RFC 6901 addresses nothing and parses to nothing', () => {
    expect(parsePointerTokens('a')).toBeUndefined();
    expect(parsePointerTokens('/~2')).toBeUndefined();
    expect(parsePointerTokens('/a~')).toBeUndefined();
    expect(parsePointerTokens('/\u0000')).toBeUndefined();
    expect(parsePointerTokens('/a\r')).toBeUndefined();
    expect(parsePointerTokens('')).toEqual([]);
    const tree = treeOf('[1]');
    expect(tree.resolve('a')).toBe(-1);
    expect(tree.resolve('/01')).toBe(-1);
    expect(tree.resolve('/1')).toBe(-1);
    expect(tree.resolve('/0')).toBe(1);
  });

  test('a pointer past the 512-byte comment cap is not offered', () => {
    const key = 'k'.repeat(600);
    const tree = treeOf(`{"${key}":1}`);
    expect(tree.pointer(tree.children(0)[0]!)).toBeUndefined();
  });

  test('a pointer the tree offers is one the comment writer accepts', () => {
    const tree = treeOf('{"a/b":{"~":[1]}}');
    const pointers = [0, 1, 2, 3]
      .map((node) => tree.pointer(node))
      .filter((p): p is string => p !== undefined);
    for (const pointer of pointers) {
      expect(() =>
        parseWritableCommentAnchor({ kind: 'path', pointer })
      ).not.toThrow();
    }
  });
});

describe('parseJsonTree: the reader agrees with JSON.parse', () => {
  test('values match JSON.parse on generated documents, duplicates included', () => {
    const rng = mulberry32(20261119);
    for (let i = 0; i < 400; i += 1) {
      const text = generateText(rng, 0);
      const expected = JSON.parse(text) as unknown;
      const result = parseJsonTree(text);
      if (!result.ok) {
        throw new Error(
          `refused valid JSON ${text}: ${JSON.stringify(result.failure)}`
        );
      }
      expect(materialize(result.tree)).toEqual(expected);
    }
  });

  test('validity matches JSON.parse on mutated text, both ways', () => {
    const rng = mulberry32(7);
    const alphabet = '{}[],:"\\ 0a-.eE+tfnul\n\t\u0001';
    let refused = 0;
    let accepted = 0;
    for (let i = 0; i < 4000; i += 1) {
      const base = generateText(rng, 0);
      const at = Math.floor(rng() * base.length);
      const mutated =
        rng() < 0.5
          ? base.slice(0, at) + base.slice(at + 1)
          : base.slice(0, at) +
            alphabet[Math.floor(rng() * alphabet.length)]! +
            base.slice(at);
      let valid = true;
      try {
        JSON.parse(mutated);
      } catch {
        valid = false;
      }
      const ours = parseJsonTree(mutated).ok;
      if (valid) accepted += 1;
      else refused += 1;
      if (ours !== valid) {
        throw new Error(
          `disagrees with JSON.parse on ${JSON.stringify(mutated)}`
        );
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
  });

  test('whitespace is the four JSON characters and nothing else', () => {
    expect(parseJsonTree('\u00a0[1]').ok).toBe(false);
    expect(parseJsonTree('\t\r\n[1]\t\r\n').ok).toBe(true);
  });
});

describe('parseJsonTree: syntax errors name a line and column', () => {
  test('a missing comma is reported where the next member starts', () => {
    expect(failureOf('{\n  "a": 1\n  "b": 2\n}')).toEqual({
      kind: 'syntax',
      line: 3,
      column: 3,
      reason: 'expected a comma or a closing brace',
    });
  });

  test('a trailing comma, an unclosed string and a bare control character', () => {
    expect(failureOf('[1,]')).toMatchObject({
      kind: 'syntax',
      line: 1,
      column: 4,
      reason: 'expected a value',
    });
    expect(failureOf('["abc')).toMatchObject({
      kind: 'syntax',
      reason: 'the string is never closed',
    });
    expect(failureOf('["a\u0001"]')).toMatchObject({
      kind: 'syntax',
      reason: 'a control character must be escaped in a string',
    });
  });

  test('text after the value, an empty file, a bad escape and a bare minus', () => {
    expect(failureOf('1 2')).toMatchObject({
      reason: 'unexpected text after the value',
    });
    expect(failureOf('')).toMatchObject({ kind: 'syntax', line: 1, column: 1 });
    expect(failureOf('"\\q"')).toMatchObject({
      reason: 'an invalid escape in a string',
    });
    expect(failureOf('[-]')).toMatchObject({
      reason: 'a minus sign needs a digit after it',
    });
  });

  test('the column counts from the start of its own line', () => {
    expect(failureOf('[\n\n  tru]')).toMatchObject({ line: 3, column: 3 });
  });
});

describe('parseJsonTree: limits refuse without crashing', () => {
  test('nesting exactly at the depth cap reads, one deeper is refused', () => {
    const at =
      '['.repeat(JSON_TREE_MAX_DEPTH) + ']'.repeat(JSON_TREE_MAX_DEPTH);
    expect(parseJsonTree(at).ok).toBe(true);
    const over =
      '['.repeat(JSON_TREE_MAX_DEPTH + 1) + ']'.repeat(JSON_TREE_MAX_DEPTH + 1);
    expect(failureOf(over)).toMatchObject({
      kind: 'too-deep',
      limit: JSON_TREE_MAX_DEPTH,
      line: 1,
      column: JSON_TREE_MAX_DEPTH + 1,
    });
  });

  test('100,000 levels of nesting are refused with no stack overflow', () => {
    const depth = 100_000;
    const closed = '['.repeat(depth) + ']'.repeat(depth);
    const started = performance.now();
    const refusal = failureOf(closed);
    const elapsed = performance.now() - started;
    expect(refusal).toMatchObject({ kind: 'too-deep' });
    expect(elapsed).toBeLessThan(1000);
    const unclosed = failureOf('{"a":'.repeat(depth));
    expect(unclosed).toMatchObject({ kind: 'too-deep' });
    console.log(
      `json-tree: 100,000-deep nesting refused in ${elapsed.toFixed(2)} ms`
    );
  });

  test('the node cap admits 2,000,000 values and refuses one more', () => {
    const fits = `[${'0,'.repeat(JSON_TREE_MAX_NODES - 2)}0]`;
    const started = performance.now();
    const result = parseJsonTree(fits);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tree.size).toBe(JSON_TREE_MAX_NODES);
    console.log(
      `json-tree: ${JSON_TREE_MAX_NODES.toLocaleString('en-US')} values parsed in ${elapsed.toFixed(0)} ms`
    );
    expect(failureOf(`[${'0,'.repeat(JSON_TREE_MAX_NODES - 1)}0]`)).toEqual({
      kind: 'too-many-nodes',
      limit: JSON_TREE_MAX_NODES,
    });
  });

  test('a file over the byte cap is refused before it is read', () => {
    const big = `"${'a'.repeat(JSON_TREE_MAX_BYTES)}"`;
    expect(failureOf(big)).toEqual({
      kind: 'too-large',
      bytes: JSON_TREE_MAX_BYTES + 2,
      limit: JSON_TREE_MAX_BYTES,
    });
  });
});

describe('parseJsonTree: hostile text stays text', () => {
  test('markup in keys and values is kept as characters, never read as structure', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const tree = treeOf(JSON.stringify({ [hostile]: hostile }));
    expect(tree.key(tree.children(0)[0]!)).toBe(hostile);
    expect(tree.valueSource(tree.children(0)[0]!)).toBe(
      JSON.stringify(hostile)
    );
  });
});

// A small deterministic generator, so a failure names a case that can be run again.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateText(rng: () => number, depth: number): string {
  const ws = (): string =>
    rng() < 0.7 ? '' : [' ', '\n', '\t', '\r\n'][Math.floor(rng() * 4)]!;
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rng() * items.length)]!;
  const scalar = (): string => {
    const kind = rng();
    if (kind < 0.25) return pick(['true', 'false', 'null']);
    if (kind < 0.55) {
      const digits = pick([
        '0',
        '7',
        '12',
        '123456789012345678',
        '-3',
        '2.5',
        '-0.25',
        '6e3',
        '1E-4',
        '-7.5e+2',
      ]);
      return digits;
    }
    const pool = [
      'a',
      'é',
      '😀',
      '"',
      '\\',
      '/',
      '\n',
      '\u0001',
      '\u2028',
      '<',
      ' ',
      'x',
    ];
    let value = '';
    const length = Math.floor(rng() * 6);
    for (let i = 0; i < length; i += 1) value += pick(pool);
    let text = JSON.stringify(value);
    if (rng() < 0.3) text = escapeNonAscii(text);
    if (rng() < 0.2) text = text.replace(/\//g, '\\/');
    return text;
  };
  const key = (): string => {
    const raw = pick(['a', 'b', 'k', 'x/y', 'm~n', '', 'é']);
    let text = JSON.stringify(raw);
    if (rng() < 0.3) text = escapeNonAscii(text);
    return text;
  };
  if (depth >= 4 || rng() < 0.4) return ws() + scalar() + ws();
  if (rng() < 0.5) {
    const count = Math.floor(rng() * 4);
    const items: string[] = [];
    for (let i = 0; i < count; i += 1) items.push(generateText(rng, depth + 1));
    return `${ws()}[${items.join(',')}]${ws()}`;
  }
  const count = Math.floor(rng() * 4);
  const members: string[] = [];
  for (let i = 0; i < count; i += 1) {
    members.push(`${ws()}${key()}${ws()}:${generateText(rng, depth + 1)}`);
  }
  return `${ws()}{${members.join(',')}}${ws()}`;
}

/** Escapes every non-ASCII code unit as a JSON \uXXXX, which JSON.parse reads back the same. */
function escapeNonAscii(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    out += unit < 0x80 ? text[at] : `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return out;
}
