/**
 * Minimal WebAuthn verifier for Relic passkey decisions (spec §4.5).
 *
 * Verifies WebAuthn Level 3 registration and assertion responses using WebCrypto
 * and built-in Node/Bun crypto primitives, with zero third-party dependencies.
 *
 * Supported algorithms:
 *   - ES256 (COSE alg -7): ECDSA over P-256 with SHA-256
 *   - RS256 (COSE alg -257): RSASSA-PKCS1-v1_5 with SHA-256
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * WebAuthn verification or malformed payload error.
 *
 * The `kind` distinguishes 400 invalid_passkey ('malformed') from
 * 403 passkey_verification_failed ('verification').
 * The `check` specifies the exact check that failed.
 */
export class WebauthnError extends Error {
  constructor(
    readonly kind: 'malformed' | 'verification',
    readonly check: string
  ) {
    super(`WebAuthn ${kind}: ${check}`);
    this.name = 'WebauthnError';
  }
}

/** Check if string is unpadded base64url (RFC 4648 §5). */
function isValidBase64url(str: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(str) && str.length % 4 !== 1;
}

/** Parse an unpadded base64url string to Uint8Array. */
export function parseBase64url(str: unknown): Uint8Array {
  if (typeof str !== 'string' || !isValidBase64url(str)) {
    throw new WebauthnError('malformed', 'encoding');
  }
  try {
    return new Uint8Array(Buffer.from(str, 'base64url'));
  } catch {
    throw new WebauthnError('malformed', 'encoding');
  }
}

/** Parse ASN.1 DER length (short or long form). */
function readDerLength(
  bytes: Uint8Array,
  offset: number
): { len: number; nextOffset: number } | null {
  if (offset >= bytes.length) return null;
  const initial = bytes[offset];
  if (initial === undefined) return null;
  if ((initial & 0x80) === 0) {
    return { len: initial, nextOffset: offset + 1 };
  }
  const numLenBytes = initial & 0x7f;
  if (
    numLenBytes === 0 ||
    numLenBytes > 2 ||
    offset + 1 + numLenBytes > bytes.length
  ) {
    return null;
  }
  let len = 0;
  for (let i = 0; i < numLenBytes; i++) {
    const byte = bytes[offset + 1 + i];
    if (byte === undefined) return null;
    len = (len << 8) | byte;
  }
  return { len, nextOffset: offset + 1 + numLenBytes };
}

/**
 * Convert ASN.1 DER ECDSA signature (SEQUENCE { r INTEGER, s INTEGER })
 * into raw 64-byte IEEE P1363 format (32-byte r || 32-byte s).
 *
 * Handles leading-zero r/s (e.g. 33 bytes with 0x00 sign byte) and
 * short integers (r or s < 32 bytes).
 */
export function derToRawEcdsa(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30) return null;
  const seqLenRes = readDerLength(der, 1);
  if (!seqLenRes) return null;
  let offset = seqLenRes.nextOffset;
  if (offset + seqLenRes.len !== der.length) return null;

  if (offset >= der.length || der[offset] !== 0x02) return null;
  const rLenRes = readDerLength(der, offset + 1);
  if (!rLenRes) return null;
  offset = rLenRes.nextOffset;
  if (offset + rLenRes.len > der.length) return null;
  let r = der.subarray(offset, offset + rLenRes.len);
  offset += rLenRes.len;

  if (offset >= der.length || der[offset] !== 0x02) return null;
  const sLenRes = readDerLength(der, offset + 1);
  if (!sLenRes) return null;
  offset = sLenRes.nextOffset;
  if (offset + sLenRes.len !== der.length) return null;
  let s = der.subarray(offset, offset + sLenRes.len);

  // Strip leading zeros for r if length > 32
  while (r.length > 32 && r[0] === 0x00) {
    r = r.subarray(1);
  }
  if (r.length > 32 || r.length === 0) return null;

  // Strip leading zeros for s if length > 32
  while (s.length > 32 && s[0] === 0x00) {
    s = s.subarray(1);
  }
  if (s.length > 32 || s.length === 0) return null;

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

/**
 * Convert 64-byte raw IEEE P1363 ECDSA signature into ASN.1 DER SEQUENCE.
 */
