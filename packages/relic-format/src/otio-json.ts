/**
 * Lossless OTIO JSON parser and serializer with raw numeric token preservation.
 *
 * OpenTimelineIO documents may contain:
 * - 64-bit signed/unsigned integers in metadata (e.g. 9223372036854775807)
 *   which exceed JavaScript's Number.MAX_SAFE_INTEGER (9007199254740991).
 * - Non-finite float tokens emitted by Python OTIO (NaN, Infinity, -Infinity)
 *   which standard JSON.parse rejects.
 *
 * This module preserves exact tokens during parsing and re-serialization
 * so that packaged documents and metadata survive without silent corruption.
 */

export class OtioRawNumber {
  readonly raw: string;
  readonly numericValue: number;

  constructor(raw: string, numericValue?: number) {
    this.raw = raw;
    if (numericValue !== undefined) {
      this.numericValue = numericValue;
    } else {
      if (raw === 'NaN') {
        this.numericValue = NaN;
      } else if (raw === 'Infinity' || raw === '+Infinity') {
        this.numericValue = Infinity;
      } else if (raw === '-Infinity') {
        this.numericValue = -Infinity;
      } else {
        this.numericValue = Number(raw);
      }
    }
  }

  valueOf(): number {
    return this.numericValue;
  }

  toString(): string {
    return this.raw;
  }

  toJSON(): string {
    return this.raw;
  }
}

export function isOtioRawNumber(value: unknown): value is OtioRawNumber {
  return (
    typeof value === 'object' &&
    value !== null &&
    value instanceof OtioRawNumber
  );
}

export function parseOtioJson(input: string | Uint8Array): unknown {
  const text =
    typeof input === 'string'
      ? input
      : new TextDecoder('utf-8', { fatal: false }).decode(input);

  let index = 0;
  const length = text.length;

  function skipWhitespace(): void {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        index++;
      } else {
        break;
      }
    }
  }

  function parseValue(): unknown {
    skipWhitespace();
    if (index >= length) {
      throw new SyntaxError('Unexpected end of JSON input');
    }

    const char = text[index];
    if (char === '{') {
      return parseObject();
    }
    if (char === '[') {
      return parseArray();
    }
    if (char === '"') {
      return parseString();
    }
    if (char === 't' || char === 'f') {
      return parseBoolean();
    }
    if (char === 'n') {
      if (text.startsWith('null', index)) {
        index += 4;
        return null;
      }
    }
    // Check for non-finite tokens or numbers
    return parseNumberOrSpecial();
  }

  function parseString(): string {
    index++; // skip opening '"'
    let result = '';
    let start = index;

    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        // '"'
        result += text.slice(start, index);
        index++;
        return result;
      }
      if (code === 0x5c) {
        // '\\'
        result += text.slice(start, index);
        index++;
        if (index >= length) {
          throw new SyntaxError('Unterminated string in JSON');
        }
        const esc = text[index++];
        switch (esc) {
          case '"':
            result += '"';
            break;
          case '\\':
            result += '\\';
            break;
          case '/':
            result += '/';
            break;
          case 'b':
            result += '\b';
            break;
          case 'f':
            result += '\f';
            break;
          case 'n':
            result += '\n';
            break;
          case 'r':
            result += '\r';
            break;
          case 't':
            result += '\t';
            break;
          case 'u': {
            if (index + 4 > length) {
              throw new SyntaxError('Invalid unicode escape in JSON');
            }
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new SyntaxError(`Invalid unicode hex in JSON: ${hex}`);
            }
            result += String.fromCharCode(parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            throw new SyntaxError(`Invalid escape sequence: \\${esc}`);
        }
        start = index;
        continue;
      }
      if (code < 0x20) {
        throw new SyntaxError(
          `Unescaped control character in string at index ${index}`
        );
      }
      index++;
    }
    throw new SyntaxError('Unterminated string in JSON');
  }

  function parseNumberOrSpecial(): unknown {
    const start = index;

    // Check for special tokens: NaN, Infinity, -Infinity
    if (text.startsWith('NaN', index)) {
      index += 3;
      return new OtioRawNumber('NaN', NaN);
    }
    if (text.startsWith('Infinity', index)) {
      index += 8;
      return new OtioRawNumber('Infinity', Infinity);
    }
    if (text.startsWith('+Infinity', index)) {
      index += 9;
      return new OtioRawNumber('+Infinity', Infinity);
    }
    if (text.startsWith('-Infinity', index)) {
      index += 9;
      return new OtioRawNumber('-Infinity', -Infinity);
    }

    if (text[index] === '-') {
      index++;
    }

    let isInteger = true;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code >= 0x30 && code <= 0x39) {
        index++;
      } else if (code === 0x2e) {
        // '.'
        isInteger = false;
        index++;
      } else if (code === 0x65 || code === 0x45) {
        // 'e' or 'E'
        isInteger = false;
        index++;
        if (index < length && (text[index] === '+' || text[index] === '-')) {
          index++;
        }
      } else {
        break;
      }
    }

    const token = text.slice(start, index);
    if (token === '' || token === '-') {
      throw new SyntaxError(`Unexpected token at position ${start}: ${token}`);
    }

    const num = Number(token);
    // If it's a large integer outside safe integer range:
    if (
      isInteger &&
      (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER)
    ) {
      return new OtioRawNumber(token, num);
    }

    // If Number(token) is not finite:
    if (!Number.isFinite(num)) {
      return new OtioRawNumber(token, num);
    }

    // Standard finite number
    return num;
  }

  function parseBoolean(): boolean {
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    throw new SyntaxError(`Unexpected token at position ${index}`);
  }

  function parseArray(): unknown[] {
    index++; // skip '['
    const array: unknown[] = [];
    skipWhitespace();
    if (index < length && text[index] === ']') {
      index++;
      return array;
    }

    while (index < length) {
      const val = parseValue();
      array.push(val);
      skipWhitespace();
      if (index >= length) {
        throw new SyntaxError('Unterminated array in JSON');
      }
      if (text[index] === ']') {
        index++;
        return array;
      }
      if (text[index] === ',') {
        index++;
        skipWhitespace();
      } else {
        throw new SyntaxError(
          `Expected ',' or ']' in array at position ${index}, got '${text[index]}'`
        );
      }
    }
    throw new SyntaxError('Unterminated array in JSON');
  }

  function parseObject(): Record<string, unknown> {
    index++; // skip '{'
    const obj: Record<string, unknown> = {};
    skipWhitespace();
    if (index < length && text[index] === '}') {
      index++;
      return obj;
    }

    while (index < length) {
      skipWhitespace();
      if (text[index] !== '"') {
        throw new SyntaxError(
          `Expected string key in object at position ${index}, got '${text[index]}'`
        );
      }
      const key = parseString();
      skipWhitespace();
      if (index >= length || text[index] !== ':') {
        throw new SyntaxError(
          `Expected ':' after key in object at position ${index}`
        );
      }
      index++; // skip ':'
      const val = parseValue();
      obj[key] = val;

      skipWhitespace();
      if (index >= length) {
        throw new SyntaxError('Unterminated object in JSON');
      }
      if (text[index] === '}') {
        index++;
        return obj;
      }
      if (text[index] === ',') {
        index++;
        skipWhitespace();
      } else {
        throw new SyntaxError(
          `Expected ',' or '}' in object at position ${index}, got '${text[index]}'`
        );
      }
    }
    throw new SyntaxError('Unterminated object in JSON');
  }

  const root = parseValue();
  skipWhitespace();
  if (index < length) {
    throw new SyntaxError(
      `Unexpected extra characters after JSON at position ${index}`
    );
  }
  return root;
}

