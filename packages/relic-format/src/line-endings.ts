import { filenameExtension } from './renderer-class.ts';

export const SUGGESTION_SOURCE_LIMIT_BYTES = 1_048_576;

export type SuggestionSourceFailure =
  | 'too_large'
  | 'not_utf8'
  | 'has_cr'
  | 'has_nul'
  | 'mixed_line_endings';

/** CRLF conversion is valid only after rejecting lone CR and mixed endings. */
export function normalizeCrLf(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

/** Restore the original line endings after merging on normalized offsets. */
export function restoreCrLf(source: string): string {
  return source.replace(/\n/g, '\r\n');
}

/** Decode source once for viewer, resolver and apply; offsets refer to LF text. */
export function suggestionSourceFor(
  bytes: Uint8Array,
  filename: string,
  mimetype = ''
):
  | { ok: true; source: string; bom: boolean; crlf: boolean }
  | { ok: false; reason: SuggestionSourceFailure } {
  if (bytes.byteLength > SUGGESTION_SOURCE_LIMIT_BYTES)
    return { ok: false, reason: 'too_large' };
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }
  if (source.includes('\0')) return { ok: false, reason: 'has_nul' };
  if (!source.includes('\r')) return { ok: true, source, bom, crlf: false };
  const extension = filenameExtension(filename);
  const extensionKind =
    extension === 'csv' ||
    extension === 'tsv' ||
    extension === 'srt' ||
    extension === 'vtt'
      ? 'supported'
      : extension === 'json'
        ? 'other'
        : undefined;
  const type = mimetype.toLowerCase().split(';')[0]?.trim() ?? '';
  const supportsCrLf =
    extensionKind === 'supported' ||
    (extensionKind === undefined &&
      [
        'text/csv',
        'text/tab-separated-values',
        'application/x-subrip',
        'text/vtt',
      ].includes(type));
  if (!supportsCrLf || /\r(?!\n)/.test(source))
    return { ok: false, reason: 'has_cr' };
  if (/(?<!\r)\n/.test(source))
    return { ok: false, reason: 'mixed_line_endings' };
  return { ok: true, source: normalizeCrLf(source), bom, crlf: true };
}
