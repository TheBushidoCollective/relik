import { expect, test } from 'bun:test';
import type { OtioGateDecodeDiagnostic } from '../src/otio-transport-gate-state';
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

test('clock fault carries decode evidence without enumerating it into logs', async () => {
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
    const diagnostic: OtioGateDecodeDiagnostic = {
      location: 'warming',
      reason: 'tag-mismatch',
      failingSample: 0,
      failingFrame: 0,
      failingTag: 3,
      length: 128,
      cachedCurrentFrame: 32768,
      bank: {
        clockEpoch: gate.clockEpoch,
        bank: 1,
        serial: 2,
        startFrame: 32768,
        endFrame: 98304,
      },
      frame: null,
      tag: null,
      activeBank: {
        clockEpoch: gate.clockEpoch,
        bank: 0,
        serial: 1,
        startFrame: 0,
        endFrame: 65536,
      },
      warmingBank: {
        clockEpoch: gate.clockEpoch,
        bank: 1,
        serial: 2,
        startFrame: 32768,
        endFrame: 98304,
      },
      samples: {
        active: { frame: [0], tag: [1] },
        warming: { frame: [0], tag: [3] },
      },
    };
    node.emit({
      type: 'clock-fault',
      clockEpoch: gate.clockEpoch,
      expectedFrame: 32768,
      observedFrame: -1,
      diagnostic,
    });
    await expect(pending).rejects.toBeInstanceOf(OtioGateRenderClockError);
    const error = errors[0] as OtioGateRenderClockError;
    expect(error.message).toBe(
      'Transport render clock discontinuity: expected 32768, observed -1'
    );
    expect(error.diagnostic).toEqual(diagnostic);
    expect(Object.keys(error)).not.toContain('diagnostic');
    expect(JSON.stringify(error)).not.toContain('samples');
    await gate.dispose();
  } finally {
    globals.AudioWorkletNode = original;
  }
});
