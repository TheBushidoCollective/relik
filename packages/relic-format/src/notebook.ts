/**
 * The notebook reader for `.ipynb` (plan A4; section 4 for the output policy
 * and limits, section 5 for the `path` anchors).
 *
 * It reads a notebook with the JSON reader in `json-tree.ts`, so the file is
 * parsed exactly as a tree is, and a cell's `path` anchor (`/cells/N`, or
 * `/cells/N/outputs/M`) is the RFC 6901 pointer the same reader resolves.
 *
 * The result is text, numbers, decoded image bytes that have passed a file
 * signature check, and ANSI styling as data. Nothing here is markup. A view
 * draws text with `textContent`, or hands markdown to the viewer's existing
 * escape-first renderer. HTML, SVG, JavaScript, LaTeX and widgets are never
 * drawn: they come back as a `withheld` body with the text the reader can see.
 *
 * Metadata is never read, so nothing an author puts there reaches a view.
 */

import type { CommentAnchor } from './comments.ts';
import {
  jsonStringValue,
  type JsonTree,
  type JsonTreeFailure,
  parseJsonTree,
  parsePointerTokens,
  utf8Length,
} from './json-tree.ts';

/** Cells past this count refuse the notebook whole. */
export const NOTEBOOK_MAX_CELLS = 5_000;
/** Outputs kept per cell. The rest are counted and not shown. */
export const NOTEBOOK_MAX_OUTPUTS_PER_CELL = 200;
/** Outputs read across the notebook before it is refused whole (a DOM bound). */
export const NOTEBOOK_MAX_OUTPUTS = 20_000;
/** A source or output text keeps this many characters, then is cut and marked. */
export const NOTEBOOK_TEXT_MAX_CHARS = 1_048_576;
/** One decoded image, in bytes. */
export const NOTEBOOK_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
/** All decoded images together, in bytes. */
export const NOTEBOOK_IMAGES_MAX_BYTES = 64 * 1024 * 1024;
/** Decoded images across the notebook. */
export const NOTEBOOK_IMAGES_MAX_COUNT = 500;

export type NotebookRefusal =
  | { readonly kind: 'json'; readonly failure: JsonTreeFailure }
  | { readonly kind: 'not-notebook' }
  | { readonly kind: 'nbformat'; readonly found: string }
  | {
      readonly kind: 'too-many-cells';
      readonly count: number;
      readonly limit: number;
    }
  | { readonly kind: 'too-many-outputs'; readonly limit: number };

export type NotebookResult =
  | { readonly ok: true; readonly notebook: Notebook }
  | { readonly ok: false; readonly refusal: NotebookRefusal };

/** Display text, with invisible characters written as `[U+XXXX]`, and whether it was cut. */
export interface NotebookText {
  readonly text: string;
  readonly truncated: boolean;
}

export type CellKind = 'markdown' | 'code' | 'raw';

export interface NotebookCell {
  /** The position in the `cells` array. The `path` anchor is `/cells/<index>`. */
  readonly index: number;
  readonly kind: CellKind;
  /** The execution count, when the file holds a non-negative integer. */
  readonly executionCount: number | undefined;
  readonly source: NotebookText;
  readonly outputs: readonly NotebookOutput[];
  /** Outputs past the per-cell cap. They are counted, not read. */
  readonly omittedOutputs: number;
  /** The cell's source offsets, used to place a quote. */
  readonly start: number;
  readonly end: number;
}

export type OutputType =
  | 'stream'
  | 'error'
  | 'display_data'
  | 'execute_result'
  | 'unknown';

export interface NotebookOutput {
  /** The position in the cell's `outputs` array. The `path` anchor is `.../outputs/<index>`. */
  readonly index: number;
  readonly outputType: OutputType;
  readonly start: number;
  readonly end: number;
  readonly body: NotebookBody;
}

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';
export type ImageRefusal = 'encoding' | 'size' | 'count' | 'signature';
export type WithheldKind = 'html' | 'svg' | 'javascript' | 'latex' | 'widget';

