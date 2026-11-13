import { describe, expect, test } from 'bun:test';
import {
  OTIO_PCM_BOUNDARY_COPY_FRAMES,
  OtioPcmBudget,
  OtioPcmScheduler,
} from '../src/otio-audio-pcm';

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
  buffer: { data: Float32Array[] } | null = null;
  onended: (() => void) | null = null;
  started = -1;
  start(time: number) {
    this.started = time;
  }
  stop() {}
  end() {
    this.onended?.();
  }
}

class FakeGain extends FakeNode {
  gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
  };
}

class FakeContext {
  sampleRate = 48000;
  currentTime = 1;
  sources: FakeSource[] = [];
  createBuffer(channels: number, frames: number, _rate: number) {
    const data = Array.from(
      { length: channels },
      () => new Float32Array(frames)
    );
    return {
      data,
      length: frames,
      numberOfChannels: channels,
      copyToChannel(plane: Float32Array, channel: number) {
        data[channel]!.set(plane);
      },
      copyFromChannel(dest: Float32Array, channel: number, offset = 0) {
        dest.set(data[channel]!.subarray(offset, offset + dest.length));
      },
    };
  }
  createBufferSource() {
    const node = new FakeSource();
    this.sources.push(node);
    return node;
  }
  createGain() {
    return new FakeGain();
  }
}

function harness() {
  const context = new FakeContext();
  const master = new FakeNode();
  const budget = new OtioPcmBudget();
  const make = (generation: number, own = budget) =>
    new OtioPcmScheduler(
      context as unknown as AudioContext,
      master as unknown as AudioNode,
      generation,
      own
    );
  return { context, budget, make };
}

function ramp(length: number, offset: number): Float32Array {
  return Float32Array.from({ length }, (_, i) =>
    Math.fround(Math.sin((offset + i) * 0.01) * 0.5)
  );
}

function copiedPlane(context: FakeContext): Float32Array {
  const source = context.sources.at(-1)!;
  return source.buffer!.data[0]!;
}

