import { expect, test } from 'bun:test';
import { anchoredGate, FakeGateNode } from './otio-transport-gate-fixture';

test('malformed and mismatched command acknowledgments fail pending commands', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  globals.AudioWorkletNode = FakeGateNode;
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
        throughFrame: 400,
        closedFrame: null,
      },
      {
        type: 'arm',
        generation: 2,
        sequence: 1,
        accepted: true,
        throughFrame: 400,
        closedFrame: null,
      },
      {
        type: 'arm',
        generation: 1,
        sequence: 1,
        accepted: 'yes',
        throughFrame: 400,
        closedFrame: null,
      },
    ]) {
      const errors: Error[] = [];
      const { gate, node } = await anchoredGate(
        () => {},
        (error) => errors.push(error)
      );
      const promise = gate.arm(1, 300, 400);
      node.emit({ ...ack, clockEpoch: gate.clockEpoch });
      await expect(promise).rejects.toThrow('transport gate');
      expect(errors).toHaveLength(1);
      await expect(gate.arm(2, 400, 500)).rejects.toThrow('transport gate');
      const retired = gate.dispose();
      node.emit({ type: 'disposed', clockEpoch: gate.clockEpoch });
      await retired;
    }
  } finally {
    globals.AudioWorkletNode = original;
  }
});

test('malformed unsolicited closures report an error instead of a false close', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  globals.AudioWorkletNode = FakeGateNode;
  try {
    const errors: Error[] = [];
    const closures: unknown[] = [];
    const { gate, node } = await anchoredGate(
      (ack) => closures.push(ack),
      (error) => errors.push(error)
    );
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
    await arm;
    node.emit({
      type: 'closed',
      clockEpoch: gate.clockEpoch,
      generation: 2,
      sequence: 1,
      accepted: true,
      throughFrame: 400,
      closedFrame: 400,
    });
    expect(closures).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await expect(gate.extend(1, 400, 500)).rejects.toThrow('closure');
    const retired = gate.dispose();
    node.emit({ type: 'disposed', clockEpoch: gate.clockEpoch });
    await retired;
  } finally {
    globals.AudioWorkletNode = original;
  }
});
