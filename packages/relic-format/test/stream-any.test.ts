import { describe, expect, test } from 'bun:test';
import { encryptRelic } from '../src/container.ts';
import { DecryptFailedError, TransferIncompleteError } from '../src/errors.ts';
import {
  encryptFolder,
  UnsupportedEnvelopeVersionError,
} from '../src/folder-container.ts';
import { decodeManifest } from '../src/multi.ts';
import {
  deriveKeys,
  encodeHeader,
  encryptRecord,
  HEADER_BYTES,
  RECORD_SIZE,
  recordCapacity,
} from '../src/rfc8188.ts';
import { streamAnyRelicContent } from '../src/stream-any.ts';
import { streamRelicContent } from '../src/stream.ts';

const key = new Uint8Array(16).fill(7);
const text = new TextEncoder();
const source = (bytes: Uint8Array) => new Blob([bytes as BlobPart]).stream();
async function open(bytes: Uint8Array, objectLength = bytes.length) {
  const parts: Uint8Array[] = [];
  const envelope = await streamAnyRelicContent(source(bytes), key, {
    objectLength,
    onContent: (chunk) => {
      parts.push(chunk);
    },
  });
  return {
    envelope,
    content: new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()),
  };
}

describe('dual-layout streaming', () => {
  test('v1 matches the original streaming path', async () => {
    const bytes = await encryptRelic({
      key,
      filename: 'a.txt',
      mimetype: 'text/plain',
      content: text.encode('hello'),
    });
    const expected: Uint8Array[] = [];
    const envelope = await streamRelicContent(source(bytes), key, {
      objectLength: bytes.length,
      onContent: (chunk) => {
        expected.push(chunk);
      },
    });
    const actual = await open(bytes);
    expect(actual.envelope).toEqual(envelope);
    expect(actual.content).toEqual(
      new Uint8Array(await new Blob(expected as BlobPart[]).arrayBuffer())
    );
  });
  test('folder yields validated manifest and original entries', async () => {
    const bytes = await encryptFolder({
      key,
      name: 'folder',
      defaultIndex: 0,
      entries: [
        {
          path: 'README.md',
          mimetype: 'text/markdown',
          bytes: text.encode('# Hello'),
        },
        {
          path: 'data/a.json',
          mimetype: 'application/json',
          bytes: text.encode('{"ok":true}'),
        },
      ],
    });
    const result = await open(bytes);
    if ('entries' in result.envelope) throw new Error('expected folder');
    const manifest = decodeManifest(
      result.content.subarray(0, result.envelope.manifestLength),
      result.envelope
    );
    expect(
      manifest.entries.map((e) =>
        new TextDecoder().decode(
          result.content.subarray(e.offset, e.offset + e.length)
        )
      )
    ).toEqual(['# Hello', '{"ok":true}']);
  });
  test('tampered and truncated records are refused', async () => {
    const bytes = await encryptFolder({
      key,
      name: '',
      defaultIndex: 0,
      entries: [{ path: 'a', mimetype: '', bytes: text.encode('content') }],
    });
    const tampered = bytes.slice();
    tampered[HEADER_BYTES + 1] = tampered[HEADER_BYTES + 1]! ^ 1;
    await expect(open(tampered)).rejects.toBeInstanceOf(DecryptFailedError);
    await expect(
      open(bytes.subarray(0, bytes.length - 1), bytes.length)
    ).rejects.toBeInstanceOf(TransferIncompleteError);
  });
  test('future envelope version has a named refusal', async () => {
    const salt = new Uint8Array(16);
    const record = await encryptRecord(
      await deriveKeys(key, salt),
      0,
      new Uint8Array([3, 0]),
      false,
      recordCapacity(RECORD_SIZE)
    );
    const bytes = new Uint8Array(HEADER_BYTES + record.length);
    bytes.set(encodeHeader(salt, RECORD_SIZE));
    bytes.set(record, HEADER_BYTES);
    await expect(open(bytes)).rejects.toBeInstanceOf(
      UnsupportedEnvelopeVersionError
    );
  });
});
