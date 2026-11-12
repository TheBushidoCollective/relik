/**
 * Private-share identities: one per normalized address (plan 4.2 and 4.4).
 *
 * The service stores an identity's public keys, its signed statements, and
 * the identity's bundle encrypted under each bound passkey's PRF output. It
 * never holds the decrypting key, so it can verify what the owner signed and
 * can never produce the bundle's contents.
 */

import {
  decodeBase64url,
  fingerprintsEqual,
  identityFingerprint,
  identityIdOf,
  kemKeyIdOf,
  parseTypedFingerprint,
} from '@relic/format/private';
import type { RecoveryJSON, IdentityStateJSON } from '@relic/format/private';
import { normalizeEmail } from '@relic/format';
import { identityReplacedMail } from '../mail.ts';
import type { PartyJSON } from '@relic/format/private';
import { ProblemError } from '../problems.ts';
import type {
  IdentityCredentialBinding,
  IdentityRecord,
  PasskeyRecord,
  RecoveryDesignation,
  SessionRow,
} from '../store.ts';
import {
  hexOf,
  identityPublicJson,
  iso,
  type PrivateEnv,
  partyJson,
} from './context.ts';
import { verifyAttestation, type VerifiedAttestation } from './attest.ts';
import { readableVersions, recipientKeys, isDeleted } from './access.ts';

/** A bundle is one base64url string: nonce, ciphertext and tag. */
const MAX_BUNDLE_CHARS = 4096;

/** The one identity an address currently holds, or undefined. */
export async function currentIdentity(
  env: PrivateEnv,
  email: string
): Promise<IdentityRecord | undefined> {
  return env.store.getIdentityForAddress(normalizeEmail(email));
}

/**
 * The identity's signing key, for statements the identity itself signs. A
 * registration is the one exception: its own statement names the key.
 */
export function identitySigner(record: Pick<IdentityRecord, 'sigPublicKey'>) {
  const key = decodeBase64url(record.sigPublicKey);
  return (
    kind: string,
    statement: Record<string, unknown>
  ): Uint8Array | undefined => {
    if (kind === 'identity_register') {
      return decodeBase64url(String(statement['sig_public_key']));
    }
    return key;
  };
}

/** Whether a session may replace an identity, per the first-passkey freshness rule. */
export function freshLinkSession(
  session: Pick<SessionRow, 'via' | 'createdAt'>,
  env: PrivateEnv
): boolean {
  const via = session.via ?? 'link';
  return (
    (via === 'link' || via === 'code') &&
    env.now - session.createdAt <= env.config.passkeyFreshLinkSeconds * 1000
  );
}

function isBundle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BUNDLE_CHARS &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** Wire state for the signed-in address, with its passkeys and bindings. */
export async function identityState(
  env: PrivateEnv,
  email: string,
  passkeys: PasskeyRecord | undefined
): Promise<IdentityStateJSON> {
  const record = await currentIdentity(env, email);
  const bound = new Set((record?.credentials ?? []).map((c) => c.credentialId));
  const credentials = (passkeys?.credentials ?? []).map((c) => ({
    credential_id: c.credentialId,
    bound: bound.has(c.credentialId),
  }));
  if (record === undefined) {
    return { identity: null, passkeys: credentials };
  }
  const recovery =
    record.recovery === undefined
      ? null
      : await recoveryJson(env, record.recovery);
  return {
    identity: {
      ...identityPublicJson(record),
      credentials: record.credentials.map((c) => ({
        credential_id: c.credentialId,
        encrypted_bundle: c.encryptedBundle,
        bound_at: iso(c.boundAt),
      })),
      recovery,
      access_log_retention_days: record.accessLogRetentionDays,
      recipients_epoch: record.recipientsEpoch,
    },
    passkeys: credentials,
  };
}

async function recoveryJson(
  env: PrivateEnv,
  designation: RecoveryDesignation
): Promise<RecoveryJSON | null> {
  const recovery = await env.store.getIdentity(designation.recoveryIdentityId);
  if (recovery === undefined) return null;
  const att = designation.attestation;
  const statement = att.statements[0];
  if (statement === undefined) return null;
  return {
    ...partyJson(recovery),
    designated_at: iso(designation.designatedAt),
    designation: {
      statement: statement.statement,
      identity_signature: statement.identitySignature,
    },
  };
}

