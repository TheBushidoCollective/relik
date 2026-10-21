import { describe, expect, test } from 'bun:test';
import {
  isOtioRawNumber,
  OtioRawNumber,
  parseOtioJson,
  stringifyOtioJson,
} from '../src/otio-json.ts';

describe('otio-json token-preserving parser and serializer', () => {
  test('parses and preserves 64-bit integer metadata beyond MAX_SAFE_INTEGER', () => {
    const raw =
      '{"max_int64": 9223372036854775807, "min_int64": -9223372036854775808}';
    const parsed = parseOtioJson(raw) as Record<string, unknown>;

    expect(isOtioRawNumber(parsed['max_int64'])).toBe(true);
    expect(isOtioRawNumber(parsed['min_int64'])).toBe(true);

    const maxVal = parsed['max_int64'] as OtioRawNumber;
    const minVal = parsed['min_int64'] as OtioRawNumber;

    expect(maxVal.raw).toBe('9223372036854775807');
    expect(minVal.raw).toBe('-9223372036854775808');

    const reserialized = stringifyOtioJson(parsed);
    expect(reserialized).toContain('9223372036854775807');
    expect(reserialized).toContain('-9223372036854775808');
  });

  test('parses and preserves non-finite float tokens emitted by Python OTIO (NaN, Infinity, -Infinity)', () => {
    const raw = '{"nan": NaN, "inf": Infinity, "ninf": -Infinity}';
    const parsed = parseOtioJson(raw) as Record<string, unknown>;

    expect(isOtioRawNumber(parsed['nan'])).toBe(true);
    expect(isOtioRawNumber(parsed['inf'])).toBe(true);
    expect(isOtioRawNumber(parsed['ninf'])).toBe(true);

    const nanVal = parsed['nan'] as OtioRawNumber;
    const infVal = parsed['inf'] as OtioRawNumber;
    const ninfVal = parsed['ninf'] as OtioRawNumber;

    expect(nanVal.raw).toBe('NaN');
    expect(Number.isNaN(nanVal.numericValue)).toBe(true);

    expect(infVal.raw).toBe('Infinity');
    expect(infVal.numericValue).toBe(Infinity);

    expect(ninfVal.raw).toBe('-Infinity');
    expect(ninfVal.numericValue).toBe(-Infinity);

    const reserialized = stringifyOtioJson(parsed);
    expect(reserialized).toContain('NaN');
    expect(reserialized).toContain('Infinity');
    expect(reserialized).toContain('-Infinity');
  });

  test('parses standard JSON structures losslessly', () => {
    const input = {
      name: 'Timeline',
      rate: 24,
      nested: { enabled: true, score: 98.6 },
      items: [1, 2, 'three', null, false],
    };
    const jsonStr = JSON.stringify(input);
    const parsed = parseOtioJson(jsonStr);
    expect(parsed).toEqual(input);
    expect(stringifyOtioJson(parsed)).toBe(JSON.stringify(input));
  });

  test('handles strings with unicode and escape sequences', () => {
    const input =
      '{"escaped": "Line 1\\nLine 2\\t\\"quotes\\" and unicode: \\u0041"}';
    const parsed = parseOtioJson(input) as Record<string, string>;
    expect(parsed['escaped']).toBe('Line 1\nLine 2\t"quotes" and unicode: A');
  });

  test('rejects invalid UTF-8 instead of replacing bytes', () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect(() => parseOtioJson(bytes)).toThrow(TypeError);
  });

  test('rejects JSON nested past the depth bound', () => {
    const bomb = `${'['.repeat(80)}${']'.repeat(80)}`;
    expect(() => parseOtioJson(bomb)).toThrow(SyntaxError);
  });

  test('keeps __proto__ as an own key', () => {
    const parsed = parseOtioJson('{"__proto__": {"admin": true}, "constructor": 1}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed['constructor']).toBe(1);
  });
});
