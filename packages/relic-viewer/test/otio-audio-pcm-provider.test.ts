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
  messages: Array<Record<string, unknown>> = [];
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }
  terminate() {}
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
