import { escapeHtml } from './markdown.ts';

export interface SourceSegment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly block: number;
  readonly kind: 'text' | 'join' | 'code';
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface MarkdownDelimiterPair {
  readonly kind: 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'image';
  readonly block: number;
  readonly open: SourceRange;
  readonly close: SourceRange;
}

export interface MarkdownWithSource {
  readonly html: string;
  readonly segments: readonly SourceSegment[];
  readonly delimiters: readonly MarkdownDelimiterPair[];
}

type SegmentKind = SourceSegment['kind'];

interface Origin {
  readonly start: number;
  readonly end: number;
  // The character before HTML escaping. Multiple HTML bytes can have one origin.
  readonly char: string;
  readonly kind: SegmentKind;
}

interface Mapped {
  readonly text: string;
  readonly origins: readonly (Origin | null)[];
  readonly start: number;
  readonly end: number;
}

interface Line {
  readonly value: Mapped;
  readonly newline: Mapped | null;
}

type MappedBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: Mapped }
  | { readonly kind: 'paragraph'; readonly text: Mapped }
  | { readonly kind: 'code'; readonly language: string; readonly text: Mapped }
  | { readonly kind: 'rule' }
  | { readonly kind: 'quote'; readonly blocks: readonly MappedBlock[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly Mapped[];
    }
  | {
      readonly kind: 'table';
      readonly header: readonly Mapped[];
      readonly rows: readonly (readonly Mapped[])[];
    };

function empty(at: number): Mapped {
  return { text: '', origins: [], start: at, end: at };
}

function literal(text: string): Mapped {
  return {
    text,
    origins: Array<null>(text.length).fill(null),
    start: 0,
    end: 0,
  };
}

function concat(parts: readonly Mapped[]): Mapped {
  if (parts.length === 0) return empty(0);
  return {
    text: parts.map((part) => part.text).join(''),
    origins: parts.flatMap((part) => part.origins),
    start: parts[0]?.start ?? 0,
    end: parts[parts.length - 1]?.end ?? 0,
  };
}

function slice(value: Mapped, start: number, end = value.text.length): Mapped {
  const before = value.origins[start - 1];
  const after = value.origins[start];
  const at = after?.start ?? before?.end ?? value.start;
  const origins = value.origins.slice(start, end);
  const first = origins.find((origin) => origin !== null);
  let last: Origin | null = null;
  for (let i = origins.length - 1; i >= 0; i--) {
    if (origins[i] !== null && origins[i] !== undefined) {
      last = origins[i] as Origin;
      break;
    }
  }
  return {
    text: value.text.slice(start, end),
    origins,
    start: first?.start ?? at,
    end: last?.end ?? at,
  };
}

function normalize(source: string): Mapped {
  const chars: string[] = [];
  const origins: Origin[] = [];
  for (let i = 0; i < source.length; i++) {
    const start = i;
    let char = source[i] as string;
    if (char === '\r') {
      if (source[i + 1] === '\n') i++;
      char = '\n';
    }
    chars.push(char);
    origins.push({ start, end: i + 1, char, kind: 'text' });
  }
  return { text: chars.join(''), origins, start: 0, end: source.length };
}

function splitLines(value: Mapped): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (true) {
    const index = value.text.indexOf('\n', start);
    if (index === -1) {
      lines.push({ value: slice(value, start), newline: null });
      return lines;
    }
    lines.push({
      value: slice(value, start, index),
      newline: slice(value, index, index + 1),
    });
    start = index + 1;
  }
}

function trim(value: Mapped): Mapped {
  const start = value.text.length - value.text.trimStart().length;
  const end = value.text.trimEnd().length;
  return slice(value, start, Math.max(start, end));
}

function joinLines(lines: readonly Line[]): Mapped {
  if (lines.length === 0) return empty(0);
  const parts: Mapped[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) parts.push((lines[i - 1] as Line).newline ?? literal('\n'));
    parts.push((lines[i] as Line).value);
  }
  return concat(parts);
}

