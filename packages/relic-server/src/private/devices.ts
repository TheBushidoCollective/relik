/**
 * Device keys (plan 4.16 and 4.7): the relic-mcp client's own identity, which
 * the owner certifies once and which then receives wraps like any reader.
 *
 * A device proves itself with one signature per request. The enrollment
 * proof, the certificate and the revocation are signed statements; a request
 * to `/context` is signed over the method, path and body hash, so a captured
 * request cannot be replayed to a different route.
 */

import {
  canonicalJson,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  fingerprintsEqual,
  parseStatement,
  parseTypedFingerprint,
  statementBytes,
  verifyStatement,
  InvalidStatementError,
  type DeviceAuthJSON,
  type DevicePublicJSON,
  type PartyJSON,
  type RecoveryJSON,
  type StatementKind,
  type StatementMap,
} from '@relic/format/private';
import { ProblemError } from '../problems.ts';
import type {
  DeviceEnrollmentRow,
  DeviceRecord,
  PasskeyRecord,
} from '../store.ts';
import {
  deviceJson,
  hexOf,
  iso,
  newEnrollmentId,
  type PrivateEnv,
  partyJson,
  sha256Hex,
} from './context.ts';
import { verifyAttestation } from './attest.ts';
import { identitySigner, currentIdentity, recoveryJson } from './identity.ts';

const BACKENDS = ['secure-enclave', 'file'] as const;
const DAY = 86_400_000;

function invalidDevice(check: string): never {
  throw new ProblemError('invalid_device', { device_check: check });
}

/** A statement parsed under its kind, or the device refusal. */
function parseDeviceStatement<K extends StatementKind>(
  kind: K,
  value: unknown
): StatementMap[K] {
  try {
    return parseStatement(kind, value);
  } catch (error) {
    if (error instanceof InvalidStatementError) invalidDevice(error.check);
    throw error;
  }
}

function keyBytes(text: unknown): Uint8Array {
  if (typeof text !== 'string') invalidDevice('key');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(text);
  } catch {
    invalidDevice('key');
  }
  if (bytes.byteLength !== 65 || bytes[0] !== 0x04) invalidDevice('key');
  return bytes;
}

/** Starts an enrollment: the device proves its keys, and its owner approves later. */
export async function enrollDevice(
  env: PrivateEnv,
  body: unknown
): Promise<{
  enrollment_id: string;
  approve_url: string;
  expires_at: string;
  device_id: string;
}> {
  if (typeof body !== 'object' || body === null) invalidDevice('shape');
  const b = body as Record<string, unknown>;
  const kem = keyBytes(b['kem_public_key']);
  const sig = keyBytes(b['sig_public_key']);
  const label = b['label'];
  const backend = b['backend'];
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    new TextEncoder().encode(label).byteLength > 64 ||
    typeof backend !== 'string' ||
    !(BACKENDS as readonly string[]).includes(backend)
  ) {
    invalidDevice('metadata');
  }
  const proof = b['proof'] as Record<string, unknown> | undefined;
  if (
    typeof proof !== 'object' ||
    proof === null ||
    typeof proof['signature'] !== 'string'
  ) {
    invalidDevice('proof');
  }
  const statement = parseDeviceStatement('device_enroll', proof['statement']);
  const deviceId = await deviceIdOf(kem, sig);
  if (
    statement['device_id'] !== deviceId ||
    statement['label'] !== label ||
    Math.abs(env.now - (statement['at'] as number)) >
      env.config.passkeyChallengeTtlSeconds * 1000
  ) {
    invalidDevice('statement');
  }
  const valid = await verifyStatement(
    sig,
    statementBytes('device_enroll', statement as never),
    proof['signature']
  );
  if (!valid) invalidDevice('signature');

  const enrollmentId = newEnrollmentId();
  const expiresAt = env.now + env.config.deviceEnrollmentTtlSeconds * 1000;
  const row: DeviceEnrollmentRow = {
    enrollmentId,
    deviceId,
    kemPublicKey: String(b['kem_public_key']),
    sigPublicKey: String(b['sig_public_key']),
    label,
    backend: backend as DeviceEnrollmentRow['backend'],
    createdAt: env.now,
    expiresAt,
    status: 'pending',
  };
  if (!(await env.store.putDeviceEnrollment(row))) {
    invalidDevice('enrollment');
  }
  return {
    enrollment_id: enrollmentId,
    approve_url: `${new URL(env.config.serviceOrigin).origin}/dashboard?approve-device=${enrollmentId}`,
    expires_at: iso(expiresAt),
    device_id: deviceId,
  };
}

