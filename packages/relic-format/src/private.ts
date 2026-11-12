/**
 * Private shares: the definitions both sides of a private relic agree on
 * (`docs/plans/private-shares/README.md` section 4). The publisher, the
 * service, the viewer and relic-mcp import this module, so each label, each
 * statement field and each byte layout is defined here once.
 *
 * Reached as `@relic/format/private`, never through the package index, so the
 * viewer's eager shell does not carry it.
 *
 * WebCrypto only. No key, PRF output or key phrase ever reaches an error
 * message, a log line, or a string this module builds for a caller.
 */

import { normalizeEmail } from './email.ts';
import { RelicFormatError } from './errors.ts';
import { encodeCrockford } from './id.ts';
import { hpkeOpen, hpkeSeal, type HpkeRecipient } from './hpke.ts';

export type { HpkeRecipient } from './hpke.ts';
export * from './private-wire.ts';

/** The Crockford alphabet of relic IDs and fingerprints: lowercase, no i, l, o or u. */
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const RELIC_ID_RE = new RegExp(`^[${B32}]{26}$`);
const FINGERPRINT_RE = new RegExp(`^[${B32}]{32}$`);
const HEX64_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /\p{Cc}/u;
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** WebAuthn PRF `eval.first` for the identity ceremony: UTF8('relic/identity-prf/v1'). */
export const PRF_SALT: Uint8Array = utf8('relic/identity-prf/v1');

const NUL = Uint8Array.of(0x00);
const WRAP_LABEL = utf8('relic/wrap/v1');
const KEY_COMMIT_LABEL = utf8('relic/key-commit/v1');
const KEK_LABEL = utf8('relic/identity-kek/v1');
const BUNDLE_LABEL = utf8('relic/identity-bundle/v1');
const ATTEST_LABEL = utf8('relic-attest/v1');
const STATEMENT_PREFIX = 'relic-statement/v1';

/** The statement kinds, one per signed or device-signed message (section 4.3). */
export type StatementKind =
  | 'identity_register'
  | 'identity_bind'
  | 'identity_settings'
  | 'access_request'
  | 'grant'
  | 'revocation'
  | 'republish'
  | 'delete'
  | 'device_cert'
  | 'device_revocation'
  | 'recovery_designation'
  | 'seal'
  | 'device_enroll'
  | 'device_request'
  | 'owner_bind'
  | 'private_publish';

export interface IdentityRegisterStatement {
  readonly at: number;
  readonly email: string;
  readonly identity_id: string;
  readonly kem_public_key: string;
  readonly replaces: string | null;
  readonly sig_public_key: string;
}

export interface IdentityBindStatement {
  readonly at: number;
  readonly credential_id: string;
  readonly identity_id: string;
}

export interface IdentitySettingsStatement {
  readonly access_log_retention_days: number;
  readonly at: number;
  readonly identity_id: string;
}

export interface AccessRequestStatement {
  readonly at: number;
  readonly relic_id: string;
  readonly requester_identity_id: string;
}

export interface GrantStatement {
  readonly at: number;
  readonly fingerprint_typed: string;
  readonly grantee_email: string;
  readonly grantee_identity_id: string;
  readonly owner_identity_id: string;
  readonly relic_id: string;
  readonly versions: readonly number[];
}

export interface RevocationStatement {
  readonly at: number;
  readonly grantee_identity_id: string;
  readonly owner_identity_id: string;
  readonly relic_id: string;
}

export interface RepublishStatement {
  readonly at: number;
  readonly owner_identity_id: string;
  readonly previous_version: number;
  readonly reason: 'rekey';
  readonly relic_id: string;
}

export interface DeleteStatement {
  readonly at: number;
  readonly owner_identity_id: string;
  readonly relic_id: string;
  readonly versions: 'all' | readonly number[];
}

export interface DeviceCertStatement {
  readonly at: number;
  readonly device_fingerprint_typed: string;
  readonly device_id: string;
  readonly kem_public_key: string;
  readonly label: string;
  readonly not_after: number;
  readonly owner_identity_id: string;
  readonly sig_public_key: string;
}

export interface DeviceRevocationStatement {
  readonly at: number;
  readonly device_id: string;
  readonly owner_identity_id: string;
}

export interface RecoveryDesignationStatement {
  readonly at: number;
  readonly fingerprint_typed: string | null;
  readonly owner_identity_id: string;
  readonly recovery_email: string | null;
  readonly recovery_identity_id: string | null;
}

export interface SealStatement {
  readonly access_epoch: number;
  readonly at: number;
  readonly ciphertext_sha256: string;
  /** `keyCommitment` of the version key this seal covers (section 4.1). */
  readonly key_commitment: string;
  readonly owner_epoch: number;
  readonly recipient_key_ids: readonly string[];
  readonly relic_id: string;
  readonly signer_id: string;
  readonly version: number;
}

export interface DeviceEnrollStatement {
  readonly at: number;
  readonly device_id: string;
  readonly label: string;
}

