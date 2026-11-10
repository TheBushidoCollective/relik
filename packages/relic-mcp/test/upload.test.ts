import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  contentDigest,
  type PublishDeps,
  PublishError,
  putContainer,
} from '../src/publish.ts';

async function runNodeUploadScenario(scenario: string): Promise<void> {
  const source = await Bun.file(
    new URL('../src/upload.ts', import.meta.url)
  ).text();
  const javascript = new Bun.Transpiler({
    loader: 'ts',
    target: 'node',
  }).transformSync(source);
  const fixture = fileURLToPath(
    new URL('./upload-node-fixture.mjs', import.meta.url)
  );
  const child = Bun.spawn(['node', fixture, scenario], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  let timedOut = false;
  // Socket timeouts use the real clock; this watchdog kills a wedged Node child.
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 20_000);
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
        `Node upload scenario ${scenario} ${timedOut ? 'timed out' : `exited ${code}`}\n${output}${errors}`
      );
    }
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

describe('object upload', () => {
  test('a slow, active upload can outlast the idle timeout and carries the signed length', async () => {
    await runNodeUploadScenario('slowActive');
  }, 25_000);

  test('a stalled upload rejects at the idle timeout and closes the connection', async () => {
    await runNodeUploadScenario('stalledUpload');
  }, 25_000);

  test('surfaces an early server refusal rather than continuing to send', async () => {
    await runNodeUploadScenario('earlyRefusal');
  }, 25_000);

  test('a stalled success response rejects at the idle timeout and closes the connection', async () => {
    await runNodeUploadScenario('stalledResponse');
  }, 25_000);

  test('rejects timeouts that Node would clamp to one millisecond', async () => {
    await runNodeUploadScenario('timeoutValidation');
  }, 25_000);

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
