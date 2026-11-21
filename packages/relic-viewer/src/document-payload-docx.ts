import type { ZipIndex } from '@relic/format/zip-index';
import {
  localName,
  parseXml,
  scanForbiddenDtd,
  type XmlElement,
} from '@relic/format/xml';

/** Only pass document resources the renderer can display. */
export function includeDocxPart(name: string): boolean {
  return (
    !/^(?:word\/embeddings\/|customXml\/|docProps\/thumbnail)/i.test(name) &&
    !/(?:\.bin|(?:^|\/)thumbnail[^/]*)$/i.test(name)
  );
}

const OFFICE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships/';
const XML_RELATIONSHIPS = new Set([
  `${OFFICE}officeDocument`,
  `${OFFICE}fontTable`,
  `${OFFICE}numbering`,
  `${OFFICE}styles`,
  `${OFFICE}theme`,
  `${OFFICE}footnotes`,
  `${OFFICE}endnotes`,
  `${OFFICE}footer`,
  `${OFFICE}header`,
  `${PACKAGE}metadata/core-properties`,
  `${OFFICE}extended-properties`,
  `${OFFICE}custom-properties`,
  `${OFFICE}settings`,
  `${OFFICE}comments`,
  'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
]);
const TOP_LEVEL = [
  [`${OFFICE}officeDocument`, 'word/document.xml'],
  [`${OFFICE}extended-properties`, 'docProps/app.xml'],
  [`${PACKAGE}metadata/core-properties`, 'docProps/core.xml'],
  [`${OFFICE}custom-properties`, 'docProps/custom.xml'],
] as const;

interface Relationship {
  readonly type: string;
  readonly target: string;
}

/** Select the package entries and every entry docx-preview may parse as XML. */
export async function selectDocxParts(index: ZipIndex): Promise<{
  parts: readonly string[];
  xmlParts: ReadonlySet<string>;
}> {
  const parts = [...index.entries]
    .filter(([name, info]) => info.kind === 'file' && includeDocxPart(name))
    .map(([name]) => name);
  const available = new Set(parts);
  const xmlParts = new Set<string>();
  const parsed = new Map<string, XmlElement>();
  const readXml = async (name: string): Promise<XmlElement> => {
    const cached = parsed.get(name);
    if (cached) return cached;
    if (!available.has(name)) throw new Error(`Missing DOCX metadata: ${name}`);
    const result = await index.read(name);
    if (!result.ok) throw new Error(result.reason);
    if (scanForbiddenDtd(result.bytes, 'docx'))
      throw new Error('Forbidden DOCX metadata DTD');
    const document = parseXml(
      new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)
    );
    if (!document.ok) throw new Error(`Invalid DOCX metadata: ${name}`);
    xmlParts.add(name);
    parsed.set(name, document.root);
    return document.root;
  };
  const children = (element: XmlElement): XmlElement[] =>
    element.children.filter(
      (child): child is XmlElement => typeof child !== 'string'
    );
  const attribute = (element: XmlElement, name: string): string | undefined => {
    for (const [key, value] of element.attrs)
      if (localName(key) === name) return value;
    return undefined;
  };
  const types = await readXml('[Content_Types].xml');
  if (localName(types.name) !== 'Types')
    throw new Error('Invalid DOCX content types');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const entry of children(types)) {
    const tag = localName(entry.name);
    if (tag !== 'Default' && tag !== 'Override') continue;
    const type = attribute(entry, 'ContentType');
    const key = attribute(entry, tag === 'Default' ? 'Extension' : 'PartName');
    if (!type || !key) throw new Error('Invalid DOCX content type entry');
    const map = tag === 'Default' ? defaults : overrides;
    const normalized =
      tag === 'Default' ? key.toLowerCase() : key.replace(/^\//, '');
    if (map.has(normalized)) throw new Error('Duplicate DOCX content type');
    map.set(normalized, type.toLowerCase());
  }
  for (const name of parts) {
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const type = (overrides.get(name) ?? defaults.get(extension) ?? '')
      .split(';', 1)[0]!
      .trim();
    if (/(?:^|\/)xml$|\+xml$/i.test(type) || /\.rels$/i.test(name))
      xmlParts.add(name);
  }
  const relationships = async (name: string): Promise<Relationship[]> => {
    if (!available.has(name)) return [];
    const root = await readXml(name);
    if (localName(root.name) !== 'Relationships')
      throw new Error('Invalid DOCX relationships');
    return children(root)
      .filter((entry) => localName(entry.name) === 'Relationship')
      .map((entry) => {
        const type = attribute(entry, 'Type');
        const target = attribute(entry, 'Target');
        if (!type || !target) throw new Error('Invalid DOCX relationship');
        return { type, target };
      });
  };
  const rootRels = await relationships('_rels/.rels');
  const pending: string[] = TOP_LEVEL.map(
    ([type, fallback]) =>
      rootRels.find((rel) => rel.type === type)?.target ?? fallback
  );
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!.replace(/^\//, '');
    if (!available.has(path) || visited.has(path)) continue;
    visited.add(path);
    xmlParts.add(path);
    const slash = path.lastIndexOf('/') + 1;
    const folder = path.slice(0, slash);
    const relPath = `${folder}_rels/${path.slice(slash)}.rels`;
    for (const rel of await relationships(relPath)) {
      if (!XML_RELATIONSHIPS.has(rel.type)) continue;
      // Match docx-preview's URL resolution, including its treatment of external targets.
      let resolved: string;
      try {
        resolved = new URL(rel.target, `http://docx/${folder}`)
          .toString()
          .substring('http://docx/'.length);
      } catch {
        resolved = folder + rel.target;
      }
      pending.push(resolved);
    }
  }
  return { parts, xmlParts };
}
