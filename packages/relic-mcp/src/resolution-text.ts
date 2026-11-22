/**
 * The transcript lines for resolved `cell`, `path` and subtitle `time`
 * anchors. Resolved text is untrusted: it is capped by the resolver and written
 * here JSON-encoded, never raw.
 */

import { cellName } from './comments.ts';
import { jsonLine } from './untrusted-text.ts';
import {
  CELL_HEADER_LIMIT_BYTES,
  CELL_TEXT_LIMIT_BYTES,
  CUE_TEXT_LIMIT_BYTES,
  PATH_EXCERPT_LIMIT_BYTES,
  type CellResolved,
  type WorkbookCellResolved,
  type PathResolved,
  type TimeCuesResolved,
  subtitleClock,
} from './resolve-structured.ts';

function cutNote(truncated: boolean, limit: number): string {
  return truncated ? ` (cut to ${limit} bytes)` : '';
}

export function cellResolutionLine(
  resolved: CellResolved | WorkbookCellResolved
): string {
  const range =
    resolved.range === undefined
      ? ''
      : `; range to ${cellName(resolved.range.row_end, resolved.range.col_end)}`;
  const place =
    'sheet' in resolved
      ? `sheet ${jsonLine(resolved.sheet)}, cell ${resolved.address}`
      : `top-left line ${resolved.line}`;
  return (
    `[Resolution: cell text ${jsonLine(resolved.text)}` +
    `${cutNote(resolved.text_truncated, CELL_TEXT_LIMIT_BYTES)}; ` +
    `column header ${jsonLine(resolved.header)}` +
    `${cutNote(resolved.header_truncated, CELL_HEADER_LIMIT_BYTES)}; ` +
    `${place}${range}]\n`
  );
}

/**
 * A quote placed in a Word document or an EPUB, on one line. The quote and its
 * surrounding text are JSON-encoded, so a line break, a bidi control or an
 * escape in the file cannot split or reorder the transcript. Each note says why
 * the placement is less than certain: the surroundings differ, the quote repeats,
 * or chapters were not searched.
 */
export function documentQuoteLine(resolved: {
  readonly format: 'docx' | 'epub';
  readonly exact: string;
  readonly line: number;
  readonly context_before: string;
  readonly context_after: string;
  readonly context_matched?: boolean | undefined;
  readonly occurrences?: number | undefined;
  readonly unreadable_chapters?: number | undefined;
}): string {
  const occurrences = resolved.occurrences ?? 1;
  const unreadable = resolved.unreadable_chapters ?? 0;
  const notes: string[] = [];
  if (occurrences > 1) {
    notes.push(
      resolved.context_matched === false
        ? `the quote occurs ${occurrences} times, and this is the closest of them to its surroundings`
        : `the quote occurs ${occurrences} times, and its surroundings place it here`
    );
  } else if (resolved.context_matched === false) {
    notes.push('its surroundings match only in part');
  }
  if (unreadable > 0) {
    notes.push(
      `${unreadable} chapter(s) could not be read and were not searched, so the same words there are not ruled out`
    );
  }
  const tail = notes.map((note) => `; ${note}`).join('');
  const source = resolved.format === 'docx' ? 'document' : 'ebook';
  return (
    `[Resolution: quote ${jsonLine(resolved.exact)} at line ${resolved.line} of the ${source} text, ` +
    `before ${jsonLine(resolved.context_before)}, after ${jsonLine(resolved.context_after)}${tail}]\n`
  );
}

export function pathResolutionLine(resolved: PathResolved): string {
  const what =
    resolved.output_type !== undefined
      ? `output (${resolved.output_type}) of a ${resolved.cell_type} cell`
      : resolved.cell_type !== undefined
        ? `${resolved.cell_type} cell`
        : `JSON ${resolved.type}`;
  return (
    `[Resolution: ${what} at line ${resolved.line}, value ` +
    `${jsonLine(resolved.excerpt)}` +
    `${cutNote(resolved.excerpt_truncated, PATH_EXCERPT_LIMIT_BYTES)}]\n`
  );
}

export function cueResolutionLines(resolved: TimeCuesResolved): string {
  const rows = resolved.cues.map((cue) => {
    const speaker =
      cue.speaker === undefined ? '' : `, speaker ${jsonLine(cue.speaker)}`;
    const cut = cue.text_truncated
      ? ` (cut to ${CUE_TEXT_LIMIT_BYTES} bytes)`
      : '';
    return (
      `  cue ${cue.index}, line ${cue.line}, ` +
      `${subtitleClock(cue.start)} to ${subtitleClock(cue.end)}${speaker}: ` +
      `${jsonLine(cue.text)}${cut}`
    );
  });
  const more = resolved.cues_truncated
    ? `  ${resolved.cue_count - resolved.cues.length} more matching cue(s) not shown.\n`
    : '';
  return `[Resolution: ${resolved.explanation}]\n${rows.join('\n')}\n${more}`;
}
