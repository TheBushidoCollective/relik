import type { ZipIndex } from '@relic/format/zip-index';
import {
  decodeXmlBytes,
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
  `${PACKAGE}metadata/custom-properties`,
  `${OFFICE}settings`,
  `${OFFICE}comments`,
  'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
]);
const TOP_LEVEL = [
  [`${OFFICE}officeDocument`, 'word/document.xml'],
  [`${OFFICE}extended-properties`, 'docProps/app.xml'],
  [`${PACKAGE}metadata/core-properties`, 'docProps/core.xml'],
  [`${PACKAGE}metadata/custom-properties`, 'docProps/custom.xml'],
] as const;

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_ELEMENTS = 50_000;
const MAX_RELATIONSHIPS = 10_000;

interface Relationship {
  readonly type: string;
  readonly target: string;
}

/** Select the package entries and every entry docx-preview may parse as XML. */
export async function selectDocxParts(
  index: ZipIndex,
  signal?: AbortSignal
): Promise<{
  parts: readonly string[];
  xmlParts: ReadonlySet<string>;
}> {
  const checkCancelled = () => {
    if (signal?.aborted)
      throw new DOMException('DOCX selection cancelled', 'AbortError');
  };
  checkCancelled();
  const parts = [...index.entries]
    .filter(([name, info]) => info.kind === 'file' && includeDocxPart(name))
    .map(([name]) => name);
  const available = new Set(parts);
  const xmlParts = new Set<string>();
  let metadataBytes = 0;
  let metadataElements = 0;
  let relationshipCount = 0;
  const readXml = async (
    name: string,
    relationshipMetadata = false
  ): Promise<XmlElement> => {
    checkCancelled();
    const info = index.entries.get(name);
    if (!available.has(name) || info?.kind !== 'file')
      throw new Error(`Missing DOCX metadata: ${name}`);
    if (info.size > MAX_METADATA_BYTES - metadataBytes)
      throw new Error('DOCX metadata byte limit exceeded');
    const result = await index.read(name);
    checkCancelled();
    if (!result.ok) throw new Error(result.reason);
    if (result.bytes.byteLength > MAX_METADATA_BYTES - metadataBytes)
      throw new Error('DOCX metadata byte limit exceeded');
    metadataBytes += result.bytes.byteLength;
    const text = decodeXmlBytes(result.bytes, { fatal: true });
    if (scanForbiddenDtd(text, 'docx'))
      throw new Error('Forbidden DOCX metadata DTD');
    let relationshipLimitExceeded = false;
    const document = parseXml(text, {
      admitElement: (elementName, depth) => {
        if (++metadataElements > MAX_METADATA_ELEMENTS) return false;
        if (
          relationshipMetadata &&
          depth === 1 &&
          localName(elementName) === 'Relationship' &&
          ++relationshipCount > MAX_RELATIONSHIPS
        ) {
          relationshipLimitExceeded = true;
          return false;
        }
        return true;
      },
    });
    if (!document.ok) {
      if (document.reason === 'elements')
        throw new Error(
          relationshipLimitExceeded
            ? 'DOCX relationship limit exceeded'
            : 'DOCX metadata element limit exceeded'
        );
      throw new Error(`Invalid DOCX metadata: ${name}`);
    }
    xmlParts.add(name);
    return document.root;
  };
  const attribute = (element: XmlElement, name: string): string | undefined => {
    for (const [key, value] of element.attrs)
      if (localName(key) === name) return value;
    return undefined;
  };
  const readContentTypes = async () => {
    const types = await readXml('[Content_Types].xml');
    checkCancelled();
    if (localName(types.name) !== 'Types')
      throw new Error('Invalid DOCX content types');
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    for (const entry of types.children) {
      if (typeof entry === 'string') continue;
      const tag = localName(entry.name);
      if (tag !== 'Default' && tag !== 'Override') continue;
      const type = attribute(entry, 'ContentType');
      const key = attribute(
        entry,
        tag === 'Default' ? 'Extension' : 'PartName'
      );
      if (!type || !key) throw new Error('Invalid DOCX content type entry');
      const map = tag === 'Default' ? defaults : overrides;
      const normalized =
        tag === 'Default' ? key.toLowerCase() : key.replace(/^\//, '');
      if (map.has(normalized)) throw new Error('Duplicate DOCX content type');
      map.set(normalized, type.toLowerCase());
    }
    return { defaults, overrides };
  };
  const { defaults, overrides } = await readContentTypes();
  for (const name of parts) {
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const type = (overrides.get(name) ?? defaults.get(extension) ?? '')
      .split(';', 1)[0]!
      .trim();
    if (/(?:^|\/)xml$|\+xml$/i.test(type) || /\.rels$/i.test(name))
      xmlParts.add(name);
  }
  const relationships = async (name: string): Promise<Relationship[]> => {
    checkCancelled();
    if (!available.has(name)) return [];
    const root = await readXml(name, true);
    checkCancelled();
    if (localName(root.name) !== 'Relationships')
      throw new Error('Invalid DOCX relationships');
    const result: Relationship[] = [];
    for (const entry of root.children) {
      if (typeof entry === 'string') continue;
      if (localName(entry.name) !== 'Relationship')
        throw new Error('Invalid DOCX relationship element');
      const type = attribute(entry, 'Type');
      const target = attribute(entry, 'Target');
      if (!type || !target) throw new Error('Invalid DOCX relationship');
      result.push({ type, target });
    }
    return result;
  };
  const rootRels = await relationships('_rels/.rels');
  const pending: string[] = TOP_LEVEL.map(
    ([type, fallback]) =>
      rootRels.find((rel) => rel.type === type)?.target ?? fallback
  );
  const visited = new Set<string>();
  while (pending.length) {
    checkCancelled();
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
  checkCancelled();
  return { parts, xmlParts };
}