export type NotebookBody =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'stream';
      readonly stream: 'stdout' | 'stderr';
      readonly spans: readonly AnsiSpan[];
      readonly truncated: boolean;
    }
  | { readonly kind: 'text'; readonly text: NotebookText }
  | { readonly kind: 'markdown'; readonly text: NotebookText }
  | { readonly kind: 'json'; readonly text: NotebookText }
  | {
      readonly kind: 'image';
      readonly format: ImageFormat;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'image-refused';
      readonly reason: ImageRefusal;
      readonly declared: string;
    }
  | {
      readonly kind: 'error';
      readonly name: string;
      readonly value: string;
      readonly spans: readonly AnsiSpan[];
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'withheld';
      readonly withheld: WithheldKind;
      /** The MIME type, as the file names it, escaped for display. */
      readonly label: string;
      /** The text/plain fallback, when the output has one. */
      readonly plain: NotebookText | undefined;
      /** The output as text: its text/html, SVG or JavaScript source. */
      readonly source: NotebookText;
    };

/** A run of text with one ANSI style. Colours are the 16 basic indices (0 to 15). */
export interface AnsiSpan {
  readonly text: string;
  readonly fg: number | undefined;
  readonly bg: number | undefined;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export interface Notebook {
  /** The file's text, as read. Quote anchors are found in it. */
  readonly source: string;
  /** The file's size in UTF-8 bytes. */
  readonly bytes: number;
  readonly nbformat: 4;
  readonly cells: readonly NotebookCell[];
}

/** Where a `path` or quote anchor lands: a cell, or one of its outputs. */
export interface NotebookTarget {
  readonly cell: number;
  readonly output?: number;
}

const NONE = -1;

const IMAGE_MIME: Readonly<Record<string, ImageFormat>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const RASTER_ORDER = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * Invisible characters: C0 controls other than tab and line feed, DEL and the
 * C1 block, the bidi marks and embeddings, and the bidi isolates. Each one is
 * written out, so a reader sees what the file contains.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to match them
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Every invisible character as its code point, so it can be read. */
export function escapeInvisible(text: string): string {
  return text.replace(
    INVISIBLE,
    (character) =>
      `[U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`
  );
}

/** Display text: line endings normalised, then invisible characters escaped. */
function displayText(text: string): string {
  return escapeInvisible(text.replace(/\r\n/g, '\n'));
}

/** Cuts a text to the cap, without splitting a surrogate pair. */
function cutRaw(text: string): NotebookText {
  if (text.length <= NOTEBOOK_TEXT_MAX_CHARS) return { text, truncated: false };
  let cut = text.slice(0, NOTEBOOK_TEXT_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

function display(text: string): NotebookText {
  const shown = cutRaw(displayText(text));
  return shown;
}

/** The member of an object a reader sees: the last one with this key, as `JSON.parse` keeps it. */
function member(
  tree: JsonTree,
  node: number,
  name: string
): number | undefined {
  if (tree.kind(node) !== 'object') return undefined;
  let found: number | undefined;
  for (
    let child = tree.firstChild(node);
    child !== NONE;
    child = tree.nextSibling(child)
  ) {
    if (!tree.isShadowed(child) && tree.key(child) === name) found = child;
  }
  return found;
}

/** A string, or the strings of an array joined with `separator`. Anything else is undefined. */
function textOf(
  tree: JsonTree,
  node: number,
  separator = ''
): string | undefined {
  const kind = tree.kind(node);
  if (kind === 'string') return jsonStringValue(tree.valueSource(node));
  if (kind !== 'array') return undefined;
  let out = '';
  let first = true;
  for (
    let child = tree.firstChild(node);
    child !== NONE;
    child = tree.nextSibling(child)
  ) {
    if (tree.kind(child) !== 'string') continue;
    if (!first) out += separator;
    out += jsonStringValue(tree.valueSource(child));
    first = false;
  }
  return out;
}

/** A text as written, or the source of a value that is not text (a JSON MIME type). */
function textOrSource(tree: JsonTree, node: number): string {
  return textOf(tree, node) ?? tree.valueSource(node);
}

function countOf(tree: JsonTree, node: number | undefined): number | undefined {
  if (node === undefined || tree.kind(node) !== 'number') return undefined;
  const value = Number(tree.valueSource(node));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface Reader {
  images: number;
  imageBytes: number;
  outputs: number;
}

/** Reads a notebook. Never throws; a file it cannot show comes back refused. */
export function parseNotebook(source: string): NotebookResult {
  const parsed = parseJsonTree(source);
  if (!parsed.ok)
    return { ok: false, refusal: { kind: 'json', failure: parsed.failure } };
  const tree = parsed.tree;
  const cellsNode = member(tree, 0, 'cells');
  const formatNode = member(tree, 0, 'nbformat');
  if (
    tree.kind(0) !== 'object' ||
    cellsNode === undefined ||
    tree.kind(cellsNode) !== 'array' ||
    formatNode === undefined ||
    tree.kind(formatNode) !== 'number'
  )
    return { ok: false, refusal: { kind: 'not-notebook' } };
  if (Number(tree.valueSource(formatNode)) !== 4)
    return {
      ok: false,
      refusal: { kind: 'nbformat', found: tree.valueSource(formatNode) },
    };

  const count = tree.childCount(cellsNode);
  if (count > NOTEBOOK_MAX_CELLS)
    return {
      ok: false,
      refusal: { kind: 'too-many-cells', count, limit: NOTEBOOK_MAX_CELLS },
    };

  const reader: Reader = { images: 0, imageBytes: 0, outputs: 0 };
  const cells: NotebookCell[] = [];
  let child = tree.firstChild(cellsNode);
  for (let index = 0; child !== NONE; index += 1) {
    cells.push(readCell(tree, child, index, reader));
    if (reader.outputs > NOTEBOOK_MAX_OUTPUTS)
      return {
        ok: false,
        refusal: { kind: 'too-many-outputs', limit: NOTEBOOK_MAX_OUTPUTS },
      };
    child = tree.nextSibling(child);
  }

  return {
    ok: true,
    notebook: { source, bytes: utf8Length(source), nbformat: 4, cells },
  };
}

function readCell(
  tree: JsonTree,
  node: number,
  index: number,
  reader: Reader
): NotebookCell {
  const start = tree.valueStart(node);
  const end = tree.valueEnd(node);
  if (tree.kind(node) !== 'object')
    return {
      index,
      kind: 'raw',
      executionCount: undefined,
      source: { text: '', truncated: false },
      outputs: [],
      omittedOutputs: 0,
      start,
      end,
    };

  const typeNode = member(tree, node, 'cell_type');
  const typeText = typeNode === undefined ? undefined : textOf(tree, typeNode);
  const kind: CellKind =
    typeText === 'markdown' || typeText === 'code' ? typeText : 'raw';

  const sourceNode = member(tree, node, 'source');
  const sourceText =
    sourceNode === undefined ? '' : (textOf(tree, sourceNode) ?? '');

  const outputs: NotebookOutput[] = [];
  let omittedOutputs = 0;
  const outputsNode = member(tree, node, 'outputs');
  if (
    kind === 'code' &&
    outputsNode !== undefined &&
    tree.kind(outputsNode) === 'array'
  ) {
    const total = tree.childCount(outputsNode);
    const keep = Math.min(total, NOTEBOOK_MAX_OUTPUTS_PER_CELL);
    omittedOutputs = total - keep;
    let child = tree.firstChild(outputsNode);
    for (let at = 0; at < keep && child !== NONE; at += 1) {
      outputs.push(readOutput(tree, child, at, reader));
      reader.outputs += 1;
      child = tree.nextSibling(child);
      // Past the notebook bound the caller refuses, so there is no point reading on.
      if (reader.outputs > NOTEBOOK_MAX_OUTPUTS) break;
    }
  }

  return {
    index,
    kind,
    executionCount: countOf(tree, member(tree, node, 'execution_count')),
    source: display(sourceText),
    outputs,
    omittedOutputs,
    start,
    end,
  };
}

function readOutput(
  tree: JsonTree,
  node: number,
  index: number,
  reader: Reader
): NotebookOutput {
  const start = tree.valueStart(node);
  const end = tree.valueEnd(node);
  const empty = (outputType: OutputType): NotebookOutput => ({
    index,
    outputType,
    start,
    end,
    body: { kind: 'empty' },
  });
  if (tree.kind(node) !== 'object') return empty('unknown');

  const typeNode = member(tree, node, 'output_type');
  const typeText = typeNode === undefined ? undefined : textOf(tree, typeNode);
  switch (typeText) {
    case 'stream': {
      const nameNode = member(tree, node, 'name');
      const stream =
        nameNode !== undefined && textOf(tree, nameNode) === 'stderr'
          ? 'stderr'
          : 'stdout';
      const textNode = member(tree, node, 'text');
      const raw = cutRaw(
        textNode === undefined ? '' : (textOf(tree, textNode, '') ?? '')
      );
      return {
        index,
        outputType: 'stream',
        start,
        end,
        body: {
          kind: 'stream',
          stream,
          spans: ansiSpans(raw.text),
          truncated: raw.truncated,
        },
      };
    }
    case 'error': {
      const nameNode = member(tree, node, 'ename');
      const valueNode = member(tree, node, 'evalue');
      const tracebackNode = member(tree, node, 'traceback');
      const traceback = cutRaw(
        tracebackNode === undefined
          ? ''
          : (textOf(tree, tracebackNode, '\n') ?? '')
      );
      return {
        index,
        outputType: 'error',
        start,
        end,
        body: {
          kind: 'error',
          name: displayText(
            nameNode === undefined ? '' : (textOf(tree, nameNode) ?? '')
          ),
          value: displayText(
            valueNode === undefined ? '' : (textOf(tree, valueNode) ?? '')
          ),
          spans: ansiSpans(traceback.text),
          truncated: traceback.truncated,
        },
      };
    }
    case 'display_data':
    case 'execute_result': {
      const dataNode = member(tree, node, 'data');
      return {
        index,
        outputType: typeText,
        start,
        end,
        body:
          dataNode === undefined
            ? { kind: 'empty' }
            : readData(tree, dataNode, reader),
      };
    }
    default:
      return empty('unknown');
  }
}

/**
 * The body for a display or result's MIME bundle, first match wins: a raster
 * image, markdown, a never-rendered type, JSON, plain text. A bundle with none
 * of these is empty.
 */
function readData(
  tree: JsonTree,
  dataNode: number,
  reader: Reader
): NotebookBody {
  const entries = new Map<string, number>();
  for (
    let child = tree.firstChild(dataNode);
    child !== NONE;
    child = tree.nextSibling(child)
  ) {
    if (tree.isShadowed(child)) continue;
    entries.set(tree.key(child) ?? '', child);
  }

  for (const mime of RASTER_ORDER) {
    const node = entries.get(mime);
    if (node !== undefined) return readImage(tree, node, mime, reader);
  }

  const markdown = entries.get('text/markdown');
  if (markdown !== undefined) {
    const text = textOf(tree, markdown, '');
    return {
      kind: 'markdown',
      text: display(text ?? tree.valueSource(markdown)),
    };
  }

  const withheld = withheldEntry(entries);
  if (withheld !== undefined) {
    const plainNode = entries.get('text/plain');
    return {
      kind: 'withheld',
      withheld: withheld.kind,
      label: displayText(withheld.mime),
      plain:
        plainNode === undefined
          ? undefined
          : display(textOrSource(tree, plainNode)),
      source: display(textOrSource(tree, withheld.node)),
    };
  }

  const json = entries.get('application/json');
  if (json !== undefined)
    return { kind: 'json', text: display(tree.valueSource(json)) };

  const plain = entries.get('text/plain');
  if (plain !== undefined)
    return { kind: 'text', text: display(textOrSource(tree, plain)) };

  return { kind: 'empty' };
}

function withheldEntry(
  entries: ReadonlyMap<string, number>
): { kind: WithheldKind; mime: string; node: number } | undefined {
  const exact: ReadonlyArray<readonly [string, WithheldKind]> = [
    ['text/html', 'html'],
    ['image/svg+xml', 'svg'],
    ['application/javascript', 'javascript'],
    ['text/javascript', 'javascript'],
    ['text/latex', 'latex'],
  ];
  for (const [mime, kind] of exact) {
    const node = entries.get(mime);
    if (node !== undefined) return { kind, mime, node };
  }
  for (const [mime, node] of entries) {
    if (mime.startsWith('application/vnd.jupyter.widget'))
      return { kind: 'widget', mime, node };
  }
  return undefined;
}

function readImage(
  tree: JsonTree,
  node: number,
  declared: string,
  reader: Reader
): NotebookBody {
  const format = IMAGE_MIME[declared];
  const refused = (reason: ImageRefusal): NotebookBody => ({
    kind: 'image-refused',
    reason,
    declared,
  });
  if (format === undefined) return refused('signature');
  const encoded = textOf(tree, node, '');
  if (encoded === undefined) return refused('encoding');
  // Base64 is 4 characters for every 3 bytes, plus up to a line break per 76.
  // Refuse by length before stripping whitespace or decoding anything.
  if (encoded.length > (NOTEBOOK_IMAGE_MAX_BYTES / 3) * 4 + encoded.length / 16)
    return refused('size');
  const compact = encoded.replace(/\s+/g, '');
  const estimate = Math.floor(compact.length / 4) * 3;
  if (estimate > NOTEBOOK_IMAGE_MAX_BYTES) return refused('size');
  if (reader.images >= NOTEBOOK_IMAGES_MAX_COUNT) return refused('count');
  if (reader.imageBytes + estimate > NOTEBOOK_IMAGES_MAX_BYTES)
    return refused('size');
  const bytes = decodeBase64(compact);
  if (bytes === undefined) return refused('encoding');
  reader.images += 1;
  reader.imageBytes += bytes.length;
  if (imageFormatOf(bytes) !== format) return refused('signature');
  return { kind: 'image', format, bytes };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes padded base64 text, or `undefined` when it is not base64. */
export function decodeBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return undefined;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1)
    bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** The format a file's first bytes name, from its signature. `undefined` when none matches. */
export function imageFormatOf(bytes: Uint8Array): ImageFormat | undefined {
  const at = (offset: number, text: string): boolean => {
    if (bytes.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i += 1)
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n'))
    return 'png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'jpeg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  return undefined;
}

interface Style {
  readonly fg: number | undefined;
  readonly bg: number | undefined;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

const UNSTYLED: Style = {
  fg: undefined,
  bg: undefined,
  bold: false,
  italic: false,
  underline: false,
};

/**
 * Text with ANSI styling as runs. Colour and emphasis SGR codes change the
 * style; every other escape sequence is removed, and a malformed one is
 * dropped without losing the text after it. Each run's text is escaped.
 */
export function ansiSpans(input: string): AnsiSpan[] {
  const text = input.replace(/\r\n/g, '\n');
  const n = text.length;
  const spans: AnsiSpan[] = [];
  let style = UNSTYLED;
  let run = '';
  const flush = (): void => {
    if (run === '') return;
    spans.push({
      text: escapeInvisible(run),
      fg: style.fg,
      bg: style.bg,
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
    });
    run = '';
  };

  let i = 0;
  while (i < n) {
    let at = i;
    while (at < n) {
      const code = text.charCodeAt(at);
      if (code === 0x1b || code === 0x9b) break;
      at += 1;
    }
    run += text.slice(i, at);
    if (at >= n) break;

    const introducer = text.charCodeAt(at);
    if (introducer === 0x1b && text.charAt(at + 1) === ']') {
      i = endOfOsc(text, at + 2);
      continue;
    }
    if (introducer === 0x1b && text.charAt(at + 1) !== '[') {
      // A two-character escape (ESC then 0x40 to 0x5f) is dropped whole.
      // Any other ESC is dropped alone, and what follows is read as text.
      const next = text.charCodeAt(at + 1);
      i = at + 1 < n && next >= 0x40 && next <= 0x5f ? at + 2 : at + 1;
      continue;
    }

    // CSI: ESC [ or the single-character form 0x9b. Parameter bytes 0x30 to
    // 0x3f, intermediate bytes 0x20 to 0x2f, then one final byte 0x40 to 0x7e.
    const paramsAt = introducer === 0x9b ? at + 1 : at + 2;
    let j = paramsAt;
    while (j < n && inRange(text.charCodeAt(j), 0x30, 0x3f)) j += 1;
    const paramsEnd = j;
    while (j < n && inRange(text.charCodeAt(j), 0x20, 0x2f)) j += 1;
    if (j >= n) {
      // Unterminated at the end of the text: the rest is the sequence.
      i = n;
      continue;
    }
    if (!inRange(text.charCodeAt(j), 0x40, 0x7e)) {
      // Malformed: drop the introducer and what it had read. The offending
      // character is read again as text.
      i = j;
      continue;
    }
    if (text.charCodeAt(j) === 0x6d && j === paramsEnd) {
      flush();
      style = applySgr(style, text.slice(paramsAt, paramsEnd));
    }
    i = j + 1;
  }
  flush();
  return spans;
}

function inRange(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

/** The index after an OSC sequence's terminator (BEL, or ESC backslash), or the end of the text. */
function endOfOsc(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07) return i + 1;
    if (code === 0x1b && text.charAt(i + 1) === '\\') return i + 2;
  }
  return text.length;
}

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? ['0'] : params.split(';').slice(0, 32);
  let next = style;
  for (let k = 0; k < codes.length; k += 1) {
    const code = codes[k] ?? '';
    const value = code === '' ? 0 : Number(code);
    if (!Number.isInteger(value)) continue;
    if (value === 0) next = UNSTYLED;
    else if (value === 1) next = { ...next, bold: true };
    else if (value === 3) next = { ...next, italic: true };
    else if (value === 4) next = { ...next, underline: true };
    else if (value === 22) next = { ...next, bold: false };
    else if (value === 23) next = { ...next, italic: false };
    else if (value === 24) next = { ...next, underline: false };
    else if (value >= 30 && value <= 37) next = { ...next, fg: value - 30 };
    else if (value === 39) next = { ...next, fg: undefined };
    else if (value >= 40 && value <= 47) next = { ...next, bg: value - 40 };
    else if (value === 49) next = { ...next, bg: undefined };
    else if (value >= 90 && value <= 97) next = { ...next, fg: value - 82 };
    else if (value >= 100 && value <= 107) next = { ...next, bg: value - 92 };
    else if (value === 38 || value === 48) {
      // 38;5;n and 48;5;n select a palette entry. Only the first 16 are kept.
      // 38;2;r;g;b is a true colour the viewer does not draw, so it is skipped.
      const mode = codes[k + 1];
      if (mode === '5') {
        const index = Number(codes[k + 2]);
        if (Number.isInteger(index) && index >= 0 && index < 16)
          next = value === 38 ? { ...next, fg: index } : { ...next, bg: index };
        k += 2;
      } else if (mode === '2') {
        k += 4;
      }
    }
  }
  return next;
}

function isIndex(text: string | undefined): text is string {
  return text !== undefined && /^(0|[1-9][0-9]*)$/.test(text);
}

/**
 * The cell or output a comment anchor names in a notebook, or `undefined` when
 * the notebook does not hold it. A `path` names a cell, or an output the reader
 * kept. A quote, from a text view or a legacy comment, names the cell or output
 * whose source holds its first occurrence with matching context.
 */
export function notebookTarget(
  notebook: Notebook,
  anchor: CommentAnchor
): NotebookTarget | undefined {
  switch (anchor.kind) {
    case 'path':
      return targetOfPointer(notebook, anchor.pointer);
    case 'quote':
    case 'source':
      return targetOfOffset(
        notebook,
        findQuote(
          notebook.source,
          anchor.exact,
          anchor.prefix ?? '',
          anchor.suffix ?? ''
        )
      );
    case 'text':
      return targetOfOffset(notebook, findQuote(notebook.source, anchor.quote));
    default:
      return undefined;
  }
}

/** The RFC 6901 pointer for a cell, or for one of its outputs. */
export function notebookPointer(target: NotebookTarget): string {
  return target.output === undefined
    ? `/cells/${target.cell}`
    : `/cells/${target.cell}/outputs/${target.output}`;
}

function targetOfPointer(
  notebook: Notebook,
  pointer: string
): NotebookTarget | undefined {
  const tokens = parsePointerTokens(pointer);
  if (tokens === undefined || tokens[0] !== 'cells' || !isIndex(tokens[1]))
    return undefined;
  const cell = Number(tokens[1]);
  const found = notebook.cells[cell];
  if (found === undefined) return undefined;
  if (tokens.length === 2) return { cell };
  if (tokens.length === 4 && tokens[2] === 'outputs' && isIndex(tokens[3])) {
    const output = Number(tokens[3]);
    return found.outputs[output] === undefined ? undefined : { cell, output };
  }
  return undefined;
}

function targetOfOffset(
  notebook: Notebook,
  at: number | undefined
): NotebookTarget | undefined {
  if (at === undefined) return undefined;
  const cell = containing(notebook.cells, at);
  if (cell === undefined) return undefined;
  const output = containing(cell.outputs, at);
  return output === undefined
    ? { cell: cell.index }
    : { cell: cell.index, output: output.index };
}

/** The item whose span holds an offset. The items are in source order. */
function containing<T extends { readonly start: number; readonly end: number }>(
  items: readonly T[],
  at: number
): T | undefined {
  let low = 0;
  let high = items.length - 1;
  let found = NONE;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = items[middle];
    if (item !== undefined && item.start <= at) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const item = found === NONE ? undefined : items[found];
  return item !== undefined && at < item.end ? item : undefined;
}

/**
 * The index of a quote in the source. A quote with context must match its
 * context, so an occurrence the reader did not select is never chosen.
 */
function findQuote(
  source: string,
  exact: string,
  prefix = '',
  suffix = ''
): number | undefined {
  if (exact.length === 0) return undefined;
  for (
    let at = source.indexOf(exact);
    at !== NONE;
    at = source.indexOf(exact, at + 1)
  ) {
    const beforeOk =
      prefix.length === 0 ||
      (at >= prefix.length && source.slice(at - prefix.length, at) === prefix);
    if (beforeOk && source.startsWith(suffix, at + exact.length)) return at;
  }
  return undefined;
}