export interface DeviceRequestStatement {
  readonly at: number;
  readonly body_sha256: string;
  readonly device_id: string;
  readonly method: string;
  readonly nonce: string;
  readonly path: string;
}

export interface OwnerBindStatement {
  readonly at: number;
  readonly device_id: string;
  readonly nonce: string;
  readonly owner_identity_id: string;
  readonly relic_id: string;
}

export interface PrivatePublishStatement {
  readonly at: number;
  /** The service challenge from `POST /api/challenge`, an opaque token (1 to 64 of `[A-Za-z0-9_-]`). */
  readonly challenge_nonce: string;
  readonly device_id: string;
  readonly relic_id: string;
  readonly ttl_days: number | null;
}

/** The statement for each kind. Every field is listed; nullable fields are typed `| null`. */
export interface StatementMap {
  readonly identity_register: IdentityRegisterStatement;
  readonly identity_bind: IdentityBindStatement;
  readonly identity_settings: IdentitySettingsStatement;
  readonly access_request: AccessRequestStatement;
  readonly grant: GrantStatement;
  readonly revocation: RevocationStatement;
  readonly republish: RepublishStatement;
  readonly delete: DeleteStatement;
  readonly device_cert: DeviceCertStatement;
  readonly device_revocation: DeviceRevocationStatement;
  readonly recovery_designation: RecoveryDesignationStatement;
  readonly seal: SealStatement;
  readonly device_enroll: DeviceEnrollStatement;
  readonly device_request: DeviceRequestStatement;
  readonly owner_bind: OwnerBindStatement;
  readonly private_publish: PrivatePublishStatement;
}

/** The reason a statement was refused. The service reports it as `statement_check`. */
export type StatementCheck =
  | 'unknown_kind'
  | 'missing_key'
  | 'extra_key'
  | 'type'
  | 'format'
  | 'range'
  | 'order'
  | 'designation';

/** A statement that does not parse exactly. The message names the field, never its value. */
export class InvalidStatementError extends RelicFormatError {
  override readonly name = 'InvalidStatementError';

  constructor(
    readonly check: StatementCheck,
    readonly kind: string,
    readonly field?: string
  ) {
    const where = field === undefined ? '' : ` at ${field}`;
    super(`statement ${kind} refused: ${check}${where}`);
  }
}

/** A fingerprint that is not 32 characters of the alphabet once aliases are folded. */
export class InvalidFingerprintError extends RelicFormatError {
  override readonly name = 'InvalidFingerprintError';

  constructor() {
    super('not a fingerprint');
  }
}

/** A wrapped key did not open for this recipient, relic, version or AAD. */
export class WrapOpenError extends RelicFormatError {
  override readonly name = 'WrapOpenError';

  constructor() {
    super('wrapped key did not open');
  }
}

/** An identity bundle did not open under this KEK, credential and identity. */
export class IdentityBundleError extends RelicFormatError {
  override readonly name = 'IdentityBundleError';

  constructor() {
    super('identity bundle did not open');
  }
}

/**
 * Canonical JSON for statements: sorted keys, no whitespace, JSON strings and
 * safe integers only. Anything else throws, so two implementations cannot sign
 * different bytes for the same value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('canonical JSON takes safe integers only');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value))
        throw new TypeError('canonical JSON refuses sparse arrays');
      items.push(canonicalJson(value[i]));
    }
    return `[${items.join(',')}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(
    'canonical JSON takes strings, booleans, null, integers, arrays and plain objects'
  );
}

/** The exact bytes a statement is signed over: `relic-statement/v1`, the kind, then canonical JSON. */
export function statementBytes<K extends StatementKind>(
  kind: K,
  statement: StatementMap[K]
): Uint8Array {
  if (!hasOwn(SPECS, kind))
    throw new InvalidStatementError('unknown_kind', String(kind));
  return utf8(`${STATEMENT_PREFIX}\n${kind}\n${canonicalJson(statement)}`);
}

/**
 * Strictly parse a statement of the given kind: the exact key set (no extra key,
 * no missing key), each field's type and format, every range, and the
 * cross-field rules. Throws `InvalidStatementError` naming the check.
 */
export function parseStatement<K extends StatementKind>(
  kind: K,
  value: unknown
): StatementMap[K] {
  if (!hasOwn(SPECS, kind))
    throw new InvalidStatementError('unknown_kind', String(kind));
  const spec = SPECS[kind];
  if (!isPlainObject(value)) throw new InvalidStatementError('type', kind);
  for (const field of Object.keys(spec)) {
    if (!hasOwn(value, field))
      throw new InvalidStatementError('missing_key', kind, field);
  }
  for (const field of Object.keys(value)) {
    if (!hasOwn(spec, field))
      throw new InvalidStatementError('extra_key', kind, field);
  }
  for (const [field, rule] of Object.entries(spec)) {
    const check = rule(value[field]);
    if (check !== undefined)
      throw new InvalidStatementError(check, kind, field);
  }
  const crossCheck = CROSS_CHECKS[kind]?.(value);
  if (crossCheck !== undefined)
    throw new InvalidStatementError(crossCheck, kind);
  return value as unknown as StatementMap[K];
}

