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
  RelicRow,
  WrapRow,
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
  | 'none';

/** The roles that may open a version. A wrap alone is never authority (plan 4.12). */
const READABLE_ROLES: Partial<Record<AccessRole, true>> = {
  owner: true,
  grantee: true,
  recovery: true,
};
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
 */
export async function recipientKeys(
  env: PrivateEnv,
  row: RelicRow,
  owner: IdentityRecord
): Promise<string[]> {
  const keys = new Set<string>([owner.kemKeyId]);
  const devices = await env.store.listDevicesForOwner(owner.identityId);
  for (const device of devices) {
    if (device.revokedAt === undefined && device.notAfter > env.now) {
      keys.add(device.kemKeyId);
    }
  }
  if (owner.recovery !== undefined) {
    const recovery = await env.store.getIdentity(
      owner.recovery.recoveryIdentityId
    );
    if (recovery !== undefined && recovery.retiredAt === undefined) {
      keys.add(recovery.kemKeyId);
    }
  }
  for (const grant of await env.store.listGrants(row.id)) {
    if (grant.revokedAt !== undefined) continue;
    const grantee = await env.store.getIdentity(grant.granteeIdentityId);
    if (grantee !== undefined && grantee.retiredAt === undefined) {
      keys.add(grantee.kemKeyId);
    }
  }
  return [...keys].sort();
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
  const request = await env.store.getAccessRequest(row.id, me.identityId);
  if (request?.status === 'pending') return { role: 'requested', request };
  if (request?.status === 'declined') return { role: 'declined', request };
  return { role: 'none' };
}

export function isDeleted(row: RelicRow, version: number): boolean {
  return row.deletedVersions?.includes(version) === true;
}

/** Versions this recipient key can open: wrapped, sealed, and not deleted. */
export async function readableVersions(
  env: PrivateEnv,
  row: RelicRow,
  recipientKeyId: string
): Promise<number[]> {
  const versions = new Set<number>();
  for (const wrap of await env.store.listWraps(row.id)) {
    if (wrap.recipientKeyId !== recipientKeyId) continue;
    if (isDeleted(row, wrap.version)) continue;
    if ((await env.store.getSeal(row.id, wrap.version)) !== undefined) {
      versions.add(wrap.version);
    }
  }
  return [...versions].sort((a, b) => a - b);
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
): Promise<WrapRow> {
  if (isDeleted(row, version)) {
    throw new ProblemError('version_deleted', { version });
  }
  if ((await env.store.getSeal(row.id, version)) === undefined) {
    throw new ProblemError('relic_not_yet_published', {
      relic_id: row.id,
      retry_after_seconds: 5,
    });
  }
  const standing = await standingOf(env, row, owner, me);
  if (me === undefined || READABLE_ROLES[standing.role] !== true) {
    throw new ProblemError('private_access_denied', { relic_id: row.id });
  }
  const wrap = await env.store.getWrap(row.id, version, me.kemKeyId);
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
