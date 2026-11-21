import { resolveEpubPath } from '../../relic-format/src/epub-package.ts';

const MAX_CSS = 4 * 1024 * 1024;
const CSS_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  otf: 'font/otf',
  ttf: 'font/ttf',
};
function decodeCss(value: string): string {
  return value.replace(
    /\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
    (_, hex: string | undefined, char: string | undefined) =>
      hex
        ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
        : (char ?? '')
  );
}
export function epubDataUrl(
  entries: ReadonlyMap<string, Uint8Array>,
  base: string,
  href: string
): string | undefined {
  const target = resolveEpubPath(base, decodeCss(href.trim()));
  if (!target) return undefined;
  const bytes = entries.get(target.path);
  const extension = target.path.split('.').pop()?.toLowerCase() ?? '';
  const mime = CSS_MIMES[extension];
  if (!bytes || !mime || mime === 'image/svg+xml') return undefined;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${mime};base64,${btoa(binary)}${target.fragment ? `#${encodeURIComponent(target.fragment)}` : ''}`;
}

/** Rewrite CSS as a token stream, never preserving an unexamined URL or import. */
export function epubCss(
  entries: ReadonlyMap<string, Uint8Array>,
  path: string,
  source: string
): string {
  let size = 0;
  const active = new Set<string>();
  const parse = (file: string, css: string, depth: number): string => {
    size += new TextEncoder().encode(css).byteLength;
    if (size > MAX_CSS || depth > 4) throw new Error('CSS limit exceeded');
    if (active.has(file)) throw new Error('CSS import loop');
    active.add(file);
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
          let end = next,
            quote = '',
            parens = 0;
          while (end < css.length) {
            const c = css[end++]!;
            if (quote) {
              if (c === '\\') end++;
              else if (c === quote) quote = '';
            } else if (c === '"' || c === "'") quote = c;
            else if (c === '(') parens++;
            else if (c === ')') parens--;
            else if (c === ';' && parens <= 0) break;
          }
          const value = css.slice(next, end).trim();
          const match =
            /^(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|"([^"]*)"|'([^']*)')\s*;$/i.exec(
              value
            );
          const href =
            match && (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
          const target = href && resolveEpubPath(file, decodeCss(href));
          const bytes = target && entries.get(target.path);
          if (target && bytes && target.path.toLowerCase().endsWith('.css'))
            result += parse(
              target.path,
              new TextDecoder().decode(bytes),
              depth + 1
            );
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
          const safe = epubDataUrl(entries, file, value);
          result += safe ? `url("${safe}")` : 'url("")';
          i = end;
          continue;
        }
        result += css.slice(start, i);
        continue;
      }
      result += char;
      i++;
    }
    active.delete(file);
    return result;
  };
  return parse(path, source, 0);
}
