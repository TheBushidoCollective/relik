/**
 * The private relic's own lifecycle (plan 4.7 and 4.12): access requests,
 * grants, revocations, the recipient set, key delivery, seals, version
 * deletion, hard delete, and the upload grant for an open version.
 *
 * The epochs carry the concurrency story. A grant or a revocation bumps
 * `accessEpoch` after its records are written, and a seal succeeds only if
 * the epoch it was built against is still current. A seal and a grant racing
 * each other therefore end with the grantee wrapped in the new version or
 * with a refusal, never with neither.
 */

import type { PasskeyRecord } from '../store.ts';
import { assertVersionUnlocked } from '../store.ts';
import { settingsView } from '../settings.ts';
import {
  decodeBase64url,
  fingerprintsEqual,
  formatFingerprint,
  identityFingerprint,
  parseStatement,
  parseTypedFingerprint,
  statementBytes,
  verifyStatement,
  InvalidStatementError,
  type GrantJSON,
  type KeyJSON,
  type PartyJSON,
  type PrivateAccessJSON,
  type StatementMap,
} from '@relic/format/private';
import { encryptedSize, isRendererClass, normalizeEmail } from '@relic/format';
import { ProblemError } from '../problems.ts';
import type {
  AccessRequestRow,
  GrantRow,
  IdentityRecord,
  RelicRow,
  SealRow,
  StoredAttestation,
  WrapRow,
} from '../store.ts';
import {
  accessRequestedMail,
  accessGrantedMail,
  directShareMail,
} from '../mail.ts';
import {
  deviceJson,
  iso,
  partyJson,
  type PrivateEnv,
  type SignedStatementJSON,
  liveRelic,
  privateRow,
  signedStatementJson,
} from './context.ts';
import { verifyAttestation, type VerifiedAttestation } from './attest.ts';
import {
  identitySigner,
  currentIdentity,
  parseWrapItem,
  recoveryJson,
  recoveryStatementJson,
} from './identity.ts';
import {
  isDeleted,
  logAccess,
  ownerRecord,
  publishTokenOk,
  readableVersions,
  recipientKeys,
  requireRead,
  standingOf,
} from './access.ts';
import { ownerParty } from './context.ts';
import { verifyOwnerBind } from './devices.ts';

// ---------------------------------------------------------------- helpers

function statementOf(
  verified: VerifiedAttestation,
  index: number
): Record<string, unknown> {
  const s = verified.statements[index]?.statement;
  if (s === undefined) {
    throw new ProblemError('invalid_statement', { statement_check: 'shape' });
  }
  return s;
}

function refuseStatement(check: string): never {
  throw new ProblemError('invalid_statement', { statement_check: check });
}

/** A seal statement parsed, or the seal refusal. */
function parseSeal(value: unknown): StatementMap['seal'] {
  try {
    return parseStatement('seal', value);
  } catch (error) {
    if (error instanceof InvalidStatementError) {
      throw new ProblemError('invalid_seal', { seal_check: error.check });
    }
    throw error;
  }
}

/** A grant as the wire carries it: the owner-signed grant, and its owner-signed revocation once revoked. */
export interface GrantWireJSON extends GrantJSON {
  readonly revocation: SignedStatementJSON | null;
}

function grantJson(grant: GrantRow, grantee: IdentityRecord): GrantWireJSON {
  const signed =
    grant.grantStatement ??
    grant.attestation.statements.find(
      (item) =>
        item.kind === 'grant' &&
        item.statement['grantee_identity_id'] === grant.granteeIdentityId
    );
  return {
    statement: signed?.statement ?? {},
    identity_signature: signed?.identitySignature ?? '',
    granted_at: iso(grant.grantedAt),
    revoked_at: grant.revokedAt === undefined ? null : iso(grant.revokedAt),
    revocation: signedStatementJson(grant.revocation),
    grantee: partyJson(grantee),
  };
}

/** Upload grant for a version, signed for its ciphertext length. */
async function uploadFor(
  env: PrivateEnv,
  relicId: string,
  version: number,
  declaredPlaintextBytes: number,
  expiresAt: number | undefined
) {
  const signed = await env.storage.signUpload(
    env.objectKey(relicId, version),
    encryptedSize(declaredPlaintextBytes),
    env.config.uploadUrlValiditySeconds,
    env.now,
    expiresAt
  );
  return {
    relic_id: relicId,
    version,
    access: 'private' as const,
    relic_expires_at: expiresAt === undefined ? null : iso(expiresAt),
    upload_url: signed.url,
    upload_method: signed.method,
    upload_headers: signed.headers,
    upload_expires_at: iso(signed.expiresAt),
  };
}

// ---------------------------------------------------------------- access view

/** `GET /api/relics/{id}/access` for a private relic, as one signed-in address sees it. */
export async function privateAccessView(
  env: PrivateEnv,
  relicId: string,
  email: string | undefined
): Promise<PrivateAccessJSON> {
  const row = privateRow(await liveRelic(env, relicId));
  const owner = await ownerRecord(env, row);
  const me =
    email === undefined ? undefined : await currentIdentity(env, email);
  const standing = await standingOf(env, row, owner, me);
  const seesOwner =
    standing.role === 'owner' ||
    standing.role === 'grantee' ||
    standing.role === 'recovery' ||
    standing.role === 'revoked';
  const recovery =
    seesOwner && owner.recovery !== undefined
      ? await ownerParty(env.store, owner.recovery.recoveryIdentityId)
      : null;
  const readable =
    me === undefined || standing.role === 'revoked' || standing.role === 'none'
      ? []
      : await readableVersions(env, row, me.kemKeyId);
  return {
    access: 'private',
    relic_id: row.id,
    current_version: row.version,
    sealed_version: row.sealedVersion ?? null,
    expires_at: iso(row.expiresAt ?? 0),
    owner: seesOwner ? partyJson(owner) : null,
    recovery,
    settings:
      standing.role === 'owner' ||
      standing.role === 'grantee' ||
      standing.role === 'recovery'
        ? settingsView(row)
        : null,
    signing:
      standing.role === 'owner' ||
      standing.role === 'grantee' ||
      standing.role === 'recovery'
        ? {
            open_version: row.signingOpen?.version ?? null,
            locked_versions: row.lockedVersions ?? [],
          }
        : null,
    me: {
      role: standing.role,
      identity: me === undefined ? null : identityPublic(me),
      readable_versions: readable,
      deleted_versions: [...(row.deletedVersions ?? [])],
    },
  };
}

