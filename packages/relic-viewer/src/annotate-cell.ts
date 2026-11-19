/**
 * Anchor adapter for a cell, or a rectangle of cells, in a table.
 *
 * The table draws its own marks, on the records it holds, so this adapter only
 * hands the work to the drawn table view. It offers itself only when a table is
 * drawn, so a cell comment on a page that shows the source is reported as
 * unplaceable rather than painted on the wrong thing.
 */

import type { CommentAnchor } from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';
import { cellReference } from './table-model.ts';
import { drawnStructuredView } from './structured-view-bridge.ts';
import { visibleLabel } from './visible-label.ts';

type CellAnchor = Extract<CommentAnchor, { kind: 'cell' }>;

export const cellAnchorAdapter: AnchorAdapter<'cell'> = {
  kind: 'cell',

  label(anchor: CellAnchor): string {
    const from = cellReference(anchor.row, anchor.col);
    const ranged = anchor.row_end !== undefined || anchor.col_end !== undefined;
    const to = cellReference(
      anchor.row_end ?? anchor.row,
      anchor.col_end ?? anchor.col
    );
    const where = ranged ? `cells ${from} to ${to}` : `cell ${from}`;
    return anchor.sheet === undefined
      ? `Commenting on ${where}`
      : `Commenting on ${where} of ${visibleLabel(anchor.sheet)}`;
  },

  supports(surface: AnchorSurface): boolean {
    return drawnStructuredView(surface.host, 'table') !== undefined;
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: CellAnchor,
    commentId: string
  ): boolean {
    return (
      drawnStructuredView(surface.host, 'table')?.paintMark(
        anchor,
        commentId
      ) ?? false
    );
  },

  reveal(surface: AnchorSurface, anchor: CellAnchor, commentId?: string): void {
    drawnStructuredView(surface.host, 'table')?.reveal(anchor, commentId);
  },
};
