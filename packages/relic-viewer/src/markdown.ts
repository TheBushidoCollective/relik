/**
 * A small Markdown renderer, written rather than imported.
 *
 * The content is untrusted and the viewing origin is the one holding the
 * fragment secret, so the rule is absolute: **escape first, then add markup**.
 * Nothing in the source can ever become an element. A general-purpose library
 * would bring a raw-HTML passthrough that has to be disabled correctly, a
 * supply chain, and a bundle the strict CSP has to accommodate. This is the
 * subset that actually appears in agent output.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The code-span placeholder delimiter.
 *
 * A control character rather than something like a bare number wrapped in
 * spaces: ordinary prose containing " 0 " would otherwise be rewritten into
 * someone else's code span. Source NULs are stripped before any placeholder
 * is written, so content cannot forge one.
 */
const SENTINEL = '\u0000';

/**
 * Only `http`, `https`, and `mailto` survive.
 *
 * `javascript:` and `data:` are the two that turn a link into script
 * execution on this origin, which is fragment theft in one click.
 */
function safeHref(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  return undefined;
}

function inline(source: string): string {
  // Escaped up front, with source NULs stripped first. Every replacement
  // below inserts markup around text that is already inert.
  let out = escapeHtml(source.split(SENTINEL).join(''));

  // Code spans are lifted out first, so their contents are untouched by every
  // later rule.
  const spans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    spans.push(code);
    return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
  });

  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (match, alt: string, src: string) => {
      // An image would be a cross-origin request issued by the origin holding
      // the fragment. The alt text renders instead, and no request is made.
      return safeHref(src) === undefined
        ? match
        : `<span class="md-image">${alt}</span>`;
    }
  );

  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (match, text: string, url: string) => {
      const href = safeHref(url);
      if (href === undefined) return match;
      return (
        `<a href="${href}" rel="noopener noreferrer nofollow" ` +
        `target="_blank">${text}</a>`
      );
    }
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  const restore = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  out = out.replace(restore, (_match, index: string) => {
    return `<code>${spans[Number(index)] ?? ''}</code>`;
  });

  // Anything left is an unpaired sentinel we placed. Drop it rather than let
  // a control character reach the DOM.
  return out.split(SENTINEL).join('');
}

/**
 * A parsed block. Inline text is kept as source rather than parsed, because
 * `inline` is the one place that decides what emphasis, links, and code spans
 * mean, and every emitter reads its answer through it.
 */
export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly string[];
    }
  | {
      readonly kind: 'table';
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

/**
 * One styled stretch of text. Formatting is flags rather than a tree because
 * the emphasis rules in `inline` are independent passes that can overlap, and
 * a word processor wants runs, not nesting.
 */
export interface InlineRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  /** The alt text of an image, which is all that ever renders of one. */
  readonly image: boolean;
  /** Present only for a link that passed `safeHref`. */
  readonly href?: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** The inverse of `escapeHtml`, in one pass so `&amp;lt;` stays `&lt;`. */
function unescapeHtml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => ENTITIES[entity] as string
  );
}

/**
 * The styled runs of one inline source string, for emitters that are not HTML.
 *
 * This reads the output of `inline` instead of re-implementing it, so a Word
 * file and the page it was exported from cannot disagree about what is bold,
 * what is a link, or which links survive `safeHref`. That is safe to do
 * because the markup is closed: `inline` escapes first, so every `<` in its
 * output is a tag it emitted itself, from a fixed set.
 */
