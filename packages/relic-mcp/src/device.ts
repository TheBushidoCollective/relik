/**
 * This machine's device for one service: its key store, enrollment, owner
 * pinning, and the verification every private publish runs before it wraps a
 * key to anyone.
 *
 * A device key is what relic-mcp signs and unwraps with, so the owner never
 * taps a passkey to publish. The owner's identity certifies the device, and
 * this machine pins that identity when the owner confirms the device. Later
 * decisions about who may read a private relic come from the pin, never from
 * the service's word.
 *
 * Keys live in `device-keys.json`, partitioned by service origin, 0600 in a
 * 0700 directory. The Secure Enclave is used when the platform helper reports
 * it available; otherwise private keys are stored as JWK in that file.
 * Nothing here returns key material, and nothing writes it anywhere else.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeEmail } from '@relic/format';
import {
  advanceRosterFloor,
  canonicalJson,
  type DesignationMark,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  formatFingerprint,
  fingerprintsEqual,
  generateIdentityKeys,
  type HpkeRecipient,
  identityFingerprint,
  identityIdOf,
  parseStatement,
  parseTypedFingerprint,
  type RosterFloor,
  type RosterMark,
  type RosterObservation,
  RosterStaleError,
  rosterAdmits,
  type SignedStatementBody,
  signStatement,
  type StatementMap,
  statementBytes,
  verifySignedStatement,
  verifyStatement,
} from '@relic/format/private';
import {
  getJson,
  postJson,
  PublishError,
  type PublishDeps,
  ServerRefusal,
} from './publish.ts';
import { isPlainObject, publishStatePath } from './state.ts';

/**
 * The Secure Enclave helper's interface (plan section 4.17). The helper is
 * built separately and plugs in through `PublishDeps.secureEnclave`. Until it
 * is wired, every device uses the file backend.
 */
export interface SecureEnclaveSeam {
  available(): Promise<boolean>;
  create(): Promise<{
    kem: { blob: string; publicKey: Uint8Array };
    sig: { blob: string; publicKey: Uint8Array };
  }>;
  sign(blob: string, message: Uint8Array): Promise<Uint8Array>;
  ecdh(blob: string, peerPublicKey: Uint8Array): Promise<Uint8Array>;
}

export type DeviceBackend = 'secure-enclave' | 'file';

/** One private key: a JWK in the file, or a Secure Enclave blob. */
export interface KeyBlob {
  readonly jwk?: JsonWebKey | undefined;
  readonly se_blob?: string | undefined;
}

/** The owner a device pinned at confirmation. Every field is public. */
export interface DeviceOwner {
  readonly identity_id: string;
  readonly email: string;
  readonly kem_public_key: string;
  readonly sig_public_key: string;
  readonly pinned_at: string;
}

export interface DeviceEnrollment {
  readonly enrollment_id: string;
  readonly approve_url: string;
  readonly expires_at: string;
}

export interface DeviceCert {
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
}

export interface DeviceEntry {
  readonly device_id: string;
  readonly backend: DeviceBackend;
  readonly label: string;
  readonly created_at: string;
  readonly kem_public_key: string;
  readonly sig_public_key: string;
  readonly kem_private: KeyBlob;
  readonly sig_private: KeyBlob;
  readonly enrollment?: DeviceEnrollment | undefined;
  readonly cert?: DeviceCert | undefined;
  readonly owner?: DeviceOwner | undefined;
  /**
   * What the service has shown this machine about the pinned owner. It holds
   * owner-signed facts only (a verified designation, revocation or live
   * statement time), so nothing the service asserts alone can move it. It only
   * moves forward, and it persists with the device entry.
   */
  readonly owner_seen?: RosterFloor | undefined;
}

/** A recovery designation the owner signed and this machine verified. */
export interface VerifiedRecovery {
  readonly reader: VerifiedReader;
  readonly identityId: string;
  /** The owner-signed `at` of the designation. */
  readonly designatedAt: number;
}

/**
 * The newest recovery designation an answer carries, verified. `reader` is the
 * holder in force, and is undefined when the newest owner-signed designation
 * removed the holder.
 */
export interface VerifiedDesignation {
  readonly mark: DesignationMark;
  readonly reader: VerifiedReader | undefined;
}

/** A device the pinned owner certified that is live now. */
export interface VerifiedLiveDevice {
  readonly deviceId: string;
  /** The owner-signed `at` of its certificate. */
  readonly at: number;
  readonly reader: VerifiedReader;
}

/**
 * A device list the pin verified: the live devices that may hold a wrap, and
 * the roster mark of every device the answer states (a live certificate, or a
 * revocation the owner signed).
 */
