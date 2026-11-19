/**
 * Text a comment or a relic file supplied, written into a transcript as one
 * JSON string literal. Beyond JSON's own escapes, line separators, bidi
 * controls and C1 controls are escaped too, so a line of transcript cannot be
 * split or visually reordered by the text it carries.
 */
export function jsonLine(value: string): string {
  const invisible =
    /[\u0080-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g;
  return JSON.stringify(value).replace(
    invisible,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}
