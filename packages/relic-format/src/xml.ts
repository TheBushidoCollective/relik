export interface XmlElement {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly (XmlElement | string)[];
}
export type XmlFailure =
  | 'doctype'
  | 'entity'
  | 'depth'
  | 'elements'
  | 'attributes'
  | 'malformed';
export type XmlResult =
  | { readonly ok: true; readonly root: XmlElement }
  | { readonly ok: false; readonly reason: XmlFailure };

export function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

/** Decode XML bytes using their UTF-8 or UTF-16 byte-order signature. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const encoding =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0x3c && bytes[1] === 0)
      ? 'utf-16le'
      : (bytes[0] === 0xfe && bytes[1] === 0xff) ||
          (bytes[0] === 0 && bytes[1] === 0x3c)
        ? 'utf-16be'
        : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/** True when the input contains a DTD or entity declaration forbidden for this format. */
export function scanForbiddenDtd(
  input: Uint8Array | string,
  kind: 'docx' | 'epub'
): boolean {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (
    (input[0] === 0xff && input[1] === 0xfe) ||
    (input[0] === 0x3c && input[1] === 0)
  ) {
    text = new TextDecoder('utf-16le').decode(input);
  } else if (
    (input[0] === 0xfe && input[1] === 0xff) ||
    (input[0] === 0 && input[1] === 0x3c)
  ) {
    text = new TextDecoder('utf-16be').decode(input);
  } else {
    text = new TextDecoder().decode(input);
  }
  if (text.includes('\0')) return true;
  if (/<!ENTITY\b/i.test(text)) return true;
  if (kind === 'docx') return /<!DOCTYPE\b/i.test(text);
  const doctype = /<!DOCTYPE\b/gi;
  while (true) {
    if (doctype.exec(text) === null) break;
    let quote = '';
    let i = doctype.lastIndex;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '[') {
        return true;
      } else if (c === '>') {
        i++;
        break;
      }
    }
    // A declaration without a closing '>' consumes the rest of the input.
    doctype.lastIndex = i;
  }
  return false;
}

class ParseFailure extends Error {
  constructor(readonly reason: XmlFailure) {
    super(reason);
  }
}

/** Parse a single XML root without evaluating DTDs or fetching external data. */
export function parseXml(
  text: string,
  opts?: {
    readonly lenient?: boolean;
    /** Called before allocation; the root has depth zero. */
    readonly admitElement?: (name: string, depth: number) => boolean;
  }
): XmlResult {
  try {
    if (/<!ENTITY\b/i.test(text)) throw new ParseFailure('entity');
    if (scanForbiddenDtd(text, 'epub')) throw new ParseFailure('doctype');
    type MutableElement = {
      name: string;
      attrs: Map<string, string>;
      children: (XmlElement | string)[];
    };
    const stack: MutableElement[] = [];
    let root: MutableElement | undefined;
    let at = 0;
    const namePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;
    const fail = (): never => {
      throw new ParseFailure('malformed');
    };
    const entities = (value: string): string =>
      value.replace(/&([^;\s<&]+);|&/g, (match, entity: string | undefined) => {
        if (entity === undefined) throw new ParseFailure('entity');
        const named: Record<string, string> = {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
        };
        if (Object.hasOwn(named, entity)) return named[entity]!;
        if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
          const n =
            entity[1] === 'x'
              ? Number.parseInt(entity.slice(2), 16)
              : Number.parseInt(entity.slice(1), 10);
          if (
            !(
              n === 9 ||
              n === 10 ||
              n === 13 ||
              (n >= 32 && n <= 0xd7ff) ||
              (n >= 0xe000 && n <= 0xfffd) ||
              (n >= 0x10000 && n <= 0x10ffff)
            )
          )
            throw new ParseFailure('entity');
          return String.fromCodePoint(n);
        }
        if (opts?.lenient && /^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(entity))
          return match;
        throw new ParseFailure('entity');
      });
    const appendText = (value: string) => {
      if (!stack.length) {
        if (value.trim()) fail();
        return;
      }
      if (value) stack[stack.length - 1]!.children.push(value);
    };
    if (text.charCodeAt(0) === 0xfeff) at++;
    while (at < text.length) {
      if (text[at] !== '<') {
        const end = text.indexOf('<', at);
        const next = end < 0 ? text.length : end;
        appendText(entities(text.slice(at, next)));
        at = next;
        continue;
      }
      if (text.startsWith('<!--', at)) {
        const end = text.indexOf('-->', at + 4);
        if (end < 0 || text.slice(at + 4, end).includes('--')) fail();
        at = end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', at)) {
        const end = text.indexOf(']]>', at + 9);
        if (end < 0 || !stack.length) fail();
        appendText(text.slice(at + 9, end));
        at = end + 3;
        continue;
      }
      if (text.startsWith('<?', at)) {
        const end = text.indexOf('?>', at + 2);
        if (end < 0) fail();
        at = end + 2;
        continue;
      }
      if (/^<!DOCTYPE\b/i.test(text.slice(at))) {
        if (root || stack.length) fail();
        const end = text.indexOf('>', at + 9);
        if (end < 0) fail();
        at = end + 1;
        continue;
      }
      if (text.startsWith('</', at)) {
        const match = /^<\/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*>/.exec(
          text.slice(at)
        );
        if (
          !match ||
          !stack.length ||
          stack[stack.length - 1]!.name !== match[1]
        )
          fail();
        stack.pop();
        at += match![0].length;
        continue;
      }
      const match = namePattern.exec(text.slice(at + 1));
      if (!match) fail();
      const name = match![0];
      at += name.length + 1;
      if (opts?.admitElement && !opts.admitElement(name, stack.length))
        throw new ParseFailure('elements');
      const element: MutableElement = { name, attrs: new Map(), children: [] };
      if (stack.length) stack[stack.length - 1]!.children.push(element);
      else {
        if (root) fail();
        root = element;
      }
      if (stack.length >= 256) throw new ParseFailure('depth');
      while (true) {
        const whitespace = /^\s*/.exec(text.slice(at))![0];
        at += whitespace.length;
        if (text.startsWith('/>', at)) {
          at += 2;
          break;
        }
        if (text[at] === '>') {
          at++;
          stack.push(element);
          break;
        }
        if (!whitespace.length) fail();
        const attr = namePattern.exec(text.slice(at));
        if (!attr || element.attrs.has(attr[0])) fail();
        at += attr![0].length;
        const equals = /^\s*=\s*(["'])/.exec(text.slice(at));
        if (!equals) fail();
        at += equals![0].length;
        const end = text.indexOf(equals![1]!, at);
        if (end < 0 || text.slice(at, end).includes('<')) fail();
        element.attrs.set(attr![0], entities(text.slice(at, end)));
        if (element.attrs.size > 256) throw new ParseFailure('attributes');
        at = end + 1;
      }
    }
    if (!root || stack.length) fail();
    return { ok: true, root: root! };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ParseFailure ? error.reason : 'malformed',
    };
  }
}
