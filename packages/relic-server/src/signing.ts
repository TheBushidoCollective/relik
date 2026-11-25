import { normalizeEmail } from '@relic/format';
import {
  decodeBase64url,
  parseStatement,
  statementBytes,
  verifyStatement,
  type SigningCancelStatement,
  type SigningRequestStatement,
} from '@relic/format/private';
import {
  layoutCiphertextSha256,
  type SigningRequestJSON,
} from '@relic/format/signing';
import { ProblemError } from './problems.ts';
import type {
  RelicRow,
  SessionRow,
  SigningRequestRow,
  StoredAttestation,
} from './store.ts';
import { verifyAttestation } from './private/attest.ts';
import { currentIdentity, identitySigner } from './private/identity.ts';
import { ownerRecord, publishTokenOk, requireRead } from './private/access.ts';
import {
  deviceJson,
  identityPublicJson,
  type PrivateEnv,
} from './private/context.ts';

function proofJson(proof: StoredAttestation | undefined) {
  return proof === undefined
    ? null
    : {
        nonce: proof.nonce,
        credential: proof.credential,
        credential_id: proof.credentialId,
        public_key_jwk: proof.credentialPublicKeyJwk,
        alg: proof.credentialAlg,
        passkey_registered_at: null,
      };
}

export async function signingRequestView(
  env: PrivateEnv,
  relic: RelicRow,
  request: SigningRequestRow
): Promise<SigningRequestJSON> {
  const statement = parseStatement('signing_request', request.statement);
  const owner = await ownerRecord(env, relic);
  const device =
    request.signerKind === 'device'
      ? await env.store.getDevice(request.signerId)
      : undefined;
  const signatures = await env.store.listSignatures(
    relic.id,
    statement.request_id
  );
  return {
    request_id: statement.request_id,
    version: statement.version,
    status: request.status,
    created_at: new Date(request.createdAt).toISOString(),
    completed_at:
      request.completedAt === undefined
        ? null
        : new Date(request.completedAt).toISOString(),
    cancelled_at:
      request.cancelledAt === undefined
        ? null
        : new Date(request.cancelledAt).toISOString(),
    request: {
      statement: request.statement,
      signature: request.signature,
      signer_kind: request.signerKind,
      attestation: proofJson(request.attestation),
      layout_ciphertext: request.layoutCiphertext,
    },
    owner: {
      identity: identityPublicJson(owner),
      device: device === undefined ? null : deviceJson(device),
    },
    signers: await Promise.all(
      statement.signers.map(async (signer, index) => {
        const identity =
          signer.identity_id === null
            ? undefined
            : await env.store.getIdentity(signer.identity_id);
        const signature = signatures.find((s) => s.signerIndex === index);
        const signed = signature?.attestation.statements[0];
        return {
          index,
          email: signer.email,
          identity:
            identity === undefined ? null : identityPublicJson(identity),
          status:
            signature !== undefined
              ? ('signed' as const)
              : statement.order === 'sequential' && signatures.length < index
                ? ('waiting' as const)
                : ('ready' as const),
          served_at: null,
          opened_at: null,
          signature:
            signature === undefined || signed === undefined
              ? null
              : {
                  statement: signed.statement,
                  identity_signature: signed.identitySignature,
                  mark_ciphertext: signature.markCiphertext,
                  webauthn: proofJson(signature.attestation)!,
                  recorded_at: new Date(signature.recordedAt).toISOString(),
                  opened_receipt:
                    signature.openedReceipt?.statement !== undefined &&
                    signature.openedReceipt.identitySignature !== undefined
                      ? {
                          statement: signature.openedReceipt.statement,
                          identity_signature:
                            signature.openedReceipt.identitySignature,
                        }
                      : null,
                },
        };
      })
    ),
    cancellation:
      request.cancellation === undefined
        ? null
        : {
            statement: request.cancellation.statement,
            signature: request.cancellation.signature,
            signer_kind: request.cancellation.signerKind,
            attestation: proofJson(request.cancellation.attestation),
          },
  };
}

