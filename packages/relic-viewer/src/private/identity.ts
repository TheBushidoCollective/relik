/**
 * Setting up a private-share key: the first identity, the replacement passkey
 * offered when the passkey in use cannot hold a key, and the second passkey a
 * signed-in identity binds to its key.
 *
 * A passkey that cannot hold the key is never registered as the identity's
 * credential. Setup refuses before any bundle leaves the browser, so a provider
 * without PRF leaves nothing behind except a passkey the reader can delete.
 */

import { normalizeEmail } from '@relic/format';
import {
  attestationChallenge,
  decodeBase64url,
  deriveKek,
  encodeBase64url,
  encryptIdentityBundle,
  generateIdentityKeys,
  type IdentityKeys,
  identityIdOf,
} from '@relic/format/private';
import {
  creationOptionsFromJSON,
  parseCreationOptions,
  parseRequestOptions,
  registrationResponseToJSON,
} from '../passkey-common.ts';
import type { ViewerDeps } from '../viewer.ts';
import {
  credentialsOf,
  identityKeysOf,
  issueNonce,
  nowMs,
  openBundle,
  plainAssertion,
  postJson,
  PrfUnavailableError,
  prfAssertion,
  PrivateRequestError,
  readField,
  signStatements,
  type StatementDraft,
  statementBytesOf,
  type UnlockedIdentity,
  unlockedFrom,
} from './keys.ts';

/** Where setup stands after one identity ceremony. */
export type SetupOutcome =
  | { readonly kind: 'ready'; readonly identity: UnlockedIdentity }
  | { readonly kind: 'replace-offer' }
  | { readonly kind: 'refused' };

/** Signs with a generated key pair before the identity exists on the service. */
function signerFor(
  keys: IdentityKeys
): (message: Uint8Array) => Promise<Uint8Array> {
  return async (message) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.sig.privateKey,
        new Uint8Array(message)
      )
    );
}

/**
 * One identity ceremony: a fresh key pair, one passkey assertion that carries
 * the PRF output, the bundle encrypted under that output, and the registration.
 * Throws `PrfUnavailableError` before anything is sent when there is no PRF.
 */
async function registerOnce(
  deps: ViewerDeps,
  email: string,
  signal?: AbortSignal
): Promise<UnlockedIdentity> {
  const keys = await generateIdentityKeys();
  const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const issued = await issueNonce(deps, 'identity_register', {}, signal);
  const drafts: readonly StatementDraft[] = [
    {
      kind: 'identity_register',
      statement: {
        at: nowMs(deps),
        email: normalizeEmail(email),
        identity_id: identityId,
        kem_public_key: encodeBase64url(keys.kemPublicKey),
        replaces: null,
        sig_public_key: encodeBase64url(keys.sigPublicKey),
      },
    },
  ];
  const bytes = statementBytesOf(drafts);
  const assertion = await prfAssertion(deps, {
    challenge: encodeBase64url(
      await attestationChallenge(decodeBase64url(issued.nonce), bytes)
    ),
    rpId: issued.rpId,
    allowCredentials: issued.allowCredentials,
    ...(signal === undefined ? {} : { signal }),
  });
  const kek = await deriveKek(assertion.prf, assertion.rawId);
  const encrypted = await encryptIdentityBundle(kek, keys, assertion.rawId);
  await postJson(
    deps,
    '/api/identity',
    {
      attestation: {
        nonce: issued.nonce,
        statements: await signStatements(signerFor(keys), drafts, bytes),
        credential: assertion.response,
      },
      encrypted_bundle: encrypted,
    },
    signal
  );
  const opened = await openBundle(
    assertion.prf,
    assertion.rawId,
    encrypted,
    identityId
  );
  return unlockedFrom(
    opened,
    identityId,
    email,
    encodeBase64url(assertion.rawId)
  );
}

/**
 * Sets up the identity for a signed-in address. A passkey without PRF gives
 * `replace-offer`: the reader is offered a replacement passkey rather than a
 * refusal, because the first miss is the expected case for older passkeys.
 */
export async function setUpIdentity(
  deps: ViewerDeps,
  email: string,
  signal?: AbortSignal
): Promise<SetupOutcome> {
  try {
    return { kind: 'ready', identity: await registerOnce(deps, email, signal) };
  } catch (error) {
    if (error instanceof PrfUnavailableError) return { kind: 'replace-offer' };
    throw error;
  }
}

