/**
 * Who may read a private relic, and what the service records about it.
 *
 * Nothing in here decrypts anything. The service answers "is this identity
 * wrapped for this version, and is that still allowed" and nothing more.
 * The recipient set R (plan 4.12) is computed here so that seals, backfills
 * and coverage reports agree on one definition.
 */

import type {
  AccessEvent,
  AccessRequestRow,
  GrantRow,
  IdentityRecord,
  InviteRow,
  RelicRow,
} from '../store.ts';
import { ProblemError } from '../problems.ts';
import { DAY_MS, type PrivateEnv, sameString, sha256Hex } from './context.ts';
import { randomHexId } from './ids.ts';

export type AccessRole =
  | 'owner'
  | 'grantee'
  | 'recovery'
  | 'revoked'
  | 'requested'
  | 'declined'
  | 'invited'
  | 'none';

export interface ServedWrap {
  readonly recipientKeyId: string;
  readonly version: number;
  readonly enc: string;
  readonly ct: string;
}

/** Grants include their selected versions and all subsequently sealed versions. */
export function grantCovers(grant: GrantRow, version: number): boolean {
  return grant.versions.length > 0 &&
    (grant.versions.includes(version) || version > Math.max(...grant.versions));
}
export interface Standing {
  readonly role: AccessRole;
  readonly grant?: GrantRow;
  readonly request?: AccessRequestRow;
}

/** The owner identity a private relic was granted under. */
export async function ownerRecord(
  env: PrivateEnv,
  row: RelicRow
): Promise<IdentityRecord> {
  const owner =
    row.ownerIdentityId === undefined
      ? undefined
      : await env.store.getIdentity(row.ownerIdentityId);
  if (owner === undefined) {
    throw new ProblemError('owner_required', { relic_id: row.id });
  }
  return owner;
}

/**
 * The recipient set R for a relic at this moment (plan 4.12): the owner's
 * key, every owner device that is not revoked and not expired, the recovery
 * identity when designated and current, and every grantee whose grant is
 * not revoked and whose identity is current. Sorted, lowercase hex, unique.
 * `exceptGrantee` leaves one grant out, to ask what a revocation of it would
 * still leave current.
 */
export async function recipientCoverage(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord,
  options: { readonly exceptGrantee?: string } = {}
): Promise<ReadonlyMap<string, (version: number) => boolean>> {
  const allVersions = () => true;
  const keys = new Map<string, (version: number) => boolean>([
    [owner.kemKeyId, allVersions],
  ]);
  const devices = await env.store.listDevicesForOwner(owner.identityId);
  for (const device of devices) {
    if (device.revokedAt === undefined && device.notAfter > env.now) {
      keys.set(device.kemKeyId, allVersions);
    }
  }
  if (owner.recovery !== undefined) {
    const recovery = await env.store.getIdentity(
      owner.recovery.recoveryIdentityId
    );
    if (recovery !== undefined && recovery.retiredAt === undefined) {
      keys.set(recovery.kemKeyId, allVersions);
    }
  }
  for (const grant of await env.store.listGrants(row.id)) {
    if (grant.revokedAt !== undefined) continue;
    if (grant.granteeIdentityId === options.exceptGrantee) continue;
    const grantee = await env.store.getIdentity(grant.granteeIdentityId);
    if (
      grantee !== undefined &&
      grantee.retiredAt === undefined &&
      !keys.has(grantee.kemKeyId)
    ) {
      keys.set(grantee.kemKeyId, (version) => grantCovers(grant, version));
    }
  }
  return keys;
}

export async function recipientKeys(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord,
  options: { readonly exceptGrantee?: string } = {}
): Promise<string[]> {
  return [...(await recipientCoverage(env, row, owner, options)).keys()].sort();
}

/**
 * Removes the wraps one KEM key holds on each relic the owner owns, except on
 * a relic where that key is still a current recipient in another role (PS2-07).
 * Runs after the change that removed the key, so the epoch fence is already up.
 * Idempotent: a retry sweeps again and finds nothing new to remove.
 */