/** The device's view of its own enrollment. The id in the path is the capability. */
export async function enrollmentStatus(
  env: PrivateEnv,
  enrollmentId: string
): Promise<Record<string, unknown>> {
  const row = await env.store.getDeviceEnrollment(enrollmentId);
  if (row === undefined) throw new ProblemError('device_not_found');
  if (row.status === 'pending' && env.now >= row.expiresAt) {
    throw new ProblemError('device_enrollment_expired');
  }
  if (row.status === 'pending') {
    return {
      status: 'pending',
      kem_public_key: row.kemPublicKey,
      sig_public_key: row.sigPublicKey,
      device_id: row.deviceId,
      label: row.label,
      expires_at: iso(row.expiresAt),
    };
  }
  const device = await env.store.getDevice(row.deviceId);
  if (device === undefined) throw new ProblemError('device_not_found');
  const owner = await env.store.getIdentity(device.ownerIdentityId);
  return {
    status: 'approved',
    device_id: row.deviceId,
    label: row.label,
    expires_at: iso(row.expiresAt),
    device: deviceJson(device),
    owner: owner === undefined ? undefined : partyJson(owner),
  };
}

/** The owner certifies a pending device after typing its fingerprint. */
export async function approveDevice(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly enrollmentId: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
  }
): Promise<DevicePublicJSON> {
  const owner = await currentIdentity(env, input.email);
  if (owner === undefined) throw new ProblemError('identity_required');
  const enrollment = await env.store.getDeviceEnrollment(input.enrollmentId);
  if (enrollment === undefined) throw new ProblemError('device_not_found');
  if (enrollment.status !== 'pending' || env.now >= enrollment.expiresAt) {
    throw new ProblemError('device_enrollment_expired');
  }

  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'device_approve',
    email: owner.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(owner),
  });
  const s = verified.statements[0]?.statement;
  if (s === undefined) invalidDevice('statement');
  if (
    s['device_id'] !== enrollment.deviceId ||
    s['kem_public_key'] !== enrollment.kemPublicKey ||
    s['sig_public_key'] !== enrollment.sigPublicKey ||
    s['label'] !== enrollment.label ||
    s['owner_identity_id'] !== owner.identityId
  ) {
    invalidDevice('statement');
  }
  const typed = parseTypedFingerprint(String(s['device_fingerprint_typed']));
  const computed = await deviceFingerprint(enrollment.deviceId);
  if (typed === undefined || !fingerprintsEqual(typed, computed)) {
    throw new ProblemError('fingerprint_mismatch');
  }
  const notAfter = s['not_after'] as number;
  if (
    notAfter <= env.now ||
    notAfter > env.now + env.config.deviceCertMaxDays * DAY
  ) {
    invalidDevice('not_after');
  }

  const record: DeviceRecord = {
    deviceId: enrollment.deviceId,
    ownerIdentityId: owner.identityId,
    kemPublicKey: enrollment.kemPublicKey,
    sigPublicKey: enrollment.sigPublicKey,
    kemKeyId: hexOf(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          decodeBase64url(enrollment.kemPublicKey) as BufferSource
        )
      )
    ),
    label: enrollment.label,
    backend: enrollment.backend,
    notAfter,
    certifiedAt: env.now,
    cert: verified.attestation,
  };
  const stored = await env.store.putDevice(record);
  if (stored !== 'created') {
    invalidDevice(stored === 'exists' ? 'exists' : 'kem_key');
  }
  await env.store.updateDeviceEnrollment(enrollment.enrollmentId, (r) => ({
    ...r,
    status: 'approved',
  }));
  await env.store.updateIdentity(owner.identityId, (current) => ({
    ...current,
    recipientsEpoch: current.recipientsEpoch + 1,
  }));
  return deviceJson(record);
}