export function stringifyOtioJson(
  value: unknown,
  indent?: number | string
): string {
  const indentStr =
    typeof indent === 'number'
      ? ' '.repeat(Math.max(0, indent))
      : typeof indent === 'string'
        ? indent
        : '';
  const isPretty = indentStr.length > 0;

  function serialize(val: unknown, currentIndent: string): string {
    if (val === null || val === undefined) {
      return 'null';
    }
    if (typeof val === 'boolean') {
      return val ? 'true' : 'false';
    }
    if (val instanceof OtioRawNumber) {
      return val.raw;
    }
    if (typeof val === 'number') {
      if (isNaN(val)) return 'NaN';
      if (val === Infinity) return 'Infinity';
      if (val === -Infinity) return '-Infinity';
      return String(val);
    }
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (typeof val === 'string') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      if (!isPretty) {
        return '[' + val.map((item) => serialize(item, '')).join(',') + ']';
      }
      const nextIndent = currentIndent + indentStr;
      const items = val
        .map((item) => nextIndent + serialize(item, nextIndent))
        .join(',\n');
      return '[\n' + items + '\n' + currentIndent + ']';
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) return '{}';
      if (!isPretty) {
        const entries = keys.map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            serialize((val as Record<string, unknown>)[k], '')
        );
        return '{' + entries.join(',') + '}';
      }
      const nextIndent = currentIndent + indentStr;
      const entries = keys
        .map(
          (k) =>
            nextIndent +
            JSON.stringify(k) +
            ': ' +
            serialize((val as Record<string, unknown>)[k], nextIndent)
        )
        .join(',\n');
      return '{\n' + entries + '\n' + currentIndent + '}';
    }
    return JSON.stringify(val);
  }

  return serialize(value, '');
}
