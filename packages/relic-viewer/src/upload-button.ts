/**
 * The Upload action in the top right of every page, and what clicking it does.
 *
 * The button is a link to `/publish`, so it works with no script and with a
 * modified click (open in a new tab). When a script is present, a plain click
 * is taken over by one delegated handler, which asks the visitor for a file and
 * opens the same publisher a dropped file opens. Delegating is what lets every
 * bar be rebuilt, as the relic bar is whenever its counts change, without the
 * new copy needing wiring.
 *
 * Eager and small, like `drop-anywhere.ts`: the publisher itself is a lazy
 * chunk and loads only once a file has been chosen.
 */

import type { DroppedFiles } from './drop-anywhere.ts';

const UPLOAD_ICON =
  'M8 1.8l3.8 3.8-.7.7-2.6-2.6V11h-1V3.7L4.9 6.3l-.7-.7L8 1.8zM2 12h12v1H2v-1z';

export const UPLOAD_LABEL = 'Upload';
export const UPLOAD_TITLE = 'Publish a file as a new relic';

/** The attribute that marks an element as the Upload action. */
const UPLOAD_ATTRIBUTE = 'data-upload';

/** The Upload action, as a bar draws it: an icon and a label that narrow widths can hide. */
export function uploadLink(): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'action action-upload';
  link.href = '/publish';
  link.setAttribute(UPLOAD_ATTRIBUTE, '');
  link.setAttribute('aria-label', 'Upload a file');
  link.title = UPLOAD_TITLE;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', UPLOAD_ICON);
  svg.appendChild(path);

  const text = document.createElement('span');
  text.textContent = UPLOAD_LABEL;
  link.appendChild(svg);
  link.appendChild(text);
  return link;
}

/**
 * Puts the Upload action last in a bar's actions, making the row if the bar has
 * none. Safe to call on a bar that already has it, which is the case for the
 * loading bar the server draws before any script runs.
 */
export function ensureUploadButton(bar: HTMLElement): void {
  if (bar.querySelector(`[${UPLOAD_ATTRIBUTE}]`) !== null) return;
  let actions = bar.querySelector<HTMLElement>('.actions');
  if (actions === null) {
    actions = document.createElement('div');
    actions.className = 'actions';
    bar.appendChild(actions);
  }
  actions.appendChild(uploadLink());
}

/**
 * Whether a click is the plain one that means "choose a file here". A click
 * with a modifier, or a middle click, is the visitor asking for the page, and
 * gets the link it is.
 */
export function isPlainClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Asks the visitor for one file, and hands it over if they pick one. */
export function pickFile(open: (dropped: DroppedFiles) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  const remove = (): void => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    remove();
    // A folder cannot be chosen through this input, so nothing here is one.
    if (file !== undefined) open({ files: [file], isFolder: false });
  });
  input.addEventListener('cancel', remove);
  // In the document, because some browsers will not open a chooser for an
  // input that is not.
  document.body.appendChild(input);
  input.click();
}

export function armUploadButtons(open: (dropped: DroppedFiles) => void): void {
  document.addEventListener('click', (event) => {
    if (!isPlainClick(event)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(`[${UPLOAD_ATTRIBUTE}]`) === null) return;
    event.preventDefault();
    pickFile(open);
  });
}
