/**
 * The cue list for `.srt` and `.vtt` (plan A3). This stub cannot show cues
 * yet, so `undefined` makes the route draw the source view.
 */

import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';

export function mountView(_mount: StructuredMount): StructuredPart | undefined {
  return undefined;
}