function identityPublic(record: IdentityRecord) {
  return partyJson(record).identity;
}

// ---------------------------------------------------------------- requests

/**
 * A signed-in identity asks for access. The request is an attestation of
 * `access_request`, so the owner later reads who asked and what they signed.
 */
export async function requestAccess(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly relicId: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
  }
): Promise<{ status: 'pending'; requested_at: string; created: boolean }> {
  const row = privateRow(await liveRelic(env, input.relicId));
  const owner = await ownerRecord(env, row);
  const me = await currentIdentity(env, input.email);
  if (me === undefined) throw new ProblemError('identity_required');
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'access_request',
    email: me.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(me),
    relicId: row.id,
  });
  const s = statementOf(verified, 0);
  if (s['requester_identity_id'] !== me.identityId) {
    refuseStatement('requester');
  }

  const existing = await env.store.getAccessRequest(row.id, me.identityId);
  if (existing?.status === 'pending' || existing?.status === 'granted') {
    return {
      status: 'pending',
      requested_at: iso(existing.requestedAt),
      created: false,
    };
  }
  const pending = (await env.store.listAccessRequests(row.id)).filter(
    (r) => r.status === 'pending'
  ).length;
  if (pending >= env.config.privatePendingRequestsMax) {
    throw new ProblemError('request_limit_reached');
  }
  const request: AccessRequestRow = {
    relicId: row.id,
    requesterIdentityId: me.identityId,
    requestedAt: env.now,
    status: 'pending',
    attestation: verified.attestation,
  };
  if (existing === undefined) {
    await env.store.putAccessRequest(request);
  } else {
    await env.store.updateAccessRequest(row.id, me.identityId, () => request);
  }
  await logAccess(env, owner.identityId, row.id, 'request', {
    actorIdentityId: me.identityId,
    subjectIdentityId: me.identityId,
  });
  try {
    await env.sendMail(
      owner.email,
      accessRequestedMail({
        requesterAddress: me.email,
        fingerprint: formatFingerprint(
          await identityFingerprint(me.identityId, me.email)
        ),
        requestUrl: `${new URL(env.config.serviceOrigin).origin}/${row.id}?access=requests&grant=${me.identityId}`,
      })
    );
  } catch (error) {
    console.error('relic: access request notice failed:', error);
  }
  return { status: 'pending', requested_at: iso(env.now), created: true };
}

/** The owner's list of requests, each with the signed statement the requester made. */
export async function listRequests(
  env: PrivateEnv,
  email: string,
  relicId: string
): Promise<unknown[]> {
  const { row } = await ownedPrivate(env, email, relicId);
  const out: unknown[] = [];
  for (const request of await env.store.listAccessRequests(row.id)) {
    const requester = await env.store.getIdentity(request.requesterIdentityId);
    if (requester === undefined) continue;
    const s = request.attestation.statements[0];
    out.push({
      requester: partyJson(requester),
      requested_at: iso(request.requestedAt),
      status: request.status,
      statement: s?.statement ?? {},
      identity_signature: s?.identitySignature ?? '',
    });
  }
  return out;
}

export async function declineRequest(
  env: PrivateEnv,
  email: string,
  relicId: string,
  requesterIdentityId: string
): Promise<void> {
  const { row } = await ownedPrivate(env, email, relicId);
  const request = await env.store.getAccessRequest(row.id, requesterIdentityId);
  if (request === undefined) throw new ProblemError('request_not_found');
  await env.store.updateAccessRequest(row.id, requesterIdentityId, (r) => ({
    ...r,
    status: 'declined',
    decidedAt: env.now,
  }));
}

/** The owner's session, the private relic, and the owner record, or the refusal. */
export async function ownedPrivate(
  env: PrivateEnv,
  email: string,
  relicId: string
) {
  const row = privateRow(await liveRelic(env, relicId));
  const owner = await ownerRecord(env, row);
  const me = await currentIdentity(env, email);
  if (me === undefined || me.identityId !== owner.identityId) {
    throw new ProblemError('owner_required', { relic_id: row.id });
  }
  return { row, owner };
}

// ---------------------------------------------------------------- grants

/**
 * Grants a batch of identities the listed sealed versions (plan 3.3 B). One
 * owner attestation names 1 to privateShareMaxPerCall grants. Each grant
 * wraps its versions to the grantee's key. It is logged as `grant` when it
 * answers a pending request, and as `share` otherwise.
 *
 * The order is the race story. Every refusal that does not depend on who is
 * registered comes first, then the direct-share budget, then the refusals
 * that do. Wraps and grant rows are written next, and one epoch
 * compare-and-swap follows. A seal that read the epoch before the bump fails
 * its own CAS and retries. Any failure rolls back what this call wrote; see
 * `rollback` for what that means when another grant or seal raced it.
 */
export async function grantAccess(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly relicId: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
    readonly wraps: unknown;
  }
): Promise<{ status: 201; grants: GrantWireJSON[] }> {
  const { row, owner } = await ownedPrivate(env, input.email, input.relicId);
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'grant',
    email: owner.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(owner),
    relicId: row.id,
  });
  return applyGrants(env, row, owner, verified, input.wraps, false);
}

