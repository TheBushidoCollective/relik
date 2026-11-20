import { expect, test } from 'bun:test';
import { encryptFolder } from '../src/folder-container.ts';
import {
  encryptFolderStream,
  streamFolderContent,
} from '../src/folder-stream.ts';
import { DecryptFailedError, TransferIncompleteError } from '../src/errors.ts';

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
