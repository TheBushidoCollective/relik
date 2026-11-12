import { describe, expect, test } from 'bun:test';
import { normalizeEmail } from '../src/index.ts';

describe('normalizeEmail', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeEmail('  ada@example.com\t')).toBe('ada@example.com');
  });

  test('lowercases ASCII letters', () => {
    expect(normalizeEmail('Ada.Lovelace@Example.COM')).toBe(
      'ada.lovelace@example.com'
    );
  });

  test('leaves non-ASCII letters exactly as typed', () => {
    expect(normalizeEmail('ÉLISE@Exämple.com')).toBe('Élise@exämple.com');
  });

  test('does not remove whitespace inside the address', () => {
    expect(normalizeEmail('a b@example.com')).toBe('a b@example.com');
  });

  test('is idempotent', () => {
    const once = normalizeEmail(' X+Tag@Mail.Example ');
    expect(normalizeEmail(once)).toBe(once);
  });
});