export interface VerifiedDeviceList {
  readonly live: readonly VerifiedLiveDevice[];
  readonly statements: Readonly<Record<string, RosterMark>>;
}

interface DeviceKeysFile {
  readonly devices: Readonly<Record<string, DeviceEntry>>;
}

/** Signing and key agreement for this device, whichever backend holds them. */
export interface DeviceSigner {
  readonly deviceId: string;
  readonly recipient: HpkeRecipient;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** A party the service named, after the checks that make it a real one. */
export interface VerifiedReader {
  readonly kind: 'owner' | 'device' | 'recovery' | 'grantee';
  readonly publicKey: Uint8Array;
  /** Lowercase hex SHA-256 of the KEM public key: the wire `recipient_key_id`. */
  readonly keyId: string;
  readonly email?: string | undefined;
  readonly label?: string | undefined;
  /** Display form, computed here from public keys. */
  readonly fingerprint: string;
}

/**
 * The device list and recovery designation a device context returns, verified
 * and admitted against what this machine has accepted for the owner. Only
 * `ownerEpoch` is the service's own count: it is a hint for the seal, pinned
 * nowhere, and the service checks it when the seal lands.
 */
export interface DeviceContext {
  readonly ownerEpoch: number;
  /** Devices that may hold a wrap now: certified, unexpired, and not revoked by a signed revocation. */
  readonly devices: readonly VerifiedReader[];
  /** The recovery designation in force, or undefined when none is, or it was removed. */
  readonly recovery: VerifiedReader | undefined;
}

const P256_ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const P256_ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_HASH = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * Where the device key file lives: beside the publish state, overridable for
 * tests.
 *
 * Threat model, same user: the file and the publish state are 0600, so other
 * users cannot read them. A file-backend private key is a plaintext JWK in
 * this file, and any process running as this user can read it. A Secure
 * Enclave key carries no access control, so any same-user process that can
 * run the helper can use it. relic-mcp defends against other users and
 * against the service. It does not defend against code already running as
 * the user. See the relic skill's threat model.
 */
export function deviceKeysPath(): string {
  const override = process.env['RELIC_DEVICE_KEYS'];
  if (override !== undefined && override.length > 0) return override;
  return join(dirname(publishStatePath()), 'device-keys.json');
}

/** An app-server body that is not the shape the caller needs is a refusal, never a crash. */
export function expectRecord(
  value: unknown,
  what: string
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new PublishError(
      'app_response_unusable',
      `the service answered with no usable ${what}`
    );
  }
  return value;
}

export function expectString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PublishError(
      'app_response_unusable',
      `the service answered with no usable ${what}`
    );
  }
  return value;
}

function parseKeysFile(raw: string): DeviceKeysFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The message names the path and never the contents, which hold keys.
    throw new Error(
      `device keys at ${deviceKeysPath()} are not valid JSON. The file is ` +
        'left as it is; this device cannot be used until it is fixed or removed.'
    );
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed['devices'])) {
    throw new Error(
      `device keys at ${deviceKeysPath()} do not have the expected shape.`
    );
  }
  return { devices: parsed['devices'] as Record<string, DeviceEntry> };
}

