import { normalizeEmail } from '@relic/format';
import { encodeBase64url, SIGN_CONSENT_ID } from '@relic/format/private';
import { contentMac, layoutCiphertextSha256, sealSigningLayout, type SigningBox } from '@relic/format/signing';
import type { RelicContent } from '../content.ts';
import { nowMs } from '../private/keys.ts';
import { privateKeysOf } from '../private/ops.ts';
import type { ViewerDeps } from '../viewer.ts';
import { signingApi, signingContent } from './api.ts';
import { mountSigningBoxes } from './boxes.ts';

/** Owner-only composer. Private signer identities come from the owner's verified grants. */
export function openSigningComposer(input: {
  readonly deps: ViewerDeps;
  readonly relicId: string;
  readonly version: number;
  readonly digest: string;
  readonly content: RelicContent;
  readonly signingKey: Uint8Array;
  readonly private: boolean;
  readonly grants: readonly { email: string; identityId: string }[];
  readonly pdf: boolean;
  readonly stage: HTMLElement;
  readonly shareUrl: string;
  readonly onSent: () => void;
}): HTMLElement {
  const panel = document.createElement('aside');
  panel.className = 'access-panel signing-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Request signatures');
  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Request signatures';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close signing');
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'panel-body';
  const lead = document.createElement('p');
  lead.className = 'panel-lead';
  lead.textContent = 'Pick a signer, then drag on a page to place their box. A signer with no boxes signs in a block after the document.';
  const list = document.createElement('div');
  list.className = 'panel-section';
  const listTitle = document.createElement('h3');
  listTitle.textContent = 'Signers';
  const rows = document.createElement('div');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn small';
  add.textContent = 'Add signer';
  list.append(listTitle, rows, add);
  const orderSection = document.createElement('section');
  orderSection.className = 'panel-section';
  const orderTitle = document.createElement('h3');
  orderTitle.textContent = 'Order';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Signing order');
  for (const [value, text] of [['parallel', 'Any order'], ['sequential', 'In order']]) {
    const option = document.createElement('option');
    option.value = value!;
    option.textContent = text!;
    select.appendChild(option);
  }
  orderSection.append(orderTitle, select);
  const openedLabel = document.createElement('label');
  const opened = document.createElement('input');
  opened.type = 'checkbox';
  openedLabel.append(opened, ' Require opened');
  openedLabel.hidden = !input.private;
  const keyboard = document.createElement('button');
  keyboard.type = 'button';
  keyboard.className = 'btn small';
  keyboard.textContent = 'Add box on this page';
  keyboard.hidden = !input.pdf;
  const notice = document.createElement('p');
  notice.className = 'panel-notice';
  notice.setAttribute('role', 'status');
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'btn primary';
  send.textContent = 'Review and send';
  body.append(lead, list, orderSection, openedLabel, keyboard, notice, send);
  panel.append(head, body);
  let boxes: readonly SigningBox[] = [];
  let current = 0;
  const emails: HTMLInputElement[] = [];
  const dispose = input.pdf ? mountSigningBoxes({
    stage: input.stage,
    boxes: () => boxes,
    signer: () => current,
    editable: true,
    onChange: (next) => { boxes = next; },
  }) : () => {};
  function appendSigner(): void {
    if (emails.length >= 20) return;
    const index = emails.length;
    const row = document.createElement('label');
    row.className = 'signer-row';
    row.append(`Signer ${index + 1} `);
    const email = document.createElement('input');
    email.type = 'email';
    email.className = 'input';
    email.setAttribute('aria-label', `Signer ${index + 1} email`);
    email.addEventListener('focus', () => { current = index; });
    emails.push(email);
    row.appendChild(email);
    rows.appendChild(row);
  }
  add.addEventListener('click', appendSigner);
  keyboard.addEventListener('click', () => {
    const canvas = input.stage.querySelector<HTMLCanvasElement>('canvas.relic-page');
    if (!canvas || boxes.filter((box) => box.signer === current).length >= 20) return;
    boxes = [...boxes, { signer: current, page: Number(canvas.dataset['pageNumber']), rect: { x: 0.1, y: 0.7, w: 0.3, h: 0.06 } }];
    input.stage.dispatchEvent(new Event('relic:page-changed'));
  });
  close.addEventListener('click', () => { dispose(); panel.remove(); });
  send.addEventListener('click', () => {
    const names = emails.map((field) => normalizeEmail(field.value));
    if (names.length === 0 || names.some((email) => !email.includes('@')) || new Set(names).size !== names.length) {
      notice.textContent = 'Enter a different email address for each signer.';
      return;
    }
    const signers = names.map((email) => ({
      email,
      identity_id: input.private ? input.grants.find((grant) => normalizeEmail(grant.email) === email)?.identityId ?? null : null,
    }));
    if (input.private && signers.some((signer) => signer.identity_id === null)) {
      notice.textContent = 'A signer cannot open this relik yet. Grant access first.';
      return;
    }
    notice.textContent = "Each signer confirms with a passkey on their own device. Relik records which passkey approved which version, and when. It doesn't verify anyone's identity.";
    if (send.dataset['confirmed'] !== 'true') {
      send.dataset['confirmed'] = 'true';
      send.textContent = 'Send with passkey';
      return;
    }
    send.disabled = true;
    void (async () => {
      const requestId = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const layout = await sealSigningLayout({ signingKey: input.signingKey, relicId: input.relicId, version: input.version, layout: { v: 1, boxes }, signerCount: signers.length, pdf: input.pdf });
      const mac = await contentMac(input.signingKey, signingContent(input.content));
      const tapped = await privateKeysOf(input.deps).attest(input.deps, {
        purpose: 'signing_request', relicId: input.relicId,
        build: (identityId) => [{ kind: 'signing_request', statement: {
          at: nowMs(input.deps), ciphertext_sha256: input.digest, consent: SIGN_CONSENT_ID,
          content_mac: mac, layout_sha256: layoutCiphertextSha256(layout), order: select.value,
          owner_identity_id: identityId, relic_id: input.relicId, request_id: requestId,
          require_opened: input.private && opened.checked, signer_id: identityId, signers, version: input.version,
        } }],
      });
      await signingApi(input.deps, input.relicId).request(tapped.bundle, layout);
      dispose();
      body.replaceChildren();
      const result = document.createElement('p');
      result.className = 'panel-notice';
      result.textContent = input.private ? `Relik emailed ${signers.length === 1 ? 'the signer' : 'the signers'}.` : 'The link carries the key. Relik never sees it.';
      body.appendChild(result);
      if (!input.private) for (const signer of signers) {
        const message = `Please sign version ${input.version}. Open this link and sign in with ${signer.email}: ${input.shareUrl}`;
        const item = document.createElement('p');
        item.textContent = signer.email;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => void navigator.clipboard.writeText(message));
        const mail = document.createElement('a');
        mail.textContent = 'Email draft';
        mail.href = `mailto:${encodeURIComponent(signer.email)}?subject=${encodeURIComponent('Please sign')}&body=${encodeURIComponent(message)}`;
        item.append(copy, mail);
        body.appendChild(item);
      }
      input.onSent();
    })().catch((error: unknown) => {
      notice.textContent = error instanceof Error ? error.message : 'Could not send the request.';
      send.disabled = false;
    });
  });
  appendSigner();
  document.body.appendChild(panel);
  return panel;
}