describe('keyed PCM ledger', () => {
  test('distinct keys may retain the same composition range; overlap is rejected per key', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'a', compositionStartFrame: 1000 },
    });
    scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 7)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'b', compositionStartFrame: 1000 },
    });
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(2);
    expect(() =>
      scheduler.prepare({
        generation: 1,
        planes: [ramp(480, 0)],
        gainFactorCount: 0,
        retain: { ledgerKey: 'a', compositionStartFrame: 1200 },
      })
    ).toThrow('Invalid PCM ledger block');
    // The rejected admission returns its own bytes and nodes.
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(2);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('restages an exact boundary window across two blocks of one key', async () => {
    const { context, budget, make } = harness();
    const scheduler = make(1);
    const a = ramp(3000, 0);
    const b = ramp(3000, 3000);
    scheduler.prepare({
      generation: 1,
      planes: [a],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    scheduler.prepare({
      generation: 1,
      planes: [b],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 3000 },
    });
    expect(scheduler.coveredThrough('k', 0)).toBe(6000);
    expect(scheduler.coveredThrough('other', 0)).toBe(0);

    const target = make(2);
    const boundary = 3000 - 2048;
    const prepared = scheduler.restage({
      target,
      generation: 2,
      ledgerKey: 'k',
      compositionStartFrame: boundary,
      frameCount: OTIO_PCM_BOUNDARY_COPY_FRAMES,
      gainFactorCount: 0,
    });
    prepared.start(48200, []);
    const expected = Float32Array.from(
      { length: OTIO_PCM_BOUNDARY_COPY_FRAMES },
      (_, j) => {
        const frame = boundary + j;
        return frame < 3000 ? a[frame]! : b[frame - 3000]!;
      }
    );
    expect(copiedPlane(context)).toEqual(expected);
    expect(budget.usedBytes).toBe(
      3000 * 4 * 2 + OTIO_PCM_BOUNDARY_COPY_FRAMES * 4
    );
    target.dispose();
    scheduler.dispose();
    // A started source releases its charge only when the browser reports it ended.
    context.sources.at(-1)!.end();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('a window beyond coverage or across a gap fails with no budget change', () => {
    const { context, budget, make } = harness();
    const scheduler = make(1);
    scheduler.prepare({
      generation: 1,
      planes: [ramp(1000, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    scheduler.prepare({
      generation: 1,
      planes: [ramp(1000, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 1500 },
    });
    const target = make(2);
    const bytes = budget.usedBytes;
    const sources = context.sources.length;
    const attempt = (ledgerKey: string, start: number, frameCount: number) =>
      scheduler.restage({
        target,
        generation: 2,
        ledgerKey,
        compositionStartFrame: start,
        frameCount,
        gainFactorCount: 0,
      });
    expect(() => attempt('k', 900, 700)).toThrow('coverage short');
    expect(() => attempt('k', 2400, 200)).toThrow('coverage short');
    expect(() => attempt('missing', 0, 10)).toThrow('coverage short');
    expect(budget.usedBytes).toBe(bytes);
    expect(context.sources.length).toBe(sources);
    expect(() => attempt('k', 0, OTIO_PCM_BOUNDARY_COPY_FRAMES + 1)).toThrow(
      'Invalid PCM restage request'
    );
    target.dispose();
    scheduler.dispose();
  });

  test('a delayed predecessor end after handoff cannot free successor-owned bytes', () => {
    const { context, budget, make } = harness();
    const predecessor = make(1);
    const retainedA = predecessor.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'a', compositionStartFrame: 0 },
    });
    predecessor.prepare({
      generation: 1,
      planes: [ramp(480, 1)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'b', compositionStartFrame: 0 },
    });
    retainedA.start(48200, []);
    expect(budget.usedBytes).toBe(3840);

    predecessor.seal();
    expect(() =>
      predecessor.prepare({
        generation: 1,
        planes: [ramp(480, 2)],
        gainFactorCount: 0,
      })
    ).toThrow();
    const successor = make(2);
    predecessor.handOffLedger(successor);
    expect(budget.usedBytes).toBe(3840);

    // The predecessor's source for key 'a' is still playing and ends late.
    context.sources[0]!.end();
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(1);

    const copy = successor.restage({
      target: successor,
      generation: 2,
      ledgerKey: 'b',
      compositionStartFrame: 0,
      frameCount: 480,
      gainFactorCount: 0,
    });
    expect(budget.usedBytes).toBe(3840 + 1920);
    predecessor.dispose();
    expect(budget.usedBytes).toBe(3840 + 1920);
    copy.cancel();
    successor.dispose();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('cancellation releases retained PCM and forbids handoff or restage', () => {
    const { budget, make } = harness();
    const predecessor = make(1);
    predecessor.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    expect(() => predecessor.handOffLedger(make(2))).toThrow(
      'before predecessor closure'
    );
    predecessor.cancel();
    expect(budget.usedBytes).toBe(0);
    expect(() => predecessor.handOffLedger(make(2))).toThrow();
    expect(() =>
      predecessor.restage({
        target: make(2),
        generation: 2,
        ledgerKey: 'k',
        compositionStartFrame: 0,
        frameCount: 10,
        gainFactorCount: 0,
      })
    ).toThrow();
  });

  test("retires one key's blocks before a frame without touching later ones", () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const first = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    first.commit();
    const second = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 480 },
    });
    second.commit();
    // Unstarted sources hold their buffers until cancelled.
    first.cancel();
    second.cancel();
    scheduler.retireRetainedBefore('k', 480);
    expect(budget.usedBytes).toBe(1920);
    expect(scheduler.coveredThrough('k', 0)).toBe(0);
    expect(scheduler.coveredThrough('k', 480)).toBe(960);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
  });

  test('1000 restages hand one ledger along without leaking bytes or nodes', () => {
    const { context, budget, make } = harness();
    let active = make(0);
    active.prepare({
      generation: 0,
      planes: [ramp(4096, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    const retained = 4096 * 4;
    expect(budget.usedBytes).toBe(retained);
    for (let generation = 1; generation <= 1000; generation++) {
      const next = make(generation);
      active
        .restage({
          target: next,
          generation,
          ledgerKey: 'k',
          compositionStartFrame: 1024,
          frameCount: 2048,
          gainFactorCount: 0,
        })
        .start(48200, []);
      expect(budget.usedBytes).toBe(retained + 2048 * 4);
      active.seal();
      active.handOffLedger(next);
      active.dispose();
      context.sources.at(-1)!.end();
      expect(budget.usedBytes).toBe(retained);
      active = next;
    }
    expect(budget.usedNodes).toBe(0);
    active.dispose();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });
});

describe('uncommitted retention', () => {
  test('cancel rolls back an uncommitted block so the same range can be retried', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const request = {
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    };
    const first = scheduler.prepare(request);
    expect(budget.usedBytes).toBe(1920);
    first.cancel();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
    expect(scheduler.coveredThrough('k', 0)).toBe(0);

    const retry = scheduler.prepare(request);
    retry.commit();
    expect(budget.usedBytes).toBe(1920);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
  });

  test('commit keeps retention alive through the source being cancelled', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const prepared = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    prepared.commit();
    prepared.commit();
    prepared.cancel();
    expect(budget.usedBytes).toBe(1920);
    expect(scheduler.coveredThrough('k', 0)).toBe(480);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
  });

  test('a started uncommitted source rolled back stays charged until it actually ends', () => {
    const { context, budget, make } = harness();
    const scheduler = make(1);
    const prepared = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    prepared.start(48200, []);
    prepared.cancel();
    // The audible source still holds its AudioBuffer, so the bytes stay charged.
    expect(budget.usedBytes).toBe(1920);
    context.sources[0]!.end();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('scheduler helpers address uncommitted blocks by key and start', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const request = {
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    };
    const first = scheduler.prepare(request);
    expect(scheduler.rollbackRetained('k', 0)).toBe(true);
    expect(scheduler.rollbackRetained('k', 0)).toBe(false);
    // The unstarted source still holds its buffer until it is cancelled.
    expect(budget.usedBytes).toBe(1920);
    first.cancel();
    expect(budget.usedBytes).toBe(0);

    scheduler.prepare(request);
    scheduler.commitRetained('k', 0);
    expect(scheduler.rollbackRetained('k', 0)).toBe(false);
    expect(() => scheduler.commitRetained('k', 480)).toThrow('not retained');
    expect(budget.usedBytes).toBe(1920);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
  });

  test('retirement frees only committed blocks', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    scheduler.retireRetainedBefore('k', 480);
    expect(budget.usedBytes).toBe(1920);
    expect(scheduler.coveredThrough('k', 0)).toBe(480);
    scheduler.dispose();
  });

  test('commit and rollback follow a block through handoff', () => {
    const { budget, make } = harness();
    const predecessor = make(1);
    const committed = predecessor.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'a', compositionStartFrame: 0 },
    });
    const withdrawn = predecessor.prepare({
      generation: 1,
      planes: [ramp(480, 1)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'b', compositionStartFrame: 0 },
    });
    predecessor.seal();
    const successor = make(2);
    predecessor.handOffLedger(successor);
    committed.commit();
    withdrawn.cancel();
    expect(budget.usedBytes).toBe(1920);
    expect(successor.coveredThrough('a', 0)).toBe(480);
    expect(successor.coveredThrough('b', 0)).toBe(0);
    // The committed block stays held until its unstarted source is cancelled.
    committed.cancel();
    successor.dispose();
    expect(budget.usedBytes).toBe(0);
  });

  test('commit without retained PCM throws', () => {
    const { make } = harness();
    const scheduler = make(1);
    const prepared = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
    });
    expect(() => prepared.commit()).toThrow('retained no PCM');
    prepared.cancel();
  });
});

