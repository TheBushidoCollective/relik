/**
 * The built-in anchor adapters, installed in one place.
 *
 * Two things this file exists to prevent.
 *
 * **Self-registration on import.** If each adapter module called
 * `registerAnchorAdapter` at its own top level, the table's contents would
 * depend on import order and on whether the bundler kept a module it could
 * not see a use for. A mark that fails to paint because of tree shaking is a
 * defect with no symptom at the call site, and it would appear only in the
 * built bundle, never in a test.
 *
 * **A test emptying the table for every later test.** `resetAnchorAdapters`
 * is a real test seam and the table is process-wide, so a unit test that
 * clears it to install stubs leaves every subsequent file in the same run
 * with no adapters. That is not hypothetical: it produced a failure that
 * passed when its file ran alone and failed in the full suite, where the
 * composer chip read "Commenting on something this page cannot show" for a
 * quote that had an adapter the whole time. A test seam whose blast radius is
 * the rest of the run is worse than no seam, so anything that resets the
 * table calls this to put it back.
 *
 * Installation is therefore a replacement rather than an addition: this
 * module knows the complete built-in set, so it can state the whole table
 * rather than append to whatever was there.
 *
 * Registration order is the documented tie-break when two adapters claim one
 * kind, so the order of these calls is behaviour and not style. More specific
 * surfaces go first: an adapter that only accepts a framed document must be
 * asked before one that accepts the page's own DOM, because the second would
 * otherwise answer for content it cannot reach.
 */

import { registerAnchorAdapter, resetAnchorAdapters } from './anchoring.ts';
import {
  framePinAdapter,
  frameQuoteAdapter,
  frameRegionAdapter,
} from './annotate-frame.ts';
import { otioAdapter } from './annotate-otio.ts';
import { pageAnchorAdapter } from './annotate-page.ts';
import { quoteAdapter } from './annotate-quote.ts';
import { regionAdapter } from './annotate-region.ts';
import { timeAdapter } from './annotate-time.ts';

export function registerBuiltInAnchorAdapters(): void {
  resetAnchorAdapters();
  // Framed adapters first. Order is the tie-break when two adapters claim one
  // kind, and these accept only a surface holding a usercontent frame, which
  // is the narrower test; asking the page-DOM adapters first would let them
  // answer for a document they cannot reach into.
  registerAnchorAdapter(frameQuoteAdapter);
  registerAnchorAdapter(frameRegionAdapter);
  // The only adapter for a point. A point on the page's own DOM is drawn by
  // the stage over its own scroll and never asks the table.
  registerAnchorAdapter(framePinAdapter);
  registerAnchorAdapter(quoteAdapter);
  registerAnchorAdapter(regionAdapter);
  registerAnchorAdapter(otioAdapter);
  registerAnchorAdapter(timeAdapter);
  registerAnchorAdapter(pageAnchorAdapter);
}