export function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
  if (raw.byteLength !== 64) {
    throw new Error('raw ECDSA signature must be 64 bytes');
  }

  function encodeInteger(part: Uint8Array): Uint8Array {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) {
      start++;
    }
    let slice = part.subarray(start);
    const first = slice[0];
    if (first !== undefined && (first & 0x80) !== 0) {
      const b = new Uint8Array(slice.length + 1);
      b[0] = 0x00;
      b.set(slice, 1);
      slice = b;
    }
    const res = new Uint8Array(slice.length + 2);
    res[0] = 0x02;
    res[1] = slice.length;
    res.set(slice, 2);
    return res;
  }

  const rDer = encodeInteger(raw.subarray(0, 32));
  const sDer = encodeInteger(raw.subarray(32, 64));
  const totalLen = rDer.length + sDer.length;
  if (totalLen < 128) {
    const seq = new Uint8Array(totalLen + 2);
    seq[0] = 0x30;
    seq[1] = totalLen;
    seq.set(rDer, 2);
    seq.set(sDer, 2 + rDer.length);
    return seq;
  }
  const seq = new Uint8Array(totalLen + 3);
  seq[0] = 0x30;
  seq[1] = 0x81;
  seq[2] = totalLen;
  seq.set(rDer, 3);
  seq.set(sDer, 3 + rDer.length);
  return seq;
}

/**
 * Definite-length CBOR decoder conforming to RFC 8949 and spec §4.5.
 * Indefinite lengths, floats, tags (major type 6), and depth > 16 are malformed.
 */
export function decodeCborItem(
  bytes: Uint8Array,
  offset: number,
  depth: number
): { value: unknown; offset: number } {
  if (depth > 16) {
    throw new WebauthnError('malformed', 'cbor');
  }
  if (offset >= bytes.length) {
    throw new WebauthnError('malformed', 'cbor');
  }
  const initial = bytes[offset++];
  if (initial === undefined) {
    throw new WebauthnError('malformed', 'cbor');
  }
  const majorType = initial >> 5;
  const ai = initial & 0x1f;

  let val: number | bigint;
  if (ai < 24) {
    val = ai;
  } else if (ai === 24) {
    if (offset >= bytes.length) throw new WebauthnError('malformed', 'cbor');
    const b = bytes[offset++];
    if (b === undefined) throw new WebauthnError('malformed', 'cbor');
    val = b;
  } else if (ai === 25) {
    if (majorType === 7) {
      // 16-bit float
      throw new WebauthnError('malformed', 'cbor');
    }
    if (offset + 2 > bytes.length) throw new WebauthnError('malformed', 'cbor');
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    if (b0 === undefined || b1 === undefined) {
      throw new WebauthnError('malformed', 'cbor');
    }
    val = (b0 << 8) | b1;
    offset += 2;
  } else if (ai === 26) {
    if (majorType === 7) {
      // 32-bit float
      throw new WebauthnError('malformed', 'cbor');
    }
    if (offset + 4 > bytes.length) throw new WebauthnError('malformed', 'cbor');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    val = view.getUint32(0, false);
    offset += 4;
  } else if (ai === 27) {
    if (majorType === 7) {
      // 64-bit float
      throw new WebauthnError('malformed', 'cbor');
    }
    if (offset + 8 > bytes.length) throw new WebauthnError('malformed', 'cbor');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const big = view.getBigUint64(0, false);
    offset += 8;
    if (big <= BigInt(Number.MAX_SAFE_INTEGER)) {
      val = Number(big);
    } else {
      val = big;
    }
  } else {
    // ai 28..30 reserved, 31 indefinite length
    throw new WebauthnError('malformed', 'cbor');
  }

  switch (majorType) {
    case 0:
      return { value: val, offset };
    case 1:
      if (typeof val === 'bigint') {
        const neg = -1n - val;
        return {
          value: neg >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(neg) : neg,
          offset,
        };
      }
      return { value: -1 - val, offset };
    case 2: {
      const len = typeof val === 'bigint' ? Number(val) : val;
      if (typeof val === 'bigint' && val > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WebauthnError('malformed', 'cbor');
      }
      if (offset + len > bytes.length) {
        throw new WebauthnError('malformed', 'cbor');
      }
      const slice = bytes.subarray(offset, offset + len);
      offset += len;
      return { value: slice, offset };
    }
    case 3: {
      const len = typeof val === 'bigint' ? Number(val) : val;
      if (typeof val === 'bigint' && val > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WebauthnError('malformed', 'cbor');
      }
      if (offset + len > bytes.length) {
        throw new WebauthnError('malformed', 'cbor');
      }
      const slice = bytes.subarray(offset, offset + len);
      offset += len;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(slice);
        return { value: text, offset };
      } catch {
        throw new WebauthnError('malformed', 'cbor');
      }
    }
    case 4: {
      const count = typeof val === 'bigint' ? Number(val) : val;
      if (typeof val === 'bigint' && val > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WebauthnError('malformed', 'cbor');
      }
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const item = decodeCborItem(bytes, offset, depth + 1);
        arr.push(item.value);
        offset = item.offset;
      }
      return { value: arr, offset };
    }
    case 5: {
      const count = typeof val === 'bigint' ? Number(val) : val;
      if (typeof val === 'bigint' && val > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WebauthnError('malformed', 'cbor');
      }
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < count; i++) {
        const keyItem = decodeCborItem(bytes, offset, depth + 1);
        offset = keyItem.offset;
        const valItem = decodeCborItem(bytes, offset, depth + 1);
        offset = valItem.offset;
        map.set(keyItem.value, valItem.value);
      }
      return { value: map, offset };
    }
    case 7: {
      if (val === 20) return { value: false, offset };
      if (val === 21) return { value: true, offset };
      if (val === 22) return { value: null, offset };
      if (val === 23) return { value: undefined, offset };
      return { value: val, offset };
    }
    default:
      throw new WebauthnError('malformed', 'cbor');
  }
}

