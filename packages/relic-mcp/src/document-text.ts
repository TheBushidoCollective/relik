/**
 * `quote` and `text` anchors on a Word document or an EPUB (plan section 5),
 * resolved against the text the frame shows. The viewer takes a quote from the
 * frame's selection, so the resolver reads the document's text rather than the
 * ZIP bytes it is stored in. A DOCX yields its main story, one line per
 * paragraph. An EPUB yields its chapters in spine order, the order the reader
 * shows them, one line per block.
 *
 * Read-only and bounded. A DOCX part with any DOCTYPE is refused, and so is an
 * EPUB chapter with an internal subset or an entity declaration, as the EPUB
 * reader refuses them. Nothing here runs a script, follows a link, or opens a
 * part that a package names only by URL.
 */

import { deriveRendererClass } from '@relic/format';
import { zipContainerKindSync } from '@relic/format/containers';
import { readEpubPackage } from '@relic/format/epub-package';
import {
  decodeXmlBytes,
  localName,
  parseXml,
  scanForbiddenDtd,
  type XmlElement,
} from '@relic/format/xml';
import { indexZip, type ZipIndex } from '@relic/format/zip-index';
import { nodeInflater } from './node-inflater.ts';

/** The most text one document contributes to a search, in UTF-16 units. */
export const DOCUMENT_TEXT_LIMIT = 16 * 1024 * 1024;
/** Candidate occurrences of one quote that are scored; later ones are not. */
export const QUOTE_CANDIDATE_LIMIT = 10_000;
/** Context kept on each side of a matched quote, in UTF-16 units. */
const CONTEXT_CHARS = 120;
/** The spine items the EPUB reader walks, as the frame allows. */
const SPINE_LIMIT = 2_000;
const ZIP_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
} as const;
const PARSE_LIMITS = {
  maxNodes: 2_000_000,
  maxTextChars: DOCUMENT_TEXT_LIMIT,
} as const;
const ZIP_TOO_LARGE: Record<string, true> = {
  'total-too-large': true,
  'entry-too-large': true,
  'too-many-entries': true,
  'directory-too-large': true,
};

export type DocumentKind = 'docx' | 'epub';
export type DocumentRefusal = 'protected' | 'corrupt' | 'too-large';
type Outcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'corrupt' | 'too-large' };
export type DocumentText =
  | {
      readonly ok: true;
      readonly text: string;
      /** EPUB chapters that could not be read; a DOCX has none to count. */
      readonly unreadable: number;
    }
  | { readonly ok: false; readonly reason: DocumentRefusal };

export interface DocumentQuote {
  readonly kind: 'quote' | 'text';
  readonly exact: string;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
}

export interface QuoteMatch {
  /** The quote as it reads in the document, with whitespace collapsed. */
  readonly exact: string;
  /** The 1-based line of the extracted text the quote starts on. */
  readonly line: number;
  readonly context_before: string;
  readonly context_after: string;
}

export type DocumentQuoteResolution =
  | ({
      readonly kind: 'quote' | 'text';
      readonly status: 'resolved';
    } & QuoteMatch)
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

/**
 * Text being built for one document. A line break is written only after text,
 * so a block that is empty adds no line, and every line holds one block.
 */
class Flow {
  readonly #parts: string[] = [];
  #open = false;

  text(value: string): void {
    if (value === '') return;
    this.#parts.push(value);
    if (/\S/.test(value)) this.#open = true;
  }

  lineBreak(): void {
    if (!this.#open) return;
    this.#parts.push('\n');
    this.#open = false;
  }

  toString(): string {
    return this.#parts.join('');
  }
}

function parsed(
  xml: string,
  lenient: boolean
):
  | { readonly ok: true; readonly root: XmlElement }
  | { readonly ok: false; readonly reason: 'corrupt' | 'too-large' } {
  const result = parseXml(
    xml,
    lenient ? { ...PARSE_LIMITS, lenient } : PARSE_LIMITS
  );
  if (result.ok) return { ok: true, root: result.root };
  return {
    ok: false,
    reason: result.reason === 'size' ? 'too-large' : 'corrupt',
  };
}

function textOf(node: XmlElement): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

function collectDocx(node: XmlElement, flow: Flow): void {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    switch (localName(child.name)) {
      case 't':
      case 'delText':
        flow.text(textOf(child));
        break;
      case 'tab':
        flow.text('\t');
        break;
      case 'br':
      case 'cr':
        flow.text('\n');
        break;
      case 'noBreakHyphen':
        flow.text('-');
        break;
      case 'p':
        flow.lineBreak();
        collectDocx(child, flow);
        flow.lineBreak();
        break;
      case 'instrText':
        // A field's instruction is code the frame never shows. Its result is text.
        break;
      default:
        collectDocx(child, flow);
    }
  }
}

