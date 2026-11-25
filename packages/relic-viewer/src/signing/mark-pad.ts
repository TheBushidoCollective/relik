import { SIGNING_MARK_MAX_POINTS, SIGNING_MARK_MAX_STROKES } from '@relic/format/signing';

/** Collect a drawn mark in normalized coordinates. The canvas is only a preview. */
export function createMarkPad(onChange: () => void): {
  readonly element: HTMLElement;
  readonly strokes: () => readonly (readonly number[])[];
  readonly clear: () => void;
} {
  const element = document.createElement('div');
  element.className = 'mark-pad';
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 240;
  canvas.setAttribute('aria-label', 'Draw your mark');
  element.appendChild(canvas);
  const strokes: number[][] = [];
  let active: number[] | undefined;
  let points = 0;
  const context = canvas.getContext('2d');
  function point(event: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const unit = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
    return [unit((event.clientX - rect.left) / rect.width), unit((event.clientY - rect.top) / rect.height)];
  }
  function append(event: PointerEvent): void {
    if (active === undefined || points >= SIGNING_MARK_MAX_POINTS) return;
    const [x, y] = point(event);
    const px = x * canvas.width;
    const py = y * canvas.height;
    if (context) {
      context.lineWidth = 3;
      context.lineCap = 'round';
      context.strokeStyle = 'currentColor';
      if (active.length === 0) {
        context.beginPath();
        context.moveTo(px, py);
      } else {
        context.lineTo(px, py);
        context.stroke();
      }
    }
    active.push(x, y);
    points++;
    onChange();
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (strokes.length >= SIGNING_MARK_MAX_STROKES) return;
    event.preventDefault();
    active = [];
    strokes.push(active);
    canvas.setPointerCapture(event.pointerId);
    append(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (active !== undefined) append(event);
  });
  const finish = () => { active = undefined; };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  return {
    element,
    strokes: () => strokes,
    clear: () => {
      strokes.length = 0;
      points = 0;
      active = undefined;
      context?.clearRect(0, 0, canvas.width, canvas.height);
      onChange();
    },
  };
}