// A blockquote marker can sit between the two rendered lines. Map the join to
// the contiguous whitespace containing the actual line break, not the marker.
function joinSpace(source: string, left: Mapped, right: Mapped): Mapped {
  const gapStart = Math.min(left.end, right.start);
  const gapEnd = Math.max(left.end, right.start);
  const gap = source.slice(gapStart, gapEnd);
  const breakAt = gap.search(/[\r\n]/);
  let start = breakAt < 0 ? 0 : breakAt;
  let end = breakAt < 0 ? gap.length : breakAt + 1;
  if (breakAt >= 0) {
    while (start > 0 && /\s/.test(gap[start - 1] as string)) start--;
    while (end < gap.length && /\s/.test(gap[end] as string)) end++;
  }
  const origin: Origin = {
    start: gapStart + start,
    end: gapStart + end,
    char: ' ',
    kind: 'join',
  };
  return { text: ' ', origins: [origin], start: origin.start, end: origin.end };
}

function joinWithSpaces(source: string, parts: readonly Mapped[]): Mapped {
  if (parts.length === 0) return empty(0);
  const joined: Mapped[] = [parts[0] as Mapped];
  for (let i = 1; i < parts.length; i++) {
    joined.push(joinSpace(source, parts[i - 1] as Mapped, parts[i] as Mapped));
    joined.push(parts[i] as Mapped);
  }
  return concat(joined);
}

function isTableSeparator(line: string | undefined): boolean {
  return (
    line !== undefined &&
    /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
  );
}

function splitRow(line: Mapped): Mapped[] {
  let row = line;
  const leading = /^\s*\|/.exec(row.text);
  if (leading !== null) row = slice(row, leading[0].length);
  const trailing = /\|\s*$/.exec(row.text);
  if (trailing !== null) row = slice(row, 0, trailing.index);
  const cells: Mapped[] = [];
  let start = 0;
  while (true) {
    const separator = row.text.indexOf('|', start);
    if (separator === -1) {
      cells.push(trim(slice(row, start)));
      return cells;
    }
    cells.push(trim(slice(row, start, separator)));
    start = separator + 1;
  }
}

