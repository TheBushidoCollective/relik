/**
 * SubRip (`.srt`) and WebVTT (`.vtt`) parsing for the cue list (plan A3;
 * section 4 for the limits, section 5 for the anchors).
 *
 * Hand-written and bounded. The output is text and numbers, never markup: a
 * view draws every run with `textContent`, so no subtitle file can create an
 * element, set an attribute or name a URL. A tag is markup only when it is one
 * of the names below. Every other `<...>` is text, shown as written, so a cue
 * that says `<img src=x onerror=…>` reads as those characters.
 *
 * A file past a limit is refused whole, and the reader is shown its source. A
 * block that cannot be read is skipped and counted, so the rest of the file
 * still shows.
 */

import { COMMENT_ANCHOR_MAX_SECONDS } from './comments.ts';

export type SubtitleFormat = 'srt' | 'vtt';

/** The file's text, as UTF-8 bytes. A larger file is refused before parsing. */
export const SUBTITLE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Past this many cues the file is refused whole. */
export const SUBTITLE_MAX_CUES = 20_000;
/** Cues and NOTE, STYLE and REGION blocks together. */
export const SUBTITLE_MAX_ENTRIES = 40_000;
/** Text kept for one cue or block. Past it the text is cut and marked `truncated`. */
export const SUBTITLE_MAX_TEXT_CHARS = 32_768;
/** A voice annotation kept as the speaker label. */
export const SUBTITLE_MAX_SPEAKER_CHARS = 128;
/** How far a tag may run before its `>`. A longer candidate is text. */
export const SUBTITLE_MAX_TAG_CHARS = 256;
/** Nesting of bold, italic, underline and voice tags. Deeper tags are dropped. */
export const SUBTITLE_MAX_NESTING = 16;

export interface SubtitleSegment {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export interface SubtitleCue {
  readonly kind: 'cue';
  /** The cue's number among the cues, from 1. NOTE and STYLE blocks are not counted. */
  readonly index: number;
  /** The 1-based line the cue's block starts on. */
  readonly line: number;
  readonly id?: string;
  /** Seconds from the start of the media. */
  readonly start: number;
  readonly end: number;
  readonly speaker?: string;
  readonly segments: readonly SubtitleSegment[];
  /** The plain text of the cue, lines joined with `\n`. */
  readonly text: string;
  readonly truncated: boolean;
}

export interface SubtitleBlock {
  readonly kind: 'note' | 'style' | 'region';
  readonly line: number;
  readonly text: string;
  readonly truncated: boolean;
}

export type SubtitleEntry = SubtitleCue | SubtitleBlock;

export interface SubtitleFile {
  readonly format: SubtitleFormat;
  readonly entries: readonly SubtitleEntry[];
  readonly cueCount: number;
  /** Blocks that could not be read as cues. They are skipped and counted. */
  readonly skipped: number;
  readonly firstSkipped?: { readonly line: number; readonly reason: string };
}

export type SubtitleRefusal = 'too-large' | 'too-many' | 'no-cues';

export type SubtitleParseResult =
  | { readonly ok: true; readonly file: SubtitleFile }
  | {
      readonly ok: false;
      readonly reason: SubtitleRefusal;
      readonly skipped: number;
    };

/** The format a file is read as: the extension first, then the declared type. */
export function subtitleFormatFor(
  filename: string,
  mimetype: string
): SubtitleFormat {
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  if (extension === 'vtt') return 'vtt';
  if (extension === 'srt') return 'srt';
  const type = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  return type === 'text/vtt' ? 'vtt' : 'srt';
}

/** The UTF-8 length of `text`, counted without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

const TIMESTAMP_HOURS = /^(\d{2,}):([0-5]\d):([0-5]\d)[.,](\d{3})$/;
const TIMESTAMP_MINUTES = /^([0-5]\d):([0-5]\d)[.,](\d{3})$/;
const TIMING = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t].*)?$/;
const NOTE_HEAD = /^NOTE(?:[ \t]|$)/;
const STYLE_HEAD = /^STYLE[ \t]*$/;
const REGION_HEAD = /^REGION(?:[ \t]|$)/;
const WEBVTT_HEAD = /^WEBVTT(?:[ \t]|$)/;
const TAG_NAME = /^([A-Za-z]+)(.*)$/;
const TIMESTAMP_TAG = /^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/;

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&lrm;', '\u200e'],
  ['&rlm;', '\u200f'],
  ['&nbsp;', '\u00a0'],
];

const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;

/**
 * The timestamp in milliseconds, or `undefined` when the token is not one this
 * format accepts. SubRip requires hours; WebVTT takes `mm:ss.mmm` too.
 */
function parseClock(token: string, hoursRequired: boolean): number | undefined {
  if (token.length > 24) return undefined;
  const withHours = TIMESTAMP_HOURS.exec(token);
  const withoutHours = hoursRequired ? null : TIMESTAMP_MINUTES.exec(token);
  if (withHours === null && withoutHours === null) return undefined;
  const hours = withHours === null ? 0 : Number(withHours[1] ?? 0);
  const [minutes, seconds, millis] =
    withHours === null
      ? [withoutHours?.[1], withoutHours?.[2], withoutHours?.[3]]
      : [withHours[2], withHours[3], withHours[4]];
  const ms =
    ((hours * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0)) * 1000 +
    Number(millis ?? 0);
  return ms <= COMMENT_ANCHOR_MAX_SECONDS * 1000 ? ms : undefined;
}

/** Cuts text to the per-block cap on a code-unit boundary. */
function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= SUBTITLE_MAX_TEXT_CHARS) return { text, truncated: false };
  let cut = SUBTITLE_MAX_TEXT_CHARS;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return { text: text.slice(0, cut), truncated: true };
}