/**
 * The attestation challenge the browser signs (section 4.1): SHA-256 over
 * `relic-attest/v1`, a 0x00 byte, the 32-byte server nonce, then the SHA-256 of
 * each statement's bytes in request order. base64url of the result is the
 * WebAuthn challenge.
 */
export async function attestationChallenge(
  nonce: Uint8Array,
  statements: readonly Uint8Array[]
): Promise<Uint8Array> {
  requireLength(nonce, 32, 'attestation nonce');
  if (statements.length === 0) {
    throw new RelicFormatError('an attestation covers at least one statement');
  }
  const digests: Uint8Array[] = [];
  for (const bytes of statements) digests.push(await sha256(bytes));
  return sha256(ATTEST_LABEL, NUL, nonce, ...digests);
}

/**
 * Sign statement bytes through a caller-supplied signer, and return the
 * base64url of the 64-byte IEEE P1363 signature. The signer may be WebCrypto or
 * a Secure Enclave helper.
 */
export async function signStatement(
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
  bytes: Uint8Array
): Promise<string> {
  const signature = await sign(bytes);
  if (signature.length !== 64) {
    throw new RelicFormatError('statement signature must be 64 bytes');
  }
  return encodeBase64url(signature);
}

/**
 * Verify a base64url P1363 signature over statement bytes against a 65-byte
 * SEC1 public key. A malformed signature returns false; a malformed key throws.
 */
export async function verifyStatement(
  sigPublicKey: Uint8Array,
  bytes: Uint8Array,
  signatureB64: string
): Promise<boolean> {
  requireLength(sigPublicKey, 65, 'signature public key');
  let signature: Uint8Array;
  try {
    signature = decodeBase64url(signatureB64);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    bufferSource(sigPublicKey),
    P256_SIGN,
    false,
    ['verify']
  );
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bufferSource(signature),
      bufferSource(bytes)
    );
  } catch {
    return false;
  }
}

/** A signed statement as the wire carries it, without a kind: the statement and its identity signature. */
export interface SignedStatementBody {
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
}

/**
 * Verify one owner-signed statement of the given kind. Returns the parsed
 * statement only when it parses exactly and its signature verifies under
 * `signerKey`. Anything else is undefined, and the caller decides whether that
 * is a refusal or an entry to ignore. Pure: no network, no state.
 */
export async function verifySignedStatement<K extends StatementKind>(
  kind: K,
  signed: SignedStatementBody,
  signerKey: Uint8Array
): Promise<StatementMap[K] | undefined> {
  let statement: StatementMap[K];
  try {
    statement = parseStatement(kind, signed.statement);
  } catch {
    return undefined;
  }
  const valid = await verifyStatement(
    signerKey,
    statementBytes(kind, statement),
    signed.identity_signature
  );
  return valid ? statement : undefined;
}

/**
 * A time a verified owner-signed statement fixes. `revoked: false` is the
 * `at` of the newest live statement accepted. `revoked: true` is the `at` of a
 * verified revocation: every statement at or before it stays revoked.
 */
export interface RosterMark {
  readonly at: number;
  readonly revoked: boolean;
}

/** The newest owner-signed recovery designation accepted. `removed` when it removed the holder. */
export interface DesignationMark {
  readonly at: number;
  readonly removed: boolean;
}

/**
 * What a client has accepted for one owner. It holds owner-signed facts only:
 * the newest designation, and a mark per device and per grant. Nothing a
 * service asserted on its own is ever recorded here.
 */
export interface RosterFloor {
  readonly designation?: DesignationMark | undefined;
  readonly devices?: Readonly<Record<string, RosterMark>> | undefined;
  readonly grants?: Readonly<Record<string, RosterMark>> | undefined;
}

/**
 * One verified answer about the owner. `designation` is undefined when the
 * answer does not speak to designations, and null when it carries no signed
 * designation at all.
 */
export interface RosterObservation {
  readonly designation?: DesignationMark | null | undefined;
  readonly devices?: Readonly<Record<string, RosterMark>> | undefined;
  readonly grants?: Readonly<Record<string, RosterMark>> | undefined;
}

/** An answer that goes back on something the floor already accepted. */
export class RosterStaleError extends RelicFormatError {
  override readonly name = 'RosterStaleError';

  constructor(readonly what: string) {
    super(`the answer goes back on ${what} already accepted`);
  }
}

/**
 * Advance the floor by one verified answer. The floor only moves forward: an
 * older designation, a designation that disappears after one was accepted, a
 * live statement older than the accepted one, or an older revocation all throw
 * `RosterStaleError` and change nothing. A verified revocation is permanent for
 * the statements it covers. A live statement newer than a revocation is a new
 * owner authorization and replaces it. A live statement at or before the
 * revocation is still revoked, and the floor keeps the revocation.
 */
