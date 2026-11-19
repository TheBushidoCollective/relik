/**
 * Anchor adapter for a cue's span in a subtitle file: the `time` anchor, drawn
 * on the cue list rather than a media element.
 *
 * The media `timeAdapter` accepts only a media element, so it refuses a cue
 * list, and this adapter is registered after it to take the case it refuses.
 * Its chip says "subtitle", not "moment", because a cue is a line of text with
 * its own start and end.
 */

import type { CommentAnchor } from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';
import { drawnStructuredView } from './structured-view-bridge.ts';

type TimeAnchor = Extract<CommentAnchor, { kind: 'time' }>;

/** `hh:mm:ss.mmm`, the clock a subtitle file is read in. */
export function subtitleClock(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const ms = millis % 1000;
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(ms, 3)}`;
}

export const cueAnchorAdapter: AnchorAdapter<'time'> = {
  kind: 'time',

  label(anchor: TimeAnchor): string {
    return anchor.t_end === undefined
      ? `Commenting on the subtitle at ${subtitleClock(anchor.t)}`
      : `Commenting on subtitles from ${subtitleClock(anchor.t)} to ${subtitleClock(anchor.t_end)}`;
  },

  supports(surface: AnchorSurface): boolean {
    return drawnStructuredView(surface.host, 'cues') !== undefined;
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: TimeAnchor,
    commentId: string
  ): boolean {
    return (
      drawnStructuredView(surface.host, 'cues')?.paintMark(anchor, commentId) ??
      false
    );
  },

  reveal(surface: AnchorSurface, anchor: TimeAnchor, commentId?: string): void {
    drawnStructuredView(surface.host, 'cues')?.reveal(anchor, commentId);
  },
};
