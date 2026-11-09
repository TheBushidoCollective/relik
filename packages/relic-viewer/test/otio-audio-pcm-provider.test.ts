import { expect, test } from 'bun:test';
import { OtioPcmBudget, OtioPcmProvider } from '../src/otio-audio-pcm';
import {
  OTIO_PCM_MAX_BYTES,
  OTIO_PCM_PULL_SCRATCH_BYTES,
} from '../src/otio-audio-pcm-protocol';
import type { WavePcmHeader } from '../src/otio-wave-pcm';

const header: WavePcmHeader = {
  format: 'pcm16',
  channels: 1,
  sampleRate: 48000,
  blockAlign: 2,
  dataOffset: 44,
  dataBytes: 96000,
  totalFrames: 48000,
};
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  messages: Array<Record<string, unknown>> = [];
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: Record<string, unknown>) {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

test('worker requests are serialized, credited and generation-scoped', async () => {
  const worker = new FakeWorker(),
    budget = new OtioPcmBudget();
  const provider = new OtioPcmProvider(4, budget, worker as unknown as Worker);
  const opening = provider.open('a', new Blob([]), header);
  await Promise.resolve();
  const open = worker.messages[0]!;
  worker.reply({
    protocol: 1,
    generation: 4,
    streamId: 'a',
    requestId: open.requestId,
    kind: 'ready',
    header,
  });
  await opening;
  const one = provider.pull('a', 0, 20),
    two = provider.pull('a', 20, 20);
  await Promise.resolve();
  const request = worker.messages[1]!;
  expect(request.kind).toBe('pull');
  expect(worker.messages.length).toBe(2);
  worker.reply({
    protocol: 1,
    generation: 3,
    streamId: 'a',
    requestId: request.requestId,
    kind: 'pcm',
    firstFrame: 0,
    frameCount: 20,
    planes: [new Float32Array(20)],
  });
  expect(budget.usedBytes).toBeGreaterThan(80);
  worker.reply({
    protocol: 1,
    generation: 4,
    streamId: 'a',
    requestId: request.requestId,
    kind: 'pcm',
    firstFrame: 0,
    frameCount: 20,
    planes: [new Float32Array(20)],
  });
  const block = await one;
  provider.release(block.planes);
  await Promise.resolve();
  const next = worker.messages[2]!;
  expect(next.firstFrame).toBe(20);
  provider.cancel('a');
  expect(worker.terminated).toBe(true);
  worker.reply({
    protocol: 1,
    generation: 4,
    streamId: 'a',
    requestId: next.requestId,
    kind: 'failed',
    reason: 'cancelled',
  });
  await expect(two).rejects.toThrow();
  expect(budget.usedBytes).toBe(0);
  provider.dispose();
});

test('reserves worst-case bridged read before sending a packet request', async () => {
  const worker = new FakeWorker(),
    budget = new OtioPcmBudget();
  const provider = new OtioPcmProvider(5, budget, worker as unknown as Worker);
  const opening = provider.open('a', new Blob([]), header);
  await Promise.resolve();
  worker.reply({
    protocol: 1,
    kind: 'ready',
    generation: 5,
    streamId: 'a',
    requestId: worker.messages[0]!.requestId,
    header,
  });
  await opening;
  const occupied = OTIO_PCM_MAX_BYTES - OTIO_PCM_PULL_SCRATCH_BYTES + 1;
  budget.reserveBytes(occupied);
  await expect(provider.pull('a', 16384, 20)).rejects.toThrow('budget');
  expect(worker.messages).toHaveLength(1);
  budget.releaseBytes(occupied);
  provider.dispose();
});

test('malformed and nonfinite matching PCM responses reject and return scratch credits', async () => {
  for (const planes of [
    null,
    [new Float32Array([NaN])],
    [new Float32Array(2).subarray(0, 1)],
  ]) {
    const worker = new FakeWorker(),
      budget = new OtioPcmBudget();
    const provider = new OtioPcmProvider(
      7,
      budget,
      worker as unknown as Worker
    );
    const opening = provider.open('a', new Blob([]), header);
    await Promise.resolve();
    worker.reply({
      protocol: 1,
      kind: 'ready',
      generation: 7,
      streamId: 'a',
      requestId: worker.messages[0]!.requestId,
      header,
    });
    await opening;
    const pull = provider.pull('a', 0, 1);
    await Promise.resolve();
    worker.reply({
      protocol: 1,
      kind: 'pcm',
      generation: 7,
      streamId: 'a',
      requestId: worker.messages[1]!.requestId,
      firstFrame: 0,
      frameCount: 1,
      planes,
    });
    await expect(pull).rejects.toThrow('Invalid PCM worker response');
    expect(budget.usedBytes).toBe(0);
    provider.dispose();
  }
});

test('in-flight open cancellation terminates worker and settles without an acknowledgement', async () => {
  const worker = new FakeWorker(),
    budget = new OtioPcmBudget();
  const provider = new OtioPcmProvider(9, budget, worker as unknown as Worker);
  const opening = provider.open('a', new Blob([]), header);
  await Promise.resolve();
  provider.cancel('a');
  expect(worker.terminated).toBe(true);
  await expect(opening).rejects.toThrow('cancelled');
  expect(budget.usedBytes).toBe(0);
});

test('retained planes remain charged after provider disposal until released', async () => {
  const worker = new FakeWorker(),
    budget = new OtioPcmBudget();
  const provider = new OtioPcmProvider(8, budget, worker as unknown as Worker);
  const opening = provider.open('a', new Blob([]), header);
  await Promise.resolve();
  worker.reply({
    protocol: 1,
    kind: 'ready',
    generation: 8,
    streamId: 'a',
    requestId: worker.messages[0]!.requestId,
    header,
  });
  await opening;
  const pull = provider.pull('a', 0, 1);
  await Promise.resolve();
  worker.reply({
    protocol: 1,
    kind: 'pcm',
    generation: 8,
    streamId: 'a',
    requestId: worker.messages[1]!.requestId,
    firstFrame: 0,
    frameCount: 1,
    planes: [new Float32Array(1)],
  });
  const block = await pull;
  provider.dispose();
  expect(budget.usedBytes).toBe(4);
  provider.release(block.planes);
  expect(budget.usedBytes).toBe(0);
});

test('matching malformed envelope, messageerror and post failure settle requests', async () => {
  for (const mode of ['envelope', 'messageerror', 'post'] as const) {
    const worker = new FakeWorker(),
      budget = new OtioPcmBudget();
    if (mode === 'post')
      worker.postMessage = () => {
        throw new Error('post');
      };
    const provider = new OtioPcmProvider(
      11,
      budget,
      worker as unknown as Worker
    );
    const opening = provider.open('a', new Blob([]), header);
    await Promise.resolve();
    if (mode === 'envelope')
      worker.reply({ requestId: worker.messages[0]!.requestId, kind: 'ready' });
    if (mode === 'messageerror') worker.onmessageerror?.();
    await expect(opening).rejects.toThrow();
    expect(worker.terminated).toBe(true);
    expect(budget.usedBytes).toBe(0);
  }
});

test('zero-length EOF pull does not issue a worker request or charge the budget', async () => {
  const worker = new FakeWorker(),
    budget = new OtioPcmBudget();
  const provider = new OtioPcmProvider(12, budget, worker as unknown as Worker);
  const opening = provider.open('a', new Blob([]), header);
  await Promise.resolve();
  worker.reply({
    protocol: 1,
    kind: 'ready',
    generation: 12,
    streamId: 'a',
    requestId: worker.messages[0]!.requestId,
    header,
  });
  await opening;
  const block = await provider.pull('a', header.totalFrames, 0);
  expect(block.frameCount).toBe(0);
  expect(block.planes).toEqual([]);
  expect(worker.messages).toHaveLength(1);
  expect(budget.usedBytes).toBe(0);
  provider.dispose();
});
