/**
 * HPKE base mode, single-shot at sequence zero (RFC 9180), for the one suite a
 * private-share key wrap uses: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
 * AES-128-GCM.
 *
 * WebCrypto only, so the same code runs in browsers, Bun and Node. The
 * recipient supplies its own Diffie-Hellman operation, which lets a Secure
 * Enclave key stand in for a WebCrypto key. Export, PSKs, the authenticated
 * modes and sequence numbers past zero are not implemented: a wrap never needs
 * them.
 *
 * `test/hpke.test.ts` pins each step to RFC 9180 Appendix A.3.1 and A.3.1.1.
 */

import { RelicFormatError } from './errors.ts';

/** An HPKE open was refused. The message is fixed and never carries key material. */
export class HpkeOpenError extends RelicFormatError {
  override readonly name = 'HpkeOpenError';

  constructor() {
    super('HPKE open failed');
  }
}

/**
 * The recipient side of the KEM. `publicKey` is the recipient's SEC1
 * uncompressed point (65 bytes). `dh` returns the 32-byte x-coordinate of the
 * product of the recipient's private key and the peer point.
 */
export interface HpkeRecipient {
  readonly publicKey: Uint8Array;
  dh(peer: Uint8Array): Promise<Uint8Array>;
}

/** DHKEM(P-256, HKDF-SHA256). */
const KEM_ID = 0x0010;
/** HKDF-SHA256. */
const KDF_ID = 0x0001;
/** AES-128-GCM. */
const AEAD_ID = 0x0001;

/** Length of the KEM shared secret, and the largest single-block expand. */
const NSECRET = 32;
/** Length of the AES-128 key. */
const NK = 16;
/** Length of the AES-GCM base nonce. */
const NN = 12;
/** Length of an HMAC-SHA256 output. */
const NH = 32;
/** Length of a SEC1 uncompressed P-256 point. */
const NENC = 65;
/** Length of a P-256 Diffie-Hellman output (the x-coordinate). */
const NDH = 32;

const KEM_SUITE = concat(ascii('KEM'), u16(KEM_ID));
const HPKE_SUITE = concat(
  ascii('HPKE'),
  u16(KEM_ID),
  u16(KDF_ID),
  u16(AEAD_ID)
);
const HPKE_V1 = ascii('HPKE-v1');

const EMPTY = new Uint8Array(0);
/**
 * WebCrypto refuses a zero-length HMAC key. HMAC zero-pads a key to the block
 * size, so 32 zero bytes produce the same MAC as an empty key. Used wherever
 * RFC 9180 calls LabeledExtract with an empty salt.
 */
const EMPTY_HMAC_KEY = new Uint8Array(NH);

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** The result of DHKEM Encap: the sender's public point and the shared secret. */
export interface Encapsulation {
  readonly enc: Uint8Array;
  readonly sharedSecret: Uint8Array;
}

/**
 * DHKEM Encap. `ephemeral` is a test seam: a fixed sender key pair in place of
 * a fresh one. Its public key must be extractable and its private key must
 * allow `deriveBits`.
 */
export async function encapsulate(p: {
  recipientPublicKey: Uint8Array;
  ephemeral?: CryptoKeyPair;
}): Promise<Encapsulation> {
  requireLength(p.recipientPublicKey, NENC, 'recipient public key');
  const recipient = await crypto.subtle.importKey(
    'raw',
    bufferSource(p.recipientPublicKey),
    P256,
    false,
    []
  );
  const ephemeral =
    p.ephemeral ??
    (await crypto.subtle.generateKey(P256, true, ['deriveBits']));
  const enc = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey)
  );
  const dh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: recipient },
      ephemeral.privateKey,
      256
    )
  );
  const sharedSecret = await extractAndExpand(
    dh,
    concat(enc, p.recipientPublicKey)
  );
  return { enc, sharedSecret };
}

/**
 * DHKEM Decap. The recipient's `dh` performs the Diffie-Hellman; this function
 * checks that `enc` is a point on the curve before asking for it, and binds the
 * recipient's own public key into the KEM context.
 */
