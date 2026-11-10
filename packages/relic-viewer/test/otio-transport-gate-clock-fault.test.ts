import { expect, test } from 'bun:test';
import { OtioGateRenderClockError } from '../src/otio-transport-gate';
import { anchoredGate, FakeGateNode } from './otio-transport-gate-fixture';

test('render clock fault interrupts pending work and establishes processor retirement', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  globals.AudioWorkletNode = FakeGateNode;
  try {
    const errors: Error[] = [];
    const { gate, node } = await anchoredGate(
      () => {},
      (error) => errors.push(error)
    );
    const pending = gate.arm(1, 300, 400, 0);
    node.emit({
      type: 'clock-fault',
      clockEpoch: gate.clockEpoch,
      expectedFrame: 384,
      observedFrame: 256,
    });
    await expect(pending).rejects.toBeInstanceOf(OtioGateRenderClockError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ expectedFrame: 384, observedFrame: 256 });
    await gate.dispose();
  } finally {
    globals.AudioWorkletNode = original;
  }
});