/** Parse and validate clientDataJSON bytes and fields. */
function parseClientDataJSON(rawB64: unknown): {
  parsed: Record<string, unknown>;
  bytes: Uint8Array;
} {
  if (typeof rawB64 !== 'string') {
    throw new WebauthnError('malformed', 'shape');
  }
  const bytes = parseBase64url(rawB64);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WebauthnError('malformed', 'encoding');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebauthnError('malformed', 'shape');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebauthnError('malformed', 'shape');
  }
  return { parsed: parsed as Record<string, unknown>, bytes };
}

/**
 * Extract unverified challenge from clientDataJSON.
 * Throws WebauthnError('malformed', ...) on malformed credential.
 */
export function challengeOf(credential: unknown): string {
  if (typeof credential !== 'object' || credential === null) {
    throw new WebauthnError('malformed', 'shape');
  }
  const cred = credential as Record<string, unknown>;
  if (typeof cred['response'] !== 'object' || cred['response'] === null) {
    throw new WebauthnError('malformed', 'shape');
  }
  const resp = cred['response'] as Record<string, unknown>;
  if (typeof resp['clientDataJSON'] !== 'string') {
    throw new WebauthnError('malformed', 'shape');
  }
  const { parsed } = parseClientDataJSON(resp['clientDataJSON']);
  if (typeof parsed['challenge'] !== 'string') {
    throw new WebauthnError('malformed', 'shape');
  }
  return parsed['challenge'];
}

/**
 * Validate shape and extract credential id (must match rawId).
 * Throws WebauthnError('malformed', 'shape' | 'encoding').
 */
export function credentialIdOf(credential: unknown): string {
  if (typeof credential !== 'object' || credential === null) {
    throw new WebauthnError('malformed', 'shape');
  }
  const cred = credential as Record<string, unknown>;
  if (cred['type'] !== 'public-key') {
    throw new WebauthnError('malformed', 'shape');
  }
  if (typeof cred['id'] !== 'string' || typeof cred['rawId'] !== 'string') {
    throw new WebauthnError('malformed', 'shape');
  }
  if (cred['id'] !== cred['rawId']) {
    throw new WebauthnError('malformed', 'shape');
  }
  if (!isValidBase64url(cred['id'])) {
    throw new WebauthnError('malformed', 'encoding');
  }
  return cred['id'];
}