// Mirrors parseMarkdown, retaining source positions through its line operations.
function parse(source: string, value: Mapped): MappedBlock[] {
  const lines = splitLines(value);
  const out: MappedBlock[] = [];
  let index = 0;
  let paragraph: Mapped[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    out.push({ kind: 'paragraph', text: joinWithSpaces(source, paragraph) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = (lines[index] as Line).value;
    const fence = /^```(\S*)\s*$/.exec(line.text);
    if (fence !== null) {
      flush();
      const body: Line[] = [];
      index++;
      while (
        index < lines.length &&
        !/^```\s*$/.test((lines[index] as Line).value.text)
      ) {
        body.push(lines[index] as Line);
        index++;
      }
      index++;
      out.push({
        kind: 'code',
        language: fence[1] ?? '',
        text: joinLines(body),
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line.text);
    if (heading !== null) {
      flush();
      const text = heading[2] as string;
      out.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        text: slice(line, line.text.length - text.length),
      });
      index++;
      continue;
    }

    if (/^\s*(-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/.test(line.text)) {
      flush();
      out.push({ kind: 'rule' });
      index++;
      continue;
    }

    if (/^\s*>/.test(line.text)) {
      flush();
      const quoted: Line[] = [];
      while (
        index < lines.length &&
        /^\s*>/.test((lines[index] as Line).value.text)
      ) {
        const original = lines[index] as Line;
        const prefix = /^\s*>\s?/.exec(original.value.text) as RegExpExecArray;
        quoted.push({
          value: slice(original.value, prefix[0].length),
          newline: original.newline,
        });
        index++;
      }
      out.push({ kind: 'quote', blocks: parse(source, joinLines(quoted)) });
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line.text)) {
      flush();
      const ordered = /^\s*\d+\./.test(line.text);
      const parts: Mapped[][] = [];
      while (index < lines.length) {
        const current = (lines[index] as Line).value;
        const marker = /^\s*([-*+]|\d+\.)\s+/.exec(current.text);
        if (marker !== null) {
          parts.push([slice(current, marker[0].length)]);
        } else if (
          /^\s+\S/.test(current.text) &&
          !/^\s*(>|```)/.test(current.text)
        ) {
          (parts[parts.length - 1] as Mapped[]).push(trim(current));
        } else {
          break;
        }
        index++;
      }
      // Joined once per item: joining after every continuation line copies the
      // whole accumulated item each time, which is quadratic in a wrapped item.
      const items: Mapped[] = parts.map((item) =>
        item.length === 1 ? (item[0] as Mapped) : joinWithSpaces(source, item)
      );
      out.push({ kind: 'list', ordered, items });
      continue;
    }

    if (
      line.text.includes('|') &&
      isTableSeparator(lines[index + 1]?.value.text)
    ) {
      flush();
      const header = splitRow(line);
      const rows: Mapped[][] = [];
      index += 2;
      while (
        index < lines.length &&
        (lines[index] as Line).value.text.includes('|') &&
        (lines[index] as Line).value.text.trim().length > 0
      ) {
        rows.push(splitRow((lines[index] as Line).value));
        index++;
      }
      out.push({ kind: 'table', header, rows });
      continue;
    }

    if (line.text.trim().length === 0) {
      flush();
      index++;
      continue;
    }
    paragraph.push(trim(line));
    index++;
  }
  flush();
  return out;
}

function withKind(value: Mapped, kind: SegmentKind): Mapped {
  return {
    ...value,
    origins: value.origins.map((origin) =>
      origin === null || origin.kind === 'join' ? origin : { ...origin, kind }
    ),
  };
}

function escapeMapped(value: Mapped, stripNul: boolean): Mapped {
  const chars: string[] = [];
  const origins: (Origin | null)[] = [];
  for (let i = 0; i < value.text.length; i++) {
    const char = value.text[i] as string;
    if (stripNul && char === '\u0000') continue;
    const escaped = escapeHtml(char);
    chars.push(escaped);
    for (let j = 0; j < escaped.length; j++)
      origins.push(value.origins[i] ?? null);
  }
  return { text: chars.join(''), origins, start: value.start, end: value.end };
}

function replaceMapped(
  value: Mapped,
  pattern: RegExp,
  replacement: (match: RegExpExecArray) => Mapped
): Mapped {
  const parts: Mapped[] = [];
  let cursor = 0;
  for (const match of value.text.matchAll(pattern)) {
    const index = match.index;
    parts.push(slice(value, cursor, index), replacement(match));
    cursor = index + match[0].length;
  }
  parts.push(slice(value, cursor));
  return concat(parts);
}

function range(
  value: Mapped,
  start: number,
  end: number,
  expected: string,
  source: string
): SourceRange | null {
  const origins = value.origins.slice(start, end);
  const first = origins[0];
  const last = origins[origins.length - 1];
  if (
    first === null ||
    first === undefined ||
    last === null ||
    last === undefined
  )
    return null;
  if (
    origins.some((origin) => origin === null) ||
    source.slice(first.start, last.end) !== expected
  )
    return null;
  return { start: first.start, end: last.end };
}

interface InlineContext {
  readonly source: string;
  readonly block: number;
  readonly delimiters: MarkdownDelimiterPair[];
}

function pair(
  value: Mapped,
  context: InlineContext,
  kind: MarkdownDelimiterPair['kind'],
  openStart: number,
  open: string,
  closeStart: number,
  close: string
): void {
  const opening = range(
    value,
    openStart,
    openStart + open.length,
    open,
    context.source
  );
  const closing = range(
    value,
    closeStart,
    closeStart + close.length,
    close,
    context.source
  );
  if (opening !== null && closing !== null) {
    context.delimiters.push({
      kind,
      block: context.block,
      open: opening,
      close: closing,
    });
  }
}

function safeHref(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed))
    return trimmed;
  return undefined;
}

function applyStrike(value: Mapped, context: InlineContext): Mapped {
  return replaceMapped(value, /~~([^~]+)~~/g, (match) => {
    const start = match.index;
    const end = start + match[0].length;
    pair(value, context, 'strike', start, '~~', end - 2, '~~');
    return concat([
      literal('<del>'),
      slice(value, start + 2, end - 2),
      literal('</del>'),
    ]);
  });
}

// Keep these passes in the same order as inline() in markdown.ts. In particular,
// they operate on escaped HTML, including markup emitted by earlier passes.
function inline(value: Mapped, context: InlineContext): Mapped {
  let out = escapeMapped(value, true);
  const code: Mapped[] = [];
  let input = out;
  out = replaceMapped(input, /`([^`]+)`/g, (match) => {
    const start = match.index;
    const end = start + match[0].length;
    pair(input, context, 'code', start, '`', end - 1, '`');
    code.push(withKind(slice(input, start + 1, end - 1), 'code'));
    return literal(`\u0000${code.length - 1}\u0000`);
  });

  input = out;
  out = replaceMapped(input, /!\[([^\]]*)\]\(([^)\s]+)\)/g, (match) => {
    const start = match.index;
    const alt = match[1] as string;
    const src = match[2] as string;
    if (safeHref(src) === undefined)
      return slice(input, start, start + match[0].length);
    const close = start + 2 + alt.length;
    pair(input, context, 'image', start, '![', close, ']');
    return concat([
      literal('<span class="md-image">'),
      slice(input, start + 2, close),
      literal('</span>'),
    ]);
  });

  input = out;
  out = replaceMapped(input, /\[([^\]]+)\]\(([^)\s]+)\)/g, (match) => {
    const start = match.index;
    const text = match[1] as string;
    const href = safeHref(match[2] as string);
    if (href === undefined) return slice(input, start, start + match[0].length);
    const close = start + 1 + text.length;
    pair(input, context, 'link', start, '[', close, ']');
    return concat([
      literal(
        `<a href="${href}" rel="noopener noreferrer nofollow" target="_blank">`
      ),
      slice(input, start + 1, close),
      literal('</a>'),
    ]);
  });

  input = out;
  out = replaceMapped(input, /\*\*([^*]+)\*\*/g, (match) => {
    const start = match.index;
    const end = start + match[0].length;
    pair(input, context, 'bold', start, '**', end - 2, '**');
    return concat([
      literal('<strong>'),
      slice(input, start + 2, end - 2),
      literal('</strong>'),
    ]);
  });

  input = out;
  out = replaceMapped(input, /(^|[^*])\*([^*]+)\*/g, (match) => {
    const start = match.index;
    const prefix = (match[1] as string).length;
    const open = start + prefix;
    const end = start + match[0].length;
    pair(input, context, 'italic', open, '*', end - 1, '*');
    return concat([
      slice(input, start, open),
      literal('<em>'),
      slice(input, open + 1, end - 1),
      literal('</em>'),
    ]);
  });

  out = applyStrike(out, context);

  input = out;
  out = replaceMapped(input, /\u0000(\d+)\u0000/g, (match) =>
    concat([
      literal('<code>'),
      code[Number(match[1])] ?? empty(0),
      literal('</code>'),
    ])
  );
  input = out;
  return replaceMapped(input, /\u0000/g, () => empty(0));
}

interface RenderContext {
  readonly source: string;
  readonly delimiters: MarkdownDelimiterPair[];
  nextBlock: number;
}

function renderBlock(block: MappedBlock, context: RenderContext): Mapped {
  const renderInline = (text: Mapped): Mapped => {
    const blockNumber = context.nextBlock++;
    return inline(tagBlock(text, blockNumber), {
      source: context.source,
      block: blockNumber,
      delimiters: context.delimiters,
    });
  };
  switch (block.kind) {
    case 'heading':
      return concat([
        literal(`<h${block.level}>`),
        renderInline(block.text),
        literal(`<\/h${block.level}>`),
      ]);
    case 'paragraph':
      return concat([
        literal('<p>'),
        renderInline(block.text),
        literal('</p>'),
      ]);
    case 'code': {
      const attribute =
        block.language.length > 0
          ? ` data-language="${escapeHtml(block.language)}"`
          : '';
      const body = withKind(block.text, 'code');
      const blockNumber = context.nextBlock++;
      return concat([
        literal(`<pre${attribute}><code>`),
        tagBlock(escapeMapped(body, false), blockNumber),
        literal('</code></pre>'),
      ]);
    }
    case 'rule':
      return literal('<hr>');
    case 'quote':
      return concat([
        literal('<blockquote>'),
        joinRendered(
          block.blocks.map((child) => renderBlock(child, context)),
          '\n'
        ),
        literal('</blockquote>'),
      ]);
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) =>
        concat([literal('<li>'), renderInline(item), literal('</li>')])
      );
      return concat([literal(`<${tag}>`), ...items, literal(`</${tag}>`)]);
    }
    case 'table': {
      const header = block.header.map((cell) =>
        concat([literal('<th>'), renderInline(cell), literal('</th>')])
      );
      const rows = block.rows.map((row) =>
        concat([
          literal('<tr>'),
          ...row.map((cell) =>
            concat([literal('<td>'), renderInline(cell), literal('</td>')])
          ),
          literal('</tr>'),
        ])
      );
      return concat([
        literal('<div class="md-scroll"><table><thead><tr>'),
        ...header,
        literal('</tr></thead><tbody>'),
        ...rows,
        literal('</tbody></table></div>'),
      ]);
    }
  }
}

