import { expect, test } from 'bun:test';
import {
  createOtioTransportGate,
  OtioGateAnchorLateError,
  OtioGatePreconstructionError,
} from '../src/otio-transport-gate';
import { FakeGateNode } from './otio-transport-gate-fixture';

/** Captures every AudioWorkletNode the gate constructs, restoring the global afterwards. */
async function withNodes<T>(
  run: (nodes: FakeGateNode[]) => Promise<T>
): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  const nodes: FakeGateNode[] = [];
  globals.AudioWorkletNode = class extends FakeGateNode {
    constructor(
      context: AudioContext,
      name: string,
      options: AudioWorkletNodeOptions
    ) {
      super(context, name, options);
      nodes.push(this);
    }
  };
  try {
    return await run(nodes);
  } finally {
    globals.AudioWorkletNode = original;
  }
}

/** A running 48 kHz context whose clock is read in frames, so tests can move it between reads. */
const runningContext = (frames: () => number) =>
  ({
    state: 'running',
    sampleRate: 48000,
    get currentTime() {
      return frames() / 48000;
    },
    destination: {},
    audioWorklet: { addModule: async () => {} },
    createBuffer: () => ({
      getChannelData: () => new Float32Array(8192),
    }),
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      detune: { value: 0 },
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    }),
    createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
  }) as unknown as AudioContext;

test('a running context anchors an aligned lead ahead and programs the processor with it', async () => {
  await withNodes(async (nodes) => {
    // 48000 frames plus a 1024 lead is already a multiple of 128.
    const gate = await createOtioTransportGate(
      runningContext(() => 48000),
      () => {},
      undefined,
      { mode: 'running', leadFrames: 1024 }
    );
    expect(gate.initialFrame).toBe(49024);
    expect(gate.clockCoverageEnd).toBeNull();
    const node = nodes[0]!;
    expect(node.options.processorOptions).toMatchObject({
      initialFrame: 49024,
      prestartBudgetFrames: 1024 + 4096,
    });
    const retired = gate.dispose();
    node.emit({ type: 'disposed', clockEpoch: gate.clockEpoch });
    await retired;
  });
});

test('the anchor rounds a fractional frame up before aligning to the quantum', async () => {
  await withNodes(async () => {
    // 48000.5 frames: ceil gives 48001, plus 1024 is 49025, which aligns up to 49152.
    const gate = await createOtioTransportGate(
      runningContext(() => 48000.5),
      () => {},
      undefined,
      { mode: 'running', leadFrames: 1024 }
    );
    expect(gate.initialFrame).toBe(49152);
    const retired = gate.dispose();
    (gate.node as unknown as FakeGateNode).emit({
      type: 'disposed',
      clockEpoch: gate.clockEpoch,
    });
    await retired;
  });
});

test('a running gate refuses a suspended context before any node exists', async () => {
  await withNodes(async (nodes) => {
    const context = {
      ...runningContext(() => 0),
      state: 'suspended',
    } as unknown as AudioContext;
    const error = await createOtioTransportGate(context, () => {}, undefined, {
      mode: 'running',
      leadFrames: 1024,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OtioGatePreconstructionError);
    expect(nodes).toHaveLength(0);
  });
});

test('a lead lost during construction retires the node and waits for the processor to confirm', async () => {
  await withNodes(async (nodes) => {
    // First read sets the anchor at 49024. The re-read after scheduling finds only 64 frames of lead.
    let reads = 0;
    const context = runningContext(() => (reads++ === 0 ? 48000 : 48960));
    const error = await createOtioTransportGate(context, () => {}, undefined, {
      mode: 'running',
      leadFrames: 1024,
    }).catch((failure: unknown) => failure);
    if (!(error instanceof OtioGateAnchorLateError))
      throw new Error('expected an anchor-late error');
    expect(error.retryable).toBe(true);
    expect(error.anchorFrame).toBe(49024);
    expect(error.shortfallFrames).toBe(256 - 64);

    const node = nodes[0]!;
    expect(node.sent.at(-1)).toMatchObject({ type: 'dispose' });
    let settled = false;
    void error.retirement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    node.emit({ type: 'disposed', clockEpoch: node.sent.at(-1)?.clockEpoch });
    await error.retirement;
    expect(settled).toBe(true);
  });
});

test('a worklet anchor-late fails ready with a retryable error whose retirement is already settled', async () => {
  await withNodes(async (nodes) => {
    const errors: Error[] = [];
    const gate = await createOtioTransportGate(
      runningContext(() => 48000),
      () => {},
      (error) => errors.push(error),
      { mode: 'running', leadFrames: 1024 }
    );
    const ready = gate.ready();
    nodes[0]!.emit({
      type: 'anchor-late',
      clockEpoch: gate.clockEpoch,
      firstFrame: 49024,
      observedFrame: 49152,
      prestartSamples: 0,
      budget: 5120,
    });
    const error = await ready.catch((failure: unknown) => failure);
    if (!(error instanceof OtioGateAnchorLateError))
      throw new Error('expected an anchor-late error');
    expect(error).toMatchObject({
      retryable: true,
      anchorFrame: 49024,
      observedFrame: 49152,
      shortfallFrames: 128,
    });
    expect(errors).toHaveLength(1);
    await expect(error.retirement).resolves.toBeUndefined();
    // The processor already returned false, so dispose must not wait for a message that never comes.
    await gate.dispose();
  });
});

test('certification must name the computed anchor frame, and a wrong one fails the gate', async () => {
  await withNodes(async (nodes) => {
    const certified = (firstFrame: number) => ({
      type: 'anchor-certified',
      firstFrame,
      lastCertifiedEnd: firstFrame + 256,
      sampleCount: 256,
      callbackOrdinal: 2,
      quantumLength: 128,
      bankSerial: 1,
      clockCoverageEnd: firstFrame + 65536 - 2048,
    });

    const good = await createOtioTransportGate(
      runningContext(() => 48000),
      () => {},
      undefined,
      { mode: 'running', leadFrames: 1024 }
    );
    const ready = good.ready();
    nodes[0]!.emit({ ...certified(49024), clockEpoch: good.clockEpoch });
    await ready;
    expect(good.clockCoverageEnd).toBe(49024 + 65536 - 2048);

    const wrong = await createOtioTransportGate(
      runningContext(() => 48000),
      () => {},
      undefined,
      { mode: 'running', leadFrames: 1024 }
    );
    const rejected = wrong.ready();
    nodes[1]!.emit({ ...certified(49152), clockEpoch: wrong.clockEpoch });
    await expect(rejected).rejects.toThrow('Malformed clock anchor');
    expect(wrong.clockCoverageEnd).toBeNull();
  });
});