describe('retained AudioBuffer', () => {
  test('the ledger keeps the AudioBuffer, not the caller planes', () => {
    const { context, budget, make } = harness();
    const scheduler = make(1);
    const planes = [ramp(480, 0)];
    const original = Float32Array.from(planes[0]!);
    scheduler
      .prepare({
        generation: 1,
        planes,
        gainFactorCount: 0,
        retain: { ledgerKey: 'k', compositionStartFrame: 0 },
      })
      .commit();
    // The caller reuses its arrays once scheduled; the retained PCM must not change.
    planes[0]!.fill(9);
    const target = make(2);
    scheduler
      .restage({
        target,
        generation: 2,
        ledgerKey: 'k',
        compositionStartFrame: 0,
        frameCount: 480,
        gainFactorCount: 0,
      })
      .start(48200, []);
    expect(copiedPlane(context)).toEqual(original);
    expect(budget.usedBytes).toBe(1920 + 1920);
    context.sources.at(-1)!.end();
    scheduler.dispose();
    target.dispose();
    expect(budget.usedBytes).toBe(0);
  });

  test('retiring a block keeps its AudioBuffer charged while a source still plays it', () => {
    const { context, budget, make } = harness();
    const scheduler = make(1);
    const prepared = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    prepared.commit();
    prepared.start(48200, []);
    scheduler.retireRetainedBefore('k', 480);
    expect(scheduler.coveredThrough('k', 0)).toBe(0);
    expect(budget.usedBytes).toBe(1920);
    context.sources[0]!.end();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('retiring a committed block nothing else holds frees its bytes at once', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const prepared = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    prepared.commit();
    prepared.cancel();
    expect(budget.usedBytes).toBe(1920);
    scheduler.retireRetainedBefore('k', 480);
    expect(budget.usedBytes).toBe(0);
    scheduler.dispose();
  });
});

describe('stereo retained PCM and unstarted handles', () => {
  function stereo(length: number, offset: number): Float32Array[] {
    return [ramp(length, offset), ramp(length, offset + 500)];
  }

  test('stereo restage copies both channels exactly across a block boundary', () => {
    const { context, budget, make } = harness();
    const scheduler = make(1);
    const blockA = stereo(3000, 0);
    const blockB = stereo(3000, 3000);
    scheduler
      .prepare({
        generation: 1,
        planes: blockA,
        gainFactorCount: 0,
        retain: { ledgerKey: 'k', compositionStartFrame: 0 },
      })
      .commit();
    scheduler
      .prepare({
        generation: 1,
        planes: blockB,
        gainFactorCount: 0,
        retain: { ledgerKey: 'k', compositionStartFrame: 3000 },
      })
      .commit();
    expect(budget.usedBytes).toBe(48000);

    const target = make(2);
    const boundary = 3000 - 2048;
    scheduler
      .restage({
        target,
        generation: 2,
        ledgerKey: 'k',
        compositionStartFrame: boundary,
        frameCount: OTIO_PCM_BOUNDARY_COPY_FRAMES,
        gainFactorCount: 0,
      })
      .start(48200, []);
    const copied = context.sources.at(-1)!.buffer!.data;
    for (let channel = 0; channel < 2; channel++) {
      const source = channel === 0 ? blockA[0]! : blockA[1]!;
      const later = channel === 0 ? blockB[0]! : blockB[1]!;
      const expected = Float32Array.from(
        { length: OTIO_PCM_BOUNDARY_COPY_FRAMES },
        (_, j) => {
          const frame = boundary + j;
          return frame < 3000 ? source[frame]! : later[frame - 3000]!;
        }
      );
      expect(copied[channel]).toEqual(expected);
    }
    expect(copied[0]).not.toEqual(copied[1]);
    expect(budget.usedBytes).toBe(
      48000 + OTIO_PCM_BOUNDARY_COPY_FRAMES * 2 * 4
    );
    context.sources.at(-1)!.end();
    target.dispose();
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('a stereo late onended after handoff leaves the successor-owned block charged', () => {
    const { context, budget, make } = harness();
    const predecessor = make(1);
    const original = stereo(480, 0).map((plane) => Float32Array.from(plane));
    const playing = predecessor.prepare({
      generation: 1,
      planes: stereo(480, 0),
      gainFactorCount: 0,
      retain: { ledgerKey: 'a', compositionStartFrame: 0 },
    });
    playing.commit();
    playing.start(48200, []);
    expect(budget.usedBytes).toBe(3840);

    predecessor.seal();
    const successor = make(2);
    predecessor.handOffLedger(successor);
    expect(budget.usedBytes).toBe(3840);
    // The predecessor's stereo source ends after the handoff.
    context.sources[0]!.end();
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(0);

    const copy = successor.restage({
      target: successor,
      generation: 2,
      ledgerKey: 'a',
      compositionStartFrame: 0,
      frameCount: 480,
      gainFactorCount: 0,
    });
    copy.start(48200, []);
    const copied = context.sources.at(-1)!.buffer!.data;
    expect(copied[0]).toEqual(original[0]);
    expect(copied[1]).toEqual(original[1]);
    expect(budget.usedBytes).toBe(3840 + 3840);

    predecessor.dispose();
    expect(budget.usedBytes).toBe(3840 + 3840);
    successor.dispose();
    // The restaged copy is still audible, so only its charge remains.
    expect(budget.usedBytes).toBe(3840);
    context.sources.at(-1)!.end();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('cancelling an unstarted stereo handle releases its node, and its block only when uncommitted', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const uncommitted = scheduler.prepare({
      generation: 1,
      planes: stereo(480, 0),
      gainFactorCount: 0,
      retain: { ledgerKey: 'u', compositionStartFrame: 0 },
    });
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(1);
    uncommitted.cancel();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
    uncommitted.cancel();
    expect(budget.usedBytes).toBe(0);
    expect(() => uncommitted.start(48200, [])).toThrow();

    const committed = scheduler.prepare({
      generation: 1,
      planes: stereo(480, 0),
      gainFactorCount: 0,
      retain: { ledgerKey: 'c', compositionStartFrame: 0 },
    });
    committed.commit();
    committed.cancel();
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(0);
    expect(scheduler.coveredThrough('c', 0)).toBe(480);

    const plain = scheduler.prepare({
      generation: 1,
      planes: stereo(480, 0),
      gainFactorCount: 0,
    });
    expect(budget.usedBytes).toBe(3840 * 2);
    plain.cancel();
    expect(budget.usedBytes).toBe(3840);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });

  test('a mono block cannot join a stereo key and its failed admission returns its bytes', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    scheduler.prepare({
      generation: 1,
      planes: stereo(480, 0),
      gainFactorCount: 0,
      retain: { ledgerKey: 's', compositionStartFrame: 0 },
    });
    expect(budget.usedBytes).toBe(3840);
    expect(() =>
      scheduler.prepare({
        generation: 1,
        planes: [ramp(480, 0)],
        gainFactorCount: 0,
        retain: { ledgerKey: 's', compositionStartFrame: 480 },
      })
    ).toThrow('Invalid PCM ledger block');
    expect(budget.usedBytes).toBe(3840);
    expect(budget.usedNodes).toBe(1);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
  });
});

describe('descriptor churn across handoffs', () => {
  test('1000 restages, half cancelled and half ended late after handoff, return the budget to baseline exactly', () => {
    const { context, budget, make } = harness();
    let active = make(0);
    const initial = active.prepare({
      generation: 0,
      planes: [ramp(4096, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    initial.commit();
    initial.cancel();
    const baseline = budget.usedBytes;
    expect(baseline).toBe(4096 * 4);
    expect(budget.usedNodes).toBe(0);

    for (let generation = 1; generation <= 1000; generation++) {
      const next = make(generation);
      const descriptor = active.restage({
        target: active,
        generation: active.generation,
        ledgerKey: 'k',
        compositionStartFrame: 1024,
        frameCount: 2048,
        gainFactorCount: 0,
      });
      expect(budget.usedBytes).toBe(baseline + 2048 * 4);
      if (generation % 2 === 1) {
        // An unstarted descriptor cancelled before handoff returns at once.
        descriptor.cancel();
        expect(budget.usedBytes).toBe(baseline);
        expect(budget.usedNodes).toBe(0);
        active.seal();
        active.handOffLedger(next);
        active.dispose();
      } else {
        // A started descriptor stays charged while audible, then its onended
        // lands after the ledger moved to the successor.
        descriptor.start(48200, []);
        descriptor.cancel();
        expect(budget.usedBytes).toBe(baseline + 2048 * 4);
        active.seal();
        active.handOffLedger(next);
        context.sources.at(-1)!.end();
        expect(budget.usedBytes).toBe(baseline);
        expect(budget.usedNodes).toBe(0);
        active.dispose();
      }
      expect(budget.usedBytes).toBe(baseline);
      active = next;
    }
    expect(budget.usedNodes).toBe(0);
    active.dispose();
    expect(budget.usedBytes).toBe(0);
    expect(budget.usedNodes).toBe(0);
  });
});

describe('sealed start', () => {
  test('starting a descriptor after seal releases its nodes, keeping only the committed block', () => {
    const { budget, make } = harness();
    const scheduler = make(1);
    const handle = scheduler.prepare({
      generation: 1,
      planes: [ramp(480, 0)],
      gainFactorCount: 0,
      retain: { ledgerKey: 'k', compositionStartFrame: 0 },
    });
    handle.commit();
    scheduler.seal();
    expect(() => handle.start(48200, [])).toThrow('closed');
    expect(budget.usedNodes).toBe(0);
    expect(budget.usedBytes).toBe(1920);
    expect(scheduler.coveredThrough('k', 0)).toBe(480);
    scheduler.dispose();
    expect(budget.usedBytes).toBe(0);
  });
});
