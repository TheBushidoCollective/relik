import type { SourceSegment } from './markdown-source.ts';
import type { SuggestBlockKind, SuggestRefusal } from './suggest-draft.ts';
import type { SuggestController } from './suggest-controller.ts';

/** Source offsets and editable blocks owned by one currently drawn view. */
export interface SuggestionSurface {
  readonly root: HTMLElement;
  segments(source: string): readonly SourceSegment[];
  blockKind(block: number): SuggestBlockKind;
  editable(block: number): true | SuggestRefusal;
  repaint(): void;
}

const surfaces = new WeakMap<HTMLElement, SuggestionSurface>();

/** Register against the structured mount root; dispose when that view unmounts. */
export function registerSuggestionSurface(
  host: HTMLElement,
  surface: SuggestionSurface
): () => void {
  surfaces.set(host, surface);
  return () => {
    if (surfaces.get(host) === surface) surfaces.delete(host);
  };
}

/** Return only a surface whose editable root still belongs to the drawn view. */
export function suggestionSurfaceFor(
  host: HTMLElement
): SuggestionSurface | undefined {
  const owner = surfaces.has(host)
    ? host
    : host.querySelector<HTMLElement>('.structured-view');
  if (!owner) return undefined;
  const surface = surfaces.get(owner);
  return surface && owner.contains(surface.root) ? surface : undefined;
}

/** An unsent or failed suggestion must remain visible; an in-flight post may finish after a swap. */
export function guardSurfaceSwap(
  controller:
    | Pick<SuggestController, 'draftOpen' | 'postInFlight' | 'hasPendingDraft'>
    | undefined
): string | null {
  return controller?.hasPendingDraft() &&
    (controller.draftOpen || !controller.postInFlight)
    ? 'Send or discard your suggestion first'
    : null;
}

/** Let the thread refuse a DOM replacement before a view discards its surface. */
export function requestSurfaceSwap(root: HTMLElement): boolean {
  return root.dispatchEvent(
    new CustomEvent('relic:before-structured-swap', {
      bubbles: true,
      cancelable: true,
    })
  );
}
