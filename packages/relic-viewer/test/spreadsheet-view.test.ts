import { expect, test } from 'bun:test';
import { selectHiddenSheet } from '../src/spreadsheet-view.ts';

test('hidden sheet menu selects the requested sheet and ignores its placeholder', () => {
  const selected: number[] = [];
  selectHiddenSheet('', (index) => selected.push(index));
  expect(selected).toEqual([]);
  selectHiddenSheet('3', (index) => selected.push(index));
  expect(selected).toEqual([3]);
});
