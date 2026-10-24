import { describe, expect, test } from 'bun:test';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';
import {
  createOtioVideoTimingScheduler,
  type OtioVideoTimingWorkerLike,
} from '../src/otio-video-timing-scheduler.ts';

class FakeWorker {
  readonly messages: unknown[] = [];
  readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly errorListeners = new Set<(event: Event) => void>();
  readonly messageErrorListeners = new Set<(event: Event) => void>();
  terminated = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else if (type === 'error') {
      this.errorListeners.add(listener as (event: Event) => void);
    } else {
      this.messageErrorListeners.add(listener as (event: Event) => void);
    }
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else if (type === 'error') {
      this.errorListeners.delete(listener as (event: Event) => void);
    } else {
      this.messageErrorListeners.delete(listener as (event: Event) => void);
    }
  }

  result(id: number, timing: OtioVideoTiming): void {
    const event = {
      data: { type: 'result', id, timing },
    } as MessageEvent<unknown>;
    for (const listener of this.messageListeners) listener(event);
  }
}

function workerFactory(workers: FakeWorker[]): () => OtioVideoTimingWorkerLike {
  return () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as OtioVideoTimingWorkerLike;
  };
}

function certified(): Extract<OtioVideoTiming, { kind: 'windows' }> {
  return {
    kind: 'windows',
    starts: new Float64Array([0]),
    ends: new Float64Array([1]),
  };
}

describe('OTIO timing worker scheduler', () => {
  test('terminates each completed worker and removes every listener', async () => {
    const workers: FakeWorker[] = [];
    const scheduler = createOtioVideoTimingScheduler({
      createWorker: workerFactory(workers),
    });

    const result = scheduler.read(new Blob(['first']), 'video/mp4');
    const worker = workers[0];
    if (!worker) throw new Error('scheduler did not create a worker');
    worker.result(1, certified());

    await expect(result).resolves.toEqual(certified());
    expect(worker.terminated).toBe(1);
    expect(worker.messageListeners.size).toBe(0);
    expect(worker.errorListeners.size).toBe(0);
    expect(worker.messageErrorListeners.size).toBe(0);
  });

  test('cancels an active job by terminating its isolated worker', async () => {
    const workers: FakeWorker[] = [];
    const scheduler = createOtioVideoTimingScheduler({
      createWorker: workerFactory(workers),
    });
    const controller = new AbortController();
    const result = scheduler.read(
      new Blob(['abort']),
      'video/webm',
      controller.signal
    );
    const worker = workers[0];
    if (!worker) throw new Error('scheduler did not create a worker');

    controller.abort();

    await expect(result).resolves.toEqual({
      kind: 'unknown',
      reason: 'cancelled',
    });
    expect(worker.terminated).toBe(1);
  });

  test('removes an aborted queued job without starving the later queue', async () => {
    const workers: FakeWorker[] = [];
    const scheduler = createOtioVideoTimingScheduler({
      createWorker: workerFactory(workers),
    });
    const queuedController = new AbortController();
    const active = scheduler.read(new Blob(['active']), 'video/mp4');
    const queued = scheduler.read(
      new Blob(['queued']),
      'video/mp4',
      queuedController.signal
    );
    const later = scheduler.read(new Blob(['later']), 'video/mp4');
    const first = workers[0];
    if (!first) throw new Error('scheduler did not create a worker');

    queuedController.abort();
    first.result(1, certified());

    await expect(queued).resolves.toEqual({
      kind: 'unknown',
      reason: 'cancelled',
    });
    await expect(active).resolves.toEqual(certified());
    const second = workers[1];
    if (!second) throw new Error('scheduler did not advance queued work');
    second.result(3, certified());
    await expect(later).resolves.toEqual(certified());
  });

  test('enforces a bounded queue rather than accumulating work', async () => {
    const workers: FakeWorker[] = [];
    const scheduler = createOtioVideoTimingScheduler({
      createWorker: workerFactory(workers),
      maxQueuedJobs: 1,
    });
    const active = scheduler.read(new Blob(['active']), 'video/mp4');
    const queued = scheduler.read(new Blob(['queued']), 'video/mp4');
    const overflow = scheduler.read(new Blob(['overflow']), 'video/mp4');

    await expect(overflow).resolves.toEqual({
      kind: 'unknown',
      reason: 'worker-budget',
    });
    const first = workers[0];
    if (!first) throw new Error('scheduler did not create a worker');
    first.result(1, certified());
    await expect(active).resolves.toEqual(certified());

    const second = workers[1];
    if (!second) throw new Error('scheduler did not advance queued work');
    second.result(2, certified());
    await expect(queued).resolves.toEqual(certified());
  });

  test('terminates a deadline-exceeded worker', async () => {
    const workers: FakeWorker[] = [];
    const scheduler = createOtioVideoTimingScheduler({
      createWorker: workerFactory(workers),
      deadlineMs: 1,
    });
    const result = scheduler.read(new Blob(['slow']), 'video/webm');

    await expect(result).resolves.toEqual({
      kind: 'unknown',
      reason: 'timeout',
    });
    const worker = workers[0];
    if (!worker) throw new Error('scheduler did not create a worker');
    expect(worker.terminated).toBe(1);
  });
});
