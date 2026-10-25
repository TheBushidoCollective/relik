/**
 * The two layers assembled: RFC 8188 framing around the Relic envelope.
 *
 * Object layout, with `rs` the record size from the header:
 *
 *     [0, 21)                    plaintext header
 *     [21, 21 + rs)              record 0, the envelope header, padded full
 *     [21 + rs, 21 + 2rs)        content record 1
 *     ...                        the final record may be shorter
 *
 * Record 0 is padded to full `rs` so every later record sits at a fixed
 * offset, which is what turns range decryption into arithmetic rather than a
 * search. The one exception is zero-byte content, where record 0 is also the
 * final record and is left short (`spec/format.md` 3.9).
 */

import {
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  MAX_HEADER_BYTES,
} from './envelope.ts';
import { ContentTooLargeError, MalformedContainerError } from './errors.ts';
import { FORMAT_VERSION } from './fragment.ts';
import { openRelicStream } from './stream.ts';
import {
  type DerivedKeys,
  decodeHeader,
  decryptRecord,
  deriveKeys,
  encodeHeader,
  encryptRecord,
  HEADER_BYTES,
  RECORD_OVERHEAD,
  RECORD_SIZE,
  recordCapacity,
  SALT_BYTES,
} from './rfc8188.ts';

/** The published cap, on plaintext, verifiable with `ls`. */
export const PLAINTEXT_CAP_BYTES = 100 * 1024 * 1024;

export interface EncryptRelicInput {
  readonly content: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
  readonly key: Uint8Array;
  readonly rs?: number;
  /** Test seam. Production always draws from the platform CSPRNG. */
  readonly salt?: Uint8Array;
}

export async function encryptRelic(
  input: EncryptRelicInput
): Promise<Uint8Array> {
  const rs = input.rs ?? RECORD_SIZE;
  const capacity = recordCapacity(rs);

  if (input.content.length > PLAINTEXT_CAP_BYTES) {
    throw new ContentTooLargeError(input.content.length, PLAINTEXT_CAP_BYTES);
  }

  const salt = input.salt ?? randomSalt();
  const keys = await deriveKeys(input.key, salt);

  const envelope: Envelope = {
    version: FORMAT_VERSION,
    entries: [
      {
        filename: input.filename,
        mimetype: input.mimetype,
        offset: 0,
        length: input.content.length,
      },
    ],
  };
  const envelopeBytes = encodeEnvelope(envelope);

  if (envelopeBytes.length > capacity) {
    throw new MalformedContainerError(
      `envelope header is ${envelopeBytes.length} bytes, over the ` +
        `${capacity} a record can carry`
    );
  }

  const parts: Uint8Array[] = [encodeHeader(salt, rs)];

  if (input.content.length === 0) {
    // Record 0 is also the final record, so it is left short and carries
    // delimiter 2. The object is never zero bytes on the wire.
    parts.push(await encryptRecord(keys, 0, envelopeBytes, true));
    return concat(parts);
  }

  // Padded to full `rs` so content records land at fixed offsets.
  parts.push(await encryptRecord(keys, 0, envelopeBytes, false, capacity));

  const recordCount = Math.ceil(input.content.length / capacity);
  for (let index = 0; index < recordCount; index++) {
    const start = index * capacity;
    const chunk = input.content.slice(start, start + capacity);
    const isLast = index === recordCount - 1;
    parts.push(await encryptRecord(keys, index + 1, chunk, isLast));
  }

  return concat(parts);
}

export interface OpenedRelic {
  readonly envelope: Envelope;
  readonly content: Uint8Array;
}

/** Decrypt a whole container. */
export async function openRelic(
  container: Uint8Array,
  key: Uint8Array,
  fragmentVersion: number = FORMAT_VERSION
): Promise<OpenedRelic> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(container);
      controller.close();
    },
  });
  return openRelicStream(stream, key, {
    objectLength: container.length,
    fragmentVersion,
  });
}

/**
 * Read the envelope header without fetching the whole object.
 *
 * Takes the object's first `HEADER_BYTES + rs` bytes, which is one GCS range
 * request. This is what lets the viewer show a filename and refuse an
 * oversized payload before allocating for the content.
 */
export async function openEnvelope(
  prefix: Uint8Array,
  key: Uint8Array,
  fragmentVersion: number = FORMAT_VERSION
): Promise<Envelope> {
  const header = decodeHeader(prefix);
  const keys = await deriveKeys(key, header.salt);
  const body = prefix.slice(HEADER_BYTES);
  const record = await decryptRecord(keys, 0, sliceRecord(body, 0, header.rs));
  return decodeEnvelope(record.data, fragmentVersion);
}

