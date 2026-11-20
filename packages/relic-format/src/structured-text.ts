/**
 * Text helpers shared by the structured-file readers, the viewer and the MCP
 * transcript writer. This module imports nothing, so every package can use it
 * without a cycle.
 *
 * One definition of "invisible" serves them all, so a character a reader could
 * not see is escaped the same way wherever it is shown or written.
 */

/**
 * Code points a reader cannot see or that reorder text: C0 controls other than
 * tab and line feed, DEL, the C1 block, the Arabic letter mark, the LRM and RLM
 * marks, the bidi embeddings and overrides, the bidi isolates, and the line and
 * paragraph separators. Ranges are inclusive.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/** Whether a code point is invisible in the sense above. */
export function isInvisible(code: number): boolean {
  for (const [low, high] of INVISIBLE_RANGES) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

const INVISIBLE_PATTERN = new RegExp(
  `[${INVISIBLE_RANGES.map(
    ([low, high]) =>
      `\\u${low.toString(16).toUpperCase().padStart(4, '0')}-\\u${high.toString(16).toUpperCase().padStart(4, '0')}`
  ).join('')}]`,
  'g'
);

/** Every invisible character written as `[U+XXXX]`, so a reader can see it. */
export function escapeInvisible(text: string): string {
  return text.replace(
    INVISIBLE_PATTERN,
    (character) =>
      `[U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`
  );
}

/**
 * The first `max` characters of a text, without splitting a surrogate pair,
 * with whether anything was cut.
 */
export function cutChars(
  text: string,
  max: number
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * A short label from the file, for a notice or a header: line endings are
 * normalised and invisible characters escaped. The text is cut to `max`
 * characters before escaping (so an oversized value is never expanded) and
 * again after, so the label is at most `max` characters long.
 */
export function shortLabel(text: string, max: number): string {
  const raw = cutChars(text, max).text.replace(/\r\n/g, '\n');
  return cutChars(escapeInvisible(raw), max).text;
}

/**
 * The offset in `source` where `exact` occurs with `prefix` directly before it
 * and `suffix` directly after it, or `undefined` when no occurrence has both
 * (or `exact` is empty). The first such occurrence wins.
 *
 * The search is one linear pass (Knuth-Morris-Pratt over prefix + exact +
 * suffix), so a periodic source with many partial matches cannot make it
 * quadratic. A restart per occurrence of `exact` would.
 */
export function findQuote(
  source: string,
  exact: string,
  prefix = '',
  suffix = ''
): number | undefined {
  if (exact.length === 0) return undefined;
  const at = indexOfLinear(source, prefix + exact + suffix);
  return at === -1 ? undefined : at + prefix.length;
}

/** The first index of `pattern` in `text`, or -1. Linear in `text.length`. */
function indexOfLinear(text: string, pattern: string): number {
  const m = pattern.length;
  if (m === 0) return 0;
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i += 1) {
    const c = pattern.charCodeAt(i);
    while (k > 0 && c !== pattern.charCodeAt(k)) k = fail[k - 1] ?? 0;
    if (c === pattern.charCodeAt(k)) k += 1;
    fail[i] = k;
  }
  for (let i = 0, k = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    while (k > 0 && c !== pattern.charCodeAt(k)) k = fail[k - 1] ?? 0;
    if (c === pattern.charCodeAt(k)) k += 1;
    if (k === m) return i - m + 1;
  }
  return -1;
}
