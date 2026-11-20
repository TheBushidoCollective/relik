/**
 * The confirmation bar for a rendered frame's link request, in the viewer's own
 * chrome directly above the frame.
 *
 * The destination is written with textContent only, so markup in an address is
 * shown as text. Open link works only on a click the browser marks trusted, and
 * only after the gate's read delay. Cancel, Escape and the timeout close the bar.
 * The buttons use the popover's action classes, so the bar looks like the rest of
 * the viewer's chrome rather than adding a second set of controls.
 *
 * When the reader ticks "Don't ask again for this relic", the choice is recorded
 * only with a trusted click on Open, through the confirmation store. While the
 * choice stands for this relic and version, a request that follows a reader
 * gesture opens without the bar. The remembered choice is a strip above the frame,
 * which offers to turn the choice back on. The pending bar is an overlay only while
 * a request waits for confirmation. A frame message can raise the bar and can never
 * set or clear a choice.
 */

import { type ConfirmPrefs, readerConfirmed } from './confirm-prefs.ts';
import { watchConfirmPrefs } from './confirmation-ui.ts';
import {
  LINK_READ_DELAY_MS,
  LINK_TIMEOUT_MS,
  type LinkConfirmGate,
  type LinkDestination,
} from './open-link-confirm.ts';

export interface LinkConfirmBar {
  /** The bar. Place it directly above the frame it belongs to. Hidden when there is nothing to show. */
  readonly element: HTMLElement;
  /** The remembered-choice strip. Place it in the page flow above the frame, not over it. Hidden unless the choice stands. */
  readonly remembered: HTMLElement;
  /** A link request from the frame: show it, open it when remembered and gesture-driven, or count it as dropped. */
  request(destination: LinkDestination): void;
}

/** What the bar needs to remember a choice for one relic and version. */
export interface LinkRemember {
  readonly relicId: string;
  readonly version: number;
  readonly prefs: ConfirmPrefs;
  /** True only while the browser holds a transient user activation. */
  readonly activated: () => boolean;
}

const READ_DELAY_STATUS = 'Open link becomes available after a moment.';
const REMEMBER_LABEL = "Don't ask again for this relic";
const REMEMBERED_TEXT = 'Links from this relic open without asking.';
const TURN_BACK_ON = 'Turn back on';

