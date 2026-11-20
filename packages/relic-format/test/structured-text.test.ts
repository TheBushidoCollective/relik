import { describe, expect, test } from 'bun:test';
import {
  cutChars,
  escapeInvisible,
  findQuote,
  isInvisible,
  shortLabel,
} from '../src/structured-text.ts';

/** The quote search as it was before the linear rewrite: a restart at every occurrence. */
function findQuoteNaive(
  source: string,
  exact: string,
  prefix = '',
  suffix = ''
): number | undefined {
  if (exact.length === 0) return undefined;
  for (
    let at = source.indexOf(exact);
    at !== -1;
    at = source.indexOf(exact, at + 1)
  ) {
    const beforeOk =
      prefix.length === 0 ||
      (at >= prefix.length && source.slice(at - prefix.length, at) === prefix);
    if (beforeOk && source.startsWith(suffix, at + exact.length)) return at;
  }
  return undefined;
}

describe('isInvisible: one set for every view and the MCP transcript', () => {
  test('refuses the invisible and reordering characters, and only those', () => {
    const refused = [
      0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f,
      0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069,
    ];
    const shown = [
      0x09, 0x0a, 0x20, 0x41, 0x7e, 0xa0, 0xe9, 0x0600, 0x061b, 0x200b, 0x200d,
      0x202f, 0x2027, 0x2065, 0x206a, 0x1f600,
    ];
    for (const code of refused) expect(isInvisible(code)).toBe(true);
    for (const code of shown) expect(isInvisible(code)).toBe(false);
  });

  test('escapes each invisible character as its code point', () => {
    expect(escapeInvisible('a\u202eb\u0007c\r\nd\te\u0085')).toBe(
      'a[U+202E]b[U+0007]c[U+000D]\nd\te[U+0085]'
    );
  });
});

describe('findQuote: one linear search for prefix, exact and suffix', () => {
  test('finds the first occurrence with both context parts, as before', () => {
    expect(findQuote('ab ab ac', 'ab', ' ', ' ')).toBe(3);
    expect(findQuote('xyz', 'y', 'x', 'z')).toBe(1);
    expect(findQuote('xyz', 'y', 'z')).toBeUndefined();
    expect(findQuote('xyz', 'y')).toBe(1);
    expect(findQuote('xyz', '')).toBeUndefined();
  });

  test('agrees with the restart-per-occurrence search on random inputs', () => {
    let seed = 99;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 4000; round += 1) {
      const source = Array.from({ length: rand(40) }, () =>
        'ab-'.charAt(rand(3))
      ).join('');
      const start = rand(source.length + 1);
      const exact = source.slice(start, start + rand(4));
      const prefix = source.slice(0, rand(source.length + 1)).slice(-rand(3));
      const suffix = source.slice(rand(source.length + 1)).slice(0, rand(3));
      expect(findQuote(source, exact, prefix, suffix)).toBe(
        findQuoteNaive(source, exact, prefix, suffix)
      );
    }
  });

  test('a periodic array full of partial matches is searched in one pass', () => {
    // The review's fixture at four million pairs: about four million partial
    // matches of a 512-character quote. A restart at each one is what took
    // about 0.8 s at this size before the linear search.
    const source = `[${'0,'.repeat(4_000_000)}0]`;
    const exact = '0,'.repeat(256);
    const started = performance.now();
    expect(findQuote(source, exact, 'x')).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(300);
    expect(findQuote(source, exact, '[')).toBe(1);
  });
});

describe('cutChars and shortLabel: caps that hold before and after escaping', () => {
  test('a cut never splits a surrogate pair', () => {
    expect(cutChars(`a${'\u{1f600}'}`, 2)).toEqual({
      text: 'a',
      truncated: true,
    });
    expect(cutChars('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });

  test('a label is cut before escaping and again after, and line ends are normalised', () => {
    expect(shortLabel('x'.repeat(1000), 256)).toHaveLength(256);
    expect(shortLabel('\u0001'.repeat(300), 256)).toHaveLength(256);
    expect(shortLabel('a\r\nb', 256)).toBe('a\nb');
    expect(shortLabel('a\u061cb', 256)).toBe('a[U+061C]b');
  });
});
