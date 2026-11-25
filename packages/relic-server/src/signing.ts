import { normalizeEmail } from '@relic/format';
import {
  decodeBase64url,
  InvalidStatementError,
  parseStatement,
  statementBytes,
  verifyStatement,
  type OpenReceiptStatement,
  type SigningCancelStatement,
  type SigningRequestStatement,
} from '@relic/format/private';
import {
  layoutCiphertextSha256,
  markCiphertextSha256,
  openReceiptSha256,
  SIGN_CONSENT_ID,
  SIGN_CONSENT_TEXT,
  verifySigningCertificate,
  signingRequestSha256,
  type SigningRequestJSON,
  type SigningStateJSON,
} from '@relic/format/signing';
import { ProblemError } from './problems.ts';
import { signingNoticeMail } from './mail.ts';
import type {
  RelicRow,
  SessionRow,
  SigningRequestRow,
  StoredAttestation,
} from './store.ts';
import { issueAttestNonce, verifyAttestation, verifyStoredAttestation } from './private/attest.ts';
import { currentIdentity, identitySigner } from './private/identity.ts';
import {
  ownerRecord,
  publishTokenOk,
  requireRead,
  standingOf,
} from './private/access.ts';
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
  request: SigningRequestRow,
  showReceipts = true
): Promise<SigningRequestJSON> {
  const statement = parseStatement('signing_request', request.statement);
  const owner = await ownerRecord(env, relic);
  const device =
    request.signerKind === 'device'
      ? await env.store.getDevice(request.signerId)
      : undefined;
  const signatures = (await env.store.listSignatures(
    relic.id,
    statement.request_id
  )).filter((signature) => request.signedBy?.includes(signature.signerIndex));
  const receipts = showReceipts
    ? await env.store.listReceipts(relic.id, statement.version)
    : [];
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
        const served = receipts.find(
          (r) => r.identityId === signer.identity_id && r.kind === 'served'
        );
        const opened = receipts.find(
          (r) => r.identityId === signer.identity_id && r.kind === 'opened'
        );
        let needsAccess = false;
        if (relic.access === 'private' && signature === undefined) {
          const current = await currentIdentity(env, signer.email);
          if (
            identity === undefined ||
            current?.identityId !== identity.identityId
          ) {
            needsAccess = true;
          } else {
            try {
              await requireRead(env, relic, owner, identity, statement.version);
            } catch (error) {
              if (!(error instanceof ProblemError)) throw error;
              needsAccess = true;
            }
          }
        }
        return {
          index,
          email: signer.email,
          identity:
            identity === undefined ? null : identityPublicJson(identity),
          status:
            signature !== undefined
              ? ('signed' as const)
              : needsAccess
                ? ('needs_access' as const)
                : statement.order === 'sequential' &&
                    statement.signers
                      .slice(0, index)
                      .some(
                        (_, prior) =>
                          !signatures.some((item) => item.signerIndex === prior)
                      )
                  ? ('waiting' as const)
                  : ('ready' as const),
          served_at:
            served === undefined ? null : new Date(served.at).toISOString(),
          opened_at:
            opened === undefined ? null : new Date(opened.at).toISOString(),
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
                    showReceipts &&
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

function parseSigningRequest(value: unknown): SigningRequestStatement {
  try {
    return parseStatement('signing_request', value);
  } catch (error) {
    if (!(error instanceof InvalidStatementError)) throw error;
    const check =
      error.check === 'signers' || error.field === 'signers'
        ? 'signers'
        : error.check === 'require_opened' || error.field === 'require_opened'
          ? 'require_opened'
          : error.field === 'request_id'
            ? 'request_id'
            : error.field === 'version'
              ? 'version'
              : undefined;
    if (check !== undefined)
      throw new ProblemError('invalid_signing_request', {
        signing_check: check,
      });
    throw new ProblemError('invalid_statement', {
      statement_check: error.check,
    });
  }
}

export async function createSigningRequest(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>,
  digest: (row: RelicRow, version: number) => Promise<string>
): Promise<SigningRequestJSON> {
  if (
    'publish_token' in body &&
    !(await publishTokenOk(row, body.publish_token))
  )
    throw new ProblemError('invalid_publish_token');
  if (!('publish_token' in body) && session === undefined)
    throw new ProblemError('sign_in_required');
  const identity =
    session === undefined || 'publish_token' in body
      ? undefined
      : await currentIdentity(env, normalizeEmail(session.email));
  if (!('publish_token' in body) && identity === undefined)
    throw new ProblemError('identity_required');
  const owner = await ownerRecord(env, row);
  let statement: SigningRequestStatement;
  let signature: string;
  let signerKind: 'identity' | 'device';
  let attestation: StoredAttestation | undefined;
  if ('publish_token' in body) {
    const signed = body.request;
    if (signed === null || typeof signed !== 'object' || Array.isArray(signed))
      throw new ProblemError('invalid_statement', { statement_check: 'shape' });
    const input = signed as Record<string, unknown>;
    statement = parseSigningRequest(input.statement);
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
    if (statement.at < device.certifiedAt)
      throw new ProblemError('invalid_device');
    if (
      device.revokedAt !== undefined ||
      device.notAfter < env.now ||
      device.notAfter < statement.at
    )
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
    if (identity === undefined) throw new ProblemError('identity_required');
    if (identity.identityId !== owner.identityId)
      throw new ProblemError('owner_required');
    const bundle = body.attestation;
    if (
      bundle !== null &&
      typeof bundle === 'object' &&
      !Array.isArray(bundle)
    ) {
      const statements = (bundle as Record<string, unknown>).statements;
      if (
        Array.isArray(statements) &&
        statements.length === 1 &&
        statements[0]?.kind === 'signing_request'
      ) {
        parseSigningRequest(statements[0].statement);
      }
    }
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
  if (row.access !== 'private' && !row.shareVerifier)
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
      const grant = await env.store.getGrant(row.id, identity.identityId);
      if (
        grant === undefined ||
        grant.revokedAt !== undefined ||
        !grant.versions.includes(statement.version)
      ) {
        throw new ProblemError('signer_without_access', {
          signer_email: signer.email,
        });
      }
      try {
        await requireRead(env, row, owner, identity, statement.version);
      } catch (error) {
        if (!(error instanceof ProblemError)) throw error;
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
  let updated: RelicRow | undefined;
  try {
    updated = await env.store.updateRelic(row.id, (current) => {
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
      if (current.ownerIdentityId !== owner.identityId)
        throw new ProblemError('owner_required');
      if (
        current.access === 'private' &&
        (current.accessEpoch ?? 0) !== (row.accessEpoch ?? 0)
      ) {
        throw new ProblemError('signer_without_access');
      }
      if (
        current.publishedAt === undefined ||
        (current.access === 'private' &&
          current.sealedVersion !== current.version)
      )
        invalid('published');
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
  } catch (error) {
    const latest = await env.store.getRelic(row.id);
    if (latest?.signingOpen?.requestId !== statement.request_id) {
      await env.store.updateSigningRequest(
        row.id,
        statement.request_id,
        (current) => ({ ...current, status: 'cancelled', cancelledAt: env.now })
      );
    }
    throw error;
  }
  if ((await env.store.getTombstone(row.id)) !== undefined) {
    await env.store.deleteSigningForRelic(row.id);
    throw new ProblemError('relic_removed', { relic_id: row.id });
  }
  if (row.access === 'private') {
    const recipients = statement.order === 'parallel' ? statement.signers : statement.signers.slice(0, 1);
    for (const signer of recipients) await sendSigningNotice(env, row, signer.email, 'invite');
  }
  return signingRequestView(env, updated, record);
}

export async function cancelSigningRequest(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>
): Promise<SigningRequestJSON> {
  if (
    'publish_token' in body &&
    !(await publishTokenOk(row, body.publish_token))
  )
    throw new ProblemError('invalid_publish_token');
  if (!('publish_token' in body) && session === undefined)
    throw new ProblemError('sign_in_required');
  const identity =
    session === undefined || 'publish_token' in body
      ? undefined
      : await currentIdentity(env, normalizeEmail(session.email));
  if (!('publish_token' in body) && identity === undefined)
    throw new ProblemError('identity_required');
  const owner = await ownerRecord(env, row);
  let statement: SigningCancelStatement;
  let signature: string;
  let signerKind: 'identity' | 'device';
  let attestation: StoredAttestation | undefined;
  if ('publish_token' in body) {
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
    if (statement.at < device.certifiedAt)
      throw new ProblemError('invalid_device');
    if (
      device.revokedAt !== undefined ||
      device.notAfter < env.now ||
      device.notAfter < statement.at
    )
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
  let cancelledNow = false;
  const updated = await env.store.updateSigningRequest(
    row.id,
    statement.request_id,
    (current) => {
      cancelledNow = current.status === 'open';
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
  if (cancelledNow) {
    const original = parseStatement('signing_request', updated.statement);
    for (const signer of original.signers) await sendSigningNotice(env, row, signer.email, 'cancelled');
  }
  return signingRequestView(env, next, updated);
}

export async function readSigningState(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>,
  checkProof: (row: RelicRow, proof: unknown) => Promise<string>
): Promise<SigningStateJSON> {
  const requests = (await env.store.listSigningRequests(row.id)).filter(
    (request) =>
      request.status === 'complete' ||
      (request.status === 'cancelled' && request.cancellation !== undefined) ||
      (request.status === 'open' &&
        request.statement['request_id'] === row.signingOpen?.requestId)
  );
  const email =
    session === undefined ? undefined : normalizeEmail(session.email);
  const identity =
    email === undefined ? undefined : await currentIdentity(env, email);
  let owner = false;
  if ('publish_token' in body) {
    if (!(await publishTokenOk(row, body.publish_token)))
      throw new ProblemError('invalid_publish_token');
    owner = true;
  } else if (row.access !== 'private') {
    if ((await checkProof(row, body.share_proof)) !== 'ok')
      throw new ProblemError('invalid_share_proof');
    owner =
      identity !== undefined && identity.identityId === row.ownerIdentityId;
  } else {
    if (session === undefined) throw new ProblemError('sign_in_required');
    const ownerIdentity = await ownerRecord(env, row);
    const standing = await standingOf(env, row, ownerIdentity, identity);
    owner = standing.role === 'owner';
    const isListed = requests.some((request) => {
      const statement = parseStatement('signing_request', request.statement);
      return statement.signers.some(
        (signer) =>
          signer.email === email && signer.identity_id === identity?.identityId
      );
    });
    if (
      !owner &&
      standing.role !== 'grantee' &&
      standing.role !== 'recovery' &&
      !isListed
    )
      throw new ProblemError('private_access_denied');
  }
  for (const request of requests) {
    if (request.status === 'complete') await finishCompletion(env, row, request);
  }
  const views = await Promise.all(
    requests.map((request) => signingRequestView(env, row, request, owner))
  );
  const current = requests.find(
    (request) =>
      request.status === 'open' &&
      request.statement['request_id'] === row.signingOpen?.requestId
  );
  let me: SigningStateJSON['me'] = null;
  if (current !== undefined && email !== undefined) {
    const statement = parseStatement('signing_request', current.statement);
    const index = statement.signers.findIndex(
      (signer) =>
        signer.email === email &&
        (row.access !== 'private' ||
          signer.identity_id === identity?.identityId)
    );
    if (index >= 0) {
      const receipts =
        identity === undefined
          ? []
          : await env.store.listReceipts(row.id, statement.version);
      const own = receipts.filter((r) => r.identityId === identity?.identityId);
      const served = own.find((r) => r.kind === 'served');
      const opened = own.find((r) => r.kind === 'opened');
      me = {
        signer_index: index,
        served_at:
          served === undefined ? null : new Date(served.at).toISOString(),
        opened_at:
          opened === undefined ? null : new Date(opened.at).toISOString(),
      };
    }
  }
  return {
    relic_id: row.id,
    current_version: row.version,
    locked_versions: row.lockedVersions ?? [],
    me,
    requests: views,
  };
}

export async function signingOptions(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>,
  checkProof: (row: RelicRow, proof: unknown) => Promise<string>,
  digest: (row: RelicRow, version: number) => Promise<string>
) {
  if ('publish_token' in body) throw new ProblemError('signing_requires_reader');
  if (session === undefined) throw new ProblemError('sign_in_required');
  if (row.access !== 'private' && (await checkProof(row, body.share_proof)) !== 'ok')
    throw new ProblemError('invalid_share_proof');
  if (row.expiresAt !== undefined && row.expiresAt <= env.now)
    throw new ProblemError('relic_expired', { relic_id: row.id });
  const requestId = body.request_id;
  if (typeof requestId !== 'string')
    throw new ProblemError('signing_request_not_found');
  const request = await env.store.getSigningRequest(row.id, requestId);
  if (request === undefined) throw new ProblemError('signing_request_not_found');
  if (request.status !== 'open' || row.signingOpen?.requestId !== requestId)
    throw new ProblemError('signing_request_closed');
  if (row.settings?.signing === false) throw new ProblemError('signing_closed');
  const statement = parseStatement('signing_request', request.statement);
  const email = normalizeEmail(session.email);
  const index = statement.signers.findIndex((signer) => signer.email === email);
  if (index < 0) throw new ProblemError('not_a_signer');
  const signatures = (await env.store.listSignatures(row.id, requestId))
    .filter((signature) => request.signedBy?.includes(signature.signerIndex));
  if (signatures.some((signature) => signature.signerIndex === index))
    throw new ProblemError('already_signed');
  if (
    statement.order === 'sequential' &&
    statement.signers.slice(0, index).some(
      (_, prior) => !signatures.some((signature) => signature.signerIndex === prior)
    )
  ) throw new ProblemError('signing_not_your_turn');
  const identity = row.access === 'private' ? await currentIdentity(env, email) : undefined;
  let openedReceiptSha256: string | null = null;
  if (row.access === 'private') {
    if (identity === undefined) throw new ProblemError('identity_required');
    if (identity.identityId !== statement.signers[index]?.identity_id)
      throw new ProblemError('signer_identity_changed');
    await requireRead(env, row, await ownerRecord(env, row), identity, statement.version);
    if (statement.require_opened) {
      const receipt = (await env.store.listReceipts(row.id, statement.version)).find(
        (item) => item.identityId === identity.identityId && item.kind === 'opened'
      );
      if (receipt?.statement === undefined || receipt.identitySignature === undefined)
        throw new ProblemError('signing_open_required');
      openedReceiptSha256 = openReceiptSha256(parseStatement('open_receipt', receipt.statement));
    }
  }
  const options = await issueAttestNonce(env, {
    email,
    purpose: 'sign',
    relicId: row.id,
    passkeys: await env.store.getPasskeys(email),
    ...(identity === undefined ? {} : {
      allowedCredentialIds: identity.credentials.map((credential) => credential.credentialId),
    }),
  });
  return {
    ...options,
    request_id: requestId,
    version: statement.version,
    version_digest: await digest(row, statement.version),
    content_mac: statement.content_mac,
    request_sha256: signingRequestSha256(statement),
    signer_index: index,
    signer_identity_id: identity?.identityId ?? null,
    opened_receipt_sha256: openedReceiptSha256,
    consent: { id: SIGN_CONSENT_ID, text: SIGN_CONSENT_TEXT },
  };
}

export async function recordSignature(
  env: PrivateEnv,
  row: RelicRow,
  session: SessionRow | undefined,
  body: Record<string, unknown>,
  checkProof: (row: RelicRow, proof: unknown) => Promise<string>,
  digest: (row: RelicRow, version: number) => Promise<string>
) {
  if ('publish_token' in body) throw new ProblemError('signing_requires_reader');
  if (session === undefined) throw new ProblemError('sign_in_required');
  if (row.access !== 'private' && (await checkProof(row, body.share_proof)) !== 'ok')
    throw new ProblemError('invalid_share_proof');
  if (row.expiresAt !== undefined && row.expiresAt <= env.now)
    throw new ProblemError('relic_expired', { relic_id: row.id });
  const requestId = body.request_id;
  if (typeof requestId !== 'string') throw new ProblemError('signing_request_not_found');
  const request = await env.store.getSigningRequest(row.id, requestId);
  if (request === undefined) throw new ProblemError('signing_request_not_found');
  if (request.status !== 'open' || row.signingOpen?.requestId !== requestId)
    throw new ProblemError('signing_request_closed');
  if (row.settings?.signing === false) throw new ProblemError('signing_closed');
  const email = normalizeEmail(session.email);
  const identity = row.access === 'private' ? await currentIdentity(env, email) : undefined;
  if (row.access === 'private' && identity === undefined) throw new ProblemError('identity_required');
  const verified = await verifyAttestation(env, {
    bundle: body.attestation, purpose: 'sign', email,
    passkeys: await env.store.getPasskeys(email),
    signerKey: identity === undefined ? () => undefined : identitySigner(identity),
    relicId: row.id, identityFree: row.access !== 'private',
  });
  if (identity !== undefined && !identity.credentials.some((credential) => credential.credentialId === verified.credentialId))
    throw new ProblemError('passkey_verification_failed', { passkey_check: 'credential' });
  const statement = parseStatement('signing_request', request.statement);
  const signature = parseStatement('signature', verified.statements[0]?.statement);
  const index = statement.signers.findIndex((signer) => signer.email === email);
  if (index < 0) throw new ProblemError('not_a_signer');
  if (identity !== undefined) {
    if (identity.identityId !== statement.signers[index]?.identity_id)
      throw new ProblemError('signer_identity_changed');
    await requireRead(env, row, await ownerRecord(env, row), identity, statement.version);
  }
  const signedBy = request.signedBy ?? [];
  if (statement.order === 'sequential' && statement.signers.slice(0, index).some((_, prior) => !signedBy.includes(prior)))
    throw new ProblemError('signing_not_your_turn');
  const receipt = identity === undefined ? undefined :
    (await env.store.listReceipts(row.id, statement.version)).find((item) => item.identityId === identity.identityId && item.kind === 'opened');
  if (statement.require_opened && (receipt?.statement === undefined || receipt.identitySignature === undefined))
    throw new ProblemError('signing_open_required');
  const receiptHash = statement.require_opened && receipt?.statement !== undefined
    ? openReceiptSha256(parseStatement('open_receipt', receipt.statement)) : null;
  const mark = body.mark_ciphertext;
  if (typeof mark !== 'string' || mark.length > env.config.signingMarkMaxChars || !/^[A-Za-z0-9_-]+$/.test(mark))
    throw new ProblemError('invalid_signature', { signing_check: 'mark' });
  try {
    if (decodeBase64url(mark).length < 28 || markCiphertextSha256(mark) !== signature.mark_sha256)
      throw new ProblemError('invalid_signature', { signing_check: 'mark' });
  } catch {
    throw new ProblemError('invalid_signature', { signing_check: 'mark' });
  }
  if (signature.relic_id !== row.id || signature.version !== statement.version ||
      signature.request_id !== requestId || signature.request_sha256 !== signingRequestSha256(statement) ||
      signature.signer_index !== index || signature.signer_email !== email ||
      signature.signer_identity_id !== (identity?.identityId ?? null) ||
      signature.opened_receipt_sha256 !== receiptHash || signature.consent !== SIGN_CONSENT_ID)
    throw new ProblemError('invalid_signature', { signing_check: 'binding' });
  const versionDigest = await digest(row, statement.version);
  if (signature.ciphertext_sha256 !== versionDigest || statement.ciphertext_sha256 !== versionDigest)
    throw new ProblemError('signing_digest_mismatch', { version_digest: versionDigest });
  if (signature.content_mac !== statement.content_mac) throw new ProblemError('signing_content_mismatch');
  if (signedBy.includes(index)) throw new ProblemError('already_signed');
  let recordedAt = env.now;
  if (!await env.store.putSignature(row.id, requestId, {
    signerIndex: index, email, attestation: verified.attestation, markCiphertext: mark,
    recordedAt: env.now, ...(receipt === undefined ? {} : { openedReceipt: receipt }),
  })) {
    const stored = (await env.store.listSignatures(row.id, requestId))
      .find((item) => item.signerIndex === index);
    if (stored === undefined) throw new ProblemError('already_signed');
    const old = parseStatement('signature', stored.attestation.statements[0]?.statement);
    const signerKey = identity === undefined ? () => undefined : identitySigner(identity);
    if (stored.email !== email || old.relic_id !== row.id || old.version !== statement.version ||
        old.request_id !== requestId || old.request_sha256 !== signingRequestSha256(statement) ||
        old.signer_index !== index || old.signer_email !== email ||
        old.signer_identity_id !== (identity?.identityId ?? null) ||
        old.ciphertext_sha256 !== versionDigest || old.content_mac !== statement.content_mac ||
        old.opened_receipt_sha256 !== receiptHash || old.consent !== SIGN_CONSENT_ID ||
        old.mark_sha256 !== markCiphertextSha256(stored.markCiphertext) ||
        stored.attestation.origin !== new URL(env.config.serviceOrigin).origin ||
        (identity !== undefined && !identity.credentials.some((item) => item.credentialId === stored.attestation.credentialId)) ||
        !(await verifyStoredAttestation(stored.attestation, signerKey, identity === undefined)))
      throw new ProblemError('invalid_signature', { signing_check: 'binding' });
    recordedAt = stored.recordedAt;
  }
  const updated = await env.store.updateSigningRequest(row.id, requestId, (current) => {
    if (current.status !== 'open') throw new ProblemError('signing_request_closed');
    const admitted = current.signedBy ?? [];
    if (admitted.includes(index)) throw new ProblemError('already_signed');
    if (statement.order === 'sequential' && statement.signers.slice(0, index).some((_, prior) => !admitted.includes(prior)))
      throw new ProblemError('signing_not_your_turn');
    const next = [...admitted, index];
    return next.length === statement.signers.length
      ? { ...current, signedBy: next, status: 'complete', completedAt: env.now }
      : { ...current, signedBy: next };
  });
  if (updated === undefined) throw new ProblemError('signing_request_not_found');
  await sendSigningNotice(env, row, (await ownerRecord(env, row)).email, 'signed');
  if (updated.status === 'complete') await finishCompletion(env, row, updated);
  else if (statement.order === 'sequential' && statement.signers[index + 1] !== undefined)
    await sendSigningNotice(env, row, statement.signers[index + 1]!.email, 'turn');
  if ((await env.store.getTombstone(row.id)) !== undefined)
    throw new ProblemError('relic_removed', { relic_id: row.id });
  return { request_id: requestId, signer_index: index, recorded_at: new Date(recordedAt).toISOString(), status: updated.status };
}

export async function finishCompletion(env: PrivateEnv, row: RelicRow, request: SigningRequestRow): Promise<void> {
  if (request.status !== 'complete' || request.completedAt === undefined) return;
  const statement = parseStatement('signing_request', request.statement);
  const locked = await env.store.updateRelic(row.id, (current) => {
    if (current.lockedVersions?.includes(statement.version)) return current;
    if (current.signingOpen?.requestId !== statement.request_id)
      throw new ProblemError('signing_request_closed');
    const { signingOpen: _open, ...rest } = current;
    return { ...rest, lockedVersions: [...(current.lockedVersions ?? []), statement.version] };
  });
  if (locked === undefined) throw new ProblemError('relic_not_found');
  const existing = await env.store.getCertificate(row.id, statement.request_id);
  if (existing !== undefined) {
    await sendCompletionNotices(env, row, request, existing);
    return;
  }
  const view = await signingRequestView(env, locked, request, true);
  const signatures = view.signers.map((signer) => {
    if (signer.signature === null) throw new Error('admitted signature missing');
    return {
      signer_index: signer.index,
      statement: signer.signature.statement,
      identity_signature: signer.signature.identity_signature ?? '',
      signer_identity: signer.identity,
      mark_ciphertext: signer.signature.mark_ciphertext,
      webauthn: signer.signature.webauthn,
      recorded_at: signer.signature.recorded_at,
      receipts: row.access === 'private' ? {
        served_at: signer.served_at,
        opened: signer.signature.opened_receipt,
      } : null,
    };
  });
  const origin = new URL(env.config.serviceOrigin).origin;
  const certificate = {
    format: 'relic/signing-certificate/v1',
    service: { origin, rp_id: new URL(origin).hostname },
    relic_id: row.id,
    access: row.access === 'private' ? 'private' : 'public',
    title: row.access === 'private' ? null : row.title ?? null,
    version: statement.version,
    ciphertext_sha256: statement.ciphertext_sha256,
    content_mac: statement.content_mac,
    request: view.request,
    owner: view.owner,
    signatures,
    completed_at: new Date(request.completedAt).toISOString(),
  };
  const report = await verifySigningCertificate(certificate, {
    expectedOrigin: origin, trustedOwnerIdentityId: (await ownerRecord(env, row)).identityId,
  });
  if (!report.valid) throw new Error(`signing certificate failed verification: ${report.checks.filter((check) => !check.ok).map((check) => check.id).join(', ')}`);
  await env.store.putCertificate(row.id, statement.request_id, certificate);
  await sendCompletionNotices(env, row, request, certificate);
}

export async function postOpenedReceipt(
  env: PrivateEnv, row: RelicRow, session: SessionRow | undefined,
  body: Record<string, unknown>
) {
  if (row.access !== 'private') throw new ProblemError('invalid_receipt', { receipt_check: 'public' });
  if (session === undefined) throw new ProblemError('sign_in_required');
  const identity = await currentIdentity(env, normalizeEmail(session.email));
  if (identity === undefined) throw new ProblemError('identity_required');
  if (row.expiresAt !== undefined && row.expiresAt <= env.now)
    throw new ProblemError('relic_expired', { relic_id: row.id });
  let statement: OpenReceiptStatement;
  try {
    statement = parseStatement('open_receipt', body.statement);
  } catch {
    throw new ProblemError('invalid_receipt', { receipt_check: 'shape' });
  }
  if (Math.abs(env.now - statement.at) > env.config.passkeyChallengeTtlSeconds * 1000)
    throw new ProblemError('invalid_statement', { statement_check: 'stale' });
  if (statement.relic_id !== row.id || statement.reader_identity_id !== identity.identityId)
    throw new ProblemError('invalid_receipt', { receipt_check: 'identity' });
  await requireRead(env, row, await ownerRecord(env, row), identity, statement.version);
  const seal = await env.store.getSeal(row.id, statement.version);
  if (seal === undefined || seal.statement['ciphertext_sha256'] !== statement.ciphertext_sha256 ||
      seal.statement['key_commitment'] !== statement.key_commitment)
    throw new ProblemError('invalid_receipt', { receipt_check: 'seal' });
  if (typeof body.identity_signature !== 'string' ||
      !(await verifyStatement(decodeBase64url(identity.sigPublicKey), statementBytes('open_receipt', statement), body.identity_signature)))
    throw new ProblemError('invalid_receipt', { receipt_check: 'signature' });
  const receipts = await env.store.listReceipts(row.id, statement.version);
  const served = receipts.find((item) => item.identityId === identity.identityId && item.kind === 'served');
  if (served === undefined) throw new ProblemError('receipt_not_served');
  const created = await env.store.putReceipt(row.id, {
    version: statement.version, identityId: identity.identityId, kind: 'opened', at: env.now,
    statement: statement as unknown as Record<string, unknown>, identitySignature: body.identity_signature,
  });
  const stored = (await env.store.listReceipts(row.id, statement.version))
    .find((item) => item.identityId === identity.identityId && item.kind === 'opened');
  if (stored === undefined) throw new Error('opened receipt missing after write');
  return { created, body: { relic_id: row.id, version: statement.version,
    served_at: new Date(served.at).toISOString(), opened_at: new Date(stored.at).toISOString() } };
}

export async function readSigningCertificate(
  env: PrivateEnv, row: RelicRow, session: SessionRow | undefined,
  body: Record<string, unknown>,
  checkProof: (row: RelicRow, proof: unknown) => Promise<string>
) {
  await readSigningState(env, row, session, body, checkProof);
  if (typeof body.request_id !== 'string') throw new ProblemError('signing_request_not_found');
  const request = await env.store.getSigningRequest(row.id, body.request_id);
  if (request === undefined) throw new ProblemError('signing_request_not_found');
  if (request.status !== 'complete') throw new ProblemError('certificate_not_ready');
  await finishCompletion(env, row, request);
  const certificate = await env.store.getCertificate(row.id, body.request_id);
  if (certificate === undefined) throw new ProblemError('certificate_not_ready');
  return certificate;
}

async function sendSigningNotice(
  env: PrivateEnv, row: RelicRow, address: string,
  kind: 'invite' | 'turn' | 'signed' | 'complete' | 'cancelled',
  certificate?: Record<string, unknown>, details?: string
): Promise<void> {
  try {
    await env.sendSigningMail?.(row.id, address, (stopUrl) => signingNoticeMail({
      kind, private: row.access === 'private',
      ...(row.title === undefined ? {} : { title: row.title }),
      relicUrl: `${env.config.serviceOrigin}/${row.id}`, stopUrl,
      ...(details === undefined ? {} : { details }),
      ...(certificate === undefined || row.access === 'private' ? {} : {
        certificate: { filename: `relik-${row.id}-v${certificate['version']}-signing.json`, content: new TextEncoder().encode(JSON.stringify(certificate)) },
      }),
    }));
  } catch {
    console.error('relic: signing notice could not be prepared');
  }
}

async function sendCompletionNotices(
  env: PrivateEnv, row: RelicRow, request: SigningRequestRow, certificate: Record<string, unknown>
): Promise<void> {
  if (env.sendSigningMail === undefined) return;
  const statement = parseStatement('signing_request', request.statement);
  let claimed = false;
  await env.store.updateSigningRequest(row.id, statement.request_id, (current) => {
    claimed = current.status === 'complete' && current.completionMailedAt === undefined;
    return claimed ? { ...current, completionMailedAt: env.now } : current;
  });
  if (!claimed) return;
  const signatures = await env.store.listSignatures(row.id, statement.request_id);
  const details = `Version ${statement.version}; digest ${statement.ciphertext_sha256.slice(0, 16)}; expiry ${row.expiresAt === undefined ? 'never' : new Date(row.expiresAt).toISOString()}. ` +
    signatures.filter((item) => request.signedBy?.includes(item.signerIndex))
      .map((item) => `${item.email}: ${new Date(item.recordedAt).toISOString()}`).join('; ');
  const owner = await ownerRecord(env, row);
  for (const address of new Set([owner.email, ...statement.signers.map((signer) => signer.email)]))
    await sendSigningNotice(env, row, address, 'complete', certificate, details);
}
