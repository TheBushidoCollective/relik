/* A streaming XML tokenizer for spreadsheet parts. It never resolves external
 * entities and does not construct a tree of worksheet cells. */
export interface XmlEvents {
  start(
    name: string,
    attributes: ReadonlyMap<string, string>,
    namespaces: ReadonlyMap<string, string>
  ): void;
  end(name: string): void;
  text(value: string): void;
}

const NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;
const SPACE = /\s/y;
const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&([^;\s<&]+);|&/g, (whole, key: string | undefined) => {
    if (!key) throw new Error('Invalid XML entity');
    if (Object.hasOwn(PREDEFINED, key)) return PREDEFINED[key]!;
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(key))
      throw new Error('Invalid XML entity');
    const n =
      key[1] === 'x'
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
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
      throw new Error('Invalid XML character');
    return String.fromCodePoint(n);
  });
}

/** Emits XML events in document order. A malformed or DTD-bearing part throws. */
export function tokenizeSpreadsheetXml(xml: string, events: XmlEvents): void {
  if (xml.includes('\0') || /<!DOCTYPE\b|<!ENTITY\b/i.test(xml))
    throw new Error('Forbidden XML declaration');
  let at = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: string[] = [];
  const namespaces = new Map<string, string>();
  const scopeStack: Array<Array<[string, string | undefined]> | undefined> = [];
  const restore = (
    scope: Array<[string, string | undefined]> | undefined
  ): void => {
    if (!scope) return;
    for (let i = scope.length - 1; i >= 0; i--) {
      const [prefix, previous] = scope[i]!;
      if (previous === undefined) namespaces.delete(prefix);
      else namespaces.set(prefix, previous);
    }
  };
  let roots = 0;
  const whitespace = (): void => {
    SPACE.lastIndex = at;
    while (SPACE.test(xml)) {
      at++;
      SPACE.lastIndex = at;
    }
  };
  const readName = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(xml);
    if (!match) throw new Error('Invalid XML name');
    at = NAME.lastIndex;
    return match[0];
  };
  while (at < xml.length) {
    if (xml[at] !== '<') {
      let end = xml.indexOf('<', at);
      if (end < 0) end = xml.length;
      const value = decode(xml.slice(at, end));
      if (!stack.length && value.trim()) throw new Error('Text outside root');
      if (stack.length && value) events.text(value);
      at = end;
      continue;
    }
    if (xml.startsWith('<!--', at)) {
      const end = xml.indexOf('-->', at + 4);
      if (end < 0 || xml.slice(at + 4, end).includes('--'))
        throw new Error('Invalid XML comment');
      at = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', at)) {
      const end = xml.indexOf(']]>', at + 9);
      if (end < 0 || !stack.length) throw new Error('Invalid CDATA');
      events.text(xml.slice(at + 9, end));
      at = end + 3;
      continue;
    }
    if (xml.startsWith('<?', at)) {
      const end = xml.indexOf('?>', at + 2);
      if (end < 0) throw new Error('Invalid XML instruction');
      at = end + 2;
      continue;
    }
    if (xml.startsWith('</', at)) {
      at += 2;
      const name = readName();
      whitespace();
      if (xml[at++] !== '>' || stack.pop() !== name)
        throw new Error('Unmatched XML element');
      events.end(name);
      restore(scopeStack.pop());
      continue;
    }
    if (xml.startsWith('<!', at)) throw new Error('Forbidden XML declaration');
    at++;
    const name = readName();
    if (!stack.length && ++roots !== 1) throw new Error('Multiple XML roots');
    if (stack.length >= 256) throw new Error('XML too deep');
    const attrs = new Map<string, string>();
    let empty = false;
    for (;;) {
      const before = at;
      whitespace();
      if (xml.startsWith('/>', at)) {
        at += 2;
        empty = true;
        break;
      }
      if (xml[at] === '>') {
        at++;
        break;
      }
      if (before === at) throw new Error('Invalid XML attributes');
      const attr = readName();
      if (attrs.has(attr) || attrs.size >= 256)
        throw new Error('Invalid XML attributes');
      whitespace();
      if (xml[at++] !== '=') throw new Error('Invalid XML attribute');
      whitespace();
      const quote = xml[at++];
      if (quote !== '"' && quote !== "'")
        throw new Error('Invalid XML attribute');
      const end = xml.indexOf(quote, at);
      if (end < 0 || xml.slice(at, end).includes('<'))
        throw new Error('Invalid XML attribute');
      attrs.set(attr, decode(xml.slice(at, end)));
      at = end + 1;
    }
    let scope: Array<[string, string | undefined]> | undefined;
    for (const [key, value] of attrs) {
      if (key !== 'xmlns' && !key.startsWith('xmlns:')) continue;
      const prefix = key === 'xmlns' ? '' : key.slice(6);
      scope ??= [];
      scope.push([prefix, namespaces.get(prefix)]);
      namespaces.set(prefix, value);
    }
    events.start(name, attrs, namespaces);
    if (empty) {
      events.end(name);
      restore(scope);
    } else {
      stack.push(name);
      scopeStack.push(scope);
    }
  }
  if (roots !== 1 || stack.length) throw new Error('Incomplete XML');
}
