import { MalformedContainerError, TransferIncompleteError } from './errors.ts';
import { decodeAnyEnvelope, type AnyEnvelope } from './folder-container.ts';
import { streamFolderContent } from './folder-stream.ts';
import { ENVELOPE_VERSIONS } from './multi.ts';
import {
  decodeHeader,
  decryptRecord,
  deriveKeys,
  HEADER_BYTES,
  RECORD_SIZE,
} from './rfc8188.ts';
import { streamRelicContent, type StreamContentOptions } from './stream.ts';

export interface AnyStreamContentOptions
  extends Omit<StreamContentOptions, 'onEnvelope'> {
  readonly onEnvelope?: (envelope: AnyEnvelope) => void;
}

/** Probe one bounded authenticated record, then replay it to the existing decoder. */
async function probe(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
  objectLength: number,
  onPrefix?: (prefix: Uint8Array) => void
): Promise<{
  envelope: AnyEnvelope;
  prefix: Uint8Array;
  replay: ReadableStream<Uint8Array>;
}> {
  if (!Number.isSafeInteger(objectLength) || objectLength < HEADER_BYTES)
    throw new MalformedContainerError('invalid stream length');
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  async function ensure(size: number): Promise<void> {
    while (buffered < size) {
      const result = await reader.read();
      if (result.done)
        throw new TransferIncompleteError(buffered, objectLength);
      if (result.value.length) {
        chunks.push(result.value);
        buffered += result.value.length;
      }
    }
  }
  function prefixOf(size: number): Uint8Array {
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.length, size - offset);
      result.set(chunk.subarray(0, length), offset);
      offset += length;
      if (offset === size) break;
    }
    return result;
  }
  try {
    await ensure(HEADER_BYTES);
    const framing = decodeHeader(prefixOf(HEADER_BYTES));
    if (framing.rs > RECORD_SIZE)
      throw new MalformedContainerError('record size exceeds stream limit');
    const prefixLength =
      HEADER_BYTES + Math.min(framing.rs, objectLength - HEADER_BYTES);
    await ensure(prefixLength);
    const prefix = prefixOf(prefixLength);
    onPrefix?.(prefix);
    const record = await decryptRecord(
      await deriveKeys(key, framing.salt),
      0,
      prefix.subarray(HEADER_BYTES)
    );
    const envelope = decodeAnyEnvelope(record.data, {
      admitted: ENVELOPE_VERSIONS,
    });
    let index = 0;
    const replay = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (index < chunks.length) {
            controller.enqueue(chunks[index++]!);
            return;
          }
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    });
    return { envelope, prefix, replay };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
}

/** Authenticate the first record without downloading the remainder. */
export async function readAnyRelicEnvelope(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
  options: {
    readonly objectLength: number;
    readonly onPrefix?: (prefix: Uint8Array) => void;
  }
): Promise<{ envelope: AnyEnvelope; prefix: Uint8Array }> {
  const result = await probe(
    source,
    key,
    options.objectLength,
    options.onPrefix
  );
  await result.replay.cancel();
  return { envelope: result.envelope, prefix: result.prefix };
}

/** Open v1 unchanged or stream a validated folder into the caller's sink. */
export async function streamAnyRelicContent(
  source: ReadableStream<Uint8Array>,
  key: Uint8Array,
  options: AnyStreamContentOptions
): Promise<AnyEnvelope> {
  const opened = await probe(
    source,
    key,
    options.objectLength,
    options.onPrefix
  );
  if (opened.envelope.version !== 2) {
    const { onPrefix: _onPrefix, ...remaining } = options;
    return streamRelicContent(opened.replay, key, remaining);
  }
  return streamFolderContent(opened.replay, key, {
    objectLength: options.objectLength,
    ...(options.maxContentBytes === undefined
      ? {}
      : { maxContentBytes: options.maxContentBytes }),
    ...(options.onEnvelope === undefined
      ? {}
      : { onHeader: options.onEnvelope }),
    onContent: options.onContent,
  });
}
