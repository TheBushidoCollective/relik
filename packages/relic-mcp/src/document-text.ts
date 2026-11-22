/**
 * `quote` and `text` anchors on a Word document or an EPUB, placed against the
 * text a reader sees (plan section 5). The viewer takes a quote from the frame's
 * selection, so the text searched is the text shown, never the ZIP bytes it is
 * stored in.
 *
 * A DOCX yields its main story, one line per paragraph. Its main part is the one
 * `_rels/.rels` names as the office document, and that must be word/document.xml.
 * Tracked deletions, hidden runs and the fallback copy of an alternate-content
 * block are not shown, so they are not searched. An EPUB yields its spine in
 * order, once per distinct chapter, one line per block. Elements the frame hides
 * (`hidden`, `aria-hidden`, inline `display:none`) are not searched.
 *
 * Read-only and bounded. Every limit in DOCUMENT_LIMITS is counted across the
 * whole document, and a part that passes a limit ends the search as too large.
 * A chapter that cannot be read is counted, and every placement says how many
 * were skipped, so a result never hides text it did not search. Nothing runs a
 * script, follows a link or opens a part that a package names only by URL.
 *
 * The line a placement reports counts the text's own lines: one per paragraph
 * or block with text, and one per explicit line break. A Word document or an
 * EPUB has no line of the file to report.
 */

import { deriveRendererClass } from '@relic/format';
import { zipContainerKindSync } from '@relic/format/containers';
import { readEpubPackage } from '@relic/format/epub-package';
import { packagePath } from '@relic/format/xlsx';
import {
  decodeXmlBytes,
  localName,
  parseXml,
  scanForbiddenDtd,
  type XmlElement,
} from '@relic/format/xml';
import {
  indexZip,
  type ZipIndex,
  type ZipLimits,
} from '@relic/format/zip-index';
import { nodeInflater } from './node-inflater.ts';

export type DocumentKind = 'docx' | 'epub';
export type DocumentRefusal = 'protected' | 'corrupt' | 'too-large';

export interface DocumentLimits {
  /** Inflated bytes read from the document's parts, in total. */
  readonly bytes: number;
  /** Markup tags parsed, in total. Each `<` is counted before its part is parsed. */
  readonly tags: number;
  /** Characters of extracted text, in total. */
  readonly text: number;
  /** Items in an EPUB spine. */
  readonly spine: number;
  /** Inflated bytes of any one part, checked before the part is read. */
  readonly part: number;
  /** Character comparisons spent placing one quote. */
  readonly steps: number;
}

export const DOCUMENT_LIMITS: DocumentLimits = {
  bytes: 64 * 1024 * 1024,
  tags: 2_000_000,
  text: 16 * 1024 * 1024,
  spine: 2_000,
  part: 16 * 1024 * 1024,
  steps: 32_000_000,
};

export const DOCUMENT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/** Characters of text kept on each side of a placed quote. */
const CONTEXT_CHARS = 120;
/** Line numbers listed in an explanation before the rest are only counted. */
const LISTED = 5;
const RELATIONSHIPS = '_rels/.rels';
const DOCX_MAIN = 'word/document.xml';
const SPACE = 32;
const SPACE_CHAR = /\s/;
const NO_TEXT_MEDIA = /^(image|audio|video|font)\//;

const ZIP_TOO_LARGE: Record<string, true> = {
  'total-too-large': true,
  'entry-too-large': true,
  'too-many-entries': true,
  'directory-too-large': true,
};

/** The searchable text of one document, with what it needs to place a position. */
export interface DocumentText {
  /** The text with every whitespace run collapsed to one space. */
  readonly flat: string;
  /** Positions in `flat` where a collapsed run held at least one line break, ascending. */
  readonly breakAt: readonly number[];
  /** `breakLines[k]` is the number of line breaks before `breakAt[k]`. */
  readonly breakLines: readonly number[];
  /** Chapters that could not be read, and so are not in `flat`. */
  readonly unreadable: number;
}

