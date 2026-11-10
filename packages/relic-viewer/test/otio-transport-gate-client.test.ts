import { expect, test } from 'bun:test';
import { createOtioTransportGate } from '../src/otio-transport-gate';
import {
  anchoredGate,
  fakeGateContext,
  FakeGateNode,
} from './otio-transport-gate-fixture';

test('session correlates checkpoints, anchors, commands and retirement', async () => {
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
    const context = {
      state: 'suspended',
      sampleRate: 48000,
      currentTime: 0,
      destination: {},
      audioWorklet: { addModule: async () => {} },
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    } as unknown as AudioContext;
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
    emit({ type: 'clock-ready' });
    await gate.ready();
    const checkpoint = gate.checkpoint(9);
    emit({
      type: 'checkpoint',
      nonce: 9,
      bankSerial: 1,
      callbackOrdinal: 2,
      sampleCount: 256,
      lastCertifiedEnd: 256,
      quantumLength: 128,
      fault: false,
    });
    const snapshot = await checkpoint;
    const anchor = gate.acceptAnchor(snapshot);
    emit({
      type: 'anchor-accepted',
      requestId: sent[sent.length - 1]!.requestId,
      clockCoverageEnd: 65536 - 2048,
    });
    await anchor;
    expect(gate.clockCoverageEnd).toBe(65536 - 2048);
    const arm = gate.arm(1, 300, 500);
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
