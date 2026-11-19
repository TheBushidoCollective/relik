/**
 * Anchor adapter for a node of a JSON tree or a cell of a notebook, by its JSON
 * pointer. Like the cell adapter, it hands the work to the drawn view and never
 * paints on the source.
 */

import type { CommentAnchor } from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';
import {
  drawnStructuredView,
  type StructuredViewHandle,
} from './structured-view-bridge.ts';

type PathAnchor = Extract<CommentAnchor, { kind: 'path' }>;

/** The drawn view that holds path marks: a tree or a notebook. */
function pathView(surface: AnchorSurface): StructuredViewHandle | undefined {
  return (
    drawnStructuredView(surface.host, 'tree') ??
    drawnStructuredView(surface.host, 'notebook')
  );
}

export const pathAnchorAdapter: AnchorAdapter<'path'> = {
  kind: 'path',

  label(anchor: PathAnchor): string {
    return anchor.pointer === ''
      ? 'Commenting on the whole document'
      : `Commenting on ${anchor.pointer}`;
  },

  supports(surface: AnchorSurface): boolean {
    return pathView(surface) !== undefined;
  },

  paint(
    surface: AnchorSurface,
    _overlay: HTMLElement,
    anchor: PathAnchor,
    commentId: string
  ): boolean {
    return pathView(surface)?.paintMark(anchor, commentId) ?? false;
  },

  reveal(surface: AnchorSurface, anchor: PathAnchor, commentId?: string): void {
    pathView(surface)?.reveal(anchor, commentId);
  },
};