async function readKeysFile(): Promise<DeviceKeysFile> {
  let raw: string;
  try {
    raw = await readFile(deviceKeysPath(), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { devices: {} };
    throw new Error(
      `could not read device keys at ${deviceKeysPath()}: ${code}`
    );
  }
  return parseKeysFile(raw);
}

/** The enrolled device for one service origin, or undefined when there is none. */
export async function loadDeviceEntry(
  origin: string
): Promise<DeviceEntry | undefined> {
  const file = await readKeysFile();
  return file.devices[origin];
}

// Writers queue behind one chain. Two enrollments finishing together must not
// read-modify-write past each other, or one origin's device silently vanishes.
let deviceWriteChain: Promise<void> = Promise.resolve();

/** Replace one origin's device, preserving every other origin. */
export function writeDeviceEntry(
  origin: string,
  entry: DeviceEntry
): Promise<void> {
  const run = deviceWriteChain.then(() => storeEntry(origin, entry));
  deviceWriteChain = run.catch(() => undefined);
  return run;
}

async function storeEntry(origin: string, entry: DeviceEntry): Promise<void> {
  const path = deviceKeysPath();
  // 0700 applies to the directory this creates. An existing config root is
  // never re-moded, the same rule the publish state follows.
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const file = await readKeysFile();
  const next: DeviceKeysFile = {
    devices: { ...file.devices, [origin]: entry },
  };
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function validateLabel(label: string): void {
  const bytes = new TextEncoder().encode(label).length;
  if (bytes < 1 || bytes > 64 || /\p{Cc}/u.test(label)) {
    throw new PublishError(
      'local_device_label_invalid',
      'a device label is 1 to 64 bytes with no control characters'
    );
  }
}

interface FreshKeys {
  readonly backend: DeviceBackend;
  readonly kemPublicKey: Uint8Array;
  readonly sigPublicKey: Uint8Array;
  readonly kemPrivate: KeyBlob;
  readonly sigPrivate: KeyBlob;
}

async function createKeys(
  helper: SecureEnclaveSeam | undefined
): Promise<FreshKeys> {
  if (helper !== undefined && (await helper.available())) {
    const created = await helper.create();
    return {
      backend: 'secure-enclave',
      kemPublicKey: created.kem.publicKey,
      sigPublicKey: created.sig.publicKey,
      kemPrivate: { se_blob: created.kem.blob },
      sigPrivate: { se_blob: created.sig.blob },
    };
  }
  const keys = await generateIdentityKeys();
  return {
    backend: 'file',
    kemPublicKey: keys.kemPublicKey,
    sigPublicKey: keys.sigPublicKey,
    kemPrivate: {
      jwk: await crypto.subtle.exportKey('jwk', keys.kem.privateKey),
    },
    sigPrivate: {
      jwk: await crypto.subtle.exportKey('jwk', keys.sig.privateKey),
    },
  };
}

/** The signer for a stored device. The Secure Enclave is reached only through the seam. */
export async function deviceSigner(
  entry: DeviceEntry,
  helper: SecureEnclaveSeam | undefined
): Promise<DeviceSigner> {
  const kemPublicKey = decodeBase64url(entry.kem_public_key);
  if (entry.backend === 'secure-enclave') {
    const kemBlob = entry.kem_private.se_blob;
    const sigBlob = entry.sig_private.se_blob;
    if (
      helper === undefined ||
      kemBlob === undefined ||
      sigBlob === undefined
    ) {
      throw new PublishError(
        'device_key_unavailable',
        'this device key lives in the Secure Enclave, and this build cannot reach it'
      );
    }
    return {
      deviceId: entry.device_id,
      recipient: {
        publicKey: kemPublicKey,
        dh: (peer) => helper.ecdh(kemBlob, peer),
      },
      sign: (bytes) => helper.sign(sigBlob, bytes),
    };
  }

  const kemJwk = entry.kem_private.jwk;
  const sigJwk = entry.sig_private.jwk;
  if (kemJwk === undefined || sigJwk === undefined) {
    throw new PublishError(
      'device_key_unavailable',
      'the device key file holds no usable private key for this device'
    );
  }
  const kemKey = await crypto.subtle.importKey(
    'jwk',
    kemJwk,
    P256_ECDH,
    false,
    ['deriveBits']
  );
  const sigKey = await crypto.subtle.importKey(
    'jwk',
    sigJwk,
    P256_ECDSA,
    false,
    ['sign']
  );
  return {
    deviceId: entry.device_id,
    recipient: {
      publicKey: kemPublicKey,
      dh: async (peer) => {
        const peerKey = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(peer),
          P256_ECDH,
          false,
          []
        );
        const bits = await crypto.subtle.deriveBits(
          { name: 'ECDH', public: peerKey },
          kemKey,
          256
        );
        return new Uint8Array(bits);
      },
    },
    sign: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(SIGN_HASH, sigKey, new Uint8Array(bytes))
      ),
  };
}

