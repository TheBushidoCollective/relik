/**
 * Object storage, behind an interface.
 *
 * The app server is structurally not in either data path: the publishing
 * client PUTs ciphertext straight to storage under a signed grant, and the
 * recipient GETs it straight from storage under a signed URL. That is what
 * upgrades the zero-knowledge claim from "we promise" to "we structurally
 * cannot" (`preconditions.md` section 4).
 *
 * What the server does hold is bucket-mutating credentials, because
 * delete-by-ID is a v1 abuse control.
 */
import { createHash } from 'node:crypto';

export interface SignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  /**
   * Headers the signature pins. A client cannot alter or add a signed header
   * without invalidating the signature.
   *
   * No `x-goog-meta-*` appears here. `docs/decisions.md` item 6: nothing needs
   * custom object metadata, and `format.md` 3.2 bars anything
   * content-descriptive from living in it anyway.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: number;
  /**
   * The exact object length the signature pins.
   *
   * Not a ceiling. `Content-Length` is ignored on a signed PUT unless it is
   * one of the signed headers, and once signed it must match exactly, so
   * there is no such thing as signing an upper bound.
   */
  readonly contentLength: number;
}

export interface ObjectStat {
  readonly length: number;
  /**
   * Base64 CRC32C, read from non-editable metadata GCS computes itself.
   *
   * Its only job is separating transport corruption from everything else,
   * which matters because a tag failure is otherwise indistinguishable from a
   * wrong key. It removes one branch and cannot remove the others. It is 32
   * bits and is never used as the abuse blocklist hash.
   */
  readonly crc32c: string;
  readonly generation?: string | undefined;
}

export interface ObjectStorage {
  signUpload(
    relicId: string,
    contentLength: number,
    validitySeconds: number,
    now: number
  ): Promise<SignedUpload>;
  signDownload(
    relicId: string,
    validitySeconds: number,
    now: number
  ): Promise<{ url: string; expiresAt: number }>;
  stat(relicId: string): Promise<ObjectStat | undefined>;
  /** Read the bytes once, for the delete path's hash. Never for serving. */
  read(relicId: string): Promise<Uint8Array | undefined>;
  delete(relicId: string): Promise<void>;
  /** Streaming sha256 hex of the object at that key; undefined iff absent; throws on other errors. */
  digest(relicId: string): Promise<string | undefined>;
}

/** In-memory storage, for tests and local development. */
export class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly uploads = new Map<string, { maxBytes: number }>();

  constructor(private readonly origin = 'https://storage.invalid') {}

  async signUpload(
    relicId: string,
    contentLength: number,
    validitySeconds: number,
    now: number
  ): Promise<SignedUpload> {
    const token = `${relicId}.${now}`;
    this.uploads.set(token, { maxBytes: contentLength });
    return {
      url: `${this.origin}/upload/${relicId}?token=${token}`,
      method: 'PUT',
      headers: { 'content-length': String(contentLength) },
      expiresAt: now + validitySeconds * 1000,
      contentLength,
    };
  }

  async signDownload(
    relicId: string,
    validitySeconds: number,
    now: number
  ): Promise<{ url: string; expiresAt: number }> {
    const expiresAt = now + validitySeconds * 1000;
    return {
      url: `${this.origin}/o/${relicId}?expires=${expiresAt}`,
      expiresAt,
    };
  }

  async stat(relicId: string): Promise<ObjectStat | undefined> {
    const bytes = this.objects.get(relicId);
    if (bytes === undefined) return undefined;
    return { length: bytes.length, crc32c: crc32cBase64(bytes) };
  }

  async read(relicId: string): Promise<Uint8Array | undefined> {
    return this.objects.get(relicId);
  }

  async delete(relicId: string): Promise<void> {
    this.objects.delete(relicId);
  }

  async digest(relicId: string): Promise<string | undefined> {
    const object = await this.stat(relicId);
    if (object === undefined) return undefined;
    const bytes = this.objects.get(relicId);
    if (bytes === undefined) return undefined;
    const hash = createHash('sha256');
    let bytesHashed = 0;
    hash.update(bytes);
    bytesHashed += bytes.byteLength;
    if (bytesHashed !== object.length) {
      throw new Error(
        `digest length mismatch: stat=${object.length}, hashed=${bytesHashed}`
      );
    }
    return hash.digest('hex');
  }
  /** Test seam: stand in for the client's direct-to-storage PUT. */
  put(relicId: string, bytes: Uint8Array): void {
    this.objects.set(relicId, bytes);
  }
}

const CRC32C_POLY = 0x82f63b78;
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ CRC32C_POLY : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32cBase64(bytes: Uint8Array): string {
  const value = crc32c(bytes);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return btoa(String.fromCharCode(...out));
}

/**
 * The abuse blocklist hash.
 *
 * SHA-256 over the ciphertext, never the CRC32C: 32 bits is unfit for a
 * blocklist. A delete with no hash is refused, because by then it is the
 * payload you most want blocklisted.
 */
export async function ciphertextHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
