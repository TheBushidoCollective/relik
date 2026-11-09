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
  start(time: number) {
    this.started = time;
  }
  stop() {
    this.onended?.();
  }
}
class FakeGain extends FakeNode {
  calls: Array<[string, number, number]> = [];
  gain = {
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
});
