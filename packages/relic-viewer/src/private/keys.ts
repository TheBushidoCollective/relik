/**
 * The identity half of private shares: the passkey that holds a reader's
 * private-share key, the unlock ceremony that opens it, and the attestation
 * every signed request carries.
 *
 * A key never leaves this module as bytes that a request could carry. A PRF
 * output becomes a KEK in one call, opens the identity bundle into
 * non-extractable keys, and is dropped. What reaches the service is public:
 * public keys, signatures, the encrypted bundle and the assertion itself.
 */

import type {
  AuthenticationResponseJSON,
  PasskeyDescriptorJSON,
  RequestOptionsJSON,
} from '@relic/format';
import {
  type AttestationBundleJSON,
  type AttestPurpose,
  attestationChallenge,
  decodeBase64url,
  decryptIdentityBundle,
  deriveKek,
  encodeBase64url,
  type HpkeRecipient,
  type IdentityKeys,
  type IdentityStateJSON,
  kemKeyIdOf,
  PRF_SALT,
  parseStatement,
  type SignedStatementJSON,
  signStatement,
  type StatementKind,
  statementBytes,
} from '@relic/format/private';
import {
  authenticationResponseToJSON,
  type CredentialsLike,
  parseDescriptors,
  requestOptionsFromJSON,
} from '../passkey-common.ts';
import type { ViewerDeps } from '../viewer.ts';

/** The authenticator returned no PRF output, so no key can be derived from it. */
export class PrfUnavailableError extends Error {}

/** The signed-in address has no private-share key yet. */
export class NoIdentityError extends Error {}

/** The service refused a request. `code` is the problem code it named. */
export class PrivateRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = 'PrivateRequestError';
  }
}

/** A signed-in reader's private-share key, opened in this page and nowhere else. */
export interface UnlockedIdentity {
  readonly identityId: string;
  readonly email: string;
  readonly kemPublicKey: Uint8Array;
  readonly sigPublicKey: Uint8Array;
  readonly kemKeyId: Uint8Array;
  readonly credentialId: string;
  dh(peer: Uint8Array): Promise<Uint8Array>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** A statement to sign, as the server will rebuild and verify it. */
export interface StatementDraft {
  readonly kind: StatementKind;
  readonly statement: Record<string, unknown>;
}

/** What an attestation signs, and the nonce it is bound to. */
export interface AttestRequest {
  readonly purpose: AttestPurpose;
  readonly relicId?: string;
  readonly credentialId?: string;
  build(identityId: string): readonly StatementDraft[];
}

export interface PrfAssertion {
  readonly response: AuthenticationResponseJSON;
  readonly rawId: Uint8Array;
  readonly prf: Uint8Array;
}

/** A server nonce with the options the ceremony must use. */
export interface IssuedNonce {
  readonly nonce: string;
  readonly rpId: string;
  readonly allowCredentials: readonly PasskeyDescriptorJSON[];
}

type Signer = (message: Uint8Array) => Promise<Uint8Array>;

/** Key pairs behind each unlocked identity, so a bind can re-encrypt the bundle. */
const keysByIdentity = new WeakMap<UnlockedIdentity, IdentityKeys>();

class Unlocked implements UnlockedIdentity {
  constructor(
    readonly identityId: string,
    readonly email: string,
    readonly kemPublicKey: Uint8Array,
    readonly sigPublicKey: Uint8Array,
    readonly kemKeyId: Uint8Array,
    readonly credentialId: string,
    keys: IdentityKeys
  ) {
    keysByIdentity.set(this, keys);
  }

  async dh(peer: Uint8Array): Promise<Uint8Array> {
    const keys = identityKeysOf(this);
    const peerKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(peer),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerKey },
        keys.kem.privateKey,
        256
      )
    );
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        identityKeysOf(this).sig.privateKey,
        new Uint8Array(bytes)
      )
    );
  }
}