/** A device-signed or owner-signed statement's base64url signature. */
export function signDeviceStatement<K extends keyof StatementMap>(
  signer: DeviceSigner,
  kind: K,
  statement: StatementMap[K]
): Promise<string> {
  return signStatement(signer.sign, statementBytes(kind, statement));
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fresh statement nonce: the canonical base64url of 32 random bytes (plan 4.2). */
export function freshNonce(): string {
  return encodeBase64url(randomBytes(32));
}

/**
 * An identity party the service named, with its keys proven to be the
 * identity it claims. A service that names keys hashing to some other
 * identity is refused before any of them is used.
 */
export async function partyIdentity(
  identity: Record<string, unknown>
): Promise<{
  identityId: string;
  email: string;
  kem: string;
  sig: string;
  kemBytes: Uint8Array;
  sigBytes: Uint8Array;
}> {
  const identityId = expectString(identity['identity_id'], 'identity id');
  const email = expectString(identity['email'], 'identity email');
  const kem = expectString(identity['kem_public_key'], 'identity KEM key');
  const sig = expectString(identity['sig_public_key'], 'identity signing key');
  const kemBytes = decodeBase64url(kem);
  const sigBytes = decodeBase64url(sig);
  if ((await identityIdOf(kemBytes, sigBytes)) !== identityId) {
    throw new PublishError(
      'recipient_key_mismatch',
      'an identity the service named does not hash to its identity id'
    );
  }
  return { identityId, email, kem, sig, kemBytes, sigBytes };
}

/**
 * The service's owner, checked against the pin this machine holds. A
 * mismatch means the service names a different owner than the one this
 * device was certified by, and nothing may be wrapped for it.
 */
export function assertOwnerPin(
  pin: DeviceOwner,
  party: {
    readonly identityId: string;
    readonly email: string;
    readonly kem: string;
    readonly sig: string;
  }
): void {
  if (
    party.identityId !== pin.identity_id ||
    party.kem !== pin.kem_public_key ||
    party.sig !== pin.sig_public_key ||
    normalizeEmail(party.email) !== normalizeEmail(pin.email)
  ) {
    throw new PublishError(
      'owner_pin_mismatch',
      'the service names a different owner than the one this device was ' +
        'certified by, so no key is wrapped for it'
    );
  }
}

/**
 * Verify a device certificate: the pinned owner's signature over the
 * `device_cert` statement, every field of that statement against the device
 * it certifies, and the device id against its keys. A device that fails any
 * of these is refused, never skipped, so a service cannot quietly narrow or
 * widen the recipient list.
 */
export async function verifyDeviceCert(input: {
  readonly deviceId: string;
  readonly ownerIdentityId: string;
  readonly ownerSigPublicKey: Uint8Array;
  readonly kemPublicKey: string;
  readonly sigPublicKey: string;
  readonly label: string;
  readonly notAfter: number;
  readonly cert: DeviceCert;
}): Promise<void> {
  const uncertified = new PublishError(
    'recipient_uncertified_device',
    `device ${input.deviceId} is not certified by the pinned owner`
  );
  const kemBytes = decodeBase64url(input.kemPublicKey);
  const sigBytes = decodeBase64url(input.sigPublicKey);
  if ((await deviceIdOf(kemBytes, sigBytes)) !== input.deviceId)
    throw uncertified;

  const statement = parseStatement('device_cert', input.cert.statement);
  const bound =
    statement.device_id === input.deviceId &&
    statement.owner_identity_id === input.ownerIdentityId &&
    statement.kem_public_key === input.kemPublicKey &&
    statement.sig_public_key === input.sigPublicKey &&
    statement.label === input.label &&
    statement.not_after === input.notAfter &&
    fingerprintsEqual(
      statement.device_fingerprint_typed,
      await deviceFingerprint(input.deviceId)
    );
  if (!bound) throw uncertified;

  const signed = await verifyStatement(
    input.ownerSigPublicKey,
    statementBytes('device_cert', statement),
    input.cert.identity_signature
  );
  if (!signed) throw uncertified;
}

export interface EnrollResult {
  readonly status: 'pending';
  readonly enrollment_id: string;
  readonly approve_url: string;
  readonly device_id: string;
  readonly device_fingerprint: string;
  readonly backend: DeviceBackend;
  readonly expires_at: string;
}

/**
 * Create this machine's device key and ask the service to enroll it.
 *
 * The device signs its own enrollment, so the service can prove who asked.
 * The owner then approves the device in the browser after typing this
 * device's fingerprint. Nothing is pinned yet: that happens in
 * `confirmDevice`, after the owner reads back the owner fingerprint.
 */
export async function enrollDevice(
  input: { readonly label?: string | undefined },
  deps: PublishDeps
): Promise<EnrollResult> {
  const origin = deps.serviceOrigin;
  const existing = await loadDeviceEntry(origin);
  if (existing?.owner !== undefined) {
    throw new PublishError(
      'device_already_enrolled',
      `this machine already has a device for ${origin}, certified for ` +
        `${existing.owner.email}. Another device needs its owner's approval ` +
        'from the dashboard, not a new enrollment here.'
    );
  }

  const label = input.label ?? `${deps.clientName} on this machine`;
  validateLabel(label);
  const keys = await createKeys(deps.secureEnclave);
  const deviceId = await deviceIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const draft: DeviceEntry = {
    device_id: deviceId,
    backend: keys.backend,
    label,
    created_at: new Date().toISOString(),
    kem_public_key: encodeBase64url(keys.kemPublicKey),
    sig_public_key: encodeBase64url(keys.sigPublicKey),
    kem_private: keys.kemPrivate,
    sig_private: keys.sigPrivate,
  };
  const signer = await deviceSigner(draft, deps.secureEnclave);

  const statement: StatementMap['device_enroll'] = {
    at: Date.now(),
    device_id: deviceId,
    label,
  };
  const signature = await signDeviceStatement(
    signer,
    'device_enroll',
    statement
  );
  const response = expectRecord(
    await postJson(deps, `${origin}/api/devices/enrollments`, {
      kem_public_key: draft.kem_public_key,
      sig_public_key: draft.sig_public_key,
      label,
      backend: keys.backend,
      proof: { statement, signature },
    }),
    'enrollment'
  );
  if (response['device_id'] !== deviceId) {
    throw new PublishError(
      'device_enrollment_invalid',
      'the service enrolled a different device than the one this machine created'
    );
  }
  const enrollment: DeviceEnrollment = {
    enrollment_id: expectString(response['enrollment_id'], 'enrollment id'),
    approve_url: expectString(response['approve_url'], 'approval URL'),
    expires_at: expectString(response['expires_at'], 'enrollment expiry'),
  };
  await writeDeviceEntry(origin, { ...draft, enrollment });
  return {
    status: 'pending',
    enrollment_id: enrollment.enrollment_id,
    approve_url: enrollment.approve_url,
    device_id: deviceId,
    device_fingerprint: formatFingerprint(await deviceFingerprint(deviceId)),
    backend: keys.backend,
    expires_at: enrollment.expires_at,
  };
}

export interface ConfirmResult {
  readonly status: 'confirmed';
  readonly device_id: string;
  readonly owner: { readonly email: string; readonly fingerprint: string };
}

/**
 * Pin the owner once the owner has approved this device.
 *
 * The owner reads the owner fingerprint off the approval page and types it
 * here. Both sides of that comparison are computed on this machine from the
 * owner's public keys, so a service that invents its own owner cannot match
 * it. A mismatch pins nothing.
 */
export async function confirmDevice(
  input: { readonly owner_fingerprint: string },
  deps: PublishDeps
): Promise<ConfirmResult> {
  const origin = deps.serviceOrigin;
  const entry = await loadDeviceEntry(origin);
  if (entry?.enrollment === undefined) {
    throw new PublishError(
      'device_not_enrolled',
      `no device enrollment is waiting for ${origin}. Call relic_enroll_device first.`
    );
  }
  if (entry.owner !== undefined) {
    throw new PublishError(
      'device_already_confirmed',
      `this device is already certified for ${entry.owner.email}`
    );
  }

  const status = await fetchEnrollment(deps, entry.enrollment);
  if (status['status'] !== 'approved') {
    throw new PublishError(
      'device_enrollment_pending',
      'the owner has not approved this device yet. Approve it at ' +
        `${entry.enrollment.approve_url}, then confirm again.`
    );
  }
  const device = expectRecord(status['device'], 'device');
  const ownerParty = expectRecord(status['owner'], 'owner');
  const owner = await partyIdentity(
    expectRecord(ownerParty['identity'], 'owner identity')
  );
  if (
    device['device_id'] !== entry.device_id ||
    device['kem_public_key'] !== entry.kem_public_key ||
    device['sig_public_key'] !== entry.sig_public_key ||
    device['owner_identity_id'] !== owner.identityId
  ) {
    throw new PublishError(
      'recipient_key_mismatch',
      'the service approved a device whose keys or owner are not this machine'
    );
  }

  const cert = expectRecord(device['cert'], 'device certificate');
  const deviceCert: DeviceCert = {
    statement: expectRecord(cert['statement'], 'device certificate statement'),
    identity_signature: expectString(
      cert['identity_signature'],
      'device certificate signature'
    ),
  };
  await verifyDeviceCert({
    deviceId: entry.device_id,
    ownerIdentityId: owner.identityId,
    ownerSigPublicKey: owner.sigBytes,
    kemPublicKey: entry.kem_public_key,
    sigPublicKey: entry.sig_public_key,
    label: entry.label,
    notAfter: Number(device['not_after']),
    cert: deviceCert,
  });

  const email = normalizeEmail(
    expectString(ownerParty['email'], 'owner email')
  );
  const fingerprint = await identityFingerprint(owner.identityId, email);
  const typed = parseTypedFingerprint(input.owner_fingerprint);
  if (typed === undefined || !fingerprintsEqual(typed, fingerprint)) {
    throw new PublishError(
      'device_owner_fingerprint_mismatch',
      'the owner fingerprint typed does not match the owner the service approved. ' +
        'Nothing was pinned. Read the owner fingerprint from the approval page again.'
    );
  }

  await writeDeviceEntry(origin, {
    ...entry,
    enrollment: undefined,
    cert: deviceCert,
    owner: {
      identity_id: owner.identityId,
      email,
      kem_public_key: owner.kem,
      sig_public_key: owner.sig,
      pinned_at: new Date().toISOString(),
    },
  });
  return {
    status: 'confirmed',
    device_id: entry.device_id,
    owner: { email, fingerprint: formatFingerprint(fingerprint) },
  };
}

async function fetchEnrollment(
  deps: PublishDeps,
  enrollment: DeviceEnrollment
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await getJson(
      deps,
      `${deps.serviceOrigin}/api/devices/enrollments/${enrollment.enrollment_id}`
    );
  } catch (error) {
    if (
      error instanceof ServerRefusal &&
      (error.code === 'device_enrollment_expired' ||
        error.code === 'device_not_found')
    ) {
      throw new PublishError(
        'device_enrollment_expired',
        'this enrollment expired before it was approved. Enroll the device again.'
      );
    }
    throw error;
  }
  return expectRecord(body, 'enrollment status');
}

