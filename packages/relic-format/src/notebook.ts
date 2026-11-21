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
import {
  cutChars,
  escapeInvisible,
  findQuote,
  shortLabel,
} from './structured-text.ts';

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
/** A display label from the file (an error name or value, a MIME type, a format number) keeps this many characters. */
export const NOTEBOOK_LABEL_MAX_CHARS = 256;
/** One decoded image's width times height, in pixels. */
export const NOTEBOOK_IMAGE_MAX_PIXELS = 50_000_000;
/** All decoded images' pixels together. */
export const NOTEBOOK_IMAGES_MAX_PIXELS = 200_000_000;

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
  /** JSON string token ranges for the source, including their quotes. */
  readonly sourceTokens: readonly {
    readonly start: number;
    readonly end: number;
  }[];
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
 * Display text: line endings normalised and invisible characters escaped. The
 * raw text is cut before escaping, since escaping expands each invisible
 * character to eight, and cut again after, so the shown text stays in the cap.
 */
function display(text: string): NotebookText {
  const raw = cutChars(text, NOTEBOOK_TEXT_MAX_CHARS);
  const shown = cutChars(
    escapeInvisible(raw.text.replace(/\r\n/g, '\n')),
    NOTEBOOK_TEXT_MAX_CHARS
  );
  return { text: shown.text, truncated: raw.truncated || shown.truncated };
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
  pixels: number;
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
      refusal: {
        kind: 'nbformat',
        found: shortLabel(
          tree.valueSource(formatNode),
          NOTEBOOK_LABEL_MAX_CHARS
        ),
      },
    };

  const count = tree.childCount(cellsNode);
  if (count > NOTEBOOK_MAX_CELLS)
    return {
      ok: false,
      refusal: { kind: 'too-many-cells', count, limit: NOTEBOOK_MAX_CELLS },
    };

  const reader: Reader = { images: 0, imageBytes: 0, pixels: 0, outputs: 0 };
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
      sourceTokens: [],
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
  const sourceTokens: { start: number; end: number }[] = [];
  if (sourceNode !== undefined) {
    if (tree.kind(sourceNode) === 'string') {
      sourceTokens.push({
        start: tree.valueStart(sourceNode),
        end: tree.valueEnd(sourceNode),
      });
    } else if (tree.kind(sourceNode) === 'array') {
      for (
        let token = tree.firstChild(sourceNode);
        token !== NONE;
        token = tree.nextSibling(token)
      ) {
        if (tree.kind(token) === 'string')
          sourceTokens.push({
            start: tree.valueStart(token),
            end: tree.valueEnd(token),
          });
      }
    }
  }

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
    sourceTokens,
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
      const raw = cutChars(
        textNode === undefined ? '' : (textOf(tree, textNode, '') ?? ''),
        NOTEBOOK_TEXT_MAX_CHARS
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
      const traceback = cutChars(
        tracebackNode === undefined
          ? ''
          : (textOf(tree, tracebackNode, '\n') ?? ''),
        NOTEBOOK_TEXT_MAX_CHARS
      );
      return {
        index,
        outputType: 'error',
        start,
        end,
        body: {
          kind: 'error',
          name: shortLabel(
            nameNode === undefined ? '' : (textOf(tree, nameNode) ?? ''),
            NOTEBOOK_LABEL_MAX_CHARS
          ),
          value: shortLabel(
            valueNode === undefined ? '' : (textOf(tree, valueNode) ?? ''),
            NOTEBOOK_LABEL_MAX_CHARS
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
      label: shortLabel(withheld.mime, NOTEBOOK_LABEL_MAX_CHARS),
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
  const size = imageSize(bytes, format);
  if (size === undefined) return refused('signature');
  const pixels = size.width * size.height;
  if (
    pixels > NOTEBOOK_IMAGE_MAX_PIXELS ||
    reader.pixels + pixels > NOTEBOOK_IMAGES_MAX_PIXELS
  )
    return refused('size');
  reader.pixels += pixels;
  return { kind: 'image', format, bytes };
}

/** A decoded image's width and height in pixels. */
interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size an image declares in its header, or `undefined` when the header is
 * malformed. Only the header is read: no pixel is decoded, so a small file that
 * declares a huge canvas is refused before a browser is asked to draw it.
 */
function imageSize(
  bytes: Uint8Array,
  format: ImageFormat
): ImageSize | undefined {
  switch (format) {
    case 'png':
      return pngSize(bytes);
    case 'gif':
      return gifSize(bytes);
    case 'jpeg':
      return jpegSize(bytes);
    case 'webp':
      return webpSize(bytes);
  }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sized(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) return undefined;
  const view = viewOf(bytes);
  // The first chunk must be IHDR (the word 0x49484452), 13 bytes long.
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
    return undefined;
  return sized(view.getUint32(16), view.getUint32(20));
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined;
  // The logical screen is the canvas. A zero side is malformed.
  const view = viewOf(bytes);
  return sized(view.getUint16(6, true), view.getUint16(8, true));
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  const view = viewOf(bytes);
  let at = 2; // past the SOI marker
  while (at < bytes.length) {
    if (view.getUint8(at) !== 0xff) return undefined;
    at += 1;
    while (at < bytes.length && view.getUint8(at) === 0xff) at += 1;
    if (at >= bytes.length) return undefined;
    const marker = view.getUint8(at);
    at += 1;
    // Fill is 0xff; 0x00 is stuffing, not a marker; EOI or SOS ends the headers.
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return undefined;
    const length = view.getUint16(at);
    if (length < 2) return undefined;
    // SOF0 to SOF15, but not DHT (C4), JPG (C8) or DAC (CC).
    const frame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (frame) {
      if (length < 8 || at + 7 > bytes.length) return undefined;
      return sized(view.getUint16(at + 5), view.getUint16(at + 3));
    }
    at += length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined;
  const view = viewOf(bytes);
  const chunk = String.fromCharCode(
    view.getUint8(12),
    view.getUint8(13),
    view.getUint8(14),
    view.getUint8(15)
  );
  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte frame tag, the start code 9d 01 2a, then 14-bit width and height.
    if (
      view.getUint8(23) !== 0x9d ||
      view.getUint8(24) !== 0x01 ||
      view.getUint8(25) !== 0x2a
    )
      return undefined;
    return sized(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff
    );
  }
  if (chunk === 'VP8L') {
    // Lossless: a signature byte, then width-1 and height-1 as 14-bit fields.
    if (view.getUint8(20) !== 0x2f) return undefined;
    const bits = view.getUint32(21, true);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    // Extended: the canvas is width-1 and height-1 as 24-bit little-endian values.
    return sized(
      1 + view.getUint16(24, true) + view.getUint8(26) * 0x10000,
      1 + view.getUint16(27, true) + view.getUint8(29) * 0x10000
    );
  }
  return undefined;
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
