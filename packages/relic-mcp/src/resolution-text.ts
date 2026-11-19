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
  type PathResolved,
  type TimeCuesResolved,
  subtitleClock,
} from './resolve-structured.ts';

function cutNote(truncated: boolean, limit: number): string {
  return truncated ? ` (cut to ${limit} bytes)` : '';
}

export function cellResolutionLine(resolved: CellResolved): string {
  const range =
    resolved.range === undefined
      ? ''
      : `; range to ${cellName(resolved.range.row_end, resolved.range.col_end)}`;
  return (
    `[Resolution: cell text ${jsonLine(resolved.text)}` +
    `${cutNote(resolved.text_truncated, CELL_TEXT_LIMIT_BYTES)}; ` +
    `column header ${jsonLine(resolved.header)}` +
    `${cutNote(resolved.header_truncated, CELL_HEADER_LIMIT_BYTES)}; ` +
    `top-left line ${resolved.line}${range}]\n`
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
