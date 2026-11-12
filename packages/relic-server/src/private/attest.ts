/**
 * Attestations: one WebAuthn assertion that signs one or more statements
 * (`docs/plans/private-shares` 4.3 and 4.4).
 *
 * The server issues a single-use nonce, the browser signs the statements
 * with the identity's key, and the WebAuthn challenge is
 * `attestationChallenge(nonce, statements)`, so the assertion commits to
 * exactly the bytes the service stores. A stored attestation carries
 * everything needed to verify it again without the live store.
 */

import {
  attestationChallenge,
  type AttestPurpose,
  decodeBase64url,
  encodeBase64url,
  InvalidStatementError,
  parseStatement,
  type StatementKind,
  statementBytes,
  verifyStatement,
} from '@relic/format/private';
import { verifyAssertion, WebauthnError } from '../webauthn.ts';
import { ProblemError } from '../problems.ts';
import type { PasskeyRecord, StoredAttestation } from '../store.ts';
import {
  type PrivateEnv,
  randomBytes,
  sameString,
  sha256Hex,
} from './context.ts';

/** The statements each purpose may sign, in the order the bundle carries them. */
export const PURPOSE_KINDS: Readonly<
  Record<AttestPurpose, readonly StatementKind[]>
> = {
  identity_register: ['identity_register'],
  identity_bind: ['identity_bind'],
  identity_settings: ['identity_settings'],
  access_request: ['access_request'],
  grant: ['grant'],
  revoke: ['revocation', 'republish'],
  delete: ['delete'],
  device_approve: ['device_cert'],
  device_revoke: ['device_revocation'],
  recovery_designate: ['recovery_designation'],
};

/** A statement as it was verified: its kind, its parsed fields and its signature. */
export interface VerifiedStatement {
  readonly kind: StatementKind;
  readonly statement: Record<string, unknown>;
  readonly identitySignature: string;
}

export interface VerifiedAttestation {
  readonly attestation: StoredAttestation;
  readonly statements: readonly VerifiedStatement[];
  /** The passkey the assertion came from. */
  readonly credentialId: string;
}

/** A WebAuthn assertion body as the browser returns it, from the bundle. */
export interface AttestationBundle {
  readonly nonce: string;
  readonly statements: readonly {
    readonly kind: string;
    readonly statement: Record<string, unknown>;
    readonly identity_signature: string;
  }[];
  readonly credential: Record<string, unknown>;
}

const NONCE_BYTES = 32;

/**
 * Issues a single-use attestation nonce for one purpose and returns the
 * assertion options the browser needs. The nonce row binds the purpose, the
 * relic and, for a bind, the credential, so a nonce for one action cannot
 * sign another.
 */
export async function issueAttestNonce(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly purpose: AttestPurpose;
    readonly passkeys: PasskeyRecord | undefined;
    readonly relicId?: string | undefined;
    readonly credentialId?: string | undefined;
  }
): Promise<{
  nonce: string;
  expires_at: string;
  public_key: {
    rpId: string;
    timeout: number;
    userVerification: 'required';
    allowCredentials: {
      type: 'public-key';
      id: string;
      transports: string[];
    }[];
  };
}> {
  const passkeys = input.passkeys;
  if (passkeys === undefined || passkeys.credentials.length === 0) {
    throw new ProblemError('passkey_required');
  }
  let allowed = passkeys.credentials;
  if (input.purpose === 'identity_bind') {
    if (input.credentialId === undefined) {
      throw new ProblemError('invalid_passkey', { passkey_check: 'shape' });
    }
    allowed = passkeys.credentials.filter(
      (c) => c.credentialId === input.credentialId
    );
    if (allowed.length === 0) {
      throw new ProblemError('invalid_passkey', {
        passkey_check: 'credential',
      });
    }
  }

  const nonce = encodeBase64url(randomBytes(NONCE_BYTES));
  const expiresAt = env.now + env.config.passkeyChallengeTtlSeconds * 1000;
  await env.store.putWebauthnChallenge({
    challengeHash: await sha256Hex(nonce),
    email: input.email,
    purpose: 'attest',
    attestPurpose: input.purpose,
    ...(input.relicId === undefined ? {} : { relicId: input.relicId }),
    ...(input.credentialId === undefined
      ? {}
      : { credentialId: input.credentialId }),
    expiresAt,
  });

  return {
    nonce,
    expires_at: new Date(expiresAt).toISOString(),
    public_key: {
      rpId: new URL(env.config.serviceOrigin).hostname,
      timeout: 300_000,
      userVerification: 'required',
      allowCredentials: allowed.map((c) => ({
        type: 'public-key',
        id: c.credentialId,
        transports:
          c.transports && c.transports.length > 0
            ? [...c.transports]
            : ['internal'],
      })),
    },
  };
}

