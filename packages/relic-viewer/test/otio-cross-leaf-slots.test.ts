import { describe, expect, test } from 'bun:test';
import {
  phaseBandMs,
  planOtioCausalEpoch,
  requiredResidentSlots,
  type DecoderPhaseSample,
} from '../src/otio-video-decoders.ts';

const VSYNC_60 = 1 / 60;
const W_30 = 1 / 30;
const LEAD_SECONDS = 0.041;

// Two drawn leaves at 30 fps. Selection waits for both first advanced frames,
// so the earliest epoch trails the slower leaf's capture (dL = 30 ms) by the
// measured lead: 30 + 41 = 71 ms. Leaf A's frame arrives at 5 ms.
const leafA = { dL: 5, offsetSeconds: 0.005 };
const leafB = { dL: 30, offsetSeconds: 0.03 };
const EARLIEST_EPOCH_MS = 71;

function sampleFor(
  leaf: { dL: number; offsetSeconds: number },
  residentSlots: number
): DecoderPhaseSample {
  return {
    dL: leaf.dL,
    iL0Plus1Start: leaf.offsetSeconds,
    sourceT0Seconds: 0,
    rL: 1,
    wMinSeconds: W_30,
    residentSlots,
  };
}

describe('ring sizing covers the slowest leaf to arrive', () => {
  test('sizing each leaf by its own offset leaves the earliest epoch outside leaf A', () => {
    const perLeaf = [leafA, leafB].map((leaf) =>
      requiredResidentSlots({
        leadSeconds: LEAD_SECONDS,
        vsyncSeconds: VSYNC_60,
        offsetSeconds: leaf.offsetSeconds,
        wMinSeconds: W_30,
      })
    );
    expect(perLeaf).toEqual([3, 4]);
    const upperA = phaseBandMs(sampleFor(leafA, perLeaf[0]!), VSYNC_60).upper;
    expect(upperA).toBeLessThan(EARLIEST_EPOCH_MS);
  });

  test('sizing every leaf to the slowest arrival places the earliest epoch in every band', () => {
    const slowest = Math.max(leafA.offsetSeconds, leafB.offsetSeconds);
    const shared = requiredResidentSlots({
      leadSeconds: LEAD_SECONDS,
      vsyncSeconds: VSYNC_60,
      offsetSeconds: slowest,
      wMinSeconds: W_30,
    });
    expect(shared).toBe(4);
    if (shared === null) throw new Error('slot sizing failed');
    for (const leaf of [leafA, leafB]) {
      const band = phaseBandMs(sampleFor(leaf, shared), VSYNC_60);
      expect(band.lower).toBeLessThanOrEqual(EARLIEST_EPOCH_MS);
      expect(band.upper).toBeGreaterThanOrEqual(EARLIEST_EPOCH_MS);
    }
  });

  test('a mapping allowance widens the required slots when it is added to the lead', () => {
    const withoutAllowance = requiredResidentSlots({
      leadSeconds: LEAD_SECONDS,
      vsyncSeconds: VSYNC_60,
      offsetSeconds: 0.03,
      wMinSeconds: W_30,
    });
    const withAllowance = requiredResidentSlots({
      leadSeconds: LEAD_SECONDS + 0.04,
      vsyncSeconds: VSYNC_60,
      offsetSeconds: 0.03,
      wMinSeconds: W_30,
    });
    expect(withAllowance!).toBeGreaterThan(withoutAllowance!);
  });
});

describe('a refused epoch is labelled a ring shortage only past the band upper edge', () => {
  const bridge = {
    contextTime: 0,
    performanceTime: 0,
    mappingAllowanceMs: 0,
  };
  // The earliest guarded epoch lands at 1153.8 ms in these fixtures.
  const contextNow = 54870.4 / 48000;

  test('three slots: the earliest guarded epoch is past the upper edge, so the plan is slot-limited', () => {
    const sample = {
      dL: 1100,
      iL0Plus1Start: 0.036,
      sourceT0Seconds: 0,
      rL: 1,
      wMinSeconds: W_30,
      residentSlots: 3,
    };
    const plan = planOtioCausalEpoch(
      [sample],
      VSYNC_60,
      bridge,
      48000,
      contextNow,
      1100,
      1100,
      512
    );
    expect(plan.epoch).toBeNull();
    expect(plan.earliestWall).toBeCloseTo(1153.8, 1);
    expect(plan.upperWall).not.toBeNull();
    expect(plan.earliestWall! + bridge.mappingAllowanceMs).toBeGreaterThan(
      plan.upperWall!
    );
  });

  test('four slots: the same earliest epoch is placed, so no refusal is reported', () => {
    const sample = {
      dL: 1100,
      iL0Plus1Start: 0.036,
      sourceT0Seconds: 0,
      rL: 1,
      wMinSeconds: W_30,
      residentSlots: 4,
    };
    const plan = planOtioCausalEpoch(
      [sample],
      VSYNC_60,
      bridge,
      48000,
      contextNow,
      1100,
      1100,
      512
    );
    expect(plan.epoch).not.toBeNull();
    expect(plan.earliestWall).toBeCloseTo(1153.8, 1);
  });

  test('unusable input has no evidence, so it cannot be labelled a ring shortage', () => {
    const sample = {
      dL: 1100,
      iL0Plus1Start: 0.036,
      sourceT0Seconds: 0,
      rL: 1,
      wMinSeconds: W_30,
      residentSlots: 3,
    };
    const plan = planOtioCausalEpoch(
      [sample],
      VSYNC_60,
      bridge,
      48000,
      Number.NaN,
      1100,
      1100,
      512
    );
    expect(plan.epoch).toBeNull();
    expect(plan.earliestWall).toBeNull();
    expect(plan.upperWall).toBeNull();
  });
});

describe('recovery readiness follows the held slot count', () => {
  test('a 60 fps ring holding seven slots accepts a clock four windows past the 3-slot edge', () => {
    const w60 = 1 / 60;
    const base = {
      dL: 1000,
      iL0Plus1Start: 0.01,
      sourceT0Seconds: 0,
      rL: 1,
      wMinSeconds: w60,
    };
    const threeSlot = phaseBandMs(
      { ...base, residentSlots: 3 },
      VSYNC_60
    ).upper;
    const sevenSlot = phaseBandMs(
      { ...base, residentSlots: 7 },
      VSYNC_60
    ).upper;
    expect(sevenSlot - threeSlot).toBeCloseTo(4 * w60 * 1000, 6);
    // A moment between the two edges is refused by a 3-slot check and accepted
    // by the band the ring actually holds.
    const instant = threeSlot + 10;
    expect(instant).toBeGreaterThan(threeSlot);
    expect(instant).toBeLessThanOrEqual(sevenSlot);
  });
});
