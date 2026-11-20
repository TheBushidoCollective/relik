import { describe, expect, test } from 'bun:test';
import {
  normalizeCrLf,
  restoreCrLf,
  SUGGESTION_SOURCE_LIMIT_BYTES,
  suggestionSourceFor,
} from '../src/suggestions.ts';
import { structuredKindFor } from '../../relic-viewer/src/structured-view-bridge.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('normalized suggestion sources', () => {
  test('accepts uniformly CRLF tables and cues with extension precedence', () => {
    for (const [name, mime] of [
      ['data.csv', 'text/markdown'],
      ['data.tsv', 'application/octet-stream'],
      ['data.srt', ''],
      ['data.vtt', ''],
      ['data.unknown', 'text/csv; charset=utf-8'],
      ['captions', 'text/vtt'],
    ]) {
      expect(
        suggestionSourceFor(bytes('one,two\r\nthree,four\r\n'), name!, mime)
      ).toEqual({
        ok: true,
        source: 'one,two\nthree,four\n',
        bom: false,
        crlf: true,
      });
    }
    expect(
      suggestionSourceFor(bytes('a\r\nb'), 'data.json', 'text/csv')
    ).toEqual({ ok: false, reason: 'has_cr' });
    expect(
      suggestionSourceFor(bytes('a\r\nb'), 'data.csv', 'text/markdown')
    ).toMatchObject({ ok: true, crlf: true });
  });

  test('matches the structured-view filename and type classifier for CRLF', () => {
    for (const name of [
      'x.csv',
      'x.tsv',
      'x.json',
      'x.srt',
      'x.vtt',
      'x.txt',
      'x.constructor',
    ]) {
      for (const mime of [
        '',
        'text/csv',
        'text/vtt',
        'application/json',
        'text/markdown',
      ]) {
        const kind = structuredKindFor(name, mime);
        const result = suggestionSourceFor(bytes('a\r\nb'), name, mime);
        expect(result.ok).toBe(kind === 'table' || kind === 'cues');
      }
    }
  });

  test('rejects lone CR, mixed endings, NUL and malformed UTF-8', () => {
    for (const name of ['notes.md', 'tree.json', 'notes.ipynb'])
      expect(suggestionSourceFor(bytes('a\r\nb'), name)).toEqual({
        ok: false,
        reason: 'has_cr',
      });
    expect(suggestionSourceFor(bytes('a\rb'), 'data.csv')).toEqual({
      ok: false,
      reason: 'has_cr',
    });
    expect(suggestionSourceFor(bytes('a\r\nb\nc'), 'data.csv')).toEqual({
      ok: false,
      reason: 'mixed_line_endings',
    });
    expect(suggestionSourceFor(bytes('a\0b'), 'data.csv')).toEqual({
      ok: false,
      reason: 'has_nul',
    });
    expect(
      suggestionSourceFor(new Uint8Array([0xc3, 0x28]), 'data.csv')
    ).toEqual({ ok: false, reason: 'not_utf8' });
  });

  test('preserves BOM semantics and enforces the exact 1 MiB limit', () => {
    expect(
      suggestionSourceFor(bytes('\ufeff\ufeffa\r\nb'), 'data.csv')
    ).toEqual({ ok: true, source: '\ufeffa\nb', bom: true, crlf: true });
    expect(suggestionSourceFor(bytes('a\nb'), 'data.csv')).toEqual({
      ok: true,
      source: 'a\nb',
      bom: false,
      crlf: false,
    });
    expect(
      suggestionSourceFor(
        new Uint8Array(SUGGESTION_SOURCE_LIMIT_BYTES).fill(97),
        'x.csv'
      ).ok
    ).toBe(true);
    expect(
      suggestionSourceFor(
        new Uint8Array(SUGGESTION_SOURCE_LIMIT_BYTES + 1),
        'x.csv'
      )
    ).toEqual({ ok: false, reason: 'too_large' });
  });

  test('round trips the exact bytes of uniformly CRLF CSV data', () => {
    for (const bom of ['', '\ufeff']) {
      const original =
        bom +
        Array.from(
          { length: 2000 },
          (_, index) => `${index},"café ${index % 7}",${index % 3}\r\n`
        ).join('');
      const decoded = suggestionSourceFor(bytes(original), 'data.csv');
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error(decoded.reason);
      expect(decoded.crlf).toBe(true);
      expect(decoded.source).not.toContain('\r');
      expect(
        bytes((decoded.bom ? '\ufeff' : '') + restoreCrLf(decoded.source))
      ).toEqual(bytes(original));
      expect(restoreCrLf(normalizeCrLf(original))).toBe(original);
    }
  });
});
