import type { SigningRequestJSON } from '@relic/format/signing';
import { nowMs } from '../private/keys.ts';
import { privateKeysOf } from '../private/ops.ts';
import type { ViewerDeps } from '../viewer.ts';
import { signingApi } from './api.ts';

export function openSigningStatus(input: {
  readonly deps: ViewerDeps;
  readonly relicId: string;
  readonly request: SigningRequestJSON;
  readonly private: boolean;
  readonly owner: boolean;
  readonly verifiedSignatures: ReadonlySet<number>;
  readonly signerIndex?: number;
  readonly onSignIn?: () => void;
  readonly onSign?: () => void;
  readonly onRequest?: () => void;
  readonly onCertificate: () => void;
  readonly onChanged: () => void;
}): HTMLElement {
  const panel = document.createElement('aside');
  panel.className = 'access-panel signing-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Signing');
  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Signing';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close signing');
  close.addEventListener('click', () => panel.remove());
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'panel-body';
  const lead = document.createElement('p');
  lead.className = 'panel-lead';
  lead.textContent = `${input.request.owner.identity.email} (claimed) asked ${input.request.signers.length} people to sign version ${input.request.version}.`;
  body.appendChild(lead);
  const me = input.request.signers.find(
    (signer) => signer.index === input.signerIndex
  );
  if (me?.status === 'waiting') {
    const preceding = input.request.signers.find(
      (signer) => signer.index < me.index && signer.status !== 'signed'
    );
    if (preceding) {
      const waiting = document.createElement('p');
      waiting.className = 'panel-notice';
      waiting.textContent = `Waiting for ${preceding.email} to sign first.`;
      body.appendChild(waiting);
    }
  } else if (
    me?.status === 'signed' &&
    input.verifiedSignatures.has(me.index)
  ) {
    const signed = document.createElement('p');
    signed.className = 'panel-notice';
    const count = input.verifiedSignatures.size;
    const at = me.signature?.statement['at'];
    const signedAt =
      typeof at === 'number' ? new Date(at).toISOString() : 'the recorded time';
    signed.textContent = `You signed at ${signedAt}. ${count} of ${input.request.signers.length} signed.`;
    body.appendChild(signed);
  }
  const list = document.createElement('ul');
  list.className = 'status-list';
  if (input.private && input.owner) {
    list.classList.add('receipt-list');
    const header = document.createElement('li');
    header.className = 'receipt-head';
    for (const label of ['Signer', 'Delivered', 'Opened', 'Signed']) {
      const cell = document.createElement('span');
      cell.textContent = label;
      header.appendChild(cell);
    }
    list.appendChild(header);
  }
  for (const signer of input.request.signers) {
    const row = document.createElement('li');
    const who = document.createElement('strong');
    who.textContent = signer.email;
    const status = document.createElement('span');
    status.textContent =
      signer.status === 'signed'
        ? input.verifiedSignatures.has(signer.index)
          ? 'Signed'
          : 'Signature unverified'
        : signer.status === 'waiting'
          ? 'Waiting'
          : signer.status === 'needs_access'
            ? 'Needs access'
            : 'Not yet';
    if (input.private && input.owner) {
      row.className = 'receipt-row';
      row.appendChild(who);
      const signedAt = input.verifiedSignatures.has(signer.index)
        ? signer.signature?.statement['at']
        : undefined;
      for (const value of [signer.served_at, signer.opened_at, signedAt]) {
        const cell = document.createElement('span');
        const date =
          typeof value === 'string' || typeof value === 'number'
            ? new Date(value)
            : undefined;
        cell.textContent =
          date && !Number.isNaN(date.valueOf())
            ? `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`
            : 'Not yet';
        row.appendChild(cell);
      }
    } else {
      row.append(who, status);
    }
    list.appendChild(row);
  }
  body.appendChild(list);
  if (input.private && input.owner) {
    const legend = document.createElement('p');
    legend.className = 'panel-meta';
    legend.textContent =
      "Delivered: Relik handed their passkey the key to this version (Relik's record), and only that passkey can open it. Opened: their browser opened and checked this version (signed by them). On a public relik there is no delivered record, only whether the page was opened by a signer.";
    body.appendChild(legend);
    const scope = document.createElement('p');
    scope.className = 'panel-meta';
    scope.textContent =
      'These receipt times are reported by the service. The opened receipt is independently checked when it accompanies a verified signature.';
    body.appendChild(scope);
  }
  const notice = document.createElement('p');
  notice.className = 'panel-notice';
  notice.setAttribute('role', 'status');
  body.appendChild(notice);
  if (input.onSignIn && input.request.status === 'open') {
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.className = 'btn primary';
    signIn.textContent = 'Sign in to sign';
    signIn.addEventListener('click', () => {
      panel.remove();
      input.onSignIn?.();
    });
    body.appendChild(signIn);
  }
  if (input.onRequest && input.request.status === 'cancelled') {
    const request = document.createElement('button');
    request.type = 'button';
    request.className = 'btn primary';
    request.textContent = 'Request signatures';
    request.addEventListener('click', () => {
      panel.remove();
      input.onRequest?.();
    });
    body.appendChild(request);
  }
  if (input.onSign && input.request.status === 'open') {
    const sign = document.createElement('button');
    sign.type = 'button';
    sign.className = 'btn primary';
    sign.textContent = 'Sign';
    sign.addEventListener('click', () => {
      panel.remove();
      input.onSign?.();
    });
    body.appendChild(sign);
  }
  if (input.request.status === 'complete') {
    const certificate = document.createElement('button');
    certificate.type = 'button';
    certificate.className = 'btn';
    certificate.textContent = 'View certificate';
    certificate.addEventListener('click', input.onCertificate);
    body.appendChild(certificate);
  }
  if (input.owner && input.request.status === 'open') {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', () => {
      if (cancel.dataset['confirm'] !== 'true') {
        cancel.dataset['confirm'] = 'true';
        cancel.textContent = 'Confirm cancellation';
        notice.textContent = 'Cancel this signing request?';
        return;
      }
      cancel.disabled = true;
      void privateKeysOf(input.deps)
        .attest(input.deps, {
          purpose: 'signing_cancel',
          relicId: input.relicId,
          build: (identityId) => [
            {
              kind: 'signing_cancel',
              statement: {
                at: nowMs(input.deps),
                owner_identity_id: identityId,
                relic_id: input.relicId,
                request_id: input.request.request_id,
                signer_id: identityId,
              },
            },
          ],
        })
        .then(({ bundle }) =>
          signingApi(input.deps, input.relicId).cancel(bundle)
        )
        .then(() => {
          panel.remove();
          input.onChanged();
        })
        .catch((error: unknown) => {
          notice.textContent =
            error instanceof Error
              ? error.message
              : 'Could not cancel the request.';
          cancel.disabled = false;
        });
    });
    body.appendChild(cancel);
  }
  panel.append(head, body);
  document.body.appendChild(panel);
  return panel;
}
