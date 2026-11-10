import { expect, test } from 'bun:test';
import { createOtioTransportGate } from '../src/otio-transport-gate';
import {
  anchoredGate,
  fakeGateContext,
  FakeGateNode,
} from './otio-transport-gate-fixture';

test('session correlates anchor certification, commands and retirement', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  const sent: Array<Record<string, unknown>> = [];
  const param = () => ({
    cancelScheduledValues() {},
    setValueAtTime() {},
    linearRampToValueAtTime() {},
  });
  class Node {
    parameters = new Map(
      ['clockFrameA', 'clockTagA', 'clockFrameB', 'clockTagB'].map((name) => [
        name,
        param(),
      ])
    );
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (message: Record<string, unknown>) => sent.push(message),
      close() {},
    };
    onprocessorerror = null;
    connect() {}
    disconnect() {}
  }
  globals.AudioWorkletNode = Node;
  try {
    const context = fakeGateContext();
    const closed: unknown[] = [];
    const gate = await createOtioTransportGate(
      context,
      (ack) => closed.push(ack),
      undefined,
      0
    );
    const node = gate.node as unknown as Node;
    const emit = (message: Record<string, unknown>) =>
      node.port.onmessage?.({
        data: { clockEpoch: gate.clockEpoch, ...message },
      });
    emit({
      type: 'anchor-certified',
      firstFrame: 0,
      lastCertifiedEnd: 256,
      sampleCount: 256,
      callbackOrdinal: 2,
      quantumLength: 128,
      bankSerial: 1,
      clockCoverageEnd: 65536 - 2048,
    });
    await gate.ready();
    expect(gate.clockCoverageEnd).toBe(65536 - 2048);
    const arm = gate.arm(1, 300, 500);
    emit({ type: 'clock-stale-pair', previous: {}, current: {} });
    emit({ type: 'clock-stale-overflow' });
    expect(gate.clockCoverageEnd).toBe(65536 - 2048);
    await expect(gate.extend(1, 500, 600)).rejects.toThrow('pending');
    emit({
      type: 'arm',
      generation: 1,
      sequence: sent[sent.length - 1]!.sequence,
      accepted: true,
      throughFrame: 500,
      closedFrame: null,
    });
    expect((await arm).accepted).toBe(true);
    const stop = gate.stop(1, 400);
    expect(gate.stop(1, 400)).toBe(stop);
    const stopSequence = sent[sent.length - 1]!.sequence;
    const abort = gate.abort(1);
    const abortSequence = sent[sent.length - 1]!.sequence;
    emit({
      type: 'stop',
      generation: 1,
      sequence: stopSequence,
      accepted: true,
      throughFrame: 400,
      closedFrame: null,
    });
    emit({
      type: 'abort',
      generation: 1,
      sequence: abortSequence,
      accepted: true,
      throughFrame: 400,
      closedFrame: 320,
    });
    await stop;
    await abort;
    emit({
      type: 'closed',
      generation: 1,
      sequence: abortSequence,
      accepted: true,
      throughFrame: 400,
      closedFrame: 400,
    });
    expect(closed).toHaveLength(1);
    const retirement = gate.dispose();
    emit({ type: 'disposed' });
    await retirement;
    await expect(gate.arm(2, 500, 600)).rejects.toThrow('disposed');
  } finally {
    globals.AudioWorkletNode = original;
  }
});

test('serial exhaustion is proof-only, refuses renewal and does not wrap', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalNode = globals.AudioWorkletNode;
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    'location'
  );
  const originalProof = globals.__otioProofPcm;
  const originalExhaustion = globals.__otioProofClockSerialExhaustion;
  const maximum = 2 ** 24 - 1;
  globals.AudioWorkletNode = FakeGateNode;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname: 'example.com' },
  });
  try {
    globals.__otioProofPcm = true;
    globals.__otioProofClockSerialExhaustion = true;
    await expect(
      createOtioTransportGate(fakeGateContext(), () => {}, undefined, 0, {
        proofInitialSerial: maximum,
      })
    ).rejects.toThrow('loopback');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hostname: '127.0.0.1' },
    });
    globals.__otioProofClockSerialExhaustion = false;
    await expect(
      createOtioTransportGate(fakeGateContext(), () => {}, undefined, 0, {
        proofInitialSerial: maximum,
      })
    ).rejects.toThrow('proof mode');
    globals.__otioProofClockSerialExhaustion = true;
    await expect(
      createOtioTransportGate(fakeGateContext(), () => {}, undefined, 0, {
        proofInitialSerial: maximum - 1,
      })
    ).rejects.toThrow('proof mode');
    const { gate, node } = await anchoredGate(() => {}, undefined, {
      proofInitialSerial: maximum,
    });
    expect(node.options.processorOptions).toMatchObject({
      proofInitialSerial: maximum,
    });
    const count = node.sent.length;
    await expect(gate.prepareNextBank()).rejects.toThrow(
      'Clock bank unavailable'
    );
    expect(node.sent).toHaveLength(count);
    const arm = gate.arm(1, 300, 400);
    node.emit({
      type: 'arm',
      clockEpoch: gate.clockEpoch,
      generation: 1,
      sequence: 1,
      accepted: true,
      throughFrame: 400,
      closedFrame: null,
    });
    expect((await arm).accepted).toBe(true);
    const retired = gate.dispose();
    node.emit({ type: 'disposed', clockEpoch: gate.clockEpoch });
    await retired;
  } finally {
    globals.AudioWorkletNode = originalNode;
    globals.__otioProofPcm = originalProof;
    globals.__otioProofClockSerialExhaustion = originalExhaustion;
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globals.location;
  }
});

test('frozen native carrier encodes exact frame words and is routed only to input one', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  globals.AudioWorkletNode = FakeGateNode;
  const high = new Float32Array(8192);
  const low = new Float32Array(8192);
  const connections: unknown[][] = [];
  const starts: number[][] = [];
  const source = {
    buffer: null as unknown,
    onended: null as (() => void) | null,
    playbackRate: { value: 9 },
    detune: { value: 9 },
    loop: true,
    connect(...args: unknown[]) {
      connections.push(args);
    },
    disconnect() {},
    start(...args: number[]) {
      starts.push(args);
    },
    stop() {},
  };
  const initialFrame = 65534;
  const context = {
    ...fakeGateContext(),
    currentTime: initialFrame / 48000,
    createBuffer: () => ({
      getChannelData: (channel: number) => (channel === 0 ? high : low),
    }),
    createBufferSource: () => source,
  } as unknown as AudioContext;
  try {
    const gate = await createOtioTransportGate(
      context,
      () => {},
      undefined,
      initialFrame
    );
    const node = gate.node as unknown as FakeGateNode;
    expect(node.options.numberOfInputs).toBe(2);
    expect(node.options.channelInterpretation).toBe('speakers');
    expect(connections).toEqual([[node, 0, 1]]);
    expect(starts).toEqual([[initialFrame / 48000, 0]]);
    expect(Array.from(high.slice(0, 4))).toEqual([1, 1, 2, 2]);
    expect(Array.from(low.slice(0, 4))).toEqual([65534, 65535, 0, 1]);
    expect(source.playbackRate.value).toBe(1);
    expect(source.detune.value).toBe(0);
    expect(source.loop).toBe(false);
    const retired = gate.dispose();
    node.emit({ type: 'disposed', clockEpoch: gate.clockEpoch });
    await retired;
    source.onended?.();
  } finally {
    globals.AudioWorkletNode = original;
  }
});