export async function applyGrants(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord,
  verified: Pick<VerifiedAttestation, 'statements'> & {
    readonly attestation: StoredAttestation;
  },
  rawWraps: unknown,
  signing: boolean
): Promise<{ status: 201; grants: GrantWireJSON[] }> {
  const statements = verified.statements.map((item) => item.statement);

  // Checks that do not depend on who is registered (plan 3.3 B.4).
  const granteeIds = new Set<string>();
  for (const s of statements) {
    if (s['owner_identity_id'] !== owner.identityId) {
      refuseStatement('owner_identity_id');
    }
    const granteeId = String(s['grantee_identity_id']);
    if (granteeIds.has(granteeId)) refuseStatement('grantee');
    granteeIds.add(granteeId);
    const versions = s['versions'] as number[];
    for (const version of versions) {
      if (isDeleted(row, version)) {
        throw new ProblemError('version_deleted', { version });
      }
      if (
        version > (row.sealedVersion ?? 0) ||
        (await env.store.getSeal(row.id, version)) === undefined
      ) {
        throw new ProblemError('private_seal_required', { version });
      }
    }
    if (
      row.sealedVersion === undefined ||
      !versions.includes(row.sealedVersion)
    ) {
      throw new ProblemError('grant_stale_version', {
        current_version: row.version,
      });
    }
  }

  // Who has a pending request decides how each grant is logged. A grant with
  // no pending request spends the owner's direct-share budget (plan 3.3 B.5).
  const pending = new Map<string, boolean>();
  for (const s of statements) {
    const granteeId = String(s['grantee_identity_id']);
    const request = await env.store.getAccessRequest(row.id, granteeId);
    pending.set(granteeId, request?.status === 'pending');
  }
  const direct = statements.filter(
    (s) => pending.get(String(s['grantee_identity_id'])) !== true
  ).length;
  env.limit(
    'direct-share',
    owner.identityId,
    env.config.directShareRateLimit,
    direct
  );

  // Checks that depend on who is registered (plan 3.3 B.6).
  const planned: PlannedGrant[] = [];
  for (const s of statements) {
    const granteeId = String(s['grantee_identity_id']);
    const grantee = await env.store.getIdentity(granteeId);
    if (
      grantee === undefined ||
      grantee.retiredAt !== undefined ||
      grantee.identityId === owner.identityId ||
      grantee.email !== normalizeEmail(String(s['grantee_email']))
    ) {
      refuseStatement('grantee');
    }
    const typed = parseTypedFingerprint(String(s['fingerprint_typed']));
    const computed = await identityFingerprint(
      grantee.identityId,
      grantee.email
    );
    if (typed === undefined || !fingerprintsEqual(typed, computed)) {
      throw new ProblemError('fingerprint_mismatch', {
        grantee_identity_id: grantee.identityId,
      });
    }
    const prior = await env.store.getGrant(row.id, grantee.identityId);
    if (prior !== undefined && prior.revokedAt === undefined) {
      throw new ProblemError('grant_exists', {
        grantee_identity_id: grantee.identityId,
      });
    }
    planned.push({
      grantee,
      versions: [...(s['versions'] as number[])],
      prior,
      pending: pending.get(granteeId) === true,
    });
  }

  // The wraps must cover exactly grantee keys x versions (plan 3.3 B.7).
  if (!Array.isArray(rawWraps)) throw new ProblemError('invalid_wrap');
  const wraps = (rawWraps as unknown[]).map(parseWrapItem);
  const expected = new Set<string>();
  for (const p of planned) {
    for (const v of p.versions) expected.add(`${v}:${p.grantee.kemKeyId}`);
  }
  const seen = new Set(wraps.map((w) => `${w.version}:${w.recipientKeyId}`));
  if (
    wraps.length > env.config.privateBackfillMaxWraps ||
    seen.size !== wraps.length ||
    wraps.length !== expected.size ||
    [...seen].some((k) => !expected.has(k))
  ) {
    throw new ProblemError('invalid_wrap', {
      detail: 'Wraps must cover the granted versions.',
    });
  }
  for (const wrap of wraps) {
    if (wrap.relicId !== undefined && wrap.relicId !== row.id) {
      throw new ProblemError('invalid_wrap');
    }
  }

  const granteeByKey = new Map(
    planned.map((p) => [p.grantee.kemKeyId, p.grantee.identityId] as const)
  );
  const writtenWraps: WrapRow[] = [];
  const created: string[] = [];
  const replaced: { granteeId: string; prior: GrantRow }[] = [];
  const writtenGrants = new Map<string, GrantRow>();

  /** Whether a live grant of this relik, read now, covers a version for a grantee. */
  const covers = async (granteeId: string, version: number) => {
    const live = await env.store.getGrant(row.id, granteeId);
    return (
      live !== undefined &&
      live.revokedAt === undefined &&
      live.versions.includes(version)
    );
  };

  /**
   * Undoes what this call wrote and nothing it did not write.
   *
   * A grant row this call created is removed, and a revoked row it replaced
   * is restored. A wrap this call wrote is removed, unless another role keeps
   * its key current or a live grant covers its version. A wrap that was
   * already there (`putWrap` returned false) is never removed: a wrap for the
   * same version and key opens the same content whoever wrote it. When a
   * seal raced this call (`sealRace`), a key left with no live grant also
   * loses the wraps the seal made for it.
   */
  const rollback = async (sealRace: boolean) => {
    for (const granteeId of created) {
      await env.store.deleteGrant(row.id, granteeId);
    }
    for (const r of replaced) {
      await env.store.updateGrant(row.id, r.granteeId, () => r.prior);
    }
    const keptElsewhere = new Map<string, boolean>();
    for (const p of planned) {
      const keys = await recipientKeys(env, row, owner, {
        exceptGrantee: p.grantee.identityId,
      });
      keptElsewhere.set(p.grantee.kemKeyId, keys.includes(p.grantee.kemKeyId));
    }
    for (const wrap of writtenWraps) {
      if (keptElsewhere.get(wrap.recipientKeyId) === true) continue;
      const granteeId = granteeByKey.get(wrap.recipientKeyId);
      if (granteeId !== undefined && (await covers(granteeId, wrap.version))) {
        continue;
      }
      await env.store.deleteWraps(row.id, {
        version: wrap.version,
        recipientKeyId: wrap.recipientKeyId,
      });
    }
    if (sealRace) {
      for (const p of planned) {
        if (keptElsewhere.get(p.grantee.kemKeyId) === true) continue;
        const live = await env.store.getGrant(row.id, p.grantee.identityId);
        if (live !== undefined && live.revokedAt === undefined) continue;
        await env.store.deleteWraps(row.id, {
          recipientKeyId: p.grantee.kemKeyId,
        });
      }
    }
  };

  let epochStarted = false;
  try {
    for (const wrap of wraps) {
      const record: WrapRow = {
        relicId: row.id,
        version: wrap.version,
        recipientKeyId: wrap.recipientKeyId,
        enc: wrap.enc,
        ct: wrap.ct,
        createdAt: env.now,
        source: 'grant',
      };
      if (await env.store.putWrap(record)) writtenWraps.push(record);
    }

    for (const p of planned) {
      const granteeId = p.grantee.identityId;
      const grantRow: GrantRow = {
        relicId: row.id,
        granteeIdentityId: granteeId,
        ownerIdentityId: owner.identityId,
        versions: [...p.versions],
        grantedAt: env.now,
        attestation: verified.attestation,
        ...(signing
          ? {
              grantStatement: {
                statement: verified.statements.find(
                  (item) => item.statement['grantee_identity_id'] === granteeId
                )!.statement,
                identitySignature: verified.statements.find(
                  (item) => item.statement['grantee_identity_id'] === granteeId
                )!.identitySignature,
              },
            }
          : {}),
      };
      if (p.prior === undefined) {
        // A concurrent grant to this grantee may have won. Its row and its
        // wraps stay; this call's own wraps are rolled back above.
        if (!(await env.store.putGrant(grantRow))) {
          throw new ProblemError('grant_exists', {
            grantee_identity_id: granteeId,
          });
        }
        created.push(granteeId);
      } else {
        const prior = p.prior;
        const updated = await env.store.updateGrant(
          row.id,
          granteeId,
          (cur) => {
            if (cur.revokedAt === undefined) {
              throw new ProblemError('grant_exists', {
                grantee_identity_id: granteeId,
              });
            }
            return grantRow;
          }
        );
        if (updated === undefined) {
          throw new ProblemError('grant_exists', {
            grantee_identity_id: granteeId,
          });
        }
        replaced.push({ granteeId, prior });
      }
      writtenGrants.set(granteeId, grantRow);
    }

    epochStarted = true;
    await env.store.updateRelic(row.id, (cur) => {
      const sealed = cur.sealedVersion;
      if (
        sealed === undefined ||
        planned.some((p) => !p.versions.includes(sealed))
      ) {
        throw new ProblemError('grant_stale_version', {
          current_version: cur.version,
        });
      }
      return { ...cur, accessEpoch: (cur.accessEpoch ?? 0) + 1 };
    });
  } catch (error) {
    await rollback(epochStarted).catch((rollbackError: unknown) => {
      console.error('relic: grant rollback failed:', rollbackError);
    });
    throw error;
  }

  const grants: GrantWireJSON[] = [];
  for (const p of planned) {
    const granteeId = p.grantee.identityId;
    if (p.pending) {
      await env.store
        .updateAccessRequest(row.id, granteeId, (r) => ({
          ...r,
          status: 'granted',
          decidedAt: env.now,
        }))
        .catch(() => undefined);
    }
    await logAccess(
      env,
      owner.identityId,
      row.id,
      p.pending ? 'grant' : 'share',
      {
        actorIdentityId: owner.identityId,
        version: Math.max(...p.versions),
        subjectIdentityId: granteeId,
      }
    );
    if (!signing)
      try {
        await env.sendMail(
          p.grantee.email,
          p.pending
            ? accessGrantedMail({
                relicUrl: `${new URL(env.config.serviceOrigin).origin}/${row.id}`,
              })
            : directShareMail({
                ownerAddress: owner.email,
                fingerprint: formatFingerprint(
                  await identityFingerprint(
                    p.grantee.identityId,
                    p.grantee.email
                  )
                ),
                relicUrl: `${new URL(env.config.serviceOrigin).origin}/${row.id}`,
              })
        );
      } catch {
        console.error('relic: access grant notice failed');
      }
    const stored = await env.store.getGrant(row.id, granteeId);
    grants.push(grantJson(stored ?? writtenGrants.get(granteeId)!, p.grantee));
  }
  return { status: 201, grants };
}