type Failure = { readonly ok: false; readonly reason: DocumentRefusal };
type Read<T> = { readonly ok: true; readonly value: T } | Failure;
type Extracted =
  | { readonly ok: true; readonly text: string; readonly unreadable: number }
  | Failure;

const CORRUPT: Failure = { ok: false, reason: 'corrupt' };
const TOO_LARGE: Failure = { ok: false, reason: 'too-large' };

export type IndexedDocument =
  | {
      readonly ok: true;
      readonly format: DocumentKind;
      readonly text: DocumentText;
    }
  | Failure;

export interface QuoteQuery {
  readonly exact: string;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
}

export interface DocumentQuote extends QuoteQuery {
  readonly kind: 'quote' | 'text';
}

export type Placement =
  | {
      readonly kind: 'placed';
      readonly exact: string;
      readonly at: number;
      /** Whether the words on both sides match the reference exactly, ignoring spacing. */
      readonly contextMatched: boolean;
      readonly occurrences: number;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'exhausted' }
  | {
      readonly kind: 'ambiguous';
      readonly occurrences: number;
      readonly exactMatches: number;
      readonly lines: readonly number[];
    };

export type QuoteResolution =
  | {
      readonly status: 'resolved';
      readonly exact: string;
      readonly line: number;
      readonly context_before: string;
      readonly context_after: string;
      readonly context_matched: boolean;
      readonly occurrences: number;
      readonly unreadable_chapters: number;
    }
  | { readonly status: 'unresolvable'; readonly explanation: string };

export type DocumentQuoteResolution =
  | ({
      readonly kind: 'quote' | 'text';
      readonly format: DocumentKind;
    } & Extract<QuoteResolution, { readonly status: 'resolved' }>)
  | {
      readonly kind: 'quote' | 'text';
      readonly status: 'unresolvable';
      readonly explanation: string;
    };

/** The document format a relic holds, when it is a Word document or an EPUB. */
export function documentKindOf(
  content: Uint8Array,
  filename: string
): DocumentKind | undefined {
  if (deriveRendererClass(content, filename) !== 'document') return undefined;
  const kind = zipContainerKindSync(content);
  return kind === 'docx' || kind === 'epub' ? kind : undefined;
}

const indexes = new WeakMap<Uint8Array, Promise<IndexedDocument>>();

/** One index per decrypted version, shared by every quote comment on it. */
export function documentIndexFor(
  content: Uint8Array,
  kind: DocumentKind
): Promise<IndexedDocument> {
  let pending = indexes.get(content);
  if (pending === undefined) {
    pending = indexFromBytes(content, kind);
    indexes.set(content, pending);
  }
  return pending;
}

/** Indexes a document from its bytes. */
export async function indexFromBytes(
  content: Uint8Array,
  kind: DocumentKind,
  limits: DocumentLimits = DOCUMENT_LIMITS
): Promise<IndexedDocument> {
  let zip: ZipIndex;
  try {
    const indexed = await indexZip(content, DOCUMENT_ZIP_LIMITS, nodeInflater);
    if (!indexed.ok) {
      return {
        ok: false,
        reason:
          ZIP_TOO_LARGE[indexed.reason] === true ? 'too-large' : 'corrupt',
      };
    }
    zip = indexed.index;
  } catch {
    return CORRUPT;
  }
  return indexFromZip(zip, kind, limits);
}

/** Indexes a document from an opened ZIP. Each part is read once, however often it is named. */
export async function indexFromZip(
  zip: ZipIndex,
  kind: DocumentKind,
  limits: DocumentLimits = DOCUMENT_LIMITS
): Promise<IndexedDocument> {
  try {
    const budget = new Budget(limits);
    const extracted =
      kind === 'docx'
        ? await docxText(zip, budget)
        : await epubText(zip, budget);
    if (!extracted.ok) return extracted;
    return {
      ok: true,
      format: kind,
      text: indexText(extracted.text, extracted.unreadable),
    };
  } catch {
    return CORRUPT;
  }
}

