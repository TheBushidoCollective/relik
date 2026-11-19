/**
 * The table view for `.csv` and `.tsv` (plan A1). This stub cannot show a
 * table yet, so `undefined` makes the route draw the source view, which is the
 * code route's behaviour before structured views existed.
 */

import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';

export function mountView(_mount: StructuredMount): StructuredPart | undefined {
  return undefined;
}