/** Creates the address's identity from one registration attestation. */
export async function registerIdentity(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly session: Pick<SessionRow, 'via' | 'createdAt'>;
    readonly passkeys: PasskeyRecord | undefined;
    readonly bundle: unknown;
    readonly replace: boolean;
    readonly attestation: unknown;
  }
): Promise<IdentityRecord> {
  const address = normalizeEmail(input.email);
  if (!isBundle(input.bundle)) {
    throw new ProblemError('invalid_identity', { identity_check: 'bundle' });
  }
  const existing = await env.store.getIdentityForAddress(address);
  if (existing !== undefined && !input.replace) {
    throw new ProblemError('identity_exists');
  }
  if (existing !== undefined && !freshLinkSession(input.session, env)) {
    throw new ProblemError('passkey_fresh_link_required');
  }

  const verified: VerifiedAttestation = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'identity_register',
    email: address,
    passkeys: input.passkeys,
    signerKey: identitySigner({ sigPublicKey: '' }),
  });
  const statement = verified.statements[0]?.statement;
  if (statement === undefined) {
    throw new ProblemError('invalid_statement', { statement_check: 'shape' });
  }
  if (normalizeEmail(String(statement['email'])) !== address) {
    throw new ProblemError('invalid_statement', { statement_check: 'email' });
  }
  const kemPublic = decodeBase64url(String(statement['kem_public_key']));
  const sigPublic = decodeBase64url(String(statement['sig_public_key']));
  const identityId = await identityIdOf(kemPublic, sigPublic);
  if (identityId !== statement['identity_id']) {
    throw new ProblemError('invalid_statement', {
      statement_check: 'identity_id',
    });
  }
  const replaces = statement['replaces'];
  if (existing === undefined) {
    if (replaces !== null) {
      throw new ProblemError('invalid_statement', {
        statement_check: 'replaces',
      });
    }
  } else if (replaces !== existing.identityId) {
    throw new ProblemError('invalid_statement', {
      statement_check: 'replaces',
    });
  }

  const record: IdentityRecord = {
    identityId,
    email: address,
    address,
    kemPublicKey: String(statement['kem_public_key']),
    sigPublicKey: String(statement['sig_public_key']),
    kemKeyId: await kemKeyIdHex(kemPublic),
    createdAt: env.now,
    registration: verified.attestation,
    credentials: [
      {
        credentialId: verified.credentialId,
        encryptedBundle: input.bundle,
        boundAt: env.now,
        attestation: verified.attestation,
      },
    ],
    accessLogRetentionDays: env.config.accessLogRetentionDefaultDays,
    recipientsEpoch: 0,
  };

  if (existing === undefined) {
    const created = await env.store.createIdentity(record);
    if (created !== 'created') {
      throw new ProblemError('identity_exists');
    }
  } else {
    const outcome = await env.store.replaceIdentity(
      record,
      existing.identityId,
      env.now
    );
    if (outcome !== 'replaced') {
      throw new ProblemError('identity_exists');
    }
    await notifyReplacement(env, address);
  }
  return record;
}

async function notifyReplacement(
  env: PrivateEnv,
  address: string
): Promise<void> {
  try {
    await env.sendMail(address, identityReplacedMail({ address, at: env.now }));
  } catch (error) {
    console.error('relic: identity replacement notice failed:', error);
  }
}

