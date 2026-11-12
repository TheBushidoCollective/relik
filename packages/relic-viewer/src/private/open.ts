/**
 * Opening one sealed version of a private relic.
 *
 * Nothing is decrypted until every link in the chain checks out: the owner's
 * public keys hash to the owner's identity id, the owner is the one this
 * browser pinned, the signer is the owner or one of the owner's certified
 * devices, the seal is signed by that signer, this reader is in the seal's
 * recipient set, the wrap opens under this reader's key, and the ciphertext's
 * digest is the one the seal signed. A failure at any step refuses the version
 * with a named error, and the content of a refused version is never shown.
 */

import {
  type Envelope,
  PLAINTEXT_CAP_BYTES,
  streamRelicContent,
} from '@relic/format';
import {
  type DevicePublicJSON,
  decodeBase64url,
  deviceIdOf,
  type IdentityPublicJSON,
  identityIdOf,
  type KeyJSON,
  parseStatement,
  type PartyJSON,
  type SealJSON,
  type SealStatement,
  statementBytes,
  unwrapVersionKey,
  verifyStatement,
  WrapOpenError,
} from '@relic/format/private';
import { mint, type MintResponse, type ViewerDeps } from '../viewer.ts';
import {
  postJson,
  readField,
  recipientOf,
  type UnlockedIdentity,
} from './keys.ts';

/** A seal, wrap or owner key that does not verify. Nothing from it is shown. */
export class SealMismatchError extends Error {}

/** The owner's key for this relic is not the one this browser first saw. */
export class OwnerChangedError extends Error {
  constructor(
    readonly pinned: PinnedOwner,
    readonly reported: { readonly identityId: string; readonly email: string }
  ) {
    super('owner_changed');
  }
}

/** The seal does not name this reader, so no wrap was sent for them. */
export class RecipientMissingError extends Error {}

/** The service sent a response that is not a key response at all. */
export class InvalidKeyResponseError extends Error {}

/** The ciphertext could not be fetched whole, so nothing was checked. */
export class TransferError extends Error {}

/** The version cannot be served to this reader, for the code the service named. */
export class VersionUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The owner a browser first saw for a relic. */
export interface PinnedOwner {
  readonly identityId: string;
  readonly email: string;
  readonly firstSeen: number;
}

/** The unwrapped key for a version, with the parsed key response it came from. */
export interface VerifiedKey {
  readonly key: Uint8Array;
  readonly keyJson: KeyJSON;
  readonly seal: SealStatement;
}

/** One decrypted version, its digest checked against the seal. */
export interface OpenedVersion {
  readonly envelope: Envelope;
  readonly content: Uint8Array;
  readonly digest: string;
}

const PIN_STORAGE_KEY = 'relic:owner-pins';

/** Pins live in this page and, when storage keeps them, across reloads. */
const pagePins = new Map<string, PinnedOwner>();

interface StoredPin {
  readonly identity_id: string;
  readonly email: string;
  readonly first_seen: number;
}

function pinStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function storedPins(): Record<string, StoredPin> {
  const raw = pinStorage()?.getItem(PIN_STORAGE_KEY);
  if (raw === null || raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
}

/** The owner this browser pinned for a relic, if it has seen one. */
export function pinnedOwnerFor(relicId: string): PinnedOwner | undefined {
  const fromPage = pagePins.get(relicId);
  if (fromPage !== undefined) return fromPage;
  const stored = storedPins()[relicId];
  if (stored === undefined) return undefined;
  return {
    identityId: stored.identity_id,
    email: stored.email,
    firstSeen: stored.first_seen,
  };
}

function pinOwner(relicId: string, pin: PinnedOwner): void {
  pagePins.set(relicId, pin);
  const storage = pinStorage();
  if (storage === undefined) return;
  try {
    storage.setItem(
      PIN_STORAGE_KEY,
      JSON.stringify({
        ...storedPins(),
        [relicId]: {
          identity_id: pin.identityId,
          email: pin.email,
          first_seen: pin.firstSeen,
        },
      })
    );
  } catch {
    // Storage refusing a write keeps the pin for this page only.
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidKeyResponseError('string');
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requireString(value);
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number') throw new InvalidKeyResponseError('number');
  return value;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidKeyResponseError('object');
  }
  return Object.fromEntries(Object.entries(value));
}

function parseIdentityPublic(value: unknown): IdentityPublicJSON {
  return {
    identity_id: requireString(readField(value, 'identity_id')),
    email: requireString(readField(value, 'email')),
    kem_public_key: requireString(readField(value, 'kem_public_key')),
    sig_public_key: requireString(readField(value, 'sig_public_key')),
    created_at: requireString(readField(value, 'created_at')),
    retired_at: nullableString(readField(value, 'retired_at')),
  };
}

function parseParty(value: unknown): PartyJSON {
  return {
    email: requireString(readField(value, 'email')),
    identity: parseIdentityPublic(readField(value, 'identity')),
  };
}

function parseDevice(value: unknown): DevicePublicJSON {
  const backend = requireString(readField(value, 'backend'));
  if (backend !== 'secure-enclave' && backend !== 'file') {
    throw new InvalidKeyResponseError('backend');
  }
  const cert = readField(value, 'cert');
  return {
    device_id: requireString(readField(value, 'device_id')),
    owner_identity_id: requireString(readField(value, 'owner_identity_id')),
    kem_public_key: requireString(readField(value, 'kem_public_key')),
    sig_public_key: requireString(readField(value, 'sig_public_key')),
    label: requireString(readField(value, 'label')),
    backend,
    not_after: requireNumber(readField(value, 'not_after')),
    certified_at: requireString(readField(value, 'certified_at')),
    revoked_at: nullableString(readField(value, 'revoked_at')),
    cert: {
      statement: recordOf(readField(cert, 'statement')),
      identity_signature: requireString(readField(cert, 'identity_signature')),
    },
  };
}

function parseSeal(value: unknown): SealJSON {
  const signerKind = requireString(readField(value, 'signer_kind'));
  if (signerKind !== 'device' && signerKind !== 'identity') {
    throw new InvalidKeyResponseError('signer_kind');
  }
  return {
    statement: recordOf(readField(value, 'statement')),
    signature: requireString(readField(value, 'signature')),
    signer_kind: signerKind,
  };
}

function parseSigner(value: unknown): KeyJSON['signer'] {
  const kind = requireString(readField(value, 'kind'));
  if (kind === 'identity') return { kind: 'identity' };
  if (kind === 'device') {
    return { kind: 'device', device: parseDevice(readField(value, 'device')) };
  }
  throw new InvalidKeyResponseError('signer_kind');
}

/** The key response, parsed field by field. Any unexpected shape is refused. */
function parseKey(value: unknown, relicId: string, version: number): KeyJSON {
  if (
    requireString(readField(value, 'relic_id')) !== relicId ||
    requireNumber(readField(value, 'version')) !== version
  ) {
    throw new InvalidKeyResponseError('relic_or_version');
  }
  const wrap = readField(value, 'wrap');
  const wrapVersion = requireNumber(readField(wrap, 'version'));
  if (wrapVersion !== version) {
    throw new InvalidKeyResponseError('wrap_version');
  }
  return {
    relic_id: relicId,
    version,
    wrap: {
      recipient_key_id: requireString(readField(wrap, 'recipient_key_id')),
      version: wrapVersion,
      enc: requireString(readField(wrap, 'enc')),
      ct: requireString(readField(wrap, 'ct')),
    },
    seal: parseSeal(readField(value, 'seal')),
    signer: parseSigner(readField(value, 'signer')),
    owner: parseParty(readField(value, 'owner')),
  };
}

/** Confirms a device certificate was signed by the pinned owner's key. */
async function verifyDeviceCert(
  device: DevicePublicJSON,
  ownerSigKey: Uint8Array,
  ownerIdentityId: string
): Promise<void> {
  const statement = parseStatement('device_cert', device.cert.statement);
  const signed = await verifyStatement(
    ownerSigKey,
    statementBytes('device_cert', statement),
    device.cert.identity_signature
  );
  if (!signed) throw new SealMismatchError('device_cert_signature');
  if (
    statement.device_id !== device.device_id ||
    statement.owner_identity_id !== ownerIdentityId ||
    device.revoked_at !== null
  ) {
    throw new SealMismatchError('device_cert_scope');
  }
  const kem = decodeBase64url(device.kem_public_key);
  const sig = decodeBase64url(device.sig_public_key);
  if ((await deviceIdOf(kem, sig)) !== device.device_id) {
    throw new SealMismatchError('device_keys');
  }
}

/**
 * Verifies the wrap, seal and owner for one version, and returns the unwrapped
 * key. Pins the owner on the first verified version of a relic.
 */
export async function verifyVersionKey(
  deps: ViewerDeps,
  relicId: string,
  version: number,
  identity: UnlockedIdentity
): Promise<VerifiedKey> {
  const keyJson = parseKey(
    await postJson(
      deps,
      `/api/relics/${encodeURIComponent(relicId)}/versions/${version}/key`,
      {}
    ),
    relicId,
    version
  );

  const ownerKem = decodeBase64url(keyJson.owner.identity.kem_public_key);
  const ownerSig = decodeBase64url(keyJson.owner.identity.sig_public_key);
  const ownerId = keyJson.owner.identity.identity_id;
  if ((await identityIdOf(ownerKem, ownerSig)) !== ownerId) {
    throw new SealMismatchError('owner_keys');
  }

  const pinned = pinnedOwnerFor(relicId);
  if (pinned !== undefined && pinned.identityId !== ownerId) {
    throw new OwnerChangedError(pinned, {
      identityId: ownerId,
      email: keyJson.owner.identity.email,
    });
  }

  let signerKey = ownerSig;
  let signerId = ownerId;
  if (keyJson.signer.kind === 'device') {
    const device = keyJson.signer.device;
    await verifyDeviceCert(device, ownerSig, ownerId);
    signerKey = decodeBase64url(device.sig_public_key);
    signerId = device.device_id;
  }

  const seal = parseStatement('seal', keyJson.seal.statement);
  if (
    seal.relic_id !== relicId ||
    seal.version !== version ||
    seal.signer_id !== signerId
  ) {
    throw new SealMismatchError('seal_scope');
  }
  const sealed = await verifyStatement(
    signerKey,
    statementBytes('seal', seal),
    keyJson.seal.signature
  );
  if (!sealed) throw new SealMismatchError('seal_signature');

  const myKeyId = hex(identity.kemKeyId);
  if (
    !seal.recipient_key_ids.includes(myKeyId) ||
    keyJson.wrap.recipient_key_id !== myKeyId
  ) {
    throw new RecipientMissingError('recipient');
  }

  let key: Uint8Array;
  try {
    key = await unwrapVersionKey({
      recipient: recipientOf(identity),
      relicId,
      version,
      enc: keyJson.wrap.enc,
      ct: keyJson.wrap.ct,
    });
  } catch (error) {
    if (error instanceof WrapOpenError) throw new SealMismatchError('wrap');
    throw error;
  }

  if (pinned === undefined) {
    pinOwner(relicId, {
      identityId: ownerId,
      email: keyJson.owner.identity.email,
      firstSeen: Date.now(),
    });
  }
  return { key, keyJson, seal };
}

/**
 * The key for one version, after every check in `verifyVersionKey` passed.
 * Returned for a version this reader can read, and nothing else.
 */
export async function fetchVersionKey(
  deps: ViewerDeps,
  relicId: string,
  version: number,
  identity: UnlockedIdentity
): Promise<{ key: Uint8Array; keyJson: KeyJSON }> {
  const verified = await verifyVersionKey(deps, relicId, version, identity);
  return { key: verified.key, keyJson: verified.keyJson };
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Fetches a sealed version's ciphertext, checks its digest, and decrypts it. */
export async function fetchAndDecryptVersion(
  deps: ViewerDeps,
  relicId: string,
  version: number,
  identity: UnlockedIdentity
): Promise<OpenedVersion> {
  const verified = await verifyVersionKey(deps, relicId, version, identity);
  const minted = await mint(relicId, deps, version);
  if ('dead' in minted) throw new VersionUnavailableError(minted.dead.code);
  const signed: MintResponse = minted.mint;
  if (signed.version !== version) {
    throw new VersionUnavailableError('version_mismatch');
  }

  let response: Response;
  try {
    response = await deps.fetch(signed.url);
  } catch {
    throw new TransferError('service_unreachable');
  }
  if (!response.ok) throw new TransferError('removed_after_mint');
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  if (ciphertext.length !== signed.object_length) {
    throw new TransferError('truncated_transfer');
  }

  const digest = hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext))
  );
  if (digest !== verified.seal.ciphertext_sha256) {
    throw new SealMismatchError('ciphertext_digest');
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const envelope = await streamRelicContent(
    bytesStream(ciphertext),
    verified.key,
    {
      objectLength: ciphertext.length,
      fragmentVersion: version,
      maxContentBytes: PLAINTEXT_CAP_BYTES,
      onContent: (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
      },
    }
  );
  return { envelope, content: concat(chunks, received), digest };
}
