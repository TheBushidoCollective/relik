import { resolveEpubPath } from '../../relic-format/src/epub-package.ts';

const MAX_CSS = 4 * 1024 * 1024;
const MAX_CSS_REWRITE_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_BOOK_IMAGE_PIXELS = 128 * 1024 * 1024;
type UnicodeRange = readonly [number, number];
interface CachedFontFace {
  readonly signature: string;
  readonly prefix: string;
  readonly ranges: readonly UnicodeRange[];
}

export interface EpubResources {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly mediaTypes: ReadonlyMap<string, string>;
  readonly dataUrls: Map<string, string>;
  readonly mediaUrls: Map<string, string>;
  fontFaces?: Map<string, Map<string, CachedFontFace>>;
  imagePixels?: Map<string, number>;
  decodedImagePixels?: number;
  omittedImages?: boolean;
  omittedImagePaths?: Set<string>;
  svgDataUrl?: (path: string) => string | undefined;
  encodedBytes: number;
  referencedBytes: number;
  cssRewriteBytes?: number;
  cssBytes: number;
}
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);
const FONT_TYPES = new Set([
  'font/woff',
  'font/woff2',
  'font/otf',
  'font/ttf',
  'application/font-woff',
  'application/font-sfnt',
  'application/vnd.ms-opentype',
  'application/vnd.ms-fontobject',
]);

const FONT_STRETCHES: Readonly<Record<string, number>> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
};

const ALL_UNICODE: readonly UnicodeRange[] = [[0, 0x10ffff]];

function fontUnicodeRanges(value: string): readonly UnicodeRange[] {
  if (!value || value.length > 4096) return ALL_UNICODE;
  const parts = value.split(',');
  if (parts.length > 128) return ALL_UNICODE;
  const ranges: UnicodeRange[] = [];
  for (const part of parts) {
    const match = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(
      part.trim()
    );
    if (
      !match ||
      (match[2] && match[1]!.includes('?')) ||
      /\?[0-9a-f]/i.test(match[1]!)
    )
      return ALL_UNICODE;
    const start = Number.parseInt(match[1]!.replaceAll('?', '0'), 16);
    const end = match[2]
      ? Number.parseInt(match[2], 16)
      : Number.parseInt(match[1]!.replaceAll('?', 'f'), 16);
    if (start > end || start > 0x10ffff) return ALL_UNICODE;
    ranges.push([start, Math.min(end, 0x10ffff)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: UnicodeRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1)
      merged[merged.length - 1] = [
        previous[0],
        Math.max(previous[1], range[1]),
      ];
    else merged.push(range);
  }
  return merged;
}

function unicodeRangesOverlap(
  a: readonly UnicodeRange[],
  b: readonly UnicodeRange[]
): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]![0] <= b[j]![1] && b[j]![0] <= a[i]![1]) return true;
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return false;
}

/** Only partition faces when their fixed descriptors cannot overlap. */
function fontFaceIdentity(rule: CSSFontFaceRule): {
  family: string;
  slot: string;
  prefix: string;
  ranges: readonly UnicodeRange[];
} {
  const family = rule.style
    .getPropertyValue('font-family')
    .trim()
    .toLowerCase();
  const style =
    rule.style.getPropertyValue('font-style').trim().toLowerCase() || 'normal';
  const rawWeight = rule.style
    .getPropertyValue('font-weight')
    .trim()
    .toLowerCase();
  const weight =
    rawWeight === '' || rawWeight === 'normal'
      ? 400
      : rawWeight === 'bold'
        ? 700
        : /^\d+(?:\.\d+)?$/.test(rawWeight)
          ? Number(rawWeight)
          : NaN;
  const rawStretch = rule.style
    .getPropertyValue('font-stretch')
    .trim()
    .toLowerCase();
  const stretch =
    rawStretch === ''
      ? 100
      : (FONT_STRETCHES[rawStretch] ??
        (/^\d+(?:\.\d+)?%$/.test(rawStretch)
          ? Number.parseFloat(rawStretch)
          : NaN));
  const specific =
    (style === 'normal' || style === 'italic') &&
    weight >= 1 &&
    weight <= 1000 &&
    Number.isFinite(stretch) &&
    stretch > 0;
  if (!specific) return { family, slot: '*', prefix: '*', ranges: ALL_UNICODE };
  const prefix = `${style}\0${weight}\0${stretch}`;
  const ranges = fontUnicodeRanges(
    rule.style.getPropertyValue('unicode-range')
  );
  return {
    family,
    slot: `${prefix}\0${JSON.stringify(ranges)}`,
    prefix,
    ranges,
  };
}

