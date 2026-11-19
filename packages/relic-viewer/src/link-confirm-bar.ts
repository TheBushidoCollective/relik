/**
 * The confirmation bar for a rendered frame's link request, in the viewer's own
 * chrome directly above the frame.
 *
 * The destination is written with textContent only, so markup in an address is
 * shown as text. Open link works only on a click the browser marks trusted, and
 * only after the gate's read delay. Cancel, Escape and the timeout close the
 * bar. The buttons use the popover's action classes, so the bar looks like the
 * rest of the viewer's chrome rather than adding a second set of controls.
 */

import {
  LINK_READ_DELAY_MS,
  LINK_TIMEOUT_MS,
  type LinkConfirmGate,
  type LinkDestination,
} from './open-link-confirm.ts';

export interface LinkConfirmBar {
  /** The bar element. Place it directly above the frame it belongs to. */
  readonly element: HTMLElement;
  /** A link request from the frame: show it, or count it as dropped. */
  request(destination: LinkDestination): void;
}

const READ_DELAY_STATUS = 'Open link becomes available after a moment.';

export function createLinkConfirmBar(
  gate: LinkConfirmGate,
  open: (href: string) => void
): LinkConfirmBar {
  const element = document.createElement('section');
  element.className = 'link-confirm';
  element.setAttribute('role', 'alertdialog');
  element.hidden = true;

  const title = document.createElement('p');
  title.className = 'link-confirm-title';
  title.id = `link-confirm-title-${crypto.randomUUID()}`;
  title.textContent = 'This page asks to open a link in a new tab.';
  element.setAttribute('aria-labelledby', title.id);

  const scheme = document.createElement('span');
  scheme.className = 'scheme';
  const host = document.createElement('span');
  host.className = 'host';
  const rest = document.createElement('span');
  rest.className = 'rest';
  const destination = document.createElement('p');
  destination.className = 'link-confirm-dest';
  destination.append(scheme, host, rest);

  const note = document.createElement('p');
  note.className = 'link-confirm-note';
  note.textContent =
    'The new tab gets no link to this page. Check the address before you open it.';

  const status = document.createElement('p');
  status.className = 'link-confirm-status';
  status.setAttribute('aria-live', 'polite');

  const text = document.createElement('div');
  text.className = 'link-confirm-text';
  text.append(title, destination, note, status);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'popover-action is-quiet';
  cancel.textContent = 'Cancel';

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'popover-action is-primary';
  openButton.textContent = 'Open link';
  openButton.disabled = true;

  const actions = document.createElement('div');
  actions.className = 'link-confirm-actions';
  actions.append(cancel, openButton);
  element.append(text, actions);

  let readTimer = 0;
  let expireTimer = 0;

  const hideBar = (): void => {
    window.clearTimeout(readTimer);
    window.clearTimeout(expireTimer);
    element.hidden = true;
    document.removeEventListener('keydown', onKey);
  };

  const close = (): void => {
    gate.dismiss();
    hideBar();
  };

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  const renderDropped = (dropped: number): void => {
    if (dropped === 1) {
      status.textContent =
        '1 more link request was ignored while this one is open.';
    } else {
      status.textContent = `${dropped} more link requests were ignored while this one is open.`;
    }
  };

  cancel.addEventListener('click', close);
  openButton.addEventListener('click', (event) => {
    // A script cannot make this click. Only the reader's own click is trusted.
    if (!event.isTrusted) return;
    const confirmed = gate.confirm();
    hideBar();
    if (confirmed !== undefined) open(confirmed.href);
  });

  return {
    element,
    request(next: LinkDestination): void {
      const outcome = gate.request(next);
      if (outcome.kind === 'dropped') {
        renderDropped(outcome.dropped);
        return;
      }
      scheme.textContent = next.scheme;
      host.textContent = next.host;
      rest.textContent = next.rest;
      openButton.disabled = true;
      status.textContent = READ_DELAY_STATUS;
      element.hidden = false;
      document.addEventListener('keydown', onKey);
      window.clearTimeout(readTimer);
      window.clearTimeout(expireTimer);
      readTimer = window.setTimeout(() => {
        openButton.disabled = false;
        status.textContent = '';
      }, LINK_READ_DELAY_MS);
      expireTimer = window.setTimeout(() => {
        if (gate.expire()) hideBar();
      }, LINK_TIMEOUT_MS);
    },
  };
}