// Block identity travels with origins until the final HTML serialization.
interface BlockOrigin extends Origin {
  readonly block: number;
}

function tagBlock(value: Mapped, block: number): Mapped {
  return {
    ...value,
    origins: value.origins.map((origin) =>
      origin === null ? null : { ...origin, block }
    ),
  };
}

function joinRendered(parts: readonly Mapped[], separator: string): Mapped {
  const result: Mapped[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) result.push(literal(separator));
    result.push(parts[i] as Mapped);
  }
  return concat(result);
}

function annotate(value: Mapped): { html: string; segments: SourceSegment[] } {
  const output: string[] = [];
  const segments: SourceSegment[] = [];
  let inTag = false;
  let quote = '';
  let index = 0;

  while (index < value.text.length) {
    const char = value.text[index] as string;
    const origin = value.origins[index] as BlockOrigin | null | undefined;
    if (inTag || char === '<' || origin === null || origin === undefined) {
      output.push(char);
      if (inTag) {
        if (quote !== '') {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '>') inTag = false;
      } else if (char === '<') inTag = true;
      index++;
      continue;
    }

    const block = origin.block;
    const kind = origin.kind;
    let text = origin.char;
    let end = origin.end;
    let previous = origin;
    let encoded = char;
    index++;
    while (index < value.text.length) {
      const next = value.origins[index] as BlockOrigin | null | undefined;
      const nextChar = value.text[index] as string;
      if (
        next === null ||
        next === undefined ||
        nextChar === '<' ||
        next.block !== block ||
        next.kind !== kind
      )
        break;
      const same = next.start === previous.start && next.end === previous.end;
      if (!same && (kind === 'join' || next.start !== end)) break;
      encoded += nextChar;
      if (!same) {
        text += next.char;
        end = next.end;
      }
      previous = next;
      index++;
    }
    const segment: SourceSegment = {
      text,
      start: origin.start,
      end,
      block,
      kind,
    };
    const number = segments.push(segment) - 1;
    output.push(`<span data-seg="${number}">`, encoded, '</span>');
  }
  return { html: output.join(''), segments };
}

/** Render the existing Markdown subset while preserving each visible source range. */
export function renderMarkdownWithSource(source: string): MarkdownWithSource {
  const context: RenderContext = { source, delimiters: [], nextBlock: 0 };
  const blocks = parse(source, normalize(source));
  const rendered = joinRendered(
    blocks.map((block) => renderBlock(block, context)),
    '\n'
  );
  const result = annotate(rendered);
  context.delimiters.sort(
    (a, b) => a.open.start - b.open.start || b.close.end - a.close.end
  );
  return { ...result, delimiters: context.delimiters };
}

/** The code view's pre.code-body is the one editable block, including its newlines. */
export function codeSegments(source: string): readonly SourceSegment[] {
  return [
    {
      text: source.replace(/[\r\u0000]/g, ''),
      start: 0,
      end: source.length,
      block: 0,
      kind: 'code',
    },
  ];
}