/** The text of a DOCX's main story, one line per paragraph, as the frame shows it. */
export function docxMainText(xml: string): Outcome {
  if (scanForbiddenDtd(xml, 'docx')) return { ok: false, reason: 'corrupt' };
  const root = parsed(xml, false);
  if (!root.ok) return root;
  const flow = new Flow();
  collectDocx(root.root, flow);
  return { ok: true, text: flow.toString() };
}

const HIDDEN_XHTML: Record<string, true> = {
  head: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  title: true,
};
const BLOCK_XHTML: Record<string, true> = {
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

function collectXhtml(node: XmlElement, flow: Flow): void {
  for (const child of node.children) {
    if (typeof child === 'string') {
      flow.text(child);
      continue;
    }
    const name = localName(child.name);
    if (HIDDEN_XHTML[name] === true) continue;
    if (name === 'br') {
      flow.text('\n');
      continue;
    }
    const block = BLOCK_XHTML[name] === true;
    if (block) flow.lineBreak();
    collectXhtml(child, flow);
    if (block) flow.lineBreak();
    else if (name === 'td' || name === 'th') flow.text('\t');
  }
}

/** The text of one EPUB content document, one line per block. */
export function epubChapterText(xhtml: string): Outcome {
  const root = parsed(xhtml, true);
  if (!root.ok) return root;
  const flow = new Flow();
  collectXhtml(root.root, flow);
  return { ok: true, text: flow.toString() };
}

async function docxText(index: ZipIndex): Promise<DocumentText> {
  const part = await index.read('word/document.xml');
  if (!part.ok) return { ok: false, reason: 'corrupt' };
  const main = docxMainText(decodeXmlBytes(part.bytes));
  return main.ok
    ? { ok: true, text: main.text, unreadable: 0 }
    : { ok: false, reason: main.reason };
}

async function epubText(index: ZipIndex): Promise<DocumentText> {
  const book = await readEpubPackage(index);
  if (!book.ok) return { ok: false, reason: book.reason };
  if (book.book.spine.length > SPINE_LIMIT) {
    return { ok: false, reason: 'too-large' };
  }
  const chapters: string[] = [];
  let length = 0;
  let unreadable = 0;
  for (const item of book.book.spine) {
    const part = await index.read(item.path);
    const chapter = part.ok
      ? epubChapterText(decodeXmlBytes(part.bytes))
      : undefined;
    if (chapter === undefined || !chapter.ok) {
      unreadable++;
      continue;
    }
    length += chapter.text.length;
    if (length > DOCUMENT_TEXT_LIMIT) return { ok: false, reason: 'too-large' };
    chapters.push(chapter.text);
  }
  const text = chapters
    .map((chapter) => (chapter.endsWith('\n') ? chapter : `${chapter}\n`))
    .join('');
  return { ok: true, text, unreadable };
}

async function readDocument(
  content: Uint8Array,
  kind: DocumentKind
): Promise<DocumentText> {
  try {
    const indexed = await indexZip(content, ZIP_LIMITS, nodeInflater);
    if (!indexed.ok) {
      return {
        ok: false,
        reason:
          ZIP_TOO_LARGE[indexed.reason] === true ? 'too-large' : 'corrupt',
      };
    }
    return kind === 'docx'
      ? await docxText(indexed.index)
      : await epubText(indexed.index);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

const documents = new WeakMap<Uint8Array, Promise<DocumentText>>();

/** One extraction per decrypted version, shared by every quote on it. */
export function documentTextFor(
  content: Uint8Array,
  kind: DocumentKind
): Promise<DocumentText> {
  let pending = documents.get(content);
  if (pending === undefined) {
    pending = readDocument(content, kind);
    documents.set(content, pending);
  }
  return pending;
}

const UNICODE_SPACE = /\s/;

/** Whether a UTF-16 code unit is whitespace, as `\s` matches it. */
function isSpace(code: number): boolean {
  return code <= 32
    ? code === 32 || (code >= 9 && code <= 13)
    : code >= 0x80 && UNICODE_SPACE.test(String.fromCharCode(code));
}

/**
 * The offset in the original text where the collapsed text's `index` begins.
 * Each run of whitespace is one character of the collapsed text.
 */
function originalOffset(text: string, index: number): number {
  let emitted = 0;
  let inSpace = false;
  for (let at = 0; at < text.length; at++) {
    if (isSpace(text.charCodeAt(at))) {
      if (inSpace) continue;
      inSpace = true;
    } else {
      inSpace = false;
    }
    if (emitted === index) return at;
    emitted++;
  }
  return text.length;
}

function countNewlines(text: string, end: number): number {
  let count = 0;
  for (let at = 0; at < end; at++) if (text.charCodeAt(at) === 10) count++;
  return count;
}

/** Every whitespace run becomes one space, so line breaks and indentation do not count. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** How well the text around one occurrence agrees with the prefix and suffix. */
function scoreAround(
  flat: string,
  at: number,
  length: number,
  before: string,
  after: string
): number {
  let score = 0;
  if (before !== '') {
    const seen = flat.slice(Math.max(0, at - before.length), at);
    if (seen === before) score += 2;
    else if (seen !== '' && (seen.endsWith(before) || before.endsWith(seen))) {
      score += 1;
    }
  }
  if (after !== '') {
    const seen = flat.slice(at + length, at + length + after.length);
    if (seen === after) score += 2;
    else if (
      seen !== '' &&
      (seen.startsWith(after) || after.startsWith(seen))
    ) {
      score += 1;
    }
  }
  return score;
}

/**
 * Finds a quote in document text. The quote, the prefix and the suffix are
 * compared with whitespace collapsed, because the frame's selection text and
 * the extracted paragraphs break lines in different places. Among occurrences,
 * the one whose surroundings agree best with the prefix and suffix wins, and
 * the first wins a tie, as the markdown matcher does.
 */
export function findDocumentQuote(
  text: string,
  quote: string,
  prefix = '',
  suffix = ''
): QuoteMatch | undefined {
  const target = collapse(quote).trim();
  if (target === '') return undefined;
  const flat = collapse(text);
  const before = collapse(prefix);
  const after = collapse(suffix);
  let best: number | undefined;
  let bestScore = -1;
  let candidates = 0;
  for (
    let at = flat.indexOf(target);
    at !== -1 && candidates < QUOTE_CANDIDATE_LIMIT;
    at = flat.indexOf(target, at + 1)
  ) {
    candidates++;
    const score = scoreAround(flat, at, target.length, before, after);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  if (best === undefined) return undefined;
  return {
    exact: target,
    line: 1 + countNewlines(text, originalOffset(text, best)),
    context_before: flat.slice(Math.max(0, best - CONTEXT_CHARS), best),
    context_after: flat.slice(
      best + target.length,
      best + target.length + CONTEXT_CHARS
    ),
  };
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
 * Resolves a quote against a Word document or an EPUB. Returns `undefined`
 * for any other relic, so the caller keeps its own text matching for those.
 */
export async function resolveDocumentQuote(
  content: Uint8Array,
  filename: string,
  quote: DocumentQuote
): Promise<DocumentQuoteResolution | undefined> {
  const kind = documentKindOf(content, filename);
  if (kind === undefined) return undefined;
  const text = await documentTextFor(content, kind);
  if (!text.ok) {
    return {
      kind: quote.kind,
      status: 'unresolvable',
      explanation: refusalText(text.reason),
    };
  }
  const match = findDocumentQuote(
    text.text,
    quote.exact,
    quote.prefix,
    quote.suffix
  );
  if (match === undefined) {
    const skipped =
      text.unreadable > 0
        ? ` ${text.unreadable} chapter(s) could not be read.`
        : '';
    return {
      kind: quote.kind,
      status: 'unresolvable',
      explanation:
        'The quoted text was not found in the document text this reader searches (it may have been edited or removed in a newer version, or it may sit in a header, footer or note).' +
        skipped,
    };
  }
  return {
    kind: quote.kind,
    status: 'resolved',
    exact: match.exact,
    line: match.line,
    context_before: match.context_before,
    context_after: match.context_after,
  };
}