export async function sweepWrapsFor(
  env: PrivateEnv,
  owner: IdentityRecord,
  keyIds: readonly string[]
): Promise<void> {
  for (const owned of await env.store.listOwnedRelics(owner.identityId)) {
    const row = await env.store.getRelic(owned.relicId);
    // Read before the recipient set: a grant that commits after this read has
    // a later epoch, so its wraps survive the sweep.
    const epoch = row?.accessEpoch ?? 0;
    const current = new Set(
      row === undefined ? [] : await recipientKeys(env, row, owner)
    );
    for (const keyId of keyIds) {
      if (current.has(keyId)) continue;
      await removeWrapsUpTo(env, owned.relicId, keyId, epoch);
    }
  }
}

/**
 * Deletes the wraps one key holds on a relic that were written at or before
 * `epoch`. A wrap written later belongs to a grant or seal that committed after
 * the caller read the epoch, and survives. Every delete is conditional on the
 * wrap it judged, so a write that lands during the sweep is judged again.
 */
export async function removeWrapsUpTo(
  env: PrivateEnv,
  relicId: string,
  recipientKeyId: string,
  epoch: number
): Promise<void> {
  for (const wrap of await env.store.listWraps(relicId)) {
    if (wrap.recipientKeyId !== recipientKeyId) continue;
    await env.store.deleteWrapIf(
      relicId,
      wrap.version,
      recipientKeyId,
      (current) => (current.epoch ?? 0) <= epoch
    );
  }
}

/**
 * An invitation is fenced when its address has a fence committed after the
 * invitation was created. The fence is written with the epoch, so the two
 * cannot disagree.
 */
export function invitationRevokedByEpoch(
  row: RelicRow,
  invite: InviteRow
): boolean {
  const fence = row.accessFence?.[invite.invitedEmail];
  return fence !== undefined && (invite.createdAccessEpoch ?? 0) < fence.epoch;
}

/** The index is only a hint: each referenced invitation must still authorize. */
export async function claimedInvitations(
  env: PrivateEnv,
  row: RelicRow,
  identityId: string
): Promise<{ live: InviteRow[]; revoked: InviteRow[] }> {
  const index = await env.store.getInviteClaimIndex(row.id, identityId);
  const rows = await Promise.all(
    (index?.inviteIds ?? []).map((id) => env.store.getInvite(row.id, id))
  );
  const live: InviteRow[] = [];
  const revoked: InviteRow[] = [];
  for (const invite of rows) {
    if (invite === undefined || invite.claimantIdentityId !== identityId) continue;
    if (invite.status === 'revoked' || invitationRevokedByEpoch(row, invite)) {
      revoked.push(invite);
    } else if (invite.status === 'claimed') {
      live.push(invite);
    }
  }
  return { live, revoked };
}

/** What the identity is to this relic, in precedence order. */
export async function standingOf(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord,
  me: IdentityRecord | undefined
): Promise<Standing> {
  if (me === undefined) return { role: 'none' };
  if (me.identityId === owner.identityId) return { role: 'owner' };
  if (owner.recovery?.recoveryIdentityId === me.identityId) {
    return { role: 'recovery' };
  }
  const grant = await env.store.getGrant(row.id, me.identityId);
  if (grant !== undefined && grant.revokedAt === undefined) {
    return { role: 'grantee', grant };
  }
  if (grant !== undefined) return { role: 'revoked', grant };
  const claims = await claimedInvitations(env, row, me.identityId);
  if (claims.live.length > 0) return { role: 'invited' };
  if (claims.revoked.length > 0) return { role: 'revoked' };
  const request = await env.store.getAccessRequest(row.id, me.identityId);
  if (request?.status === 'pending') return { role: 'requested', request };
  if (request?.status === 'declined') return { role: 'declined', request };
  return { role: 'none' };
}

export function isDeleted(row: RelicRow, version: number): boolean {
  return row.deletedVersions?.includes(version) === true;
}

async function wrapForStanding(
  env: PrivateEnv,
  row: RelicRow,
  me: IdentityRecord,
  standing: Standing,
  claims: readonly InviteRow[],
  version: number
): Promise<ServedWrap | undefined> {
  if (
    standing.role === 'owner' ||
    standing.role === 'recovery' ||
    (standing.role === 'grantee' &&
      standing.grant !== undefined &&
      grantCovers(standing.grant, version))
  ) {
    const wrap = await env.store.getWrap(row.id, version, me.kemKeyId);
    if (wrap !== undefined) return wrap;
  }
  if (standing.role !== 'invited' && standing.role !== 'grantee') return undefined;
  for (const claim of claims) {
    if (!claim.versions.includes(version)) continue;
    const wrap = claim.claimWraps?.find((item) => item.version === version);
    if (wrap !== undefined) return { ...wrap, recipientKeyId: me.kemKeyId };
  }
  return undefined;
}

