import {
  ContentTooLargeError,
  MalformedContainerError,
  TransferIncompleteError,
  TruncatedContainerError,
} from './errors.ts';
import {
  decodeAnyEnvelope,
  EntrySizeMismatchError,
  folderPlaintext,
  type EncryptFolderInput,
} from './folder-container.ts';
import { PLAINTEXT_CAP_BYTES } from './limits.ts';
import { decodeManifest, type FolderHeader } from './multi.ts';
import {
  decodeHeader,
  decryptRecord,
  deriveKeys,
  encodeHeader,
  encryptRecord,
  HEADER_BYTES,
  RECORD_SIZE,
  recordCapacity,
} from './rfc8188.ts';

/** Encrypt a folder as records without assembling its ciphertext in memory. */
export function encryptFolderStream(
  input: EncryptFolderInput
): ReadableStream<Uint8Array> {
  const { headerBytes, parts } = folderPlaintext(input);
  const rs = input.rs ?? RECORD_SIZE;
  const capacity = recordCapacity(rs);
  if (capacity < headerBytes.length)
    throw new MalformedContainerError('folder header exceeds record capacity');
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));

  async function* plaintext(): AsyncGenerator<Uint8Array> {
    yield parts[0] as Uint8Array;
    for (const entry of input.entries) {
      if (entry.bytes instanceof Uint8Array) {
        yield entry.bytes;
        continue;
      }
      let seen = 0;
      for await (const chunk of entry.bytes.chunks()) {
        if (!(chunk instanceof Uint8Array))
          throw new MalformedContainerError(
            'entry source yielded a non-byte chunk'
          );
        seen += chunk.length;
        if (seen > entry.bytes.size)
          throw new EntrySizeMismatchError(entry.path, entry.bytes.size, seen);
        yield chunk;
      }
      if (seen !== entry.bytes.size)
        throw new EntrySizeMismatchError(entry.path, entry.bytes.size, seen);
    }
  }

  async function* records(): AsyncGenerator<Uint8Array> {
    const keys = await deriveKeys(input.key, salt);
    yield encodeHeader(salt, rs);
    yield await encryptRecord(keys, 0, headerBytes, false, capacity);
    let buffer = new Uint8Array(capacity),
      filled = 0,
      sequence = 1;
    for await (const chunk of plaintext()) {
      let offset = 0;
      while (offset < chunk.length) {
        if (filled === capacity) {
          yield await encryptRecord(keys, sequence++, buffer, false);
          buffer = new Uint8Array(capacity);
          filled = 0;
        }
        const length = Math.min(capacity - filled, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + length), filled);
        offset += length;
        filled += length;
      }
    }
    yield await encryptRecord(keys, sequence, buffer.subarray(0, filled), true);
  }
  const iterator = records();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

export interface FolderStreamOptions {
  readonly objectLength: number;
  readonly maxContentBytes?: number;
  readonly onHeader?: (header: FolderHeader) => void;
  /** The sink must discard all chunks if this operation rejects. */
  readonly onContent: (chunk: Uint8Array) => void | Promise<void>;
}

/** Authenticate each record before sending it to the sink. */
export async function streamFolderContent(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
  options: FolderStreamOptions
): Promise<FolderHeader> {
  const limit = options.maxContentBytes ?? PLAINTEXT_CAP_BYTES;
  if (
    !Number.isSafeInteger(options.objectLength) ||
    options.objectLength < HEADER_BYTES ||
    !Number.isSafeInteger(limit) ||
    limit < 0
  )
    throw new MalformedContainerError('invalid stream limits');
  const reader = source.getReader();
  let received = 0,
    buffered = 0,
    position = 0;
  const chunks: Uint8Array[] = [];
  async function take(n: number): Promise<Uint8Array> {
    while (buffered < n) {
      const { done, value } = await reader.read();
      if (done)
        throw new TransferIncompleteError(received, options.objectLength);
      received += value.length;
      if (received > options.objectLength)
        throw new MalformedContainerError(
          'stream exceeds declared object length'
        );
      if (value.length) {
        chunks.push(value);
        buffered += value.length;
      }
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const first = chunks[0]!;
      const count = Math.min(n - at, first.length - position);
      out.set(first.subarray(position, position + count), at);
      at += count;
      position += count;
      buffered -= count;
      if (position === first.length) {
        chunks.shift();
        position = 0;
      }
    }
    return out;
  }
  try {
    const framing = decodeHeader(await take(HEADER_BYTES));
    if (framing.rs > RECORD_SIZE)
      throw new MalformedContainerError('record size exceeds stream limit');
    if (options.objectLength < HEADER_BYTES + framing.rs)
      throw new TruncatedContainerError('folder record 0 is truncated');
    const keys = await deriveKeys(key, framing.salt);
    const first = await decryptRecord(keys, 0, await take(framing.rs));
    const envelope = decodeAnyEnvelope(first.data, { admitted: [2] });
    if (envelope.version !== 2 || first.isLast)
      throw new MalformedContainerError('invalid folder header record');
    const header = envelope as FolderHeader;
    if (header.contentLength > Math.min(limit, PLAINTEXT_CAP_BYTES))
      throw new ContentTooLargeError(
        header.contentLength,
        Math.min(limit, PLAINTEXT_CAP_BYTES)
      );
    options.onHeader?.(header);
    const manifest = new Uint8Array(header.manifestLength);
    let consumed = HEADER_BYTES + framing.rs,
      written = 0,
      seq = 1;
    while (consumed < options.objectLength) {
      const length = Math.min(framing.rs, options.objectLength - consumed);
      const record = await decryptRecord(keys, seq++, await take(length));
      consumed += length;
      if (record.isLast !== (consumed === options.objectLength))
        throw new MalformedContainerError('invalid final record delimiter');
      if (written < manifest.length) {
        manifest.set(
          record.data.subarray(
            0,
            Math.min(record.data.length, manifest.length - written)
          ),
          written
        );
      }
      written += record.data.length;
      if (written > header.contentLength)
        throw new MalformedContainerError(
          'folder content exceeds declared length'
        );
      await options.onContent(record.data);
    }
    if (written !== header.contentLength)
      throw new TruncatedContainerError('folder content is truncated');
    decodeManifest(manifest, header);
    const extra = await reader.read();
    if (!extra.done)
      throw new MalformedContainerError(
        'stream exceeds declared object length'
      );
    reader.releaseLock();
    return header;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }
}