export async function createSigningRequest(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>,
  digest: (row: RelicRow, version: number) => Promise<string>
): Promise<SigningRequestJSON> {
  const owner = await ownerRecord(env, row);
  let statement: SigningRequestStatement;
  let signature: string;
  let signerKind: 'identity' | 'device';
  let attestation: StoredAttestation | undefined;
  if ('publish_token' in body) {
    if (!(await publishTokenOk(row, body.publish_token)))
      throw new ProblemError('invalid_publish_token');
    const signed = body.request;
    if (signed === null || typeof signed !== 'object' || Array.isArray(signed))
      throw new ProblemError('invalid_statement', { statement_check: 'shape' });
    const input = signed as Record<string, unknown>;
    try {
      statement = parseStatement('signing_request', input.statement);
    } catch {
      throw new ProblemError('invalid_statement', { statement_check: 'shape' });
    }
    if (
      input.signer_kind !== 'device' ||
      typeof input.device_id !== 'string' ||
      input.device_id !== statement.signer_id ||
      typeof input.signature !== 'string'
    )
      throw new ProblemError('invalid_device');
    const device = await env.store.getDevice(input.device_id);
    if (device === undefined) throw new ProblemError('device_not_found');
    if (
      device.ownerIdentityId !== owner.identityId ||
      statement.owner_identity_id !== owner.identityId
    )
      throw new ProblemError('owner_required');
    if (device.revokedAt !== undefined || device.notAfter < env.now)
      throw new ProblemError('device_revoked');
    if (
      statement.relic_id !== row.id ||
      Math.abs(env.now - statement.at) >
        env.config.passkeyChallengeTtlSeconds * 1000
    )
      throw new ProblemError('invalid_statement', { statement_check: 'stale' });
    if (
      !(await verifyStatement(
        decodeBase64url(device.sigPublicKey),
        statementBytes('signing_request', statement),
        input.signature
      ))
    )
      throw new ProblemError('invalid_statement', {
        statement_check: 'signature',
      });
    signature = input.signature;
    signerKind = 'device';
  } else {
    if (session === undefined) throw new ProblemError('sign_in_required');
    const identity = await currentIdentity(env, normalizeEmail(session.email));
    if (identity === undefined) throw new ProblemError('identity_required');
    if (identity.identityId !== owner.identityId)
      throw new ProblemError('owner_required');
    const verified = await verifyAttestation(env, {
      bundle: body.attestation,
      purpose: 'signing_request',
      email: identity.email,
      passkeys: await env.store.getPasskeys(identity.email),
      signerKey: identitySigner(identity),
      relicId: row.id,
    });
    if (
      !identity.credentials.some(
        (c) => c.credentialId === verified.credentialId
      )
    )
      throw new ProblemError('passkey_verification_failed', {
        passkey_check: 'credential',
      });
    statement = parseStatement(
      'signing_request',
      verified.statements[0]?.statement
    );
    if (
      statement.owner_identity_id !== owner.identityId ||
      statement.signer_id !== owner.identityId
    )
      throw new ProblemError('owner_required');
    signature = verified.statements[0]!.identitySignature;
    signerKind = 'identity';
    attestation = verified.attestation;
  }
  if (row.expiresAt !== undefined && row.expiresAt <= env.now)
    throw new ProblemError('relic_expired', { relic_id: row.id });
  if (row.settings?.signing === false) throw new ProblemError('signing_closed');
  if (row.access !== 'private' && row.shareVerifier === undefined)
    throw new ProblemError('share_unavailable');
  const invalid = (check: string): never => {
    throw new ProblemError('invalid_signing_request', { signing_check: check });
  };
  if (statement.version !== row.version) invalid('version');
  if (
    row.publishedAt === undefined ||
    (row.access === 'private' && row.sealedVersion !== row.version)
  )
    invalid('published');
  if (
    statement.signers.length < 1 ||
    statement.signers.length > env.config.signingMaxSigners
  )
    invalid('signers');
  if (
    row.access !== 'private' &&
    (statement.require_opened ||
      statement.signers.some((s) => s.identity_id !== null))
  )
    invalid('require_opened');
  if (
    row.access === 'private' &&
    statement.signers.some((s) => s.identity_id === null)
  )
    invalid('signers');
  const layout = body.layout_ciphertext;
  if (
    typeof layout !== 'string' ||
    layout.length > env.config.signingLayoutMaxChars ||
    !/^[A-Za-z0-9_-]+$/.test(layout)
  )
    invalid('layout');
  try {
    if (
      decodeBase64url(layout as string).length < 28 ||
      layoutCiphertextSha256(layout as string) !== statement.layout_sha256
    )
      invalid('layout');
  } catch {
    invalid('layout');
  }
  const versionDigest = await digest(row, statement.version);
  if (statement.ciphertext_sha256 !== versionDigest)
    throw new ProblemError('signing_digest_mismatch', {
      version_digest: versionDigest,
    });
  if (row.lockedVersions?.includes(statement.version))
    throw new ProblemError('version_locked', {
      locked_version: statement.version,
    });
  if (row.signingOpen !== undefined)
    throw new ProblemError('signing_in_progress');
  if (row.access === 'private') {
    const seen = new Set<string>();
    for (const signer of statement.signers) {
      const identity = await currentIdentity(env, signer.email);
      if (
        identity === undefined ||
        identity.identityId !== signer.identity_id ||
        seen.has(identity.identityId)
      )
        throw new ProblemError('signer_without_access', {
          signer_email: signer.email,
        });
      seen.add(identity.identityId);
      try {
        await requireRead(env, row, owner, identity, statement.version);
      } catch {
        throw new ProblemError('signer_without_access', {
          signer_email: signer.email,
        });
      }
    }
  }
  const record: SigningRequestRow = {
    statement: statement as unknown as Record<string, unknown>,
    signature,
    signerKind,
    signerId: statement.signer_id,
    ...(attestation === undefined ? {} : { attestation }),
    layoutCiphertext: layout as string,
    status: 'open',
    createdAt: env.now,
  };
  if (
    !(await env.store.putSigningRequest(row.id, statement.request_id, record))
  )
    invalid('request_id');
  try {
    const updated = await env.store.updateRelic(row.id, (current) => {
      if (current.signingOpen !== undefined)
        throw new ProblemError('signing_in_progress');
      if (current.lockedVersions?.includes(statement.version))
        throw new ProblemError('version_locked', {
          locked_version: statement.version,
        });
      if (
        current.version !== statement.version ||
        current.deletedVersions?.includes(statement.version)
      )
        invalid('version');
      if (current.settings?.signing === false)
        throw new ProblemError('signing_closed');
      if (current.expiresAt !== undefined && current.expiresAt <= env.now)
        throw new ProblemError('relic_expired', { relic_id: current.id });
      return {
        ...current,
        signingOpen: {
          requestId: statement.request_id,
          version: statement.version,
        },
      };
    });
    if (updated === undefined) throw new ProblemError('relic_not_found');
    return signingRequestView(env, updated, record);
  } catch (error) {
    await env.store.updateSigningRequest(
      row.id,
      statement.request_id,
      (current) => ({ ...current, status: 'cancelled', cancelledAt: env.now })
    );
    throw error;
  }
}

