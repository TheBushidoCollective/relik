import type {
  DocumentInput,
  DocumentOutcome,
} from './frame-document-protocol.ts';

export async function render(
  root: HTMLElement,
  _input: DocumentInput
): Promise<DocumentOutcome> {
  root.textContent = 'EPUB document renderer is not available yet.';
  return { state: 'failed', reason: 'unsupported' };
}
