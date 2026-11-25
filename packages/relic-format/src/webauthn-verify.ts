/**
 * The WebAuthn assertion verifier that the service and relic-mcp share
 * (`docs/plans/signing/plan.md` 5.4). It is pure: WebCrypto and bytes only, no
 * network, no clock, no stored state. The service keeps its own `node:crypto`
 * verifier for passkey sign-in and counters; this one is the portable copy
 * that signing certificates verify against, and the service's differential test
 * holds the two in agreement.
 *
 * What it checks, in order, and which failure each check names:
 *   - the credential's id is the expected one (`verification`, `credential`);
 *   - `type` is `webauthn.get`, the challenge and origin match, and
 *     `crossOrigin` is not true;
 *   - `rpIdHash` is SHA-256 of the expected relying-party id;
 *   - UP and UV are set, and AT is clear;
 *   - extension data (ED) is exactly one CBOR map that fills the rest of the
 *     authenticator data, and with no ED the data is exactly 37 bytes;
 *   - the signature verifies over `authenticatorData || SHA-256(clientDataJSON)`:
 *     ES256 with the DER form converted to IEEE P1363, or RS256.
 *
 * The signature counter is not checked here. It needs stored state, so the
 * service compares it itself under its compare-and-swap.
 */

import { RelicFormatError } from './errors.ts';
import { decodeBase64url } from './private.ts';

/** Which refusal class a failure belongs to: a malformed payload or a verification failure. */
export type WebauthnFailureKind = 'malformed' | 'verification';

/** The named check that failed. */
export type WebauthnCheck =
  | 'shape'
  | 'encoding'
  | 'credential'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'cross_origin'
  | 'auth_data'
  | 'rp_id'
  | 'user_present'
  | 'user_verified'
  | 'extensions'
  | 'algorithm'
  | 'key'
  | 'signature';

/** An assertion that does not verify. The message names the check, never a value. */
export class WebauthnAssertionError extends RelicFormatError {
  override readonly name = 'WebauthnAssertionError';

  constructor(
    readonly kind: WebauthnFailureKind,
    readonly check: WebauthnCheck
  ) {
    super(`WebAuthn ${kind}: ${check}`);
  }
}

/** What the caller expects the assertion to be bound to. */
export interface AssertionExpectation {
  /** Unpadded base64url of the challenge the statements committed to. */
  readonly challenge: string;
  /** The origin the browser must report, for example `https://relik.link`. */
  readonly origin: string;
  /** The relying-party id, for example `relik.link`. */
  readonly rpId: string;
  /** The stored public key, as a JWK. It must carry no private part. */
  readonly publicKeyJwk: JsonWebKey;
  /** -7 for ES256 or -257 for RS256. */
  readonly alg: -7 | -257;
  /** The base64url credential id the passkey was registered with. */
  readonly credentialId: string;
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;
const ED = 0x80;
const AUTH_DATA_MIN = 37;
const CBOR_MAX_DEPTH = 16;

/**
 * Verify a WebAuthn assertion response. Resolves when every check passes and
 * throws `WebauthnAssertionError` naming the first check that fails.
 */
export async function verifyWebauthnAssertion(
  credential: unknown,
  expect: AssertionExpectation
): Promise<void> {
  const cred = objectOf(credential);
  if (cred.type !== 'public-key') malformed('shape');
  if (
    typeof cred.id !== 'string' ||
    typeof cred.rawId !== 'string' ||
    cred.id !== cred.rawId
  ) {
    malformed('shape');
  }
  if (cred.id !== expect.credentialId) verification('credential');

  const resp = objectOf(cred.response);
  if (
    typeof resp.clientDataJSON !== 'string' ||
    typeof resp.authenticatorData !== 'string' ||
    typeof resp.signature !== 'string' ||
    (resp.userHandle !== null &&
      resp.userHandle !== undefined &&
      typeof resp.userHandle !== 'string')
  ) {
    malformed('shape');
  }

  const clientDataBytes = decodeOrMalformed(resp.clientDataJSON);
  const clientData = parseClientData(clientDataBytes);
  if (clientData.type !== 'webauthn.get') verification('type');
  if (clientData.challenge !== expect.challenge) verification('challenge');
  if (clientData.origin !== expect.origin) verification('origin');
  if (clientData.crossOrigin === true) verification('cross_origin');

  const authData = decodeOrMalformed(resp.authenticatorData);
  if (authData.length < AUTH_DATA_MIN) malformed('auth_data');
  const rpIdHash = await sha256(utf8(expect.rpId));
  if (!bytesEqual(rpIdHash, authData.subarray(0, 32))) verification('rp_id');

  const flags = authData[32] ?? 0;
  if ((flags & UP) === 0) verification('user_present');
  if ((flags & UV) === 0) verification('user_verified');
  if ((flags & AT) !== 0) malformed('auth_data');
  if ((flags & ED) !== 0) {
    const extensions = readCbor(authData, AUTH_DATA_MIN, 0);
    if (!(extensions.value instanceof Map)) malformed('extensions');
    if (extensions.offset !== authData.length) malformed('extensions');
  } else if (authData.length !== AUTH_DATA_MIN) {
    malformed('auth_data');
  }

  const signature = decodeOrMalformed(resp.signature);
  const clientDataHash = await sha256(clientDataBytes);
  const signed = concat(authData, clientDataHash);
  const key = await importVerificationKey(expect);

  let valid: boolean;
  if (expect.alg === -7) {
    const raw = derToP1363(signature);
    if (raw === undefined) verification('signature');
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toBuffer(raw),
      toBuffer(signed)
    );
  } else {
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      toBuffer(signature),
      toBuffer(signed)
    );
  }
  if (!valid) verification('signature');
}