/** Contain stylesheet rules without allowing unmatched braces to escape the scope. */
export function scopeEpubCss(
  css: string,
  chapter: number,
  isolatedSvg = false,
  resources?: EpubResources,
  fontMedia = ''
): string {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const char = css[i]!;
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth < 0) {
      throw new Error('Invalid EPUB stylesheet');
    }
  }
  if (depth !== 0 || quote) throw new Error('Invalid EPUB stylesheet');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const rewriteSelector = (selector: string): string => {
    let result = '';
    let quote = '';
    for (let i = 0; i < selector.length; i++) {
      const char = selector[i]!;
      if (char === '\\') {
        result += selector.slice(i, i + 2);
        i++;
      } else if (quote) {
        result += char;
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
        result += char;
      } else if (char === '[') {
        let end = i + 1;
        let attrQuote = '';
        for (; end < selector.length; end++) {
          const next = selector[end]!;
          if (next === '\\') {
            end++;
            continue;
          }
          if (attrQuote) {
            if (next === attrQuote) attrQuote = '';
          } else if (next === '"' || next === "'") attrQuote = next;
          else if (next === ']') break;
        }
        const raw = selector.slice(i, end + 1);
        const attr =
          /^(\[\s*(id|href)\s*=\s*)(["'])(.*?)\3(\s*[is]?\s*\])$/i.exec(raw);
        if (attr) {
          const value = decodeCss(attr[4]!);
          const isHref = attr[2]!.toLowerCase() === 'href';
          if (!isHref || value.startsWith('#')) {
            const id = isHref ? value.slice(1) : value;
            const remapped = `${isHref ? '#' : ''}ep-${chapter}-${id}`
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"');
            result += `${attr[1]}"${remapped}"${attr[5]}`;
          } else result += raw;
        } else result += raw;
        i = end;
      } else if (char === '#') {
        const ident =
          /^(?:\\[0-9a-fA-F]{1,6}\s?|\\[^\r\n]|[-_a-zA-Z0-9\u0080-\uFFFF])+/.exec(
            selector.slice(i + 1)
          );
        if (!ident) {
          result += char;
          continue;
        }
        result += `#${CSS.escape(`ep-${chapter}-${decodeCss(ident[0])}`)}`;
        i += ident[0].length;
      } else if (
        selector.startsWith(':root', i) &&
        selector[i - 1] !== ':' &&
        !/[-_a-zA-Z0-9]/.test(selector[i + 5] ?? '')
      ) {
        result += '[data-epub-root]';
        i += 4;
      } else {
        result += char;
      }
    }
    return result;
  };
  const duplicateFonts = new Map<string, Set<string>>();
  if (resources && !isolatedSvg) {
    const families = new Map<
      string,
      {
        all: string[];
        slots: Map<
          string,
          {
            sequence: string[];
            prefix: string;
            ranges: readonly UnicodeRange[];
          }
        >;
      }
    >();
    const collectFonts = (rules: CSSRuleList, context = ''): void => {
      for (const rule of Array.from(rules)) {
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          const { family, slot, prefix, ranges } = fontFaceIdentity(
            rule as CSSFontFaceRule
          );
          if (family) {
            const group = families.get(family) ?? {
              all: [],
              slots: new Map<
                string,
                {
                  sequence: string[];
                  prefix: string;
                  ranges: readonly UnicodeRange[];
                }
              >(),
            };
            const signature = `${fontMedia}\0${context}\0${rule.cssText}`;
            group.all.push(`${slot}\0${signature}`);
            const entry = group.slots.get(slot) ?? {
              sequence: [],
              prefix,
              ranges,
            };
            entry.sequence.push(signature);
            group.slots.set(slot, entry);
            families.set(family, group);
          }
        } else if ('cssRules' in rule) {
          const group = rule as CSSGroupingRule;
          const opener = group.cssText.indexOf('{');
          if (opener >= 0)
            collectFonts(
              group.cssRules,
              `${context}\0${group.cssText.slice(0, opener)}`
            );
        }
      }
    };
    collectFonts(sheet.cssRules);
    resources.fontFaces ??= new Map();
    for (const [family, group] of families) {
      const faces =
        resources.fontFaces.get(family) ?? new Map<string, CachedFontFace>();
      if (faces.has('!')) continue;
      // Keep overlap bookkeeping bounded; uncached faces still render normally.
      if (group.slots.size > 256) {
        faces.clear();
        faces.set('!', { signature: '', prefix: '!', ranges: [] });
        resources.fontFaces.set(family, faces);
        continue;
      }
      const duplicates = new Set<string>();
      if (group.slots.has('*')) {
        const signature = JSON.stringify(group.all);
        if (faces.get('*')?.signature === signature) duplicates.add('*');
        faces.clear();
        faces.set('*', { signature, prefix: '*', ranges: ALL_UNICODE });
      } else {
        if (faces.has('*')) faces.clear();
        for (const [slot, entry] of group.slots) {
          const signature = JSON.stringify(entry.sequence);
          if (faces.get(slot)?.signature === signature) {
            duplicates.add(slot);
            continue;
          }
          for (const [otherSlot, previous] of faces)
            if (
              previous.prefix === entry.prefix &&
              unicodeRangesOverlap(previous.ranges, entry.ranges)
            )
              faces.delete(otherSlot);
          faces.set(slot, {
            signature,
            prefix: entry.prefix,
            ranges: entry.ranges,
          });
          if (faces.size > 256) {
            faces.clear();
            faces.set('!', { signature: '', prefix: '!', ranges: [] });
            break;
          }
        }
      }
      resources.fontFaces.set(family, faces);
      if (duplicates.size) duplicateFonts.set(family, duplicates);
    }
  }
  const rewriteRules = (rules: CSSRuleList, context = ''): string =>
    Array.from(rules, (rule) => {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const { family, slot } = fontFaceIdentity(rule as CSSFontFaceRule);
        const duplicates = duplicateFonts.get(family);
        return duplicates?.has('*') || duplicates?.has(slot)
          ? ''
          : rule.cssText;
      }
      if (rule.type === CSSRule.STYLE_RULE) {
        const style = rule as CSSStyleRule;
        const nestedRules = (
          style as CSSStyleRule & { readonly cssRules?: CSSRuleList }
        ).cssRules;
        const nested = nestedRules
          ? rewriteRules(nestedRules, `${context}\0${style.selectorText}`)
          : '';
        return `${rewriteSelector(style.selectorText)}{${style.style.cssText}${nested}}`;
      }
      if ('cssRules' in rule) {
        const group = rule as CSSGroupingRule;
        const opener = group.cssText.indexOf('{');
        if (opener >= 0) {
          const prefix = group.cssText.slice(0, opener);
          const mapped = /^@scope\b/i.test(prefix)
            ? rewriteSelector(prefix)
            : prefix;
          return `${mapped}{${rewriteRules(group.cssRules, `${context}\0${prefix}`)}}`;
        }
      }
      return rule.cssText;
    }).join('');
  const rewritten = rewriteRules(sheet.cssRules);
  const result = isolatedSvg
    ? rewritten
    : `@scope (#ep-${chapter}-) {${rewritten}}`;
  const bytes = new TextEncoder().encode(result).byteLength;
  if (bytes > MAX_CSS) throw new Error('CSS limit exceeded');
  if (resources) {
    resources.cssBytes += bytes;
    if (resources.cssBytes > MAX_CSS) throw new Error('CSS limit exceeded');
    for (const match of result.matchAll(
      /url\(\s*(?:"(data:[^"]*)"|'(data:[^']*)'|(data:[^)\s]*))\s*\)/gi
    )) {
      resources.referencedBytes += (
        match[1] ??
        match[2] ??
        match[3] ??
        ''
      ).length;
      if (resources.referencedBytes > 64 * 1024 * 1024)
        throw new Error('EPUB resource limit exceeded');
    }
  }
  return result;
}
function decodeCss(value: string): string {
  return value.replace(
    /\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
    (_, hex: string | undefined, char: string | undefined) =>
      hex
        ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
        : (char ?? '')
  );
}