export function advanceRosterFloor(
  floor: RosterFloor,
  observed: RosterObservation
): RosterFloor {
  let designation = floor.designation;
  if (observed.designation === null) {
    if (designation !== undefined) {
      throw new RosterStaleError('a recovery designation');
    }
  } else if (observed.designation !== undefined) {
    const next = observed.designation;
    if (designation !== undefined) {
      if (next.at < designation.at) {
        throw new RosterStaleError('a newer recovery designation');
      }
      if (next.at === designation.at && next.removed !== designation.removed) {
        throw new RosterStaleError('a recovery designation at the same time');
      }
    }
    designation = next;
  }
  return {
    designation,
    devices: advanceMarks(floor.devices, observed.devices, 'device'),
    grants: advanceMarks(floor.grants, observed.grants, 'grant'),
  };
}

function advanceMarks(
  prior: Readonly<Record<string, RosterMark>> | undefined,
  observed: Readonly<Record<string, RosterMark>> | undefined,
  what: string
): Record<string, RosterMark> {
  const next: Record<string, RosterMark> = { ...prior };
  for (const [key, mark] of Object.entries(observed ?? {})) {
    const before = prior?.[key];
    if (mark.revoked) {
      if (before !== undefined && !before.revoked && mark.at < before.at) {
        throw new RosterStaleError(`an older ${what} revocation`);
      }
      next[key] = {
        at: before?.revoked === true ? Math.max(before.at, mark.at) : mark.at,
        revoked: true,
      };
    } else if (before?.revoked === true) {
      if (mark.at > before.at) next[key] = mark;
    } else {
      if (before !== undefined && mark.at < before.at) {
        throw new RosterStaleError(`an older ${what} statement`);
      }
      next[key] = mark;
    }
  }
  return next;
}

/**
 * Whether an entry whose owner-signed statement is at `at` may receive a wrap,
 * given the floor's mark for it. A revoked mark excludes every statement at or
 * before its time. An absent mark admits nothing extra: the caller has already
 * verified the entry itself.
 */
export function rosterAdmits(
  mark: RosterMark | undefined,
  at: number
): boolean {
  return mark === undefined || !mark.revoked || at > mark.at;
}

/** `identityId = hex(SHA-256("relic/identity/v1" || 0x00 || kemPub || sigPub))`. */
export function identityIdOf(
  kemPub: Uint8Array,
  sigPub: Uint8Array
): Promise<string> {
  return keyPairId('relic/identity/v1', kemPub, sigPub);
}

/** `deviceId = hex(SHA-256("relic/device/v1" || 0x00 || kemPub || sigPub))`. */
export function deviceIdOf(
  kemPub: Uint8Array,
  sigPub: Uint8Array
): Promise<string> {
  return keyPairId('relic/device/v1', kemPub, sigPub);
}

/** `kemKeyId = SHA-256(kemPub)`, 32 raw bytes. The wrap AAD and the wire `recipient_key_id`. */
export async function kemKeyIdOf(kemPub: Uint8Array): Promise<Uint8Array> {
  requireLength(kemPub, 65, 'KEM public key');
  return sha256(kemPub);
}

/**
 * The identity fingerprint the owner types: the first 20 bytes of
 * SHA-256("relic/fp/v1" || 0x00 || identityId || normalizeEmail(email)), in
 * Crockford base32. Lowercase, 32 characters.
 */
export async function identityFingerprint(
  identityId: string,
  email: string
): Promise<string> {
  const digest = await sha256(
    utf8('relic/fp/v1'),
    NUL,
    hex32(identityId),
    utf8(normalizeEmail(email))
  );
  return encodeCrockford(digest.subarray(0, 20));
}

/** The device fingerprint: the first 20 bytes of SHA-256("relic/device-fp/v1" || 0x00 || deviceId). */
export async function deviceFingerprint(deviceId: string): Promise<string> {
  const digest = await sha256(utf8('relic/device-fp/v1'), NUL, hex32(deviceId));
  return encodeCrockford(digest.subarray(0, 20));
}

/** The display form: uppercase, eight groups of four, single spaces. Accepts typed input too. */
export function formatFingerprint(fp: string): string {
  const normalized = parseTypedFingerprint(fp);
  if (normalized === undefined) throw new InvalidFingerprintError();
  return Array.from({ length: 8 }, (_, group) =>
    normalized.slice(group * 4, group * 4 + 4).toUpperCase()
  ).join(' ');
}

/**
 * Normalize what a person typed: drop whitespace and hyphens, lowercase, fold
 * `i` and `l` to `1` and `o` to `0`. Returns the 32-character form, or
 * undefined when the result is not 32 characters of the alphabet.
 */
export function parseTypedFingerprint(typed: string): string | undefined {
  const folded = typed
    .replace(/[\s-]/g, '')
    .toLowerCase()
    .replace(/[il]/g, '1')
    .replace(/o/g, '0');
  return FINGERPRINT_RE.test(folded) ? folded : undefined;
}