/** One grant of a batch, once the checks that depend on who is registered have passed. */
interface PlannedGrant {
  readonly grantee: IdentityRecord;
  readonly versions: readonly number[];
  /** The grant row this grantee already had, when it was revoked. */
  readonly prior: GrantRow | undefined;
  /** True when the grantee has a pending request this grant answers. */
  readonly pending: boolean;
}

export async function listGrants(
  env: PrivateEnv,
  email: string,
  relicId: string
): Promise<GrantWireJSON[]> {
  await ownedPrivate(env, email, relicId);
  const out: GrantWireJSON[] = [];
  for (const grant of await env.store.listGrants(relicId)) {
    const grantee = await env.store.getIdentity(grant.granteeIdentityId);
    if (grantee !== undefined) out.push(grantJson(grant, grantee));
  }
  return out;
}

// ---------------------------------------------------------------- revocation

/**
 * Revokes one grantee. The grant is marked revoked first, so every access
 * check refuses at once; then the epoch moves and the next version opens
 * under CAS; then the grantee's wraps are deleted. A failed epoch move puts
 * the grant back, because deleting wraps is the one step that cannot undo.
 */
export async function revokeAccess(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly relicId: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
    readonly rendererClass: unknown;
    readonly declaredSizeBytes: unknown;
    readonly declaredCiphertextBytes: unknown;
  }
): Promise<Record<string, unknown>> {
  const { row, owner } = await ownedPrivate(env, input.email, input.relicId);
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'revoke',
    email: owner.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(owner),
    relicId: row.id,
  });
  const rev = statementOf(verified, 0);
  const rep = statementOf(verified, 1);
  if (
    rev['owner_identity_id'] !== owner.identityId ||
    rep['owner_identity_id'] !== owner.identityId ||
    rep['previous_version'] !== row.version
  ) {
    refuseStatement('owner_identity_id');
  }
  if (
    row.sealedVersion !== row.version ||
    row.version !== rep['previous_version']
  ) {
    throw new ProblemError('version_conflict');
  }

  const granteeId = String(rev['grantee_identity_id']);
  const grant = await env.store.getGrant(row.id, granteeId);
  if (grant === undefined || grant.revokedAt !== undefined) {
    throw new ProblemError('grant_not_found');
  }
  const grantee = await env.store.getIdentity(granteeId);
  if (grantee === undefined) throw new ProblemError('grant_not_found');

  if (!isRendererClass(input.rendererClass as string)) {
    throw new ProblemError('invalid_publish_metadata');
  }
  const declared = input.declaredSizeBytes;
  const ciphertext = input.declaredCiphertextBytes;
  if (
    typeof declared !== 'number' ||
    !Number.isSafeInteger(declared) ||
    declared <= 0 ||
    typeof ciphertext !== 'number' ||
    ciphertext !== encryptedSize(declared)
  ) {
    throw new ProblemError('invalid_publish_metadata');
  }

  const newVersion = row.version + 1;
  const current = await env.store.getRelic(row.id);
  if (
    current === undefined ||
    current.version !== row.version ||
    current.sealedVersion !== row.version
  ) {
    throw new ProblemError('version_conflict');
  }

  // Wraps go first, then the grant is marked, then the version moves. A failed
  // sweep leaves the grant standing, and the owner retries the whole revocation.
  // A failed move puts the grant back. A key another role still keeps current
  // (a recovery holder, say) keeps its wraps (PS2-07).
  const keptElsewhere = (
    await recipientKeys(env, row, owner, { exceptGrantee: granteeId })
  ).includes(grantee.kemKeyId);
  if (!keptElsewhere) {
    await env.store.deleteWraps(row.id, { recipientKeyId: grantee.kemKeyId });
  }
  await env.store.updateGrant(row.id, granteeId, (g) => ({
    ...g,
    revokedAt: env.now,
    revocation: verified.attestation,
  }));
  try {
    await env.store.updateRelic(row.id, (cur) => {
      if (cur.version !== row.version || cur.sealedVersion !== row.version) {
        throw new ProblemError('version_conflict');
      }
      return {
        ...cur,
        version: newVersion,
        accessEpoch: (cur.accessEpoch ?? 0) + 1,
        rendererClass: input.rendererClass as RelicRow['rendererClass'],
        declaredSizeBytes: declared,
        publishedAt: undefined,
        objectLength: undefined,
        objectCrc32c: undefined,
        cover: undefined,
        noticePending: true,
      };
    });
  } catch (error) {
    await env.store.updateGrant(row.id, granteeId, () => grant);
    throw error;
  }
  const updated = await env.store.getRelic(row.id);
  await logAccess(env, owner.identityId, row.id, 'revoke', {
    actorIdentityId: owner.identityId,
    version: row.version,
    subjectIdentityId: grantee.identityId,
  });
  const upload = await uploadFor(
    env,
    row.id,
    newVersion,
    declared,
    row.expiresAt
  );
  return {
    revoked_identity_id: grantee.identityId,
    republish: upload,
    access_epoch: updated?.accessEpoch ?? 0,
    owner_epoch: owner.recipientsEpoch,
  };
}

