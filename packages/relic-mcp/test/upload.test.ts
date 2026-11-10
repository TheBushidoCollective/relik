import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  contentDigest,
  type PublishDeps,
  PublishError,
  putContainer,
} from '../src/publish.ts';
import { createNodeUploader } from '../src/upload.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}/signed?token=test`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('object upload', () => {
  test('a slow, active upload can outlast the idle timeout and carries the signed length', async () => {
    const body = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < body.length; i += 4096) body[i] = i % 251;
    const expected = createHash('sha256').update(body).digest('hex');
    let received = 0;
    let contentLength: string | undefined;
    let actual = '';
    const server = createServer((req, res) => {
      contentLength = req.headers['content-length'];
      const hash = createHash('sha256');
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        hash.update(chunk);
        // Real socket idle behavior is the subject, so fake clocks cannot
        // stand in for the paced network reads.
        req.pause();
        setTimeout(() => req.resume(), 15);
      });
      req.on('end', () => {
        actual = hash.digest('hex');
        res.writeHead(200).end();
      });
    });
    const url = await listen(server);
    try {
      const idleMs = 600;
      const start = Date.now();
      const result = await createNodeUploader(idleMs)(
        url,
        { 'content-length': String(body.length) },
        body
      );
      expect(Date.now() - start).toBeGreaterThan(idleMs);
      expect(result.status).toBe(200);
      expect(received).toBe(body.length);
      expect(contentLength).toBe(String(body.length));
      expect(actual).toBe(expected);
    } finally {
      await close(server);
    }
  }, 20_000);

  test('a stalled upload rejects at the idle timeout', async () => {
    const server = createServer((req: IncomingMessage) => req.pause());
    const url = await listen(server);
    try {
      const body = new Uint8Array(32 * 1024 * 1024);
      await expect(
        createNodeUploader(150)(
          url,
          { 'content-length': String(body.length) },
          body
        )
      ).rejects.toThrow('upload idle');
    } finally {
      await close(server);
    }
  }, 10_000);

  test('surfaces an early server refusal rather than continuing to send', async () => {
    const server = createServer((_req, res) => res.writeHead(403).end());
    const url = await listen(server);
    try {
      const body = new Uint8Array(8 * 1024 * 1024);
      expect(
        await createNodeUploader(1_000)(
          url,
          { 'content-length': String(body.length) },
          body
        )
      ).toEqual({ status: 403 });
    } finally {
      await close(server);
    }
  });

  test('wraps transport errors and non-success responses as upload_failed', async () => {
    const failing = {
      upload: async () => {
        throw new Error('socket stalled');
      },
    } as unknown as PublishDeps;
    await expect(
      putContainer(
        failing,
        'relic-id',
        'https://storage.invalid',
        new Uint8Array(3)
      )
    ).rejects.toMatchObject({
      code: 'upload_failed',
      details: { relic_id: 'relic-id', cause: 'socket stalled' },
    });
    const sensitiveUrl = 'https://storage.invalid/put?signature=secret';
    const leaking = {
      upload: async () => {
        throw new Error(`failed to upload to ${sensitiveUrl}`);
      },
    } as unknown as PublishDeps;
    await expect(
      putContainer(leaking, 'relic-id', sensitiveUrl, new Uint8Array(3))
    ).rejects.toMatchObject({
      code: 'upload_failed',
      details: { cause: 'failed to upload to [signed upload URL]' },
    });
    const refused = {
      upload: async () => ({ status: 503 }),
    } as unknown as PublishDeps;
    try {
      await putContainer(
        refused,
        'relic-id',
        'https://storage.invalid',
        new Uint8Array(3)
      );
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError);
      expect(error).toMatchObject({
        code: 'upload_failed',
        details: { relic_id: 'relic-id', status: 503 },
      });
    }
  });
});

describe('content digest compatibility', () => {
  test('matches the original header, NUL and content byte sequence', async () => {
    const original = new Uint8Array([255, 0, 1, 2, 127, 128, 254, 99]);
    const samples = [original.subarray(1, 7), new Uint8Array(0)];
    for (const content of samples) {
      const filename = '剪輯\0".otio';
      const title = 'Café 🎞';
      const header = new TextEncoder().encode(
        `${JSON.stringify([filename, title])}\0`
      );
      const material = new Uint8Array(header.length + content.length);
      material.set(header);
      material.set(content, header.length);
      const oldDigest = await crypto.subtle.digest('SHA-256', material);
      const expected = Buffer.from(oldDigest).toString('hex');
      expect(await contentDigest({ content, filename, title })).toBe(expected);
    }
  });
});
