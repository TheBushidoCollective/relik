/**
 * The notebook view for `.ipynb` (plan A4). This stub cannot show a notebook
 * yet, so `undefined` makes the route draw the source view. A notebook route
 * therefore reads as its JSON text until A4 lands, and never as a blank page.
 */

import type {
  StructuredMount,
  StructuredPart,
} from './structured-view-bridge.ts';

export function mountView(_mount: StructuredMount): StructuredPart | undefined {
  return undefined;
}