/**
 * Ask the service for this device's context and verify it against the pin.
 *
 * The request is device-signed over a `device_request` statement that binds
 * the path and the body, so a replayed or redirected request does not verify.
 * The answer is held to what this machine has already accepted, and recorded,
 * before the caller can wrap anything to it.
 */
export async function fetchDeviceContext(
  deps: PublishDeps,
  entry: DeviceEntry,
  signer: DeviceSigner,
  pin: DeviceOwner
): Promise<DeviceContext> {
  const path = `/api/devices/${entry.device_id}/context`;
  const statement: StatementMap['device_request'] = {
    at: Date.now(),
    body_sha256: sha256Hex(canonicalJson({})),
    device_id: entry.device_id,
    method: 'POST',
    nonce: freshNonce(),
    path,
  };
  const signature = await signDeviceStatement(
    signer,
    'device_request',
    statement
  );
  const body = expectRecord(
    await postJson(deps, `${deps.serviceOrigin}${path}`, {
      device_auth: {
        device_id: entry.device_id,
        nonce: statement.nonce,
        at: statement.at,
        signature,
      },
    }),
    'device context'
  );

  const ownerParty = expectRecord(body['owner'], 'owner');
  const owner = await partyIdentity(
    expectRecord(ownerParty['identity'], 'owner identity')
  );
  assertOwnerPin(pin, {
    identityId: owner.identityId,
    email: expectString(ownerParty['email'], 'owner email'),
    kem: owner.kem,
    sig: owner.sig,
  });

  const devices = await verifyDeviceList(body['devices'], pin, Date.now());
  const designation = await verifyDesignationAnswer(body, pin);
  const ownerEpoch = expectEpoch(body['owner_epoch'], 'owner epoch');
  const floor = await observeOwnerState(deps.serviceOrigin, {
    designation: designation?.mark ?? null,
    devices: devices.statements,
  });
  return {
    ownerEpoch,
    devices: admittedDevices(devices, floor),
    recovery: designation?.reader,
  };
}