interface ImportQualifiers {
  readonly layer?: string;
  readonly supports?: string;
  readonly media?: string;
}

/** Parse import qualifiers before turning them into nested conditional rules. */
function importQualifiers(input: string): ImportQualifiers {
  let at = 0;
  const invalid = (): never => {
    throw new Error('Unsupported EPUB stylesheet import qualifiers');
  };
  const skipSpace = () => {
    while (at < input.length) {
      if (/\s/.test(input[at]!)) at++;
      else if (input.startsWith('/*', at)) {
        const end = input.indexOf('*/', at + 2);
        if (end < 0) return invalid();
        at = end + 2;
      } else break;
    }
  };
  const keyword = (): string => {
    const match =
      /^(?:[-_a-zA-Z0-9\u0080-\uFFFF]|\\(?:[0-9a-fA-F]{1,6}\s?|[^\r\n]))+/.exec(
        input.slice(at)
      );
    if (!match) return '';
    at += match[0].length;
    return decodeCss(match[0]).toLowerCase();
  };
  const group = (): string => {
    if (input[at] !== '(') return invalid();
    const start = ++at;
    let depth = 1;
    let quote = '';
    while (at < input.length) {
      const char = input[at++]!;
      if (char === '\\') {
        if (at >= input.length) return invalid();
        at++;
      } else if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '/' && input[at] === '*') {
        const end = input.indexOf('*/', at + 1);
        if (end < 0) return invalid();
        at = end + 2;
      } else if (char === '(') depth++;
      else if (char === ')') {
        if (--depth === 0) return input.slice(start, at - 1).trim();
      } else if (char === '{' || char === '}' || char === ';') {
        return invalid();
      }
    }
    return invalid();
  };
  skipSpace();
  let layer: string | undefined;
  let supports: string | undefined;
  let start = at;
  if (keyword() === 'layer') {
    skipSpace();
    if (input[at] === '(') {
      layer = group();
      if (!layer) return invalid();
    } else layer = '';
    const layerIdent =
      '(?:[-_a-zA-Z0-9\\u0080-\\uFFFF]|\\\\(?:[0-9a-fA-F]{1,6}\\s?|[^\\r\\n]))+';
    const layerName = layer.replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (
      layer !== '' &&
      !new RegExp(`^${layerIdent}(?:\\s*\\.\\s*${layerIdent})*$`).test(
        layerName.trim()
      )
    )
      return invalid();
  } else at = start;
  skipSpace();
  start = at;
  if (keyword() === 'supports') {
    skipSpace();
    if (input[at] === '(') {
      supports = group();
      if (!supports) return invalid();
    } else at = start;
  } else at = start;
  skipSpace();
  const media = input.slice(at).trim();
  if (media) {
    // Reuse the balanced-group scanner for the complete media-query list.
    const original = input;
    input = `(${media})`;
    at = 0;
    group();
    if (at !== input.length) return invalid();
    input = original;
  }
  return {
    ...(layer === undefined ? {} : { layer }),
    ...(supports === undefined ? {} : { supports }),
    ...(media ? { media } : {}),
  };
}

