import {
  encodeBase64url,
  SIGN_CONSENT_ID,
  type SigningRequestStatement,
} from '@relic/format/private';
import {
  SIGN_CONSENT_TEXT,
  signingRequestSha256,
  type SigningRequestJSON,
} from '@relic/format/signing';
import { openSignerPanel } from '../src/signing/panel.ts';
import type { ViewerDeps } from '../src/viewer.ts';

export async function signerCases(): Promise<void> {
  const relicId = '7k2m9qxah3tb0p4dvw8cr1nezf';
  const requestId = encodeBase64url(new Uint8Array(16).fill(4));
  const statement: SigningRequestStatement = {
    at: Date.now(),
    ciphertext_sha256: 'a'.repeat(64),
    consent: SIGN_CONSENT_ID,
    content_mac: 'b'.repeat(64),
    layout_sha256: 'c'.repeat(64),
    order: 'parallel' as const,
    owner_identity_id: 'd'.repeat(64),
    relic_id: relicId,
    request_id: requestId,
    require_opened: false,
    signer_id: 'd'.repeat(64),
    signers: [{ email: 'ana@example.test', identity_id: null }],
    version: 1,
  };
  const request = { request: { statement } } as unknown as SigningRequestJSON;
  let badDigest = false;
  let insideClick = false;
  let calledSynchronously = false;
  const deps = {
    serviceOrigin: location.origin,
    credentials: {
      get: () => {
        calledSynchronously = insideClick;
        return Promise.resolve(null);
      },
    },
    fetch: async () =>
      Response.json({
        nonce: encodeBase64url(new Uint8Array(32)),
        expires_at: new Date(Date.now() + 300000).toISOString(),
        public_key: {
          rpId: location.hostname,
          timeout: 300000,
          userVerification: 'required',
          allowCredentials: [],
        },
        request_id: requestId,
        version: 1,
        version_digest: badDigest
          ? 'e'.repeat(64)
          : statement.ciphertext_sha256,
        content_mac: statement.content_mac,
        request_sha256: signingRequestSha256(statement),
        signer_index: 0,
        signer_identity_id: null,
        opened_receipt_sha256: null,
        consent: { id: SIGN_CONSENT_ID, text: SIGN_CONSENT_TEXT },
      }),
  } as unknown as ViewerDeps;
  const panel = openSignerPanel({
    deps,
    relicId,
    request,
    signerIndex: 0,
    signingKey: new Uint8Array(32),
    onSigned: () => {},
  });
  const name = panel.querySelector<HTMLInputElement>(
    'input[autocomplete="name"]'
  )!;
  const consent = panel.querySelector<HTMLInputElement>(
    'input[type="checkbox"]'
  )!;
  const button = panel.querySelector<HTMLButtonElement>('button.btn.primary')!;
  const status = panel.querySelector<HTMLElement>('[role="status"]')!;
  const untilStatus = (text: string): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (status.textContent === text) resolve();
    else {
      const observer = new MutationObserver(() => {
        if (status.textContent === text) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(status, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    return promise;
  };
  name.value = 'Ana Ruiz';
  name.dispatchEvent(new Event('input'));
  if (!button.disabled) throw new Error('Sign enabled without consent');
  consent.checked = true;
  consent.dispatchEvent(new Event('change'));
  await untilStatus('Your passkey confirms it.');
  if (button.disabled)
    throw new Error('Sign did not enable after valid preparation');
  insideClick = true;
  button.click();
  insideClick = false;
  if (!calledSynchronously)
    throw new Error('Passkey call did not start synchronously');
  badDigest = true;
  name.value = 'Ana R';
  name.dispatchEvent(new Event('input'));
  await untilStatus('The signing request changed. Reload this relik.');
  if (!button.disabled) throw new Error('A mismatched digest enabled Sign');
  panel.remove();
  let createCalledSynchronously = false;
  const noPasskeyDeps = {
    ...deps,
    credentials: {
      create: () => {
        createCalledSynchronously = insideClick;
        return Promise.resolve(null);
      },
    },
    fetch: async (url: string) => {
      if (url.endsWith('/api/auth/passkeys/options')) {
        return Response.json({
          mode: 'create',
          public_key: {
            challenge: encodeBase64url(new Uint8Array(32)),
            rp: { id: location.hostname, name: 'Relik' },
            user: {
              id: requestId,
              name: 'ana@example.test',
              displayName: 'Ana',
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          },
        });
      }
      return Response.json({ code: 'passkey_required' }, { status: 409 });
    },
  } as unknown as ViewerDeps;
  const setupPanel = openSignerPanel({
    deps: noPasskeyDeps,
    relicId,
    request,
    signerIndex: 0,
    signingKey: new Uint8Array(32),
    onSigned: () => {},
  });
  const setupName = setupPanel.querySelector<HTMLInputElement>(
    'input[autocomplete="name"]'
  )!;
  const setupConsent = setupPanel.querySelector<HTMLInputElement>(
    'input[type="checkbox"]'
  )!;
  const create = [
    ...setupPanel.querySelectorAll<HTMLButtonElement>('button'),
  ].find((entry) => entry.textContent === 'Create passkey')!;
  const ready = Promise.withResolvers<void>();
  const observer = new MutationObserver(() => {
    if (!create.hidden) {
      observer.disconnect();
      ready.resolve();
    }
  });
  observer.observe(create, { attributes: true, attributeFilter: ['hidden'] });
  setupName.value = 'Ana Ruiz';
  setupName.dispatchEvent(new Event('input'));
  setupConsent.checked = true;
  setupConsent.dispatchEvent(new Event('change'));
  await ready.promise;
  insideClick = true;
  create.click();
  insideClick = false;
  if (!createCalledSynchronously)
    throw new Error('Passkey creation did not start synchronously');
  setupPanel.remove();
}
