import { type Envelope, decodeEnvelope } from './envelope.ts';
import { FORMAT_VERSION } from './fragment.ts';
import {
  ContentTooLargeError,
  MalformedContainerError,
  TransferIncompleteError,
  TruncatedContainerError,
} from './errors.ts';
import {
  type ContainerHeader,
  type DerivedKeys,
  HEADER_BYTES,
  decodeHeader,
  decryptRecord,
  deriveKeys,
} from './rfc8188.ts';
import type { OpenedRelic } from './container.ts';

export interface StreamOpenProgress {
  readonly receivedBytes: number; // ciphertext bytes read so far, header included
  readonly objectLength: number;
  readonly openedContentBytes: number; // content plaintext bytes decrypted so far (record 0 excluded)
  readonly contentLength: number | undefined; // entry.length, once record 0 authenticates
}

export interface StreamOpenOptions {
  readonly objectLength: number;
  readonly fragmentVersion?: number; // default FORMAT_VERSION
  readonly maxContentBytes?: number; // refuse a larger entry.length before allocating
  readonly onPrefix?: (prefix: Uint8Array) => void; // once: HEADER_BYTES + record-0 bytes, BEFORE record 0 is decrypted
  readonly onEnvelope?: (envelope: Envelope) => void; // once: after record 0 authenticates
  readonly onProgress?: (progress: StreamOpenProgress) => void; // after every chunk read and every record decrypted
}

/**
 * Open an encrypted Relic container from a ReadableStream.
 *
 * Implements Spec B streaming opener with record-0 early key check and strict end-of-stream.
 */
