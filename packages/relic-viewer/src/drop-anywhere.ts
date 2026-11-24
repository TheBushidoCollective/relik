/**
 * Makes the whole window a place to drop a file and start a new relic.
 *
 * This is the one piece of the publish feature that is not lazy: something has
 * to be listening before the first drag, and it is a few listeners and no
 * markup. Everything that publishes loads only after a file is actually
 * dropped.
 *
 * Three things here are about not breaking the page:
 *
 * - **Only a drag that carries files is touched.** A text selection dragged
 *   inside a comment, or a divider being dragged, has no `Files` type and goes
 *   by untouched.
 * - **A file dropped anywhere is caught.** Left alone, a browser answers a
 *   dropped file by navigating the tab to it, which throws away whatever the
 *   reader had open, so the drop is cancelled at the window even when the
 *   curtain below never appeared.
 * - **A sandboxed frame is asked, not assumed.** A drag over the frame goes to
 *   the frame and never reaches this page, so the shim reports a file drag the
 *   relic did not claim (`frame-file-drag.ts`) and the curtain goes up over the
 *   frame then. A relic that handles file drops itself keeps them.
 */

import { isFileDrag } from './file-drag.ts';
import { isFrameFileDragMessage } from './frame-file-drag.ts';

export interface DroppedFiles {
  readonly files: File[];
  readonly isFolder: boolean;
  readonly entries: FileSystemEntry[];
}

/**
 * What a drop carried. A folder arrives as a `File` that cannot be read, so it
 * is recognised from the entry, which exists only for the length of the drop
 * event and has to be read synchronously.
 */
export function droppedFrom(transfer: DataTransfer): DroppedFiles {
  const entries = [...(transfer.items ?? [])]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => entry != null);
  return {
    files: [...transfer.files],
    isFolder: entries.some((entry) => entry.isDirectory),
    entries,
  };
}

/** How long a curtain outlives the last sign of a drag, in case the drag was cancelled. */
const CURTAIN_WATCHDOG_MS = 1500;

/**
 * How long the page ignores a frame's reports after one that came to nothing.
 *
 * A curtain the frame raised and no drag ever reached is a frame crying wolf,
 * by script or by accident, and a curtain that swallows clicks is worth more
 * than the next report.
 */
const FALSE_ALARM_QUIET_MS = 10_000;

function buildCurtain(): HTMLElement {
  const curtain = document.createElement('div');
  curtain.setAttribute('aria-hidden', 'true');
  curtain.dataset['fileCurtain'] = '';
  Object.assign(curtain.style, {
    position: 'fixed',
    inset: '0',
    // Above the viewer's own chrome, and above the sandboxed frame, which
    // would otherwise take the drag for itself and never tell this page.
    zIndex: '2147483000',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    boxSizing: 'border-box',
    border: '3px dashed var(--patina)',
    background: 'color-mix(in srgb, var(--ground) 88%, transparent)',
    color: 'var(--ink)',
    fontFamily: 'var(--serif)',
    textAlign: 'center',
  });
  const title = document.createElement('div');
  title.textContent = 'Drop to publish as a new relik';
  Object.assign(title.style, { fontSize: '1.6rem', fontWeight: '600' });
  const note = document.createElement('div');
  note.textContent = 'A file or folder. Review it before anything is sent.';
  Object.assign(note.style, {
    fontFamily: 'var(--sans)',
    fontSize: '0.95rem',
    color: 'var(--ink-soft)',
  });
  curtain.append(title, note);
  return curtain;
}

export function armFileDrop(open: (dropped: DroppedFiles) => void): void {
  let curtain: HTMLElement | undefined;
  let watchdog: number | undefined;
  /** Whether a drag has actually reached the curtain since it went up. */
  let dragSeen = false;
  let lastFalseAlarm = Number.NEGATIVE_INFINITY;

  const lower = (): void => {
    if (watchdog !== undefined) window.clearTimeout(watchdog);
    watchdog = undefined;
    curtain?.remove();
    curtain = undefined;
  };

  const keepRaised = (): void => {
    if (watchdog !== undefined) window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      if (!dragSeen) lastFalseAlarm = Date.now();
      lower();
    }, CURTAIN_WATCHDOG_MS);
  };

  const raise = (): void => {
    // A publish dialog is already on screen: the drop is still caught below,
    // but a second curtain over it would hide what it says.
    if (document.querySelector('dialog.pub-dialog') !== null) return;
    if (curtain === undefined) {
      curtain = buildCurtain();
      dragSeen = false;
      document.body.appendChild(curtain);
    }
    keepRaised();
  };

  window.addEventListener(
    'dragenter',
    (event) => {
      if (isFileDrag(event.dataTransfer?.types)) raise();
    },
    true
  );

  window.addEventListener(
    'dragover',
    (event) => {
      if (!isFileDrag(event.dataTransfer?.types)) return;
      // Without this the drop is not offered to the page at all.
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
      if (curtain !== undefined) {
        dragSeen = true;
        keepRaised();
      }
    },
    true
  );

  window.addEventListener(
    'dragleave',
    (event) => {
      // `relatedTarget` is null when the pointer leaves the window rather than
      // crossing into another element, which is the only leave that matters.
      if (event.relatedTarget === null) lower();
    },
    true
  );

  window.addEventListener(
    'drop',
    (event) => {
      if (!isFileDrag(event.dataTransfer?.types)) return;
      event.preventDefault();
      lower();
      if (event.dataTransfer === null) return;
      if (document.querySelector('dialog.pub-dialog') !== null) return;
      open(droppedFrom(event.dataTransfer));
    },
    true
  );

  window.addEventListener('message', (event) => {
    if (!isFrameFileDragMessage(event.data)) return;
    // Only the render frame this page holds, and not on a streak of reports
    // that never turned into a drag.
    const fromOwnFrame = [...document.querySelectorAll('iframe')].some(
      (frame) => frame.contentWindow === event.source
    );
    if (!fromOwnFrame) return;
    if (Date.now() - lastFalseAlarm < FALSE_ALARM_QUIET_MS) return;
    raise();
  });
}
