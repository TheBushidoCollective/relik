/**
 * Hands a chosen or dropped file to the publisher.
 *
 * The publisher is a lazy chunk, so a visitor who never publishes never
 * downloads it. The viewer and the homepage both come through here, so there is
 * one place that decides what happens when that chunk cannot be fetched.
 */

import type { DroppedFiles } from './drop-anywhere.ts';

export function openPublisher(dropped: DroppedFiles): void {
  void import('./publish-view.ts')
    .then((view) => view.openPublishDialog(dropped.files, dropped.isFolder))
    .catch((error: unknown) => {
      // Offline, or a deploy replaced the chunk under an open tab. The visitor
      // is left on the page they were on with nothing published.
      console.error('the publisher could not be loaded', error);
    });
}
