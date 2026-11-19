/**
 * The JSON reader behind the tree view and the notebook reader (plan A2,
 * section 4; A4 reuses it).
 *
 * It is one pass over the text with an explicit stack, so no input depth can
 * overflow the call stack: nesting past the depth cap is refused, and nothing
 * here recurses. Every JSON value is one node. Nodes live in typed arrays, not
 * objects, so a file at the node cap costs tens of megabytes rather than
 * hundreds.
 *
 * Three things a reader of JSON usually loses, and this one keeps:
 * - A duplicate key stays as two nodes. The earlier is flagged as ignored,
 *   because a parser that keeps the last value ignores it, and the reader has
 *   to show both to say so.
 * - A number stays as its source text. `12345678901234567890` is not rounded
 *   to a double on the way to the screen.
 * - Every node keeps its offsets, so a parse error names a line and column and
 *   a quote can be found where it was written.
 *
 * Pointers are RFC 6901, the form `path` comment anchors carry. A key that
 * appears twice is addressed by its last occurrence, as `JSON.parse` keeps
 * it, so an ignored duplicate has no pointer of its own.
 */

import { COMMENT_ANCHOR_POINTER_LIMIT_BYTES } from './comments.ts';

/** A file larger than this, in UTF-8 bytes, is not parsed. */
export const JSON_TREE_MAX_BYTES = 32 * 1024 * 1024;

/** Nodes (every value, container or scalar) before the reader refuses. */
export const JSON_TREE_MAX_NODES = 2_000_000;

/** Containers open at once. A file nested deeper is refused. */
export const JSON_TREE_MAX_DEPTH = 1_000;

export type JsonValueKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

/** Why a file was not read as a tree. Syntax failures carry a 1-based position. */
export type JsonTreeFailure =
  | {
      readonly kind: 'too-large';
      readonly bytes: number;
      readonly limit: number;
    }
  | { readonly kind: 'too-many-nodes'; readonly limit: number }
  | {
      readonly kind: 'too-deep';
      readonly limit: number;
      readonly line: number;
      readonly column: number;
    }
  | {
      readonly kind: 'syntax';
      readonly line: number;
      readonly column: number;
      readonly reason: string;
    };

export type JsonTreeResult =
  | { readonly ok: true; readonly tree: JsonTree }
  | { readonly ok: false; readonly failure: JsonTreeFailure };

const NONE = -1;

const KIND_OBJECT = 0;
const KIND_ARRAY = 1;
const KIND_STRING = 2;
const KIND_NUMBER = 3;
const KIND_BOOLEAN = 4;
const KIND_NULL = 5;

const KIND_NAMES: readonly JsonValueKind[] = [
  'object',
  'array',
  'string',
  'number',
  'boolean',
  'null',
];

/** The node has an object key (its source span is in `keyStart`/`keyEnd`). */
const FLAG_HAS_KEY = 1;
/** An earlier member of the same object has this key, and this one is ignored. */
const FLAG_SHADOWED = 2;
/** This object has a later or earlier member with the same key. */
const FLAG_DUPLICATED = 4;

/** Column-major node storage. Each array is indexed by node. */
class Store {
  count = 0;
  capacity = 0;
  maxDepth = 0;
  shadowed = 0;
  kind = new Uint8Array(0);
  start = new Uint32Array(0);
  end = new Uint32Array(0);
  keyStart = new Uint32Array(0);
  keyEnd = new Uint32Array(0);
  parent = new Int32Array(0);
  depth = new Uint16Array(0);
  index = new Uint32Array(0);
  firstChild = new Int32Array(0);
  nextSibling = new Int32Array(0);
  childCount = new Uint32Array(0);
  flags = new Uint8Array(0);

  /** Makes room for one more node. False when the node cap is reached. */
  reserve(): boolean {
    if (this.count < this.capacity) return true;
    if (this.count >= JSON_TREE_MAX_NODES) return false;
    const next = Math.min(
      JSON_TREE_MAX_NODES,
      Math.max(1024, this.capacity * 2)
    );
    this.kind = grow(this.kind, next);
    this.start = grow(this.start, next);
    this.end = grow(this.end, next);
    this.keyStart = grow(this.keyStart, next);
    this.keyEnd = grow(this.keyEnd, next);
    this.parent = grow(this.parent, next);
    this.depth = grow(this.depth, next);
    this.index = grow(this.index, next);
    this.firstChild = grow(this.firstChild, next);
    this.nextSibling = grow(this.nextSibling, next);
    this.childCount = grow(this.childCount, next);
    this.flags = grow(this.flags, next);
    this.capacity = next;
    return true;
  }
}

