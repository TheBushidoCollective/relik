import { describe, expect, test } from 'bun:test';
import { parseWritableCommentAnchor } from '../src/comments.ts';

const cellWithSheet = (sheet: string) =>
  parseWritableCommentAnchor({ kind: 'cell', row: 1, col: 1, sheet });

describe('sheet names: a name a label cannot show is refused by reader and writer alike', () => {
  test('ordinary names still parse', () => {
    for (const sheet of ['Sheet 1', 'Données', 'Q1 2026 (draft)', '表1']) {
      expect(cellWithSheet(sheet)).toMatchObject({ kind: 'cell', sheet });
    }
  });

  test('the old refusals still hold: C0, DEL and the bidi embeddings and isolates', () => {
    for (const sheet of ['a\u0007b', 'a\u007fb', 'a\u202eb', 'a\u2066b']) {
      expect(() => cellWithSheet(sheet)).toThrow();
    }
  });

  test('the newly refused set is the C1 block, the Arabic letter mark, LRM and RLM, and the line separators', () => {
    for (const sheet of [
      'a\u0085b',
      'a\u009fb',
      'a\u061cb',
      'a\u200eb',
      'a\u200fb',
      'a\u2028b',
      'a\u2029b',
    ]) {
      expect(() => cellWithSheet(sheet)).toThrow();
    }
  });

  test('characters outside the invisible set are not refused', () => {
    for (const sheet of ['a\u200bb', 'a\u200db', 'a\u00a0b', 'a\u202fb']) {
      expect(cellWithSheet(sheet)).toMatchObject({ kind: 'cell', sheet });
    }
  });
});
