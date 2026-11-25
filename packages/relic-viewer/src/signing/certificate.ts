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
  const cert = await signingApi(
    input.deps,
    input.relicId,
    input.shareProof
  ).certificate(input.requestId);
  const report = await verifySigningCertificate(cert, {
    signingKey: input.signingKey,
    content: signingContent(input.content),
    expectedOrigin: input.deps.serviceOrigin,
    ...(input.trustedOwnerIdentityId === undefined
      ? {}
      : { trustedOwnerIdentityId: input.trustedOwnerIdentityId }),
  });
  const panel = document.createElement('div');
  panel.className = 'certificate-view';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Signing certificate');
  const head = document.createElement('header');
  head.className = 'certificate-bar';
  const title = document.createElement('strong');
  title.textContent = `relik-${input.relicId}-v${cert.version}-signing.json`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close certificate');
  close.addEventListener('click', () => panel.remove());
  head.append(title, close);
  const body = document.createElement('article');
  body.className = 'certificate-body';
  const heading = document.createElement('section');
  heading.className = 'certificate-heading';
  const caption = document.createElement('small');
  caption.textContent = `RELIC/SIGNING-CERTIFICATE/V1 · ${cert.access.toUpperCase()}`;
  const fileTitle = document.createElement('h2');
  fileTitle.textContent =
    cert.title === null
      ? `Version ${cert.version}`
      : `${cert.title} (service title)`;
  const result = document.createElement('p');
  result.className = 'certificate-result';
  result.textContent = report.valid
    ? 'Verified in this browser'
    : report.internal_consistency && report.trust.owner === 'unchecked'
      ? 'Signatures are internally consistent. The owner identity has not been independently checked.'
      : 'Certificate verification failed.';
  heading.append(caption, fileTitle, result);
  body.appendChild(heading);
  const facts = document.createElement('section');
  facts.className = 'certificate-facts';
  for (const [label, value] of [
    ['Relik', cert.relic_id],
    ['Version', String(cert.version)],
    ['Content digest', cert.ciphertext_sha256],
    ['Completed (service record)', cert.completed_at],
  ] as const) {
    const item = document.createElement('div');
    const name = document.createElement('small');
    name.textContent = label;
    const detail = document.createElement('span');
    detail.textContent = value;
    item.append(name, detail);
    facts.appendChild(item);
  }
  body.appendChild(facts);
  const explanation = document.createElement('section');
  explanation.className = 'certificate-explanation';
  const proves = document.createElement('div');
  const provesTitle = document.createElement('h3');
  provesTitle.textContent = 'What this proves';
  const provesText = document.createElement('p');
  provesText.textContent = report.valid
    ? 'Proves: each listed passkey approved this exact version after agreeing to sign electronically, and the request came from the owner shown.'
    : 'The signatures and request must be checked against a trusted owner identity before this certificate establishes who requested them.';
  proves.append(provesTitle, provesText);
  const limitations = document.createElement('div');
  const limitationsTitle = document.createElement('h3');
  limitationsTitle.textContent = "What this doesn't prove";
  const limitationsText = document.createElement('p');
  limitationsText.textContent =
    "Doesn't prove: who held the passkey, that the person is who the address suggests, or that the signature is legally binding. On a public relik a passkey is trusted from its first use with that address. Times come from each signer's device, checked by Relik to within 5 minutes.";
  limitations.append(limitationsTitle, limitationsText);
  explanation.append(proves, limitations);
  body.appendChild(explanation);
  const owner = document.createElement('section');
  owner.className = 'certificate-section';
  const ownerHeading = document.createElement('h3');
  ownerHeading.textContent = 'Requested by';
  const ownerText = document.createElement('p');
  ownerText.textContent = report.owner
    ? `${report.owner.email} (claimed) · ${report.owner.fingerprint}`
    : 'Owner could not be verified';
  owner.append(ownerHeading, ownerText);
  body.appendChild(owner);
  const signatures = document.createElement('section');
  signatures.className = 'certificate-section';
  const signaturesHeading = document.createElement('h3');
  signaturesHeading.textContent = 'Signatures';
  signatures.appendChild(signaturesHeading);
  for (const signer of report.signers) {
    const row = document.createElement('p');
    row.textContent = `${signer.email} · ${signer.name ?? 'Name unavailable'} · signed ${signer.signed_at === null ? 'unknown' : new Date(signer.signed_at).toISOString()} · recorded ${signer.recorded_at ?? 'unknown'} (service record)`;
    signatures.appendChild(row);
  }
  body.appendChild(signatures);
  const checks = document.createElement('section');
  checks.className = 'certificate-section';
  const checksTitle = document.createElement('h3');
  checksTitle.textContent = 'Checks';
  checks.appendChild(checksTitle);
  const grouped = new Map<string, Array<(typeof report.checks)[number]>>();
  for (const check of report.checks) {
    const group = grouped.get(check.id) ?? [];
    group.push(check);
    grouped.set(check.id, group);
  }
  for (const [id, group] of grouped) {
    const failed = group.find((check) => !check.ok);
    const row = document.createElement('p');
    row.textContent = `${failed ? 'Failed' : 'Passed'}: ${id}${group.length > 1 ? ` ×${group.length}` : ''}${failed?.detail ? ` (${failed.detail})` : ''}`;
    checks.appendChild(row);
  }
  body.appendChild(checks);
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'btn';
  download.textContent = 'Download certificate';
  download.disabled =
    !report.internal_consistency || report.content !== 'match';
  download.addEventListener('click', () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { ...cert, signing_key: encodeBase64url(input.signingKey) },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
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
