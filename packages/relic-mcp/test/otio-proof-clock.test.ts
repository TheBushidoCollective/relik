import { describe, expect, test } from 'bun:test';
import {
  associateGateSequence,
  assertAssociatedSamples,
  type GateQuantum,
  type TapQuantum,
} from './otio-proof-clock.ts';

function fixture(labels = [10, 10, 10, 14]) {
  const tap: TapQuantum[] = labels.map((label, i) => ({
    label,
    length: 2,
    ordinal: i,
    offset: i * 2,
    carrier: [100 + i * 2, 101 + i * 2],
  }));
  const gate: GateQuantum[] = labels.map((label, i) => ({
    clockEpoch: 7,
    cachedCurrentFrame: label,
    callbackOrdinal: i + 1,
    sampleCount: 20 + i * 2,
    certifiedFrame: 100 + i * 2,
    startFrame: 100,
    endFrame: 200,
    serial: 9,
    frames: [i * 2, i * 2 + 1],
    tags: [9],
  }));
  return { tap, gate };
}

describe('independent callback association', () => {
  test('locates three frozen labels within a longer tap sequence by the whole sequence', () => {
    const { tap, gate } = fixture([8, 10, 10, 10, 14, 18]);
    const sub = gate.slice(1, 5);
    const a = associateGateSequence(tap, sub, 7);
    expect(a.start).toBe(1);
    assertAssociatedSamples(tap, sub, a.start, 102, 110);
  });
  test('rejects gate-side missing, duplicated and reordered callbacks', () => {
    const { tap, gate } = fixture([10, 11, 12, 13]);
    expect(() =>
      associateGateSequence(tap, [gate[0]!, ...gate.slice(2)], 7)
    ).toThrow();
    expect(() =>
      associateGateSequence(
        tap,
        [gate[0]!, gate[1]!, gate[1]!, ...gate.slice(2)],
        7
      )
    ).toThrow();
    expect(() =>
      associateGateSequence(tap, [gate[1]!, gate[0]!, ...gate.slice(2)], 7)
    ).toThrow();
  });
  test('accepts successive frozen labels and exact native/carrier samples', () => {
    const { tap, gate } = fixture();
    const a = associateGateSequence(tap, gate, 7);
    expect(a.start).toBe(0);
    assertAssociatedSamples(tap, gate, a.start, 100, 108);
  });
  test('accepts a repeated label at a chunk boundary when flattened', () => {
    const { tap, gate } = fixture([10, 11, 11, 13]);
    const a = associateGateSequence(tap, gate, 7);
    assertAssociatedSamples(tap, gate, a.start, 100, 108);
  });
  test('rejects a constant carrier displacement', () => {
    const { tap, gate } = fixture();
    const shifted = tap.map((q) => ({
      ...q,
      carrier: q.carrier.map((x) => (x === null ? null : x + 128)),
    }));
    const a = associateGateSequence(shifted, gate, 7);
    expect(() =>
      assertAssociatedSamples(shifted, gate, a.start, 100, 108)
    ).toThrow();
  });
  test('rejects wrong epoch, missing, duplicated and reordered quanta', () => {
    const { tap, gate } = fixture();
    expect(() => associateGateSequence(tap, gate, 8)).toThrow();
    expect(() =>
      associateGateSequence([tap[0]!, ...tap.slice(2)], gate, 7)
    ).toThrow();
    expect(() =>
      associateGateSequence(
        [tap[0]!, tap[1]!, tap[1]!, ...tap.slice(2)],
        gate,
        7
      )
    ).toThrow();
    expect(() =>
      associateGateSequence([tap[1]!, tap[0]!, ...tap.slice(2)], gate, 7)
    ).toThrow();
  });
  test('rejects corrupt native frame or tag and missing carrier', () => {
    const { tap, gate } = fixture();
    const a = associateGateSequence(tap, gate, 7);
    expect(() =>
      assertAssociatedSamples(
        tap,
        [{ ...gate[0]!, frames: [1, 1] }, ...gate.slice(1)],
        a.start,
        100,
        108
      )
    ).toThrow();
    expect(() =>
      assertAssociatedSamples(
        tap,
        [{ ...gate[0]!, tags: [8] }, ...gate.slice(1)],
        a.start,
        100,
        108
      )
    ).toThrow();
    expect(() =>
      assertAssociatedSamples(
        [{ ...tap[0]!, carrier: [null, 101] }, ...tap.slice(1)],
        gate,
        a.start,
        100,
        108
      )
    ).toThrow();
  });
  test('rejects ambiguous cached-label association', () => {
    const { tap, gate } = fixture([10, 10, 10, 10]);
    expect(() => associateGateSequence(tap, gate.slice(0, 2), 7)).toThrow(
      'uniquely aligned'
    );
  });
});
