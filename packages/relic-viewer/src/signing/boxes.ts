import type { SigningBox } from '@relic/format/signing';
import { boxFromUnit, rectFromCorners, unitFromPointer } from '../anchoring.ts';

/** Refuse the whole request if any box names a page the PDF does not contain. */
export function signingPagesFit(
  boxes: readonly SigningBox[],
  pages: number
): boolean {
  return (
    Number.isInteger(pages) &&
    pages >= 1 &&
    boxes.every((box) => box.page <= pages)
  );
}

/** Paint boxes against the current PDF canvas, not against the scrolling stage. */
export function mountSigningBoxes(input: {
  readonly stage: HTMLElement;
  readonly boxes: () => readonly SigningBox[];
  readonly signer: () => number;
  readonly editable: boolean;
  readonly onChange: (boxes: readonly SigningBox[]) => void;
  readonly onSign?: () => void;
}): () => void {
  let overlay: HTMLElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let origin: { x: number; y: number } | undefined;
  let selected = -1;
  const host = input.stage;
  function page(): number {
    return Number(canvas?.dataset['pageNumber'] ?? 0);
  }
  function paint(): void {
    canvas =
      host.querySelector<HTMLCanvasElement>('canvas.relic-page') ?? undefined;
    if (!canvas?.parentElement) return;
    const parent = canvas.parentElement;
    if (overlay?.parentElement !== parent) {
      overlay?.remove();
      overlay = document.createElement('div');
      overlay.className = input.editable
        ? 'signing-box-overlay is-editable'
        : 'signing-box-overlay';
      parent.appendChild(overlay);
      overlay.addEventListener('pointerdown', start);
      overlay.addEventListener('pointerup', finish);
    }
    overlay.replaceChildren();
    for (const [index, box] of input.boxes().entries()) {
      if (box.page !== page()) continue;
      const position = boxFromUnit({ host: parent, content: canvas }, box.rect);
      if (!position) continue;
      const element = document.createElement('button');
      element.type = 'button';
      element.dataset['boxIndex'] = String(index);
      element.className = `signing-box signer-${box.signer % 4}${index === selected ? ' is-selected' : ''}`;
      element.style.left = `${position.left}px`;
      element.style.top = `${position.top}px`;
      element.style.width = `${position.width}px`;
      element.style.height = `${position.height}px`;
      element.textContent = `Signer ${box.signer + 1}`;
      element.setAttribute(
        'aria-label',
        `Signature box for signer ${box.signer + 1}, page ${box.page}`
      );
      element.addEventListener('pointerdown', (event) =>
        event.stopPropagation()
      );
      element.addEventListener('click', () => {
        if (input.editable) {
          selected = index;
          paint();
          overlay
            ?.querySelector<HTMLElement>(`[data-box-index="${index}"]`)
            ?.focus();
        } else if (box.signer === input.signer()) input.onSign?.();
      });
      element.addEventListener('keydown', (event) => {
        selected = index;
        if (!input.editable) return;
        const boxes = [...input.boxes()];
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          boxes.splice(index, 1);
          selected = -1;
        } else {
          const step = 0.005;
          const dx =
            event.key === 'ArrowLeft'
              ? -step
              : event.key === 'ArrowRight'
                ? step
                : 0;
          const dy =
            event.key === 'ArrowUp'
              ? -step
              : event.key === 'ArrowDown'
                ? step
                : 0;
          if (dx === 0 && dy === 0) return;
          event.preventDefault();
          const rect = { ...box.rect };
          if (event.shiftKey) {
            rect.w = Math.max(0.005, Math.min(1 - rect.x, rect.w + dx));
            rect.h = Math.max(0.005, Math.min(1 - rect.y, rect.h + dy));
          } else {
            rect.x = Math.max(0, Math.min(1 - rect.w, rect.x + dx));
            rect.y = Math.max(0, Math.min(1 - rect.h, rect.y + dy));
          }
          boxes[index] = { ...box, rect };
        }
        input.onChange(boxes);
        paint();
        if (selected !== -1) {
          overlay
            ?.querySelector<HTMLElement>(`[data-box-index="${index}"]`)
            ?.focus();
        }
      });
      overlay.appendChild(element);
    }
  }
  function start(event: PointerEvent): void {
    if (!input.editable || !canvas || !overlay) return;
    origin = unitFromPointer(
      { host: overlay, content: canvas },
      event.clientX,
      event.clientY
    );
    if (origin) overlay.setPointerCapture(event.pointerId);
  }
  function finish(event: PointerEvent): void {
    if (!origin || !canvas || !overlay) return;
    const end = unitFromPointer(
      { host: overlay, content: canvas },
      event.clientX,
      event.clientY
    );
    const rect = end && rectFromCorners(origin, end);
    origin = undefined;
    if (
      !rect ||
      input.boxes().filter((box) => box.signer === input.signer()).length >= 20
    )
      return;
    input.onChange([
      ...input.boxes(),
      { signer: input.signer(), page: page(), rect },
    ]);
    paint();
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !overlay?.contains(record.target))) paint();
  });
  observer.observe(host, { childList: true, subtree: true });
  host.addEventListener('relic:page-changed', paint);
  const resize = new ResizeObserver(paint);
  resize.observe(host);
  paint();
  return () => {
    observer.disconnect();
    resize.disconnect();
    host.removeEventListener('relic:page-changed', paint);
    overlay?.remove();
  };
}
