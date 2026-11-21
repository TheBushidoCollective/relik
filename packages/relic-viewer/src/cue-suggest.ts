import {
  subtitleTextSpans,
  type SubtitleCue,
  type SubtitleFormat,
} from '@relic/format/subtitles';
import type { SourceSegment } from './markdown-source.ts';
import type { SuggestRefusal } from './suggest-draft.ts';

export function encodeCueText(
  format: SubtitleFormat,
  text: string,
  before = '',
  after = '',
  original?: string
): string | SuggestRefusal {
  if (format === 'srt' && text.includes('<'))
    return {
      kind: 'refused',
      code: 'markup-in-cue',
      message: 'SubRip text cannot contain <.',
    };
  const encoded =
    format === 'vtt'
      ? text
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
      : text;
  const result = before + encoded + after;
  const leadingBoundary = /^[ \t]*\r?\n/.test(result);
  const trailingBoundary = /\r?\n[ \t]*$/.test(result);
  const preservesLeadingWhitespace =
    /^[ \t]+\r?\n/.test(result) &&
    original !== undefined &&
    /^[ \t]+\r?\n/.test(original);
  const preservesTrailingWhitespace =
    /\r?\n[ \t]+$/.test(result) &&
    original !== undefined &&
    /\r?\n[ \t]+$/.test(original);
  if (
    result === '' ||
    (leadingBoundary && !preservesLeadingWhitespace) ||
    (trailingBoundary && !preservesTrailingWhitespace) ||
    /\r?\n[ \t]*\r?\n/.test(result) ||
    result.includes('-->')
  )
    return {
      kind: 'refused',
      code: 'ends-cue',
      message: 'That text would end or change a cue.',
    };
  return encoded;
}

/** Decode only the WebVTT entities the subtitle parser displays. */
export function decodeCueText(format: SubtitleFormat, source: string): string {
  if (format !== 'vtt') return source;
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&lrm;': '\u200e',
    '&rlm;': '\u200f',
    '&nbsp;': '\u00a0',
  };
  return source.replace(
    /&(?:amp|lt|gt|lrm|rlm|nbsp);/g,
    (entity) => entities[entity]!
  );
}

/** Segments are deliberately separated by tags so edits cannot consume markup. */
export function cueSourceSegments(
  source: string,
  cue: SubtitleCue
): SourceSegment[] {
  return subtitleTextSpans(source, cue).map((span) => ({
    text: span.text,
    start: span.start,
    end: span.end,
    block: cue.index,
    kind: span.escape ? 'escape' : 'text',
  }));
}