/** The live devices the floor admits: a device a verified revocation covers is no recipient. */
export function admittedDevices(
  list: VerifiedDeviceList,
  floor: RosterFloor
): VerifiedReader[] {
  return list.live
    .filter((device) =>
      rosterAdmits(floor.devices?.[device.deviceId], device.at)
    )
    .map((device) => device.reader);
}

/**
 * Verify a recovery designation: the owner's signature over it, and the
 * fingerprint it names matching the recovery identity's keys. An unsigned or
 * mismatched designation is refused, never wrapped to.
 */
export async function verifyRecovery(
  recovery: Record<string, unknown>,
  pin: DeviceOwner
): Promise<VerifiedRecovery> {
  const unsigned = new PublishError(
    'recovery_unsigned',
    'the recovery designation is not signed by the pinned owner'
  );
  const party = await partyIdentity(
    expectRecord(recovery['identity'], 'recovery identity')
  );
  const designation = expectRecord(
    recovery['designation'],
    'recovery designation'
  );
  const statement = parseStatement(
    'recovery_designation',
    expectRecord(designation['statement'], 'recovery designation statement')
  );
  if (
    statement.owner_identity_id !== pin.identity_id ||
    statement.recovery_identity_id !== party.identityId ||
    statement.recovery_email === null ||
    normalizeEmail(statement.recovery_email) !== normalizeEmail(party.email) ||
    statement.fingerprint_typed === null
  ) {
    throw unsigned;
  }
  const signed = await verifyStatement(
    decodeBase64url(pin.sig_public_key),
    statementBytes('recovery_designation', statement),
    expectString(designation['identity_signature'], 'designation signature')
  );
  if (!signed) throw unsigned;
  const fingerprint = await identityFingerprint(party.identityId, party.email);
  if (!fingerprintsEqual(statement.fingerprint_typed, fingerprint))
    throw unsigned;
  return {
    reader: {
      kind: 'recovery',
      publicKey: party.kemBytes,
      keyId: sha256Hex(party.kemBytes),
      email: normalizeEmail(party.email),
      fingerprint: formatFingerprint(fingerprint),
    },
    identityId: party.identityId,
    designatedAt: statement.at,
  };
}

