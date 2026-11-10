import { describe, expect, test } from 'bun:test';
import { OtioPcmBudget, OtioPcmScheduler } from '../src/otio-audio-pcm';

class FakeNode {
  connections: FakeNode[] = [];
  connect(node: FakeNode) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.connections = [];
  }
}
class FakeSource extends FakeNode {
  buffer: unknown;
  onended: (() => void) | null = null;
  started = -1;
  stoppedAt: number | undefined;
  start(time: number) {
    this.started = time;
  }
  stop(time?: number) {
    this.stoppedAt = time;
  }
}
class FakeGain extends FakeNode {
  calls: Array<[string, number, number]> = [];
  gain = {
    value: 1,
    setValueAtTime: (value: number, time: number) =>
      this.calls.push(['set', value, time]),
    linearRampToValueAtTime: (value: number, time: number) =>
      this.calls.push(['ramp', value, time]),
  };
}
class FakeContext {
  sampleRate = 48000;
  currentTime = 1;
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  createBuffer(_channels: number, _frames: number, _rate: number) {
    return { copyToChannel() {} };
  }
  createBufferSource() {
    const node = new FakeSource();
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
}

describe('bounded PCM graph', () => {
  test('owns chained factors, exact frame start and releases on completion', () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget(),
      master = new FakeNode();
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      master as unknown as AudioNode,
      3,
      budget
    );
    expect(
      scheduler.schedule({
        generation: 3,
        firstContextFrame: 48200,
        planes: [new Float32Array(480)],
        gainFactors: [
          { startFrame: 48000, endFrame: 48528, startGain: 0, endGain: 1 },
          { startFrame: 48000, endFrame: 48528, startGain: 1, endGain: 0 },
        ],
      })
    ).toBe(48680);
    expect(context.sources[0]!.started).toBe(48200 / 48000);
    expect(context.sources[0]!.connections[0]).toBe(context.gains[0]);
    expect(context.gains[0]!.connections[0]).toBe(context.gains[1]);
    expect(context.gains[1]!.connections[0]).toBe(master);
    expect(budget.usedNodes).toBe(3);
    expect(budget.usedBytes).toBe(1920);
    context.sources[0]!.onended?.();
    expect(budget.usedNodes).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });
  test('primes gain before rounded frame-time automation', () => {
    const context = new FakeContext();
    context.currentTime = 2;
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1
    );
    const frame = 112576;
    expect((frame / 48000) * 48000).toBeGreaterThan(frame);
    scheduler.schedule({
      generation: 1,
      firstContextFrame: frame,
      planes: [new Float32Array(480)],
      gainFactors: [
        {
          startFrame: frame - 100,
          endFrame: frame + 100,
          startGain: 0,
          endGain: 1,
        },
      ],
    });
    const gain = context.gains[0]!;
    expect(gain.gain.value).toBe(0.5);
    expect(gain.calls[0]).toEqual(['set', 0.5, frame / 48000]);
    scheduler.dispose();
  });
  test('rejects stale, late and outside-horizon sources without consuming credits', () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget();
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1,
      budget
    );
    const request = {
      generation: 1,
      firstContextFrame: 48128,
      planes: [new Float32Array(480)],
      gainFactors: [],
    };
    expect(() => scheduler.schedule({ ...request, generation: 0 })).toThrow();
    expect(() =>
      scheduler.schedule({ ...request, firstContextFrame: 47999 })
    ).toThrow();
    expect(() =>
      scheduler.schedule({ ...request, firstContextFrame: 72000 })
    ).toThrow();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
    scheduler.schedule(request);
    scheduler.cancel();
    expect(budget.usedBytes).toBe(1920);
    expect(budget.usedNodes).toBe(1);
    context.sources[context.sources.length - 1]!.onended?.();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
    expect(() => scheduler.schedule(request)).toThrow();
  });
  test('rejects a deadline that expires while graph construction runs', () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget();
    context.createBuffer = () => {
      context.currentTime += 0.01;
      return { copyToChannel() {} };
    };
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1,
      budget
    );
    expect(() =>
      scheduler.schedule({
        generation: 1,
        firstContextFrame: 48400,
        planes: [new Float32Array(480)],
        gainFactors: [],
      })
    ).toThrow('deadline');
    expect(context.sources[0]!.started).toBe(-1);
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });
  test('drains at one frame and retains credits until each generation ends', async () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget();
    const master = new FakeNode() as unknown as AudioNode;
    const old = new OtioPcmScheduler(
      context as unknown as AudioContext,
      master,
      1,
      budget
    );
    const next = new OtioPcmScheduler(
      context as unknown as AudioContext,
      master,
      2,
      budget
    );
    const request = {
      firstContextFrame: 48200,
      planes: [new Float32Array(480)],
      gainFactors: [],
    };
    old.schedule({ ...request, generation: 1 });
    next.schedule({ ...request, generation: 2 });
    const drain = old.stopAtFrame(48300);
    expect(old.stopAtFrame(48300)).toBe(drain);
    expect(() => old.stopAtFrame(48301)).toThrow('Conflicting');
    let ended = false;
    void drain.ended.then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    expect(context.sources[0]!.stoppedAt).toBe(48300 / 48000);
    expect(budget.usedNodes).toBe(2);
    expect(budget.usedBytes).toBe(3840);
    expect(() => old.schedule({ ...request, generation: 1 })).toThrow();
    const staleEnded = context.sources[0]!.onended!;
    staleEnded();
    await drain.ended;
    expect(ended).toBe(true);
    expect(budget.usedNodes).toBe(1);
    staleEnded();
    expect(budget.usedBytes).toBe(1920);
    next.dispose();
    expect(budget.usedNodes).toBe(1);
    context.sources[1]!.onended?.();
    expect(budget.usedNodes).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });
  test('rejects expired stop and leaves the source owned', () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget();
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1,
      budget
    );
    scheduler.schedule({
      generation: 1,
      firstContextFrame: 48200,
      planes: [new Float32Array(480)],
      gainFactors: [],
    });
    expect(() => scheduler.stopAtFrame(48127)).toThrow('deadline');
    expect(budget.usedNodes).toBe(1);
    scheduler.dispose();
    expect(budget.usedNodes).toBe(1);
    context.sources[0]!.onended?.();
    expect(budget.usedNodes).toBe(0);
  });
  test('confirmed context closure releases canceled sources without ended, exactly once', () => {
    const context = new FakeContext();
    const budget = new OtioPcmBudget();
    let retired = 0;
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1,
      budget,
      () => {
        retired++;
      }
    );
    scheduler.schedule({
      generation: 1,
      firstContextFrame: 48200,
      planes: [new Float32Array(480)],
      gainFactors: [
        { startFrame: 48200, endFrame: 48680, startGain: 0, endGain: 1 },
      ],
    });
    const lateEnded = context.sources[0]!.onended!;
    scheduler.dispose();
    expect(budget.usedNodes).toBe(2);
    expect(budget.usedBytes).toBe(1920);
    expect(retired).toBe(0);
    scheduler.contextClosed();
    scheduler.contextClosed();
    lateEnded();
    expect(budget.usedNodes).toBe(0);
    expect(budget.usedBytes).toBe(0);
    expect(retired).toBe(1);
  });

  test('prepared nodes retire immediately before start, but started nodes await ended', () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget();
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1,
      budget
    );
    const prepared = scheduler.prepare({
      generation: 1,
      planes: [new Float32Array(64)],
      gainFactorCount: 1,
    });
    expect(context.sources[0]!.started).toBe(-1);
    expect(budget.usedNodes).toBe(2);
    prepared.cancel();
    expect(budget.usedNodes).toBe(0);
    const active = scheduler.prepare({
      generation: 1,
      planes: [new Float32Array(64)],
      gainFactorCount: 0,
    });
    active.start(48200, []);
    active.cancel();
    expect(budget.usedNodes).toBe(1);
    context.sources[1]!.onended?.();
    expect(budget.usedNodes).toBe(0);
  });
  test('partial stop failure does not claim a coordinated drain', () => {
    const context = new FakeContext(),
      budget = new OtioPcmBudget();
    const scheduler = new OtioPcmScheduler(
      context as unknown as AudioContext,
      new FakeNode() as unknown as AudioNode,
      1,
      budget
    );
    const req = {
      generation: 1,
      firstContextFrame: 48200,
      planes: [new Float32Array(480)],
      gainFactors: [],
    };
    scheduler.schedule(req);
    scheduler.schedule(req);
    context.sources[1]!.stop = () => {
      throw new Error('stop failed');
    };
    expect(() => scheduler.stopAtFrame(48300)).toThrow('stop failed');
    expect(budget.usedNodes).toBe(2);
    context.sources[0]!.onended?.();
    context.sources[1]!.onended?.();
    expect(budget.usedNodes).toBe(0);
  });
  test('budget subscribers wake only after release and can unsubscribe before delivery', async () => {
    const budget = new OtioPcmBudget();
    budget.reserveBytes(4);
    budget.reserveNodes(1);
    let calls = 0;
    const unsubscribe = budget.subscribe(() => {
      calls++;
    });
    budget.releaseBytes(4);
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    budget.releaseNodes(1);
    unsubscribe();
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
