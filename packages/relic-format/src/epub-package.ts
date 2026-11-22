import {
  decodeXmlBytes,
  localName,
  parseXml,
  scanForbiddenDtd,
  type XmlElement,
} from './xml.ts';
import type { ZipIndex } from './zip-index.ts';

export interface EpubBook {
  readonly title: string;
  readonly creator?: string;
  readonly language?: string;
  readonly progression: 'ltr' | 'rtl' | 'default';
  readonly layout: 'reflowable' | 'pre-paginated';
  readonly resources: readonly {
    readonly path: string;
    readonly mediaType: string;
  }[];
  readonly spine: readonly {
    readonly path: string;
    readonly linear: boolean;
  }[];
  readonly toc: readonly {
    readonly label: string;
    readonly path: string;
    readonly fragment?: string;
    readonly depth: number;
  }[];
  readonly pageList: readonly {
    readonly label: string;
    readonly path: string;
    readonly fragment?: string;
  }[];
}

/**
 * The order a book's spine renders in: linear items first, then the rest, each
 * group in spine order. A chapter's position in this list is its render index,
 * so every reader of a `part` must agree on this order.
 */
export function epubRenderOrder(
  book: Pick<EpubBook, 'spine'>
): readonly { readonly path: string; readonly linear: boolean }[] {
  return [
    ...book.spine.filter((item) => item.linear),
    ...book.spine.filter((item) => !item.linear),
  ];
}

export type EpubPackageResult =
  | {
      readonly ok: true;
      readonly book: EpubBook;
      readonly parts: readonly string[];
      readonly xmlParts: ReadonlySet<string>;
    }
  | {
      readonly ok: false;
      readonly reason: 'protected' | 'corrupt' | 'too-large';
    };

type Failure = 'protected' | 'corrupt' | 'too-large';
class PackageFailure extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}
const fail = (reason: Failure): never => {
  throw new PackageFailure(reason);
};
const children = (node: XmlElement, name: string): XmlElement[] =>
  node.children.filter(
    (item): item is XmlElement =>
      typeof item !== 'string' && localName(item.name) === name
  );
function descendants(node: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of node.children)
    if (typeof child !== 'string') {
      if (localName(child.name) === name) found.push(child);
      found.push(...descendants(child, name));
    }
  return found;
}
function attribute(node: XmlElement, name: string): string | undefined {
  for (const [key, value] of node.attrs)
    if (localName(key) === name) return value;
  return undefined;
}
function text(node: XmlElement): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : text(child)))
    .join('')
    .trim();
}
/** Resolve an EPUB relative IRI within the archive, refusing external or escaping paths. */
export function resolveEpubPath(
  base: string,
  href: string
): { path: string; fragment?: string } | undefined {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith('//') ||
    href.includes('\\') ||
    href.includes('?')
  )
    return undefined;
  const hash = href.indexOf('#');
  let raw = hash < 0 ? href : href.slice(0, hash);
  let fragment: string | undefined;
  try {
    raw = decodeURIComponent(raw);
    fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
  } catch {
    return undefined;
  }
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0'))
    return undefined;
  const parts = raw ? base.split('/').slice(0, -1) : base.split('/');
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) return undefined;
  return { path: parts.join('/'), ...(fragment ? { fragment } : {}) };
}
async function xml(
  index: ZipIndex,
  path: string,
  lenient = false
): Promise<XmlElement> {
  const entry = index.entries.get(path);
  if (!entry || entry.kind !== 'file') return fail('corrupt');
  if (entry.size > 4 * 1024 * 1024) return fail('too-large');
  const bytes = await index.read(path);
  if (!bytes.ok)
    return fail(bytes.reason.includes('large') ? 'too-large' : 'corrupt');
  if (scanForbiddenDtd(bytes.bytes, 'epub')) return fail('corrupt');
  const parsed = parseXml(decodeXmlBytes(bytes.bytes), {
    lenient,
    maxNodes: 20000,
    maxTextChars: 4 * 1024 * 1024,
  });
  if (!parsed.ok)
    return fail(parsed.reason === 'size' ? 'too-large' : 'corrupt');
  return parsed.root;
}
interface ManifestItem {
  path: string;
  media: string;
  properties: string[];
}
const FONT_TYPES = new Set([
  'application/vnd.ms-opentype',
  'application/font-sfnt',
  'application/font-woff',
  'application/vnd.ms-fontobject',
  'font/otf',
  'font/ttf',
  'font/woff',
  'font/woff2',
]);
const FONT_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

