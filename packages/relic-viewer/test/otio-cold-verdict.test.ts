import { describe, expect, test } from 'bun:test';
import {
  coldEpochVerdict,
  requiredResidentSlots,
} from '../src/otio-video-decoders.ts';
import { DEFAULT_CLOCK_POLICY } from '../src/otio-output-clock.ts';

const current = {
  superseded: false,
  epochPlaced: true,
  ringsHoldTags: true,
  slotLimited: false,
};

describe('a superseded cold start never fails the newer run', () => {
  test('a superseded start that cannot place its epoch returns without failing', () => {
    expect(
      coldEpochVerdict({
        ...current,
        superseded: true,
        epochPlaced: false,
        slotLimited: false,
      })
    ).toBe('superseded');
  });

  test('a superseded start whose calibration failed returns without failing', () => {
    // A clock failure leaves no slot evidence and no placed epoch.
    expect(
      coldEpochVerdict({
        ...current,
        superseded: true,
        epochPlaced: false,
        ringsHoldTags: false,
        slotLimited: false,
      })
    ).toBe('superseded');
  });

  test('a superseded start that is slot-limited still returns without labelling a ring shortage', () => {
    expect(
      coldEpochVerdict({
        ...current,
        superseded: true,
        epochPlaced: false,
        slotLimited: true,
      })
    ).toBe('superseded');
  });

  test('a superseded start with a placed epoch is not treated as placed', () => {
    expect(coldEpochVerdict({ ...current, superseded: true })).toBe(
      'superseded'
    );
  });
});

describe('a current cold start is judged on its own evidence', () => {
  test('a placed epoch with its rings holding their tags is placed', () => {
    expect(coldEpochVerdict(current)).toBe('placed');
  });

  test('a refusal past the band upper edge is a slot-limited refusal', () => {
    expect(
      coldEpochVerdict({ ...current, epochPlaced: false, slotLimited: true })
    ).toBe('refused-slot-limited');
  });

  test('a clock or input failure is an explicit refusal, never a slot shortage', () => {
    expect(
      coldEpochVerdict({ ...current, epochPlaced: false, slotLimited: false })
    ).toBe('refused-explicit');
  });

  test('a placed epoch whose rings lost their tags is an explicit refusal', () => {
    expect(coldEpochVerdict({ ...current, ringsHoldTags: false })).toBe(
      'refused-explicit'
    );
  });
});

describe('ring sizing uses the clock policy bound for the mapping allowance', () => {
  // 60 fps, vsync 1/60 s, the slowest first frame at 30 ms, and a 30 ms lead.
  const vsync = 1 / 60;
  const windowSeconds = 1 / 60;
  const lead = 0.03;
  const slowest = 0.03;

  test('the policy bound requires more slots than the spread observed so far', () => {
    const observedSpread = 0.001;
    const policySpread = DEFAULT_CLOCK_POLICY.maxOffsetSpreadMs / 1000;
    const sizedFromObserved = requiredResidentSlots({
      leadSeconds: lead + observedSpread,
      vsyncSeconds: vsync,
      offsetSeconds: slowest,
      wMinSeconds: windowSeconds,
    });
    const sizedFromPolicy = requiredResidentSlots({
      leadSeconds: lead + policySpread,
      vsyncSeconds: vsync,
      offsetSeconds: slowest,
      wMinSeconds: windowSeconds,
    });
    expect(sizedFromObserved).toBe(6);
    expect(sizedFromPolicy).toBe(7);
    expect(sizedFromPolicy!).toBeGreaterThan(sizedFromObserved!);
  });

  test('the policy bound is the spread a calibrated clock is allowed to report', () => {
    expect(DEFAULT_CLOCK_POLICY.maxOffsetSpreadMs).toBe(10);
  });
});

describe('final-window selection shares the superseded rule', () => {
  const finalWindow = { ringsHoldTags: true, slotLimited: false };

  test('a start superseded while selecting its final window never fails', () => {
    expect(
      coldEpochVerdict({
        ...finalWindow,
        superseded: true,
        epochPlaced: false,
      })
    ).toBe('superseded');
  });

  test('a current final-window start with no epoch fails explicitly', () => {
    expect(
      coldEpochVerdict({
        ...finalWindow,
        superseded: false,
        epochPlaced: false,
      })
    ).toBe('refused-explicit');
  });

  test('a current final-window start with a placed epoch proceeds', () => {
    expect(
      coldEpochVerdict({
        ...finalWindow,
        superseded: false,
        epochPlaced: true,
      })
    ).toBe('placed');
  });
});
