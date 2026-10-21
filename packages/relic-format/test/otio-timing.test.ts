import { describe, expect, test } from 'bun:test';
import {
  addRationalTimes,
  compareRationalTimes,
  evaluateOtioAt,
  intersectRanges,
  markersForOtioTimeline,
  rangeContainsTime,
  rescaleTime,
  secondsToTime,
  sourceSpansForOtioRange,
  subtractRationalTimes,
  timeToSeconds,
} from '../src/otio-timing.ts';
import { readOtioDocument } from '../src/otio-identity.ts';
import type { OtioRationalTime, OtioTimeRange } from '../src/otio-types.ts';

describe('otio-timing rational arithmetic and mixed rates', () => {
  test('timeToSeconds throws on zero or non-finite rate', () => {
    expect(() => timeToSeconds({ value: 10, rate: 0 })).toThrow(TypeError);
    expect(() => timeToSeconds({ value: 10, rate: NaN })).toThrow(TypeError);
    expect(() => timeToSeconds({ value: Infinity, rate: 24 })).toThrow(
      TypeError
    );
  });

  test('secondsToTime preserves fractional mixed rates without rounding', () => {
    const time = secondsToTime(1.001, 30000 / 1001);
    expect(time.value).toBeCloseTo(30, 5);
    expect(time.rate).toBeCloseTo(30000 / 1001, 5);
  });

  test('rescaleTime converts between 24fps and 30000/1001 accurately', () => {
    const time24: OtioRationalTime = { value: 24, rate: 24 };
    const time2997 = rescaleTime(time24, 30000 / 1001);
    expect(time2997.value).toBeCloseTo(30000 / 1001, 5);
    expect(time2997.rate).toBeCloseTo(30000 / 1001, 5);
  });

  test('compareRationalTimes handles mixed rates and equality within epsilon', () => {
    const a: OtioRationalTime = { value: 24, rate: 24 };
    const b: OtioRationalTime = { value: 30, rate: 30 };
    expect(compareRationalTimes(a, b)).toBe(0);

    const c: OtioRationalTime = { value: 25, rate: 24 };
    expect(compareRationalTimes(c, a)).toBe(1);
  });

  test('add and subtract rational times with mixed rates', () => {
    const a: OtioRationalTime = { value: 12, rate: 24 };
    const b: OtioRationalTime = { value: 15, rate: 30 };
    const sum = addRationalTimes(a, b);
    expect(sum.value).toBeCloseTo(24, 5);
    expect(sum.rate).toBe(24);

    const diff = subtractRationalTimes(a, b);
    expect(diff.value).toBeCloseTo(0, 5);
  });

  test('rangeContainsTime handles half-open intervals and zero-duration points', () => {
    const range: OtioTimeRange = {
      start_time: { value: 10, rate: 24 },
      duration: { value: 10, rate: 24 },
    };
    expect(rangeContainsTime(range, { value: 10, rate: 24 })).toBe(true);
    expect(rangeContainsTime(range, { value: 19, rate: 24 })).toBe(true);
    expect(rangeContainsTime(range, { value: 20, rate: 24 })).toBe(false);

    const point: OtioTimeRange = {
      start_time: { value: 10, rate: 24 },
      duration: { value: 0, rate: 24 },
    };
    expect(rangeContainsTime(point, { value: 10, rate: 24 })).toBe(true);
    expect(rangeContainsTime(point, { value: 11, rate: 24 })).toBe(false);
  });

  test('intersectRanges handles point inside non-zero range correctly', () => {
    const range: OtioTimeRange = {
      start_time: { value: 0, rate: 24 },
      duration: { value: 100, rate: 24 },
    };
    const point: OtioTimeRange = {
      start_time: { value: 50, rate: 24 },
      duration: { value: 0, rate: 24 },
    };
    const intersection = intersectRanges(range, point);
    expect(intersection).not.toBeNull();
    expect(intersection?.start_time.value).toBe(50);
    expect(intersection?.duration.value).toBe(0);
  });
});