export async function readEpubPackage(
  index: ZipIndex
): Promise<EpubPackageResult> {
  try {
    if (
      index.entries.has('META-INF/rights.xml') ||
      index.entries.has('META-INF/license.lcpl')
    )
      return fail('protected');
    const container = await xml(index, 'META-INF/container.xml');
    const opfPath = descendants(container, 'rootfile')
      .map((node) => attribute(node, 'full-path'))
      .find(Boolean);
    if (
      !opfPath ||
      !resolveEpubPath('root', opfPath) ||
      opfPath.startsWith('/')
    )
      return fail('corrupt');
    const opf = await xml(index, opfPath);
    const manifest = children(opf, 'manifest')[0];
    const spineNode = children(opf, 'spine')[0];
    if (!manifest || !spineNode) return fail('corrupt');
    const items = new Map<string, ManifestItem>();
    const paths = new Map<string, ManifestItem>();
    for (const item of children(manifest, 'item')) {
      const id = attribute(item, 'id');
      const href = attribute(item, 'href');
      const resolved = href && resolveEpubPath(opfPath, href);
      if (
        !id ||
        !resolved ||
        resolved.fragment ||
        items.has(id) ||
        paths.has(resolved.path)
      )
        return fail('corrupt');
      const entry = index.entries.get(resolved.path);
      if (!entry || entry.kind !== 'file') return fail('corrupt');
      const media = (attribute(item, 'media-type') ?? '')
        .toLowerCase()
        .split(';', 1)[0]!
        .trim();
      if (!media) return fail('corrupt');
      const limit =
        media === 'text/css' || FONT_TYPES.has(media)
          ? 4
          : media.startsWith('image/') ||
              media === 'application/xhtml+xml' ||
              media === 'text/html'
            ? 16
            : 100;
      if (entry.size > limit * 1024 * 1024) return fail('too-large');
      const value = {
        path: resolved.path,
        media,
        properties: (attribute(item, 'properties') ?? '')
          .split(/\s+/)
          .filter(Boolean),
      };
      items.set(id, value);
      paths.set(value.path, value);
    }
    const obscured = new Set<string>();
    if (index.entries.has('META-INF/encryption.xml')) {
      const encryption = await xml(index, 'META-INF/encryption.xml');
      for (const encrypted of descendants(encryption, 'EncryptedData')) {
        const algorithm = descendants(encrypted, 'EncryptionMethod')[0];
        const reference = descendants(encrypted, 'CipherReference')[0];
        const uri = reference && attribute(reference, 'URI');
        const resolved = uri && resolveEpubPath('root', uri);
        const item = resolved && paths.get(resolved.path);
        if (
          !algorithm ||
          !FONT_ALGORITHMS.has(attribute(algorithm, 'Algorithm') ?? '') ||
          !item ||
          !FONT_TYPES.has(item.media)
        )
          return fail('protected');
        obscured.add(item.path);
      }
      if (descendants(encryption, 'EncryptedData').length === 0)
        return fail('protected');
    }
    const refs = children(spineNode, 'itemref');
    if (refs.length > 2000) return fail('too-large');
    if (!refs.length) return fail('corrupt');
    const spine = refs.map((ref) => {
      const item = items.get(attribute(ref, 'idref') ?? '');
      if (!item || obscured.has(item.path)) return fail('corrupt');
      if (index.entries.get(item.path)!.size > 16 * 1024 * 1024)
        return fail('too-large');
      return { path: item.path, linear: attribute(ref, 'linear') !== 'no' };
    });
    const metadata = children(opf, 'metadata')[0];
    const first = (name: string): string | undefined =>
      metadata
        ? descendants(metadata, name).map(text).find(Boolean)
        : undefined;
    const title = first('title') ?? '';
    const creator = first('creator');
    const language = first('language');
    const layout =
      metadata &&
      descendants(metadata, 'meta').some(
        (n) =>
          attribute(n, 'property') === 'rendition:layout' &&
          text(n) === 'pre-paginated'
      )
        ? 'pre-paginated'
        : 'reflowable';
    const direction = attribute(spineNode, 'page-progression-direction');
    const progression =
      direction === 'rtl' || direction === 'ltr' ? direction : 'default';
    const toc: {
      label: string;
      path: string;
      fragment?: string;
      depth: number;
    }[] = [];
    const pageList: { label: string; path: string; fragment?: string }[] = [];
    const navLimit = 5000;
    const nav = [...items.values()].find((item) =>
      item.properties.includes('nav')
    );
    if (nav) {
      const root = await xml(index, nav.path, true);
      for (const section of descendants(root, 'nav')) {
        const type = (attribute(section, 'type') ?? '').split(/\s+/);
        if (!type.includes('toc') && !type.includes('page-list')) continue;
        const walk = (node: XmlElement, depth: number): void => {
          for (const child of node.children)
            if (typeof child !== 'string') {
              if (localName(child.name) === 'a') {
                const href = attribute(child, 'href');
                const target = href && resolveEpubPath(nav.path, href);
                if (target && paths.has(target.path)) {
                  if (
                    toc.length +
                      pageList.length +
                      Number(type.includes('toc')) +
                      Number(type.includes('page-list')) >
                    navLimit
                  )
                    fail('too-large');
                  const entry = { label: text(child), ...target };
                  if (type.includes('toc'))
                    toc.push({ ...entry, depth: Math.max(0, depth - 1) });
                  if (type.includes('page-list')) pageList.push(entry);
                }
              }
              walk(child, depth + (localName(child.name) === 'ol' ? 1 : 0));
            }
        };
        walk(section, 0);
      }
    } else {
      const ncx =
        items.get(attribute(spineNode, 'toc') ?? '') ??
        [...items.values()].find(
          (item) => item.media === 'application/x-dtbncx+xml'
        );
      if (ncx) {
        const root = await xml(index, ncx.path);
        const walk = (node: XmlElement, depth: number): void => {
          for (const child of node.children)
            if (typeof child !== 'string') {
              const name = localName(child.name);
              if (name === 'navPoint' || name === 'pageTarget') {
                const content = children(child, 'content')[0];
                const href = content && attribute(content, 'src');
                const target = href && resolveEpubPath(ncx.path, href);
                const label = children(child, 'navLabel')[0];
                if (target && paths.has(target.path)) {
                  if (toc.length + pageList.length >= navLimit)
                    fail('too-large');
                  const entry = { label: label ? text(label) : '', ...target };
                  if (name === 'navPoint') toc.push({ ...entry, depth });
                  else pageList.push(entry);
                }
              }
              walk(child, depth + (name === 'navPoint' ? 1 : 0));
            }
        };
        walk(root, 0);
      }
    }
    const parts = [...paths.keys()].filter((path) => !obscured.has(path));
    const xmlParts = new Set<string>();
    for (const [id, item] of items) {
      const media = item.media.toLowerCase().split(';', 1)[0]!.trim();
      if (
        media === 'text/html' ||
        media === 'text/xml' ||
        media === 'application/xml' ||
        media.endsWith('+xml') ||
        item.properties.includes('nav') ||
        attribute(spineNode, 'toc') === id
      ) {
        if (!obscured.has(item.path)) xmlParts.add(item.path);
      }
    }
    for (const item of spine) xmlParts.add(item.path);
    return {
      ok: true,
      book: {
        title,
        ...(creator ? { creator } : {}),
        ...(language ? { language } : {}),
        progression,
        layout,
        resources: [...items.values()]
          .filter((item) => !obscured.has(item.path))
          .map((item) => ({
            path: item.path,
            mediaType: item.media.toLowerCase().split(';', 1)[0]!.trim(),
          })),
        spine,
        toc,
        pageList,
      },
      parts,
      xmlParts,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof PackageFailure ? error.reason : 'corrupt',
    };
  }
}