/** Binds one more passkey to the signed-in identity, under its own PRF key. */
export async function bindCredential(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly bundle: unknown;
    readonly attestation: unknown;
  }
): Promise<IdentityCredentialBinding> {
  const record = await currentIdentity(env, input.email);
  if (record === undefined) throw new ProblemError('identity_required');
  if (!isBundle(input.bundle)) {
    throw new ProblemError('invalid_identity', { identity_check: 'bundle' });
  }
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'identity_bind',
    email: record.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(record),
  });
  const statement = verified.statements[0]?.statement;
  if (
    statement === undefined ||
    statement['identity_id'] !== record.identityId ||
    statement['credential_id'] !== verified.credentialId
  ) {
    throw new ProblemError('invalid_statement', {
      statement_check: 'identity_id',
    });
  }
  if (
    record.credentials.some((c) => c.credentialId === verified.credentialId)
  ) {
    throw new ProblemError('identity_exists', { identity_check: 'bound' });
  }
  const binding: IdentityCredentialBinding = {
    credentialId: verified.credentialId,
    encryptedBundle: input.bundle,
    boundAt: env.now,
    attestation: verified.attestation,
  };
  await env.store.updateIdentity(record.identityId, (current) => {
    if (
      current.credentials.some((c) => c.credentialId === binding.credentialId)
    ) {
      throw new ProblemError('identity_exists', { identity_check: 'bound' });
    }
    return { ...current, credentials: [...current.credentials, binding] };
  });
  return binding;
}

/** Sets how long this identity's access log is kept, inside the configured bounds. */
export async function setRetention(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
  }
): Promise<number> {
  const record = await currentIdentity(env, input.email);
  if (record === undefined) throw new ProblemError('identity_required');
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'identity_settings',
    email: record.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(record),
  });
  const statement = verified.statements[0]?.statement;
  const days = statement?.['access_log_retention_days'];
  if (
    statement === undefined ||
    statement['identity_id'] !== record.identityId ||
    typeof days !== 'number' ||
    days < env.config.accessLogRetentionMinDays ||
    days > env.config.accessLogRetentionMaxDays
  ) {
    throw new ProblemError('invalid_statement', {
      statement_check: 'retention',
    });
  }
  await env.store.updateIdentity(record.identityId, (current) => ({
    ...current,
    accessLogRetentionDays: days,
  }));
  return days;
}

/** The party a fingerprint-checked lookup can reveal: an address and its key, never a fingerprint. */
export async function lookupRecovery(
  env: PrivateEnv,
  email: string,
  viewer: string
): Promise<PartyJSON | null> {
  env.limit('identity-lookup', viewer, env.config.identityLookupRateLimit);
  const record = await currentIdentity(env, normalizeEmail(email));
  return record === undefined ? null : partyJson(record);
}

/**
 * Designates, replaces or removes the recovery identity (plan 4.12). The
 * designation is typed-checked: the owner must type the recovery identity's
 * fingerprint before the statement is signed, and the server re-computes it.
 */
export async function designateRecovery(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
  }
): Promise<RecoveryJSON | null> {
  const owner = await currentIdentity(env, input.email);
  if (owner === undefined) throw new ProblemError('identity_required');
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'recovery_designate',
    email: owner.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(owner),
  });
  const statement = verified.statements[0]?.statement;
  if (
    statement === undefined ||
    statement['owner_identity_id'] !== owner.identityId
  ) {
    throw new ProblemError('invalid_statement', {
      statement_check: 'owner_identity_id',
    });
  }
  const typed = statement['fingerprint_typed'];
  const recoveryId = statement['recovery_identity_id'];
  const recoveryEmail = statement['recovery_email'];
  const removing =
    typed === null && recoveryId === null && recoveryEmail === null;
  const previous = owner.recovery;

  let next: RecoveryDesignation | undefined;
  if (!removing) {
    if (
      typeof typed !== 'string' ||
      typeof recoveryId !== 'string' ||
      typeof recoveryEmail !== 'string'
    ) {
      throw new ProblemError('invalid_statement', {
        statement_check: 'recovery',
      });
    }
    const recovery = await env.store.getIdentity(recoveryId);
    const address = normalizeEmail(recoveryEmail);
    if (
      recovery === undefined ||
      recovery.retiredAt !== undefined ||
      recovery.email !== address ||
      recoveryId === owner.identityId
    ) {
      throw new ProblemError('invalid_statement', {
        statement_check: 'recovery',
      });
    }
    const typedNormal = parseTypedFingerprint(typed);
    const computed = await identityFingerprint(
      recovery.identityId,
      recovery.email
    );
    if (
      typedNormal === undefined ||
      !fingerprintsEqual(typedNormal, computed)
    ) {
      throw new ProblemError('fingerprint_mismatch');
    }
    next = {
      recoveryIdentityId: recovery.identityId,
      recoveryEmail: recovery.email,
      designatedAt: env.now,
      attestation: verified.attestation,
    };
  }

  await env.store.updateIdentity(owner.identityId, (current) => ({
    ...current,
    recovery: next,
    recipientsEpoch: current.recipientsEpoch + 1,
  }));

  // The previous recovery key must lose its wraps the moment it is replaced.
  if (
    previous !== undefined &&
    previous.recoveryIdentityId !== next?.recoveryIdentityId
  ) {
    const old = await env.store.getIdentity(previous.recoveryIdentityId);
    if (old !== undefined) {
      for (const owned of await env.store.listOwnedRelics(owner.identityId)) {
        await env.store.deleteWraps(owned.relicId, {
          recipientKeyId: old.kemKeyId,
        });
      }
    }
  }
  if (next === undefined) return null;
  return recoveryJson(env, next);
}

