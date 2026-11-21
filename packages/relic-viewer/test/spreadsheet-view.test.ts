import { expect, test } from 'bun:test';
import { selectHiddenSheet, sourceFor } from '../src/spreadsheet-view.ts';

test('hidden sheet menu selects the requested sheet and ignores its placeholder', () => {
  const selected: number[] = [];
  selectHiddenSheet('', (index) => selected.push(index));
  expect(selected).toEqual([]);
  selectHiddenSheet('3', (index) => selected.push(index));
  expect(selected).toEqual([3]);
});

test('sparse table lookup and column classification use populated rows', () => {
  const source = sourceFor({
    name: 'Sparse',
    state: 'visible',
    kind: 'worksheet',
    rows: 600000,
    columns: 2,
    rowNumbers: new Uint32Array([0, 599999]),
    rowStart: new Uint32Array([0, 1, 2]),
    cells: new Uint32Array([0, 0, 1, 1, 1, 2]),
    numbers: new Float64Array([NaN, 42]),
    texts: ['Header', '42'],
    details: [{ type: 'text' }, { type: 'number' }],
  });
  expect(source.text(1, 1)).toBe('');
  expect(source.text(599999, 1)).toBe('42');
  expect(source.numericColumn?.(1, true)).toBe(true);
  expect(source.matchingColumns?.(599999, '42', 2, 10)).toEqual([1]);
  expect(source.matchingColumns?.(200000, '42', 2, 10)).toEqual([]);
});

test('find checks each shared text once per query and resets for a new query', () => {
  let reads = 0;
  const texts = ['shared value'];
  Object.defineProperty(texts, '0', {
    get() {
      reads++;
      return 'shared value';
    },
  });
  const source = sourceFor({
    name: 'Shared',
    state: 'visible',
    kind: 'worksheet',
    rows: 2,
    columns: 1,
    rowNumbers: new Uint32Array([0, 1]),
    rowStart: new Uint32Array([0, 1, 2]),
    cells: new Uint32Array([0, 0, 1, 0, 0, 1]),
    numbers: new Float64Array([NaN, NaN]),
    texts,
    details: [{ type: 'text' }],
  });
  expect(source.matchingColumns?.(0, 'missing', 1, 10)).toEqual([]);
  expect(source.matchingColumns?.(1, 'missing', 1, 10)).toEqual([]);
  expect(reads).toBe(1);
  expect(source.matchingColumns?.(1, 'shared', 1, 10)).toEqual([0]);
  expect(reads).toBe(2);
});
