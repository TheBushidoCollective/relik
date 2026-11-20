import type { FolderRelic } from './folder-relic.ts';

export function folderEntryList(
  folder: FolderRelic,
  open: (index: number) => void
): HTMLElement {
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Files');
  const list = document.createElement('ul');
  folder.manifest.entries.forEach((entry, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.path;
    if (index === folder.index) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => open(index));
    item.appendChild(button);
    list.appendChild(item);
  });
  nav.appendChild(list);
  return nav;
}
