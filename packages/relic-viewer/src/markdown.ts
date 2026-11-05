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

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
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
      const attribute =
        language.length > 0 ? ` data-language="${escapeHtml(language)}"` : '';
      out.push(
        `<pre${attribute}><code>${escapeHtml(body.join('\n'))}</code></pre>`
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      index++;
      continue;
    }

    if (/^\s*(-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/.test(line)) {
      flushParagraph();
      out.push('<hr>');
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
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
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
      const tag = ordered ? 'ol' : 'ul';
      const body = items.map((item) => `<li>${inline(item)}</li>`).join('');
      out.push(`<${tag}>${body}</${tag}>`);
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
      // Wide tables scroll inside their own container so the page body never
      // scrolls horizontally.
      out.push(
        '<div class="md-scroll"><table><thead><tr>' +
          header.map((cell) => `<th>${inline(cell)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`
            )
            .join('') +
          '</tbody></table></div>'
      );
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
  return out.join('\n');
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
