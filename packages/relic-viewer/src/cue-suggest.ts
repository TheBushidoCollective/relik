import {
  subtitleTextSpans,
  type SubtitleCue,
  type SubtitleFormat,
} from '@relic/format/subtitles';
import type { SourceSegment } from './markdown-source.ts';
import type { SuggestRefusal } from './suggest-draft.ts';

export function encodeCueText(
  format: SubtitleFormat,
  text: string
): string | SuggestRefusal {
  if (format === 'srt' && text.includes('<'))
    return {
      kind: 'refused',
      code: 'markup-in-cue',
      message: 'SubRip text cannot contain <.',
    };
  if (/\n[ \t]*\n/.test(text) || text.includes('-->'))
    return {
      kind: 'refused',
      code: 'ends-cue',
      message: 'That text would end or change a cue.',
    };
  return format === 'vtt'
    ? text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
    : text;
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
