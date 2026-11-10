import { describe, expect, test } from 'bun:test';
import {
  ciphertextCapBytes,
  encryptRelic,
  openRelic,
  PLAINTEXT_CAP_BYTES,
} from '../src/container.ts';
import { encodeEnvelope, type Envelope } from '../src/envelope.ts';
import {
  ContentTooLargeError,
  DecryptFailedError,
  MalformedContainerError,
  TransferIncompleteError,
  TruncatedContainerError,
} from '../src/errors.ts';
import { generateKey } from '../src/fragment.ts';
import {
  deriveKeys,
  encodeHeader,
  encryptRecord,
  HEADER_BYTES,
  RECORD_SIZE,
  recordCapacity,
} from '../src/rfc8188.ts';
import {
  type StreamOpenProgress,
  openRelicStream,
  readRelicEnvelope,
  streamRelicContent,
} from '../src/stream.ts';

const RS = 64;
const CAPACITY = recordCapacity(RS);

function bytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = state & 0xff;
  }
  return out;
}

function chunkStream(sourceBytes: Uint8Array, chunkSize: number) {
  let offset = 0;
  let cancels = 0;
  let pulledChunks = 0;
  let pulledBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= sourceBytes.length) {
        controller.close();
        return;
      }
      pulledChunks++;
      const end = Math.min(offset + chunkSize, sourceBytes.length);
      const chunk = sourceBytes.slice(offset, end);
      pulledBytes += chunk.length;
      offset = end;
      controller.enqueue(chunk);
    },
    cancel() {
      cancels++;
    },
  });
  return {
    stream,
    getPulledChunks: () => pulledChunks,
    getPulledBytes: () => pulledBytes,
    getCancels: () => cancels,
  };
}