function grow<T extends Uint8Array | Uint16Array | Uint32Array | Int32Array>(
  current: T,
  capacity: number
): T {
  const next = new (current.constructor as new (length: number) => T)(capacity);
  next.set(current);
  return next;
}

/**
 * A parsed document. Nodes are numbered in source order, the root is node 0,
 * and every accessor is O(1) except where it says otherwise.
 */
export class JsonTree {
  readonly source: string;
  /** Every value in the document, containers and scalars alike. */
  readonly size: number;
  /** The deepest container nesting, where the root is depth 0. */
  readonly maxDepth: number;
  /** Members that a later member of the same object shadows. */
  readonly duplicateCount: number;
  readonly #store: Store;

  constructor(source: string, store: Store) {
    this.source = source;
    this.size = store.count;
    this.maxDepth = store.maxDepth;
    this.duplicateCount = store.shadowed;
    this.#store = store;
  }

  kind(node: number): JsonValueKind {
    return KIND_NAMES[this.#store.kind[node] ?? KIND_NULL] ?? 'null';
  }

  isContainer(node: number): boolean {
    const kind = this.#store.kind[node];
    return kind === KIND_OBJECT || kind === KIND_ARRAY;
  }

  parent(node: number): number {
    return this.#store.parent[node] ?? NONE;
  }

  depth(node: number): number {
    return this.#store.depth[node] ?? 0;
  }

  childCount(node: number): number {
    return this.#store.childCount[node] ?? 0;
  }

  firstChild(node: number): number {
    return this.#store.firstChild[node] ?? NONE;
  }

  nextSibling(node: number): number {
    return this.#store.nextSibling[node] ?? NONE;
  }

  /** Position among the parent's children: the array index, or the member order. */
  index(node: number): number {
    return this.#store.index[node] ?? 0;
  }

  /** The value's first and past-the-end source offsets. */
  valueStart(node: number): number {
    return this.#store.start[node] ?? 0;
  }

  valueEnd(node: number): number {
    return this.#store.end[node] ?? 0;
  }

  hasKey(node: number): boolean {
    return (((this.#store.flags[node] ?? 0) & FLAG_HAS_KEY) as number) !== 0;
  }

  /** Whether an earlier member of this object has the same key and is ignored. */
  isShadowed(node: number): boolean {
    return (((this.#store.flags[node] ?? 0) & FLAG_SHADOWED) as number) !== 0;
  }

  /** Whether this object has another member with the same key. */
  isDuplicated(node: number): boolean {
    return (((this.#store.flags[node] ?? 0) & FLAG_DUPLICATED) as number) !== 0;
  }

  /** Where the member's text starts: its key when it has one, else its value. */
  spanStart(node: number): number {
    return this.hasKey(node)
      ? (this.#store.keyStart[node] ?? 0)
      : this.valueStart(node);
  }

  /** The key as written in the source, quotes and escapes included. */
  keySource(node: number): string | undefined {
    if (!this.hasKey(node)) return undefined;
    return this.source.slice(
      this.#store.keyStart[node] ?? 0,
      this.#store.keyEnd[node] ?? 0
    );
  }

  /** The key's value, with escapes decoded. */
  key(node: number): string | undefined {
    const written = this.keySource(node);
    return written === undefined ? undefined : jsonStringValue(written);
  }

  /** The value as written in the source. A number keeps every digit. */
  valueSource(node: number): string {
    return this.source.slice(this.valueStart(node), this.valueEnd(node));
  }

  /** The node's children in source order. Allocates, so use it for display only. */
  children(node: number): number[] {
    const out: number[] = [];
    for (
      let child = this.firstChild(node);
      child !== NONE;
      child = this.nextSibling(child)
    ) {
      out.push(child);
    }
    return out;
  }

  /**
   * The RFC 6901 pointer that addresses this node, or `undefined` when no
   * pointer does: an ignored duplicate, a node under one, or a pointer longer
   * than the comment cap (512 bytes).
   */
  pointer(node: number): string | undefined {
    const tokens = this.#tokensOf(node);
    if (tokens === undefined) return undefined;
    const pointer = pointerFromTokens(tokens);
    return new TextEncoder().encode(pointer).length <=
      COMMENT_ANCHOR_POINTER_LIMIT_BYTES
      ? pointer
      : undefined;
  }

  /** The node a pointer addresses, or `NONE` when it addresses nothing. */
  resolve(pointer: string): number {
    const tokens = parsePointerTokens(pointer);
    if (tokens === undefined) return NONE;
    let node = 0;
    for (const token of tokens) {
      node = this.#child(node, token);
      if (node === NONE) return NONE;
    }
    return node;
  }

  /**
   * The innermost node whose text covers a source offset, or `NONE` when the
   * offset is outside the document. Whitespace between children answers for
   * their container.
   */
  nodeAt(offset: number): number {
    if (this.size === 0) return NONE;
    if (offset < this.valueStart(0) || offset >= this.valueEnd(0)) return NONE;
    let node = 0;
    for (;;) {
      let next = NONE;
      for (
        let child = this.firstChild(node);
        child !== NONE;
        child = this.nextSibling(child)
      ) {
        if (offset < this.spanStart(child)) break;
        if (offset < this.valueEnd(child)) {
          next = child;
          break;
        }
      }
      if (next === NONE) return node;
      node = next;
    }
  }

  #child(node: number, token: string): number {
    if (this.kind(node) === 'object') {
      let found = NONE;
      for (
        let child = this.firstChild(node);
        child !== NONE;
        child = this.nextSibling(child)
      ) {
        // The last occurrence wins, as `JSON.parse` keeps it.
        if (this.key(child) === token) found = child;
      }
      return found;
    }
    if (this.kind(node) === 'array') {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return NONE;
      const wanted = Number(token);
      if (wanted >= this.childCount(node)) return NONE;
      let child = this.firstChild(node);
      for (let at = 0; at < wanted && child !== NONE; at += 1) {
        child = this.nextSibling(child);
      }
      return child;
    }
    return NONE;
  }

  #tokensOf(node: number): string[] | undefined {
    const tokens: string[] = [];
    for (let at = node; this.parent(at) !== NONE; at = this.parent(at)) {
      if (this.isShadowed(at)) return undefined;
      const parent = this.parent(at);
      if (this.kind(parent) === 'array') {
        tokens.push(String(this.index(at)));
      } else {
        const key = this.key(at);
        if (key === undefined) return undefined;
        tokens.push(key);
      }
    }
    return tokens.reverse();
  }
}

/** Decodes a JSON string literal, quotes included, to its value. */
export function jsonStringValue(literal: string): string {
  if (!literal.includes('\\')) return literal.slice(1, -1);
  return JSON.parse(literal) as string;
}

/** RFC 6901 escaping of one reference token: `~` becomes `~0`, `/` becomes `~1`. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The pointer for a list of reference tokens. No tokens is the whole document. */
export function pointerFromTokens(tokens: readonly string[]): string {
  let pointer = '';
  for (const token of tokens) pointer += `/${escapePointerToken(token)}`;
  return pointer;
}

/**
 * The reference tokens of a pointer, or `undefined` when it is not a pointer.
 * The rules match the anchor writer's: empty or rooted at `/`, `~` only as
 * `~0` or `~1`, and no NUL or CR.
 */
export function parsePointerTokens(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  if (pointer.includes('\u0000') || pointer.includes('\r')) return undefined;
  const tokens: string[] = [];
  for (const part of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(part)) return undefined;
    tokens.push(part.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return tokens;
}

/** UTF-8 length of a string, without encoding it. Lone surrogates count as U+FFFD. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      at + 1 < text.length &&
      (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      at += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Reads a whole document. The result is a tree, or the reason it is not one:
 * a file over the byte cap, too many values, nesting past the depth cap, or a
 * syntax error with its line and column. It never throws.
 */
export function parseJsonTree(source: string): JsonTreeResult {
  const bytes = utf8Length(source);
  if (bytes > JSON_TREE_MAX_BYTES) {
    return refused({
      kind: 'too-large',
      bytes,
      limit: JSON_TREE_MAX_BYTES,
    });
  }
  return new Parser(source).run();
}

function refused(failure: JsonTreeFailure): JsonTreeResult {
  return { ok: false, failure };
}

/** 1-based line and column of an offset. Columns count UTF-16 code units. */
function lineAndColumn(source: string, offset: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, source.length);
  for (let at = 0; at < end; at += 1) {
    if (source.charCodeAt(at) === 0x0a) {
      line += 1;
      lineStart = at + 1;
    }
  }
  return [line, end - lineStart + 1];
}

const CH_QUOTE = 0x22;
const CH_BACKSLASH = 0x5c;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_MINUS = 0x2d;
const CH_PLUS = 0x2b;
const CH_DOT = 0x2e;
const CH_ZERO = 0x30;
const CH_NINE = 0x39;
const CH_OPEN_BRACE = 0x7b;
const CH_CLOSE_BRACE = 0x7d;
const CH_OPEN_BRACKET = 0x5b;
const CH_CLOSE_BRACKET = 0x5d;
const CH_LOWER_E = 0x65;
const CH_UPPER_E = 0x45;
const CH_LOWER_U = 0x75;

function isWhitespace(unit: number): boolean {
  return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d;
}

function isDigit(unit: number): boolean {
  return unit >= CH_ZERO && unit <= CH_NINE;
}

function isHex(unit: number): boolean {
  return (
    isDigit(unit) ||
    (unit >= 0x41 && unit <= 0x46) ||
    (unit >= 0x61 && unit <= 0x66)
  );
}

/**
 * One pass over the text. Each step either adds a node, or moves the cursor
 * over a delimiter. The open containers live on `#open`, not the call stack.
 */
class Parser {
  readonly #source: string;
  readonly #store = new Store();
  /** Open containers, outermost first. */
  readonly #open: number[] = [];
  /** The last child added to each open container, parallel to `#open`. */
  readonly #lastChild: number[] = [];
  /** Each open object's keys so far, parallel to `#open`. Arrays hold none. */
  readonly #members: Array<Map<string, number> | undefined> = [];
  #failure: JsonTreeFailure | undefined;
  /** The key span the last `#member` call read, for the value that follows. */
  #keyStart = NONE;
  #keyEnd = NONE;

  constructor(source: string) {
    this.#source = source;
  }

  run(): JsonTreeResult {
    const src = this.#source;
    const len = src.length;
    let pos = this.#skip(0);
    let needValue = true;
    let keyStart = NONE;
    let keyEnd = NONE;

    for (;;) {
      if (needValue) {
        if (pos >= len) {
          return this.#syntax(pos, 'expected a value, but the file ends');
        }
        const unit = src.charCodeAt(pos);
        const parent =
          this.#open.length > 0 ? (this.#open.at(-1) ?? NONE) : NONE;

        if (unit === CH_OPEN_BRACE || unit === CH_OPEN_BRACKET) {
          if (this.#open.length >= JSON_TREE_MAX_DEPTH) {
            const [line, column] = lineAndColumn(src, pos);
            return refused({
              kind: 'too-deep',
              limit: JSON_TREE_MAX_DEPTH,
              line,
              column,
            });
          }
          const isObject = unit === CH_OPEN_BRACE;
          const node = this.#add(
            isObject ? KIND_OBJECT : KIND_ARRAY,
            pos,
            0,
            parent,
            keyStart,
            keyEnd
          );
          if (node === NONE) return this.#refuse();
          keyStart = NONE;
          keyEnd = NONE;
          this.#open.push(node);
          this.#lastChild.push(NONE);
          this.#members.push(undefined);
          pos = this.#skip(pos + 1);

          if (isObject && src.charCodeAt(pos) !== CH_CLOSE_BRACE) {
            pos = this.#member(
              pos,
              'expected a property name or a closing brace'
            );
            if (pos === NONE) return this.#refuse();
            keyStart = this.#keyStart;
            keyEnd = this.#keyEnd;
            needValue = true;
            continue;
          }
          if (!isObject && src.charCodeAt(pos) !== CH_CLOSE_BRACKET) {
            needValue = true;
            continue;
          }
          pos = this.#close(pos);
          needValue = false;
          continue;
        }

        const end = this.#scalar(pos, parent, keyStart, keyEnd);
        if (end === NONE) return this.#refuse();
        keyStart = NONE;
        keyEnd = NONE;
        pos = end;
        needValue = false;
        continue;
      }

      if (this.#open.length === 0) {
        pos = this.#skip(pos);
        if (pos < len) {
          return this.#syntax(pos, 'unexpected text after the value');
        }
        return { ok: true, tree: new JsonTree(src, this.#store) };
      }

      pos = this.#skip(pos);
      const unit = src.charCodeAt(pos);
      const top = this.#open.at(-1) ?? NONE;
      if (this.#store.kind[top] === KIND_OBJECT) {
        if (unit === CH_COMMA) {
          pos = this.#member(
            this.#skip(pos + 1),
            'expected a property name after a comma'
          );
          if (pos === NONE) return this.#refuse();
          keyStart = this.#keyStart;
          keyEnd = this.#keyEnd;
          needValue = true;
          continue;
        }
        if (unit === CH_CLOSE_BRACE) {
          pos = this.#close(pos);
          continue;
        }
        return this.#syntax(pos, 'expected a comma or a closing brace');
      }
      if (unit === CH_COMMA) {
        pos = this.#skip(pos + 1);
        needValue = true;
        continue;
      }
      if (unit === CH_CLOSE_BRACKET) {
        pos = this.#close(pos);
        continue;
      }
      return this.#syntax(pos, 'expected a comma or a closing bracket');
    }
  }

  /**
   * Reads `"key" :` at `pos` and leaves the key span in `#keyStart`/`#keyEnd`.
   * Returns where the value starts, or `NONE` with a failure set.
   */
  #member(pos: number, reason: string): number {
    if (this.#source.charCodeAt(pos) !== CH_QUOTE) {
      this.#failure = this.#syntaxFailure(pos, reason);
      return NONE;
    }
    const end = this.#string(pos);
    if (end === NONE) return NONE;
    this.#keyStart = pos;
    this.#keyEnd = end;
    const colon = this.#skip(end);
    if (this.#source.charCodeAt(colon) !== CH_COLON) {
      this.#failure = this.#syntaxFailure(
        colon,
        'expected a colon after the property name'
      );
      return NONE;
    }
    return this.#skip(colon + 1);
  }

  /** Reads a scalar at `pos` and adds it. Returns the position after it. */
  #scalar(
    pos: number,
    parent: number,
    keyStart: number,
    keyEnd: number
  ): number {
    const src = this.#source;
    const unit = src.charCodeAt(pos);
    if (unit === CH_QUOTE) {
      const end = this.#string(pos);
      if (end === NONE) return NONE;
      return this.#add(KIND_STRING, pos, end, parent, keyStart, keyEnd) === NONE
        ? NONE
        : end;
    }
    if (unit === CH_MINUS || isDigit(unit)) {
      const end = this.#number(pos);
      if (end === NONE) return NONE;
      return this.#add(KIND_NUMBER, pos, end, parent, keyStart, keyEnd) === NONE
        ? NONE
        : end;
    }
    const literal: ReadonlyArray<readonly [string, number]> = [
      ['true', KIND_BOOLEAN],
      ['false', KIND_BOOLEAN],
      ['null', KIND_NULL],
    ];
    for (const [word, kind] of literal) {
      if (src.startsWith(word, pos)) {
        const end = pos + word.length;
        return this.#add(kind, pos, end, parent, keyStart, keyEnd) === NONE
          ? NONE
          : end;
      }
    }
    this.#failure = this.#syntaxFailure(pos, 'expected a value');
    return NONE;
  }

  /** The end of a string literal starting at `pos`, or `NONE` with a failure set. */
  #string(pos: number): number {
    const src = this.#source;
    const len = src.length;
    let at = pos + 1;
    for (;;) {
      if (at >= len) {
        this.#failure = this.#syntaxFailure(pos, 'the string is never closed');
        return NONE;
      }
      const unit = src.charCodeAt(at);
      if (unit === CH_QUOTE) return at + 1;
      if (unit === CH_BACKSLASH) {
        const code = src.charCodeAt(at + 1);
        if (code === CH_LOWER_U) {
          for (let digit = 2; digit < 6; digit += 1) {
            if (!isHex(src.charCodeAt(at + digit))) {
              this.#failure = this.#syntaxFailure(
                at,
                'a \\u escape needs four hex digits'
              );
              return NONE;
            }
          }
          at += 6;
          continue;
        }
        if ('"\\/bfnrt'.includes(String.fromCharCode(code))) {
          at += 2;
          continue;
        }
        this.#failure = this.#syntaxFailure(
          at,
          'an invalid escape in a string'
        );
        return NONE;
      }
      if (unit < 0x20) {
        this.#failure = this.#syntaxFailure(
          at,
          'a control character must be escaped in a string'
        );
        return NONE;
      }
      at += 1;
    }
  }

  /** The end of a number literal at `pos`, or `NONE` with a failure set. */
  #number(pos: number): number {
    const src = this.#source;
    let at = pos;
    if (src.charCodeAt(at) === CH_MINUS) at += 1;
    if (src.charCodeAt(at) === CH_ZERO) {
      at += 1;
    } else if (isDigit(src.charCodeAt(at))) {
      while (isDigit(src.charCodeAt(at))) at += 1;
    } else {
      this.#failure = this.#syntaxFailure(
        at,
        'a minus sign needs a digit after it'
      );
      return NONE;
    }
    if (src.charCodeAt(at) === CH_DOT) {
      at += 1;
      if (!isDigit(src.charCodeAt(at))) {
        this.#failure = this.#syntaxFailure(
          at,
          'a decimal point needs a digit after it'
        );
        return NONE;
      }
      while (isDigit(src.charCodeAt(at))) at += 1;
    }
    const exponent = src.charCodeAt(at);
    if (exponent === CH_LOWER_E || exponent === CH_UPPER_E) {
      at += 1;
      const sign = src.charCodeAt(at);
      if (sign === CH_PLUS || sign === CH_MINUS) at += 1;
      if (!isDigit(src.charCodeAt(at))) {
        this.#failure = this.#syntaxFailure(at, 'an exponent needs a digit');
        return NONE;
      }
      while (isDigit(src.charCodeAt(at))) at += 1;
    }
    return at;
  }

  /** Closes the innermost open container at `pos`, which holds its closer. */
  #close(pos: number): number {
    const node = this.#open.pop() ?? NONE;
    this.#lastChild.pop();
    this.#members.pop();
    this.#store.end[node] = pos + 1;
    return pos + 1;
  }

  /** Adds a value under `parent`, which is the innermost open container or none. */
  #add(
    kind: number,
    start: number,
    end: number,
    parent: number,
    keyStart: number,
    keyEnd: number
  ): number {
    if (!this.#store.reserve()) {
      this.#failure = { kind: 'too-many-nodes', limit: JSON_TREE_MAX_NODES };
      return NONE;
    }
    const store = this.#store;
    const node = store.count;
    store.count += 1;
    store.kind[node] = kind;
    store.start[node] = start;
    store.end[node] = end;
    store.parent[node] = parent;
    store.firstChild[node] = NONE;
    store.nextSibling[node] = NONE;
    store.childCount[node] = 0;
    const depth = this.#open.length;
    store.depth[node] = depth;
    if (depth > store.maxDepth) store.maxDepth = depth;

    let flags = 0;
    if (keyStart !== NONE) {
      flags |= FLAG_HAS_KEY;
      store.keyStart[node] = keyStart;
      store.keyEnd[node] = keyEnd;
    }
    store.flags[node] = flags;

    if (parent !== NONE) {
      const slot = this.#open.length - 1;
      store.index[node] = store.childCount[parent] ?? 0;
      store.childCount[parent] = (store.childCount[parent] ?? 0) + 1;
      const previous = this.#lastChild[slot] ?? NONE;
      if (previous === NONE) {
        store.firstChild[parent] = node;
      } else {
        store.nextSibling[previous] = node;
      }
      this.#lastChild[slot] = node;
      if (keyStart !== NONE) this.#registerKey(slot, node, keyStart, keyEnd);
    }
    return node;
  }

  /** Records a member's key. A repeat shadows the earlier member. */
  #registerKey(
    slot: number,
    node: number,
    keyStart: number,
    keyEnd: number
  ): void {
    let keys = this.#members[slot];
    if (keys === undefined) {
      keys = new Map<string, number>();
      this.#members[slot] = keys;
    }
    const text = jsonStringValue(this.#source.slice(keyStart, keyEnd));
    const earlier = keys.get(text);
    keys.set(text, node);
    this.#store.flags[node] = (this.#store.flags[node] ?? 0) | FLAG_DUPLICATED;
    if (earlier !== undefined) {
      this.#store.flags[earlier] =
        (this.#store.flags[earlier] ?? 0) | FLAG_SHADOWED | FLAG_DUPLICATED;
      this.#store.shadowed += 1;
    }
  }

  #skip(pos: number): number {
    const src = this.#source;
    let at = pos;
    while (at < src.length && isWhitespace(src.charCodeAt(at))) at += 1;
    return at;
  }

  #syntaxFailure(pos: number, reason: string): JsonTreeFailure {
    const [line, column] = lineAndColumn(this.#source, pos);
    return { kind: 'syntax', line, column, reason };
  }

  #syntax(pos: number, reason: string): JsonTreeResult {
    return refused(this.#syntaxFailure(pos, reason));
  }

  #refuse(): JsonTreeResult {
    return refused(
      this.#failure ?? this.#syntaxFailure(0, 'the file could not be read')
    );
  }
}