describe('otio-timing evaluator and source spans', () => {
  const timelineJson = JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Test Timeline',
    metadata: { relic: { id: 'timeline_1' } },
    global_start_time: { value: 86400, rate: 24 },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Video 1',
          kind: 'Video',
          metadata: { relic: { id: 'track_v1' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Clip A',
              metadata: { relic: { id: 'clip_a' } },
              source_range: {
                start_time: { value: 48, rate: 24 },
                duration: { value: 72, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/primary_a.mp4',
                available_range: {
                  start_time: { value: 24, rate: 24 },
                  duration: { value: 240, rate: 24 },
                },
              },
            },
            {
              OTIO_SCHEMA: 'Transition.1',
              name: 'Dissolve',
              transition_type: 'SMPTE_Dissolve',
              in_offset: { value: 12, rate: 24 },
              out_offset: { value: 12, rate: 24 },
            },
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Clip B',
              metadata: { relic: { id: 'clip_b' } },
              source_range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 96, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/secondary_b.mp4',
              },
            },
          ],
        },
      ],
    },
  });

  test('readOtioDocument parses Timeline.tracks Stack object and assigns identities', () => {
    const doc = readOtioDocument(timelineJson);
    expect(doc.timeline_ids.length).toBe(1);
    const timelineId = doc.timeline_ids[0] as string;
    const timelineNode = doc.nodes[timelineId];
    expect(timelineNode?.schema).toBe('Timeline.1');
    expect(timelineNode?.children_ids.length).toBe(1);

    const stackId = timelineNode?.children_ids[0] as string;
    const stackNode = doc.nodes[stackId];
    expect(stackNode?.schema).toBe('Stack.1');
    expect(stackNode?.children_ids.length).toBe(1);

    const trackId = stackNode?.children_ids[0] as string;
    const trackNode = doc.nodes[trackId];
    expect(trackNode?.id).toBe('track_v1');
    expect(trackNode?.children_ids.length).toBe(3);
  });

  test('evaluateOtioAt computes file-relative source time subtracting available_range.start_time', () => {
    const doc = readOtioDocument(timelineJson);
    const timelineId = doc.timeline_ids[0] as string;

    // At t=36 (1.5s), Clip A is active (parent range [0, 72))
    // source_range.start_time = 48, offset = 36, sourceTime = 84
    // available_range.start_time = 24, file-relative = 84 - 24 = 60
    const evalResult = evaluateOtioAt(doc, timelineId, { value: 36, rate: 24 });
    expect(evalResult.video_contributions.length).toBe(1);
    const contrib = evalResult.video_contributions[0];
    expect(contrib?.node_id).toBe('clip_a');
    expect(contrib?.source_time.value).toBeCloseTo(60, 5);
    expect(contrib?.bundle_path).toBe('media/primary_a.mp4');
  });

  test('evaluateOtioAt computes transition weights during SMPTE_Dissolve', () => {
    const doc = readOtioDocument(timelineJson);
    const timelineId = doc.timeline_ids[0] as string;

    // Transition edit point at frame 72. in_offset=12, out_offset=12.
    // Transition range: [60, 84).
    // At t=72 (edit point), progress = (72-60)/(84-60) = 0.5
    const evalResult = evaluateOtioAt(doc, timelineId, { value: 72, rate: 24 });
    expect(evalResult.video_contributions.length).toBe(2);

    const outClip = evalResult.video_contributions.find(
      (c) => c.node_id === 'clip_a'
    );
    const inClip = evalResult.video_contributions.find(
      (c) => c.node_id === 'clip_b'
    );

    expect(outClip?.transition_weight).toBeCloseTo(0.5, 5);
    expect(inClip?.transition_weight).toBeCloseTo(0.5, 5);
    expect(outClip?.transition_type).toBe('SMPTE_Dissolve');
  });

  test('sourceSpansForOtioRange returns clips, the transition, and handles', () => {
    const doc = readOtioDocument(timelineJson);
    const timelineId = doc.timeline_ids[0] as string;

    const spans = sourceSpansForOtioRange(doc, timelineId, 'track_v1', {
      start_time: { value: 60, rate: 24 },
      duration: { value: 30, rate: 24 },
    });

    const transition = spans.find((span) => span.schema === 'Transition.1');
    expect(transition).toBeDefined();
    if (!transition) throw new Error('expected transition source span');
    expect(spans.map((span) => span.node_id).sort()).toEqual([
      'clip_a',
      'clip_b',
      transition.node_id,
    ].sort());

    const clipA = spans.find((span) => span.node_id === 'clip_a');
    const clipB = spans.find((span) => span.node_id === 'clip_b');

    expect(clipA?.intersected_timeline_range.start_time.value).toBeCloseTo(60, 5);
    expect(clipA?.intersected_timeline_range.duration.value).toBeCloseTo(24, 5);
    expect(clipA?.file_relative_source_range?.start_time.value).toBeCloseTo(84, 5);
    expect(clipA?.file_relative_source_range?.duration.value).toBeCloseTo(24, 5);
    expect(clipA?.source_mapping?.scalar).toBe(1);

    expect(clipB?.intersected_timeline_range.start_time.value).toBeCloseTo(60, 5);
    expect(clipB?.intersected_timeline_range.duration.value).toBeCloseTo(30, 5);
    expect(clipB?.source_range?.start_time.value).toBeCloseTo(-12, 5);
    expect(clipB?.diagnostics.some((item) => item.code === 'missing-handles')).toBe(true);

    expect(transition?.intersected_timeline_range.start_time.value).toBeCloseTo(60, 5);
    expect(transition?.intersected_timeline_range.duration.value).toBeCloseTo(24, 5);
  });

  test('projects legacy Marker.1 time only when canonical timing is absent or null', () => {
    const doc = readOtioDocument(JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata: { relic: { id: 'timeline' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [{
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track' } },
          children: [{
            OTIO_SCHEMA: 'Clip.1',
            metadata: { relic: { id: 'clip' } },
            source_range: {
              start_time: { value: 10, rate: 24 },
              duration: { value: 24, rate: 24 },
            },
            media_reference: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: 'media/clip.mov',
              available_range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 48, rate: 24 },
              },
            },
            markers: [
              {
                OTIO_SCHEMA: 'Marker.1',
                name: 'legacy point',
                time: { value: 12, rate: 24 },
              },
              {
                OTIO_SCHEMA: 'Marker.1',
                name: 'null canonical',
                marked_range: null,
                time: { value: 13, rate: 24 },
              },
              {
                OTIO_SCHEMA: 'Marker.1',
                name: 'canonical wins',
                marked_range: {
                  start_time: { value: 14, rate: 24 },
                  duration: { value: 2, rate: 24 },
                },
                time: { value: 12, rate: 24 },
              },
              {
                OTIO_SCHEMA: 'Marker.1',
                name: 'invalid canonical',
                marked_range: {
                  start_time: { value: 'invalid', rate: 24 },
                  duration: { value: 0, rate: 24 },
                },
                time: { value: 12, rate: 24 },
              },
              {
                OTIO_SCHEMA: 'Marker.2',
                name: 'not a legacy fallback',
                time: { value: 12, rate: 24 },
              },
            ],
          }],
        }],
      },
    }));
    const timelineId = doc.timeline_ids[0];
    const clipNode = doc.nodes['clip'];
    if (!timelineId || !clipNode) throw new Error('expected timeline and clip');
    const [legacy, nullCanonical, canonical, invalidCanonical, markerTwo] = clipNode.markers ?? [];
    if (!legacy || !nullCanonical || !canonical || !invalidCanonical || !markerTwo) {
      throw new Error('expected all parsed markers');
    }

    expect(legacy.marked_range).toEqual({
      start_time: { value: 12, rate: 24 },
      duration: { value: 0, rate: 24 },
    });
    expect(nullCanonical.marked_range).toEqual({
      start_time: { value: 13, rate: 24 },
      duration: { value: 0, rate: 24 },
    });
    expect(canonical.marked_range).toEqual({
      start_time: { value: 14, rate: 24 },
      duration: { value: 2, rate: 24 },
    });
    expect(invalidCanonical.marked_range).toBeNull();
    expect(invalidCanonical.raw).toEqual(expect.objectContaining({
      time: { value: 12, rate: 24 },
    }));
    expect(markerTwo.marked_range).toBeNull();
    expect(clipNode.diagnostics?.some((item) => item.code === 'invalid-timing')).toBe(true);

    const projected = markersForOtioTimeline(doc, timelineId);
    expect(projected.map((item) => item.marker.name)).toEqual([
      'legacy point',
      'null canonical',
      'canonical wins',
    ]);
    const legacyProjection = projected[0];
    const nullCanonicalProjection = projected[1];
    const canonicalProjection = projected[2];
    if (!legacyProjection || !nullCanonicalProjection || !canonicalProjection) {
      throw new Error('expected projected legacy and canonical markers');
    }
    expect(legacyProjection.timeline_range).toEqual({
      start_time: { value: 2, rate: 24 },
      duration: { value: 0, rate: 24 },
    });
    expect(nullCanonicalProjection.timeline_range).toEqual({
      start_time: { value: 3, rate: 24 },
      duration: { value: 0, rate: 24 },
    });
    expect(canonicalProjection.timeline_range).toEqual({
      start_time: { value: 4, rate: 24 },
      duration: { value: 2, rate: 24 },
    });
  });
});