/**
 * The identity ceremony retried once after a replacement passkey was made. A
 * second miss is a hard refusal, and nothing has been registered for the
 * identity yet.
 */
export async function retryIdentityAfterReplacement(
  deps: ViewerDeps,
  email: string,
  signal?: AbortSignal
): Promise<SetupOutcome> {
  try {
    return { kind: 'ready', identity: await registerOnce(deps, email, signal) };
  } catch (error) {
    if (error instanceof PrfUnavailableError) return { kind: 'refused' };
    throw error;
  }
}

/**
 * Creates a passkey through the server's options handshake, the same two-step
 * flow the post-sign-in offer uses: an empty options call returns an assertion
 * when the session already holds a passkey, and the assertion returns the
 * creation options. Returns the new credential's id, which is its base64url
 * raw id.
 */
async function createPasskey(
  deps: ViewerDeps,
  forPrivateShares: boolean,
  signal?: AbortSignal
): Promise<string> {
  const extra = forPrivateShares ? { for_private_shares: true } : {};
  const first = await postJson(
    deps,
    '/api/auth/passkeys/options',
    extra,
    signal
  );
  let options = first;
  const asserted = parseRequestOptions(readField(first, 'public_key'));
  if (asserted !== undefined) {
    const assertion = await plainAssertion(deps, {
      challenge: asserted.challenge,
      rpId: asserted.rpId,
      allowCredentials: asserted.allowCredentials ?? [],
      ...(signal === undefined ? {} : { signal }),
    });
    options = await postJson(
      deps,
      '/api/auth/passkeys/options',
      { ...extra, credential: assertion.response },
      signal
    );
  }
  const creation = parseCreationOptions(readField(options, 'public_key'));
  if (creation === undefined) {
    throw new PrivateRequestError('invalid_passkey_options', 0);
  }
  const created = await credentialsOf(deps).create({
    publicKey: creationOptionsFromJSON(creation),
    ...(signal === undefined ? {} : { signal }),
  });
  if (created === null) throw new PrivateRequestError('ceremony_cancelled', 0);
  await postJson(
    deps,
    '/api/auth/passkeys',
    { credential: registrationResponseToJSON(created) },
    signal
  );
  return created.id;
}

/**
 * A replacement passkey for an identity whose current passkey cannot hold the
 * key. The server issues its creation options only for the private-share
 * request, so a plain passkey cannot be swapped in by accident.
 */
export async function makeReplacementPasskey(
  deps: ViewerDeps,
  signal?: AbortSignal
): Promise<void> {
  await createPasskey(deps, true, signal);
}

/**
 * Binds a second passkey to the identity this page already holds. The new
 * passkey must hold PRF: its assertion opens a fresh KEK, and the same keys are
 * encrypted under it before the credential is recorded.
 */
export async function bindPasskey(
  deps: ViewerDeps,
  identity: UnlockedIdentity,
  signal?: AbortSignal
): Promise<{ readonly credentialId: string }> {
  const credentialId = await createPasskey(deps, false, signal);
  const issued = await issueNonce(
    deps,
    'identity_bind',
    { credentialId },
    signal
  );
  const drafts: readonly StatementDraft[] = [
    {
      kind: 'identity_bind',
      statement: {
        at: nowMs(deps),
        credential_id: credentialId,
        identity_id: identity.identityId,
      },
    },
  ];
  const bytes = statementBytesOf(drafts);
  const assertion = await prfAssertion(deps, {
    challenge: encodeBase64url(
      await attestationChallenge(decodeBase64url(issued.nonce), bytes)
    ),
    rpId: issued.rpId,
    allowCredentials: [{ id: credentialId, type: 'public-key' }],
    ...(signal === undefined ? {} : { signal }),
  });
  const encrypted = await encryptIdentityBundle(
    await deriveKek(assertion.prf, assertion.rawId),
    identityKeysOf(identity),
    assertion.rawId
  );
  await postJson(
    deps,
    '/api/identity/credentials',
    {
      attestation: {
        nonce: issued.nonce,
        statements: await signStatements(
          (message) => identity.sign(message),
          drafts,
          bytes
        ),
        credential: assertion.response,
      },
      encrypted_bundle: encrypted,
    },
    signal
  );
  return { credentialId };
}