/** Bytes to fetch to read the envelope header, given a record size. */
export function envelopePrefixLength(rs: number = RECORD_SIZE): number {
  return HEADER_BYTES + rs;
}

export interface ObjectRange {
  /** Inclusive, for an HTTP `Range: bytes=start-end` header. */
  readonly start: number;
  readonly end: number;
  readonly firstRecord: number;
  /** Offset into the decrypted span where the requested content begins. */
  readonly trimStart: number;
}

/**
 * Map a plaintext content range onto the object byte range that covers it.
 *
 * Content byte `n` lives in record `floor(n / capacity) + 1`, which is the
 * whole benefit of padding record 0 to full size.
 */
export function contentRangeToObjectRange(
  contentStart: number,
  contentEnd: number,
  rs: number = RECORD_SIZE
): ObjectRange {
  if (contentStart < 0 || contentEnd < contentStart) {
    throw new MalformedContainerError(
      `invalid content range ${contentStart}..${contentEnd}`
    );
  }

  const capacity = recordCapacity(rs);
  const firstRecord = Math.floor(contentStart / capacity) + 1;
  const lastRecord =
    contentEnd === contentStart
      ? firstRecord
      : Math.floor((contentEnd - 1) / capacity) + 1;

  return {
    start: HEADER_BYTES + firstRecord * rs,
    end: HEADER_BYTES + (lastRecord + 1) * rs - 1,
    firstRecord,
    trimStart: contentStart - (firstRecord - 1) * capacity,
  };
}

/**
 * Decrypt a span of content records fetched by `contentRangeToObjectRange`.
 *
 * `span` is the bytes the range request returned, which may be short if the
 * range ran past the end of the object.
 */
export async function decryptContentRange(
  span: Uint8Array,
  range: ObjectRange,
  salt: Uint8Array,
  key: Uint8Array,
  rs: number = RECORD_SIZE,
  wanted?: number
): Promise<Uint8Array> {
  const keys = await deriveKeys(key, salt);
  const recordCount = Math.ceil(span.length / rs);
  const chunks: Uint8Array[] = [];

  for (let index = 0; index < recordCount; index++) {
    const record = await decryptRecord(
      keys,
      range.firstRecord + index,
      sliceRecord(span, index, rs)
    );
    chunks.push(record.data);
    if (record.isLast) break;
  }

  const joined = concat(chunks).slice(range.trimStart);
  return wanted === undefined ? joined : joined.slice(0, wanted);
}

/**
 * Ciphertext length for a given plaintext length.
 *
 * `spec/format.md` 3.11: when the cap is enforced on ciphertext anywhere, it
 * is computed through this, so a file exactly at the published plaintext cap
 * always fits. `envelopeBytes` defaults to the largest header this build can
 * emit, which is the right basis for a signed grant constraint.
 */
export function encryptedSize(
  contentLength: number,
  rs: number = RECORD_SIZE,
  envelopeBytes: number = MAX_HEADER_BYTES
): number {
  const capacity = recordCapacity(rs);

  if (contentLength === 0) {
    return HEADER_BYTES + envelopeBytes + RECORD_OVERHEAD;
  }

  const recordCount = Math.ceil(contentLength / capacity);
  const lastChunk = contentLength - (recordCount - 1) * capacity;
  const fullRecords = recordCount - 1;

  return HEADER_BYTES + rs + fullRecords * rs + lastChunk + RECORD_OVERHEAD;
}

/** The signed size constraint a grant carries for the published cap. */
export function ciphertextCapBytes(rs: number = RECORD_SIZE): number {
  return encryptedSize(PLAINTEXT_CAP_BYTES, rs);
}

/**
 * An upper bound on content length, computed from the object's length before
 * any decryption (`spec/format.md` 3.3).
 *
 * It is an upper bound rather than exact because record 0 is padded, which is
 * the discretionary-padding case the spec anticipates. That is the safe
 * direction for a refuse-before-allocating check. The exact length arrives in
 * the envelope header's per-entry `length` immediately afterwards.
 */
export function plaintextSizeUpperBound(
  objectLength: number,
  rs: number = RECORD_SIZE
): number {
  const body = objectLength - HEADER_BYTES;
  if (body <= 0) return 0;

  const recordCount = Math.ceil(body / rs);
  const dataCapacity = body - recordCount * RECORD_OVERHEAD;
  // Record 0 carries no content, so subtract everything it could hold.
  return Math.max(0, dataCapacity - recordCapacity(rs));
}

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

function sliceRecord(body: Uint8Array, index: number, rs: number): Uint8Array {
  const start = index * rs;
  if (start >= body.length) {
    throw new MalformedContainerError(`record ${index} is past the object`);
  }
  return body.slice(start, Math.min(start + rs, body.length));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type { DerivedKeys };