/**
 * The upload grant for the open unsealed version, re-issued for the browser
 * after the first grant has expired. The owner's session is the only
 * authority: the publish token never leaves relic-mcp.
 */
export async function reissueUpload(
  env: PrivateEnv,
  email: string,
  relicId: string,
  version: number
): Promise<Record<string, unknown>> {
  const { row, owner } = await ownedPrivate(env, email, relicId);
  if (version !== row.version || version <= (row.sealedVersion ?? 0)) {
    throw new ProblemError('version_conflict');
  }
  // A failed initial index write must be repaired before any retry gets a PUT.
  await env.store.putOwnedRelic(
    {
      relicId: row.id,
      ownerIdentityId: owner.identityId,
      access: 'private',
      at: row.grantedAt,
    },
    { expiresAt: row.expiresAt }
  );
  return uploadFor(env, row.id, version, row.declaredSizeBytes, row.expiresAt);
}

// ---------------------------------------------------------------- recipients

/**
 * The state a publisher or the owner needs to build a seal: the epochs, the
 * owner, the devices, the active grants, the recovery designation, and the
 * recipient key set the seal must match.
 */
export async function recipientsState(
  env: PrivateEnv,
  relicId: string,
  auth: { readonly publishToken?: unknown; readonly email?: string | undefined }
): Promise<Record<string, unknown>> {
  const row = privateRow(await liveRelic(env, relicId));
  const owner = await ownerRecord(env, row);
  const tokenOk =
    auth.publishToken !== undefined &&
    (await publishTokenOk(row, auth.publishToken));
  if (!tokenOk) {
    const me =
      auth.email === undefined
        ? undefined
        : await currentIdentity(env, auth.email);
    if (me === undefined || me.identityId !== owner.identityId) {
      if (auth.publishToken !== undefined) {
        throw new ProblemError('invalid_publish_token');
      }
      throw new ProblemError('owner_required', { relic_id: row.id });
    }
  }
  const devices = await env.store.listDevicesForOwner(owner.identityId);
  // Revoked grants stay in the roster, each with its owner-signed revocation, so
  // a client never has to read a revocation from an absence.
  const grants: GrantWireJSON[] = [];
  for (const grant of await env.store.listGrants(row.id)) {
    const grantee = await env.store.getIdentity(grant.granteeIdentityId);
    if (grantee !== undefined) grants.push(grantJson(grant, grantee));
  }
  const recovery =
    owner.recovery === undefined
      ? null
      : await recoveryJson(env, owner.recovery);
  return {
    access_epoch: row.accessEpoch ?? 0,
    owner_epoch: owner.recipientsEpoch,
    current_version: row.version,
    sealed_version: row.sealedVersion ?? null,
    owner: partyJson(owner),
    devices: devices.map(deviceJson),
    grants,
    recovery,
    recovery_statement: recoveryStatementJson(owner),
    recipient_key_ids: await recipientKeys(env, row, owner),
  };
}