/** The DER form of an ECDSA signature becomes the 64-byte IEEE P1363 form WebCrypto verifies. */
export function derToP1363(der: Uint8Array): Uint8Array | undefined {
  if (der.length < 8 || der[0] !== 0x30) return undefined;
  const seq = derLength(der, 1);
  if (seq === undefined) return undefined;
  let offset = seq.next;
  if (offset + seq.length !== der.length) return undefined;

  const r = derInteger(der, offset);
  if (r === undefined) return undefined;
  offset = r.next;
  const s = derInteger(der, offset);
  if (s === undefined || s.next !== der.length) return undefined;

  const raw = new Uint8Array(64);
  raw.set(r.value, 32 - r.value.length);
  raw.set(s.value, 64 - s.value.length);
  return raw;
}

function derInteger(
  der: Uint8Array,
  offset: number
): { value: Uint8Array; next: number } | undefined {
  if (der[offset] !== 0x02) return undefined;
  const len = derLength(der, offset + 1);
  if (len === undefined || len.next + len.length > der.length) return undefined;
  let value = der.subarray(len.next, len.next + len.length);
  while (value.length > 32 && value[0] === 0x00) value = value.subarray(1);
  if (value.length === 0 || value.length > 32) return undefined;
  return { value, next: len.next + len.length };
}

function derLength(
  der: Uint8Array,
  offset: number
): { length: number; next: number } | undefined {
  const initial = der[offset];
  if (initial === undefined) return undefined;
  if ((initial & 0x80) === 0) return { length: initial, next: offset + 1 };
  const count = initial & 0x7f;
  if (count === 0 || count > 2 || offset + 1 + count > der.length) {
    return undefined;
  }
  let length = 0;
  for (let i = 0; i < count; i++)
    length = (length << 8) | (der[offset + 1 + i] ?? 0);
  return { length, next: offset + 1 + count };
}

// ---------------------------------------------------------------------------
// CBOR: definite lengths only, no floats, no tags, no indefinite items. The
// caller checks that the item ends exactly where the authenticator data ends.
// ---------------------------------------------------------------------------