export async function decapsulate(
  recipient: HpkeRecipient,
  enc: Uint8Array
): Promise<Uint8Array> {
  if (enc.length !== NENC) throw new HpkeOpenError();
  try {
    await crypto.subtle.importKey('raw', bufferSource(enc), P256, false, []);
  } catch {
    throw new HpkeOpenError();
  }
  const dh = await recipient.dh(enc);
  if (dh.length !== NDH) throw new HpkeOpenError();
  return extractAndExpand(dh, concat(enc, recipient.publicKey));
}

/**
 * The HPKE key schedule in base mode (no PSK, empty `psk_id`). Returns the
 * AES key, the base nonce, and the exporter secret. The exporter secret is
 * returned only so the RFC vector can be checked; nothing here exports it.
 */
export async function keySchedule(
  sharedSecret: Uint8Array,
  info: Uint8Array
): Promise<{
  key: Uint8Array;
  baseNonce: Uint8Array;
  exporterSecret: Uint8Array;
}> {
  const pskIdHash = await labeledExtract(
    HPKE_SUITE,
    EMPTY,
    'psk_id_hash',
    EMPTY
  );
  const infoHash = await labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(0x00), pskIdHash, infoHash);
  const secret = await labeledExtract(
    HPKE_SUITE,
    sharedSecret,
    'secret',
    EMPTY
  );
  return {
    key: await labeledExpand(HPKE_SUITE, secret, 'key', context, NK),
    baseNonce: await labeledExpand(
      HPKE_SUITE,
      secret,
      'base_nonce',
      context,
      NN
    ),
    exporterSecret: await labeledExpand(HPKE_SUITE, secret, 'exp', context, NH),
  };
}

/** HPKE Seal at sequence zero: the sender's public point and the AES-GCM output. */
export async function hpkeSeal(p: {
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  ephemeral?: CryptoKeyPair;
}): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
  const { enc, sharedSecret } = await encapsulate(p);
  const { key, baseNonce } = await keySchedule(sharedSecret, p.info);
  const aead = await crypto.subtle.importKey(
    'raw',
    bufferSource(key),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: bufferSource(baseNonce),
      additionalData: bufferSource(p.aad),
      tagLength: 128,
    },
    aead,
    bufferSource(p.plaintext)
  );
  return { enc, ct: new Uint8Array(ct) };
}

/**
 * HPKE Open at sequence zero. Every failure, including a bad point, a wrong
 * recipient, a wrong `info` or `aad`, and a tampered ciphertext, throws the same
 * `HpkeOpenError`, so a caller cannot learn which check failed.
 */
export async function hpkeOpen(p: {
  recipient: HpkeRecipient;
  enc: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ct: Uint8Array;
}): Promise<Uint8Array> {
  try {
    const sharedSecret = await decapsulate(p.recipient, p.enc);
    const { key, baseNonce } = await keySchedule(sharedSecret, p.info);
    const aead = await crypto.subtle.importKey(
      'raw',
      bufferSource(key),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(baseNonce),
        additionalData: bufferSource(p.aad),
        tagLength: 128,
      },
      aead,
      bufferSource(p.ct)
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new HpkeOpenError();
  }
}

async function extractAndExpand(
  dh: Uint8Array,
  kemContext: Uint8Array
): Promise<Uint8Array> {
  const eaePrk = await labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh);
  return labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', kemContext, NSECRET);
}

/** LabeledExtract(salt, label, ikm) = HMAC-SHA256(salt, "HPKE-v1" || suite || label || ikm). */
async function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array
): Promise<Uint8Array> {
  const key = salt.length === 0 ? EMPTY_HMAC_KEY : salt;
  return hmacSha256(key, concat(HPKE_V1, suiteId, ascii(label), ikm));
}

/**
 * LabeledExpand(prk, label, info, L): the first L bytes of
 * HMAC-SHA256(prk, I2OSP(L, 2) || "HPKE-v1" || suite || label || info || 0x01).
 * One HMAC block suffices for every length this file asks for.
 */
async function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  if (length > NH)
    throw new RangeError('HPKE expand is limited to one hash block');
  const mac = await hmacSha256(
    prk,
    concat(
      u16(length),
      HPKE_V1,
      suiteId,
      ascii(label),
      info,
      Uint8Array.of(0x01)
    )
  );
  return mac.slice(0, length);
}

async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    bufferSource(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, bufferSource(data))
  );
}

function requireLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) {
    throw new RelicFormatError(`${what} must be ${length} bytes`);
  }
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

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A big-endian two-byte integer. */
function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}