export function createLinkConfirmBar(
  gate: LinkConfirmGate,
  open: (href: string) => void,
  remember?: LinkRemember
): LinkConfirmBar {
  const rem: LinkRemember | undefined = remember;

  const element = document.createElement('section');
  element.className = 'link-confirm';
  element.setAttribute('role', 'alertdialog');
  element.hidden = true;

  // The pending part: the request, its read delay, and its two buttons.
  const pending = document.createElement('div');
  pending.className = 'link-confirm-pending';
  pending.hidden = true;

  const title = document.createElement('p');
  title.className = 'link-confirm-title';
  title.id = `link-confirm-title-${crypto.randomUUID()}`;
  title.textContent = 'This page asks to open a link in a new tab.';
  element.setAttribute('aria-labelledby', title.id);

  const scheme = document.createElement('span');
  scheme.className = 'scheme';
  const hostName = document.createElement('span');
  hostName.className = 'host';
  const rest = document.createElement('span');
  rest.className = 'rest';
  const destination = document.createElement('p');
  destination.className = 'link-confirm-dest';
  destination.append(scheme, hostName, rest);

  const note = document.createElement('p');
  note.className = 'link-confirm-note';
  note.textContent =
    'The new tab gets no link to this page. Check the address before you open it.';

  const status = document.createElement('p');
  status.className = 'link-confirm-status';
  status.setAttribute('aria-live', 'polite');

  const text = document.createElement('div');
  text.className = 'link-confirm-text';
  text.append(title, destination, note);

  let rememberBox: HTMLInputElement | undefined;
  if (rem !== undefined) {
    const label = document.createElement('label');
    label.className = 'link-confirm-remember';
    rememberBox = document.createElement('input');
    rememberBox.type = 'checkbox';
    label.append(rememberBox, ` ${REMEMBER_LABEL}`);
    text.append(label);
  }
  text.append(status);

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
  pending.append(text, actions);

  // The remembered choice is a strip in the page flow above the frame, never an
  // overlay, so it cannot cover frame content. It shows only while the choice
  // stands for this relic and version.
  const strip = document.createElement('section');
  strip.className = 'link-confirm-strip';
  strip.hidden = true;
  const remembered = document.createElement('p');
  remembered.className = 'link-confirm-remembered';
  const rememberedNote = document.createElement('span');
  rememberedNote.textContent = REMEMBERED_TEXT;
  const turnBackOn = document.createElement('button');
  turnBackOn.type = 'button';
  turnBackOn.className = 'popover-action is-quiet';
  turnBackOn.textContent = TURN_BACK_ON;
  remembered.append(rememberedNote, turnBackOn);
  strip.append(remembered);

  element.append(pending);

  let readTimer = 0;
  let expireTimer = 0;

  const isRemembered = (): boolean =>
    rem !== undefined && rem.prefs.has('link', rem.relicId, rem.version);

  /** Idle state without touching timers or listeners, which is safe at creation. */
  const applyIdle = (): void => {
    pending.hidden = true;
    element.hidden = true;
    strip.hidden = !isRemembered();
  };

  /** Leaves the pending state: stops its timers and keys, then shows the idle state. */
  const showIdle = (): void => {
    window.clearTimeout(readTimer);
    window.clearTimeout(expireTimer);
    document.removeEventListener('keydown', onKey);
    applyIdle();
  };

  const close = (): void => {
    gate.dismiss();
    showIdle();
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

  applyIdle();
  if (rem !== undefined)
    watchConfirmPrefs(strip, rem.prefs, () => {
      if (pending.hidden) applyIdle();
    });

  cancel.addEventListener('click', close);
  openButton.addEventListener('click', (event) => {
    // A script cannot make this click. Only the reader's own click is trusted.
    if (!event.isTrusted) return;
    const confirmed = gate.confirm();
    const proof = readerConfirmed(event);
    if (
      confirmed !== undefined &&
      rem !== undefined &&
      proof !== undefined &&
      rememberBox?.checked === true
    ) {
      rem.prefs.remember(proof, {
        kind: 'link',
        relicId: rem.relicId,
        version: rem.version,
      });
    }
    showIdle();
    if (confirmed !== undefined) open(confirmed.href);
  });
  turnBackOn.addEventListener('click', (event) => {
    if (!event.isTrusted || rem === undefined) return;
    rem.prefs.forget({
      kind: 'link',
      relicId: rem.relicId,
      version: rem.version,
    });
    applyIdle();
  });

  return {
    element,
    remembered: strip,
    request(next: LinkDestination): void {
      if (rem !== undefined && isRemembered() && rem.activated()) {
        // Remembered for this relic and version, and a reader gesture is active:
        // open without the bar, its read delay and its cooldown.
        open(next.href);
        return;
      }
      const outcome = gate.request(next);
      if (outcome.kind === 'dropped') {
        renderDropped(outcome.dropped);
        return;
      }
      scheme.textContent = next.scheme;
      hostName.textContent = next.host;
      rest.textContent = next.rest;
      openButton.disabled = true;
      status.textContent = READ_DELAY_STATUS;
      if (rememberBox !== undefined) rememberBox.checked = false;
      pending.hidden = false;
      strip.hidden = true;
      element.hidden = false;
      document.addEventListener('keydown', onKey);
      window.clearTimeout(readTimer);
      window.clearTimeout(expireTimer);
      readTimer = window.setTimeout(() => {
        openButton.disabled = false;
        status.textContent = '';
      }, LINK_READ_DELAY_MS);
      expireTimer = window.setTimeout(() => {
        if (gate.expire()) showIdle();
      }, LINK_TIMEOUT_MS);
    },
  };
}
