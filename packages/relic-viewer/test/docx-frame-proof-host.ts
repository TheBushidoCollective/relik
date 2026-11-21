import { createLinkConfirmBar } from '../src/link-confirm-bar.ts';
import {
  describeLinkRequest,
  LinkConfirmGate,
} from '../src/open-link-confirm.ts';

const frame = document.querySelector('iframe')!;
const bar = createLinkConfirmBar(new LinkConfirmGate(), () => {});
document.body.prepend(bar.element);
window.addEventListener('message', (event) => {
  if (
    event.source !== frame.contentWindow ||
    event.data?.type !== 'relic:open-link'
  )
    return;
  const destination = describeLinkRequest(event.data.href);
  if (destination) bar.request(destination);
});
document.documentElement.setAttribute('data-proof-host-ready', '');
