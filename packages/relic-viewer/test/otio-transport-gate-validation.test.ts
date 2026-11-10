import { expect, test } from 'bun:test';
import { createOtioTransportGate } from '../src/otio-transport-gate';

test('malformed and mismatched command acknowledgments fail pending commands', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  class Node {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (_message: unknown) => {},
      close: () => {},
    };
    onprocessorerror = null;
    disconnect() {}
  }
  globals.AudioWorkletNode = Node;
  const context = {
    audioWorklet: { addModule: async () => {} },
  } as unknown as AudioContext;
  try {
    for (const ack of [
      {
        type: 'arm',
        generation: 1,
        sequence: 1,
        accepted: true,
        throughFrame: NaN,
        closedFrame: null,
      },
      {
        type: 'extend',
        generation: 1,
        sequence: 1,
        accepted: true,
        throughFrame: 10,
        closedFrame: null,
      },
      {
        type: 'arm',
        generation: 2,
        sequence: 1,
        accepted: true,
        throughFrame: 10,
        closedFrame: null,
      },
      {
        type: 'arm',
        generation: 1,
        sequence: 1,
        accepted: 'yes',
        throughFrame: 10,
        closedFrame: null,
      },
    ]) {
      const errors: Error[] = [];
      const gate = await createOtioTransportGate(
        context,
        () => {},
        (error) => errors.push(error)
      );
      const promise = gate.arm(1, 0, 10);
      (gate.node as unknown as Node).port.onmessage?.({ data: ack });
      await expect(promise).rejects.toThrow('transport gate');
      expect(errors).toHaveLength(1);
      await expect(gate.arm(2, 10, 20)).rejects.toThrow('transport gate');
      gate.dispose();
    }
  } finally {
    globals.AudioWorkletNode = original;
  }
});

test('malformed unsolicited closures report an error instead of a false close', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  class Node {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (_message: unknown) => {},
      close: () => {},
    };
    onprocessorerror = null;
    disconnect() {}
  }
  globals.AudioWorkletNode = Node;
  try {
    const errors: Error[] = [];
    const closures: unknown[] = [];
    const context = {
      audioWorklet: { addModule: async () => {} },
    } as unknown as AudioContext;
    const gate = await createOtioTransportGate(
      context,
      (ack) => closures.push(ack),
      (error) => errors.push(error)
    );
    const node = gate.node as unknown as Node;
    const arm = gate.arm(1, 0, 10);
    node.port.onmessage?.({
      data: {
        type: 'arm',
        generation: 1,
        sequence: 1,
        accepted: true,
        throughFrame: 10,
        closedFrame: null,
      },
    });
    await arm;
    node.port.onmessage?.({
      data: {
        type: 'closed',
        generation: 2,
        sequence: 1,
        accepted: true,
        throughFrame: 10,
        closedFrame: 10,
      },
    });
    expect(closures).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await expect(gate.extend(1, 10, 20)).rejects.toThrow('closure');
    gate.dispose();
  } finally {
    globals.AudioWorkletNode = original;
  }
});
