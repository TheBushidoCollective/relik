import { expect, test } from 'bun:test';
import { encryptFolder } from '../src/folder-container.ts';
import { encryptedSize } from '../src/container.ts';
import {
  folderPlaintext,
  EntrySizeMismatchError,
} from '../src/folder-container.ts';
import {
  encryptFolderStream,
  streamFolderContent,
} from '../src/folder-stream.ts';
import { DecryptFailedError, TransferIncompleteError } from '../src/errors.ts';
import { decodeManifest } from '../src/multi.ts';
import { MalformedContainerError } from '../src/errors.ts';

const input = {
  name: 'test',
  defaultIndex: 0,
  entries: [
    {
      path: 'large.bin',
      mimetype: 'application/octet-stream',
      bytes: new Uint8Array(150000).fill(37),
    },
  ],
  key: new Uint8Array(16).fill(5),
  salt: new Uint8Array(16).fill(6),
};
function source(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 113)
        c.enqueue(bytes.subarray(i, i + 113));
      c.close();
    },
  });
}
test('stream output is identical and decryption receives authenticated content', async () => {
  const bytes = await encryptFolder(input);
  const streamed = new Uint8Array(
    await new Response(encryptFolderStream(input)).arrayBuffer()
  );
  expect<Uint8Array>(streamed).toEqual(bytes);
  let length = 0;
  const header = await streamFolderContent(source(bytes), input.key, {
    objectLength: bytes.length,
    onContent(chunk) {
      length += chunk.length;
    },
  });
  expect(length).toBe(header.contentLength);
  expect(header.entryCount).toBe(1);
});

test('preserves original manifest bytes including non-UTF-8 MIME octets', async () => {
  const original = folderPlaintext(input);
  const manifest = (original.parts[0] as Uint8Array).slice();
  const mimeStart = 4 + 2 + new TextEncoder().encode('large.bin').length + 2;
  manifest[mimeStart] = 0xff;
  const parsed = decodeManifest(manifest, original.header);
  const output = new Uint8Array(
    await new Response(
      encryptFolderStream({
        ...input,
        originalManifest: manifest,
        entries: [
          { ...input.entries[0]!, mimetype: parsed.entries[0]!.mimetype },
        ],
      })
    ).arrayBuffer()
  );
  const chunks: Uint8Array[] = [];
  await streamFolderContent(source(output), input.key, {
    objectLength: output.length,
    onContent(chunk) {
      chunks.push(chunk);
    },
  });
  const plaintext = new Uint8Array(
    await new Blob(chunks as BlobPart[]).arrayBuffer()
  );
  expect(plaintext.subarray(0, manifest.length)).toEqual(manifest);
  expect(plaintext.subarray(manifest.length)).toEqual(input.entries[0]!.bytes);
  expect(() =>
    encryptFolderStream({ ...input, originalManifest: manifest })
  ).toThrow(MalformedContainerError);
});
test('refuses truncated and tampered mid-stream records by error type', async () => {
  const bytes = await encryptFolder(input);
  await expect(
    streamFolderContent(
      source(bytes.subarray(0, bytes.length - 10)),
      input.key,
      { objectLength: bytes.length, onContent() {} }
    )
  ).rejects.toBeInstanceOf(TransferIncompleteError);
  const corrupt = bytes.slice();
  corrupt[70000] = corrupt[70000]! ^ 1;
  await expect(
    streamFolderContent(source(corrupt), input.key, {
      objectLength: corrupt.length,
      onContent() {},
    })
  ).rejects.toBeInstanceOf(DecryptFailedError);
});

test('streams generator-backed entries without materializing the folder', async () => {
  const size = 3 * 1024 * 1024;
  let maxSourceChunk = 0;
  let maxCipherChunk = 0;
  let maxPlainChunk = 0;
  const entries = [1, 2, 3].map((value) => ({
    path: `${value}.bin`,
    mimetype: 'application/octet-stream',
    bytes: {
      size,
      async *chunks() {
        for (let i = 0; i < 3; i++) {
          const chunk = new Uint8Array(1024 * 1024).fill(value);
          maxSourceChunk = Math.max(maxSourceChunk, chunk.length);
          yield chunk;
        }
      },
    },
  }));
  const options = { ...input, entries };
  const { header, headerBytes } = folderPlaintext(options);
  const stream = encryptFolderStream(options);
  const monitored = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        maxCipherChunk = Math.max(maxCipherChunk, chunk.length);
        controller.enqueue(chunk);
      },
    })
  );
  let position = 0;
  await streamFolderContent(monitored, options.key, {
    objectLength: encryptedSize(
      header.contentLength,
      undefined,
      headerBytes.length
    ),
    onContent(chunk) {
      maxPlainChunk = Math.max(maxPlainChunk, chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const offset = position + i - header.manifestLength;
        if (offset >= 0 && chunk[i] !== Math.floor(offset / size) + 1)
          throw new Error(`incorrect byte at ${offset}`);
      }
      position += chunk.length;
    },
  });
  expect(position).toBe(header.contentLength);
  expect(maxSourceChunk).toBe(1024 * 1024);
  expect(maxCipherChunk).toBeLessThan(header.contentLength);
  expect(maxPlainChunk).toBeLessThan(header.contentLength);
});

test.each([2, 4])(
  'refuses a source yielding %i bytes when it declared 3',
  async (actual) => {
    const entries = [
      {
        path: 'mismatch',
        mimetype: '',
        bytes: {
          size: 3,
          async *chunks() {
            yield new Uint8Array(actual);
          },
        },
      },
    ];
    const stream = encryptFolderStream({ ...input, entries });
    try {
      await new Response(stream).arrayBuffer();
      throw new Error('expected source mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(EntrySizeMismatchError);
      expect((error as EntrySizeMismatchError).code).toBe(
        'entry-size-mismatch'
      );
    }
  }
);
