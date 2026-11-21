export interface CssUrl {
  readonly url: string;
  /** Offsets of the URL contents, excluding quotes and the url() wrapper. */
  readonly start: number;
  readonly end: number;
}

const cssWhitespace = (char: string | undefined): boolean =>
  char === ' ' ||
  char === '\t' ||
  char === '\n' ||
  char === '\r' ||
  char === '\f';
const hexDigit = (char: string | undefined): boolean =>
  char !== undefined && /[0-9a-f]/i.test(char);
const nameChar = (char: string | undefined): boolean =>
  char !== undefined &&
  (/[a-z0-9_-]/i.test(char) || char.charCodeAt(0) >= 0x80);

function cssEscape(
  text: string,
  at: number
): { value: string; end: number } | undefined {
  const next = text[at + 1];
  if (next === undefined) return undefined;
  if (next === '\n' || next === '\f') return { value: '', end: at + 2 };
  if (next === '\r')
    return { value: '', end: at + (text[at + 2] === '\n' ? 3 : 2) };
  if (!hexDigit(next)) return { value: next, end: at + 2 };
  let end = at + 1;
  while (end < text.length && end < at + 7 && hexDigit(text[end])) end++;
  let code = Number.parseInt(text.slice(at + 1, end), 16);
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
    code = 0xfffd;
  if (cssWhitespace(text[end])) {
    if (text[end] === '\r' && text[end + 1] === '\n') end++;
    end++;
  }
  return { value: String.fromCodePoint(code), end };
}

function cssString(
  text: string,
  at: number
): { value: string; start: number; end: number; next: number } | undefined {
  const quote = text[at];
  const start = at + 1;
  let value = '';
  at = start;
  while (at < text.length) {
    const char = text[at]!;
    if (char === quote) return { value, start, end: at, next: at + 1 };
    if (char === '\n' || char === '\r' || char === '\f') return undefined;
    if (char === '\\') {
      const escaped = cssEscape(text, at);
      if (!escaped) return undefined;
      value += escaped.value;
      at = escaped.end;
    } else {
      value += char;
      at++;
    }
  }
  return undefined;
}

/** Collect CSS URL tokens, while skipping comments and ordinary quoted text. */
export function scanCssUrls(text: string): {
  urls: readonly CssUrl[];
  opaque: boolean;
} {
  const urls: CssUrl[] = [];
  const functions: string[] = [];
  let opaque = false;
  let at = 0;
  while (at < text.length) {
    if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      if (end < 0) return { urls, opaque: true };
      at = end + 2;
      continue;
    }
    const char = text[at]!;
    if (char === '"' || char === "'") {
      const string = cssString(text, at);
      if (!string) return { urls, opaque: true };
      if (
        ['image-set', '-webkit-image-set', 'image'].includes(
          functions.at(-1) ?? ''
        )
      ) {
        urls.push({ url: string.value, start: string.start, end: string.end });
      }
      at = string.next;
      continue;
    }
    if (char === ')') {
      functions.pop();
      at++;
      continue;
    }
    if (char === '(') {
      functions.push('');
      at++;
      continue;
    }
    if (!nameChar(char) && char !== '\\') {
      at++;
      continue;
    }
    const nameStart = at;
    let name = '';
    while (at < text.length && (nameChar(text[at]) || text[at] === '\\')) {
      if (text[at] === '\\') {
        const escaped = cssEscape(text, at);
        if (!escaped || escaped.value === '') return { urls, opaque: true };
        name += escaped.value;
        at = escaped.end;
      } else {
        name += text[at++];
      }
    }
    name = name.toLowerCase();
    if (name === 'import' && text[nameStart - 1] === '@') opaque = true;
    if (text[at] !== '(') continue;
    at++;
    if (name !== 'url') {
      if (
        [
          'var',
          'env',
          'attr',
          'src',
          'cross-fade',
          '-webkit-cross-fade',
        ].includes(name)
      )
        opaque = true;
      functions.push(name);
      continue;
    }
    while (cssWhitespace(text[at])) at++;
    if (text[at] === '"' || text[at] === "'") {
      const string = cssString(text, at);
      if (!string) return { urls, opaque: true };
      at = string.next;
      while (cssWhitespace(text[at])) at++;
      if (text[at] !== ')') return { urls, opaque: true };
      urls.push({ url: string.value, start: string.start, end: string.end });
      at++;
      continue;
    }
    const start = at;
    let value = '';
    while (at < text.length && text[at] !== ')' && !cssWhitespace(text[at])) {
      if (text[at] === '\\') {
        const escaped = cssEscape(text, at);
        if (!escaped || escaped.value === '') return { urls, opaque: true };
        value += escaped.value;
        at = escaped.end;
      } else if (
        text[at] === '"' ||
        text[at] === "'" ||
        text[at] === '(' ||
        text.charCodeAt(at) < 0x20
      ) {
        return { urls, opaque: true };
      } else {
        value += text[at++];
      }
    }
    const end = at;
    while (cssWhitespace(text[at])) at++;
    if (text[at] !== ')') return { urls, opaque: true };
    urls.push({ url: value, start, end });
    at++;
  }
  if (functions.length) opaque = true;
  return { urls, opaque };
}

/** Apply the URL parser's ASCII whitespace normalization without changing its content. */
export function normalizeUrl(url: string): string {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  return url.slice(start, end).replace(/[\t\n\r]/g, '');
}

/** Decode a data URL to its MIME essence and bytes. Non-data URLs return undefined. */
export function parseDataUrl(
  url: string
): { essence: string; bytes: Uint8Array } | 'invalid' | undefined {
  url = normalizeUrl(url);
  if (!/^data:/i.test(url)) return undefined;
  const comma = url.indexOf(',');
  if (comma < 0) return 'invalid';
  let header = url.slice(5, comma).trim();
  const base64 = /;[\t\n\r\f ]*base64$/i.test(header);
  if (base64) header = header.replace(/;[\t\n\r\f ]*base64$/i, '');
  const essence = (
    header.split(';', 1)[0]!.trim() || 'text/plain'
  ).toLowerCase();
  const end = url.indexOf('#', comma + 1);
  const encoded = new TextEncoder().encode(
    url.slice(comma + 1, end < 0 ? undefined : end)
  );
  let length = 0;
  for (let at = 0; at < encoded.length; at++) {
    const first = encoded[at + 1];
    const second = encoded[at + 2];
    if (
      encoded[at] === 0x25 &&
      first !== undefined &&
      second !== undefined &&
      hexDigit(String.fromCharCode(first)) &&
      hexDigit(String.fromCharCode(second))
    ) {
      encoded[length++] = Number.parseInt(
        String.fromCharCode(first, second),
        16
      );
      at += 2;
    } else {
      encoded[length++] = encoded[at]!;
    }
  }
  const bytes = encoded.subarray(0, length);
  if (!base64) return { essence, bytes };
  try {
    let encodedBase64 = '';
    for (let at = 0; at < bytes.length; at++)
      encodedBase64 += String.fromCharCode(bytes[at]!);
    const decoded = atob(encodedBase64);
    const result = new Uint8Array(decoded.length);
    for (let at = 0; at < decoded.length; at++)
      result[at] = decoded.charCodeAt(at);
    return { essence, bytes: result };
  } catch {
    return 'invalid';
  }
}
