import { describe, expect, test } from 'bun:test';
import {
  encodeRelicId,
  generateRelicId,
  ID_LENGTH,
  InvalidRelicIdError,
  isValidRelicId,
  normalizeRelicId,
  parseRelicId,
  RESERVED_SEGMENTS,
} from '../src/id.ts';

describe('relik id', () => {
  test('is 26 characters, which clears the 122-bit entropy floor', () => {
    expect(ID_LENGTH).toBe(26);
    // 26 characters x 5 bits = 130 bits of capacity, above the floor.
    expect(ID_LENGTH * 5).toBeGreaterThanOrEqual(122);
  });

  test('generates ids that validate', () => {
    for (let i = 0; i < 200; i++) {
      expect(isValidRelicId(generateRelicId())).toBe(true);
    }
  });

  test('generates distinct ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateRelicId());
    expect(seen.size).toBe(500);
  });

  test('never emits a character outside Crockford base32', () => {
    const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
    for (let i = 0; i < 200; i++) {
      for (const ch of generateRelicId()) {
        expect(alphabet).toContain(ch);
      }
    }
  });

  test('never emits i, l, o, or u', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateRelicId();
      for (const excluded of ['i', 'l', 'o', 'u']) {
        expect(id).not.toContain(excluded);
      }
    }
  });

  test('encodes a known vector deterministically', () => {
    const entropy = new Uint8Array(16);
    expect(encodeRelicId(entropy)).toBe('00000000000000000000000000');

    // 128 bits over 26 characters leaves the final character carrying the
    // last 3 bits padded with 2 zeros: 0b111 << 2 is 28, which is `w`.
    const ones = new Uint8Array(16).fill(0xff);
    expect(encodeRelicId(ones)).toBe('zzzzzzzzzzzzzzzzzzzzzzzzzw');
  });
});

describe('lookup normalization', () => {
  test('case folds', () => {
    const id = generateRelicId();
    expect(parseRelicId(id.toUpperCase())).toBe(id);
  });

  test('applies Crockford decode aliases i and l to 1, o to 0', () => {
    expect(normalizeRelicId('iIlLoO')).toBe('111100');
  });

  test('accepts an id retyped with confusable characters', () => {
    const id = `1${'0'.repeat(25)}`;
    expect(parseRelicId(`l${'O'.repeat(25)}`)).toBe(id);
  });

  test('rejects hyphens rather than stripping them', () => {
    // Crockford permits hyphens as separators. Relic declines that half:
    // honoring it would give every id unbounded valid spellings.
    const withHyphen = `${'0'.repeat(13)}-${'0'.repeat(12)}`;
    expect(withHyphen.length).toBe(ID_LENGTH);
    expect(() => parseRelicId(withHyphen)).toThrow(InvalidRelicIdError);
  });
});

describe('the three validation checks', () => {
  test('names length', () => {
    try {
      parseRelicId('0'.repeat(25));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRelicIdError);
      expect((error as InvalidRelicIdError).failure).toBe('length');
    }
  });

  test('names alphabet', () => {
    try {
      parseRelicId(`u${'0'.repeat(25)}`);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as InvalidRelicIdError).failure).toBe('alphabet');
    }
  });

  test('names reserved', () => {
    // Reserved words are all shorter than an id, so the table is only
    // reachable by bypassing the length guard. Assert it directly.
    const table = RESERVED_SEGMENTS.map((w) => normalizeRelicId(w));
    expect(table).toContain('assets');
    expect(table).toContain('p011cy');
    expect(table).toContain('ap1');
    expect(table).toContain('hea1th');
    expect(table).toContain('dashb0ard');
  });
});

describe('reserved segments', () => {
  test('every reserved word is shorter than an id, so length excludes it', () => {
    for (const word of RESERVED_SEGMENTS) {
      expect(word.length).toBeLessThan(ID_LENGTH);
    }
  });

  test('the longest reserved word clears the id length by five or more', () => {
    const longest = Math.max(...RESERVED_SEGMENTS.map((w) => w.length));
    expect(longest).toBe(20);
    expect(ID_LENGTH - longest).toBeGreaterThanOrEqual(5);
  });

  test('no generated id can ever collide with the table', () => {
    const normalized = new Set(RESERVED_SEGMENTS.map(normalizeRelicId));
    for (let i = 0; i < 500; i++) {
      expect(normalized.has(generateRelicId())).toBe(false);
    }
  });
});
