/**
 * Resolution of `cell`, `path` and SRT or VTT `time` anchors against one
 * published version of a structured file (plan section 5, MCP side).
 *
 * Pure: the caller decrypts a version and hands over its bytes. Each reader is
 * the parser the viewer draws with (`@relic/format/csv`, `json-tree`,
 * `notebook`, `subtitles`), so a coordinate the reader shows is the coordinate
 * an agent gets back. Nothing here throws. A location the version does not hold
 * is `status: 'unresolvable'` with an explanation that says "not found in this
 * version". Text a file supplies is capped here; the transcript encodes it.
 */

import type {
  CellCommentAnchor,
  CommentAnchor,
  PathCommentAnchor,
} from '@relic/format';
import {
  cellText,
  parseTable,
  recordWidth,
  type TableParse,
  type TableParseFailure,
} from '@relic/format/csv';
import {
  type JsonTreeFailure,
  type JsonTreeResult,
  jsonStringValue,
  parseJsonTree,
  parsePointerTokens,
  utf8Length,
} from '@relic/format/json-tree';
import {
  escapeInvisible,
  type NotebookOutput,
  type NotebookRefusal,
  type NotebookResult,
  notebookTarget,
  parseNotebook,
} from '@relic/format/notebook';
import {
  type SubtitleCue,
  type SubtitleParseResult,
  subtitleFormatFor,
  parseSubtitles,
} from '@relic/format/subtitles';

/** A cell's text, cut to this many UTF-8 bytes. */
export const CELL_TEXT_LIMIT_BYTES = 512;
/** A column's header text, cut to this many UTF-8 bytes. */
export const CELL_HEADER_LIMIT_BYTES = 128;
/** A JSON value or notebook cell or output excerpt, in UTF-8 bytes. */
export const PATH_EXCERPT_LIMIT_BYTES = 512;
/** One matched cue's text, in UTF-8 bytes. */
export const CUE_TEXT_LIMIT_BYTES = 512;
/** Matching cues returned for one time anchor. The rest are counted, not sent. */
export const TIME_CUE_LIMIT = 20;

export type StructuredKind =
  | 'table'
  | 'json'
  | 'notebook'
  | 'subtitles'
  | 'other';

export interface NotFound<K extends string> {
  readonly kind: K;
  readonly status: 'unresolvable';
  readonly explanation: string;
}

export interface CellRange {
  readonly row_end: number;
  readonly col_end: number;
}

export interface CellResolved {
  readonly kind: 'cell';
  readonly status: 'resolved';
  /** The top-left cell's text, cut to `CELL_TEXT_LIMIT_BYTES`. */
  readonly text: string;
  readonly text_truncated: boolean;
  /** The first record's text in the same column, cut to `CELL_HEADER_LIMIT_BYTES`. */
  readonly header: string;
  readonly header_truncated: boolean;
  /** The 1-based physical line the top-left cell starts on. */
  readonly line: number;
  /** The inclusive extent of a range, as the comment wrote it. */
  readonly range?: CellRange;
}

export type CellResolution = CellResolved | NotFound<'cell'>;

export type PathType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'cell'
  | 'output';

export interface PathResolved {
  readonly kind: 'path';
  readonly status: 'resolved';
  /** The JSON value kind, or `cell` and `output` for a notebook. */
  readonly type: PathType;
  /** The value as text: a string's decoded value, otherwise the source as written. */
  readonly excerpt: string;
  readonly excerpt_truncated: boolean;
  readonly line: number;
  /** A notebook cell's kind. Absent for JSON. */
  readonly cell_type?: 'markdown' | 'code' | 'raw';
  /** A notebook output's type. Absent unless the path names an output. */
  readonly output_type?:
    | 'stream'
    | 'error'
    | 'display_data'
    | 'execute_result'
    | 'unknown';
}

export type PathResolution = PathResolved | NotFound<'path'>;

/** One cue a time anchor matched, with its text cut for display and transcript. */
export interface SubtitleCueExcerpt {
  readonly index: number;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly speaker?: string;
  readonly text: string;
  readonly text_truncated: boolean;
}

export interface TimeCuesResolved {
  readonly kind: 'time';
  readonly status: 'resolved';
  readonly t: number;
  readonly t_end?: number;
  readonly has_frames: false;
  readonly downscaled: false;
  readonly explanation: string;
  /** The first `TIME_CUE_LIMIT` matches, in file order. */
  readonly cues: readonly SubtitleCueExcerpt[];
  /** Every match, including those past the limit. */
  readonly cue_count: number;
  readonly cues_truncated: boolean;
}

export type TimeCuesResolution = TimeCuesResolved | NotFound<'time'>;

type TimeAnchor = Extract<CommentAnchor, { kind: 'time' }>;

