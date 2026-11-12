/**
 * The shared environment every private-share route runs in, and the JSON
 * builders the wire shapes in `docs/plans/private-shares` 4.6 are made from.
 *
 * Nothing here holds a key. Identity and device records carry public keys
 * and the encrypted bundle; the fingerprints computed here are displayed by
 * clients and never returned by a route (plan 4.2).
 */

import {
  deviceFingerprint,
  identityFingerprint,
  kemKeyIdOf,
} from '@relic/format/private';
import type {
  DevicePublicJSON,
  IdentityPublicJSON,
  PartyJSON,
} from '@relic/format/private';
import type { OutboundMail } from '../mail.ts';
import type { RelicConfig, RateLimitConfig } from '../config.ts';
import { ProblemError } from '../problems.ts';
import type { PasskeyRecord } from '../store.ts';
import type {
  DeviceRecord,
  IdentityRecord,
  RelicRow,
  RelicStore,
} from '../store.ts';
import type { ObjectStorage } from '../storage.ts';

export const DAY_MS = 86_400_000;

/** The Crockford-style alphabet relic ids and fingerprints use (plan 4.2). */
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

export interface PrivateEnv {
  readonly store: RelicStore;
  readonly storage: ObjectStorage;
  readonly config: RelicConfig;
  /** The request's clock. Every expiry and freshness check reads this. */
  readonly now: number;
  /** One message to one address. The caller decides whether a failure matters. */
  readonly sendMail: (to: string, mail: OutboundMail) => Promise<void>;
  /** Spends one unit of the named budget, or throws `private_rate_limited`. */
  readonly limit: (scope: string, key: string, budget: RateLimitConfig) => void;
  /** The storage key a relic version's ciphertext lives under. */
  readonly objectKey: (relicId: string, version: number) => string;
  /**
   * The passkey assertion check the app's sign-in and decision paths share:
   * verifies the credential against the record, advances its counter, and
   * reports a refusal instead of throwing.
   */
  readonly assertPasskey: (
    record: PasskeyRecord,
    credential: unknown,
    challenge: string,
    now: number
  ) => Promise<
    | { readonly ok: true; readonly credentialId: string }
    | {
        readonly ok: false;
        readonly code: 'invalid_passkey' | 'passkey_verification_failed';
        readonly check: string;
      }
  >;
}

export function iso(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}

export function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  );
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hexOf(await sha256Bytes(bytes));
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Constant-time equality on two strings of any length. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * A 26-character enrollment id from 16 random bytes: 128 bits left-padded
 * to 130 and read in 5-bit groups, most significant bit first.
 */
export function newEnrollmentId(): string {
  const bytes = randomBytes(16);
  let bits = '00';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += B32[Number.parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export function rpIdOf(config: RelicConfig): string {
  return new URL(config.serviceOrigin).hostname;
}

export function originOf(config: RelicConfig): string {
  return new URL(config.serviceOrigin).origin;
}

/** Refuses anything that is not a non-negative safe integer. */
export function safeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function identityPublicJson(record: IdentityRecord): IdentityPublicJSON {
  return {
    identity_id: record.identityId,
    email: record.email,
    kem_public_key: record.kemPublicKey,
    sig_public_key: record.sigPublicKey,
    created_at: iso(record.createdAt),
    retired_at: record.retiredAt === undefined ? null : iso(record.retiredAt),
  };
}

export function partyJson(record: IdentityRecord): PartyJSON {
  return { email: record.email, identity: identityPublicJson(record) };
}

export async function ownerParty(
  store: RelicStore,
  identityId: string
): Promise<PartyJSON | null> {
  const record = await store.getIdentity(identityId);
  return record === undefined ? null : partyJson(record);
}

export function deviceJson(record: DeviceRecord): DevicePublicJSON {
  const cert = record.cert.statements[0];
  if (cert === undefined) {
    throw new Error('device record has no certificate statement');
  }
  return {
    device_id: record.deviceId,
    owner_identity_id: record.ownerIdentityId,
    kem_public_key: record.kemPublicKey,
    sig_public_key: record.sigPublicKey,
    label: record.label,
    backend: record.backend,
    not_after: record.notAfter,
    certified_at: iso(record.certifiedAt),
    revoked_at: record.revokedAt === undefined ? null : iso(record.revokedAt),
    cert: {
      statement: cert.statement,
      identity_signature: cert.identitySignature,
    },
  };
}

/** The identity fingerprint, computed here from public keys (plan 4.2). */
export async function fingerprintOf(record: IdentityRecord): Promise<string> {
  return identityFingerprint(record.identityId, record.email);
}

/** The identity's raw KEM key id, lowercase hex: the wire `recipient_key_id`. */
export async function kemKeyIdHex(kemPublicKey: Uint8Array): Promise<string> {
  const id = await kemKeyIdOf(kemPublicKey);
  return [...id].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deviceFingerprintOf(
  record: DeviceRecord
): Promise<string> {
  return deviceFingerprint(record.deviceId);
}

/**
 * The relic's row, after the checks every private route shares: the row
 * exists, it is not removed, and it has not expired. A removed id reads as
 * removed even when the row is gone, because the tombstone survives.
 */
export async function liveRelic(
  env: PrivateEnv,
  relicId: string
): Promise<RelicRow> {
  if ((await env.store.getTombstone(relicId)) !== undefined) {
    throw new ProblemError('relic_removed', { relic_id: relicId });
  }
  const row = await env.store.getRelic(relicId);
  if (row === undefined) {
    throw new ProblemError('relic_not_found', { relic_id: relicId });
  }
  if (row.expiresAt !== undefined && env.now >= row.expiresAt) {
    throw new ProblemError('relic_expired', { relic_id: relicId });
  }
  return row;
}

/** A private relic, or the refusal every private-only route shares. */
export function privateRow(row: RelicRow): RelicRow {
  if (row.access !== 'private' || row.ownerIdentityId === undefined) {
    throw new ProblemError('private_policy_violation', {
      policy_check: 'version',
      detail: 'This relic is not a private relic.',
    });
  }
  return row;
}