export async function openRelicStream(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
  options: StreamOpenOptions
): Promise<OpenedRelic> {
  const objectLength = options.objectLength;
  const fragmentVersion = options.fragmentVersion ?? FORMAT_VERSION;

  if (objectLength < HEADER_BYTES) {
    throw new MalformedContainerError(
      `container is ${objectLength} bytes, shorter than the header`
    );
  }

  const reader = source.getReader();

  let receivedBytes = 0;
  let openedContentBytes = 0;
  let contentLength: number | undefined;

  let header: ContainerHeader | undefined;
  let keys: DerivedKeys | undefined;
  let envelope: Envelope | undefined;
  let contentBuffer: Uint8Array | undefined;

  let record0Length = 0;
  let prefixLength = 0;
  let record0Processed = false;
  let processedBytes = 0;
  let nextRecordSeq = 1;

  const bufferedChunks: Uint8Array[] = [];
  let bufferedLength = 0;

  function takeBytes(n: number): Uint8Array {
    const result = new Uint8Array(n);
    let offset = 0;
    while (offset < n && bufferedChunks.length > 0) {
      const head = bufferedChunks[0] as Uint8Array;
      const needed = n - offset;
      if (head.length <= needed) {
        result.set(head, offset);
        offset += head.length;
        bufferedChunks.shift();
      } else {
        result.set(head.subarray(0, needed), offset);
        bufferedChunks[0] = head.subarray(needed);
        offset += needed;
      }
    }
    bufferedLength -= n;
    return result;
  }

  function peekBytes(n: number): Uint8Array {
    const result = new Uint8Array(n);
    let offset = 0;
    for (const chunk of bufferedChunks) {
      const needed = n - offset;
      if (chunk.length <= needed) {
        result.set(chunk, offset);
        offset += chunk.length;
      } else {
        result.set(chunk.subarray(0, needed), offset);
        offset += needed;
        break;
      }
    }
    return result;
  }

  async function processAvailableRecords(): Promise<void> {
    // 1. Process header if not yet decoded
    if (!header && bufferedLength >= HEADER_BYTES) {
      const headerBytes = peekBytes(HEADER_BYTES);
      header = decodeHeader(headerBytes);
      keys = await deriveKeys(key, header.salt);
      const bodyLength = objectLength - HEADER_BYTES;
      if (bodyLength <= 0) {
        throw new MalformedContainerError('container carries no records');
      }
      record0Length = Math.min(header.rs, bodyLength);
      prefixLength = HEADER_BYTES + record0Length;
    }

    // 2. Process record 0 if header decoded and prefix buffered
    if (header && keys && !record0Processed && bufferedLength >= prefixLength) {
      const prefix = takeBytes(prefixLength);
      processedBytes += prefixLength;

      // Call onPrefix BEFORE decrypting record 0
      options.onPrefix?.(prefix);

      const record0Ciphertext = prefix.subarray(HEADER_BYTES);
      const first = await decryptRecord(keys, 0, record0Ciphertext);
      envelope = decodeEnvelope(first.data, fragmentVersion);

      const entry = envelope.entries[0];
      if (!entry) {
        throw new MalformedContainerError('envelope carries no entries');
      }
      if (
        options.maxContentBytes !== undefined &&
        entry.length > options.maxContentBytes
      ) {
        throw new ContentTooLargeError(entry.length, options.maxContentBytes);
      }
      contentLength = entry.length;
      options.onEnvelope?.(envelope);
      options.onProgress?.({
        receivedBytes,
        objectLength,
        openedContentBytes,
        contentLength,
      });

      record0Processed = true;

      if (first.isLast) {
        if (processedBytes < objectLength) {
          throw new MalformedContainerError(
            'delimiter 2 on record 0 before end of container'
          );
        }
        if (entry.length !== 0) {
          throw new TruncatedContainerError(
            `container truncated: expected ${entry.length} content bytes, got 0`
          );
        }
        contentBuffer = new Uint8Array(0);
        options.onProgress?.({
          receivedBytes,
          objectLength,
          openedContentBytes: 0,
          contentLength: 0,
        });
      } else {
        if (processedBytes === objectLength) {
          throw new TruncatedContainerError(
            'positional last record 0 has delimiter 1, expected delimiter 2'
          );
        }
        contentBuffer = new Uint8Array(entry.length);
      }
    }

    // 3. Process subsequent content records
    while (
      header &&
      keys &&
      record0Processed &&
      processedBytes < objectLength
    ) {
      const remainingCiphertext = objectLength - processedBytes;
      const targetRecordSize = Math.min(header.rs, remainingCiphertext);

      if (bufferedLength < targetRecordSize) {
        break;
      }

      const recordCiphertext = takeBytes(targetRecordSize);
      processedBytes += targetRecordSize;
      const seq = nextRecordSeq++;

      const record = await decryptRecord(keys, seq, recordCiphertext);
      const entry = (envelope as Envelope).entries[0]!;

      if (record.isLast) {
        if (processedBytes < objectLength) {
          throw new MalformedContainerError(
            `delimiter 2 on record ${seq} before end of container`
          );
        }
        const newTotal = openedContentBytes + record.data.length;
        if (newTotal < entry.length) {
          throw new TruncatedContainerError(
            `container truncated: expected ${entry.length} content bytes, got ${newTotal}`
          );
        }
        if (newTotal > entry.length) {
          throw new MalformedContainerError(
            `content length ${newTotal} exceeds declared entry length ${entry.length}`
          );
        }
        contentBuffer!.set(record.data, openedContentBytes);
        openedContentBytes = newTotal;
        options.onProgress?.({
          receivedBytes,
          objectLength,
          openedContentBytes,
          contentLength,
        });
      } else {
        if (processedBytes === objectLength) {
          throw new TruncatedContainerError(
            `positional last record ${seq} has delimiter 1, expected delimiter 2`
          );
        }
        const newTotal = openedContentBytes + record.data.length;
        if (newTotal > entry.length) {
          throw new MalformedContainerError(
            `content length ${newTotal} exceeds declared entry length ${entry.length}`
          );
        }
        contentBuffer!.set(record.data, openedContentBytes);
        openedContentBytes = newTotal;
        options.onProgress?.({
          receivedBytes,
          objectLength,
          openedContentBytes,
          contentLength,
        });
      }
    }
  }

  try {
    while (true) {
      let readResult: { done: boolean; value?: Uint8Array | undefined };
      try {
        readResult = await reader.read();
      } catch {
        throw new TransferIncompleteError(receivedBytes, objectLength);
      }
      if (readResult.done) {
        break;
      }

      const chunk = readResult.value;
      if (chunk && chunk.length > 0) {
        receivedBytes += chunk.length;
        if (receivedBytes > objectLength) {
          throw new MalformedContainerError(
            `received ${receivedBytes} bytes, exceeding declared object length ${objectLength}`
          );
        }

        bufferedChunks.push(chunk);
        bufferedLength += chunk.length;

        const recordsBefore = nextRecordSeq;
        const envelopeBefore = record0Processed;

        await processAvailableRecords();

        if (!record0Processed) {
          options.onProgress?.({
            receivedBytes,
            objectLength,
            openedContentBytes,
            contentLength,
          });
        } else if (envelopeBefore && nextRecordSeq === recordsBefore) {
          options.onProgress?.({
            receivedBytes,
            objectLength,
            openedContentBytes,
            contentLength,
          });
        }
      }
    }

    if (receivedBytes < objectLength) {
      throw new TransferIncompleteError(receivedBytes, objectLength);
    }
    if (!record0Processed || processedBytes < objectLength) {
      throw new TruncatedContainerError('container ended prematurely');
    }

    const entry = (envelope as Envelope | undefined)?.entries[0];
    if (!entry || openedContentBytes !== entry.length) {
      throw new TruncatedContainerError(
        `container ended with ${openedContentBytes} content bytes, expected ${entry?.length ?? 0}`
      );
    }

    reader.releaseLock();
    return {
      envelope: envelope!,
      content: contentBuffer!,
    };
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }
}