export function inlineRuns(source: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const open = { bold: 0, italic: 0, strike: 0, code: 0, image: 0 };
  let href: string | undefined;

  const pattern = /<(\/?)(strong|em|del|code|a|span)((?:\s[^>]*)?)>|([^<]+)/g;
  for (const token of inline(source).matchAll(pattern)) {
    const text = token[4];
    if (text !== undefined) {
      runs.push({
        text: unescapeHtml(text),
        bold: open.bold > 0,
        italic: open.italic > 0,
        strike: open.strike > 0,
        code: open.code > 0,
        image: open.image > 0,
        ...(href === undefined ? {} : { href }),
      });
      continue;
    }

    const closing = token[1] === '/';
    const delta = closing ? -1 : 1;
    switch (token[2]) {
      case 'strong':
        open.bold = Math.max(0, open.bold + delta);
        break;
      case 'em':
        open.italic = Math.max(0, open.italic + delta);
        break;
      case 'del':
        open.strike = Math.max(0, open.strike + delta);
        break;
      case 'code':
        open.code = Math.max(0, open.code + delta);
        break;
      case 'span':
        open.image = Math.max(0, open.image + delta);
        break;
      case 'a':
        href = closing
          ? undefined
          : unescapeHtml(/href="([^"]*)"/.exec(token[3] ?? '')?.[1] ?? '');
        break;
    }
  }
  return runs;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] as string;

    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence !== null) {
      flushParagraph();
      const language = fence[1] ?? '';
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index] as string)) {
        body.push(lines[index] as string);
        index++;
      }
      index++;
      out.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      out.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        text: heading[2] as string,
      });
      index++;
      continue;
    }

    if (/^\s*(-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/.test(line)) {
      flushParagraph();
      out.push({ kind: 'rule' });
      index++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] as string)) {
        quoted.push((lines[index] as string).replace(/^\s*>\s?/, ''));
        index++;
      }
      out.push({ kind: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] as string;
        if (/^\s*([-*+]|\d+\.)\s+/.test(current)) {
          items.push(current.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        } else if (/^\s+\S/.test(current) && !/^\s*(>|```)/.test(current)) {
          // A wrapped item: the line is indented under the one before it.
          items[items.length - 1] += ` ${current.trim()}`;
        } else {
          break;
        }
        index++;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (
        index < lines.length &&
        (lines[index] as string).includes('|') &&
        (lines[index] as string).trim().length > 0
      ) {
        rows.push(splitRow(lines[index] as string));
        index++;
      }
      out.push({ kind: 'table', header, rows });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index++;
      continue;
    }

    paragraph.push(line.trim());
    index++;
  }

  flushParagraph();
  return out;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${inline(block.text)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${inline(block.text)}</p>`;
    case 'code': {
      const attribute =
        block.language.length > 0
          ? ` data-language="${escapeHtml(block.language)}"`
          : '';
      return `<pre${attribute}><code>${escapeHtml(block.text)}</code></pre>`;
    }
    case 'rule':
      return '<hr>';
    case 'quote':
      return `<blockquote>${block.blocks.map(renderBlock).join('\n')}</blockquote>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const body = block.items.map((item) => `<li>${inline(item)}</li>`);
      return `<${tag}>${body.join('')}</${tag}>`;
    }
    case 'table':
      // Wide tables scroll inside their own container so the page body never
      // scrolls horizontally.
      return (
        '<div class="md-scroll"><table><thead><tr>' +
        block.header.map((cell) => `<th>${inline(cell)}</th>`).join('') +
        '</tr></thead><tbody>' +
        block.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`
          )
          .join('') +
        '</tbody></table></div>'
      );
  }
}

export function renderMarkdown(source: string): string {
  return parseMarkdown(source).map(renderBlock).join('\n');
}

function isTableSeparator(line: string | undefined): boolean {
  if (line === undefined) return false;
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'def',
  'default',
  'defer',
  'del',
  'do',
  'elif',
  'else',
  'end',
  'enum',
  'except',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'fn',
  'for',
  'from',
  'func',
  'function',
  'go',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'is',
  'let',
  'match',
  'mod',
  'module',
  'mut',
  'new',
  'nil',
  'None',
  'not',
  'null',
  'or',
  'package',
  'pass',
  'private',
  'protected',
  'pub',
  'public',
  'raise',
  'return',
  'select',
  'self',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'use',
  'var',
  'void',
  'when',
  'where',
  'while',
  'with',
  'yield',
]);

/**
 * Lightweight generic highlighting: strings, comments, numbers, keywords.
 *
 * Deliberately language-agnostic rather than a set of per-language grammars.
 * It is honest about what it is and never guesses a language it cannot
 * verify. Escaping happens before any markup is added, same rule as above.
 */
export function highlightCode(source: string): string {
  const escaped = escapeHtml(source);

  return escaped.replace(
    /(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#39;(?:[^&]|&(?!#39;))*?&#39;)|(\/\/[^\n]*|#[^\n]*|--[^\n]*)|(\/\*[\s\S]*?\*\/)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g,
    (match, str, lineComment, blockComment, num, word) => {
      if (str !== undefined) return `<span class="tok-str">${str}</span>`;
      if (lineComment !== undefined) {
        return `<span class="tok-com">${lineComment}</span>`;
      }
      if (blockComment !== undefined) {
        return `<span class="tok-com">${blockComment}</span>`;
      }
      if (num !== undefined) return `<span class="tok-num">${num}</span>`;
      if (word !== undefined && KEYWORDS.has(word)) {
        return `<span class="tok-kw">${word}</span>`;
      }
      return match;
    }
  );
}