/**
 * The key pairs behind an unlocked identity. Only the bundle flows need them,
 * to encrypt the same keys under another passkey's KEK.
 */
export function identityKeysOf(identity: UnlockedIdentity): IdentityKeys {
  const keys = keysByIdentity.get(identity);
  if (keys === undefined) throw new NoIdentityError('identity_not_unlocked');
  return keys;
}

/** Wraps freshly opened or generated keys as an unlocked identity. */
export async function unlockedFrom(
  keys: IdentityKeys,
  identityId: string,
  email: string,
  credentialId: string
): Promise<UnlockedIdentity> {
  return new Unlocked(
    identityId,
    email,
    keys.kemPublicKey,
    keys.sigPublicKey,
    await kemKeyIdOf(keys.kemPublicKey),
    credentialId,
    keys
  );
}

/** The HPKE recipient a wrap is opened with, backed by this identity's DH. */
export function recipientOf(identity: UnlockedIdentity): HpkeRecipient {
  return {
    publicKey: identity.kemPublicKey,
    dh: (peer) => identity.dh(peer),
  };
}

/** The relying party for this service, which is the host WebAuthn scopes to. */
export function rpIdOf(deps: ViewerDeps): string {
  return new URL(deps.serviceOrigin).hostname;
}

export function nowMs(deps: ViewerDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** Reads one field off untrusted JSON, without assuming its shape. */
export function readField(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, name)
    : undefined;
}

export function credentialsOf(deps: ViewerDeps): CredentialsLike {
  return deps.credentials ?? navigator.credentials;
}

export async function requestFailure(
  response: Response
): Promise<PrivateRequestError> {
  const body: unknown = await response.json().catch(() => undefined);
  const code = readField(body, 'code');
  return new PrivateRequestError(
    typeof code === 'string' ? code : 'unknown',
    response.status
  );
}

