import { describe, expect, test } from 'bun:test';
import { parseNotebook } from '@relic/format/notebook';
import {
  decodeNotebookText,
  encodeNotebookDraft,
  escapeNotebookText,
  notebookSourceUnits,
} from '../src/notebook-suggest.ts';

import { notebookSuggestionFixture } from './notebook-suggest-fixture.ts';

describe('notebook suggestion source', () => {
  test('maps each cell source token and preserves escaped characters', () => {
    const parsed = parseNotebook(notebookSuggestionFixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const cell of parsed.notebook.cells) {
      const units = notebookSourceUnits(notebookSuggestionFixture, cell);
      expect(units.map((unit) => unit.text).join('')).toBe(cell.source.text);
      for (const unit of units) {
        expect(
          JSON.parse(
            `"${notebookSuggestionFixture.slice(unit.start, unit.end)}"`
          )
        ).toBe(unit.text);
        expect(unit.start).toBeGreaterThanOrEqual(
          cell.sourceTokens[unit.token]!.start + 1
        );
        expect(unit.end).toBeLessThan(cell.sourceTokens[unit.token]!.end);
      }
    }
    const code = parsed.notebook.cells[1]!;
    expect(code.sourceTokens).toHaveLength(2);
    expect(code.outputs[0]!.start).toBeGreaterThan(code.sourceTokens[1]!.end);
  });

  test('replacement remains in its JSON string', () => {
    const typed = 'quote " slash \\ and newline\nnext';
    const encoded = escapeNotebookText(typed);
    expect(decodeNotebookText(encoded)).toBe(typed);
    expect(decodeNotebookText('bad\\')).toBe('bad\\');
    expect(JSON.parse(`{"source":"${encoded}","outputs":[]}`)).toEqual({
      source: typed,
      outputs: [],
    });
    expect(() => JSON.parse(`{"source":"${typed}","outputs":[]}`)).toThrow();
    const parsed = parseNotebook(notebookSuggestionFixture);
    if (!parsed.ok) throw new Error('fixture was refused');
    const [first, second] = parsed.notebook.cells[1]!.sourceTokens;
    expect(
      encodeNotebookDraft(typed, first!.start + 1, first!.end - 1, first)
    ).toEqual({ ok: true, source: encoded });
    expect(
      encodeNotebookDraft(typed, first!.start + 1, second!.start + 1, first).ok
    ).toBe(false);
    expect(
      encodeNotebookDraft(typed, first!.start, first!.start + 1, first).ok
    ).toBe(false);
  });
});