/**
 * Binds an owner to a relic that has none (plan 4.7). A relic-mcp client signs
 * an `owner_bind` with a certified device, and the owner is that device's owner
 * identity. Public and private relics both take it. Only the owner link is
 * written: the relic's access never changes, and every access check keys on
 * `access`, not on the owner. A relic that already has an owner is refused, so
 * the binding happens once.
 */
export async function bindOwner(
  env: PrivateEnv,
  input: { readonly relicId: string; readonly body: Record<string, unknown> }
): Promise<{ owner: PartyJSON }> {
  const row = await liveRelic(env, input.relicId);
  if (!(await publishTokenOk(row, input.body['publish_token']))) {
    throw new ProblemError('invalid_publish_token');
  }
  if (row.ownerIdentityId !== undefined) {
    throw new ProblemError('owner_exists', { relic_id: row.id });
  }
  const device = await verifyOwnerBind(env, {
    relicId: row.id,
    auth: input.body['device_auth'],
  });
  const owner = await env.store.getIdentity(device.ownerIdentityId);
  if (owner === undefined || owner.retiredAt !== undefined) {
    throw new ProblemError('owner_required', { relic_id: row.id });
  }
  await env.store.updateRelic(row.id, (current) => {
    if (current.ownerIdentityId !== undefined) {
      throw new ProblemError('owner_exists', { relic_id: row.id });
    }
    return { ...current, ownerIdentityId: owner.identityId };
  });
  await env.store.putOwnedRelic({
    relicId: row.id,
    ownerIdentityId: owner.identityId,
    access: row.access === 'private' ? 'private' : 'public',
    at: env.now,
  });
  return { owner: partyJson(owner) };
}

// ---------------------------------------------------------------- keys

/**
 * Delivers one version's wrap, its seal and its signer to an authorized
 * caller: an identity that holds a live wrap for the version, or the publish
 * token with the recipient key the publisher names. Every delivery is logged.
 */
export async function deliverKey(
  env: PrivateEnv,
  relicId: string,
  version: number,
  caller:
    | { readonly kind: 'session'; readonly email: string }
    | {
        readonly kind: 'publish';
        readonly token: unknown;
        readonly recipientKeyId: unknown;
      }
): Promise<KeyJSON> {
  const row = privateRow(await liveRelic(env, relicId));
  const owner = await ownerRecord(env, row);
  if (!Number.isSafeInteger(version) || version < 1 || version > row.version) {
    throw new ProblemError('invalid_relic_version', { relic_id: row.id });
  }

  let me: IdentityRecord | undefined;
  let wrap: WrapRow | undefined;
  if (caller.kind === 'session') {
    me = await currentIdentity(env, caller.email);
    if (me === undefined)
      throw new ProblemError('private_access_denied', { relic_id: row.id });
    wrap = await requireRead(env, row, owner, me, version);
  } else {
    if (!(await publishTokenOk(row, caller.token))) {
      throw new ProblemError('invalid_publish_token');
    }
    if (typeof caller.recipientKeyId !== 'string') {
      throw new ProblemError('private_access_denied', { relic_id: row.id });
    }
    // Only a current recipient's wrap is handed out. A wrap a racing seal left
    // for a key since removed (a revoked device, a replaced holder) is refused.
    if (
      !(await recipientKeys(env, row, owner)).includes(caller.recipientKeyId)
    ) {
      throw new ProblemError('private_access_denied', { relic_id: row.id });
    }
    if (isDeleted(row, version))
      throw new ProblemError('version_deleted', { version });
    const seal = await env.store.getSeal(row.id, version);
    if (version > (row.sealedVersion ?? 0) || seal === undefined) {
      throw new ProblemError('relic_not_yet_published', {
        relic_id: row.id,
        retry_after_seconds: 5,
      });
    }
    wrap = await env.store.getWrap(row.id, version, caller.recipientKeyId);
    if (wrap === undefined)
      throw new ProblemError('private_access_denied', { relic_id: row.id });
  }

  const seal = (await env.store.getSeal(row.id, version)) as SealRow;
  const signer =
    seal.signerKind === 'identity'
      ? ({ kind: 'identity' } as const)
      : await deviceSigner(env, seal.signerId);
  await logAccess(env, owner.identityId, row.id, 'wrap_fetch', {
    version,
    ...(me === undefined
      ? {}
      : { actorIdentityId: me.identityId, subjectIdentityId: me.identityId }),
  });
  if (me !== undefined) {
    await env.store.putReceipt(row.id, {
      version,
      identityId: me.identityId,
      kind: 'served',
      at: env.now,
    });
  }
  return {
    relic_id: row.id,
    version,
    wrap: {
      recipient_key_id: wrap.recipientKeyId,
      version: wrap.version,
      enc: wrap.enc,
      ct: wrap.ct,
    },
    seal: {
      statement: seal.statement,
      signature: seal.signature,
      signer_kind: seal.signerKind,
    },
    signer,
    owner: partyJson(owner),
  };
}

