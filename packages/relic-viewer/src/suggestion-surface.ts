import type { SourceSegment } from './markdown-source.ts';
import type { SuggestBlockKind, SuggestRefusal } from './suggest-draft.ts';

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