function refuseStatement(check: string): never {
  throw new ProblemError('invalid_statement', { statement_check: check });
}

function bundleShape(bundle: unknown): AttestationBundle {
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    throw new ProblemError('invalid_statement', { statement_check: 'shape' });
  }
  const b = bundle as Record<string, unknown>;
  if (
    typeof b['nonce'] !== 'string' ||
    !Array.isArray(b['statements']) ||
    b['statements'].length === 0 ||
    typeof b['credential'] !== 'object' ||
    b['credential'] === null
  ) {
    refuseStatement('shape');
  }
  for (const item of b['statements'] as unknown[]) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>)['kind'] !== 'string' ||
      typeof (item as Record<string, unknown>)['statement'] !== 'object' ||
      (item as Record<string, unknown>)['statement'] === null ||
      typeof (item as Record<string, unknown>)['identity_signature'] !==
        'string'
    ) {
      refuseStatement('shape');
    }
  }
  return b as unknown as AttestationBundle;
}

/** Decodes the nonce, refusing anything that is not 32 base64url bytes. */
function nonceBytes(nonce: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(nonce);
  } catch {
    throw new ProblemError('passkey_verification_failed', {
      passkey_check: 'nonce',
    });
  }
  if (bytes.byteLength !== NONCE_BYTES) {
    throw new ProblemError('passkey_verification_failed', {
      passkey_check: 'nonce',
    });
  }
  return bytes;
}

/** The signature key a statement must verify under, or undefined for none. */
export type SignerKey = (
  kind: StatementKind,
  statement: Record<string, unknown>
) => Uint8Array | undefined;

/**
 * Verifies a fresh attestation for one purpose, end to end: the nonce is
 * this purpose's and unspent, every statement parses and is fresh, the
 * assertion is for the session's own passkey and commits to these
 * statements, and each statement carries the signature its signer made.
 *
 * Throws `ProblemError` with the refusal the plan names. Nothing is written
 * here; the caller stores the result after its own checks pass.
 */