describe('openRelicStream', () => {
  test('output equals openRelic across content sizes, record sizes, and chunk sizes', async () => {
    for (const rs of [RS, RECORD_SIZE]) {
      const cap = recordCapacity(rs);
      const testSizes = [0, 1, cap - 1, cap, cap + 1, 3 * cap + 7];

      for (const size of testSizes) {
        const content = bytes(size);
        const key = generateKey();
        const container = await encryptRelic({
          content,
          filename: 'a.txt',
          mimetype: 'text/plain',
          key,
          rs,
        });

        const expected = await openRelic(container, key);

        const chunkSizes = [1, 7, rs, rs + 1, container.length];
        for (const chunkSize of chunkSizes) {
          const { stream } = chunkStream(container, chunkSize);
          const actual = await openRelicStream(stream, key, {
            objectLength: container.length,
          });

          expect(actual.envelope).toEqual(expected.envelope);
          expect(actual.content).toEqual(expected.content);
        }
      }
    }
  });

  test('wrong key cancels after record 0 without firing onEnvelope', async () => {
    const content = bytes(CAPACITY * 3);
    const rightKey = generateKey();
    const wrongKey = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key: rightKey,
      rs: RS,
    });

    const chunkSize = 16;
    const tracker = chunkStream(container, chunkSize);

    let prefixReceived: Uint8Array | undefined;
    let envelopeFired = false;

    let thrown: unknown;
    try {
      await openRelicStream(tracker.stream, wrongKey, {
        objectLength: container.length,
        onPrefix: (prefix) => {
          prefixReceived = prefix;
        },
        onEnvelope: () => {
          envelopeFired = true;
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DecryptFailedError);
    expect((thrown as DecryptFailedError).recordSeq).toBe(0);

    const record0Length = Math.min(RS, container.length - HEADER_BYTES);
    const expectedPrefixLength = HEADER_BYTES + record0Length;
    expect(prefixReceived?.length).toBe(expectedPrefixLength);
    expect(envelopeFired).toBe(false);

    expect(tracker.getCancels()).toBe(1);
    const maxChunksExpected = Math.ceil(expectedPrefixLength / chunkSize) + 1;
    expect(tracker.getPulledChunks()).toBeLessThanOrEqual(maxChunksExpected);
    expect(tracker.getPulledBytes()).toBeLessThanOrEqual(
      maxChunksExpected * chunkSize
    );
  });

  test('content exceeding maxContentBytes throws ContentTooLargeError without firing onEnvelope', async () => {
    const content = bytes(100);
    const key = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });

    let envelopeFired = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(container);
        controller.close();
      },
    });

    let err: unknown;
    try {
      await openRelicStream(stream, key, {
        objectLength: container.length,
        maxContentBytes: 50,
        onEnvelope: () => {
          envelopeFired = true;
        },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ContentTooLargeError);
    expect(envelopeFired).toBe(false);
  });

  test('stream that closes early or rejects throws TransferIncompleteError', async () => {
    const content = bytes(CAPACITY * 3);
    const key = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });

    // 1. Closes early
    const halfBytes = container.slice(0, Math.floor(container.length / 2));
    const shortStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(halfBytes);
        controller.close();
      },
    });

    let err1: unknown;
    try {
      await openRelicStream(shortStream, key, {
        objectLength: container.length,
      });
    } catch (err) {
      err1 = err;
    }
    expect(err1).toBeInstanceOf(TransferIncompleteError);
    expect((err1 as TransferIncompleteError).receivedBytes).toBe(
      halfBytes.length
    );
    expect((err1 as TransferIncompleteError).expectedBytes).toBe(
      container.length
    );

    // 2. Stream rejects
    const failingStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('network disconnect'));
      },
    });

    let err2: unknown;
    try {
      await openRelicStream(failingStream, key, {
        objectLength: container.length,
      });
    } catch (err) {
      err2 = err;
    }
    expect(err2).toBeInstanceOf(TransferIncompleteError);
  });

  test('bytes beyond objectLength throw MalformedContainerError after cancel', async () => {
    const content = bytes(CAPACITY);
    const key = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });

    let sent = false;
    let cancels = 0;
    const overflowingStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(container);
          controller.enqueue(new Uint8Array([1, 2, 3]));
        }
      },
      cancel() {
        cancels++;
      },
    });

    let thrown: unknown;
    try {
      await openRelicStream(overflowingStream, key, {
        objectLength: container.length,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MalformedContainerError);
    expect(cancels).toBe(1);
  });

  test('declared entry.length above maxContentBytes throws ContentTooLargeError before second content record is pulled', async () => {
    const content = bytes(CAPACITY * 3);
    const key = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });

    const tracker = chunkStream(container, RS);
    let thrown: unknown;

    try {
      await openRelicStream(tracker.stream, key, {
        objectLength: container.length,
        maxContentBytes: CAPACITY, // smaller than CAPACITY * 3
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ContentTooLargeError);
    // Only pulled header + record 0 (and at most 1 chunk into record 1; record 2 never pulled)
    expect(tracker.getPulledChunks()).toBeLessThanOrEqual(3);
  });

  test('onEnvelope fires once, after record 0; onProgress is monotonic and ends exact', async () => {
    const content = bytes(CAPACITY * 4);
    const key = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });

    const envelopeEvents: Envelope[] = [];
    const progressEvents: StreamOpenProgress[] = [];

    const { stream } = chunkStream(container, 17);
    await openRelicStream(stream, key, {
      objectLength: container.length,
      onEnvelope: (env) => {
        envelopeEvents.push(env);
      },
      onProgress: (prog) => {
        progressEvents.push(prog);
      },
    });

    expect(envelopeEvents.length).toBe(1);
    expect(progressEvents.length).toBeGreaterThanOrEqual(4);

    let prevReceived = 0;
    let prevOpened = 0;
    for (const p of progressEvents) {
      expect(p.receivedBytes).toBeGreaterThanOrEqual(prevReceived);
      expect(p.openedContentBytes).toBeGreaterThanOrEqual(prevOpened);
      prevReceived = p.receivedBytes;
      prevOpened = p.openedContentBytes;
    }

    const last = progressEvents[progressEvents.length - 1]!;
    expect(last.receivedBytes).toBe(container.length);
    expect(last.openedContentBytes).toBe(content.length);
    expect(last.contentLength).toBe(content.length);
  });

  test('byte flipped in record 2 throws DecryptFailedError with recordSeq === 2 after onEnvelope fired', async () => {
    const content = bytes(CAPACITY * 3);
    const key = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });

    // Record 0 is [21, 21 + RS) = [21, 85)
    // Record 1 is [85, 85 + RS) = [85, 149)
    // Record 2 starts at 149.
    const tampered = new Uint8Array(container);
    tampered[149 + 5] = tampered[149 + 5]! ^ 0xff;

    let envelopeFired = false;
    let thrown: unknown;

    const { stream } = chunkStream(tampered, 32);
    try {
      await openRelicStream(stream, key, {
        objectLength: tampered.length,
        onEnvelope: () => {
          envelopeFired = true;
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(envelopeFired).toBe(true);
    expect(thrown).toBeInstanceOf(DecryptFailedError);
    expect((thrown as DecryptFailedError).recordSeq).toBe(2);
  });
});