interface TagToken {
  /** Index just past the closing `>`. */
  readonly end: number;
  readonly kind: 'open' | 'close' | 'drop';
  readonly name: string;
  readonly annotation: string;
}

/**
 * The tag starting at `start`, when the `<` begins a recognised one. A
 * candidate that meets another `<`, or runs past the tag cap, is text. Scanning
 * stops at the next `<`, so a string of `<` characters costs linear time.
 */
function readTag(source: string, start: number): TagToken | undefined {
  const limit = Math.min(source.length, start + SUBTITLE_MAX_TAG_CHARS + 1);
  let close = -1;
  for (let j = start + 1; j < limit; j++) {
    const code = source.charCodeAt(j);
    if (code === 0x3e) {
      close = j;
      break;
    }
    if (code === 0x3c) break;
  }
  if (close < 0) return undefined;
  const body = source.slice(start + 1, close);
  const closing = body.startsWith('/');
  const inner = closing ? body.slice(1) : body;
  const end = close + 1;
  if (!closing && TIMESTAMP_TAG.test(inner)) {
    return { end, kind: 'drop', name: '', annotation: '' };
  }
  const named = TAG_NAME.exec(inner);
  if (named === null) return undefined;
  const name = named[1] ?? '';
  const rest = named[2] ?? '';
  const attributeStart = rest === '' || /^[.\s]/.test(rest);
  if (name === 'b' || name === 'i' || name === 'u') {
    if (rest !== '') return undefined;
    return { end, kind: closing ? 'close' : 'open', name, annotation: '' };
  }
  if (name === 'v') {
    if (!attributeStart) return undefined;
    const annotation = closing ? '' : decodeEntities(rest.trim());
    return {
      end,
      kind: closing ? 'close' : 'open',
      name,
      annotation: annotation.slice(0, SUBTITLE_MAX_SPEAKER_CHARS),
    };
  }
  if (name === 'c' || name === 'lang' || name === 'ruby' || name === 'rt') {
    if (!attributeStart) return undefined;
    return { end, kind: 'drop', name, annotation: '' };
  }
  return undefined;
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  let out = text;
  for (const [entity, value] of ENTITIES) out = out.split(entity).join(value);
  return out;
}

interface CueContent {
  readonly segments: readonly SubtitleSegment[];
  readonly text: string;
  readonly speaker: string | undefined;
  readonly truncated: boolean;
}

