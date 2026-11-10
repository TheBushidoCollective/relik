import { expect, test } from 'bun:test';
import {
  createOtioTransportGate,
  OtioGateRenderClockError,
} from '../src/otio-transport-gate';

test('render clock fault interrupts pending work and establishes processor retirement', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  class Node {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (_value: unknown) => {},
      close: () => {},
    };
    onprocessorerror = null;
    disconnect() {}
  }
  globals.AudioWorkletNode = Node;
  try {
    const errors: Error[] = [];
    const context = {
      audioWorklet: { addModule: async () => {} },
    } as unknown as AudioContext;
    const gate = await createOtioTransportGate(
      context,
      () => {},
      (error) => errors.push(error)
    );
    const pending = gate.arm(1, 0, 100);
    (gate.node as unknown as Node).port.onmessage?.({
      data: { type: 'clock-fault', expectedFrame: 128, observedFrame: 0 },
    });
    await expect(pending).rejects.toBeInstanceOf(OtioGateRenderClockError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ expectedFrame: 128, observedFrame: 0 });
    await gate.dispose();
  } finally {
    globals.AudioWorkletNode = original;
  }
});
