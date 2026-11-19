/**
 * Anchor adapter for a cue's span in a subtitle file: the `time` anchor, drawn
 * on the cue list rather than a media element.
 *
 * The media `timeAdapter` accepts only a media element, so it refuses a cue
 * list, and this adapter is registered after it to take the case it refuses.
 */

import type { CommentAnchor } from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';
import { drawnStructuredView } from './structured-view-bridge.ts';

type TimeAnchor = Extract<CommentAnchor, { kind: 'time' }>;

/** `h:mm:ss`, for a label. Whole seconds: a cue list is read by its start. */
function timecode(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}`;
}

export const cueAnchorAdapter: AnchorAdapter<'time'> = {
  kind: 'time',

  label(anchor: TimeAnchor): string {
    return anchor.t_end === undefined
      ? `Commenting at ${timecode(anchor.t)}`
      : `Commenting from ${timecode(anchor.t)} to ${timecode(anchor.t_end)}`;
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