/** Read recognizable raster headers independently of the manifest label. */
function rasterPixels(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value) &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR'
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    bytes.length >= 10 &&
    ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (
    bytes.length >= 25 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    const type = String.fromCharCode(...bytes.subarray(12, 16));
    if (type === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (type === 'VP8L' && bytes[20] === 0x2f) {
      width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
      height =
        1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    } else if (
      type === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at++] !== 0xff) return undefined;
      while (at < bytes.length && bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) return undefined;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) return undefined;
      if (
        length >= 8 &&
        ((marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf))
      ) {
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += length;
    }
  }
  if (!(width > 0 && height > 0)) return undefined;
  const pixels = width * height;
  return Number.isSafeInteger(pixels) ? pixels : Number.POSITIVE_INFINITY;
}
export function epubDataUrl(
  resources: EpubResources,
  base: string,
  href: string,
  kind: 'image' | 'any' = 'any',
  deferReferenceAccounting = false
): string | undefined {
  const target = resolveEpubPath(base, decodeCss(href.trim()));
  if (!target) return undefined;
  const bytes = resources.entries.get(target.path);
  const mime = resources.mediaTypes.get(target.path);
  if (
    !bytes ||
    !mime ||
    (!IMAGE_TYPES.has(mime) && !FONT_TYPES.has(mime)) ||
    (kind === 'image' && !IMAGE_TYPES.has(mime))
  )
    return undefined;
  const limit = FONT_TYPES.has(mime) ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
  if (bytes.length > limit) throw new Error('EPUB resource limit exceeded');
  if (resources.omittedImagePaths?.has(target.path)) return undefined;
  // CSS URLs can be used as images even when the manifest labels them as fonts.
  resources.imagePixels ??= new Map();
  const images = resources.imagePixels;
  if (!images.has(target.path)) {
    const pixels = rasterPixels(bytes);
    const total = resources.decodedImagePixels ?? 0;
    if (
      pixels !== undefined &&
      (pixels > MAX_IMAGE_PIXELS || total + pixels > MAX_BOOK_IMAGE_PIXELS)
    ) {
      resources.omittedImages = true;
      resources.omittedImagePaths ??= new Set();
      resources.omittedImagePaths.add(target.path);
      return undefined;
    }
    images.set(target.path, pixels ?? 0);
    if (pixels !== undefined) resources.decodedImagePixels = total + pixels;
  }
  let url = resources.dataUrls.get(target.path);
  if (!url && mime === 'image/svg+xml') {
    url = resources.svgDataUrl?.(target.path);
    if (!url) return undefined;
    if (resources.encodedBytes + url.length > 64 * 1024 * 1024)
      throw new Error('EPUB resource limit exceeded');
    resources.dataUrls.set(target.path, url);
    resources.encodedBytes += url.length;
  }
  if (!url) {
    const encodedLength = 4 * Math.ceil(bytes.length / 3);
    if (resources.encodedBytes + encodedLength > 64 * 1024 * 1024)
      throw new Error('EPUB resource limit exceeded');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    url = `data:${mime};base64,${btoa(binary)}`;
    resources.dataUrls.set(target.path, url);
    resources.encodedBytes += encodedLength;
  }
  if (deferReferenceAccounting) {
    resources.cssRewriteBytes = (resources.cssRewriteBytes ?? 0) + url.length;
    if (resources.cssRewriteBytes > MAX_CSS_REWRITE_BYTES)
      throw new Error('CSS limit exceeded');
  } else {
    resources.referencedBytes += url.length;
    if (resources.referencedBytes > 64 * 1024 * 1024)
      throw new Error('EPUB resource limit exceeded');
  }
  return `${url}${target.fragment ? `#${encodeURIComponent(target.fragment)}` : ''}`;
}