/**
 * The recovery designation a recipients or device-context answer carries,
 * verified against the pin. `recovery` is the holder in force. `recovery_statement`
 * is the owner's newest signed designation, and it is a removal when all three
 * party fields are null. The greatest owner-signed `at` decides. A designation
 * statement must name the holder the answer carries, and a holder and a removal
 * at the same time cannot be ordered, so the answer is refused. Returns null when
 * the answer carries no signed designation at all.
 */
export async function verifyDesignationAnswer(
  answer: Record<string, unknown>,
  pin: DeviceOwner
): Promise<VerifiedDesignation | null> {
  const unsigned = new PublishError(
    'recovery_unsigned',
    'the recovery designation is not signed by the pinned owner'
  );
  const holder =
    answer['recovery'] === null || answer['recovery'] === undefined
      ? undefined
      : await verifyRecovery(expectRecord(answer['recovery'], 'recovery'), pin);
  const signedField = answer['recovery_statement'];
  let statement: StatementMap['recovery_designation'] | undefined;
  if (signedField !== null && signedField !== undefined) {
    const signed = signedBodyOf(signedField);
    if (signed === undefined) throw unsigned;
    statement = await verifySignedStatement(
      'recovery_designation',
      signed,
      decodeBase64url(pin.sig_public_key)
    );
    if (
      statement === undefined ||
      statement.owner_identity_id !== pin.identity_id
    ) {
      throw unsigned;
    }
  }
  const removed =
    statement !== undefined &&
    statement.recovery_identity_id === null &&
    statement.recovery_email === null &&
    statement.fingerprint_typed === null;
  if (
    statement !== undefined &&
    !removed &&
    (holder === undefined ||
      holder.identityId !== statement.recovery_identity_id)
  ) {
    throw new PublishError(
      'recovery_ambiguous',
      'the newest recovery designation names a holder this answer does not carry, so neither is trusted'
    );
  }
  if (
    statement !== undefined &&
    holder !== undefined &&
    statement.at === holder.designatedAt &&
    removed
  ) {
    throw new PublishError(
      'recovery_ambiguous',
      'a recovery holder and a removal carry the same time, so neither is trusted'
    );
  }
  if (
    statement !== undefined &&
    (holder === undefined || statement.at > holder.designatedAt)
  ) {
    return {
      mark: { at: statement.at, removed },
      reader: removed ? undefined : holder?.reader,
    };
  }
  if (holder === undefined) return null;
  return {
    mark: { at: holder.designatedAt, removed: false },
    reader: holder.reader,
  };
}

/** The signed body a wire `{statement, identity_signature}` carries, or undefined when it is not one. */
export function signedBodyOf(value: unknown): SignedStatementBody | undefined {
  if (!isPlainObject(value)) return undefined;
  const statement = value['statement'];
  const signature = value['identity_signature'];
  if (!isPlainObject(statement) || typeof signature !== 'string') {
    return undefined;
  }
  return { statement, identity_signature: signature };
}

/**
 * Verify a service's device list against the pin.
 *
 * A live device is unexpired, and its certificate is one the pinned owner
 * signed. An active device whose certificate does not verify refuses the whole
 * list. A revocation counts only when the owner signed it: a verified
 * `device_revocation` becomes a roster mark, and the device is no recipient. A
 * `revoked_at` flag without a verified revocation is ignored, so the device is
 * live when its certificate checks out. A flagged device whose certificate or
 * revocation does not verify is skipped and recorded nowhere, so one bad entry
 * cannot stop a publish. An expired device is not a recipient either.
 */