/** The runs and speaker of a cue's text lines. Markup is read, never emitted. */
function cueContent(lines: readonly string[]): CueContent {
  const source = lines.join('\n');
  const out: SubtitleSegment[] = [];
  const stack: string[] = [];
  let run = '';
  let runMask = 0;
  let produced = 0;
  let speaker: string | undefined;
  let truncated = false;

  const flush = (): void => {
    if (run === '') return;
    out.push({
      text: run,
      bold: (runMask & BOLD) !== 0,
      italic: (runMask & ITALIC) !== 0,
      underline: (runMask & UNDERLINE) !== 0,
    });
    run = '';
  };

  /** Adds text in the current style. False once the cap is reached. */
  const write = (chunk: string): boolean => {
    const room = SUBTITLE_MAX_TEXT_CHARS - produced;
    if (chunk.length <= room) {
      run += chunk;
      produced += chunk.length;
      return true;
    }
    let take = Math.max(0, room);
    if (take > 0 && isHighSurrogate(chunk.charCodeAt(take - 1))) take -= 1;
    run += chunk.slice(0, take);
    produced += take;
    truncated = true;
    return false;
  };

  /** Starts a new run when the style changes. */
  const restyle = (): void => {
    const mask =
      (stack.includes('b') ? BOLD : 0) |
      (stack.includes('i') ? ITALIC : 0) |
      (stack.includes('u') ? UNDERLINE : 0);
    if (mask === runMask) return;
    flush();
    runMask = mask;
  };

  let i = 0;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (code === 0x3c) {
      const tag = readTag(source, i);
      if (tag !== undefined) {
        if (tag.kind === 'open') {
          if (tag.name === 'v') {
            if (stack.length < SUBTITLE_MAX_NESTING) {
              stack.push('v');
              if (speaker === undefined && tag.annotation !== '')
                speaker = tag.annotation;
            }
          } else if (stack.length < SUBTITLE_MAX_NESTING) {
            stack.push(tag.name);
            restyle();
          }
        } else if (tag.kind === 'close') {
          const at = stack.lastIndexOf(tag.name);
          if (at >= 0) {
            stack.splice(at, 1);
            restyle();
          }
        }
        i = tag.end;
        continue;
      }
      if (!write('<')) break;
      i += 1;
      continue;
    }
    if (code === 0x26) {
      const entity = ENTITIES.find(([name]) => source.startsWith(name, i));
      if (entity !== undefined) {
        if (!write(entity[1])) break;
        i += entity[0].length;
        continue;
      }
      if (!write('&')) break;
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < source.length) {
      const next = source.charCodeAt(j);
      if (next === 0x3c || next === 0x26) break;
      j += 1;
    }
    if (!write(source.slice(i, j))) break;
    i = j;
  }
  flush();
  return {
    segments: out,
    text: out.map((segment) => segment.text).join(''),
    speaker,
    truncated,
  };
}

/** The blocks WebVTT names apart from cues, as the kind they show as. */
function fixedBlockKind(head: string): 'note' | 'style' | 'region' | undefined {
  if (NOTE_HEAD.test(head)) return 'note';
  if (STYLE_HEAD.test(head)) return 'style';
  if (REGION_HEAD.test(head)) return 'region';
  return undefined;
}

/** The text of a NOTE, STYLE or REGION block: after its keyword, then its lines. */
function fixedBlockText(
  kind: 'note' | 'style' | 'region',
  block: readonly string[]
): string {
  const head = block[0] ?? '';
  const keywordLength = kind === 'style' ? 5 : kind === 'note' ? 4 : 6;
  const rest = head.slice(keywordLength).trim();
  const lines = rest === '' ? block.slice(1) : [rest, ...block.slice(1)];
  return lines.join('\n');
}