/** Check counter strictly: new signCount must be > stored if either > 0. */
export function checkCounter(
  storedSignCount: number,
  newSignCount: number
): void {
  if (
    (storedSignCount > 0 || newSignCount > 0) &&
    newSignCount <= storedSignCount
  ) {
    throw new WebauthnError('verification', 'counter');
  }
}

/**
 * Verify a WebAuthn registration response (spec §4.5).
 */
export async function verifyRegistration(
  credential: unknown,
  e: { challenge: string; origin: string; rpId: string }
): Promise<{
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  alg: -7 | -257;
  signCount: number;
  transports: readonly string[];
}> {
  const credentialId = credentialIdOf(credential);
  const cred = credential as Record<string, unknown>;
  if (typeof cred['response'] !== 'object' || cred['response'] === null) {
    throw new WebauthnError('malformed', 'shape');
  }
  const resp = cred['response'] as Record<string, unknown>;
  if (
    typeof resp['clientDataJSON'] !== 'string' ||
    typeof resp['attestationObject'] !== 'string'
  ) {
    throw new WebauthnError('malformed', 'shape');
  }
  let transports: readonly string[] = [];
  if (resp['transports'] !== undefined) {
    if (
      !Array.isArray(resp['transports']) ||
      !resp['transports'].every((t) => typeof t === 'string')
    ) {
      throw new WebauthnError('malformed', 'shape');
    }
    transports = resp['transports'] as readonly string[];
  }

  // Parse clientDataJSON
  const { parsed: clientData } = parseClientDataJSON(resp['clientDataJSON']);
  if (
    typeof clientData['type'] !== 'string' ||
    typeof clientData['challenge'] !== 'string' ||
    typeof clientData['origin'] !== 'string'
  ) {
    throw new WebauthnError('malformed', 'shape');
  }
  if (clientData['type'] !== 'webauthn.create') {
    throw new WebauthnError('verification', 'type');
  }
  if (clientData['challenge'] !== e.challenge) {
    throw new WebauthnError('verification', 'challenge');
  }
  if (clientData['origin'] !== e.origin) {
    throw new WebauthnError('verification', 'origin');
  }
  if (clientData['crossOrigin'] === true) {
    throw new WebauthnError('verification', 'cross_origin');
  }

  // Parse attestationObject
  const attBytes = parseBase64url(resp['attestationObject']);
  const { value: attObj, offset: attOffset } = decodeCborItem(attBytes, 0, 0);
  if (attOffset !== attBytes.byteLength) {
    throw new WebauthnError('malformed', 'cbor');
  }
  if (!(attObj instanceof Map)) {
    throw new WebauthnError('malformed', 'cbor');
  }
  const authData = attObj.get('authData');
  if (!(authData instanceof Uint8Array)) {
    throw new WebauthnError('malformed', 'cbor');
  }

  // Parse authData
  if (authData.byteLength < 37) {
    throw new WebauthnError('malformed', 'auth_data');
  }
  const expectedRpIdHash = createHash('sha256').update(e.rpId).digest();
  const authRpIdHash = authData.subarray(0, 32);
  if (!timingSafeEqual(expectedRpIdHash, authRpIdHash)) {
    throw new WebauthnError('verification', 'rp_id');
  }

  const flags = authData[32];
  if (flags === undefined) {
    throw new WebauthnError('malformed', 'auth_data');
  }
  if ((flags & 0x01) === 0) {
    throw new WebauthnError('verification', 'user_present');
  }
  if ((flags & 0x04) === 0) {
    throw new WebauthnError('verification', 'user_verified');
  }
  if ((flags & 0x40) === 0) {
    throw new WebauthnError('malformed', 'auth_data');
  }

  const signCount = new DataView(
    authData.buffer,
    authData.byteOffset + 33,
    4
  ).getUint32(0, false);

  // Attested credential data
  if (authData.byteLength < 55) {
    throw new WebauthnError('malformed', 'auth_data');
  }
  const credIdLen = new DataView(
    authData.buffer,
    authData.byteOffset + 53,
    2
  ).getUint16(0, false);
  if (credIdLen > 1023 || authData.byteLength < 55 + credIdLen) {
    throw new WebauthnError('malformed', 'auth_data');
  }
  const credIdBytes = authData.subarray(55, 55 + credIdLen);
  const credIdStr = Buffer.from(credIdBytes).toString('base64url');
  if (credIdStr !== credentialId) {
    throw new WebauthnError('verification', 'credential');
  }

  let offset = 55 + credIdLen;

  // COSE Key
  const { value: coseKey, offset: coseOffset } = decodeCborItem(
    authData,
    offset,
    0
  );
  if (!(coseKey instanceof Map)) {
    throw new WebauthnError('malformed', 'cbor');
  }
  offset = coseOffset;

  // Extension data if ED (0x80) is set
  if ((flags & 0x80) !== 0) {
    const { value: extMap, offset: extOffset } = decodeCborItem(
      authData,
      offset,
      0
    );
    if (!(extMap instanceof Map)) {
      throw new WebauthnError('malformed', 'cbor');
    }
    offset = extOffset;
  }

  // No trailing bytes allowed
  if (offset !== authData.byteLength) {
    throw new WebauthnError('malformed', 'auth_data');
  }

  // Parse COSE key
  const kty = coseKey.get(1);
  const alg = coseKey.get(3);

  if (alg === -7) {
    const crv = coseKey.get(-1);
    const x = coseKey.get(-2);
    const y = coseKey.get(-3);
    if (
      kty !== 2 ||
      crv !== 1 ||
      !(x instanceof Uint8Array) ||
      x.byteLength !== 32 ||
      !(y instanceof Uint8Array) ||
      y.byteLength !== 32
    ) {
      throw new WebauthnError('malformed', 'algorithm');
    }
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(x).toString('base64url'),
      y: Buffer.from(y).toString('base64url'),
    };
    try {
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
      );
    } catch {
      throw new WebauthnError('malformed', 'key');
    }
    return {
      credentialId,
      publicKeyJwk: jwk,
      alg: -7,
      signCount,
      transports,
    };
  }

  if (alg === -257) {
    const n = coseKey.get(-1);
    const e = coseKey.get(-2);
    if (kty !== 3 || !(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new WebauthnError('malformed', 'algorithm');
    }

    let startN = 0;
    while (startN < n.byteLength && n[startN] === 0) {
      startN++;
    }
    const strippedN = n.subarray(startN);
    if (strippedN.byteLength < 256 || strippedN.byteLength > 512) {
      throw new WebauthnError('malformed', 'key');
    }

    let startE = 0;
    while (startE < e.byteLength && e[startE] === 0) {
      startE++;
    }
    const strippedE = e.subarray(startE);
    const isE65537 =
      strippedE.byteLength === 3 &&
      strippedE[0] === 0x01 &&
      strippedE[1] === 0x00 &&
      strippedE[2] === 0x01;
    if (!isE65537) {
      throw new WebauthnError('malformed', 'key');
    }

    const jwk: JsonWebKey = {
      kty: 'RSA',
      n: Buffer.from(strippedN).toString('base64url'),
      e: Buffer.from(strippedE).toString('base64url'),
    };
    try {
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        true,
        ['verify']
      );
    } catch {
      throw new WebauthnError('malformed', 'key');
    }
    return {
      credentialId,
      publicKeyJwk: jwk,
      alg: -257,
      signCount,
      transports,
    };
  }

  throw new WebauthnError('malformed', 'algorithm');
}

