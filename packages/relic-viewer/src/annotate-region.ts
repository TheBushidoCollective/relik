import type { CommentAnchor } from '@relic/format';
import type { AnchorAdapter, AnchorSurface } from './anchoring.ts';
import { boxFromUnit } from './anchoring.ts';

/**
 * Checks whether an element is an image element.
 *
 * Checks both the DOM constructor and the tagName property so that stub DOMs
 * in test harnesses (which define tagName but may not register browser
 * constructors on globalThis) pass without faking a renderer class.
 */
export function isImageElement(element: unknown): element is HTMLImageElement {
  if (
    typeof HTMLImageElement !== 'undefined' &&
    element instanceof HTMLImageElement
  ) {
    return true;
  }
  if (element && typeof element === 'object' && 'tagName' in element) {
    const tag = element.tagName;
    return typeof tag === 'string' && tag.toUpperCase() === 'IMG';
  }
  return false;
}

/**
 * Adapter for rectangular region marks drawn on an image artifact.
 *
 * Coordinates are stored as unit values (0 to 1) relative to the image content
 * box rather than the stage, ensuring that marks land on the exact same
 * features of the picture across viewport resize and letterboxing changes.
 */
export const regionAdapter: AnchorAdapter<'region'> = {
  kind: 'region',

  label(_anchor: Extract<CommentAnchor, { kind: 'region' }>): string {
    return 'Commenting on a region of the image';
  },

  supports(surface: AnchorSurface): boolean {
    return isImageElement(surface.content);
  },

  paint(
    surface: AnchorSurface,
    overlay: HTMLElement,
    anchor: Extract<CommentAnchor, { kind: 'region' }>,
    commentId: string
  ): boolean {
    const box = boxFromUnit(surface, anchor.rect);
    if (box === undefined) {
      // The image has not loaded or has no area yet. Painting into a zero box
      // would place the mark at the host origin, which reads as a mark on the
      // wrong thing rather than as a mark waiting for its asset.
      return false;
    }

    const region = document.createElement('div');
    region.className = 'comment-region';
    region.dataset.commentId = commentId;
    region.style.left = `${box.left}px`;
    region.style.top = `${box.top}px`;
    region.style.width = `${box.width}px`;
    region.style.height = `${box.height}px`;

    const isPending =
      commentId === 'pending:target' || commentId.startsWith('pending:');

    if (isPending) {
      region.classList.add('is-pending');
    } else {
      // A visible number inside the box gives the reader a clear pairing with
      // the comment thread, matching the numbered pins.
      const badge = document.createElement('span');
      badge.className = 'comment-region-badge';
      const count =
        overlay.querySelectorAll(
          '.comment-pin:not(.is-pending), .comment-region:not(.is-pending)'
        ).length + 1;
      badge.textContent = String(count);
      region.appendChild(badge);
    }

    overlay.appendChild(region);
    return true;
  },

  reveal(
    surface: AnchorSurface,
    anchor: Extract<CommentAnchor, { kind: 'region' }>
  ): void {
    const box = boxFromUnit(surface, anchor.rect);
    if (box === undefined) return;

    const host = surface.host;
    const currentScrollTop = host.scrollTop;
    const currentScrollLeft = host.scrollLeft;
    const clientHeight = host.clientHeight;
    const clientWidth = host.clientWidth;

    if (
      box.top < currentScrollTop ||
      box.top + box.height > currentScrollTop + clientHeight
    ) {
      host.scrollTop = Math.max(0, box.top - clientHeight / 4);
    }
    if (
      box.left < currentScrollLeft ||
      box.left + box.width > currentScrollLeft + clientWidth
    ) {
      host.scrollLeft = Math.max(0, box.left - clientWidth / 4);
    }
  },
};