/** Caps a string to a UTF-8 byte budget without splitting a code point. */
export function capBytes(
  text: string,
  limit: number
): { readonly text: string; readonly truncated: boolean } {
  if (utf8Length(text) <= limit) return { text, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8Length(character);
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** `hh:mm:ss.mmm`, the clock a cue is listed with. */
export function subtitleClock(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(millis, 3)}`;
}

/** The kind of structured file a relic holds, from its extension, then its type. */
export function structuredKindOf(
  filename: string,
  mimetype: string
): StructuredKind {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  switch (extension) {
    case 'ipynb':
      return 'notebook';
    case 'csv':
    case 'tsv':
      return 'table';
    case 'json':
      return 'json';
    case 'srt':
    case 'vtt':
      return 'subtitles';
  }
  const type = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  if (type === 'text/csv' || type === 'text/tab-separated-values')
    return 'table';
  if (type === 'application/json') return 'json';
  if (type === 'text/vtt') return 'subtitles';
  return 'other';
}

function describeTableFailure(failure: TableParseFailure): string {
  switch (failure.reason) {
    case 'empty':
      return 'it is empty';
    case 'binary':
      return 'it holds a NUL byte';
    case 'unclosed-quote':
      return `a quote opened on line ${failure.line} is never closed`;
    case 'too-large':
      return `it is over the ${failure.limit} limit`;
  }
}

function describeJsonFailure(failure: JsonTreeFailure): string {
  switch (failure.kind) {
    case 'too-large':
      return `it is over ${failure.limit} bytes`;
    case 'too-many-nodes':
      return `it holds more than ${failure.limit} values`;
    case 'too-deep':
      return `it nests deeper than ${failure.limit} levels, at line ${failure.line}, column ${failure.column}`;
    case 'syntax':
      return `line ${failure.line}, column ${failure.column}: ${failure.reason}`;
  }
}

function describeNotebookRefusal(refusal: NotebookRefusal): string {
  switch (refusal.kind) {
    case 'json':
      return describeJsonFailure(refusal.failure);
    case 'not-notebook':
      return 'it is not a notebook';
    case 'nbformat':
      return 'it is not nbformat 4';
    case 'too-many-cells':
      return `it has more than ${refusal.limit} cells`;
    case 'too-many-outputs':
      return `it has more than ${refusal.limit} outputs`;
  }
}

function describeSubtitleRefusal(
  reason: 'too-large' | 'too-many' | 'no-cues'
): string {
  switch (reason) {
    case 'too-large':
      return 'it is over the size limit';
    case 'too-many':
      return 'it has too many cues';
    case 'no-cues':
      return 'it has no readable cue';
  }
}

/** The text an output shows in an excerpt. Invisible characters are escaped. */
function outputExcerpt(output: NotebookOutput): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const body = output.body;
  switch (body.kind) {
    case 'empty':
      return { text: '', truncated: false };
    case 'stream':
      return {
        text: body.spans.map((span) => span.text).join(''),
        truncated: body.truncated,
      };
    case 'text':
    case 'markdown':
    case 'json':
      return { text: body.text.text, truncated: body.text.truncated };
    case 'error':
      return {
        text: `${body.name}: ${body.value}`,
        truncated: body.truncated,
      };
    case 'image':
      return {
        text: `${body.format} image, ${body.bytes.length} bytes`,
        truncated: false,
      };
    case 'image-refused':
      return {
        text: `image output that could not be shown (declared ${escapeInvisible(body.declared)})`,
        truncated: false,
      };
    case 'withheld': {
      const shown = body.plain ?? body.source;
      return { text: shown.text, truncated: shown.truncated };
    }
  }
}

/** Newline offsets in a text, so an offset maps to its line by binary search. */
function newlineOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (
    let at = text.indexOf('\n');
    at !== -1;
    at = text.indexOf('\n', at + 1)
  ) {
    offsets.push(at);
  }
  return offsets;
}

function lineAt(breaks: readonly number[], offset: number): number {
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((breaks[middle] ?? 0) < offset) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

/**
 * One structured file, read on demand. Each format parses at most once, and
 * the caller shares one reader across every comment on the same version.
 */
export class StructuredReader {
  readonly kind: StructuredKind;
  readonly #source: string;
  readonly #tsv: boolean;
  readonly #filename: string;
  readonly #mimetype: string;
  #table: TableParse | undefined;
  #tree: JsonTreeResult | undefined;
  #notebook: NotebookResult | undefined;
  #subtitles: SubtitleParseResult | undefined;
  #breaks: number[] | undefined;

  constructor(source: string, filename: string, mimetype: string) {
    this.#source = source;
    this.#filename = filename;
    this.#mimetype = mimetype;
    this.kind = structuredKindOf(filename, mimetype);
    this.#tsv =
      /\.tsv$/i.test(filename) ||
      mimetype.toLowerCase().startsWith('text/tab-separated-values');
  }

  /** A cell. Coordinates are A1 coordinates: record 1 is row 1. */
  cell(anchor: CellCommentAnchor): CellResolution {
    const notFound = (why: string): NotFound<'cell'> => ({
      kind: 'cell',
      status: 'unresolvable',
      explanation: `The cell is not found in this version: ${why}`,
    });
    if (this.kind !== 'table') {
      return notFound('a cell anchor resolves only against CSV and TSV files.');
    }
    if (anchor.sheet !== undefined) {
      return notFound('a CSV or TSV file has no sheets.');
    }
    const parsed = this.#tableParse();
    if (!parsed.ok) {
      return notFound(
        `the file cannot be read as a table (${describeTableFailure(parsed)}).`
      );
    }
    const table = parsed.table;
    const endRow = anchor.row_end ?? anchor.row;
    const endCol = anchor.col_end ?? anchor.col;
    if (endRow < anchor.row || endCol < anchor.col) {
      return notFound('the range ends before it starts.');
    }
    if (anchor.row > table.records) {
      return notFound(
        `row ${anchor.row} is past the end of the file, which has ${table.records} row(s).`
      );
    }
    if (endRow > table.records) {
      return notFound(
        `the range runs to row ${endRow}, past the end of the file, which has ${table.records} row(s).`
      );
    }
    if (anchor.col > table.columns) {
      return notFound(
        `column ${anchor.col} is past the widest row, which has ${table.columns} column(s).`
      );
    }
    if (endCol > table.columns) {
      return notFound(
        `the range runs to column ${endCol}, past the widest row, which has ${table.columns} column(s).`
      );
    }
    const record = anchor.row - 1;
    const column = anchor.col - 1;
    const width = recordWidth(table, record);
    if (column >= width) {
      return notFound(
        `row ${anchor.row} has ${width} cell(s), so column ${anchor.col} is past its end.`
      );
    }
    const text = capBytes(
      cellText(table, record, column),
      CELL_TEXT_LIMIT_BYTES
    );
    const header = capBytes(
      column < recordWidth(table, 0) ? cellText(table, 0, column) : '',
      CELL_HEADER_LIMIT_BYTES
    );
    const fieldStart = table.fieldStart[table.recordStart[record]! + column]!;
    const resolved: CellResolved = {
      kind: 'cell',
      status: 'resolved',
      text: text.text,
      text_truncated: text.truncated,
      header: header.text,
      header_truncated: header.truncated,
      line: lineAt(this.#lines(), fieldStart),
      ...(anchor.row_end === undefined && anchor.col_end === undefined
        ? {}
        : { range: { row_end: endRow, col_end: endCol } }),
    };
    return resolved;
  }

  /** A JSON pointer into a JSON file, or a notebook cell or output. */
  path(anchor: PathCommentAnchor): PathResolution {
    const notFound = (why: string): NotFound<'path'> => ({
      kind: 'path',
      status: 'unresolvable',
      explanation: `The path is not found in this version: ${why}`,
    });
    switch (this.kind) {
      case 'json':
        return this.#jsonPath(anchor, notFound);
      case 'notebook':
        return this.#notebookPath(anchor, notFound);
      default:
        return notFound(
          'a path anchor resolves only against JSON and notebook files.'
        );
    }
  }

  /** The cues a time span covers in an SRT or VTT file, in file order. */
  subtitleTime(anchor: TimeAnchor): TimeCuesResolution {
    const span = (): string => {
      const end = anchor.t_end ?? anchor.t;
      return end === anchor.t
        ? subtitleClock(anchor.t)
        : `${subtitleClock(anchor.t)} to ${subtitleClock(end)}`;
    };
    const notFound = (why: string): NotFound<'time'> => ({
      kind: 'time',
      status: 'unresolvable',
      explanation: `The time is not found in this version: ${why}`,
    });
    if (this.kind !== 'subtitles') {
      return notFound('a time anchor on this file is not a subtitle cue.');
    }
    const end = anchor.t_end ?? anchor.t;
    if (end < anchor.t) return notFound('the span ends before it starts.');
    const parsed = this.#subtitleParse();
    if (!parsed.ok) {
      return notFound(
        `the file cannot be read as cues (${describeSubtitleRefusal(parsed.reason)}).`
      );
    }
    // A cue covers [start, end). A point matches the cue whose span holds it,
    // and a span matches every cue it overlaps.
    const matches: SubtitleCue[] = [];
    for (const entry of parsed.file.entries) {
      if (entry.kind !== 'cue') continue;
      if (entry.start <= end && entry.end > anchor.t) matches.push(entry);
    }
    if (matches.length === 0) {
      return notFound(`no subtitle cue covers ${span()}.`);
    }
    const cues = matches
      .slice(0, TIME_CUE_LIMIT)
      .map((cue): SubtitleCueExcerpt => {
        const text = capBytes(cue.text, CUE_TEXT_LIMIT_BYTES);
        return {
          index: cue.index,
          line: cue.line,
          start: cue.start,
          end: cue.end,
          ...(cue.speaker === undefined ? {} : { speaker: cue.speaker }),
          text: text.text,
          text_truncated: text.truncated || cue.truncated,
        };
      });
    return {
      kind: 'time',
      status: 'resolved',
      t: anchor.t,
      ...(anchor.t_end === undefined ? {} : { t_end: anchor.t_end }),
      has_frames: false,
      downscaled: false,
      explanation: `${matches.length} subtitle cue(s) cover ${span()}.`,
      cues,
      cue_count: matches.length,
      cues_truncated: matches.length > TIME_CUE_LIMIT,
    };
  }

  #jsonPath(
    anchor: PathCommentAnchor,
    notFound: (why: string) => NotFound<'path'>
  ): PathResolution {
    if (parsePointerTokens(anchor.pointer) === undefined) {
      return notFound('it is not a valid JSON pointer.');
    }
    const parsed = this.#treeParse();
    if (!parsed.ok) {
      return notFound(
        `the file cannot be read as JSON (${describeJsonFailure(parsed.failure)}).`
      );
    }
    const tree = parsed.tree;
    const node = tree.resolve(anchor.pointer);
    if (node < 0)
      return notFound('no value sits at that path in this version.');
    const type = tree.kind(node);
    const raw =
      type === 'string'
        ? jsonStringValue(tree.valueSource(node))
        : tree.valueSource(node);
    const excerpt = capBytes(raw, PATH_EXCERPT_LIMIT_BYTES);
    return {
      kind: 'path',
      status: 'resolved',
      type,
      excerpt: excerpt.text,
      excerpt_truncated: excerpt.truncated,
      line: lineAt(this.#lines(), tree.spanStart(node)),
    };
  }

  #notebookPath(
    anchor: PathCommentAnchor,
    notFound: (why: string) => NotFound<'path'>
  ): PathResolution {
    const parsed = this.#notebookParse();
    if (!parsed.ok) {
      return notFound(
        `the file cannot be read as a notebook (${describeNotebookRefusal(parsed.refusal)}).`
      );
    }
    const notebook = parsed.notebook;
    const target = notebookTarget(notebook, anchor);
    if (target === undefined) {
      return notFound(
        `no cell or output sits at that path in this notebook, which has ${notebook.cells.length} cell(s).`
      );
    }
    const cell = notebook.cells[target.cell]!;
    if (target.output === undefined) {
      const excerpt = capBytes(cell.source.text, PATH_EXCERPT_LIMIT_BYTES);
      return {
        kind: 'path',
        status: 'resolved',
        type: 'cell',
        cell_type: cell.kind,
        excerpt: excerpt.text,
        excerpt_truncated: excerpt.truncated || cell.source.truncated,
        line: lineAt(this.#lines(), cell.start),
      };
    }
    const output = cell.outputs[target.output]!;
    const shown = outputExcerpt(output);
    const excerpt = capBytes(
      escapeInvisible(shown.text),
      PATH_EXCERPT_LIMIT_BYTES
    );
    return {
      kind: 'path',
      status: 'resolved',
      type: 'output',
      cell_type: cell.kind,
      output_type: output.outputType,
      excerpt: excerpt.text,
      excerpt_truncated: excerpt.truncated || shown.truncated,
      line: lineAt(this.#lines(), output.start),
    };
  }

  #lines(): number[] {
    this.#breaks ??= newlineOffsets(this.#source);
    return this.#breaks;
  }

  #tableParse(): TableParse {
    this.#table ??= parseTable(this.#source, {
      delimiter: this.#tsv ? '\t' : 'auto',
    });
    return this.#table;
  }

  #treeParse(): JsonTreeResult {
    this.#tree ??= parseJsonTree(this.#source);
    return this.#tree;
  }

  #notebookParse(): NotebookResult {
    this.#notebook ??= parseNotebook(this.#source);
    return this.#notebook;
  }

  #subtitleParse(): SubtitleParseResult {
    this.#subtitles ??= parseSubtitles(
      this.#source,
      subtitleFormatFor(this.#filename, this.#mimetype)
    );
    return this.#subtitles;
  }
}

/** A reader for one relic file. Bytes are decoded only for a structured kind. */
export function structuredReaderFor(
  content: Uint8Array,
  filename: string,
  mimetype: string
): StructuredReader {
  const kind = structuredKindOf(filename, mimetype);
  const source =
    kind === 'other'
      ? ''
      : new TextDecoder('utf-8', { fatal: false }).decode(content);
  return new StructuredReader(source, filename, mimetype);
}
