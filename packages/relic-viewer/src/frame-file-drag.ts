/**
 * Lets the page behind a sandboxed frame take a file dragged over it.
 *
 * The frame is a separate document on another origin, so a drag over it is
 * delivered to the frame and never to the page that holds it, and a relic that
 * fills the window leaves the page nowhere to see a file arrive. This runs in
 * the frame's shim and sends the page one message when a file is being dragged
 * over the frame and nothing in the frame wants it.
 *
 * Two rules keep it from taking what is not its to take:
 *
 * - **A relic that accepts the drag keeps it.** A page that handles file drops
 *   itself says so by cancelling `dragover`, and then nothing is sent, so a
 *   relic that is an image converter still gets its files. The check waits
 *   until the event has finished travelling, because the relic's own listeners
 *   run after the shim's.
 * - **Only the browser's own drags count.** A script in the frame can dispatch
 *   a `dragover` of its own, but cannot make it trusted, so it cannot use this
 *   to raise the page's drop curtain. It can still post the message by hand,
 *   which the page treats as the same low-trust frame message it treats every
 *   other and rate-limits.
 *
 * It lives apart from the page's handler so the sandbox bundle carries this and
 * nothing else of it.
 */

import { isFileDrag } from './file-drag.ts';

export const FRAME_FILE_DRAG_MESSAGE = 'relic:file-drag';

export function isFrameFileDragMessage(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === FRAME_FILE_DRAG_MESSAGE
  );
}

/** The part of a window this needs, so it can be driven without a browser. */
export interface DragSignalWindow {
  addEventListener(
    type: 'dragover' | 'dragleave' | 'drop',
    listener: (event: DragEvent) => void,
    capture: boolean
  ): void;
  readonly parent: {
    postMessage(message: unknown, targetOrigin: string): void;
  };
}

export function announceUnclaimedFileDrags(win: DragSignalWindow): void {
  let announced = false;

  win.addEventListener(
    'dragover',
    (event) => {
      if (announced || !event.isTrusted) return;
      if (!isFileDrag(event.dataTransfer?.types)) return;
      announced = true;
      // After the relic's own listeners have had their say.
      setTimeout(() => {
        if (event.defaultPrevented) return;
        // The frame is opaque, so no origin can name the page, as with every
        // other message the shim sends it.
        win.parent.postMessage({ type: FRAME_FILE_DRAG_MESSAGE }, '*');
      }, 0);
    },
    false
  );

  // One message per drag. The drag is over when it leaves the frame for good,
  // or when it lands.
  win.addEventListener(
    'dragleave',
    (event) => {
      if (event.relatedTarget === null) announced = false;
    },
    true
  );
  win.addEventListener(
    'drop',
    () => {
      announced = false;
    },
    true
  );
}