/**
 * The limits of one document, shared by every part read from it. A part is
 * read once. The byte, tag and text totals are charged before a part is parsed,
 * so a part that would pass a total is refused before its work is done.
 */
class Budget {
  readonly limits: DocumentLimits;
  #bytes = 0;
  #tags = 0;
  #text = 0;
  readonly #parts = new Map<string, Read<Uint8Array>>();

  constructor(limits: DocumentLimits) {
    this.limits = limits;
  }

  async part(zip: ZipIndex, name: string): Promise<Read<Uint8Array>> {
    const seen = this.#parts.get(name);
    if (seen !== undefined) return seen;
    const outcome = await this.#read(zip, name);
    this.#parts.set(name, outcome);
    return outcome;
  }

  async #read(zip: ZipIndex, name: string): Promise<Read<Uint8Array>> {
    const entry = zip.entries.get(name);
    if (entry === undefined || entry.kind !== 'file') return CORRUPT;
    if (entry.size > this.limits.part) return TOO_LARGE;
    const read = await zip.read(name);
    if (!read.ok) {
      return read.reason === 'entry-too-large' ||
        read.reason === 'total-too-large'
        ? TOO_LARGE
        : CORRUPT;
    }
    this.#bytes += read.bytes.length;
    if (this.#bytes > this.limits.bytes) return TOO_LARGE;
    return { ok: true, value: read.bytes };
  }

  /** One markup part, parsed. Its tags are charged before any element is built. */
  markup(source: string, lenient: boolean): Read<XmlElement> {
    this.#tags += countOf(source, '<');
    if (this.#tags > this.limits.tags) return TOO_LARGE;
    const parsed = parseXml(source, {
      lenient,
      maxNodes: this.limits.tags,
      maxTextChars: this.limits.text,
    });
    if (parsed.ok) return { ok: true, value: parsed.root };
    return parsed.reason === 'size' ? TOO_LARGE : CORRUPT;
  }

  /** Charges extracted text. False once the document holds more than the text limit. */
  addText(length: number): boolean {
    this.#text += length;
    return this.#text <= this.limits.text;
  }
}

function countOf(text: string, needle: string): number {
  let count = 0;
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  )
    count++;
  return count;
}

/**
 * Text being built for one document. A line break is written only after text, so
 * an empty paragraph adds no line. Literal line breaks in XML text are whitespace.
 */
class Flow {
  readonly #parts: string[] = [];
  #open = false;

  text(value: string): void {
    if (value === '') return;
    const plain = value.replace(/[\r\n]+/g, ' ');
    this.#parts.push(plain);
    if (/\S/.test(plain)) this.#open = true;
  }

