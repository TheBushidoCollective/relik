import { describe, expect, test } from 'bun:test';
import { parseJsonTree } from '@relic/format';
import { pathAnchorAdapter } from '../src/annotate-path.ts';
import { cellAnchorAdapter } from '../src/annotate-cell.ts';
import { JsonTreeState, keyLabel, visibleText } from '../src/json-tree-rows.ts';
import { clipboardText } from '../src/data-table.ts';
import { visibleLabel, LABEL_DISPLAY_LIMIT } from '../src/visible-label.ts';

/**
 * Unit guards for the structured-view fixes (security review SF-UNCAPPED-
 * REDRAW, SF-BIDI-LABELS, SF-CLIPBOARD-RAW, SF-POINTER-UNWRITABLE). The
 * browser proof is in structured-fixes-browser.test.ts; these pin the pure
 * helpers so a regression names the helper that broke.
 */

function tree(source: string) {
  const parsed = parseJsonTree(source);
  if (!parsed.ok) throw new Error(`fixture refused: ${parsed.failure.kind}`);
  return parsed.tree;
}

describe('labels escape bidi and are cut to a fixed length', () => {
  test('a stored path pointer with U+202E shows as an escape in the label', () => {
    const label = pathAnchorAdapter.label({
      kind: 'path',
      pointer: '/\u202Efdp.exe',
    });
    expect(label).toBe('Commenting on /\\u202efdp.exe');
    expect(label).not.toContain('\u202e');
  });

  test('a sheet name with a bidi control shows as an escape', () => {
    const label = cellAnchorAdapter.label({
      kind: 'cell',
      row: 1,
      col: 1,
      sheet: 'Q3\u202E',
    });
    expect(label).toBe('Commenting on cell A1 of Q3\\u202e');
  });

  test('a long label is cut and ends in an ellipsis', () => {
    const shown = visibleLabel('x'.repeat(10_000));
    expect(shown.length).toBe(LABEL_DISPLAY_LIMIT + 1);
    expect(shown.endsWith('…')).toBe(true);
  });

  test('a control character is written as an escape, never raw', () => {
    expect(visibleText('a\u001bb')).toBe('a\\u001bb');
    expect(visibleText('plain')).toBe('plain');
  });
});

describe('a key is shown capped, and its full text is kept for the pointer', () => {
  test('a 1 MB key is cut to the value cut for display', () => {
    const big = 'k'.repeat(1 << 20);
    const t = tree(`{"${big}":1}`);
    const label = keyLabel(t, 1);
    expect(label.length).toBeLessThanOrEqual(514);
    expect(label.endsWith('…')).toBe(true);
    // A pointer over the 512-byte cap is not anchored at all, so no comment.
    expect(t.pointer(1)).toBeUndefined();
  });
});

describe('copied text is escaped, with tab and LF kept', () => {
  test('ESC and LF in a cell: the ESC is escaped, the LF stays', () => {
    expect(clipboardText('\u001b[201~\nid')).toBe('\\u{1B}[201~\nid');
  });

  test('CR and bidi controls are escaped; tab stays', () => {
    expect(clipboardText('a\rb\tc\u202Ed')).toBe('a\\u{D}b\tc\\u{202E}d');
  });
});

describe('a pointer the writer refuses gets no comment anchor', () => {
  test('a key holding a CR has no selection anchor', () => {
    const state = new JsonTreeState(tree('{"a\\rb":1}'));
    state.select(1);
    expect(state.selectionAnchor()).toBeUndefined();
  });

  test('a key holding a NUL has no selection anchor', () => {
    const state = new JsonTreeState(tree('{"a\\u0000b":1}'));
    state.select(1);
    expect(state.selectionAnchor()).toBeUndefined();
  });

  test('an ordinary key still anchors', () => {
    const state = new JsonTreeState(tree('{"a":1}'));
    state.select(1);
    expect(state.selectionAnchor()).toEqual({ kind: 'path', pointer: '/a' });
  });
});
