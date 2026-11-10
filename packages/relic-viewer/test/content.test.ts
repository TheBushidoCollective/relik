import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@relic/format';
import {
  CONTENT_BATCH_BYTES,
  CONTENT_HEAD_BYTES,
  CONTENT_TAIL_BYTES,
  ContentStoreError,
  createContentSink,
  contentFromBlob,
  contentFromBytes,
  DOCUMENT_RENDER_LIMIT_BYTES,
  MAX_CONTENT_READ_BYTES,
} from '../src/content.ts';

const contentSizes = [
  0,
  1,
  65_519,
  65_520,
  CONTENT_BATCH_BYTES - 1,
  CONTENT_BATCH_BYTES,
  CONTENT_BATCH_BYTES + 1,
  40 * 1024 * 1024,
];

async function checkNodeBlobMime(): Promise<void> {
  const source = await Bun.file(
    new URL('../src/content.ts', import.meta.url)
  ).text();
  const javascript = new Bun.Transpiler({
    loader: 'ts',
    target: 'node',
  }).transformSync(source);
  const fixture = fileURLToPath(
    new URL('./content-node-fixture.mjs', import.meta.url)
  );
  const child = Bun.spawn(['node', fixture, JSON.stringify(contentSizes)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  let timedOut = false;
  // A real-clock watchdog bounds a wedged external Node process.
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    child.stdin.write(javascript);
    await child.stdin.end();
    const [code, output, errors] = await Promise.all([
      child.exited,
      stdout,
      stderr,
    ]);
    if (timedOut || code !== 0) {
      throw new Error(
        `Node Blob MIME check ${timedOut ? 'timed out' : `exited ${code}`}\n${output}${errors}`
      );
    }
    expect(output).toBe('CONTENT_NODE_MIME_CASES=8\n');
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

describe('browser-backed content', () => {
  for (const size of contentSizes) {
    test(`preserves bytes across record and batch boundaries: ${size}`, async () => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 37 + (i >>> 13)) & 255;
      const sink = createContentSink(size);
      for (let offset = 0; offset < size; offset += 65_519) {
        sink.write(bytes.slice(offset, Math.min(size, offset + 65_519)));
      }
      const content = await sink.finish();
      expect(content.size).toBe(size);
      expect(content.head).toEqual(bytes.slice(0, CONTENT_HEAD_BYTES));
      expect(content.tail).toEqual(
        bytes.slice(Math.max(0, size - CONTENT_TAIL_BYTES))
      );
      const stored = new Uint8Array(
        await content.blob('application/octet-stream').arrayBuffer()
      );
      expect(sha256Hex(stored)).toBe(sha256Hex(bytes));
      const start = Math.max(0, size - 101);
      expect(await content.read(start, size)).toEqual(bytes.slice(start));
    });
  }

  test('preserves the exact Blob MIME type in Node', async () => {
    await checkNodeBlobMime();
  }, 35_000);

  test('enforces bounded reads and exact sink length', async () => {
    const sink = createContentSink(3);
    sink.write(new Uint8Array([1, 2]));
    await expect(sink.finish()).rejects.toThrow(RangeError);
    expect(() => sink.write(new Uint8Array([3, 4]))).toThrow(RangeError);
    const content = contentFromBytes(new Uint8Array([1, 2, 3]));
    expect(await content.readWhole(2)).toBeUndefined();
    expect(await content.readWhole(3)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(content.read(-1, 1)).rejects.toThrow(RangeError);
    await expect(content.read(0, MAX_CONTENT_READ_BYTES + 1)).rejects.toThrow(
      RangeError
    );
    await expect(
      content.readWhole(DOCUMENT_RENDER_LIMIT_BYTES + 1)
    ).rejects.toThrow(RangeError);
  });

  test('surfaces unreadable browser storage without misclassifying it as corrupt ciphertext', async () => {
    const broken = {
      size: 1,
      slice: () => ({
        size: 1,
        arrayBuffer: async () => {
          throw new Error('storage failed');
        },
      }),
    } as unknown as Blob;
    await expect(contentFromBlob(broken)).rejects.toBeInstanceOf(
      ContentStoreError
    );
  });
});
