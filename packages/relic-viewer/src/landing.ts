/**
 * The homepage's script, and its only one.
 *
 * The homepage is not the viewer, so it does not load the viewer. It loads this
 * entry, which arms the same file drop and the same Upload button and hands
 * their files to the same lazy publisher. It touches no key, no vault and no
 * relic.
 *
 * The homepage has its own stylesheet inline and none of the viewer's, so the
 * publisher's dialog brings a small base of the rules it borrows from the
 * viewer (`publish-base.css`). That sheet is added just before the dialog is,
 * so it sits ahead of the dialog's own in the cascade.
 */

import { armFileDrop, type DroppedFiles } from './drop-anywhere.ts';
import { openPublisher } from './publish-entry.ts';
import { armUploadButtons } from './upload-button.ts';

function addBaseStyles(): void {
  if (document.querySelector('link[data-publish-base]') !== null) return;
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = '/assets/publish-base.css';
  sheet.dataset['publishBase'] = '';
  document.head.appendChild(sheet);
}

function open(dropped: DroppedFiles): void {
  addBaseStyles();
  openPublisher(dropped);
}

armFileDrop(open);
armUploadButtons(open);