/** Rewrite CSS as a token stream, never preserving an unexamined URL or import. */
export function epubCss(
  resources: EpubResources,
  path: string,
  source: string,
  chapter?: number,
  deferAccounting = false
): string {
  let size = 0;
  const active = new Set<string>();
  const parse = (
    file: string,
    css: string,
    depth: number,
    fragment = false
  ): string => {
    const inputBytes = new TextEncoder().encode(css).byteLength;
    size += inputBytes;
    resources.cssRewriteBytes = (resources.cssRewriteBytes ?? 0) + inputBytes;
    if (
      size > MAX_CSS ||
      depth > 4 ||
      resources.cssRewriteBytes > MAX_CSS_REWRITE_BYTES
    )
      throw new Error('CSS limit exceeded');
    if (!fragment && active.has(file)) throw new Error('CSS import loop');
    if (!fragment) active.add(file);
    let result = '';
    let i = 0;
    while (i < css.length) {
      if (css.startsWith('/*', i)) {
        const end = css.indexOf('*/', i + 2);
        i = end < 0 ? css.length : end + 2;
        result += ' ';
        continue;
      }
      const char = css[i]!;
      if (char === '"' || char === "'") {
        const start = i++;
        while (i < css.length) {
          if (css[i] === '\\') i += 2;
          else if (css[i++] === char) break;
        }
        const value = css.slice(start + 1, Math.max(start + 1, i - 1));
        result += /(?:https?:|\/\/|data:|javascript:)/i.test(decodeCss(value))
          ? '""'
          : css.slice(start, i);
        continue;
      }
      if (char === '@' || /[a-z_-]|\\/i.test(char)) {
        const start = i;
        if (char === '@') i++;
        while (i < css.length) {
          if (/[a-z0-9_-]/i.test(css[i]!)) i++;
          else if (css[i] === '\\' && i + 1 < css.length) {
            i++;
            const hex = /^[0-9a-f]{1,6}\s?/i.exec(css.slice(i));
            i += hex ? hex[0].length : 1;
          } else break;
        }
        if (i === start) {
          result += css[i++];
          continue;
        }
        const token = decodeCss(css.slice(start, i)).toLowerCase();
        let next = i;
        while (/\s/.test(css[next] ?? '') && next < css.length) next++;
        if (token === '@import') {
          if (fragment) throw new Error('Unsupported EPUB stylesheet import');
          while (css.startsWith('/*', next)) {
            const commentEnd = css.indexOf('*/', next + 2);
            if (commentEnd < 0)
              throw new Error('Unsupported EPUB stylesheet import');
            next = commentEnd + 2;
            while (/\s/.test(css[next] ?? '') && next < css.length) next++;
          }
          let end = next,
            quote = '',
            parens = 0;
          while (end < css.length) {
            const c = css[end++]!;
            if (c === '\\') end++;
            else if (quote) {
              if (c === quote) quote = '';
            } else if (c === '"' || c === "'") quote = c;
            else if (c === '/' && css[end] === '*') {
              const commentEnd = css.indexOf('*/', end + 1);
              if (commentEnd < 0)
                throw new Error('Unsupported EPUB stylesheet import');
              end = commentEnd + 2;
            } else if (c === '(') parens++;
            else if (c === ')') {
              if (--parens < 0)
                throw new Error('Unsupported EPUB stylesheet import');
            } else if (c === '{' || c === '}') {
              throw new Error('Unsupported EPUB stylesheet import');
            } else if (c === ';' && parens === 0) break;
          }
          const value = css.slice(next, end).trim();
          const match =
            /^(?:url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)]*))\s*\)|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')([\s\S]*);$/i.exec(
              value
            );
          if (!match || quote || parens !== 0)
            throw new Error('Unsupported EPUB stylesheet import');
          const href = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
          const target = href && resolveEpubPath(file, decodeCss(href));
          const bytes = target && resources.entries.get(target.path);
          const qualifiers = importQualifiers(match[6] ?? '');
          if (
            target &&
            (!bytes || resources.mediaTypes.get(target.path) !== 'text/css')
          )
            throw new Error('Unsupported EPUB stylesheet import');
          if (
            target &&
            bytes &&
            resources.mediaTypes.get(target.path) === 'text/css'
          ) {
            if (bytes.length > MAX_CSS) throw new Error('CSS limit exceeded');
            const imported = parse(
              target.path,
              new TextDecoder().decode(bytes),
              depth + 1
            );
            let expanded = imported;
            if (qualifiers.media)
              expanded = `@media ${parse(file, qualifiers.media, depth, true)}{${expanded}}`;
            if (qualifiers.supports)
              expanded = `@supports (${parse(file, qualifiers.supports, depth, true)}){${expanded}}`;
            if (qualifiers.layer !== undefined)
              expanded = `@layer${qualifiers.layer ? ` ${qualifiers.layer}` : ''}{${expanded}}`;
            if (result.length + expanded.length > MAX_CSS)
              throw new Error('CSS limit exceeded');
            result += expanded;
          }
          i = end;
          continue;
        }
        if (token === 'url' && css[next] === '(') {
          let end = next + 1,
            quote = '';
          while (end < css.length) {
            const c = css[end++]!;
            if (quote) {
              if (c === '\\') end++;
              else if (c === quote) quote = '';
            } else if (c === '"' || c === "'") quote = c;
            else if (c === ')') break;
          }
          let value = css.slice(next + 1, end - 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          )
            value = value.slice(1, -1);
          const decoded = decodeCss(value);
          const safe =
            chapter !== undefined &&
            decoded.startsWith('#') &&
            decoded.length > 1
              ? `#ep-${chapter}-${encodeURIComponent(decoded.slice(1))}`
              : epubDataUrl(resources, file, value, 'any', deferAccounting);
          const replacement = safe ? `url("${safe}")` : 'url("")';
          if (result.length + replacement.length > MAX_CSS)
            throw new Error('CSS limit exceeded');
          result += replacement;
          i = end;
          continue;
        }
        result += css.slice(start, i);
        continue;
      }
      result += char;
      i++;
    }
    if (!fragment) active.delete(file);
    return result;
  };
  const result = parse(path, source, 0);
  if (!deferAccounting) {
    resources.cssBytes += new TextEncoder().encode(result).byteLength;
    if (resources.cssBytes > MAX_CSS) throw new Error('CSS limit exceeded');
  }
  return result;
}