async function deviceSigner(env: PrivateEnv, deviceId: string) {
  const device = await env.store.getDevice(deviceId);
  if (device === undefined) throw new ProblemError('device_not_found');
  return { kind: 'device' as const, device: deviceJson(device) };
}

// ---------------------------------------------------------------- seal

/**
 * Accepts a seal for the open version (plan 4.12). Checks run in the plan's
 * order; the seal is written before the relic row is moved, and undone if the
 * move is refused, so a refused seal leaves no wraps behind.
 */
export async function completeSeal(
  env: PrivateEnv,
  input: {
    readonly relicId: string;
    readonly seal: unknown;
    readonly wraps: unknown;
    readonly publishToken: unknown;
    readonly objectLength: number;
    readonly objectCrc32c: string;
    readonly digest: string;
  }
): Promise<{
  version: number;
  access_epoch: number;
  digest: string;
  owner_epoch: number;
}> {
  const row = privateRow(await liveRelic(env, input.relicId));
  const owner = await ownerRecord(env, row);
  if (
    input.publishToken !== undefined &&
    !(await publishTokenOk(row, input.publishToken))
  ) {
    throw new ProblemError('invalid_publish_token');
  }
  if (typeof input.seal !== 'object' || input.seal === null) {
    throw new ProblemError('private_seal_required');
  }
  const sealBody = input.seal as Record<string, unknown>;
  // The key commitment is stored with the seal but not checked here: this
  // service never holds a version key. Every opener checks it before use.
  const statement = parseSeal(sealBody['statement']);
  if (typeof sealBody['signature'] !== 'string') {
    throw new ProblemError('invalid_seal', { seal_check: 'signature' });
  }
  if (statement.relic_id !== row.id) {
    throw new ProblemError('invalid_seal', { seal_check: 'relic_id' });
  }
  if (
    statement.version !== row.version ||
    statement.version <= (row.sealedVersion ?? 0)
  ) {
    throw new ProblemError('version_conflict');
  }

  // Signer: the owner's identity, or one of the owner's live devices.
  const kind = sealBody['signer_kind'];
  if (kind === 'identity') {
    if (statement.signer_id !== owner.identityId) {
      throw new ProblemError('invalid_seal', { seal_check: 'signer' });
    }
    const valid = await verifyStatement(
      decodeBase64url(owner.sigPublicKey),
      statementBytes('seal', statement),
      sealBody['signature']
    );
    if (!valid)
      throw new ProblemError('invalid_seal', { seal_check: 'signature' });
  } else if (kind === 'device') {
    const device = await env.store.getDevice(statement.signer_id);
    if (device === undefined || device.ownerIdentityId !== owner.identityId) {
      throw new ProblemError('invalid_seal', { seal_check: 'signer' });
    }
    if (device.revokedAt !== undefined)
      throw new ProblemError('device_revoked');
    if (device.notAfter < statement.at) {
      throw new ProblemError('device_revoked', { device_check: 'expired' });
    }
    const valid = await verifyStatement(
      decodeBase64url(device.sigPublicKey),
      statementBytes('seal', statement),
      sealBody['signature']
    );
    if (!valid)
      throw new ProblemError('invalid_seal', { seal_check: 'signature' });
  } else {
    throw new ProblemError('invalid_seal', { seal_check: 'signer_kind' });
  }

  if (statement.ciphertext_sha256 !== input.digest) {
    throw new ProblemError('seal_digest_mismatch');
  }

  // Recipients: the wraps must be exactly R, which the seal also names.
  if (statement.owner_epoch !== owner.recipientsEpoch) {
    throw new ProblemError('recipients_changed', {
      owner_epoch: owner.recipientsEpoch,
      access_epoch: row.accessEpoch ?? 0,
    });
  }
  const required = await recipientKeys(env, row, owner);
  if (
    JSON.stringify(required) !== JSON.stringify(statement.recipient_key_ids)
  ) {
    throw new ProblemError('recipients_changed', {
      owner_epoch: owner.recipientsEpoch,
      access_epoch: row.accessEpoch ?? 0,
    });
  }
  if (!Array.isArray(input.wraps)) throw new ProblemError('invalid_wrap');
  const wraps = (input.wraps as unknown[]).map(parseWrapItem);
  const keys = wraps.map((w) => w.recipientKeyId).sort();
  if (
    wraps.some((w) => w.version !== statement.version) ||
    JSON.stringify(keys) !== JSON.stringify(required) ||
    new Set(keys).size !== keys.length
  ) {
    throw new ProblemError('recipients_changed', {
      owner_epoch: owner.recipientsEpoch,
      access_epoch: row.accessEpoch ?? 0,
    });
  }

  // Write: wraps and seal first, then the CAS that makes them current.
  await env.store.deleteWraps(row.id, { version: statement.version });
  const written: WrapRow[] = [];
  for (const w of wraps) {
    const wrapRow: WrapRow = {
      relicId: row.id,
      version: w.version,
      recipientKeyId: w.recipientKeyId,
      enc: w.enc,
      ct: w.ct,
      createdAt: env.now,
      source: 'seal',
    };
    await env.store.putWrap(wrapRow);
    written.push(wrapRow);
  }
  const sealRow: SealRow = {
    relicId: row.id,
    version: statement.version,
    statement: sealBody['statement'] as Record<string, unknown>,
    signature: sealBody['signature'],
    signerKind: kind,
    signerId: statement.signer_id,
    sealedAt: env.now,
  };
  if (!(await env.store.putSeal(sealRow))) {
    await env.store.deleteWraps(row.id, { version: statement.version });
    throw new ProblemError('version_conflict');
  }
  const undo = async () => {
    await env.store.deleteWraps(row.id, { version: statement.version });
    await env.store.deleteSeals(row.id, statement.version);
  };
  try {
    await env.store.updateRelic(row.id, (cur) => {
      if (cur.version !== statement.version) {
        throw new ProblemError('version_conflict');
      }
      if ((cur.accessEpoch ?? 0) !== statement.access_epoch) {
        throw new ProblemError('recipients_changed', {
          access_epoch: cur.accessEpoch ?? 0,
          owner_epoch: owner.recipientsEpoch,
        });
      }
      return { ...cur, sealedVersion: statement.version };
    });
  } catch (error) {
    await undo();
    throw error;
  }
  // The owner's recipients may have moved during the seal (a device revoked,
  // a recovery changed). Re-check the epoch once; a moved epoch undoes it.
  const after = await env.store.getIdentity(owner.identityId);
  if (after !== undefined && after.recipientsEpoch !== statement.owner_epoch) {
    await env.store.updateRelic(row.id, (cur) =>
      cur.sealedVersion === statement.version
        ? { ...cur, sealedVersion: row.sealedVersion }
        : cur
    );
    await undo();
    throw new ProblemError('recipients_changed', {
      owner_epoch: after.recipientsEpoch,
    });
  }
  await env.store.recordVersionDigest(row.id, statement.version, input.digest);
  if (row.publishedAt === undefined) {
    await env.store.markPublished(
      row.id,
      env.now,
      input.objectLength,
      input.objectCrc32c
    );
  }
  const current = await env.store.getRelic(row.id);
  return {
    version: statement.version,
    access_epoch: current?.accessEpoch ?? 0,
    digest: input.digest,
    owner_epoch: owner.recipientsEpoch,
  };
}

