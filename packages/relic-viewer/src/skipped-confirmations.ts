import {
  type ConfirmKind,
  type ConfirmPref,
  type ConfirmPrefs,
} from './confirm-prefs.ts';
import { watchConfirmPrefs } from './confirmation-ui.ts';

const ORDER: readonly ConfirmKind[] = ['link', 'large-open', 'delete-comment'];
const NAMES: Record<ConfirmKind, string> = {
  link: 'Links',
  'large-open': 'Large file open',
  'delete-comment': 'Deleting my comments',
};
const DELETE_WARNING =
  'This removes only your comment. Replies will stay. Relik has no undo.';

function paragraph(className: string, text: string): HTMLParagraphElement {
  const item = document.createElement('p');
  item.className = className;
  item.textContent = text;
  return item;
}

function skipIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M2 3.3 6.7 8 2 12.7l.7.7L8.1 8 2.7 2.6zm6 0L12.7 8 8 12.7l.7.7L14.1 8 8.7 2.6z'
  );
  svg.appendChild(path);
  return svg;
}

function button(label: string, className: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}

/** Attach one live set of controls to the current incarnation of the bar. */
export function installSkippedConfirmations(
  bar: HTMLElement,
  relicId: string,
  version: number,
  sizeLabel: string,
  prefs: ConfirmPrefs
): void {
  const actions = bar.querySelector<HTMLElement>('.actions');
  const moreWrap = bar.querySelector<HTMLElement>('.band-more-wrap');
  const more = bar.querySelector<HTMLButtonElement>('.action-more');
  const menu = bar.querySelector<HTMLElement>('.band-more-list');
  if (!actions || !moreWrap || !more || !menu) return;

  const desktop = button('', 'action skipped-bar-action');
  desktop.setAttribute('aria-haspopup', 'dialog');
  desktop.setAttribute('aria-controls', 'skipped-confirmations');
  desktop.setAttribute('aria-expanded', 'false');
  const desktopLabel = document.createElement('span');
  desktopLabel.textContent = 'Skipped';
  const desktopCount = document.createElement('span');
  desktopCount.className = 'skipped-count';
  desktop.append(skipIcon(), desktopLabel, desktopCount);
  actions.insertBefore(desktop, moreWrap);

  const menuItem = button('', 'action skipped-menu-action');
  menuItem.setAttribute('aria-haspopup', 'dialog');
  const menuLabel = document.createElement('span');
  menuLabel.textContent = 'Skipped confirmations';
  const menuCount = document.createElement('span');
  menuCount.className = 'skipped-count';
  menuItem.append(skipIcon(), menuLabel, menuCount);
  menu.insertBefore(menuItem, menu.lastElementChild);

  let dialog: HTMLDialogElement | undefined;
  let title: HTMLElement | undefined;
  let list: HTMLUListElement | undefined;
  let intro: HTMLElement | undefined;
  let empty: HTMLElement | undefined;
  let status: HTMLElement | undefined;
  let opener: HTMLElement | undefined;

  const choices = (): ConfirmPref[] =>
    [...prefs.list(relicId)].sort((a, b) => {
      const order = ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind);
      return order || (a.version ?? 0) - (b.version ?? 0);
    });

  const update = (): void => {
    const selected = choices();
    const count = new Set(selected.map((choice) => choice.kind)).size;
    const activePanel = document.querySelector<HTMLDialogElement>(
      '.skipped-panel[open]'
    );
    desktop.hidden =
      count === 0 && dialog === undefined && activePanel === null;
    desktopCount.hidden = count === 0;
    desktopCount.textContent = String(count);
    desktop.setAttribute('aria-label', `Skipped confirmations, ${count}`);
    desktop.setAttribute(
      'aria-expanded',
      String(
        (dialog !== undefined && opener === desktop) ||
          activePanel?.dataset['openedFrom'] === 'desktop'
      )
    );
    menuCount.hidden = count === 0;
    menuCount.textContent = String(count);
    if (!dialog || !list || !intro || !empty) return;
    list.replaceChildren();
    selected.forEach((pref, index) => {
      const row = document.createElement('li');
      row.className = 'skipped-row';
      row.dataset.kind = pref.kind;
      if (pref.version !== undefined)
        row.dataset.version = String(pref.version);
      const text = document.createElement('div');
      text.className = 'skipped-row-text';
      const name = paragraph('skipped-name', NAMES[pref.kind]);
      name.id = `skipped-kind-${index}`;
      text.append(
        name,
        paragraph(
          'skipped-scope',
          pref.version === undefined
            ? 'This relic, every version'
            : `This relic and this version (version ${pref.version})`
        )
      );
      const description =
        pref.kind === 'link'
          ? 'Links you click in the relic open in a new tab without the bar.'
          : pref.kind === 'large-open'
            ? pref.version === version
              ? `This ${sizeLabel} file opens without asking first.`
              : 'This version opens without asking first.'
            : 'Your comments delete as soon as you press Delete. The question you turned off said:';
      text.appendChild(paragraph('skipped-description', description));
      if (pref.kind === 'delete-comment')
        text.appendChild(paragraph('skipped-warning', DELETE_WARNING));
      const ask = button('Ask again', 'skipped-ask');
      ask.setAttribute('aria-describedby', name.id);
      ask.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        prefs.forget(pref);
        if (status)
          status.textContent = `${NAMES[pref.kind]} will ask again.${prefs.list(relicId).length === 0 && opener === desktop ? ' Nothing else is skipped, so Skipped leaves the bar when this closes.' : ''}`;
        const remaining =
          list?.querySelectorAll<HTMLButtonElement>('.skipped-ask');
        (remaining?.[Math.min(index, remaining.length - 1)] ?? title)?.focus();
      });
      row.append(text, ask);
      list?.appendChild(row);
    });
    list.hidden = selected.length === 0;
    intro.hidden = selected.length === 0;
    empty.hidden = selected.length !== 0;
  };

  const open = (from: HTMLElement): void => {
    if (dialog !== undefined || document.querySelector('.skipped-panel[open]'))
      return;
    opener = from;
    const panel = document.createElement('dialog');
    dialog = panel;
    panel.className = 'share-panel skipped-panel';
    panel.dataset['openedFrom'] = from === desktop ? 'desktop' : 'more';
    const stopPanelUpdates = prefs.subscribe(() => update());
    panel.id = 'skipped-confirmations';
    panel.setAttribute('aria-labelledby', 'skipped-title');
    const head = document.createElement('div');
    head.className = 'share-head';
    title = document.createElement('h2');
    title.className = 'share-title';
    title.id = 'skipped-title';
    title.tabIndex = -1;
    title.textContent = 'Skipped confirmations';
    const close = button('×', 'share-close skipped-close');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => panel.close());
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'share-body skipped-body';
    intro = paragraph(
      'skipped-intro',
      'On this relic, the viewer no longer asks before these.'
    );
    list = document.createElement('ul');
    list.className = 'skipped-list';
    empty = paragraph(
      'skipped-empty',
      'Nothing skipped. The viewer asks before opening links, large files and deleting comments.'
    );
    status = paragraph('skipped-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    body.append(intro, list, empty, status);
    panel.append(head, body);
    panel.style.setProperty(
      '--share-top',
      `${bar.getBoundingClientRect().bottom}px`
    );
    panel.addEventListener('click', (event) => {
      if (event.target !== panel) return;
      const rect = panel.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        panel.close();
    });
    panel.addEventListener('close', () => {
      stopPanelUpdates();
      dialog = undefined;
      panel.remove();
      update();
      const currentButton = document.querySelector<HTMLButtonElement>(
        '.bar .skipped-bar-action'
      );
      if (currentButton) {
        currentButton.hidden = prefs.list(relicId).length === 0;
        currentButton.setAttribute('aria-expanded', 'false');
      }
      const target =
        from.isConnected && from.getClientRects().length > 0 && !from.hidden
          ? from
          : document.querySelector<HTMLElement>(
              from === desktop ? '.bar .action-report' : '.bar .action-more'
            );
      target?.focus({ preventScroll: true });
    });
    document.body.appendChild(panel);
    update();
    panel.showModal();
    title.focus();
  };

  desktop.addEventListener('click', () => open(desktop));
  menuItem.addEventListener('click', () => {
    more.click();
    open(more);
  });
  update();
  watchConfirmPrefs(bar, prefs, update);
}