export async function postJson(
  deps: ViewerDeps,
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await deps.fetch(`${deps.serviceOrigin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw await requestFailure(response);
  return response.json();
}

function isIdentityState(value: unknown): value is IdentityStateJSON {
  if (typeof value !== 'object' || value === null) return false;
  if (!('identity' in value) || !('passkeys' in value)) return false;
  if (!Array.isArray(value.passkeys)) return false;
  const identity: unknown = value.identity;
  if (identity === null) return true;
  return (
    typeof readField(identity, 'identity_id') === 'string' &&
    Array.isArray(readField(identity, 'credentials'))
  );
}

/** The identity this session holds, its bound passkeys and their bundles. */
export async function loadIdentityState(
  deps: ViewerDeps
): Promise<IdentityStateJSON> {
  const response = await deps.fetch(`${deps.serviceOrigin}/api/identity`);
  if (!response.ok) throw await requestFailure(response);
  const body: unknown = await response.json();
  if (!isIdentityState(body)) {
    throw new PrivateRequestError('invalid_identity_state', response.status);
  }
  return body;
}

export function randomBase64url(bytes: number): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A credential's raw id, which is what the service and the bundle key on. */
function rawIdOf(credential: Credential): Uint8Array {
  const rawId: unknown = Reflect.get(credential, 'rawId');
  if (!(rawId instanceof ArrayBuffer)) {
    throw new TypeError('credential has no raw id');
  }
  return new Uint8Array(rawId);
}

/** The PRF output off a credential, read locally and never serialized. */
function prfOutput(credential: Credential): Uint8Array | undefined {
  const getResults: unknown = Reflect.get(
    credential,
    'getClientExtensionResults'
  );
  if (typeof getResults !== 'function') return undefined;
  const results: unknown = getResults.call(credential);
  const first = readField(
    readField(readField(results, 'prf'), 'results'),
    'first'
  );
  return first instanceof ArrayBuffer ? new Uint8Array(first) : undefined;
}

/**
 * One assertion that also evaluates the identity PRF salt.
 *
 * The response is built by `authenticationResponseToJSON`, which reads no
 * extension results. The PRF output is returned to the caller only, and
 * refusing an authenticator without it happens before anything is sent.
 */
export async function prfAssertion(
  deps: ViewerDeps,
  options: {
    readonly challenge: string;
    readonly rpId: string;
    readonly allowCredentials: readonly PasskeyDescriptorJSON[];
    readonly signal?: AbortSignal;
  }
): Promise<PrfAssertion> {
  const request = requestOptionsFromJSON({
    challenge: options.challenge,
    rpId: options.rpId,
    allowCredentials: [...options.allowCredentials],
    userVerification: 'required',
    extensions: { prf: { eval: { first: encodeBase64url(PRF_SALT) } } },
  } satisfies RequestOptionsJSON);
  const credential = await credentialsOf(deps).get({
    publicKey: request,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (credential === null) {
    throw new PrivateRequestError('ceremony_cancelled', 0);
  }
  const prf = prfOutput(credential);
  if (prf === undefined) {
    throw new PrfUnavailableError('authenticator returned no PRF output');
  }
  return {
    response: authenticationResponseToJSON(credential),
    rawId: rawIdOf(credential),
    prf,
  };
}

/** A plain assertion, for ceremonies that need a passkey but no PRF output. */
export async function plainAssertion(
  deps: ViewerDeps,
  options: {
    readonly challenge: string;
    readonly rpId: string;
    readonly allowCredentials: readonly PasskeyDescriptorJSON[];
    readonly signal?: AbortSignal;
  }
): Promise<{
  readonly response: AuthenticationResponseJSON;
  readonly rawId: Uint8Array;
}> {
  const credential = await credentialsOf(deps).get({
    publicKey: requestOptionsFromJSON({
      challenge: options.challenge,
      rpId: options.rpId,
      allowCredentials: [...options.allowCredentials],
      userVerification: 'required',
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (credential === null) {
    throw new PrivateRequestError('ceremony_cancelled', 0);
  }
  return {
    response: authenticationResponseToJSON(credential),
    rawId: rawIdOf(credential),
  };
}

/** A server nonce and the ceremony options it names. */
export async function issueNonce(
  deps: ViewerDeps,
  purpose: AttestPurpose,
  extra: { readonly relicId?: string; readonly credentialId?: string } = {},
  signal?: AbortSignal
): Promise<IssuedNonce> {
  const body = await postJson(
    deps,
    '/api/attest/nonce',
    {
      purpose,
      ...(extra.relicId === undefined ? {} : { relic_id: extra.relicId }),
      ...(extra.credentialId === undefined
        ? {}
        : { credential_id: extra.credentialId }),
    },
    signal
  );
  const publicKey = readField(body, 'public_key');
  const nonce = readField(body, 'nonce');
  const rpId = readField(publicKey, 'rpId');
  if (typeof nonce !== 'string' || typeof rpId !== 'string') {
    throw new PrivateRequestError('invalid_nonce', 0);
  }
  return {
    nonce,
    rpId,
    allowCredentials:
      parseDescriptors(readField(publicKey, 'allowCredentials')) ?? [],
  };
}

/**
 * The bytes each statement signs, in request order. Every draft goes through
 * the strict parser first, so a malformed statement is refused here rather
 * than signed and then rejected by the service.
 */
export function statementBytesOf(
  drafts: readonly StatementDraft[]
): Uint8Array[] {
  return drafts.map((draft) =>
    statementBytes(draft.kind, parseStatement(draft.kind, draft.statement))
  );
}

/** Signs each statement with the given signature key. */
export async function signStatements(
  sign: Signer,
  drafts: readonly StatementDraft[],
  bytes: readonly Uint8Array[]
): Promise<SignedStatementJSON[]> {
  const signed: SignedStatementJSON[] = [];
  for (const [index, draft] of drafts.entries()) {
    const message = bytes[index];
    if (message === undefined) throw new Error('statement bytes missing');
    signed.push({
      kind: draft.kind,
      statement: draft.statement,
      identity_signature: await signStatement(sign, message),
    });
  }
  return signed;
}

/** Opens the bundle one credential holds, and rebuilds non-extractable keys. */
export async function openBundle(
  prf: Uint8Array,
  rawId: Uint8Array,
  bundle: string,
  identityId: string
): Promise<IdentityKeys> {
  return decryptIdentityBundle(
    await deriveKek(prf, rawId),
    bundle,
    identityId,
    rawId
  );
}

/** The bundle a bound credential holds, or a refusal when it holds none. */
export function boundBundle(
  identity: NonNullable<IdentityStateJSON['identity']>,
  credentialId: string
): string {
  const entry = identity.credentials.find(
    (credential) => credential.credential_id === credentialId
  );
  if (entry === undefined) {
    throw new PrivateRequestError('identity_bundle_missing', 0);
  }
  return entry.encrypted_bundle;
}

/**
 * Unlock the identity with one tap on a bound passkey. No server call verifies
 * the assertion: the bundle opens only under the PRF output, so a wrong
 * authenticator fails to decrypt rather than gaining access.
 */
export async function unlock(
  deps: ViewerDeps,
  state: IdentityStateJSON,
  signal?: AbortSignal
): Promise<UnlockedIdentity> {
  const identity = state.identity;
  if (identity === null) throw new NoIdentityError('identity_required');
  const assertion = await prfAssertion(deps, {
    challenge: randomBase64url(32),
    rpId: rpIdOf(deps),
    allowCredentials: identity.credentials.map((credential) => ({
      id: credential.credential_id,
      type: 'public-key' as const,
    })),
    ...(signal === undefined ? {} : { signal }),
  });
  const credentialId = encodeBase64url(assertion.rawId);
  const keys = await openBundle(
    assertion.prf,
    assertion.rawId,
    boundBundle(identity, credentialId),
    identity.identity_id
  );
  return unlockedFrom(keys, identity.identity_id, identity.email, credentialId);
}

/**
 * Attest a state-changing action, unlocking the identity inside the same
 * passkey tap. The nonce binds the statements, the assertion carries the
 * PRF output that opens the bundle, and the signatures come from those keys.
 */
export async function attest(
  deps: ViewerDeps,
  request: AttestRequest,
  signal?: AbortSignal
): Promise<{ identity: UnlockedIdentity; bundle: AttestationBundleJSON }> {
  const state = await loadIdentityState(deps);
  const identity = state.identity;
  if (identity === null) throw new NoIdentityError('identity_required');
  const issued = await issueNonce(
    deps,
    request.purpose,
    {
      ...(request.relicId === undefined ? {} : { relicId: request.relicId }),
      ...(request.credentialId === undefined
        ? {}
        : { credentialId: request.credentialId }),
    },
    signal
  );
  const drafts = request.build(identity.identity_id);
  const bytes = statementBytesOf(drafts);
  const challenge = await attestationChallenge(
    decodeBase64url(issued.nonce),
    bytes
  );
  const assertion = await prfAssertion(deps, {
    challenge: encodeBase64url(challenge),
    rpId: issued.rpId,
    allowCredentials: issued.allowCredentials,
    ...(signal === undefined ? {} : { signal }),
  });
  const credentialId = encodeBase64url(assertion.rawId);
  const keys = await openBundle(
    assertion.prf,
    assertion.rawId,
    boundBundle(identity, credentialId),
    identity.identity_id
  );
  const unlocked = await unlockedFrom(
    keys,
    identity.identity_id,
    identity.email,
    credentialId
  );
  return {
    identity: unlocked,
    bundle: {
      nonce: issued.nonce,
      statements: await signStatements(
        (message) => unlocked.sign(message),
        drafts,
        bytes
      ),
      credential: assertion.response,
    },
  };
}