/** Returns only a wrap covered by the identity's current standing. */
export async function servedWrap(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord,
  me: IdentityRecord,
  version: number
): Promise<ServedWrap | undefined> {
  const standing = await standingOf(env, row, owner, me);
  const claims =
    standing.role === 'invited' || standing.role === 'grantee'
      ? (await claimedInvitations(env, row, me.identityId)).live
      : [];
  return wrapForStanding(env, row, me, standing, claims, version);
}

/** Versions this identity can open: authorized, wrapped, sealed, and not deleted. */
export async function readableVersions(
  env: PrivateEnv,
  row: RelicRow,
  recipientKeyId: string,
  me: IdentityRecord,
  owner: IdentityRecord
): Promise<number[]> {
  if (recipientKeyId !== me.kemKeyId) return [];
  const standing = await standingOf(env, row, owner, me);
  const claims =
    standing.role === 'invited' || standing.role === 'grantee'
      ? (await claimedInvitations(env, row, me.identityId)).live
      : [];
  const candidates = new Set(
    (await env.store.listWraps(row.id))
      .filter((wrap) => wrap.recipientKeyId === recipientKeyId)
      .map((wrap) => wrap.version)
  );
  for (const claim of claims) {
    for (const wrap of claim.claimWraps ?? []) candidates.add(wrap.version);
  }
  const versions: number[] = [];
  for (const version of [...candidates].sort((a, b) => a - b)) {
    if (version > (row.sealedVersion ?? 0) || isDeleted(row, version)) continue;
    if ((await env.store.getSeal(row.id, version)) === undefined) continue;
    if (await wrapForStanding(env, row, me, standing, claims, version)) {
      versions.push(version);
    }
  }
  return versions;
}

/**
 * The wrap that lets `me` open `version`, or the refusal that says why not.
 * Deleted versions and unsealed versions are their own answers, so a client
 * can tell "ask the owner" from "this is gone".
 */
export async function requireRead(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord,
  me: IdentityRecord | undefined,
  version: number
): Promise<ServedWrap> {
  if (isDeleted(row, version)) {
    throw new ProblemError('version_deleted', { version });
  }
  if (
    version > (row.sealedVersion ?? 0) ||
    (await env.store.getSeal(row.id, version)) === undefined
  ) {
    throw new ProblemError('relic_not_yet_published', {
      relic_id: row.id,
      retry_after_seconds: 5,
    });
  }
  const wrap =
    me === undefined ? undefined : await servedWrap(env, row, owner, me, version);
  if (wrap === undefined) {
    throw new ProblemError('private_access_denied', { relic_id: row.id });
  }
  return wrap;
}

/** A publish-token bearer, compared in constant time. */
export async function publishTokenOk(
  row: RelicRow,
  token: unknown
): Promise<boolean> {
  if (typeof token !== 'string') return false;
  return sameString(row.publishTokenHash, await sha256Hex(token));
}

/**
 * Appends one access-log event. The owner's retention setting is read now,
 * so each event is retained for the period in force when it happened, and
 * the store writes it with a `customTime` the lifecycle rule erases from.
 */
export async function logAccess(
  env: PrivateEnv,
  ownerIdentityId: string,
  relicId: string,
  kind: AccessEvent['kind'],
  extra: {
    readonly version?: number;
    readonly actorIdentityId?: string;
    readonly actorDeviceId?: string;
    readonly actorEmail?: string;
    readonly subjectIdentityId?: string;
    readonly subjectEmail?: string;
  } = {}
): Promise<void> {
  const owner = await env.store.getIdentity(ownerIdentityId);
  const days =
    owner?.accessLogRetentionDays ?? env.config.accessLogRetentionDefaultDays;
  await env.store.appendAccessEvent({
    eventId: randomHexId(),
    ownerIdentityId,
    relicId,
    at: env.now,
    kind,
    ...extra,
    retainUntil: env.now + days * DAY_MS,
  });
}