/**
 * Verify a WebAuthn assertion response (spec §4.5).
 */
export async function verifyAssertion(
  credential: unknown,
  e: {
    challenge: string;
    origin: string;
    rpId: string;
    stored: {
      credentialId: string;
      publicKeyJwk: JsonWebKey;
      alg: -7 | -257;
      signCount?: number;
    };
    userHandle: string;
  }
): Promise<{ credentialId: string; signCount: number }> {
  const credentialId = credentialIdOf(credential);
  if (credentialId !== e.stored.credentialId) {
    throw new WebauthnError('verification', 'credential');
  }

  const cred = credential as Record<string, unknown>;
  if (typeof cred['response'] !== 'object' || cred['response'] === null) {
    throw new WebauthnError('malformed', 'shape');
  }
  const resp = cred['response'] as Record<string, unknown>;
  if (
    typeof resp['clientDataJSON'] !== 'string' ||
    typeof resp['authenticatorData'] !== 'string' ||
    typeof resp['signature'] !== 'string'
  ) {
    throw new WebauthnError('malformed', 'shape');
  }

  // userHandle check (if non-null, must equal stored userHandle)
  if (resp['userHandle'] !== null && resp['userHandle'] !== undefined) {
    if (typeof resp['userHandle'] !== 'string') {
      throw new WebauthnError('malformed', 'shape');
    }
    if (resp['userHandle'] !== e.userHandle) {
      throw new WebauthnError('verification', 'user_handle');
    }
  }

  // Parse clientDataJSON
  const { parsed: clientData, bytes: clientDataBytes } = parseClientDataJSON(
    resp['clientDataJSON']
  );
  if (
    typeof clientData['type'] !== 'string' ||
    typeof clientData['challenge'] !== 'string' ||
    typeof clientData['origin'] !== 'string'
  ) {
    throw new WebauthnError('malformed', 'shape');
  }
  if (clientData['type'] !== 'webauthn.get') {
    throw new WebauthnError('verification', 'type');
  }
  if (clientData['challenge'] !== e.challenge) {
    throw new WebauthnError('verification', 'challenge');
  }
  if (clientData['origin'] !== e.origin) {
    throw new WebauthnError('verification', 'origin');
  }
  if (clientData['crossOrigin'] === true) {
    throw new WebauthnError('verification', 'cross_origin');
  }

  // Parse authenticatorData
  const authData = parseBase64url(resp['authenticatorData']);
  if (authData.byteLength < 37) {
    throw new WebauthnError('malformed', 'auth_data');
  }
  const expectedRpIdHash = createHash('sha256').update(e.rpId).digest();
  const authRpIdHash = authData.subarray(0, 32);
  if (!timingSafeEqual(expectedRpIdHash, authRpIdHash)) {
    throw new WebauthnError('verification', 'rp_id');
  }

  const flags = authData[32];
  if (flags === undefined) {
    throw new WebauthnError('malformed', 'auth_data');
  }
  if ((flags & 0x01) === 0) {
    throw new WebauthnError('verification', 'user_present');
  }
  if ((flags & 0x04) === 0) {
    throw new WebauthnError('verification', 'user_verified');
  }
  // Spec line 260: "Assertion: AT must be clear."
  if ((flags & 0x40) !== 0) {
    throw new WebauthnError('malformed', 'auth_data');
  }

  const signCount = new DataView(
    authData.buffer,
    authData.byteOffset + 33,
    4
  ).getUint32(0, false);

  if (e.stored.signCount !== undefined) {
    checkCounter(e.stored.signCount, signCount);
  }

  // Verify signature over authData || sha256(clientDataJSON)
  const clientDataHash = createHash('sha256').update(clientDataBytes).digest();
  const signedData = Buffer.concat([authData, clientDataHash]);
  const sigBytes = parseBase64url(resp['signature']);

  if (e.stored.alg === -7) {
    const rawSig = derToRawEcdsa(sigBytes);
    if (!rawSig) {
      throw new WebauthnError('verification', 'signature');
    }
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        'jwk',
        e.stored.publicKeyJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
    } catch {
      throw new WebauthnError('malformed', 'key');
    }
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      rawSig as unknown as BufferSource,
      signedData as unknown as BufferSource
    );
    if (!valid) {
      throw new WebauthnError('verification', 'signature');
    }
    return { credentialId, signCount };
  }

  if (e.stored.alg === -257) {
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        'jwk',
        e.stored.publicKeyJwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
    } catch {
      throw new WebauthnError('malformed', 'key');
    }
    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      cryptoKey,
      sigBytes as unknown as BufferSource,
      signedData as unknown as BufferSource
    );
    if (!valid) {
      throw new WebauthnError('verification', 'signature');
    }
    return { credentialId, signCount };
  }

  throw new WebauthnError('malformed', 'algorithm');
}
