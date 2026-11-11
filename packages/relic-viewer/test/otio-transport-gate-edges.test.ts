import { describe, expect, test } from 'bun:test';
import {
  TAG_STEP_LEAD_SAMPLES,
  bankTagEdgeTimes,
} from '../src/otio-transport-gate';

// Frames per bank span and step, from the transport clock layout.
const SPAN = 65536;
const STEP = 32768;

type Bank = { serial: number; startFrame: number; endFrame: number };
type Edges = { start: number; end: number };

// Engine model, inferred from receipts: a step applies at the first sample at or
// after its time. 34048, 66816 and 132352 round-trip exactly at 48 kHz; 99584 does not.
const firstSampleAtOrAfter = (time: number, sampleRate: number): number =>
  Math.ceil(time * sampleRate);

// The schedule before the quarter-sample lead: exact conversions of the frame edges.
const originalEdges = (bank: Bank, sampleRate: number): Edges => ({
  start: bank.startFrame / sampleRate,
  end: bank.endFrame / sampleRate,
});

const stepsFor = (bank: Bank, edges: Edges, sampleRate: number) => [
  { frame: firstSampleAtOrAfter(edges.start, sampleRate), value: bank.serial },
  { frame: firstSampleAtOrAfter(edges.end, sampleRate), value: 0 },
];

// The rendered tag for a sample: the last step applied at or before it, else the held value.
const tagAtSample = (
  sample: number,
  steps: { frame: number; value: number }[],
  held: number
): number => {
  let value = held;
  for (const step of steps) if (step.frame <= sample) value = step.value;
  return value;
};

// Previous serial holds before the bank, the bank's serial from its first frame through
// its last, and resets to zero on its end sample.
const expectTagAligned = (bank: Bank, edges: Edges, sampleRate: number) => {
  const steps = stepsFor(bank, edges, sampleRate);
  const held = bank.serial - 1;
  expect(tagAtSample(bank.startFrame - 1, steps, held)).toBe(held);
  expect(tagAtSample(bank.startFrame, steps, held)).toBe(bank.serial);
  expect(tagAtSample(bank.endFrame - 1, steps, held)).toBe(bank.serial);
  expect(tagAtSample(bank.endFrame, steps, held)).toBe(0);
};

// Stands in for an AudioParam: setValueAtTime rejects a negative time as the engine does.
class FakeAudioParam {
  readonly events: { time: number; value: number }[] = [];
  setValueAtTime(value: number, time: number): void {
    if (time < 0) throw new RangeError(`negative automation time ${time}`);
    this.events.push({ time, value });
  }
}

describe('transport bank tag edges', () => {
  const bank4: Bank = { serial: 4, startFrame: 99584, endFrame: 99584 + SPAN };

  test('at 48 kHz the serial 4 tag switches on sample 99584', () => {
    expectTagAligned(bank4, bankTagEdgeTimes(bank4, 48000), 48000);
  });

  test('the original unshifted schedule fails the same check at 48 kHz', () => {
    // Negative control: 99584 / 48000 * 48000 rounds above 99584, so the switch lands on 99585.
    expect(() =>
      expectTagAligned(bank4, originalEdges(bank4, 48000), 48000)
    ).toThrow();
  });

  test('the previous bank resets to zero on its own end sample', () => {
    const bank2: Bank = { serial: 2, startFrame: 34048, endFrame: 99584 };
    expectTagAligned(bank2, bankTagEdgeTimes(bank2, 48000), 48000);
    expect(() =>
      expectTagAligned(bank2, originalEdges(bank2, 48000), 48000)
    ).toThrow();
  });

  test('frame zero: the first bank schedules a non-negative tag start and switches on sample 0', () => {
    const bank0: Bank = { serial: 1, startFrame: 0, endFrame: SPAN };
    const edges = bankTagEdgeTimes(bank0, 48000);
    expect(edges.start).toBeGreaterThanOrEqual(0);
    expect(edges.end).toBeGreaterThanOrEqual(0);
    const tag = new FakeAudioParam();
    expect(() => {
      tag.setValueAtTime(bank0.serial, edges.start);
      tag.setValueAtTime(0, edges.end);
    }).not.toThrow();
    const steps = stepsFor(bank0, edges, 48000);
    expect(tagAtSample(0, steps, 0)).toBe(1);
    expect(tagAtSample(bank0.endFrame - 1, steps, 0)).toBe(1);
    expect(tagAtSample(bank0.endFrame, steps, 0)).toBe(0);
  });

  test('negative control: the unclamped lead at frame zero throws on the fake parameter', () => {
    const unclampedStart = (0 - TAG_STEP_LEAD_SAMPLES) / 48000;
    const tag = new FakeAudioParam();
    expect(() => tag.setValueAtTime(1, unclampedStart)).toThrow(RangeError);
  });

  for (const sampleRate of [44100, 48000]) {
    test(`every consecutive bank edge is sample aligned at ${sampleRate} Hz`, () => {
      for (let serial = 2; serial <= 2002; serial++) {
        const startFrame = 34048 + (serial - 2) * STEP;
        const bank: Bank = { serial, startFrame, endFrame: startFrame + SPAN };
        expectTagAligned(bank, bankTagEdgeTimes(bank, sampleRate), sampleRate);
      }
    });
  }

  test('the consecutive sweep discriminates: the original schedule misaligns some bank at 48 kHz', () => {
    let misaligned = 0;
    for (let serial = 2; serial <= 2002; serial++) {
      const startFrame = 34048 + (serial - 2) * STEP;
      const bank: Bank = { serial, startFrame, endFrame: startFrame + SPAN };
      try {
        expectTagAligned(bank, originalEdges(bank, 48000), 48000);
      } catch {
        misaligned++;
      }
    }
    expect(misaligned).toBeGreaterThan(0);
  });
});
