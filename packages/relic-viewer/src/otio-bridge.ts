import type {
  OtioAnchorResolution,
  OtioAnchorV1,
  OtioDocumentV1,
} from '@relic/format';

/** Type-only boundary: the eager shell never imports the OTIO parser/player. */
export interface OtioUiController {
  readonly document: OtioDocumentV1;
  readonly revision: number;
  paint(anchor: OtioAnchorV1, commentId: string): boolean;
  reveal(anchor: OtioAnchorV1, commentId?: string): void;
  clearMarks(): void;
  project(
    anchor: OtioAnchorV1,
    originalContent: Uint8Array
  ): Promise<OtioAnchorResolution>;
  projection(anchor: OtioAnchorV1): OtioAnchorResolution | undefined;
  dispose(): void;
}

export interface OtioAimDetail {
  readonly anchor: OtioAnchorV1;
  readonly focus?: boolean;
  readonly measure?: () => DOMRect | undefined;
  readonly measureBounds?: () => DOMRect | undefined;
}

const controllers = new WeakMap<HTMLElement, OtioUiController>();

export function attachOtioController(
  root: HTMLElement,
  controller: OtioUiController
): void {
  controllers.set(root, controller);
}

export function otioControllerFor(
  host: HTMLElement
): OtioUiController | undefined {
  const root = host.matches?.('.otio-view')
    ? host
    : host.querySelector?.<HTMLElement>('.otio-view');
  return root == null ? undefined : controllers.get(root);
}

export function disposeOtioViews(host: HTMLElement): void {
  if (host.matches?.('.otio-view')) controllers.get(host)?.dispose();
  for (const root of host.querySelectorAll?.<HTMLElement>('.otio-view') ?? []) {
    controllers.get(root)?.dispose();
    controllers.delete(root);
    root.dataset['disposed'] = 'true';
  }
}
