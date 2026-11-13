import { describe, expect, test } from 'bun:test';
import { OtioTransportGateState as GateState } from '../src/otio-transport-gate-state';

// Legacy state cases exercise slot zero; dedicated cases below use the raw state.
class OtioTransportGateState extends GateState {
  override command(raw: unknown, now: number, coverage?: number) {
    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'arm')
      return super.command({ slot: 0, ...raw }, now, coverage);
    return super.command(raw, now, coverage);
  }
}

function block(
  gate: OtioTransportGateState,
  start: number,
  length: number
): number[] {
  const input = Float32Array.from({ length }, (_, i) => start + i + 1);
  const output = new Float32Array(length);
  gate.render([[input], [], []], [output], start);
  gate.expire(start + length);
  return Array.from(output);
}

describe('render-thread transport gate', () => {
  test('isolates authored slots and never emits the bootstrap carrier', () => {
    const gate = new GateState(7);
    const output = [new Float32Array(4)];
    const inputs = [
      [new Float32Array(4).fill(1)],
      [new Float32Array(4).fill(9)],
      [new Float32Array(4).fill(2)],
    ];
    gate.render(inputs, output, 0);
    expect(Array.from(output[0]!)).toEqual([0, 0, 0, 0]);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 7,
          generation: 1,
          sequence: 1,
          f0: 2,
          throughFrame: 6,
          slot: 0,
        },
        0
      ).accepted
    ).toBe(true);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 7,
          generation: 2,
          sequence: 2,
          f0: 3,
          throughFrame: 9,
          slot: 1,
        },
        0
      ).accepted
    ).toBe(false);
    gate.render(inputs, output, 0);
    expect(Array.from(output[0]!)).toEqual([0, 0, 1, 1]);
    gate.expire(6);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 7,
          generation: 2,
          sequence: 3,
          f0: 8,
          throughFrame: 12,
          slot: 1,
        },
        6
      ).accepted
    ).toBe(true);
    gate.render(inputs, output, 6);
    expect(Array.from(output[0]!)).toEqual([0, 0, 2, 2]);
    expect(
      gate.command(
        { type: 'abort', clockEpoch: 7, generation: 2, sequence: 4 },
        10
      ).accepted
    ).toBe(true);
    gate.render(inputs, output, 10);
    expect(Array.from(output[0]!)).toEqual([0, 0, 0, 0]);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 7,
          generation: 3,
          sequence: 5,
          f0: 12,
          throughFrame: 16,
          slot: 0,
        },
        10
      ).accepted
    ).toBe(true);
    gate.render(inputs, output, 10);
    expect(Array.from(output[0]!)).toEqual([0, 0, 1, 1]);
  });

  test('rejects missing, malformed, and stale slot commands', () => {
    const gate = new GateState(7);
    for (const [index, slot] of [undefined, null, -1, 2, '0', NaN].entries()) {
      expect(
        gate.command(
          {
            type: 'arm',
            clockEpoch: 7,
            generation: 1,
            sequence: index + 1,
            f0: 0,
            throughFrame: 10,
            slot,
          },
          0
        ).accepted
      ).toBe(false);
    }
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 7,
          generation: 1,
          sequence: 7,
          f0: 0,
          throughFrame: 10,
          slot: 1,
        },
        0
      ).accepted
    ).toBe(true);
    expect(
      gate.command(
        { type: 'abort', clockEpoch: 7, generation: 1, sequence: 8 },
        1
      ).accepted
    ).toBe(true);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 7,
          generation: 1,
          sequence: 9,
          f0: 1,
          throughFrame: 10,
          slot: 0,
        },
        1
      ).accepted
    ).toBe(false);
  });

  test('rejects wrong epochs and frontiers beyond certified coverage', () => {
    const gate = new OtioTransportGateState(17);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 16,
          generation: 1,
          sequence: 1,
          f0: 10,
          throughFrame: 20,
        },
        0,
        20
      ).accepted
    ).toBe(false);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 17,
          generation: 1,
          sequence: 1,
          f0: 10,
          throughFrame: 21,
        },
        0,
        20
      ).accepted
    ).toBe(false);
    expect(
      gate.command(
        {
          type: 'arm',
          clockEpoch: 17,
          generation: 1,
          sequence: 2,
          f0: 10,
          throughFrame: 20,
        },
        0,
        20
      ).accepted
    ).toBe(true);
    expect(
      gate.command(
        {
          type: 'extend',
          clockEpoch: 17,
          generation: 1,
          sequence: 3,
          expectedThroughFrame: 20,
          throughFrame: 21,
        },
        1,
        20
      ).accepted
    ).toBe(false);
    expect(block(gate, 18, 4)).toEqual([19, 20, 0, 0]);
  });

  test('slices the exact prefix and seals without main-thread participation', () => {
    const gate = new OtioTransportGateState();
    expect(
      gate.command(
        { type: 'arm', generation: 1, sequence: 1, f0: 3, throughFrame: 10 },
        0
      ).accepted
    ).toBe(true);
    expect(block(gate, 0, 4)).toEqual([0, 0, 0, 4]);
    expect(block(gate, 4, 4)).toEqual([5, 6, 7, 8]);
    expect(block(gate, 8, 4)).toEqual([9, 10, 0, 0]);
    expect(block(gate, 12, 4)).toEqual([0, 0, 0, 0]);
    for (const command of [
      {
        type: 'extend',
        generation: 1,
        sequence: 2,
        expectedThroughFrame: 10,
        throughFrame: 30,
      },
      { type: 'arm', generation: 1, sequence: 3, f0: 16, throughFrame: 30 },
      {
        type: 'extend',
        generation: 1,
        sequence: 1,
        expectedThroughFrame: 10,
        throughFrame: 30,
      },
    ])
      expect(gate.command(command, 16).accepted).toBe(false);
    expect(block(gate, 16, 4)).toEqual([0, 0, 0, 0]);
  });

  test('rejects an arm whose initial prefix has elapsed', () => {
    const gate = new OtioTransportGateState();
    expect(
      gate.command(
        { type: 'arm', generation: 1, sequence: 1, f0: 100, throughFrame: 200 },
        101
      ).accepted
    ).toBe(false);
    expect(block(gate, 101, 8)).toEqual(Array(8).fill(0));
  });

  test('extension must precede the old frontier and match its expected boundary', () => {
    const gate = new OtioTransportGateState();
    gate.command(
      { type: 'arm', generation: 1, sequence: 1, f0: 0, throughFrame: 8 },
      0
    );
    expect(
      gate.command(
        {
          type: 'extend',
          generation: 1,
          sequence: 2,
          expectedThroughFrame: 7,
          throughFrame: 16,
        },
        4
      ).accepted
    ).toBe(false);
    expect(
      gate.command(
        {
          type: 'extend',
          generation: 1,
          sequence: 3,
          expectedThroughFrame: 8,
          throughFrame: 16,
        },
        4
      ).throughFrame
    ).toBe(16);
    expect(block(gate, 0, 16)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    );
    const late = gate.command(
      {
        type: 'extend',
        generation: 1,
        sequence: 4,
        expectedThroughFrame: 16,
        throughFrame: 24,
      },
      16
    );
    expect(late.accepted).toBe(false);
    expect(late.closedFrame).toBe(16);
  });

  test('same-frame stops join, conflicting stops cannot move the boundary', () => {
    const gate = new OtioTransportGateState();
    gate.command(
      { type: 'arm', generation: 1, sequence: 1, f0: 0, throughFrame: 20 },
      0
    );
    expect(
      gate.command(
        { type: 'stop', generation: 1, sequence: 2, stopFrame: 9 },
        2
      ).accepted
    ).toBe(true);
    expect(
      gate.command(
        { type: 'stop', generation: 1, sequence: 3, stopFrame: 9 },
        3
      ).accepted
    ).toBe(true);
    expect(
      gate.command(
        { type: 'stop', generation: 1, sequence: 4, stopFrame: 10 },
        3
      ).accepted
    ).toBe(false);
    expect(block(gate, 0, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0]);
    expect(
      gate.command(
        { type: 'stop', generation: 1, sequence: 5, stopFrame: 9 },
        12
      ).accepted
    ).toBe(true);
  });

  test('rejects malformed, stale, unsafe, and mismatched commands without opening', () => {
    const gate = new OtioTransportGateState();
    for (const command of [
      null,
      {},
      { type: 'arm', generation: NaN, sequence: 1, f0: 0, throughFrame: 1 },
      { type: 'arm', generation: 1, sequence: 1, f0: 0.5, throughFrame: 1 },
      {
        type: 'arm',
        generation: 1,
        sequence: 2,
        f0: 0,
        throughFrame: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(gate.command(command, 0).accepted).toBe(false);
    }
    expect(
      gate.command(
        { type: 'arm', generation: 2, sequence: 3, f0: 0, throughFrame: 8 },
        0
      ).accepted
    ).toBe(true);
    expect(
      gate.command({ type: 'abort', generation: 1, sequence: 4 }, 1).accepted
    ).toBe(false);
    expect(
      gate.command(
        {
          type: 'extend',
          generation: 2,
          sequence: 4,
          expectedThroughFrame: 8,
          throughFrame: 20,
        },
        1
      ).accepted
    ).toBe(false);
    expect(
      gate.command({ type: 'abort', generation: 2, sequence: 5 }, 2).closedFrame
    ).toBe(2);
    expect(block(gate, 2, 4)).toEqual([0, 0, 0, 0]);
    expect(
      gate.command(
        { type: 'arm', generation: 2, sequence: 6, f0: 4, throughFrame: 8 },
        4
      ).accepted
    ).toBe(false);
    expect(
      gate.command(
        { type: 'arm', generation: 3, sequence: 7, f0: 4, throughFrame: 8 },
        4
      ).accepted
    ).toBe(true);
  });
});
