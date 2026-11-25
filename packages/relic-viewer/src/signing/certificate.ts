import { encodeBase64url } from '@relic/format/private';
import { verifySigningCertificate } from '@relic/format/signing';
import type { RelicContent } from '../content.ts';
import type { ViewerDeps } from '../viewer.ts';
import { signingApi, signingContent } from './api.ts';

export async function openSigningCertificate(input: {
  readonly deps: ViewerDeps;
  readonly relicId: string;
  readonly requestId: string;
  readonly signingKey: Uint8Array;
  readonly content: RelicContent;
  readonly trustedOwnerIdentityId?: string;
  readonly shareProof?: string;
}): Promise<HTMLElement> {
  const cert = await signingApi(input.deps, input.relicId, input.shareProof).certificate(input.requestId);
  const report = await verifySigningCertificate(cert, {
    signingKey: input.signingKey,
    content: signingContent(input.content),
    expectedOrigin: input.deps.serviceOrigin,
    ...(input.trustedOwnerIdentityId === undefined ? {} : { trustedOwnerIdentityId: input.trustedOwnerIdentityId }),
  });
  const panel = document.createElement('aside');
  panel.className = 'access-panel signing-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Signing certificate');
  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Signing certificate';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close certificate');
  close.addEventListener('click', () => panel.remove());
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'panel-body';
  const result = document.createElement('p');
  result.className = 'panel-notice';
  result.textContent = report.valid ? 'Verified in this browser' : report.internal_consistency && report.trust.owner === 'unchecked' ? 'Signatures are internally consistent. The owner identity has not been independently checked.' : 'Certificate verification failed.';
  body.appendChild(result);
  for (const check of report.checks) {
    const row = document.createElement('p');
    row.textContent = `${check.ok ? 'Passed' : 'Failed'}: ${check.id}${check.detail ? ` (${check.detail})` : ''}`;
    body.appendChild(row);
  }
  const explanation = document.createElement('p');
  explanation.className = 'panel-lead';
  explanation.textContent = report.valid
    ? "Proves: each listed passkey approved this exact version after agreeing to sign electronically, and the request came from the owner shown. Doesn't prove: who held the passkey, that the person is who the address suggests, or that the signature is legally binding. On a public relik a passkey is trusted from its first use with that address. Times come from each signer's device, checked by Relik to within 5 minutes."
    : "This certificate does not establish a trusted owner's identity. Relik doesn't verify identity or say whether an electronic signature is legally binding.";
  body.appendChild(explanation);
  if (report.owner) {
    const owner = document.createElement('p');
    owner.textContent = `Owner: ${report.owner.email} (claimed), ${report.owner.fingerprint}`;
    body.appendChild(owner);
  }
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn';
  download.textContent = 'Download certificate';
  download.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ ...cert, signing_key: encodeBase64url(input.signingKey) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `relik-${input.relicId}-v${cert.version}-signing.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  body.appendChild(download);
  panel.append(head, body);
  document.body.appendChild(panel);
  return panel;
}