export async function cancelSigningRequest(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>
): Promise<SigningRequestJSON> {
  const owner = await ownerRecord(env, row);
  let statement: SigningCancelStatement;
  let signature: string;
  let signerKind: 'identity' | 'device';
  let attestation: StoredAttestation | undefined;
  if ('publish_token' in body) {
    if (!(await publishTokenOk(row, body.publish_token)))
      throw new ProblemError('invalid_publish_token');
    const value = body.cancel;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new ProblemError('invalid_statement', { statement_check: 'shape' });
    const input = value as Record<string, unknown>;
    try {
      statement = parseStatement('signing_cancel', input.statement);
    } catch {
      throw new ProblemError('invalid_statement', { statement_check: 'shape' });
    }
    if (
      input.signer_kind !== 'device' ||
      typeof input.device_id !== 'string' ||
      input.device_id !== statement.signer_id ||
      typeof input.signature !== 'string'
    )
      throw new ProblemError('invalid_device');
    const device = await env.store.getDevice(input.device_id);
    if (device === undefined) throw new ProblemError('device_not_found');
    if (
      device.ownerIdentityId !== owner.identityId ||
      statement.owner_identity_id !== owner.identityId
    )
      throw new ProblemError('owner_required');
    if (device.revokedAt !== undefined || device.notAfter < env.now)
      throw new ProblemError('device_revoked');
    if (
      statement.relic_id !== row.id ||
      Math.abs(env.now - statement.at) >
        env.config.passkeyChallengeTtlSeconds * 1000
    )
      throw new ProblemError('invalid_statement', { statement_check: 'stale' });
    if (
      !(await verifyStatement(
        decodeBase64url(device.sigPublicKey),
        statementBytes('signing_cancel', statement),
        input.signature
      ))
    )
      throw new ProblemError('invalid_statement', {
        statement_check: 'signature',
      });
    signature = input.signature;
    signerKind = 'device';
  } else {
    if (session === undefined) throw new ProblemError('sign_in_required');
    const identity = await currentIdentity(env, normalizeEmail(session.email));
    if (identity === undefined) throw new ProblemError('identity_required');
    if (identity.identityId !== owner.identityId)
      throw new ProblemError('owner_required');
    const verified = await verifyAttestation(env, {
      bundle: body.attestation,
      purpose: 'signing_cancel',
      email: identity.email,
      passkeys: await env.store.getPasskeys(identity.email),
      signerKey: identitySigner(identity),
      relicId: row.id,
    });
    if (
      !identity.credentials.some(
        (c) => c.credentialId === verified.credentialId
      )
    )
      throw new ProblemError('passkey_verification_failed', {
        passkey_check: 'credential',
      });
    statement = parseStatement(
      'signing_cancel',
      verified.statements[0]?.statement
    );
    if (
      statement.owner_identity_id !== owner.identityId ||
      statement.signer_id !== owner.identityId
    )
      throw new ProblemError('owner_required');
    signature = verified.statements[0]!.identitySignature;
    signerKind = 'identity';
    attestation = verified.attestation;
  }
  if (row.expiresAt !== undefined && row.expiresAt <= env.now)
    throw new ProblemError('relic_expired', { relic_id: row.id });
  const updated = await env.store.updateSigningRequest(
    row.id,
    statement.request_id,
    (current) => {
      if (current.status === 'cancelled') return current;
      if (current.status !== 'open')
        throw new ProblemError('signing_request_closed');
      return {
        ...current,
        status: 'cancelled',
        cancelledAt: env.now,
        cancellation: {
          statement: statement as unknown as Record<string, unknown>,
          signature,
          signerKind,
          ...(attestation === undefined ? {} : { attestation }),
        },
      };
    }
  );
  if (updated === undefined)
    throw new ProblemError('signing_request_not_found');
  const next = await env.store.updateRelic(row.id, (current) => {
    if (current.signingOpen?.requestId !== statement.request_id) return current;
    const { signingOpen: _open, ...rest } = current;
    return rest;
  });
  if (next === undefined) throw new ProblemError('relic_not_found');
  return signingRequestView(env, next, updated);
}