/**
 * Stores wraps the owner's browser made for versions already sealed, so a
 * new recipient (a device, a recovery key) can open them. Each wrap must be
 * for a current recipient and a sealed, undeleted version of a relic the
 * caller owns.
 */
export async function backfillWraps(
  env: PrivateEnv,
  input: { readonly email: string; readonly wraps: unknown }
): Promise<{ stored: number; skipped: number }> {
  const owner = await currentIdentity(env, input.email);
  if (owner === undefined) throw new ProblemError('identity_required');
  if (
    !Array.isArray(input.wraps) ||
    input.wraps.length > env.config.privateBackfillMaxWraps
  ) {
    throw new ProblemError('invalid_wrap', {
      detail: 'Too many wraps in one call.',
    });
  }
  const owned = new Set(
    (await env.store.listOwnedRelics(owner.identityId)).map((o) => o.relicId)
  );
  const recipientsByRelic = new Map<string, Set<string>>();
  let stored = 0;
  let skipped = 0;
  for (const item of input.wraps as unknown[]) {
    const wrap = parseWrapItem(item);
    if (wrap.relicId === undefined || !owned.has(wrap.relicId))
      throw new ProblemError('invalid_wrap');
    const row = await env.store.getRelic(wrap.relicId);
    if (row === undefined || row.ownerIdentityId !== owner.identityId) {
      throw new ProblemError('invalid_wrap');
    }
    if (isDeleted(row, wrap.version)) throw new ProblemError('invalid_wrap');
    if ((await env.store.getSeal(row.id, wrap.version)) === undefined) {
      throw new ProblemError('invalid_wrap');
    }
    let recipients = recipientsByRelic.get(row.id);
    if (recipients === undefined) {
      recipients = new Set(await recipientKeys(env, row, owner));
      recipientsByRelic.set(row.id, recipients);
    }
    if (!recipients.has(wrap.recipientKeyId)) {
      throw new ProblemError('invalid_wrap', {
        detail: 'Not a current recipient.',
      });
    }
    const created = await env.store.putWrap({
      relicId: row.id,
      version: wrap.version,
      recipientKeyId: wrap.recipientKeyId,
      enc: wrap.enc,
      ct: wrap.ct,
      createdAt: env.now,
      source: 'backfill',
    });
    if (created) stored++;
    else skipped++;
  }
  return { stored, skipped };
}

export interface ParsedWrap {
  readonly relicId?: string | undefined;
  readonly version: number;
  readonly recipientKeyId: string;
  readonly enc: string;
  readonly ct: string;
}

/** A wrap as the wire carries it: the lengths the HPKE layout fixes (plan 4.1). */
export function parseWrapItem(item: unknown): ParsedWrap {
  if (typeof item !== 'object' || item === null) {
    throw new ProblemError('invalid_wrap');
  }
  const w = item as Record<string, unknown>;
  const relicId = w['relic_id'];
  const version = w['version'];
  const keyId = w['recipient_key_id'];
  const enc = w['enc'];
  const ct = w['ct'];
  if (
    (relicId !== undefined && typeof relicId !== 'string') ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof keyId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(keyId) ||
    typeof enc !== 'string' ||
    typeof ct !== 'string' ||
    !wrapLengthsOk(enc, ct)
  ) {
    throw new ProblemError('invalid_wrap');
  }
  return { relicId, version, recipientKeyId: keyId, enc, ct };
}