function readCbor(
  bytes: Uint8Array,
  start: number,
  depth: number
): { value: unknown; offset: number } {
  if (depth > CBOR_MAX_DEPTH) malformed('extensions');
  let offset = start;
  const initial = byteAt(bytes, offset++);
  const major = initial >> 5;
  const info = initial & 0x1f;

  let arg: number;
  if (info < 24) {
    arg = info;
  } else if (info === 24) {
    arg = byteAt(bytes, offset++);
  } else if (info === 25 || info === 26 || info === 27) {
    const width = info === 25 ? 2 : info === 26 ? 4 : 8;
    if (offset + width > bytes.length) malformed('extensions');
    let big = 0n;
    for (let i = 0; i < width; i++) {
      big = (big << 8n) | BigInt(bytes[offset + i] ?? 0);
    }
    offset += width;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) malformed('extensions');
    arg = Number(big);
  } else {
    malformed('extensions');
  }

  switch (major) {
    case 0:
      return { value: arg, offset };
    case 1:
      return { value: -1 - arg, offset };
    case 2:
      return bytesItem(bytes, offset, arg);
    case 3:
      return textItem(bytes, offset, arg);
    case 4:
      return arrayItem(bytes, offset, arg, depth);
    case 5:
      return mapItem(bytes, offset, arg, depth);
    case 7:
      return simpleItem(info, offset);
    default:
      return malformed('extensions');
  }
}

function bytesItem(
  bytes: Uint8Array,
  offset: number,
  length: number
): { value: unknown; offset: number } {
  if (length > bytes.length - offset) malformed('extensions');
  return {
    value: bytes.subarray(offset, offset + length),
    offset: offset + length,
  };
}

function textItem(
  bytes: Uint8Array,
  offset: number,
  length: number
): { value: unknown; offset: number } {
  const raw = bytesItem(bytes, offset, length);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      raw.value as Uint8Array
    );
    return { value: text, offset: raw.offset };
  } catch {
    return malformed('extensions');
  }
}

function arrayItem(
  bytes: Uint8Array,
  offset: number,
  count: number,
  depth: number
): { value: unknown; offset: number } {
  if (count > bytes.length - offset) malformed('extensions');
  const items: unknown[] = [];
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    const item = readCbor(bytes, cursor, depth + 1);
    items.push(item.value);
    cursor = item.offset;
  }
  return { value: items, offset: cursor };
}

function mapItem(
  bytes: Uint8Array,
  offset: number,
  count: number,
  depth: number
): { value: unknown; offset: number } {
  if (count * 2 > bytes.length - offset) malformed('extensions');
  const map = new Map<unknown, unknown>();
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    const key = readCbor(bytes, cursor, depth + 1);
    const value = readCbor(bytes, key.offset, depth + 1);
    map.set(key.value, value.value);
    cursor = value.offset;
  }
  return { value: map, offset: cursor };
}

/** Simple values: false, true, null and undefined. Floats and other simple values are refused. */
function simpleItem(
  info: number,
  offset: number
): { value: unknown; offset: number } {
  if (info === 20) return { value: false, offset };
  if (info === 21) return { value: true, offset };
  if (info === 22) return { value: null, offset };
  if (info === 23) return { value: undefined, offset };
  return malformed('extensions');
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function importVerificationKey(
  expect: AssertionExpectation
): Promise<CryptoKey> {
  const algorithm =
    expect.alg === -7
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  try {
    return await crypto.subtle.importKey(
      'jwk',
      expect.publicKeyJwk,
      algorithm,
      false,
      ['verify']
    );
  } catch {
    malformed('key');
  }
}

function parseClientData(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
  } catch {
    malformed('shape');
  }
  const object = objectOf(parsed);
  if (
    typeof object.type !== 'string' ||
    typeof object.challenge !== 'string' ||
    typeof object.origin !== 'string'
  ) {
    malformed('shape');
  }
  return object;
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed('shape');
  }
  return value as Record<string, unknown>;
}

function decodeOrMalformed(text: unknown): Uint8Array {
  if (typeof text !== 'string') malformed('shape');
  try {
    return decodeBase64url(text);
  } catch {
    malformed('encoding');
  }
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const byte = bytes[offset];
  if (byte === undefined) malformed('extensions');
  return byte;
}

function malformed(check: WebauthnCheck): never {
  throw new WebauthnAssertionError('malformed', check);
}

function verification(check: WebauthnCheck): never {
  throw new WebauthnAssertionError('verification', check);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(bytes)));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
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

/** A copy of exactly this view's bytes, as WebCrypto requires. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
