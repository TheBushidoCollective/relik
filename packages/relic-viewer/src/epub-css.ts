import { resolveEpubPath } from '../../relic-format/src/epub-package.ts';

const MAX_CSS = 4 * 1024 * 1024;
export interface EpubResources {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly mediaTypes: ReadonlyMap<string, string>;
  readonly dataUrls: Map<string, string>;
  readonly mediaUrls: Map<string, string>;
  svgDataUrl?: (path: string) => string | undefined;
  encodedBytes: number;
  referencedBytes: number;
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

/** Contain stylesheet rules without allowing unmatched braces to escape the scope. */
export function scopeEpubCss(
  css: string,
  chapter: number,
  isolatedSvg = false,
  resources?: EpubResources
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
  const rewriteRules = (rules: CSSRuleList): string =>
    Array.from(rules, (rule) => {
      if (rule.type === CSSRule.STYLE_RULE) {
        const style = rule as CSSStyleRule;
        const nestedRules = (
          style as CSSStyleRule & { readonly cssRules?: CSSRuleList }
        ).cssRules;
        const nested = nestedRules ? rewriteRules(nestedRules) : '';
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
          return `${mapped}{${rewriteRules(group.cssRules)}}`;
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
    resources.cssBytes += Math.max(
      0,
      bytes - new TextEncoder().encode(css).byteLength
    );
    if (resources.cssBytes > MAX_CSS) throw new Error('CSS limit exceeded');
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
export function epubDataUrl(
  resources: EpubResources,
  base: string,
  href: string,
  kind: 'image' | 'any' = 'any'
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
  resources.referencedBytes += url.length;
  if (resources.referencedBytes > 64 * 1024 * 1024)
    throw new Error('EPUB resource limit exceeded');
  return `${url}${target.fragment ? `#${encodeURIComponent(target.fragment)}` : ''}`;
}

/** Rewrite CSS as a token stream, never preserving an unexamined URL or import. */
export function epubCss(
  resources: EpubResources,
  path: string,
  source: string,
  chapter?: number
): string {
  let size = 0;
  const active = new Set<string>();
  const parse = (
    file: string,
    css: string,
    depth: number,
    fragment = false
  ): string => {
    size += new TextEncoder().encode(css).byteLength;
    if (size > MAX_CSS || depth > 4) throw new Error('CSS limit exceeded');
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
              : epubDataUrl(resources, file, value);
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
  resources.cssBytes += new TextEncoder().encode(result).byteLength;
  if (resources.cssBytes > MAX_CSS) throw new Error('CSS limit exceeded');
  return result;
}