/** Compare two normalized fingerprints in constant time. Unequal lengths are unequal. */
export function fingerprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Wrap one version key to one recipient (HPKE, section 4.1). The info binds the
 * relic ID and version; the AAD is the recipient's `kemKeyId`. `enc` and `ct`
 * are base64url.
 */
export async function wrapVersionKey(p: {
  recipientPublicKey: Uint8Array;
  relicId: string;
  version: number;
  key: Uint8Array;
}): Promise<{ recipientKeyId: string; enc: string; ct: string }> {
  requireLength(p.key, 16, 'version key');
  const info = relicVersionInfo(WRAP_LABEL, p.relicId, p.version);
  const kemKeyId = await kemKeyIdOf(p.recipientPublicKey);
  const sealed = await hpkeSeal({
    recipientPublicKey: p.recipientPublicKey,
    info,
    aad: kemKeyId,
    plaintext: p.key,
  });
  return {
    recipientKeyId: bytesToHex(kemKeyId),
    enc: encodeBase64url(sealed.enc),
    ct: encodeBase64url(sealed.ct),
  };
}

/**
 * Open a wrapped version key for one recipient. Refuses, with `WrapOpenError`,
 * a wrong relic ID, a wrong version, a wrong recipient, a tampered wrap, or a
 * key that is not 16 bytes.
 */
export async function unwrapVersionKey(p: {
  recipient: HpkeRecipient;
  relicId: string;
  version: number;
  enc: string;
  ct: string;
}): Promise<Uint8Array> {
  return openWrap(p).catch(() => {
    throw new WrapOpenError();
  });
}

/**
 * The commitment a seal signs over its version key (section 4.1): lowercase
 * hex of HKDF-SHA256 over the 16-byte key, empty salt, info
 * `relic/key-commit/v1 || 0x00 || relic_id || u32be(version)`, 32 bytes.
 * HPKE base mode does not authenticate the key it opens, so every opener
 * compares this value with the signed seal before it uses the key.
 */
export async function keyCommitment(p: {
  relicId: string;
  version: number;
  key: Uint8Array;
}): Promise<string> {
  requireLength(p.key, 16, 'version key');
  const material = await crypto.subtle.importKey(
    'raw',
    bufferSource(p.key),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: bufferSource(
        relicVersionInfo(KEY_COMMIT_LABEL, p.relicId, p.version)
      ),
    },
    material,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/** One identity's key material. Generated extractable so it can be bundled; decrypted keys are not. */
export interface IdentityKeys {
  readonly kem: CryptoKeyPair;
  readonly sig: CryptoKeyPair;
  readonly kemPublicKey: Uint8Array;
  readonly sigPublicKey: Uint8Array;
  readonly identityId: string;
}

/** Generate an ECDH P-256 and an ECDSA P-256 key pair. The same call makes a device's file keys. */
export async function generateIdentityKeys(): Promise<IdentityKeys> {
  const kem = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  const sig = await crypto.subtle.generateKey(P256_SIGN, true, [
    'sign',
    'verify',
  ]);
  const kemPublicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', kem.publicKey)
  );
  const sigPublicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', sig.publicKey)
  );
  return {
    kem,
    sig,
    kemPublicKey,
    sigPublicKey,
    identityId: await identityIdOf(kemPublicKey, sigPublicKey),
  };
}

/**
 * The identity KEK: HKDF-SHA256 of the PRF output, salted with the raw
 * credential ID, info `relic/identity-kek/v1`, as a non-extractable AES-256-GCM
 * key.
 */
export async function deriveKek(
  prf: Uint8Array,
  rawCredentialId: Uint8Array
): Promise<CryptoKey> {
  requireLength(prf, 32, 'PRF output');
  if (rawCredentialId.length === 0) {
    throw new RelicFormatError('credential id must not be empty');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    bufferSource(prf),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bufferSource(rawCredentialId),
      info: bufferSource(KEK_LABEL),
    },
    material,
    256
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Seal an identity's private keys under a KEK. The bundle is base64url of
 * `nonce || ciphertext`, and its AAD binds the identity ID and the raw
 * credential ID, so it opens only for that identity and that credential.
 */
export async function encryptIdentityBundle(
  kek: CryptoKey,
  keys: IdentityKeys,
  rawCredentialId: Uint8Array
): Promise<string> {
  const derived = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  if (derived !== keys.identityId) {
    throw new RelicFormatError('identity keys do not match their identity id');
  }
  const kemJwk = await crypto.subtle.exportKey('jwk', keys.kem.privateKey);
  const sigJwk = await crypto.subtle.exportKey('jwk', keys.sig.privateKey);
  const plaintext = utf8(
    canonicalJson({
      kem: privateCoordinates(kemJwk),
      sig: privateCoordinates(sigJwk),
      v: 1,
    })
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(nonce),
        additionalData: bufferSource(
          bundleAad(keys.identityId, rawCredentialId)
        ),
        tagLength: 128,
      },
      kek,
      bufferSource(plaintext)
    )
  );
  return encodeBase64url(concat(nonce, sealed));
}