export async function verifyAttestation(
  env: PrivateEnv,
  input: {
    readonly bundle: unknown;
    readonly purpose: AttestPurpose;
    readonly email: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly signerKey: SignerKey;
    readonly relicId?: string;
  }
): Promise<VerifiedAttestation> {
  const bundle = bundleShape(input.bundle);
  if ('clientExtensionResults' in bundle.credential) {
    // PRF output never reaches the service (plan 2.19). Refusing the field
    // outright keeps the invariant from depending on a serializer.
    refuseStatement('prf_output');
  }

  const expected = PURPOSE_KINDS[input.purpose];
  if (
    bundle.statements.length !== expected.length ||
    bundle.statements.some((s, i) => s.kind !== expected[i])
  ) {
    refuseStatement('kinds');
  }

  const parsed: { kind: StatementKind; statement: Record<string, unknown> }[] =
    [];
  for (const item of bundle.statements) {
    const kind = item.kind as StatementKind;
    let statement: Record<string, unknown>;
    try {
      statement = parseStatement(kind, item.statement) as unknown as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (error instanceof InvalidStatementError) refuseStatement(error.check);
      throw error;
    }
    const at = statement['at'] as number;
    if (Math.abs(env.now - at) > env.config.passkeyChallengeTtlSeconds * 1000) {
      refuseStatement('stale');
    }
    if (
      input.relicId !== undefined &&
      'relic_id' in statement &&
      statement['relic_id'] !== input.relicId
    ) {
      refuseStatement('relic');
    }
    parsed.push({ kind, statement });
  }

  // The nonce is spent here, win or lose, so a failed assertion cannot be
  // retried against the same challenge.
  const row = await env.store.consumeWebauthnChallenge(
    await sha256Hex(bundle.nonce)
  );
  if (
    row === undefined ||
    row.purpose !== 'attest' ||
    row.attestPurpose !== input.purpose ||
    row.email !== input.email ||
    row.expiresAt < env.now ||
    (row.relicId !== undefined && row.relicId !== input.relicId) ||
    (row.credentialId !== undefined &&
      !sameString(row.credentialId, String(bundle.credential['id'] ?? '')))
  ) {
    throw new ProblemError('passkey_verification_failed', {
      passkey_check: 'nonce',
    });
  }

  const byteList = parsed.map((p) =>
    statementBytes(p.kind, p.statement as never)
  );
  const challenge = encodeBase64url(
    await attestationChallenge(nonceBytes(bundle.nonce), byteList)
  );

  if (input.passkeys === undefined) {
    throw new ProblemError('passkey_required');
  }
  const assertion = await env.assertPasskey(
    input.passkeys,
    bundle.credential,
    challenge,
    env.now
  );
  if (!assertion.ok) {
    throw new ProblemError(assertion.code, { passkey_check: assertion.check });
  }

  const verified: VerifiedStatement[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const { kind, statement } = parsed[i] as (typeof parsed)[number];
    const signature = bundle.statements[i]?.identity_signature ?? '';
    const key = input.signerKey(kind, statement);
    if (key === undefined) refuseStatement('signer');
    const valid = await verifyStatement(
      key,
      byteList[i] as Uint8Array,
      signature
    );
    if (!valid) refuseStatement('signature');
    verified.push({ kind, statement, identitySignature: signature });
  }

  const credential = input.passkeys.credentials.find(
    (c) => c.credentialId === assertion.credentialId
  );
  if (credential === undefined) {
    throw new ProblemError('passkey_verification_failed', {
      passkey_check: 'credential',
    });
  }

  return {
    credentialId: assertion.credentialId,
    statements: verified,
    attestation: {
      statements: verified.map((v) => ({
        kind: v.kind,
        statement: v.statement,
        identitySignature: v.identitySignature,
      })),
      nonce: bundle.nonce,
      credential: bundle.credential as never,
      credentialId: assertion.credentialId,
      credentialPublicKeyJwk: credential.publicKeyJwk,
      credentialAlg: credential.alg,
      rpId: new URL(env.config.serviceOrigin).hostname,
      origin: new URL(env.config.serviceOrigin).origin,
      verifiedAt: env.now,
    },
  };
}

/**
 * Verifies a stored attestation from its own bytes, with no store access
 * beyond the signer keys the caller supplies. A grant that re-verifies here
 * is a grant the owner actually signed (plan section 9, the offline test).
 */
export async function verifyStoredAttestation(
  attestation: StoredAttestation,
  signerKey: SignerKey
): Promise<boolean> {
  const byteList = attestation.statements.map((s) =>
    statementBytes(s.kind, s.statement as never)
  );
  const challenge = encodeBase64url(
    await attestationChallenge(nonceBytes(attestation.nonce), byteList)
  );
  const credential = attestation.credential as unknown as Record<
    string,
    unknown
  >;
  const response = credential['response'] as Record<string, unknown>;
  const userHandle =
    typeof response['userHandle'] === 'string' ? response['userHandle'] : '';
  try {
    await verifyAssertion(credential, {
      challenge,
      origin: attestation.origin,
      rpId: attestation.rpId,
      stored: {
        credentialId: attestation.credentialId,
        publicKeyJwk: attestation.credentialPublicKeyJwk,
        alg: attestation.credentialAlg,
      },
      userHandle,
    });
  } catch (error) {
    if (error instanceof WebauthnError) return false;
    throw error;
  }
  for (let i = 0; i < attestation.statements.length; i++) {
    const s = attestation.statements[
      i
    ] as (typeof attestation.statements)[number];
    const key = signerKey(s.kind, s.statement);
    if (key === undefined) return false;
    const ok = await verifyStatement(
      key,
      byteList[i] as Uint8Array,
      s.identitySignature
    );
    if (!ok) return false;
  }
  return true;
}
