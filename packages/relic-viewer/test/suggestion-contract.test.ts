import { describe, expect, test } from 'bun:test';
import { SuggestDraftModel } from '../src/suggest-draft.ts';
import type { SourceSegment } from '../src/markdown-source.ts';

function model(
  source: string,
  segments: SourceSegment[],
  crlf = false
): SuggestDraftModel {
  return new SuggestDraftModel({
    source,
    segments,
    delimiters: [],
    version: 1,
    reader: 'reader@example.test',
    crlf,
  });
}

describe('structured suggestion contract', () => {
  test('escape spans can only be selected, deleted and anchored whole', () => {
    const source = 'A\\u0042C';
    const segments: SourceSegment[] = [
      { text: 'A', start: 0, end: 1, block: 0, kind: 'text' },
      { text: 'B', start: 1, end: 7, block: 0, kind: 'escape' },
      { text: 'C', start: 7, end: 8, block: 0, kind: 'text' },
    ];
    expect(model(source, segments).replace(2, 3, 'x', 'nb-code')).toMatchObject(
      { kind: 'refused', code: 'crosses-formatting' }
    );
    expect(model(source, segments).replace(2, 2, 'x', 'nb-code')).toMatchObject(
      { kind: 'refused', code: 'crosses-formatting' }
    );
    const whole = model(source, segments);
    expect(whole.replace(1, 7, 'x', 'nb-code').kind).toBe('changed');
    expect(whole.commit(null)).toMatchObject({
      kind: 'save',
      plaintext: { anchor: { exact: '\\u0042' } },
    });
    const insertion = model(source, segments);
    expect(insertion.replace(7, 7, 'x', 'nb-code').kind).toBe('changed');
    expect(insertion.commit(null)).toMatchObject({
      kind: 'save',
      plaintext: {
        anchor: { exact: '\\u0042' },
        suggestion: { mode: 'after' },
      },
    });
  });

  test('CRLF source refuses new line breaks but can delete an existing one', () => {
    const source = 'A\nB';
    const segments: SourceSegment[] = [
      { text: source, start: 0, end: source.length, block: 0, kind: 'text' },
    ];
    const draft = model(source, segments, true);
    expect(draft.replace(0, 1, 'x\ny', 'csv-quoted')).toMatchObject({
      kind: 'refused',
      code: 'line-break-in-crlf-file',
    });
    expect(draft.replace(0, 1, '\r\n', 'csv-quoted')).toMatchObject({
      kind: 'refused',
      code: 'line-break-in-crlf-file',
    });
    expect(draft.enter(0, 0, 'csv-quoted')).toMatchObject({
      kind: 'refused',
      code: 'line-break-in-crlf-file',
    });
    const insertion = model(source, segments, true);
    expect(insertion.replace(0, 1, 'x', 'csv-quoted').kind).toBe('changed');
    for (const text of ['\r', '\n', '\r\n'])
      expect(insertion.editInsertion(0, 1, text, 'csv-quoted')).toMatchObject({
        kind: 'refused',
        code: 'line-break-in-crlf-file',
      });
    expect(insertion.draft?.inserted).toBe('x');
    expect(draft.replace(1, 2, '', 'csv-quoted').kind).toBe('changed');
    expect(draft.commit(null)).toMatchObject({
      kind: 'save',
      plaintext: { anchor: { exact: '\n' } },
    });
    expect(
      model(source, segments, false).replace(0, 1, 'x\ny', 'code').kind
    ).toBe('changed');
  });
});