  /** The end of a paragraph or block: a line break, if the block wrote anything. */
  endBlock(): void {
    if (!this.#open) return;
    this.#parts.push('\n');
    this.#open = false;
  }

  /** An explicit line break inside a block (`w:br`, `<br>`). */
  hardBreak(): void {
    this.#parts.push('\n');
  }

  toString(): string {
    return this.#parts.join('');
  }
}

function elements(node: XmlElement): XmlElement[] {
  return node.children.filter(
    (child): child is XmlElement => typeof child !== 'string'
  );
}

function attribute(node: XmlElement, name: string): string | undefined {
  for (const [key, value] of node.attrs)
    if (localName(key) === name) return value;
  return undefined;
}

function textOf(node: XmlElement): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

/**
 * Elements that hold no text a reader sees: tracked deletions, legacy field data,
 * properties and instructions.
 */
const DOCX_UNSHOWN: Record<string, true> = {
  del: true,
  delText: true,
  moveFrom: true,
  instrText: true,
  delInstrText: true,
  fldData: true,
  rPr: true,
  pPr: true,
  tblPr: true,
  trPr: true,
  tcPr: true,
  sectPr: true,
};

/** Whether a run's own properties hide it: `w:vanish`, unless its value turns hiding off. */
function isHiddenRun(run: XmlElement): boolean {
  const props = elements(run).find((node) => localName(node.name) === 'rPr');
  const vanish =
    props === undefined
      ? undefined
      : elements(props).find((node) => localName(node.name) === 'vanish');
  if (vanish === undefined) return false;
  const value = attribute(vanish, 'val');
  return (
    value === undefined ||
    !['0', 'false', 'off'].includes(value.trim().toLowerCase())
  );
}

/** An alternate-content block shows its choice, or its fallback when it has none. */
function collectAlternate(block: XmlElement, flow: Flow): void {
  const parts = elements(block);
  const shown =
    parts.find((node) => localName(node.name) === 'Choice') ??
    parts.find((node) => localName(node.name) === 'Fallback');
  if (shown !== undefined) collectDocx(shown, flow);
}

function collectDocx(node: XmlElement, flow: Flow): void {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    const name = localName(child.name);
    if (DOCX_UNSHOWN[name] === true) continue;
    switch (name) {
      case 'AlternateContent':
        collectAlternate(child, flow);
        break;
      case 'r':
        if (!isHiddenRun(child)) collectDocx(child, flow);
        break;
      case 't':
        flow.text(textOf(child));
        break;
      case 'tab':
      case 'ptab':
        flow.text('\t');
        break;
      case 'br':
      case 'cr':
        flow.hardBreak();
        break;
      case 'noBreakHyphen':
        flow.text('-');
        break;
      case 'p':
        flow.endBlock();
        collectDocx(child, flow);
        flow.endBlock();
        break;
      default:
        collectDocx(child, flow);
    }
  }
}

/** Elements the frame hides, or that hold no visible text. */
const XHTML_HIDDEN: Record<string, true> = {
  desc: true,
  head: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  title: true,
};

const XHTML_BLOCK: Record<string, true> = {
  address: true,
  article: true,
  aside: true,
  blockquote: true,
  body: true,
  caption: true,
  dd: true,
  div: true,
  dl: true,
  dt: true,
  figcaption: true,
  figure: true,
  footer: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  header: true,
  hr: true,
  html: true,
  li: true,
  main: true,
  nav: true,
  ol: true,
  p: true,
  pre: true,
  section: true,
  table: true,
  tbody: true,
  tfoot: true,
  thead: true,
  tr: true,
  ul: true,
};