/** Every device the signed-in owner has certified. */
export async function listOwnerDevices(
  env: PrivateEnv,
  email: string
): Promise<DevicePublicJSON[]> {
  const owner = await currentIdentity(env, email);
  if (owner === undefined) return [];
  return (await env.store.listDevicesForOwner(owner.identityId)).map(
    deviceJson
  );
}

/** Revokes one of the owner's devices and removes its wraps everywhere it had them. */
export async function revokeDevice(
  env: PrivateEnv,
  input: {
    readonly email: string;
    readonly deviceId: string;
    readonly passkeys: PasskeyRecord | undefined;
    readonly attestation: unknown;
  }
): Promise<DevicePublicJSON> {
  const owner = await currentIdentity(env, input.email);
  if (owner === undefined) throw new ProblemError('identity_required');
  const device = await env.store.getDevice(input.deviceId);
  if (device === undefined) throw new ProblemError('device_not_found');
  if (device.ownerIdentityId !== owner.identityId) {
    throw new ProblemError('owner_required');
  }
  const verified = await verifyAttestation(env, {
    bundle: input.attestation,
    purpose: 'device_revoke',
    email: owner.email,
    passkeys: input.passkeys,
    signerKey: identitySigner(owner),
  });
  const s = verified.statements[0]?.statement;
  if (
    s === undefined ||
    s['device_id'] !== device.deviceId ||
    s['owner_identity_id'] !== owner.identityId
  ) {
    invalidDevice('statement');
  }
  // Wraps go first. A failed sweep leaves the device certified, so the owner
  // retries; the sweep is idempotent and runs again on a retry.
  for (const owned of await env.store.listOwnedRelics(owner.identityId)) {
    await env.store.deleteWraps(owned.relicId, {
      recipientKeyId: device.kemKeyId,
    });
  }
  if (device.revokedAt !== undefined) return deviceJson(device);

  const revoked = await env.store.updateDevice(device.deviceId, (r) => ({
    ...r,
    revokedAt: env.now,
    revocation: verified.attestation,
  }));
  await env.store.updateIdentity(owner.identityId, (current) => ({
    ...current,
    recipientsEpoch: current.recipientsEpoch + 1,
  }));
  if (revoked === undefined) throw new ProblemError('device_not_found');
  return deviceJson(revoked);
}

/**
 * A device's auth block names a device that must be current, unexpired and
 * fresh. A revoked or expired device is refused before anything is verified.
 */
async function currentDevice(
  env: PrivateEnv,
  deviceId: string,
  auth: unknown
): Promise<{ device: DeviceRecord; auth: DeviceAuthJSON }> {
  const device = await env.store.getDevice(deviceId);
  if (device === undefined) throw new ProblemError('device_not_found');
  const block = auth as DeviceAuthJSON | undefined;
  if (
    typeof block !== 'object' ||
    block === null ||
    block.device_id !== deviceId ||
    typeof block.nonce !== 'string' ||
    typeof block.at !== 'number' ||
    typeof block.signature !== 'string'
  ) {
    invalidDevice('auth');
  }
  if (device.revokedAt !== undefined) throw new ProblemError('device_revoked');
  if (device.notAfter <= env.now) {
    throw new ProblemError('device_revoked', { device_check: 'expired' });
  }
  if (
    Math.abs(env.now - block.at) >
    env.config.passkeyChallengeTtlSeconds * 1000
  ) {
    invalidDevice('stale');
  }
  return { device, auth: block };
}

/**
 * Spends a device-signed nonce so it works once. It is kept until the
 * freshness window closes for it: after that the clock check refuses it, so
 * the record is only needed until then.
 */