describe('bounded stream sink', () => {
  test('matches the buffered opener across record boundaries and awaits each sink write', async () => {
    for (const size of [0, 1, 65_519, 65_520, 1_000_000]) {
      const content = bytes(size);
      const key = generateKey();
      const container = await encryptRelic({
        content,
        filename: 'content.bin',
        mimetype: 'application/octet-stream',
        key,
      });
      const expected = await openRelicStream(
        chunkStream(container, 37_000).stream,
        key,
        {
          objectLength: container.length,
        }
      );
      const parts: Uint8Array[] = [];
      let active = 0;
      const envelope = await streamRelicContent(
        chunkStream(container, 51_000).stream,
        key,
        {
          objectLength: container.length,
          maxContentBytes: PLAINTEXT_CAP_BYTES,
          async onContent(chunk) {
            expect(++active).toBe(1);
            await Promise.resolve();
            parts.push(chunk);
            active--;
          },
        }
      );
      expect(envelope).toEqual(expected.envelope);
      expect(Buffer.concat(parts.map((part) => Buffer.from(part)))).toEqual(
        Buffer.from(content)
      );
    }
  });

  test('accepts a cap-sized authenticated envelope without allocating its contents, and rejects cap plus one', async () => {
    const key = generateKey();
    const salt = new Uint8Array(16);
    const keys = await deriveKeys(key, salt);
    const rs = 256;
    const header = encodeHeader(salt, rs);
    for (const length of [PLAINTEXT_CAP_BYTES, PLAINTEXT_CAP_BYTES + 1]) {
      const envelope = encodeEnvelope({
        version: 1,
        entries: [
          {
            filename: 'large.bin',
            mimetype: 'application/octet-stream',
            offset: 0,
            length,
          },
        ],
      });
      const record = await encryptRecord(
        keys,
        0,
        envelope,
        false,
        recordCapacity(rs)
      );
      const prefix = new Uint8Array(header.length + record.length);
      prefix.set(header);
      prefix.set(record, header.length);
      const tracker = chunkStream(prefix, 128);
      let seenLength: number | undefined;
      const result = streamRelicContent(tracker.stream, key, {
        objectLength: ciphertextCapBytes(),
        maxContentBytes: PLAINTEXT_CAP_BYTES,
        onEnvelope: (value) => {
          seenLength = value.entries[0]?.length;
        },
        onContent: () => {
          throw new Error('no content was provided');
        },
      });
      if (length === PLAINTEXT_CAP_BYTES) {
        await expect(result).rejects.toBeInstanceOf(TransferIncompleteError);
        expect(seenLength).toBe(length);
      } else {
        await expect(result).rejects.toBeInstanceOf(ContentTooLargeError);
        expect(seenLength).toBeUndefined();
      }
    }
  });

  test('rejects oversized caller input before encryption without reading its bytes', async () => {
    const oversized = {
      length: PLAINTEXT_CAP_BYTES + 1,
    } as unknown as Uint8Array;
    await expect(
      encryptRelic({
        content: oversized,
        filename: 'large.bin',
        mimetype: 'application/octet-stream',
        key: generateKey(),
      })
    ).rejects.toBeInstanceOf(ContentTooLargeError);
  });

  test('preserves corruption, truncated transfer, and delimiter refusals', async () => {
    const key = generateKey();
    const container = await encryptRelic({
      content: bytes(CAPACITY * 3),
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });
    const corrupt = container.slice();
    corrupt[HEADER_BYTES + RS + 3] = corrupt[HEADER_BYTES + RS + 3]! ^ 1;
    const extra = new Uint8Array(container.length + 1);
    extra.set(container);
    const cases = [
      [corrupt, corrupt.length, DecryptFailedError],
      [
        container.subarray(0, container.length - 5),
        container.length,
        TransferIncompleteError,
      ],
      [
        container.subarray(0, container.length - RS),
        container.length - RS,
        TruncatedContainerError,
      ],
      [extra, extra.length, MalformedContainerError],
    ] as const;
    for (const [input, objectLength, error] of cases) {
      await expect(
        streamRelicContent(chunkStream(input, 32).stream, key, {
          objectLength,
          maxContentBytes: PLAINTEXT_CAP_BYTES,
          onContent() {},
        })
      ).rejects.toBeInstanceOf(error);
    }
  });

  test('sink rejection cancels transfer and propagates the original error', async () => {
    const key = generateKey();
    const container = await encryptRelic({
      content: bytes(CAPACITY * 6),
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });
    const tracker = chunkStream(container, 16);
    const failure = new Error('sink closed');
    let writes = 0;
    const result = streamRelicContent(tracker.stream, key, {
      objectLength: container.length,
      async onContent() {
        writes++;
        throw failure;
      },
    });
    expect(await result.catch((error) => error)).toBe(failure);
    expect(writes).toBe(1);
    expect(tracker.getCancels()).toBe(1);
  });

  test('rejects invalid maxContentBytes values instead of bypassing the cap', async () => {
    for (const limit of [NaN, Infinity, -1, 0.5]) {
      const tracker = chunkStream(new Uint8Array(100), 10);
      await expect(
        streamRelicContent(tracker.stream, generateKey(), {
          objectLength: 100,
          maxContentBytes: limit,
          onContent() {},
        })
      ).rejects.toBeInstanceOf(RangeError);
      expect(tracker.getPulledBytes()).toBeLessThanOrEqual(10);
    }
  });

  test('rejects oversized unauthenticated record headers, while the legacy opener still handles large records', async () => {
    const key = generateKey();
    const container = await encryptRelic({
      content: bytes(1),
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RECORD_SIZE + 1,
    });
    const options = { objectLength: container.length, onContent() {} };
    await expect(
      streamRelicContent(chunkStream(container, 1024).stream, key, options)
    ).rejects.toBeInstanceOf(MalformedContainerError);
    await expect(
      readRelicEnvelope(chunkStream(container, 1024).stream, key, options)
    ).rejects.toBeInstanceOf(MalformedContainerError);
    const opened = await openRelicStream(
      chunkStream(container, 1024).stream,
      key,
      options
    );
    expect(opened.content).toEqual(bytes(1));
  });

  test('authenticates record zero then cancels, exposing prefix even for wrong-key retry', async () => {
    const key = generateKey();
    const container = await encryptRelic({
      content: bytes(3 * CAPACITY),
      filename: 'a.txt',
      mimetype: 'text/plain',
      key,
      rs: RS,
    });
    const tracker = chunkStream(container, 16);
    const { envelope, prefix } = await readRelicEnvelope(tracker.stream, key, {
      objectLength: container.length,
    });
    expect(envelope.entries[0]?.length).toBe(3 * CAPACITY);
    expect(prefix).toEqual(container.subarray(0, HEADER_BYTES + RS));
    expect(tracker.getCancels()).toBe(1);
    expect(tracker.getPulledBytes()).toBeLessThanOrEqual(
      HEADER_BYTES + RS + 32
    );
    let rejectedPrefix: Uint8Array | undefined;
    const wrong = chunkStream(container, 16);
    await expect(
      readRelicEnvelope(wrong.stream, generateKey(), {
        objectLength: container.length,
        onPrefix: (value) => {
          rejectedPrefix = value;
        },
      })
    ).rejects.toBeInstanceOf(DecryptFailedError);
    expect(rejectedPrefix).toEqual(prefix);
    expect(wrong.getCancels()).toBe(1);
  });
});