function isHiddenXhtml(element: XmlElement): boolean {
  if (XHTML_HIDDEN[localName(element.name)] === true) return true;
  if (element.attrs.has('hidden')) return true;
  if ((element.attrs.get('aria-hidden') ?? '').trim().toLowerCase() === 'true')
    return true;
  const style = (element.attrs.get('style') ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function collectXhtml(node: XmlElement, flow: Flow): void {
  for (const child of node.children) {
    if (typeof child === 'string') {
      flow.text(child);
      continue;
    }
    if (isHiddenXhtml(child)) continue;
    const name = localName(child.name);
    if (name === 'br') {
      flow.hardBreak();
      continue;
    }
    const block = XHTML_BLOCK[name] === true;
    if (block) flow.endBlock();
    collectXhtml(child, flow);
    if (block) flow.endBlock();
    else if (name === 'td' || name === 'th') flow.text('\t');
  }
}

async function docxText(zip: ZipIndex, budget: Budget): Promise<Extracted> {
  const rels = await budget.part(zip, RELATIONSHIPS);
  if (!rels.ok) return rels;
  const relsSource = decodeXmlBytes(rels.value);
  if (scanForbiddenDtd(relsSource, 'docx')) return CORRUPT;
  const relations = budget.markup(relsSource, false);
  if (!relations.ok) return relations;
  const offices = elements(relations.value).filter(
    (node) =>
      localName(node.name) === 'Relationship' &&
      (attribute(node, 'Type') ?? '').endsWith('/officeDocument')
  );
  const office = offices[0];
  if (
    office === undefined ||
    offices.length > 1 ||
    attribute(office, 'TargetMode') === 'External'
  )
    return CORRUPT;
  let main: string;
  try {
    main = packagePath('', attribute(office, 'Target') ?? '');
  } catch {
    return CORRUPT;
  }
  if (main !== DOCX_MAIN) return CORRUPT;
  const part = await budget.part(zip, DOCX_MAIN);
  if (!part.ok) return part;
  const source = decodeXmlBytes(part.value);
  if (scanForbiddenDtd(source, 'docx')) return CORRUPT;
  const root = budget.markup(source, false);
  if (!root.ok) return root;
  const flow = new Flow();
  collectDocx(root.value, flow);
  const text = flow.toString();
  return budget.addText(text.length)
    ? { ok: true, text, unreadable: 0 }
    : TOO_LARGE;
}

async function epubText(zip: ZipIndex, budget: Budget): Promise<Extracted> {
  const book = await readEpubPackage(zip);
  if (!book.ok) return { ok: false, reason: book.reason };
  const { spine, resources } = book.book;
  if (spine.length > budget.limits.spine) return TOO_LARGE;
  const media = new Map(
    resources.map((resource) => [resource.path, resource.mediaType] as const)
  );
  const seen = new Set<string>();
  const chapters: string[] = [];
  let unreadable = 0;
  for (const item of spine) {
    // A repeated spine item shows the same text again. It is read and searched once.
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    if (NO_TEXT_MEDIA.test(media.get(item.path) ?? '')) continue;
    const part = await budget.part(zip, item.path);
    if (!part.ok) {
      if (part.reason === 'too-large') return part;
      unreadable++;
      continue;
    }
    const root = budget.markup(decodeXmlBytes(part.value), true);
    if (!root.ok) {
      if (root.reason === 'too-large') return root;
      unreadable++;
      continue;
    }
    const flow = new Flow();
    if (!isHiddenXhtml(root.value)) collectXhtml(root.value, flow);
    const chapter = flow.toString();
    const line =
      chapter === '' || chapter.endsWith('\n') ? chapter : `${chapter}\n`;
    if (!budget.addText(line.length)) return TOO_LARGE;
    chapters.push(line);
  }
  return { ok: true, text: chapters.join(''), unreadable };
}

/** Builds the flat text, and the table that turns a position in it into a line. */
export function indexText(text: string, unreadable: number): DocumentText {
  const breakAt: number[] = [];
  const breakLines: number[] = [0];
  let shrink = 0;
  const flat = text.replace(/\s+/g, (run: string, offset: number) => {
    let newlines = 0;
    for (let at = 0; at < run.length; at++)
      if (run.charCodeAt(at) === 10) newlines++;
    if (newlines > 0) {
      breakAt.push(offset - shrink);
      breakLines.push((breakLines[breakLines.length - 1] ?? 0) + newlines);
    }
    shrink += run.length - 1;
    return ' ';
  });
  return { flat, breakAt, breakLines, unreadable };
}

/** The line a position in `flat` is on: one more than the line breaks before it. */
export function lineAt(text: DocumentText, at: number): number {
  let low = 0;
  let high = text.breakAt.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((text.breakAt[middle] ?? 0) < at) low = middle + 1;
    else high = middle;
  }
  return 1 + (text.breakLines[low] ?? 0);
}

function isSpaceCode(code: number): boolean {
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  return code >= 0x80 && SPACE_CHAR.test(String.fromCharCode(code));
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface Match {
  /** Non-space characters of the reference that agree with the text. */
  readonly matched: number;
  /** Whether every non-space character of the reference agrees. */
  readonly exact: boolean;
  /** Character comparisons spent, counted against the search limit. */
  readonly steps: number;
}

/** Agreement of the text before `at` with `reference`, nearest character first, ignoring spacing. */
function matchBefore(flat: string, at: number, reference: string): Match {
  let r = reference.length - 1;
  let f = at - 1;
  let matched = 0;
  let steps = 0;
  while (true) {
    while (r >= 0 && isSpaceCode(reference.charCodeAt(r))) {
      r--;
      steps++;
    }
    if (r < 0) return { matched, exact: true, steps };
    while (f >= 0 && flat.charCodeAt(f) === SPACE) {
      f--;
      steps++;
    }
    steps++;
    if (f < 0 || flat.charCodeAt(f) !== reference.charCodeAt(r))
      return { matched, exact: false, steps };
    matched++;
    r--;
    f--;
  }
}

/** Agreement of the text from `from` with `reference`, nearest character first, ignoring spacing. */
function matchAfter(flat: string, from: number, reference: string): Match {
  let r = 0;
  let f = from;
  let matched = 0;
  let steps = 0;
  while (true) {
    while (r < reference.length && isSpaceCode(reference.charCodeAt(r))) {
      r++;
      steps++;
    }
    if (r >= reference.length) return { matched, exact: true, steps };
    while (f < flat.length && flat.charCodeAt(f) === SPACE) {
      f++;
      steps++;
    }
    steps++;
    if (f >= flat.length || flat.charCodeAt(f) !== reference.charCodeAt(r))
      return { matched, exact: false, steps };
    matched++;
    r++;
    f++;
  }
}

/**
 * Places a quote in the text. Every occurrence of the quote is compared with the
 * text on either side of it, ignoring spacing, so a context that differs only at
 * a paragraph break still matches.
 *
 * - One occurrence whose surroundings match exactly is the place.
 * - Several occurrences with exact surroundings are ambiguous, and so is a quote
 *   whose surroundings are no closer to one occurrence than to another.
 * - A quote with one occurrence is placed even when its surroundings differ;
 *   the result says so.
 * - A quote whose occurrences together need more comparisons than the limit is
 *   not placed at all. Nothing is ever chosen from a part of the search.
 */
export function placeQuote(
  text: DocumentText,
  query: QuoteQuery,
  limits: DocumentLimits = DOCUMENT_LIMITS
): Placement {
  const exact = collapseWhitespace(query.exact);
  if (exact === '') return { kind: 'absent' };
  const before = query.prefix ?? '';
  const after = query.suffix ?? '';
  const { flat } = text;
  let steps = 0;
  let occurrences = 0;
  let firstAt = -1;
  let exactMatches = 0;
  const exactAt: number[] = [];
  let bestScore = -1;
  let bestCount = 0;
  const bestAt: number[] = [];
  for (
    let at = flat.indexOf(exact);
    at !== -1;
    at = flat.indexOf(exact, at + 1)
  ) {
    occurrences++;
    if (firstAt === -1) firstAt = at;
    const back = matchBefore(flat, at, before);
    const forward = matchAfter(flat, at + exact.length, after);
    steps += 1 + back.steps + forward.steps;
    if (steps > limits.steps) return { kind: 'exhausted' };
    if (back.exact && forward.exact) {
      exactMatches++;
      if (exactAt.length < LISTED) exactAt.push(at);
    }
    const score = back.matched + forward.matched;
    if (score > bestScore) {
      bestScore = score;
      bestCount = 1;
      bestAt.length = 0;
      bestAt.push(at);
    } else if (score === bestScore) {
      bestCount++;
      if (bestAt.length < LISTED) bestAt.push(at);
    }
  }
  if (occurrences === 0) return { kind: 'absent' };
  if (exactMatches === 1)
    return {
      kind: 'placed',
      exact,
      at: exactAt[0]!,
      contextMatched: true,
      occurrences,
    };
  if (exactMatches > 1)
    return {
      kind: 'ambiguous',
      occurrences,
      exactMatches,
      lines: exactAt.map((at) => lineAt(text, at)),
    };
  if (occurrences === 1)
    return {
      kind: 'placed',
      exact,
      at: firstAt,
      contextMatched: false,
      occurrences,
    };
  if (bestCount === 1)
    return {
      kind: 'placed',
      exact,
      at: bestAt[0]!,
      contextMatched: false,
      occurrences,
    };
  return {
    kind: 'ambiguous',
    occurrences,
    exactMatches: 0,
    lines: bestAt.map((at) => lineAt(text, at)),
  };
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/** The text between two positions, cut so it starts and ends on whole characters. */
function sliceChars(text: string, start: number, end: number): string {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (
    from > 0 &&
    isLowSurrogate(text.charCodeAt(from)) &&
    isHighSurrogate(text.charCodeAt(from - 1))
  )
    from++;
  if (to < text.length && to > 0 && isHighSurrogate(text.charCodeAt(to - 1)))
    to--;
  return from < to ? text.slice(from, to) : '';
}

function unresolved(explanation: string): QuoteResolution {
  return { status: 'unresolvable', explanation };
}

/** Resolves a quote against an indexed document, with what the result must disclose. */
export function resolveQuote(
  text: DocumentText,
  query: QuoteQuery,
  limits: DocumentLimits = DOCUMENT_LIMITS
): QuoteResolution {
  const placement = placeQuote(text, query, limits);
  const skipped =
    text.unreadable > 0
      ? ` ${text.unreadable} chapter(s) could not be read and were not searched.`
      : '';
  switch (placement.kind) {
    case 'absent':
      return unresolved(
        `The quoted text was not found in the document text this reader searches (it may have been edited or removed in a newer version, or it may sit in a header, footer or note).${skipped}`
      );
    case 'exhausted':
      return unresolved(
        `The quoted text occurs too often for its surroundings to place it within the search limit.${skipped}`
      );
    case 'ambiguous': {
      const shown =
        placement.lines.length < placement.occurrences
          ? ` (first ${placement.lines.length} of ${placement.occurrences})`
          : '';
      const bare =
        (query.prefix ?? '').trim() === '' &&
        (query.suffix ?? '').trim() === '';
      const why = bare
        ? 'the quote has no surrounding text to tell them apart'
        : placement.exactMatches > 1
          ? `its surrounding text matches ${placement.exactMatches} of them exactly`
          : 'its surrounding text is no closer to any one of them than to the others';
      return unresolved(
        `The quoted text occurs ${placement.occurrences} times, and ${why}, so it cannot be placed. Candidate lines: ${placement.lines.join(', ')}${shown}.${skipped}`
      );
    }
    case 'placed': {
      const end = placement.at + placement.exact.length;
      return {
        status: 'resolved',
        exact: placement.exact,
        line: lineAt(text, placement.at),
        context_before: sliceChars(
          text.flat,
          placement.at - CONTEXT_CHARS,
          placement.at
        ),
        context_after: sliceChars(text.flat, end, end + CONTEXT_CHARS),
        context_matched: placement.contextMatched,
        occurrences: placement.occurrences,
        unreadable_chapters: text.unreadable,
      };
    }
  }
}

function refusalText(reason: DocumentRefusal): string {
  switch (reason) {
    case 'protected':
      return 'The ebook is protected by DRM, so the quoted text cannot be checked against it.';
    case 'too-large':
      return 'The document is too large to search for the quoted text.';
    case 'corrupt':
      return 'The document could not be read, so the quoted text cannot be checked.';
  }
}

/**
 * Resolves a quote against a Word document or an EPUB. Returns `undefined` for
 * any other relic, so the caller keeps its own text matching for those.
 */
export async function resolveDocumentQuote(
  content: Uint8Array,
  filename: string,
  quote: DocumentQuote
): Promise<DocumentQuoteResolution | undefined> {
  const kind = documentKindOf(content, filename);
  if (kind === undefined) return undefined;
  const indexed = await documentIndexFor(content, kind);
  if (!indexed.ok) {
    return {
      kind: quote.kind,
      status: 'unresolvable',
      explanation: refusalText(indexed.reason),
    };
  }
  const resolution = resolveQuote(indexed.text, quote);
  if (resolution.status === 'unresolvable') {
    return {
      kind: quote.kind,
      status: 'unresolvable',
      explanation: resolution.explanation,
    };
  }
  return { kind: quote.kind, format: indexed.format, ...resolution };
}