export async function verifyDeviceList(
  list: unknown,
  pin: DeviceOwner,
  now: number
): Promise<VerifiedDeviceList> {
  if (!Array.isArray(list)) {
    throw new PublishError(
      'app_response_unusable',
      'the device list is missing'
    );
  }
  const ownerSigPublicKey = decodeBase64url(pin.sig_public_key);
  const live: VerifiedLiveDevice[] = [];
  const statements: Record<string, RosterMark> = {};
  for (const item of list) {
    const device = expectRecord(item, 'device');
    const deviceId = expectString(device['device_id'], 'device id');
    const revocation = signedBodyOf(device['revocation']);
    if (revocation !== undefined) {
      const verified = await verifySignedStatement(
        'device_revocation',
        revocation,
        ownerSigPublicKey
      );
      if (
        verified !== undefined &&
        verified.device_id === deviceId &&
        verified.owner_identity_id === pin.identity_id
      ) {
        statements[deviceId] = { at: verified.at, revoked: true };
        continue;
      }
    }
    const flagged =
      device['revoked_at'] !== null && device['revoked_at'] !== undefined;
    let check: DeviceCertCheck;
    try {
      check = deviceCertCheck(device, deviceId, pin);
    } catch (error) {
      if (flagged) continue;
      throw error;
    }
    if (!(check.notAfter > now)) continue;
    if (flagged) {
      if (!(await checksOut(check))) continue;
    } else {
      await verifyDeviceCert(check);
    }
    const at = parseStatement('device_cert', check.cert.statement).at;
    statements[deviceId] = { at, revoked: false };
    const publicKey = decodeBase64url(check.kemPublicKey);
    live.push({
      deviceId,
      at,
      reader: {
        kind: 'device',
        publicKey,
        keyId: sha256Hex(publicKey),
        label: check.label,
        fingerprint: formatFingerprint(await deviceFingerprint(deviceId)),
      },
    });
  }
  return { live, statements };
}

/** The certificate check a listed device carries. Throws when a field is not the shape a device has. */
function deviceCertCheck(
  device: Record<string, unknown>,
  deviceId: string,
  pin: DeviceOwner
): DeviceCertCheck {
  const certBody = expectRecord(device['cert'], 'device certificate');
  return {
    deviceId,
    ownerIdentityId: pin.identity_id,
    ownerSigPublicKey: decodeBase64url(pin.sig_public_key),
    kemPublicKey: expectString(device['kem_public_key'], 'device KEM key'),
    sigPublicKey: expectString(device['sig_public_key'], 'device signing key'),
    label: expectString(device['label'], 'device label'),
    notAfter: Number(device['not_after']),
    cert: {
      statement: expectRecord(
        certBody['statement'],
        'device certificate statement'
      ),
      identity_signature: expectString(
        certBody['identity_signature'],
        'device certificate signature'
      ),
    },
  };
}

type DeviceCertCheck = Parameters<typeof verifyDeviceCert>[0];

/**
 * Whether a device certificate checks out. Used only for a revoked device,
 * whose certificate is evidence only when it verifies. A certificate that does
 * not verify is no evidence, so the caller records nothing for that device.
 */
async function checksOut(check: DeviceCertCheck): Promise<boolean> {
  try {
    await verifyDeviceCert(check);
    return true;
  } catch {
    return false;
  }
}

/** A non-negative safe integer the service counts with, or a refusal. */
export function expectEpoch(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PublishError(
      'app_response_unusable',
      `the service answered with no usable ${what}`
    );
  }
  return value;
}

/** The key a grant's seen state is stored under: one grantee on one relic. */
export function grantKey(relicId: string, granteeIdentityId: string): string {
  return `${relicId}/${granteeIdentityId}`;
}

/** A floor refusal, shown as the publish error a caller reports. Nothing is wrapped to it. */
function staleRefusal(error: RosterStaleError): PublishError {
  return new PublishError(
    'recipients_stale',
    `the service answered with an older view of the owner than this machine has already accepted (${error.what}). Nothing was wrapped to it.`
  );
}

/**
 * Hold a verified service answer to what this machine has already accepted for
 * its pinned owner, record it, and return the floor the answer is admitted
 * against. Called after the answer verifies and before any key is wrapped to
 * it. A refused answer records nothing.
 *
 * Limit (PS-05): a revocation this machine never received cannot be seen. On
 * first contact, or with a fresh key file, the floor is empty, so a service that
 * withholds both a revoked entry and its signed revocation from a client that
 * never saw one is believed. Once a verified revocation or designation is
 * accepted, the floor keeps it.
 */
export function observeOwnerState(
  origin: string,
  observed: RosterObservation
): Promise<RosterFloor> {
  const run = deviceWriteChain.then(async () => {
    const file = await readKeysFile();
    const entry = file.devices[origin];
    if (entry === undefined) {
      throw new PublishError(
        'device_not_enrolled',
        `this machine has no certified device for ${origin}.`
      );
    }
    let floor: RosterFloor;
    try {
      floor = advanceRosterFloor(entry.owner_seen ?? {}, observed);
    } catch (error) {
      if (error instanceof RosterStaleError) throw staleRefusal(error);
      throw error;
    }
    await storeEntry(origin, { ...entry, owner_seen: floor });
    return floor;
  });
  deviceWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
