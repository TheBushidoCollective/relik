import { isInvisible } from '@relic/format/structured-text';

/**
 * Text a comment or a relic file supplied, written into a transcript as one
 * JSON string literal. Beyond JSON's own escapes, every invisible character
 * (line and paragraph separators, bidi controls, C1 controls, DEL and the
 * Arabic letter mark) is escaped too, so a line of transcript cannot be split
 * or visually reordered by the text it carries.
 */
export function jsonLine(value: string): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/gu, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return isInvisible(code)
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : character;
  });
}
