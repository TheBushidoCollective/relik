/**
 * Labels built from file or comment text: a pointer, a sheet name, a column
 * header, a filename. Each one goes through the same visible escape as the
 * rest of the view, and is cut to a fixed length the way a quote label is, so
 * a label cannot reorder the text around it or stretch a chip off the screen.
 */

import { visibleText } from './json-tree-rows.ts';

/** How many characters a label shows before it abbreviates. */
export const LABEL_DISPLAY_LIMIT = 120;

/** The most source characters a label reads before it is escaped and cut. */
const LABEL_SOURCE_CAP = 512;

/**
 * The text as a label shows it: escaped, then cut to `limit` characters with
 * an ellipsis. A cut that would leave a lone high surrogate drops it.
 */
export function visibleLabel(
  text: string,
  limit = LABEL_DISPLAY_LIMIT
): string {
  const capped = text.length > LABEL_SOURCE_CAP;
  const shown = visibleText(capped ? text.slice(0, LABEL_SOURCE_CAP) : text);
  if (!capped && shown.length <= limit) return shown;
  let cut = shown.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
