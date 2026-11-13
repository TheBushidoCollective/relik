import { describe, expect, test } from 'bun:test';
import { rangeEndTime, rescaleTime } from '@relic/format';
import {
  otioCompositionTime,
  otioDomainFrames,
  otioLocalTime,
  otioPointerTime,
  otioRangeGeometry,
  type OtioTimelineDomain,
  otioZoomAt,
  otioZoomLimits,
} from '../src/otio-timeline-viewport.ts';

const domain: OtioTimelineDomain = {
  origin: { value: 108, rate: 24 },
  range: {
    start_time: { value: 108, rate: 24 },
    duration: { value: 24, rate: 24 },
  },
  rate: 24,
};

const range = (start: number, duration: number) => ({
  start_time: { value: start, rate: 24 },
  duration: { value: duration, rate: 24 },
});

describe('OTIO display coordinates never replace composition coordinates', () => {
  test('a local 2..6 selection retains the exact nonzero composition origin', () => {
    const canonical = {
      start_time: otioCompositionTime(domain, 2),
      duration: { value: 4, rate: 24 },
    };
    expect(canonical).toEqual(range(110, 4));
    expect(otioLocalTime(domain, canonical.start_time)).toEqual({
      value: 2,
      rate: 24,
    });
    expect(otioLocalTime(domain, rangeEndTime(canonical))).toEqual({
      value: 6,
      rate: 24,
    });
  });

  test('fractional origins and subframe range endpoints are not rounded', () => {
    const fractional = {
      ...domain,
      origin: { value: 108.5, rate: 24 },
      range: range(108.5, 4.25),
    };
    expect(otioCompositionTime(fractional, 2.125)).toEqual({
      value: 110.625,
      rate: 24,
    });
    expect(otioLocalTime(fractional, { value: 110.625, rate: 24 })).toEqual({
      value: 2.125,
      rate: 24,
    });
    expect(otioDomainFrames(fractional)).toEqual({
      start: 0,
      end: 4.25,
      last: 4,
      duration: 4.25,
    });
  });

  test('a mixed-rate origin survives both directions without a seconds round trip', () => {
    const mixed = {
      ...domain,
      origin: { value: 45, rate: 30 },
      range: range(36, 24),
    };
    const original = otioCompositionTime(mixed, 2);
    expect(original).toEqual({ value: 47.5, rate: 30 });
    expect(rescaleTime(original, 24)).toEqual({ value: 38, rate: 24 });
    expect(otioLocalTime(mixed, original)).toEqual({ value: 2, rate: 24 });
  });

  test('revealed handles retain the body origin and signed local time', () => {
    const handles = { ...domain, range: range(102, 36) };
    expect(otioDomainFrames(handles)).toEqual({
      start: -6,
      end: 30,
      last: 29,
      duration: 36,
    });
    expect(otioCompositionTime(handles, -4)).toEqual({ value: 104, rate: 24 });
    expect(otioLocalTime(handles, { value: 104, rate: 24 }).value).toBe(-4);
  });

  test('the already-scrolled rail rect is the only pointer translation', () => {
    const rect = { left: -900, width: 2400 };
    expect(otioPointerTime(domain, 300, rect)).toEqual({
      value: 120,
      rate: 24,
    });
    expect(otioPointerTime(domain, -1000, rect)).toEqual({
      value: 108,
      rate: 24,
    });
    expect(otioPointerTime(domain, 1600, rect)).toEqual({
      value: 132,
      rate: 24,
    });
  });

  test('range geometry crops without mutating the canonical anchor', () => {
    const original = range(100, 12);
    const before = JSON.stringify(original);
    expect(otioRangeGeometry(domain, original)).toEqual({
      left: 0,
      width: 4 / 24,
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(otioRangeGeometry(domain, range(130, 6))).toEqual({
      left: 22 / 24,
      width: 2 / 24,
    });
    expect(otioRangeGeometry(domain, range(60, 12))).toBeUndefined();
  });

  test('half-open points exclude the domain end, but a range may end there', () => {
    expect(otioRangeGeometry(domain, range(132, 0))).toBeUndefined();
    expect(otioRangeGeometry(domain, range(108, 0))).toEqual({
      left: 0,
      width: 0,
    });
    expect(otioRangeGeometry(domain, range(131.5, 0.5))).toEqual({
      left: 23.5 / 24,
      width: 0.5 / 24,
    });
  });

  test('disjoint projection pieces remain disjoint', () => {
    const pieces = [range(106, 4), range(120, 3), range(140, 2)];
    expect(pieces.map((piece) => otioRangeGeometry(domain, piece))).toEqual([
      { left: 0, width: 2 / 24 },
      { left: 12 / 24, width: 3 / 24 },
      undefined,
    ]);
    expect(pieces).toEqual([range(106, 4), range(120, 3), range(140, 2)]);
  });

  test('zoom preserves the time beneath a pointer, not the viewport centre', () => {
    const wide = { ...domain, range: range(108, 240) };
    const viewport = { domain: wide, pixelsPerFrame: 2, scrollLeft: 40 };
    const next = otioZoomAt(viewport, 120, 30, 8);
    expect(next.pixelsPerFrame).toBe(8);
    expect(next.scrollLeft).toBe(250);
    expect((next.scrollLeft + 30) / next.pixelsPerFrame).toBe((40 + 30) / 2);
    expect(viewport.scrollLeft).toBe(40);
  });

  test('Fit is the floor and short clips can still zoom beyond their fitted scale', () => {
    const limits = otioZoomLimits(domain, 480);
    expect(limits.fit).toBe(20);
    expect(limits.maximum).toBeGreaterThan(limits.fit);
    const viewport = { domain, pixelsPerFrame: 20, scrollLeft: 0 };
    expect(otioZoomAt(viewport, 480, 200, 1)).toEqual(viewport);
    expect(otioZoomAt(viewport, 480, 200, 40).pixelsPerFrame).toBe(40);
  });

  test('unrepresentable inspection width is clamped and reports the actual scale', () => {
    const long = { ...domain, range: range(0, 1_000_000_000) };
    const limits = otioZoomLimits(long, 480);
    expect(limits.maximum).toBe(0.008);
    const next = otioZoomAt(
      { domain: long, pixelsPerFrame: limits.fit, scrollLeft: 0 },
      480,
      240,
      16
    );
    expect(next.pixelsPerFrame).toBe(limits.maximum);
    expect(next.pixelsPerFrame * long.range.duration.value).toBe(8_000_000);
  });
});
