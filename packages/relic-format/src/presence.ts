import { decodeKey, encodeKey } from './fragment.ts';

export const PRESENCE_PLAINTEXT_BYTES = 512;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_AGE_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface PresenceV1 {
  readonly v: 1;
  readonly t: number;
  readonly name: string | null;
  readonly color: number;
  readonly version: number;
  readonly caret?: { readonly s: number; readonly e: number };
  readonly typing?: { readonly s: number; readonly e: number };
  readonly posted?: string;
}

/** Pass the same version key bytes used to derive that version's comment key. */
export async function derivePresenceKeys(
  keyBytes: Uint8Array,
  relicId: string
): Promise<{ readonly seal: CryptoKey; readonly room: string }> {
  const material = await crypto.subtle.importKey(
    'raw',
    toBuffer(keyBytes),
    'HKDF',
    false,
    ['deriveBits']
  );
  const derive = (info: string) =>
    crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: encoder.encode(info),
      },
      material,
      128
    );
  const [sealBits, roomBits] = await Promise.all([
    derive('relic/presence/v1/seal'),
    derive(`relic/presence/v1/room:${relicId}`),
  ]);
  return {
    seal: await crypto.subtle.importKey('raw', sealBits, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]),
    room: encodeKey(new Uint8Array(roomBits)),
  };
}

/** Frames contain JSON followed by zero padding, all authenticated by AES-GCM. */
export async function sealPresence(
  key: CryptoKey,
  room: string,
  presence: PresenceV1
): Promise<string> {
  if (!isPresence(presence)) throw new TypeError('Invalid presence frame');
  const json = encoder.encode(JSON.stringify(presence));
  if (json.length > PRESENCE_PLAINTEXT_BYTES) {
    throw new RangeError('Presence frame exceeds its plaintext size');
  }
  const plaintext = new Uint8Array(PRESENCE_PLAINTEXT_BYTES);
  plaintext.set(json);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(room) },
    key,
    plaintext
  );
  const frame = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
  frame.set(nonce);
  frame.set(new Uint8Array(ciphertext), NONCE_BYTES);
  return encodeKey(frame);
}

/** Invalid, unauthenticated, and older-than-30-second frames are ignored. */
export async function openPresence(
  key: CryptoKey,
  room: string,
  ciphertext: string
): Promise<PresenceV1 | undefined> {
  try {
    const frameBytes = NONCE_BYTES + PRESENCE_PLAINTEXT_BYTES + TAG_BYTES;
    if (
      ciphertext.length !== Math.ceil((frameBytes * 4) / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(ciphertext)
    ) {
      return undefined;
    }
    const frame = decodeKey(ciphertext);
    if (frame.length !== frameBytes || encodeKey(frame) !== ciphertext) {
      return undefined;
    }
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toBuffer(frame.subarray(0, NONCE_BYTES)),
          additionalData: additionalData(room),
        },
        key,
        toBuffer(frame.subarray(NONCE_BYTES))
      )
    );
    if (plaintext.length !== PRESENCE_PLAINTEXT_BYTES) return undefined;
    const padding = plaintext.indexOf(0);
    if (
      padding !== -1 &&
      plaintext.subarray(padding).some((byte) => byte !== 0)
    ) {
      return undefined;
    }
    const json = padding === -1 ? plaintext : plaintext.subarray(0, padding);
    const parsed: unknown = JSON.parse(decoder.decode(json));
    if (!isPresence(parsed) || Math.abs(Date.now() - parsed.t) > MAX_AGE_MS) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function additionalData(room: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`relic/presence/v1|${room}`);
}

function isPresence(value: unknown): value is PresenceV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const p = value as Record<string, unknown>;
  if (
    p['v'] !== 1 ||
    !nonnegativeInteger(p['t']) ||
    !(
      p['name'] === null ||
      (typeof p['name'] === 'string' && encoder.encode(p['name']).length <= 64)
    ) ||
    !(typeof p['color'] === 'number' && Number.isFinite(p['color'])) ||
    !nonnegativeInteger(p['version']) ||
    (p['caret'] !== undefined && !isRange(p['caret'])) ||
    (p['typing'] !== undefined && !isRange(p['typing'])) ||
    (p['posted'] !== undefined && typeof p['posted'] !== 'string')
  ) {
    return false;
  }
  return true;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRange(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const range = value as Record<string, unknown>;
  return (
    nonnegativeInteger(range['s']) &&
    nonnegativeInteger(range['e']) &&
    range['s'] <= range['e']
  );
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