/** The result of reading one block as a cue, or the reason it could not. */
type CueRead =
  | {
      readonly ok: true;
      readonly start: number;
      readonly end: number;
      readonly id: string | undefined;
      readonly text: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

function readCueBlock(
  block: readonly string[],
  format: SubtitleFormat
): CueRead {
  const timingAt = block.findIndex((line) => line.includes('-->'));
  if (timingAt < 0 || timingAt > 1) {
    return { ok: false, reason: 'no timing line' };
  }
  const match = TIMING.exec((block[timingAt] ?? '').trim());
  if (match === null) return { ok: false, reason: 'bad timing line' };
  const hoursRequired = format === 'srt';
  const start = parseClock(match[1] ?? '', hoursRequired);
  const end = parseClock(match[2] ?? '', hoursRequired);
  if (start === undefined || end === undefined) {
    return { ok: false, reason: 'bad timestamp' };
  }
  if (end < start) return { ok: false, reason: 'ends before it starts' };
  const text = block.slice(timingAt + 1);
  if (text.length === 0) return { ok: false, reason: 'no text' };
  const id = timingAt === 1 ? (block[0] ?? '').trim() : undefined;
  return {
    ok: true,
    start: start / 1000,
    end: end / 1000,
    id: id === undefined || id === '' ? undefined : id,
    text,
  };
}

/** One line of a subtitle file, with its 1-based number. */
interface LineRead {
  readonly text: string;
  readonly number: number;
}

/**
 * Returns a reader that yields the lines of a text one at a time. The text is
 * never split whole, so a file of many short lines costs no line array. Breaks
 * are CR LF, CR or LF, as `split` on `LINE_BREAK` read them. The reader returns
 * `undefined` past the last line.
 */
function lineCursor(source: string): () => LineRead | undefined {
  let start = 0;
  let number = 0;
  return () => {
    if (start > source.length) return undefined;
    number += 1;
    let end = start;
    while (end < source.length) {
      const code = source.charCodeAt(end);
      if (code === 0x0a || code === 0x0d) break;
      end += 1;
    }
    const text = source.slice(start, end);
    if (end === source.length) start = end + 1;
    else if (
      source.charCodeAt(end) === 0x0d &&
      source.charCodeAt(end + 1) === 0x0a
    )
      start = end + 2;
    else start = end + 1;
    return { text, number };
  };
}

/**
 * Reads a subtitle file. Limits are checked before the work they bound, and a
 * file past one is refused whole. Malformed blocks are skipped and counted.
 */
export function parseSubtitles(
  text: string,
  format: SubtitleFormat
): SubtitleParseResult {
  if (utf8ByteLength(text) > SUBTITLE_LIMIT_BYTES) {
    return { ok: false, reason: 'too-large', skipped: 0 };
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const entries: SubtitleEntry[] = [];
  let cueCount = 0;
  let skipped = 0;
  let firstSkipped: { line: number; reason: string } | undefined;
  let blocks = 0;
  const nextLine = lineCursor(source);

  const skip = (line: number, reason: string): void => {
    skipped += 1;
    firstSkipped ??= { line, reason };
  };

  let pending = nextLine();
  while (pending !== undefined) {
    if (pending.text === '') {
      pending = nextLine();
      continue;
    }
    const line = pending.number;
    const block: string[] = [];
    while (pending !== undefined && pending.text !== '') {
      block.push(pending.text);
      pending = nextLine();
    }
    const isFirstBlock = blocks === 0;
    blocks += 1;
    const head = block[0] ?? '';

    if (format === 'vtt' && isFirstBlock && WEBVTT_HEAD.test(head)) continue;

    if (entries.length >= SUBTITLE_MAX_ENTRIES) {
      return { ok: false, reason: 'too-many', skipped: 0 };
    }

    const fixed = format === 'vtt' ? fixedBlockKind(head) : undefined;
    if (fixed !== undefined) {
      if (block.some((entry) => entry.includes('-->'))) {
        skip(line, `${fixed.toUpperCase()} block contains -->`);
        continue;
      }
      const kept = capText(fixedBlockText(fixed, block));
      entries.push({
        kind: fixed,
        line,
        text: kept.text,
        truncated: kept.truncated,
      });
      continue;
    }

    const read = readCueBlock(block, format);
    if (!read.ok) {
      skip(line, read.reason);
      continue;
    }
    if (cueCount >= SUBTITLE_MAX_CUES) {
      return { ok: false, reason: 'too-many', skipped: 0 };
    }
    cueCount += 1;
    const content = cueContent(read.text);
    entries.push({
      kind: 'cue',
      index: cueCount,
      line,
      ...(read.id === undefined ? {} : { id: read.id }),
      start: read.start,
      end: read.end,
      ...(content.speaker === undefined ? {} : { speaker: content.speaker }),
      segments: content.segments,
      text: content.text,
      truncated: content.truncated,
    });
  }

  if (cueCount === 0) return { ok: false, reason: 'no-cues', skipped };
  return {
    ok: true,
    file: {
      format,
      entries,
      cueCount,
      skipped,
      ...(firstSkipped === undefined ? {} : { firstSkipped }),
    },
  };
}
