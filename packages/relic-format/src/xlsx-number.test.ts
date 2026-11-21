import { expect, test } from 'bun:test';
import { displayDate, displayNumber, numberKind } from './xlsx-number.ts';

test('time-only and elapsed formats retain raw serials instead of invented dates', () => {
  expect(numberKind(46)).toBe('number');
  expect(displayNumber(1.5, numberKind(46), false)).toBe('1.5');
  expect(numberKind(164, '[h]:mm')).toBe('number');
  expect(numberKind(164, 'yyyy-mm-dd')).toBe('date');
});

test('rounding a date time to midnight advances the calendar date', () => {
  expect(displayDate(61 + 86399.7 / 86400, false)).toBe('1900-03-02');
  expect(displayDate(59 + 86399.7 / 86400, false)).toBe('1900-02-29');
});

test('format classification ignores quoted, escaped and bracketed text', () => {
  expect(numberKind(164, '[Blue]"days"0%')).toBe('percent');
  expect(numberKind(164, '\\d0')).toBe('number');
  expect(numberKind(164, '0"percent%"')).toBe('number');
  expect(numberKind(164, '[unfinished')).toBe('number');
});