async function spendDeviceNonce(
  env: PrivateEnv,
  deviceId: string,
  nonce: string,
  at: number
): Promise<void> {
  const nonceHash = await sha256Hex(`device-nonce:${deviceId}:${nonce}`);
  const until = at + env.config.passkeyChallengeTtlSeconds * 1000;
  if (!(await env.store.putDeviceNonce(nonceHash, until))) {
    invalidDevice('replay');
  }
}

/**
 * Checks one device request: the device is current, the signature covers
 * this method, path and body, the signature is fresh, and its nonce has not
 * been used. The body hash is over the canonical JSON of the body without
 * `device_auth` (plan 4.3).
 */
export async function verifyDeviceRequest(
  env: PrivateEnv,
  input: {
    readonly deviceId: string;
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown>;
    readonly auth: unknown;
  }
): Promise<DeviceRecord> {
  const { device, auth } = await currentDevice(env, input.deviceId, input.auth);
  const { device_auth: _ignored, ...withoutAuth } = input.body;
  const statement = parseDeviceStatement('device_request', {
    at: auth.at,
    body_sha256: await sha256Hex(canonicalJson(withoutAuth)),
    device_id: device.deviceId,
    method: input.method,
    nonce: auth.nonce,
    path: input.path,
  });
  const valid = await verifyStatement(
    decodeBase64url(device.sigPublicKey),
    statementBytes('device_request', statement),
    auth.signature
  );
  if (!valid) invalidDevice('signature');
  await spendDeviceNonce(env, device.deviceId, auth.nonce, auth.at);
  return device;
}

/**
 * The owner bind a device signs (plan 4.7): its own owner identity owns this
 * relic. The device proves it is current, holds its key, and spends its
 * nonce. The owner is the device's owner, never a value from the request.
 */
export async function verifyOwnerBind(
  env: PrivateEnv,
  input: { readonly relicId: string; readonly auth: unknown }
): Promise<DeviceRecord> {
  const block = input.auth as Partial<DeviceAuthJSON> | undefined;
  if (
    typeof block !== 'object' ||
    block === null ||
    typeof block.device_id !== 'string'
  ) {
    invalidDevice('auth');
  }
  const { device, auth } = await currentDevice(env, block.device_id, block);
  const statement = parseDeviceStatement('owner_bind', {
    at: auth.at,
    device_id: device.deviceId,
    nonce: auth.nonce,
    owner_identity_id: device.ownerIdentityId,
    relic_id: input.relicId,
  });
  const valid = await verifyStatement(
    decodeBase64url(device.sigPublicKey),
    statementBytes('owner_bind', statement),
    auth.signature
  );
  if (!valid) invalidDevice('signature');
  await spendDeviceNonce(env, device.deviceId, auth.nonce, auth.at);
  return device;
}

/** Everything a device needs to start: its record, its owner, and the owner's devices. */
export async function deviceContext(
  env: PrivateEnv,
  input: {
    readonly deviceId: string;
    readonly path: string;
    readonly body: Record<string, unknown>;
    readonly auth: unknown;
  }
): Promise<{
  device: DevicePublicJSON;
  owner: PartyJSON;
  devices: DevicePublicJSON[];
  recovery: RecoveryJSON | null;
  owner_epoch: number;
}> {
  const device = await verifyDeviceRequest(env, {
    deviceId: input.deviceId,
    method: 'POST',
    path: input.path,
    body: input.body,
    auth: input.auth,
  });
  const owner = await env.store.getIdentity(device.ownerIdentityId);
  if (owner === undefined) throw new ProblemError('device_not_found');
  return {
    device: deviceJson(device),
    owner: partyJson(owner),
    devices: (await env.store.listDevicesForOwner(owner.identityId)).map(
      deviceJson
    ),
    recovery:
      owner.recovery === undefined
        ? null
        : await recoveryJson(env, owner.recovery),
    owner_epoch: owner.recipientsEpoch,
  };
}
