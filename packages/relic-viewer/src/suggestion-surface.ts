import type { SourceSegment } from './markdown-source.ts';
import type { SuggestBlockKind, SuggestRefusal } from './suggest-draft.ts';
import type { SuggestController } from './suggest-controller.ts';

/** Source offsets and editable blocks owned by one currently drawn view. */
export interface SuggestionSurface {
  readonly root: HTMLElement;
  segments(source: string): readonly SourceSegment[];
  blockKind(block: number): SuggestBlockKind;
  editable(block: number): true | SuggestRefusal;
  /** Restrict inline painting and editing to compatible source ranges. */
  covers?(start: number, end: number, replacement?: string): boolean;
  /** Only paint resolved changes inside this transient source slice. */
  readonly clipPaint?: boolean;
  /** Reject selections in non-editable regions instead of snapping to a nearby segment. */
  acceptsSelection?(node: Node): true | SuggestRefusal;
  /** Convert visible insertion text to and from the source representation. */
  encode?(
    block: number,
    text: string,
    start: number,
    end: number
  ):
    | { readonly ok: true; readonly source: string }
    | { readonly ok: false; readonly refusal: SuggestRefusal };
  decode?(block: number, source: string): string;
  /** Decode an untouched span of original source when extending a draft. */
  decodeRange?(block: number, start: number, end: number): string;
  emptyAnchor?(
    block: number,
    position: number
  ):
    | {
        readonly start: number;
        readonly end: number;
        readonly mode: 'before' | 'after';
      }
    | undefined;
  repaint(): void;
}
/** Let an active editor preserve a deliberate view-owned DOM change. */
export function mutateSurfaceUI(root: HTMLElement, action: () => void): void {
  const event = new CustomEvent('relic:surface-ui-mutation', {
    cancelable: true,
    detail: action,
  });
  if (root.dispatchEvent(event)) action();
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
export function requestSurfaceSwap(
  root: HTMLElement,
  reason?: 'table-cell'
): boolean {
  return root.dispatchEvent(
    new CustomEvent('relic:before-structured-swap', {
      bubbles: true,
      cancelable: true,
      detail: reason,
    })
  );
}
