/**
 * Lossless OTIO JSON parser and serializer with raw numeric token preservation.
 *
 * OpenTimelineIO documents may contain:
 * - 64-bit signed/unsigned integers in metadata (e.g. 9223372036854775807)
 *   which exceed JavaScript's Number.MAX_SAFE_INTEGER (9007199254740991).
 * - Non-finite float tokens emitted by Python OTIO (NaN, Infinity, -Infinity)
 *   which standard JSON.parse rejects.
 *
 * Strict security:
 * - Safe null-prototype objects (Object.create(null)) to prevent __proto__ prototype pollution.
 * - Strict JSON number grammar: rejects leading zeros (012), trailing decimals (12.),
 *   multiple decimals (1.2.3), and malformed exponent signs.
 * - Strict non-finite token boundaries (rejects NaN123, InfinityFoo).
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

const STRICT_NUMBER_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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
        const nextCode = text.charCodeAt(index + 4);
        if (isDelimiter(nextCode)) {
          index += 4;
          return null;
        }
      }
    }
    return parseNumberOrSpecial();
  }

  function isDelimiter(code: number): boolean {
    return (
      Number.isNaN(code) ||
      code === 0x20 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x2c || // ','
      code === 0x5d || // ']'
      code === 0x7d || // '}'
      code === 0x3a // ':'
    );
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

    // Strict check for non-finite tokens
    if (text.startsWith('NaN', index)) {
      if (isDelimiter(text.charCodeAt(index + 3))) {
        index += 3;
        return new OtioRawNumber('NaN', NaN);
      }
      throw new SyntaxError(`Malformed non-finite token at index ${index}`);
    }
    if (text.startsWith('Infinity', index)) {
      if (isDelimiter(text.charCodeAt(index + 8))) {
        index += 8;
        return new OtioRawNumber('Infinity', Infinity);
      }
      throw new SyntaxError(`Malformed non-finite token at index ${index}`);
    }
    if (text.startsWith('+Infinity', index)) {
      if (isDelimiter(text.charCodeAt(index + 9))) {
        index += 9;
        return new OtioRawNumber('+Infinity', Infinity);
      }
      throw new SyntaxError(`Malformed non-finite token at index ${index}`);
    }
    if (text.startsWith('-Infinity', index)) {
      if (isDelimiter(text.charCodeAt(index + 9))) {
        index += 9;
        return new OtioRawNumber('-Infinity', -Infinity);
      }
      throw new SyntaxError(`Malformed non-finite token at index ${index}`);
    }

    // Read until delimiter
    while (index < length && !isDelimiter(text.charCodeAt(index))) {
      index++;
    }

    const token = text.slice(start, index);
    if (!STRICT_NUMBER_REGEX.test(token)) {
      throw new SyntaxError(
        `Malformed JSON number token: ${token} at position ${start}`
      );
    }

    const num = Number(token);
    const isInteger =
      !token.includes('.') && !token.includes('e') && !token.includes('E');

    if (
      isInteger &&
      (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER)
    ) {
      return new OtioRawNumber(token, num);
    }

    if (!Number.isFinite(num)) {
      return new OtioRawNumber(token, num);
    }

    return num;
  }

  function parseBoolean(): boolean {
    if (text.startsWith('true', index)) {
      if (isDelimiter(text.charCodeAt(index + 4))) {
        index += 4;
        return true;
      }
    }
    if (text.startsWith('false', index)) {
      if (isDelimiter(text.charCodeAt(index + 5))) {
        index += 5;
        return false;
      }
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
    // Create null-prototype object to prevent prototype pollution (__proto__)
    const obj: Record<string, unknown> = Object.create(null);
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

      // Safely assign property without prototype pollution
      Object.defineProperty(obj, key, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });

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
