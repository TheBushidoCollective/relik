import { describe, expect, test } from 'bun:test';
import { encryptRelic, openRelic } from '../src/container.ts';
import type { Envelope } from '../src/envelope.ts';
import {
  ContentTooLargeError,
  DecryptFailedError,
  MalformedContainerError,
  TransferIncompleteError,
} from '../src/errors.ts';
import { generateKey } from '../src/fragment.ts';
import { HEADER_BYTES, RECORD_SIZE, recordCapacity } from '../src/rfc8188.ts';
import { type StreamOpenProgress, openRelicStream } from '../src/stream.ts';

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