// ---------------------------------------------------------------- delete

/**
 * Deletes chosen versions, or the whole relic. A version delete removes its
 * wraps, seal and ciphertext and records the number as deleted. The whole
 * relic leaves an id-only tombstone, so the id is never reissued, and removes
 * every private document. Access events survive for their retention.
 */
export async function deleteRelic(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly relicId: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
  }
): Promise<{
  deleted_versions: number[] | 'all';
  relic_deleted: boolean;
  signing_deleted?: number;
}> {
  const { row, owner } = await ownedPrivate(env, input.email, input.relicId);
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'delete',
    email: owner.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(owner),
    relicId: row.id,
  });
  const s = statementOf(verified, 0);
  if (s['owner_identity_id'] !== owner.identityId)
    refuseStatement('owner_identity_id');
  const versions = s['versions'];

  if (versions === 'all') {
    await logAccess(env, owner.identityId, row.id, 'delete', {
      actorIdentityId: owner.identityId,
    });
    await env.store.putTombstone({
      kind: 'owner',
      id: row.id,
      deletedAt: env.now,
    });
    for (let v = 1; v <= row.version; v++) {
      await env.storage.delete(env.objectKey(row.id, v));
    }
    await env.store.deleteCovers(row.id);
    await env.store.deleteCommentsForRelic(row.id);
    await env.store.deleteSharesForRelic(row.id);
    await env.store.deleteOptOutsForRelic(row.id);
    await env.store.deleteDecisionsForRelic(row.id);
    await env.store.deleteSettingsChanges(row.id);
    const signingDeleted = await env.store.deleteSigningForRelic(row.id);
    await env.store.deleteWraps(row.id, {});
    await env.store.deleteSeals(row.id);
    await env.store.deleteGrantsForRelic(row.id);
    await env.store.deleteAccessRequestsForRelic(row.id);
    await env.store.deleteOwnedRelic(owner.identityId, row.id);
    await env.store.deleteRelicRow(row.id);
    return {
      deleted_versions: Array.from({ length: row.version }, (_, i) => i + 1),
      relic_deleted: true,
      signing_deleted: signingDeleted,
    };
  }

  const list = versions as number[];
  for (const version of list) assertVersionUnlocked(row, version);
  if (list.includes(row.version)) {
    throw new ProblemError('cannot_delete_current_version', {
      version: row.version,
    });
  }
  const updated = await env.store.updateRelic(row.id, (cur) => {
    for (const version of list) {
      assertVersionUnlocked(cur, version);
      if (version === cur.version)
        throw new ProblemError('cannot_delete_current_version', { version });
      if (version > cur.version)
        throw new ProblemError('invalid_relic_version', { relic_id: row.id });
    }
    return {
      ...cur,
      deletedVersions: [
        ...new Set([...(cur.deletedVersions ?? []), ...list]),
      ].sort((a, b) => a - b),
    };
  });
  if (updated === undefined) throw new ProblemError('relic_removed');
  for (const version of list) {
    await env.store.deleteWraps(row.id, { version });
    await env.store.deleteSeals(row.id, version);
    await env.storage.delete(env.objectKey(row.id, version));
    await logAccess(env, owner.identityId, row.id, 'delete', {
      actorIdentityId: owner.identityId,
      version,
    });
  }
  return { deleted_versions: list, relic_deleted: false };
}