/**
 * Open an identity bundle and rebuild non-extractable keys. Refuses, with
 * `IdentityBundleError`, a wrong KEK, a different credential ID, a different
 * identity ID, a tampered bundle, or keys whose public halves do not hash to
 * the identity ID.
 */
export async function decryptIdentityBundle(
  kek: CryptoKey,
  bundle: string,
  identityId: string,
  rawCredentialId: Uint8Array
): Promise<IdentityKeys> {
  return openBundle(kek, bundle, identityId, rawCredentialId).catch(() => {
    throw new IdentityBundleError();
  });
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode unpadded base64url. Refuses any character outside the alphabet and any
 * encoding that is not the canonical form of its bytes (non-zero trailing bits),
 * so one value has one text form.
 */
export function decodeBase64url(text: string): Uint8Array {
  if (!BASE64URL_RE.test(text) || text.length % 4 === 1) {
    throw new RelicFormatError('not base64url');
  }
  const padded = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  if (encodeBase64url(bytes) !== text) {
    throw new RelicFormatError('base64url is not canonical');
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Statement field rules. A rule returns the reason a value is refused, or
// undefined when it is valid.
// ---------------------------------------------------------------------------

type Rule = (value: unknown) => StatementCheck | undefined;

const HEX_ID: Rule = (value) => {
  if (typeof value !== 'string') return 'type';
  return HEX64_RE.test(value) ? undefined : 'format';
};

const RELIC_ID: Rule = (value) => {
  if (typeof value !== 'string') return 'type';
  return RELIC_ID_RE.test(value) ? undefined : 'format';
};

const FINGERPRINT_TYPED: Rule = (value) => {
  if (typeof value !== 'string') return 'type';
  return FINGERPRINT_RE.test(value) ? undefined : 'format';
};

const AT: Rule = integer(0);

const EMAIL: Rule = (value) => {
  if (typeof value !== 'string') return 'type';
  const canonical =
    normalizeEmail(value) === value &&
    EMAIL_SHAPE_RE.test(value) &&
    !CONTROL_RE.test(value) &&
    utf8(value).length <= 320;
  return canonical ? undefined : 'format';
};

/** A label is 1 to 64 UTF-8 bytes with no control characters. */
const LABEL: Rule = (value) => {
  if (typeof value !== 'string') return 'type';
  const bytes = utf8(value).length;
  return bytes < 1 || bytes > 64 || CONTROL_RE.test(value)
    ? 'format'
    : undefined;
};

const NONCE: Rule = base64urlBytes(32, 32);
/** The service challenge is opaque: the server issues it as hex today, and the format does not depend on that. */
const SERVICE_TOKEN: Rule = (value) => {
  if (typeof value !== 'string') return 'type';
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? undefined : 'format';
};
const PUBLIC_KEY: Rule = base64urlBytes(65, 65, 0x04);
const CREDENTIAL_ID: Rule = base64urlBytes(1, 1023);

/** Ascending, unique, positive integers. Empty only when `nonEmpty` is false. */
function versionList(nonEmpty: boolean): Rule {
  return (value) => {
    if (!Array.isArray(value)) return 'type';
    if (nonEmpty && value.length === 0) return 'format';
    let previous = 0;
    for (const item of value as unknown[]) {
      const check = integer(1)(item);
      if (check !== undefined) return check;
      if ((item as number) <= previous) return 'order';
      previous = item as number;
    }
    return undefined;
  };
}

/** Sorted, unique, non-empty lowercase hex identifiers (the seal's recipient set). */
const SORTED_HEX_IDS: Rule = (value) => {
  if (!Array.isArray(value)) return 'type';
  if (value.length === 0) return 'format';
  let previous = '';
  for (const item of value as unknown[]) {
    const check = HEX_ID(item);
    if (check !== undefined) return check;
    if ((item as string) <= previous) return 'order';
    previous = item as string;
  }
  return undefined;
};

/** Exactly the literal `value`. */
function literal(expected: string): Rule {
  return (value) => (value === expected ? undefined : 'format');
}

/** A nullable field: null, or the rule. */
function nullable(rule: Rule): Rule {
  return (value) => (value === null ? undefined : rule(value));
}

/** Valid if any alternative is valid; otherwise the last alternative's reason. */
function either(...rules: readonly Rule[]): Rule {
  return (value) => {
    let last: StatementCheck | undefined = 'type';
    for (const rule of rules) {
      const check = rule(value);
      if (check === undefined) return undefined;
      last = check;
    }
    return last;
  };
}

/** A text pattern check for a string field. */
function text(pattern: RegExp): Rule {
  return (value) => {
    if (typeof value !== 'string') return 'type';
    return pattern.test(value) ? undefined : 'format';
  };
}

/** A safe integer no smaller than `min`. Floats are a type refusal. */
function integer(min: number): Rule {
  return (value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      return 'type';
    return value < min ? 'range' : undefined;
  };
}

/** Canonical base64url of between `min` and `max` bytes, optionally starting with a given byte. */
function base64urlBytes(min: number, max: number, firstByte?: number): Rule {
  return (value) => {
    if (typeof value !== 'string') return 'type';
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64url(value);
    } catch {
      return 'format';
    }
    if (bytes.length < min || bytes.length > max) return 'format';
    if (firstByte !== undefined && bytes[0] !== firstByte) return 'format';
    return undefined;
  };
}

const SPECS: { readonly [K in StatementKind]: Readonly<Record<string, Rule>> } =
  {
    identity_register: {
      at: AT,
      email: EMAIL,
      identity_id: HEX_ID,
      kem_public_key: PUBLIC_KEY,
      replaces: nullable(HEX_ID),
      sig_public_key: PUBLIC_KEY,
    },
    identity_bind: {
      at: AT,
      credential_id: CREDENTIAL_ID,
      identity_id: HEX_ID,
    },
    identity_settings: {
      access_log_retention_days: integer(1),
      at: AT,
      identity_id: HEX_ID,
    },
    access_request: {
      at: AT,
      relic_id: RELIC_ID,
      requester_identity_id: HEX_ID,
    },
    grant: {
      at: AT,
      fingerprint_typed: FINGERPRINT_TYPED,
      grantee_email: EMAIL,
      grantee_identity_id: HEX_ID,
      owner_identity_id: HEX_ID,
      relic_id: RELIC_ID,
      versions: versionList(true),
    },
    revocation: {
      at: AT,
      grantee_identity_id: HEX_ID,
      owner_identity_id: HEX_ID,
      relic_id: RELIC_ID,
    },
    republish: {
      at: AT,
      owner_identity_id: HEX_ID,
      previous_version: integer(1),
      reason: literal('rekey'),
      relic_id: RELIC_ID,
    },
    delete: {
      at: AT,
      owner_identity_id: HEX_ID,
      relic_id: RELIC_ID,
      versions: either(literal('all'), versionList(true)),
    },
    device_cert: {
      at: AT,
      device_fingerprint_typed: FINGERPRINT_TYPED,
      device_id: HEX_ID,
      kem_public_key: PUBLIC_KEY,
      label: LABEL,
      not_after: AT,
      owner_identity_id: HEX_ID,
      sig_public_key: PUBLIC_KEY,
    },
    device_revocation: {
      at: AT,
      device_id: HEX_ID,
      owner_identity_id: HEX_ID,
    },
    recovery_designation: {
      at: AT,
      fingerprint_typed: nullable(FINGERPRINT_TYPED),
      owner_identity_id: HEX_ID,
      recovery_email: nullable(EMAIL),
      recovery_identity_id: nullable(HEX_ID),
    },
    seal: {
      access_epoch: integer(0),
      at: AT,
      ciphertext_sha256: HEX_ID,
      key_commitment: HEX_ID,
      owner_epoch: integer(0),
      recipient_key_ids: SORTED_HEX_IDS,
      relic_id: RELIC_ID,
      signer_id: HEX_ID,
      version: integer(1),
    },
    device_enroll: {
      at: AT,
      device_id: HEX_ID,
      label: LABEL,
    },
    device_request: {
      at: AT,
      body_sha256: HEX_ID,
      device_id: HEX_ID,
      method: text(/^[A-Z]+$/),
      nonce: NONCE,
      path: text(/^\/\S*$/),
    },
    owner_bind: {
      at: AT,
      device_id: HEX_ID,
      nonce: NONCE,
      owner_identity_id: HEX_ID,
      relic_id: RELIC_ID,
    },
    private_publish: {
      at: AT,
      challenge_nonce: SERVICE_TOKEN,
      device_id: HEX_ID,
      relic_id: RELIC_ID,
      ttl_days: nullable(integer(1)),
    },
  };

/**
 * Cross-field rules. A recovery designation either names all three parties or
 * removes the designation by nulling all three; a mix is refused.
 */
const CROSS_CHECKS: Partial<
  Record<
    StatementKind,
    (value: Record<string, unknown>) => StatementCheck | undefined
  >
> = {
  recovery_designation: (value) => {
    const nulls = [
      value.fingerprint_typed,
      value.recovery_email,
      value.recovery_identity_id,
    ].filter((field) => field === null).length;
    return nulls === 0 || nulls === 3 ? undefined : 'designation';
  },
};

/** Every statement kind, in declaration order. */
export const STATEMENT_KINDS: readonly StatementKind[] = Object.keys(
  SPECS
) as StatementKind[];

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const P256_SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function keyPairId(
  label: string,
  kemPub: Uint8Array,
  sigPub: Uint8Array
): Promise<string> {
  requireLength(kemPub, 65, 'KEM public key');
  requireLength(sigPub, 65, 'signature public key');
  return sha256(utf8(label), NUL, kemPub, sigPub).then(bytesToHex);
}

function relicVersionInfo(
  label: Uint8Array,
  relicId: string,
  version: number
): Uint8Array {
  if (!RELIC_ID_RE.test(relicId)) {
    throw new RelicFormatError(
      'relic id must be 26 characters of the alphabet'
    );
  }
  if (!Number.isSafeInteger(version) || version < 1 || version > 0xffff_ffff) {
    throw new RelicFormatError('version must be an integer from 1 to 2^32 - 1');
  }
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version);
  return concat(label, NUL, utf8(relicId), versionBytes);
}

async function openWrap(p: {
  recipient: HpkeRecipient;
  relicId: string;
  version: number;
  enc: string;
  ct: string;
}): Promise<Uint8Array> {
  const enc = decodeBase64url(p.enc);
  const ct = decodeBase64url(p.ct);
  if (enc.length !== 65 || ct.length !== 32) {
    throw new RelicFormatError('wrap has the wrong length');
  }
  const aad = await kemKeyIdOf(p.recipient.publicKey);
  const key = await hpkeOpen({
    recipient: p.recipient,
    enc,
    info: relicVersionInfo(WRAP_LABEL, p.relicId, p.version),
    aad,
    ct,
  });
  if (key.length !== 16)
    throw new RelicFormatError('wrapped key is not 16 bytes');
  return key;
}

function bundleAad(
  identityId: string,
  rawCredentialId: Uint8Array
): Uint8Array {
  return concat(BUNDLE_LABEL, NUL, hex32(identityId), rawCredentialId);
}

interface Coordinates {
  readonly d: string;
  readonly x: string;
  readonly y: string;
}

function privateCoordinates(jwk: JsonWebKey): Coordinates {
  const { d, x, y } = jwk;
  if (typeof d !== 'string' || typeof x !== 'string' || typeof y !== 'string') {
    throw new RelicFormatError('private key export is incomplete');
  }
  return { d, x, y };
}

function coordinatesOf(value: unknown): Coordinates {
  if (!isPlainObject(value)) throw new IdentityBundleError();
  const { d, x, y } = value;
  if (typeof d !== 'string' || typeof x !== 'string' || typeof y !== 'string') {
    throw new IdentityBundleError();
  }
  for (const part of [d, x, y]) {
    if (decodeBase64url(part).length !== 32) throw new IdentityBundleError();
  }
  return { d, x, y };
}

/** The SEC1 uncompressed point for a JWK's public coordinates. */
function publicPoint(coords: Coordinates): Uint8Array {
  return concat(
    Uint8Array.of(0x04),
    decodeBase64url(coords.x),
    decodeBase64url(coords.y)
  );
}

async function openBundle(
  kek: CryptoKey,
  bundle: string,
  identityId: string,
  rawCredentialId: Uint8Array
): Promise<IdentityKeys> {
  const sealed = decodeBase64url(bundle);
  if (sealed.length < 12 + 16) throw new IdentityBundleError();
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(sealed.subarray(0, 12)),
        additionalData: bufferSource(bundleAad(identityId, rawCredentialId)),
        tagLength: 128,
      },
      kek,
      bufferSource(sealed.subarray(12))
    )
  );
  const payload: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  );
  if (!isPlainObject(payload) || payload.v !== 1)
    throw new IdentityBundleError();
  const kemCoords = coordinatesOf(payload.kem);
  const sigCoords = coordinatesOf(payload.sig);
  const kemPublicKey = publicPoint(kemCoords);
  const sigPublicKey = publicPoint(sigCoords);
  if ((await identityIdOf(kemPublicKey, sigPublicKey)) !== identityId) {
    throw new IdentityBundleError();
  }
  return {
    kem: {
      privateKey: await crypto.subtle.importKey(
        'jwk',
        {
          kty: 'EC',
          crv: 'P-256',
          d: kemCoords.d,
          x: kemCoords.x,
          y: kemCoords.y,
        },
        P256,
        false,
        ['deriveBits']
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        bufferSource(kemPublicKey),
        P256,
        false,
        []
      ),
    },
    sig: {
      privateKey: await crypto.subtle.importKey(
        'jwk',
        {
          kty: 'EC',
          crv: 'P-256',
          d: sigCoords.d,
          x: sigCoords.x,
          y: sigCoords.y,
        },
        P256_SIGN,
        false,
        ['sign']
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        bufferSource(sigPublicKey),
        P256_SIGN,
        false,
        ['verify']
      ),
    },
    kemPublicKey,
    sigPublicKey,
    identityId,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

function requireLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) {
    throw new RelicFormatError(`${what} must be ${length} bytes`);
  }
}

function hex32(hex: string): Uint8Array {
  if (!HEX64_RE.test(hex)) {
    throw new RelicFormatError(
      'identity id must be 64 lowercase hex characters'
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', bufferSource(concat(...parts)))
  );
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  // Copies exactly this view's bytes, so a subarray or a Node Buffer passes its own content.
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
