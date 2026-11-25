import type { CreationOptionsJSON, RequestOptionsJSON } from '@relic/format';
import {
  attestationChallenge,
  decodeBase64url,
  encodeBase64url,
  parseStatement,
  SIGN_CONSENT_ID,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import {
  markCiphertextSha256,
  sealSignatureMark,
  SIGN_CONSENT_TEXT,
  signingRequestSha256,
  type SigningLayout,
  type SigningRequestJSON,
} from '@relic/format/signing';
import {
  authenticationResponseToJSON,
  ceremonySignal,
  creationOptionsFromJSON,
  parseCreationOptions,
  parseRequestOptions,
  registrationResponseToJSON,
  requestOptionsFromJSON,
} from '../passkey-common.ts';
import {
  postJson,
  PrivateRequestError,
  type UnlockedIdentity,
} from '../private/keys.ts';
import type { ViewerDeps } from '../viewer.ts';
import { signingApi } from './api.ts';
import { createMarkPad } from './mark-pad.ts';

interface Prepared {
  readonly expiresAt: number;
  readonly publicKey: PublicKeyCredentialRequestOptions;
  readonly nonce: string;
  readonly statement: Record<string, unknown>;
  readonly identitySignature: string;
  readonly mark: string;
}

/** Open only after verifyViewerSigningRequest has accepted the request and file. */
export function openSignerPanel(input: {
  readonly deps: ViewerDeps;
  readonly relicId: string;
  readonly request: SigningRequestJSON;
  readonly signerIndex: number;
  readonly layout?: SigningLayout;
  readonly signedCount?: number;
  readonly signingKey: Uint8Array;
  readonly shareProof?: string;
  readonly identity?: UnlockedIdentity;
  readonly onSigned: () => void;
}): HTMLElement {
  const request = parseStatement(
    'signing_request',
    input.request.request.statement
  );
  if (request.signers[input.signerIndex] === undefined)
    throw new Error('not_a_signer');
  const signer = request.signers[input.signerIndex]!;
  const api = signingApi(input.deps, input.relicId, input.shareProof);
  const panel = document.createElement('aside');
  panel.className = 'access-panel signing-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Sign');
  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Sign';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.setAttribute('aria-label', 'Close signing');
  close.textContent = '×';
  close.addEventListener('click', () => panel.remove());
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'panel-body';
  const person = document.createElement('section');
  person.className = 'panel-section';
  const who = document.createElement('h3');
  who.textContent = `You ${signer.email}`;
  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = 'Your name';
  const name = document.createElement('input');
  name.className = 'input';
  name.maxLength = 128;
  name.autocomplete = 'name';
  label.appendChild(name);
  const markLabel = document.createElement('p');
  markLabel.className = 'field-label';
  markLabel.textContent = 'Mark';
  const tabs = document.createElement('div');
  tabs.className = 'seg';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Mark');
  const typed = document.createElement('button');
  typed.type = 'button';
  typed.textContent = 'Type';
  const drawn = document.createElement('button');
  drawn.type = 'button';
  drawn.textContent = 'Draw';
  tabs.append(typed, drawn);
  const preview = document.createElement('div');
  preview.className = 'typed-mark';
  const pad = createMarkPad(changed);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'link-button';
  clear.textContent = 'Clear';
  clear.addEventListener('click', pad.clear);
  person.append(who, label, markLabel, tabs, preview, pad.element, clear);
  const consentSection = document.createElement('section');
  consentSection.className = 'panel-section';
  const consentTitle = document.createElement('h3');
  consentTitle.textContent = 'Consent';
  const consentLabel = document.createElement('label');
  consentLabel.className = 'consent';
  const consent = document.createElement('input');
  consent.type = 'checkbox';
  const consentText = document.createElement('span');
  const consentLead = document.createElement('strong');
  consentLead.textContent = 'I agree to sign this document electronically.';
  const detail = document.createElement('span');
  detail.className = 'consent-detail';
  detail.textContent = `Your passkey approval is your signature on version ${request.version} of this file. It shows that a device holding your passkey for ${signer.email}, signed in to that address, approved this exact file at the time shown. Relik doesn't check who you are, and it doesn't say whether an electronic signature is legally binding where you are.`;
  consentText.append(consentLead, document.createElement('br'), detail);
  consentLabel.append(consent, consentText);
  consentSection.append(consentTitle, consentLabel);
  const row = document.createElement('div');
  row.className = 'sign-row';
  const sign = document.createElement('button');
  sign.type = 'button';
  sign.className = 'btn primary';
  sign.textContent = 'Sign';
  const passkey = document.createElement('button');
  passkey.type = 'button';
  passkey.className = 'btn';
  passkey.hidden = true;
  passkey.textContent = 'Create passkey';
  sign.disabled = true;
  const status = document.createElement('span');
  status.className = 'passkey-note';
  status.setAttribute('role', 'status');
  status.textContent = 'Tick the box above to sign.';
  row.append(sign, passkey, status);
  const summary = document.createElement('p');
  summary.className = 'signing-summary';
  const boxes =
    input.layout?.boxes.filter((box) => box.signer === input.signerIndex) ?? [];
  const pages = [...new Set(boxes.map((box) => box.page))].join(', ');
  summary.textContent = `${boxes.length ? `${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'}, pages ${pages}` : 'Signature block after the document'} · ${input.signedCount ?? 0} of ${request.signers.length} signed`;
  body.append(person, consentSection, row, summary);
  panel.append(head, body);
  let mode: 'typed' | 'drawn' = 'typed';
  let prepared: Prepared | undefined;
  let bootstrap:
    | { mode: 'create'; options: CreationOptionsJSON }
    | { mode: 'assert'; options: RequestOptionsJSON }
    | undefined;
  let generation = 0;
  function updateMode(): void {
    typed.setAttribute('aria-pressed', String(mode === 'typed'));
    drawn.setAttribute('aria-pressed', String(mode === 'drawn'));
    preview.hidden = mode !== 'typed';
    pad.element.hidden = mode !== 'drawn';
    clear.hidden = mode !== 'drawn';
  }
  function changed(): void {
    preview.textContent = name.value;
    prepared = undefined;
    sign.disabled = true;
    const current = ++generation;
    if (!consent.checked || name.value.trim() === '') {
      status.textContent = 'Tick the box above to sign.';
      return;
    }
    if (mode === 'drawn' && pad.strokes().length === 0) {
      status.textContent = 'Draw your mark to sign.';
      return;
    }
    status.textContent = 'Preparing your signature.';
    void prepare()
      .then((value) => {
        if (current !== generation) return;
        prepared = value;
        sign.disabled = false;
        status.textContent = 'Your passkey confirms it.';
      })
      .catch((error: unknown) => {
        if (current !== generation) return;
        if (
          error instanceof PrivateRequestError &&
          error.code === 'passkey_required' &&
          signer.identity_id === null
        ) {
          status.textContent = 'Create a passkey to sign.';
          void postJson(input.deps, '/api/auth/passkeys/options', {})
            .then(setBootstrap)
            .catch((cause: unknown) => {
              status.textContent =
                cause instanceof Error
                  ? cause.message
                  : 'Could not prepare a passkey.';
            });
          return;
        }
        status.textContent =
          error instanceof Error
            ? error.message
            : 'Could not prepare the signature.';
      });
  }
  async function prepare(): Promise<Prepared> {
    const options = await api.options(request.request_id);
    const now = input.deps.now ? input.deps.now() : Date.now();
    const expiresAt = Math.min(Date.parse(options.expires_at), now + 240_000);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error('The signing request expired. Try again.');
    }
    if (
      options.request_id !== request.request_id ||
      options.version !== request.version ||
      options.version_digest !== request.ciphertext_sha256 ||
      options.content_mac !== request.content_mac ||
      options.request_sha256 !== signingRequestSha256(request) ||
      options.signer_index !== input.signerIndex ||
      options.signer_identity_id !== signer.identity_id ||
      options.consent.id !== SIGN_CONSENT_ID ||
      options.consent.text !== SIGN_CONSENT_TEXT ||
      options.public_key.rpId !== new URL(input.deps.serviceOrigin).hostname ||
      options.public_key.userVerification !== 'required' ||
      (request.require_opened
        ? options.opened_receipt_sha256 === null
        : options.opened_receipt_sha256 !== null)
    ) {
      throw new Error('The signing request changed. Reload this relik.');
    }
    if (
      (signer.identity_id !== null &&
        input.identity?.identityId !== signer.identity_id) ||
      (signer.identity_id === null && input.identity !== undefined)
    )
      throw new Error('The signing identity changed.');
    const mark = await sealSignatureMark({
      signingKey: input.signingKey,
      relicId: input.relicId,
      version: request.version,
      mark: {
        v: 1,
        name: name.value.trim(),
        strokes: mode === 'typed' ? null : pad.strokes(),
      },
    });
    const statement = {
      at: input.deps.now ? input.deps.now() : Date.now(),
      ciphertext_sha256: request.ciphertext_sha256,
      consent: SIGN_CONSENT_ID,
      content_mac: request.content_mac,
      mark_sha256: markCiphertextSha256(mark),
      opened_receipt_sha256: options.opened_receipt_sha256,
      relic_id: input.relicId,
      request_id: request.request_id,
      request_sha256: options.request_sha256,
      signer_email: signer.email,
      signer_identity_id: signer.identity_id,
      signer_index: input.signerIndex,
      version: request.version,
    };
    const bytes = statementBytes(
      'signature',
      parseStatement('signature', statement)
    );
    const identitySignature =
      input.identity === undefined
        ? ''
        : await signStatement(
            (message) => input.identity!.sign(message),
            bytes
          );
    const challenge = await attestationChallenge(
      decodeBase64url(options.nonce),
      [bytes]
    );
    const publicKey = requestOptionsFromJSON({
      ...options.public_key,
      challenge: encodeBase64url(challenge),
    });
    return {
      expiresAt,
      publicKey,
      nonce: options.nonce,
      statement,
      identitySignature,
      mark,
    };
  }
  function setBootstrap(value: unknown): void {
    if (typeof value !== 'object' || value === null)
      throw new Error('Invalid passkey options.');
    const mode = Reflect.get(value, 'mode');
    const wire = Reflect.get(value, 'public_key');
    if (mode === 'create') {
      const options = parseCreationOptions(wire);
      if (
        !options ||
        options.rp.id !== new URL(input.deps.serviceOrigin).hostname
      )
        throw new Error('Invalid passkey options.');
      bootstrap = { mode, options };
      passkey.textContent = 'Create passkey';
    } else if (mode === 'assert') {
      const options = parseRequestOptions(wire);
      if (
        !options ||
        options.rpId !== new URL(input.deps.serviceOrigin).hostname
      )
        throw new Error('Invalid passkey options.');
      bootstrap = { mode, options };
      passkey.textContent = 'Use an existing passkey';
    } else throw new Error('Invalid passkey options.');
    passkey.hidden = false;
    passkey.disabled = false;
  }
  passkey.addEventListener('click', () => {
    const current = bootstrap;
    if (!current) return;
    const credentials = input.deps.credentials ?? navigator.credentials;
    let pending: Promise<Credential | null>;
    try {
      pending =
        current.mode === 'create'
          ? credentials.create({
              publicKey: creationOptionsFromJSON(current.options),
              signal: ceremonySignal(),
            })
          : credentials.get({
              publicKey: requestOptionsFromJSON(current.options),
              signal: ceremonySignal(),
            });
    } catch (error) {
      pending = Promise.reject(error);
    }
    passkey.disabled = true;
    void pending
      .then(async (credential) => {
        if (!credential) throw new Error('Passkey cancelled.');
        if (current.mode === 'assert') {
          const options = await postJson(
            input.deps,
            '/api/auth/passkeys/options',
            { credential: authenticationResponseToJSON(credential) }
          );
          setBootstrap(options);
        } else {
          await postJson(input.deps, '/api/auth/passkeys', {
            credential: registrationResponseToJSON(credential),
          });
          passkey.hidden = true;
          bootstrap = undefined;
          changed();
        }
      })
      .catch((error: unknown) => {
        status.textContent =
          error instanceof Error
            ? error.message
            : 'Could not create a passkey.';
        passkey.disabled = false;
      });
  });
  name.addEventListener('input', changed);
  consent.addEventListener('change', changed);
  typed.addEventListener('click', () => {
    mode = 'typed';
    updateMode();
    changed();
  });
  drawn.addEventListener('click', () => {
    mode = 'drawn';
    updateMode();
    changed();
  });
  sign.addEventListener('click', () => {
    const current = prepared;
    if (
      !current ||
      (input.deps.now ? input.deps.now() : Date.now()) >= current.expiresAt
    ) {
      changed();
      return;
    }
    const credentials = input.deps.credentials ?? navigator.credentials;
    let pending: Promise<Credential | null>;
    try {
      pending = credentials.get({
        publicKey: current.publicKey,
        signal: ceremonySignal(),
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    sign.disabled = true;
    status.textContent = 'Waiting for passkey';
    void pending
      .then(async (credential) => {
        if (credential === null) throw new Error('Passkey cancelled.');
        await api.signature(
          request.request_id,
          {
            nonce: current.nonce,
            statements: [
              {
                kind: 'signature',
                statement: current.statement,
                identity_signature: current.identitySignature,
              },
            ],
            credential: authenticationResponseToJSON(credential),
          },
          current.mark
        );
        status.textContent = 'You signed.';
        input.onSigned();
      })
      .catch((error: unknown) => {
        status.textContent =
          error instanceof Error ? error.message : 'Could not sign.';
        prepared = undefined;
        changed();
      });
  });
  updateMode();
  document.body.appendChild(panel);
  name.focus();
  return panel;
}