/** `enc` is 65 bytes (SEC1 uncompressed) and `ct` is 16 bytes plus a 16-byte tag. */
export function wrapLengthsOk(enc: string, ct: string): boolean {
  try {
    return (
      decodeBase64url(enc).byteLength === 65 &&
      decodeBase64url(ct).byteLength === 32
    );
  } catch {
    return false;
  }
}

async function kemKeyIdHex(kemPublic: Uint8Array): Promise<string> {
  return hexOf(await kemKeyIdOf(kemPublic));
}

/** Relics the identity owns, with what the dashboard needs to show. */
export async function ownedAndShared(
  env: PrivateEnv,
  record: IdentityRecord,
  withCoverage: boolean
): Promise<{ owned: unknown[]; shared_with_me: unknown[] }> {
  const owned: unknown[] = [];
  for (const entry of await env.store.listOwnedRelics(record.identityId)) {
    const row = await env.store.getRelic(entry.relicId);
    if (row === undefined) continue;
    const pending = (await env.store.listAccessRequests(row.id)).filter(
      (r) => r.status === 'pending'
    ).length;
    const item: Record<string, unknown> = {
      relic_id: row.id,
      access: 'private',
      current_version: row.version,
      sealed_version: row.sealedVersion ?? null,
      expires_at: row.expiresAt === undefined ? null : iso(row.expiresAt),
      pending_requests: pending,
    };
    if (withCoverage) {
      item['coverage_gaps'] = await coverageGaps(env, row, record);
    }
    owned.push(item);
  }

  const shared: unknown[] = [];
  for (const grant of await env.store.listGrantsForGrantee(record.identityId)) {
    if (grant.revokedAt !== undefined) continue;
    const row = await env.store.getRelic(grant.relicId);
    const owner = await env.store.getIdentity(grant.ownerIdentityId);
    if (row === undefined || owner === undefined) continue;
    shared.push({
      relic_id: row.id,
      readable_versions: await readableVersions(env, row, record.kemKeyId),
      expires_at: row.expiresAt === undefined ? null : iso(row.expiresAt),
      owner: partyJson(owner),
    });
  }
  return { owned, shared_with_me: shared };
}

/**
 * Sealed versions whose wraps lack a current recipient. A gap is the window
 * between a new recipient and the owner's backfill, and the dashboard shows
 * it so the owner can repair it.
 */
async function coverageGaps(
  env: PrivateEnv,
  row: {
    readonly id: string;
    readonly sealedVersion?: number | undefined;
    readonly deletedVersions?: readonly number[] | undefined;
  },
  owner: IdentityRecord
): Promise<number[]> {
  const sealed = row.sealedVersion ?? 0;
  const current = await recipientKeys(env, row as never, owner);
  const gaps: number[] = [];
  for (let version = 1; version <= sealed; version++) {
    if (row.deletedVersions?.includes(version)) continue;
    if ((await env.store.getSeal(row.id, version)) === undefined) continue;
    const have = new Set(
      (await env.store.listWraps(row.id, version)).map((w) => w.recipientKeyId)
    );
    const missing = current.filter((k) => !have.has(k));
    if (missing.length > 0) {
      gaps.push(version);
    }
  }
  return gaps;
}

/** The access log for an owner, oldest first, optionally for one relic. */
export async function accessEventsFor(
  env: PrivateEnv,
  record: IdentityRecord,
  relicId: string | undefined
): Promise<unknown[]> {
  const events = await env.store.listAccessEvents(
    record.identityId,
    env.now,
    relicId
  );
  return events.map((e) => ({
    event_id: e.eventId,
    at: iso(e.at),
    kind: e.kind,
    relic_id: e.relicId,
    version: e.version ?? null,
    actor: {
      email: e.actorEmail ?? null,
      identity_id: e.actorIdentityId ?? null,
      device_id: e.actorDeviceId ?? null,
    },
    subject_identity_id: e.subjectIdentityId ?? null,
  }));
}
