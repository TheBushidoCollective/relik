import {
  type ConfirmPref,
  type ConfirmPrefs,
  readerConfirmed,
} from './confirm-prefs.ts';

/** Stop listening when the part of the viewer that owns the control is removed. */
export function watchConfirmPrefs(
  owner: HTMLElement,
  prefs: ConfirmPrefs,
  update: () => void
): void {
  const stop = prefs.subscribe(update);
  if (typeof MutationObserver !== 'function' || !document.documentElement)
    return;
  let mounted = owner.isConnected;
  const observer = new MutationObserver(() => {
    if (owner.isConnected) mounted = true;
    else if (mounted) {
      stop();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/** Only a trusted click on this dialog's own confirmation button can save a choice. */
export function rememberControl(
  prefs: ConfirmPrefs,
  pref: ConfirmPref,
  confirm: HTMLButtonElement,
  text: string
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'confirm-remember';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  label.append(checkbox, document.createTextNode(text));
  confirm.addEventListener('click', (event) => {
    if (checkbox.checked) prefs.remember(readerConfirmed(event), pref);
  });
  return label;
}

/** The warning stays in the thread while comment deletion skips its question. */
export function deleteRememberedStrip(
  prefs: ConfirmPrefs,
  relicId: string,
  onAskAgain: () => void
): HTMLElement {
  const strip = document.createElement('p');
  strip.className = 'confirm-delete-strip';
  const text = document.createElement('span');
  text.textContent =
    'Your comments on this relik delete without asking. Relik has no undo.';
  const ask = document.createElement('button');
  ask.type = 'button';
  ask.className = 'confirm-strip-ask';
  ask.textContent = 'Ask again';
  ask.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    prefs.forget({ kind: 'delete-comment', relicId });
    onAskAgain();
  });
  strip.append(text, ask);
  const update = (): void => {
    strip.hidden = !prefs.has('delete-comment', relicId);
  };
  update();
  watchConfirmPrefs(strip, prefs, update);
  return strip;
}
