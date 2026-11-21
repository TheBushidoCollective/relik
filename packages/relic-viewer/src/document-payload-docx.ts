import { localName, parseXml } from '@relic/format/xml';

/** Only pass document resources the renderer can display. */
export function includeDocxPart(name: string): boolean {
  return (
    !/^(?:word\/embeddings\/|customXml\/|docProps\/thumbnail)/i.test(name) &&
    !/(?:\.bin|(?:^|\/)thumbnail[^/]*)$/i.test(name)
  );
}

/** Extended properties contain an optional, author-supplied page count. */
export function docxPageCount(bytes: Uint8Array): number | undefined {
  const parsed = parseXml(new TextDecoder().decode(bytes));
  if (!parsed.ok) return undefined;
  const pages = parsed.root.children.find(
    (child) => typeof child !== 'string' && localName(child.name) === 'Pages'
  );
  if (!pages || typeof pages === 'string') return undefined;
  const text = pages.children
    .filter((child): child is string => typeof child === 'string')
    .join('')
    .trim();
  if (!/^[1-9]\d*$/.test(text)) return undefined;
  const count = Number(text);
  return Number.isSafeInteger(count) ? count : undefined;
}
