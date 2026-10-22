import { describe, expect, test } from 'bun:test';
import { readOtioDocument } from '../src/otio-identity.ts';
import {
  addRationalTimes,
  compareRationalTimes,
  evaluateOtioAt,
  intersectRanges,
  markersForOtioTimeline,
  otioSamplingMap,
  rangeContainsTime,
  rescaleTime,
  sampleOtioMedia,
  secondsToTime,
  sourceSpansForOtioRange,
  subtractRationalTimes,
  timeToSeconds,
} from '../src/otio-timing.ts';
import type {
  OtioDocumentV1,
  OtioMediaEntry,
  OtioNode,
  OtioRationalTime,
  OtioTimeRange,
  OtioVideoComposition,
} from '../src/otio-types.ts';

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

  test('compareRationalTimes orders represented binary64 rationals exactly', () => {
    const cut: OtioRationalTime = { value: 1, rate: 24 };
    expect(compareRationalTimes({ value: 1999, rate: 48000 }, cut)).toBe(-1);
    expect(compareRationalTimes({ value: 2000, rate: 48000 }, cut)).toBe(0);
    expect(compareRationalTimes({ value: 2001, rate: 48000 }, cut)).toBe(1);
    expect(
      compareRationalTimes(
        { value: 40.99999999999999, rate: 30 },
        { value: 41, rate: 30 }
      )
    ).toBe(-1);
    expect(
      compareRationalTimes({ value: 1.5, rate: 3 }, { value: 0.5, rate: 1 })
    ).toBe(0);
    expect(
      compareRationalTimes({ value: 3.75, rate: 7.5 }, { value: 0.5, rate: 1 })
    ).toBe(0);

    const n = 2 ** 27;
    expect(
      compareRationalTimes(
        { value: n, rate: n - 1 },
        { value: n - 1, rate: n - 2 }
      )
    ).toBe(-1);
    expect(
      compareRationalTimes(
        { value: Number.MAX_VALUE, rate: Number.MAX_VALUE },
        { value: Number.MAX_VALUE, rate: Number.MAX_VALUE / 2 }
      )
    ).toBe(-1);
    expect(
      compareRationalTimes(
        { value: Number.MIN_VALUE, rate: Number.MIN_VALUE },
        { value: Number.MIN_VALUE, rate: Number.MIN_VALUE * 2 }
      )
    ).toBe(1);

    const negativeZero: OtioRationalTime = { value: -0, rate: 24 };
    expect(compareRationalTimes(negativeZero, { value: 0, rate: 30 })).toBe(0);
    expect(Object.is(negativeZero.value, -0)).toBe(true);
    expect(
      Number.isNaN(
        compareRationalTimes({ value: 1, rate: 0 }, { value: 1, rate: 24 })
      )
    ).toBe(true);
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
  function timingJson(clipBAvailable = true): string {
    return JSON.stringify({
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
                  ...(clipBAvailable
                    ? {
                        available_range: {
                          start_time: { value: 0, rate: 24 },
                          duration: { value: 96, rate: 24 },
                        },
                      }
                    : {}),
                },
              },
            ],
          },
        ],
      },
    });
  }

  const timelineJson = timingJson();

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

  test('keeps mixed-rate points on the strict side of a one-frame cut', () => {
    const clip = (id: string, sourceStart: number) => ({
      OTIO_SCHEMA: 'Clip.1',
      metadata: { relic: { id } },
      source_range: {
        start_time: { value: sourceStart, rate: 24 },
        duration: { value: 1, rate: 24 },
      },
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: `media/${id}.mov`,
        available_range: {
          start_time: { value: 0, rate: 24 },
          duration: { value: 1000, rate: 24 },
        },
      },
    });
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline-boundary' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              kind: 'Video',
              metadata: { relic: { id: 'track-boundary' } },
              children: [
                clip('clip-boundary-a', 100),
                clip('clip-boundary-b', 200),
              ],
            },
          ],
        },
      })
    );
    const before: OtioTimeRange = {
      start_time: { value: 1999, rate: 48000 },
      duration: { value: 0, rate: 48000 },
    };
    const atCut: OtioTimeRange = {
      start_time: { value: 2000, rate: 48000 },
      duration: { value: 0, rate: 48000 },
    };
    const firstFrame: OtioTimeRange = {
      start_time: { value: 0, rate: 24 },
      duration: { value: 1, rate: 24 },
    };

    expect(rangeContainsTime(firstFrame, before.start_time)).toBe(true);
    expect(rangeContainsTime(firstFrame, atCut.start_time)).toBe(false);
    expect(
      evaluateOtioAt(
        doc,
        'timeline-boundary',
        before.start_time
      ).video_contributions.map((item) => item.node_id)
    ).toEqual(['clip-boundary-a']);
    expect(
      evaluateOtioAt(
        doc,
        'timeline-boundary',
        atCut.start_time
      ).video_contributions.map((item) => item.node_id)
    ).toEqual(['clip-boundary-b']);

    const beforeSpans = sourceSpansForOtioRange(
      doc,
      'timeline-boundary',
      'track-boundary',
      before
    );
    const cutSpans = sourceSpansForOtioRange(
      doc,
      'timeline-boundary',
      'track-boundary',
      atCut
    );
    expect(beforeSpans.map((span) => span.node_id)).toEqual([
      'clip-boundary-a',
    ]);
    expect(cutSpans.map((span) => span.node_id)).toEqual(['clip-boundary-b']);
    expect(beforeSpans[0]?.source_range?.start_time.value).toBeCloseTo(
      100.9995,
      10
    );
    expect(beforeSpans[0]?.source_range?.start_time.rate).toBe(24);
    expect(
      evaluateOtioAt(doc, 'timeline-boundary', before.start_time)
        .video_contributions[0]?.source_time.value
    ).toBeCloseTo(100.9995, 10);
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
    expect<string | null | undefined>(contrib?.bundle_path).toBe(
      'media/primary_a.mp4'
    );
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
    expect(spans.map((span) => span.node_id).sort()).toEqual(
      ['clip_a', 'clip_b', transition.node_id].sort()
    );

    const clipA = spans.find((span) => span.node_id === 'clip_a');
    const clipB = spans.find((span) => span.node_id === 'clip_b');

    expect(clipA?.intersected_timeline_range.start_time.value).toBeCloseTo(
      60,
      5
    );
    expect(clipA?.intersected_timeline_range.duration.value).toBeCloseTo(24, 5);
    expect(clipA?.file_relative_source_range?.start_time.value).toBeCloseTo(
      84,
      5
    );
    expect(clipA?.file_relative_source_range?.duration.value).toBeCloseTo(
      24,
      5
    );
    expect(clipA?.source_mapping?.scalar).toBe(1);

    expect(clipB?.intersected_timeline_range.start_time.value).toBeCloseTo(
      60,
      5
    );
    expect(clipB?.intersected_timeline_range.duration.value).toBeCloseTo(30, 5);
    expect(clipB?.source_range?.start_time.value).toBeCloseTo(-12, 5);
    expect(
      clipB?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(true);

    expect(clipB?.file_relative_source_range?.start_time.value).toBeCloseTo(
      -12,
      5
    );
    expect(clipB?.file_relative_source_range?.duration.value).toBeCloseTo(
      30,
      5
    );
    expect(clipB?.source_mapping).toEqual({
      timeline_origin: { value: 60, rate: 24 },
      source_origin: { value: -12, rate: 24 },
      scalar: 1,
    });
    expect(
      spans
        .filter((span) =>
          span.diagnostics.some((item) => item.code === 'missing-handles')
        )
        .map((span) => span.node_id)
    ).toEqual(['clip_b']);

    expect(transition?.intersected_timeline_range.start_time.value).toBeCloseTo(
      60,
      5
    );
    expect(transition?.intersected_timeline_range.duration.value).toBeCloseTo(
      24,
      5
    );
  });

  test('projects legacy Marker.1 time only when canonical timing is absent or null', () => {
    const doc = readOtioDocument(
      JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: { relic: { id: 'timeline' } },
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          children: [
            {
              OTIO_SCHEMA: 'Track.1',
              kind: 'Video',
              metadata: { relic: { id: 'track' } },
              children: [
                {
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
                },
              ],
            },
          ],
        },
      })
    );
    const timelineId = doc.timeline_ids[0];
    const clipNode = doc.nodes['clip'];
    if (!timelineId || !clipNode) throw new Error('expected timeline and clip');
    const [legacy, nullCanonical, canonical, invalidCanonical, markerTwo] =
      clipNode.markers ?? [];
    if (
      !legacy ||
      !nullCanonical ||
      !canonical ||
      !invalidCanonical ||
      !markerTwo
    ) {
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
    expect(invalidCanonical.raw).toEqual(
      expect.objectContaining({
        time: { value: 12, rate: 24 },
      })
    );
    expect(markerTwo.marked_range).toBeNull();
    expect(
      clipNode.diagnostics?.some((item) => item.code === 'invalid-timing')
    ).toBe(true);

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

  test('keeps an unknown available range free of missing-handle claims', () => {
    const doc = readOtioDocument(timingJson(false));
    const timelineId = doc.timeline_ids[0] as string;
    const spans = sourceSpansForOtioRange(doc, timelineId, 'track_v1', {
      start_time: { value: 60, rate: 24 },
      duration: { value: 30, rate: 24 },
    });
    const clipB = spans.find((span) => span.node_id === 'clip_b');
    expect(clipB?.source_range).toEqual({
      start_time: { value: -12, rate: 24 },
      duration: { value: 30, rate: 24 },
    });
    expect(
      clipB?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(false);
  });

  test('treats a span ending at availability end as available', () => {
    const makeDocument = (availableEnd: number) =>
      readOtioDocument(
        JSON.stringify({
          OTIO_SCHEMA: 'Timeline.1',
          metadata: { relic: { id: 'timeline-full' } },
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [
              {
                OTIO_SCHEMA: 'Track.1',
                kind: 'Video',
                metadata: { relic: { id: 'track-full' } },
                children: [
                  {
                    OTIO_SCHEMA: 'Clip.1',
                    metadata: { relic: { id: 'clip-full' } },
                    source_range: {
                      start_time: { value: 0, rate: 24 },
                      duration: { value: 24, rate: 24 },
                    },
                    media_reference: {
                      OTIO_SCHEMA: 'ExternalReference.1',
                      target_url: 'media/full.mp4',
                      available_range: {
                        start_time: { value: 0, rate: 24 },
                        duration: { value: availableEnd, rate: 24 },
                      },
                    },
                  },
                ],
              },
            ],
          },
        })
      );
    const full = makeDocument(24);
    const short = makeDocument(23);
    const query = {
      start_time: { value: 0, rate: 24 },
      duration: { value: 24, rate: 24 },
    };
    const fullSpan = sourceSpansForOtioRange(
      full,
      'timeline-full',
      'track-full',
      query
    )[0];
    const shortSpan = sourceSpansForOtioRange(
      short,
      'timeline-full',
      'track-full',
      query
    )[0];

    expect(
      fullSpan?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(false);
    expect(
      shortSpan?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(true);
  });

  test('treats a span ending at availability end as available', () => {
    const makeDocument = (availableEnd: number) =>
      readOtioDocument(
        JSON.stringify({
          OTIO_SCHEMA: 'Timeline.1',
          metadata: { relic: { id: 'timeline-full' } },
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [
              {
                OTIO_SCHEMA: 'Track.1',
                kind: 'Video',
                metadata: { relic: { id: 'track-full' } },
                children: [
                  {
                    OTIO_SCHEMA: 'Clip.1',
                    metadata: { relic: { id: 'clip-full' } },
                    source_range: {
                      start_time: { value: 0, rate: 24 },
                      duration: { value: 24, rate: 24 },
                    },
                    media_reference: {
                      OTIO_SCHEMA: 'ExternalReference.1',
                      target_url: 'media/full.mp4',
                      available_range: {
                        start_time: { value: 0, rate: 24 },
                        duration: { value: availableEnd, rate: 24 },
                      },
                    },
                  },
                ],
              },
            ],
          },
        })
      );
    const full = makeDocument(24);
    const short = makeDocument(23);
    const query = {
      start_time: { value: 0, rate: 24 },
      duration: { value: 24, rate: 24 },
    };
    const fullSpan = sourceSpansForOtioRange(
      full,
      'timeline-full',
      'track-full',
      query
    )[0];
    const shortSpan = sourceSpansForOtioRange(
      short,
      'timeline-full',
      'track-full',
      query
    )[0];

    expect(
      fullSpan?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(false);
    expect(
      shortSpan?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(true);
  });
});
function rangeFromEndpoints(start: number, end: number, rate = 24) {
  return {
    start_time: { value: start, rate },
    duration: { value: end - start, rate },
  };
}

function clipNode(
  id: string,
  name: string,
  sourceStart: number,
  sourceEnd: number,
  availableStart: number,
  availableEnd: number,
  scalar = 1,
  markers?: unknown[]
) {
  return {
    OTIO_SCHEMA: 'Clip.1',
    name,
    metadata: { relic: { id } },
    source_range: rangeFromEndpoints(sourceStart, sourceEnd),
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: `media/${id}.mp4`,
      available_range: rangeFromEndpoints(availableStart, availableEnd),
    },
    effects:
      scalar === 1
        ? []
        : [
            {
              OTIO_SCHEMA: 'LinearTimeWarp.1',
              effect_name: 'LinearTimeWarp',
              time_scalar: scalar,
              enabled: true,
            },
          ],
    ...(markers === undefined ? {} : { markers }),
  };
}

function transitionNode(
  id: string,
  inOffset: number,
  outOffset: number,
  rate = 24
) {
  return {
    OTIO_SCHEMA: 'Transition.1',
    metadata: { relic: { id } },
    transition_type: 'SMPTE_Dissolve',
    in_offset: { value: inOffset, rate },
    out_offset: { value: outOffset, rate },
  };
}

function trackNode(id: string, children: unknown[], sourceRange?: unknown) {
  return {
    OTIO_SCHEMA: 'Track.1',
    kind: 'Video',
    metadata: { relic: { id } },
    ...(sourceRange === undefined ? {} : { source_range: sourceRange }),
    children,
  };
}

function stackNode(
  id: string,
  children: unknown[],
  sourceStart?: number,
  sourceEnd?: number
) {
  return {
    OTIO_SCHEMA: 'Stack.1',
    metadata: { relic: { id } },
    ...(sourceStart === undefined || sourceEnd === undefined
      ? {}
      : { source_range: rangeFromEndpoints(sourceStart, sourceEnd) }),
    children,
  };
}

function timelineWithTrack(
  timelineId: string,
  trackId: string,
  children: unknown[],
  trackSourceRange?: unknown
): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: timelineId } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [trackNode(trackId, children, trackSourceRange)],
    },
  });
}

function requiredNode(document: OtioDocumentV1, id: string): OtioNode {
  const found = document.nodes[id];
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function expectRange(
  value: OtioTimeRange | null | undefined,
  start: number,
  duration: number,
  rate = 24
): void {
  expect(value?.start_time.value).toBeCloseTo(start, 5);
  expect(value?.start_time.rate).toBeCloseTo(rate, 5);
  expect(value?.duration.value).toBeCloseTo(duration, 5);
  expect(value?.duration.rate).toBeCloseTo(rate, 5);
}

function findComposition(
  composition: OtioVideoComposition | null,
  nodeId: string
): OtioVideoComposition | null {
  if (!composition || composition.kind === 'leaf') return null;
  if (composition.node_id === nodeId) return composition;
  if (composition.kind === 'stack') {
    for (const child of composition.children) {
      const found = findComposition(child, nodeId);
      if (found) return found;
    }
    return null;
  }
  for (const branch of composition.branches) {
    const found = findComposition(branch.child, nodeId);
    if (found) return found;
  }
  return null;
}

function documentD1(): string {
  return timelineWithTrack('timeline-d1', 'track-m', [
    clipNode('clip-h', 'H', 0, 24, 0, 48),
    transitionNode('trans-t', 12, 12),
    stackNode(
      'stack-s',
      [trackNode('track-i', [clipNode('clip-x', 'X', 0, 72, 0, 72)])],
      12,
      60
    ),
    clipNode('clip-z', 'Z', 0, 24, 0, 24),
  ]);
}

function documentD2(): string {
  return timelineWithTrack('timeline-d2', 'track-m2', [
    stackNode(
      'stack-s2',
      [
        trackNode('track-j', [
          clipNode('clip-p', 'P', 0, 24, 0, 48),
          transitionNode('trans-u', 12, 12),
          clipNode('clip-q', 'Q', 12, 60, 0, 72),
        ]),
      ],
      18,
      48
    ),
  ]);
}

function documentD3(): string {
  return timelineWithTrack('timeline-d3', 'track-m3', [
    clipNode('clip-head', 'Head', 0, 24, 0, 24),
    stackNode(
      'stack-n',
      [
        trackNode('track-n', [
          clipNode('clip-x', 'X', 0, 72, 0, 72, 1, [
            {
              OTIO_SCHEMA: 'Marker.2',
              name: 'early',
              marked_range: rangeFromEndpoints(0, 6),
            },
            {
              OTIO_SCHEMA: 'Marker.2',
              name: 'late',
              marked_range: rangeFromEndpoints(12, 18),
            },
          ]),
        ]),
      ],
      12,
      60
    ),
    clipNode('clip-tail', 'Tail', 0, 24, 0, 24),
  ]);
}

function reverseDocument(
  scalar: number,
  sourceRange = true,
  sourceDuration = { value: 48, rate: 24 },
  sourceStart = { value: 0, rate: 24 },
  availableStart = { value: 0, rate: 24 },
  availableDuration = { value: 48, rate: 24 }
): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-reverse' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track-reverse' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              metadata: { relic: { id: 'clip-reverse' } },
              ...(sourceRange
                ? {
                    source_range: {
                      start_time: sourceStart,
                      duration: sourceDuration,
                    },
                  }
                : {}),
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/reverse.mp4',
                available_range: {
                  start_time: availableStart,
                  duration: availableDuration,
                },
              },
              effects: [
                {
                  OTIO_SCHEMA: 'LinearTimeWarp.1',
                  effect_name: 'LinearTimeWarp',
                  time_scalar: scalar,
                  enabled: true,
                },
              ],
            },
          ],
        },
      ],
    },
  });
}

function leadingTransitionDocument(
  rate: number,
  trackSourceRange?: OtioTimeRange
): string {
  return timelineWithTrack(
    'timeline-leading',
    'track-leading',
    [
      transitionNode('trans-leading', 6, 12, rate),
      {
        OTIO_SCHEMA: 'Clip.1',
        metadata: { relic: { id: 'clip-leading' } },
        source_range: {
          start_time: { value: 0, rate },
          duration: { value: 48, rate },
        },
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: 'media/leading.mp4',
          available_range: {
            start_time: { value: 0, rate },
            duration: { value: 96, rate },
          },
        },
      },
      transitionNode('trans-trailing', 3, 9, rate),
    ],
    trackSourceRange
  );
}

describe('OTIO nested exposure, reverse intervals, and track availability', () => {
  test('keeps nested dissolve branches visible only through their inherited windows', () => {
    const doc = readOtioDocument(documentD1());
    const timelineId = 'timeline-d1';
    const x = requiredNode(doc, 'clip-x');
    expectRange(x.timeline_range, 24, 48);
    expectRange(x.visible_timeline_range, 12, 60);

    const at18 = evaluateOtioAt(doc, timelineId, { value: 18, rate: 24 });
    expect(at18.video_contributions.map((item) => item.node_id).sort()).toEqual(
      ['clip-h', 'clip-x']
    );
    const h18 = at18.video_contributions.find(
      (item) => item.node_id === 'clip-h'
    );
    const x18 = at18.video_contributions.find(
      (item) => item.node_id === 'clip-x'
    );
    expect(h18?.source_time.value).toBeCloseTo(18, 5);
    expect(h18?.transition_weight).toBeCloseTo(0.75, 5);
    expect(x18?.source_time.value).toBeCloseTo(6, 5);
    expect(x18?.transition_weight).toBeCloseTo(0.25, 5);

    const track = findComposition(at18.video_composition, 'track-m');
    if (!track || track.kind !== 'track')
      throw new Error('expected track-m composition');
    expect(track.transition_id).toBe('trans-t');
    expect(track.branches[0]?.weight).toBeCloseTo(0.75, 5);
    expect(track.branches[0]?.child).toEqual({
      kind: 'leaf',
      contribution_index: 0,
    });
    expect(track.branches[1]?.weight).toBeCloseTo(0.25, 5);
    const stack = track.branches[1]?.child;
    if (!stack || stack.kind !== 'stack')
      throw new Error('expected incoming stack');
    expect(stack.node_id).toBe('stack-s');
    const nestedTrack = findComposition(stack, 'track-i');
    if (!nestedTrack || nestedTrack.kind !== 'track')
      throw new Error('expected nested track');
    expect(nestedTrack.branches[0]?.child).toEqual({
      kind: 'leaf',
      contribution_index: 1,
    });

    const at30 = evaluateOtioAt(doc, timelineId, { value: 30, rate: 24 });
    const h30 = at30.video_contributions.find(
      (item) => item.node_id === 'clip-h'
    );
    const x30 = at30.video_contributions.find(
      (item) => item.node_id === 'clip-x'
    );
    expect(h30?.source_time.value).toBeCloseTo(30, 5);
    expect(h30?.transition_weight).toBeCloseTo(0.25, 5);
    expect(x30?.source_time.value).toBeCloseTo(18, 5);
    expect(x30?.transition_weight).toBeCloseTo(0.75, 5);

    const at36 = evaluateOtioAt(doc, timelineId, { value: 36, rate: 24 });
    expect(at36.video_contributions).toHaveLength(1);
    expect(at36.video_contributions[0]?.node_id).toBe('clip-x');
    expect(at36.video_contributions[0]?.source_time.value).toBeCloseTo(24, 5);
    expect(at36.video_contributions[0]?.transition_weight).toBeCloseTo(1, 5);

    const late = sourceSpansForOtioRange(
      doc,
      timelineId,
      'track-m',
      rangeFromEndpoints(72, 84)
    );
    expect(late.map((span) => span.node_id)).toEqual(['clip-z']);
    expectRange(late[0]?.source_range ?? undefined, 0, 12);

    const early = sourceSpansForOtioRange(
      doc,
      timelineId,
      'track-m',
      rangeFromEndpoints(12, 24)
    );
    expect(early.map((span) => span.node_id).sort()).toEqual([
      'clip-h',
      'clip-x',
      'trans-t',
    ]);
    expectRange(
      early.find((span) => span.node_id === 'clip-h')?.source_range ??
        undefined,
      12,
      12
    );
    expectRange(
      early.find((span) => span.node_id === 'clip-x')?.source_range ??
        undefined,
      0,
      12
    );
  });

  test('keeps nested transition progress on its untrimmed window', () => {
    const doc = readOtioDocument(documentD2());
    const timelineId = 'timeline-d2';
    expectRange(requiredNode(doc, 'trans-u').timeline_range, 0, 18);

    const at0 = evaluateOtioAt(doc, timelineId, { value: 0, rate: 24 });
    const p0 = at0.video_contributions.find(
      (item) => item.node_id === 'clip-p'
    );
    const q0 = at0.video_contributions.find(
      (item) => item.node_id === 'clip-q'
    );
    expect(p0?.source_time.value).toBeCloseTo(18, 5);
    expect(p0?.transition_weight).toBeCloseTo(0.75, 5);
    expect(q0?.source_time.value).toBeCloseTo(6, 5);
    expect(q0?.transition_weight).toBeCloseTo(0.25, 5);

    const at12 = evaluateOtioAt(doc, timelineId, { value: 12, rate: 24 });
    const p12 = at12.video_contributions.find(
      (item) => item.node_id === 'clip-p'
    );
    const q12 = at12.video_contributions.find(
      (item) => item.node_id === 'clip-q'
    );
    expect(p12?.source_time.value).toBeCloseTo(30, 5);
    expect(p12?.transition_weight).toBeCloseTo(0.25, 5);
    expect(q12?.source_time.value).toBeCloseTo(18, 5);
    expect(q12?.transition_weight).toBeCloseTo(0.75, 5);

    const at18 = evaluateOtioAt(doc, timelineId, { value: 18, rate: 24 });
    expect(at18.video_contributions).toHaveLength(1);
    expect(at18.video_contributions[0]?.node_id).toBe('clip-q');
    expect(at18.video_contributions[0]?.source_time.value).toBeCloseTo(24, 5);
  });

  test('nulls an unplaced subtree rather than retaining its nested exposure', () => {
    const document = timelineWithTrack('timeline-unplaced', 'track-root', [
      clipNode('clip-known', 'Known', 0, 24, 0, 24),
      {
        OTIO_SCHEMA: 'Clip.1',
        metadata: { relic: { id: 'clip-unknown' } },
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          target_url: 'media/unknown.mp4',
        },
      },
      stackNode('stack-u', [
        trackNode('track-u', [clipNode('leaf-u', 'Leaf', 0, 24, 0, 24)]),
      ]),
    ]);
    const doc = readOtioDocument(document);
    expect(requiredNode(doc, 'track-root').available_range).toBeNull();
    const stack = requiredNode(doc, 'stack-u');
    expect(
      stack.diagnostics?.some((item) => item.code === 'unplaced-item')
    ).toBe(true);
    for (const id of ['track-u', 'leaf-u']) {
      const node = requiredNode(doc, id);
      expect(Object.hasOwn(node, 'timeline_range')).toBe(true);
      expect(Object.hasOwn(node, 'visible_timeline_range')).toBe(true);
      expect(node.timeline_range).toBeNull();
      expect(node.visible_timeline_range).toBeNull();
    }
  });

  test('clips markers to the nested editorial exposure', () => {
    const doc = readOtioDocument(documentD3());
    const markers = markersForOtioTimeline(doc, 'timeline-d3');
    expect(markers.map((item) => item.marker.name)).toEqual(['late']);
    expectRange(markers[0]?.timeline_range, 24, 6);
  });

  test('uses half-open reverse source extents while retaining exact point samples', () => {
    const doc = readOtioDocument(reverseDocument(-1));
    const full = sourceSpansForOtioRange(
      doc,
      'timeline-reverse',
      'track-reverse',
      rangeFromEndpoints(0, 48)
    )[0];
    const first = sourceSpansForOtioRange(
      doc,
      'timeline-reverse',
      'track-reverse',
      rangeFromEndpoints(0, 12)
    )[0];
    const middle = sourceSpansForOtioRange(
      doc,
      'timeline-reverse',
      'track-reverse',
      rangeFromEndpoints(12, 24)
    )[0];
    const pointZero = sourceSpansForOtioRange(
      doc,
      'timeline-reverse',
      'track-reverse',
      rangeFromEndpoints(0, 0)
    )[0];
    const pointLast = sourceSpansForOtioRange(
      doc,
      'timeline-reverse',
      'track-reverse',
      rangeFromEndpoints(47, 47)
    )[0];

    expectRange(full?.source_range ?? undefined, 0, 48);
    expectRange(full?.file_relative_source_range ?? undefined, 0, 48);
    expect(full?.source_mapping).toEqual({
      timeline_origin: { value: 0, rate: 24 },
      source_origin: { value: 47, rate: 24 },
      scalar: -1,
    });
    expect(
      full?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(false);
    expectRange(first?.source_range ?? undefined, 36, 12);
    expect(first?.source_mapping?.source_origin.value).toBe(47);
    expectRange(middle?.source_range ?? undefined, 24, 12);
    expect(middle?.source_mapping?.source_origin.value).toBe(35);
    expectRange(pointZero?.source_range ?? undefined, 47, 0);
    expectRange(pointLast?.source_range ?? undefined, 0, 0);
  });

  test('uses the measured selection for availability-only and double-speed reverse clips', () => {
    const explicit = readOtioDocument(reverseDocument(-1));
    const availableOnly = readOtioDocument(reverseDocument(-1, false));
    const query = rangeFromEndpoints(0, 48);
    const explicitSpan = sourceSpansForOtioRange(
      explicit,
      'timeline-reverse',
      'track-reverse',
      query
    )[0];
    const availableOnlySpan = sourceSpansForOtioRange(
      availableOnly,
      'timeline-reverse',
      'track-reverse',
      query
    )[0];
    expect(availableOnlySpan?.source_range).toEqual(explicitSpan?.source_range);
    expect(availableOnlySpan?.file_relative_source_range).toEqual(
      explicitSpan?.file_relative_source_range
    );
    expect(availableOnlySpan?.source_mapping).toEqual(
      explicitSpan?.source_mapping
    );

    const doubleSpeed = readOtioDocument(reverseDocument(-2));
    const doubleSpan = sourceSpansForOtioRange(
      doubleSpeed,
      'timeline-reverse',
      'track-reverse',
      rangeFromEndpoints(0, 24)
    )[0];
    expectRange(doubleSpan?.source_range ?? undefined, 0, 48);
    expect(doubleSpan?.source_mapping).toEqual({
      timeline_origin: { value: 0, rate: 24 },
      source_origin: { value: 47, rate: 24 },
      scalar: -2,
    });
  });

  test('preserves reverse sampling under mixed start and duration rates', () => {
    const sourceRate = 30000 / 1001;
    const timelineRate = 24000 / 1001;
    const sourceStart = { value: 100, rate: sourceRate };
    const availableStart = { value: 90, rate: sourceRate };
    const availableDuration = { value: 30, rate: sourceRate };
    const sourceDuration = { value: 10, rate: sourceRate };
    const mixedDuration = { value: 8, rate: timelineRate };
    const explicit = readOtioDocument(
      reverseDocument(
        -1,
        true,
        sourceDuration,
        sourceStart,
        availableStart,
        availableDuration
      )
    );
    const mixed = readOtioDocument(
      reverseDocument(
        -1,
        true,
        mixedDuration,
        sourceStart,
        availableStart,
        availableDuration
      )
    );
    const fullQuery: OtioTimeRange = {
      start_time: { value: 0, rate: timelineRate },
      duration: { value: 8, rate: timelineRate },
    };
    const halfQuery: OtioTimeRange = {
      start_time: { value: 0, rate: timelineRate },
      duration: { value: 4, rate: timelineRate },
    };
    const pointQuery: OtioTimeRange = {
      start_time: { value: 4, rate: timelineRate },
      duration: { value: 0, rate: timelineRate },
    };
    const explicitFull = sourceSpansForOtioRange(
      explicit,
      'timeline-reverse',
      'track-reverse',
      fullQuery
    )[0];
    const mixedFull = sourceSpansForOtioRange(
      mixed,
      'timeline-reverse',
      'track-reverse',
      fullQuery
    )[0];
    const explicitHalf = sourceSpansForOtioRange(
      explicit,
      'timeline-reverse',
      'track-reverse',
      halfQuery
    )[0];
    const explicitPoint = sourceSpansForOtioRange(
      explicit,
      'timeline-reverse',
      'track-reverse',
      pointQuery
    )[0];

    expectRange(explicitFull?.source_range ?? undefined, 100, 10, sourceRate);
    expectRange(
      explicitFull?.file_relative_source_range ?? undefined,
      10,
      10,
      sourceRate
    );
    expect(explicitFull?.source_mapping?.source_origin).toEqual({
      value: 19,
      rate: sourceRate,
    });
    expectRange(explicitHalf?.source_range ?? undefined, 105, 5, sourceRate);
    expectRange(
      explicitHalf?.file_relative_source_range ?? undefined,
      15,
      5,
      sourceRate
    );
    expectRange(explicitPoint?.source_range ?? undefined, 104, 0, sourceRate);
    expectRange(
      explicitPoint?.file_relative_source_range ?? undefined,
      14,
      0,
      sourceRate
    );
    expect(mixedFull?.source_range).toEqual(explicitFull?.source_range);
    expect(mixedFull?.file_relative_source_range).toEqual(
      explicitFull?.file_relative_source_range
    );
    if (!explicitFull?.source_mapping || !mixedFull?.source_mapping) {
      throw new Error('expected reverse source mappings');
    }
    const explicitMapping = explicitFull.source_mapping;
    const mixedMapping = mixedFull.source_mapping;
    expect(mixedMapping.source_origin).toEqual(explicitMapping.source_origin);
    expect(explicitMapping.source_origin).toEqual({
      value: 19,
      rate: sourceRate,
    });
    expect(explicitMapping.scalar).toBe(-1);
    expect(mixedMapping.scalar).toBe(-1);
    expect(explicitMapping.timeline_origin).toEqual(
      explicitFull.intersected_timeline_range.start_time
    );
    expect(mixedMapping.timeline_origin).toEqual(
      mixedFull.intersected_timeline_range.start_time
    );
    expect([sourceRate, timelineRate]).toContain(
      explicitMapping.timeline_origin.rate
    );
    expect([sourceRate, timelineRate]).toContain(
      mixedMapping.timeline_origin.rate
    );
    expect(
      compareRationalTimes(explicitMapping.timeline_origin, {
        value: 0,
        rate: timelineRate,
      })
    ).toBe(0);
    expect(
      compareRationalTimes(mixedMapping.timeline_origin, {
        value: 0,
        rate: timelineRate,
      })
    ).toBe(0);
    expect(
      compareRationalTimes(
        explicitMapping.timeline_origin,
        mixedMapping.timeline_origin
      )
    ).toBe(0);

    for (const [document, clip] of [
      [explicit, requiredNode(explicit, 'clip-reverse')],
      [mixed, requiredNode(mixed, 'clip-reverse')],
    ] as const) {
      const map = otioSamplingMap(clip);
      if (!map) throw new Error('expected bound sampling map');
      expect(map.available_start).toEqual(availableStart);
      for (const [timelineValue, mediaValue, fileValue] of [
        [0, 109, 19],
        [4, 104, 14],
      ] as const) {
        const timelineTime = { value: timelineValue, rate: timelineRate };
        const sampled = sampleOtioMedia(map, timelineTime);
        expect(sampled.rate).toBe(sourceRate);
        expect(
          compareRationalTimes(sampled, {
            value: mediaValue,
            rate: sourceRate,
          })
        ).toBe(0);
        const evaluated = evaluateOtioAt(
          document,
          'timeline-reverse',
          timelineTime
        ).video_contributions.find(
          (contribution) => contribution.node_id === 'clip-reverse'
        );
        if (!evaluated) throw new Error('expected reverse contribution');
        expect(evaluated.source_time.rate).toBe(sourceRate);
        expect(
          compareRationalTimes(evaluated.source_time, {
            value: fileValue,
            rate: sourceRate,
          })
        ).toBe(0);
      }
    }
  });

  test('counts leading transition offsets in natural track availability without moving cuts', () => {
    const doc = readOtioDocument(leadingTransitionDocument(24));
    const timeline = requiredNode(doc, 'timeline-leading');
    const track = requiredNode(doc, 'track-leading');
    const leading = requiredNode(doc, 'trans-leading');
    const clip = requiredNode(doc, 'clip-leading');
    const trailing = requiredNode(doc, 'trans-trailing');
    expectRange(track.available_range, 0, 63);
    expectRange(timeline.timeline_range, 0, 63);
    expectRange(leading.parent_range, -6, 18);
    expectRange(leading.timeline_range, 0, 12);
    expectRange(clip.parent_range, 0, 48);
    expectRange(clip.visible_timeline_range, 0, 57);
    expectRange(trailing.parent_range, 45, 12);

    const at0 = evaluateOtioAt(doc, 'timeline-leading', { value: 0, rate: 24 });
    expect(at0.video_contributions[0]?.node_id).toBe('clip-leading');
    expect(at0.video_contributions[0]?.transition_weight).toBeCloseTo(1 / 3, 5);
    const at12 = evaluateOtioAt(doc, 'timeline-leading', {
      value: 12,
      rate: 24,
    });
    expect(at12.video_contributions[0]?.transition_weight).toBeCloseTo(1, 5);
    const at48 = evaluateOtioAt(doc, 'timeline-leading', {
      value: 48,
      rate: 24,
    });
    expect(at48.video_contributions[0]?.transition_weight).toBeCloseTo(0.75, 5);
    for (const time of [57, 62]) {
      expect(
        evaluateOtioAt(doc, 'timeline-leading', { value: time, rate: 24 })
          .video_contributions
      ).toEqual([]);
    }
  });

  test('keeps leading transition availability and authored track trimming independent at fractional rates', () => {
    const rate = 30000 / 1001;
    const full = readOtioDocument(leadingTransitionDocument(rate));
    const trimmedRange: OtioTimeRange = {
      start_time: { value: 0, rate },
      duration: { value: 24, rate },
    };
    const trimmed = readOtioDocument(
      leadingTransitionDocument(rate, trimmedRange)
    );
    expectRange(
      requiredNode(full, 'track-leading').available_range,
      0,
      63,
      rate
    );
    expectRange(
      requiredNode(full, 'timeline-leading').timeline_range,
      0,
      63,
      rate
    );
    expectRange(
      requiredNode(trimmed, 'track-leading').available_range,
      0,
      63,
      rate
    );
    expectRange(
      requiredNode(trimmed, 'timeline-leading').timeline_range,
      0,
      24,
      rate
    );
  });

  test('keeps unknown leading transition timing from manufacturing a later track range', () => {
    const doc = readOtioDocument(
      timelineWithTrack('timeline-poisoned', 'track-poisoned', [
        {
          OTIO_SCHEMA: 'Transition.1',
          metadata: { relic: { id: 'trans-unknown' } },
          transition_type: 'SMPTE_Dissolve',
        },
        clipNode('clip-after-unknown', 'After unknown', 0, 24, 0, 24),
      ])
    );
    const track = requiredNode(doc, 'track-poisoned');
    const clip = requiredNode(doc, 'clip-after-unknown');
    expect(track.available_range).toBeNull();
    expect(clip.parent_range).toBeNull();
    expect(clip.timeline_range).toBeNull();
    expect(clip.visible_timeline_range).toBeNull();
  });

  test('uses canonical entries for external, sequence, and zero-image media', () => {
    const media = (name: string): Record<string, OtioMediaEntry> => ({
      [name]: { key: name, bundle_path: name, size: 1 },
    });
    const imageReference = (
      overrides: Readonly<Record<string, unknown>> = {}
    ): Record<string, unknown> => ({
      OTIO_SCHEMA: 'ImageSequenceReference.1',
      target_url_base: 'frames',
      name_prefix: 'plate_',
      name_suffix: '.png',
      start_frame: 1001,
      frame_step: 1,
      rate: 24,
      frame_zero_padding: 4,
      missing_frame_policy: 'error',
      available_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 24 },
        duration: { OTIO_SCHEMA: 'RationalTime.1', value: 48, rate: 24 },
      },
      ...overrides,
    });
    const document = (
      reference: Record<string, unknown>,
      mediaIndex: Record<string, OtioMediaEntry> = Object.create(
        null
      ) as Record<string, OtioMediaEntry>,
      kind = 'Video'
    ): OtioDocumentV1 =>
      readOtioDocument(
        JSON.stringify({
          OTIO_SCHEMA: 'Timeline.1',
          metadata: { relic: { id: 'timeline-sequence' } },
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [
              {
                OTIO_SCHEMA: 'Track.1',
                kind,
                metadata: { relic: { id: 'track-sequence' } },
                children: [
                  {
                    OTIO_SCHEMA: 'Clip.1',
                    metadata: { relic: { id: 'clip-sequence' } },
                    source_range: {
                      start_time: { value: 0, rate: 24 },
                      duration: { value: 48, rate: 24 },
                    },
                    media_reference: reference,
                  },
                ],
              },
            ],
          },
        }),
        { mediaIndex }
      );

    for (const [reference, entry] of [
      [imageReference(), 'media/frames/plate_1001.png'],
      [
        imageReference({ target_url_base: 'media', name_prefix: '/plate_' }),
        'media/plate_1001.png',
      ],
      [
        imageReference({ target_url_base: 'media/', name_suffix: '.png?v=1' }),
        'media/plate_1001.png',
      ],
      [
        imageReference({ target_url_base: 'media/', name_prefix: '%3F_' }),
        'media/?_1001.png',
      ],
      [
        imageReference({ target_url_base: 'media/', name_prefix: '%23_' }),
        'media/#_1001.png',
      ],
    ] as const) {
      const doc = document(reference, media(entry));
      const evaluated = evaluateOtioAt(doc, 'timeline-sequence', {
        value: 0,
        rate: 24,
      });
      expect<string | null | undefined>(
        evaluated.video_contributions[0]?.bundle_path
      ).toBe(entry);
      expect(
        sourceSpansForOtioRange(doc, 'timeline-sequence', 'track-sequence', {
          start_time: { value: 0, rate: 24 },
          duration: { value: 1, rate: 24 },
        })[0]?.bundle_path
      ).toBeNull();
    }

    const rateThirty = document(
      imageReference({ target_url_base: 'media/', rate: 30 }),
      media('media/plate_1051.png')
    );
    expect<string | null | undefined>(
      evaluateOtioAt(rateThirty, 'timeline-sequence', { value: 40, rate: 24 })
        .video_contributions[0]?.bundle_path
    ).toBe('media/plate_1051.png');

    for (const policy of ['error', 'hold', 'black'] as const) {
      const zero = document(
        imageReference({ available_range: null, missing_frame_policy: policy }),
        media('media/frames/plate_1001.png')
      );
      const contribution = evaluateOtioAt(zero, 'timeline-sequence', {
        value: 0,
        rate: 24,
      }).video_contributions[0];
      if (policy === 'black') {
        expect(contribution?.sample_kind).toBe('black');
        expect(contribution?.bundle_path).toBeNull();
      } else {
        expect(contribution?.sample_kind).toBe('media');
        expect(contribution?.bundle_path).toBeNull();
        expect(
          contribution?.diagnostics.some(
            (diagnostic) => diagnostic.code === 'missing-media'
          )
        ).toBe(true);
      }
    }

    const preStartHold = document(
      imageReference({
        missing_frame_policy: 'hold',
        available_range: {
          OTIO_SCHEMA: 'TimeRange.1',
          start_time: {
            OTIO_SCHEMA: 'RationalTime.1',
            value: 24,
            rate: 24,
          },
          duration: {
            OTIO_SCHEMA: 'RationalTime.1',
            value: 4,
            rate: 24,
          },
        },
      }),
      {
        ...media('media/frames/plate_1002.png'),
        ...media('media/frames/plate_1004.png'),
      }
    );
    const heldPreStart = evaluateOtioAt(preStartHold, 'timeline-sequence', {
      value: 0,
      rate: 24,
    }).video_contributions[0];
    expect<string | null | undefined>(heldPreStart?.bundle_path).toBe(
      'media/frames/plate_1002.png'
    );
    expect(heldPreStart?.source_frame).toBe(1002);

    const invalid = document(imageReference({ frame_zero_padding: 33 }));
    const invalidContribution = evaluateOtioAt(invalid, 'timeline-sequence', {
      value: 0,
      rate: 24,
    }).video_contributions[0];
    expect(invalidContribution?.bundle_path).toBeNull();
    expect(invalidContribution?.source_frame).toBeUndefined();
    expect(
      invalidContribution?.diagnostics.some(
        (diagnostic) => diagnostic.code === 'invalid-timing'
      )
    ).toBe(true);

    const external = {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: 'media/a%2520b.mp4',
      available_range: {
        start_time: { value: 0, rate: 24 },
        duration: { value: 48, rate: 24 },
      },
    };
    const externalVideo = document(external);
    expect<string | null | undefined>(
      evaluateOtioAt(externalVideo, 'timeline-sequence', {
        value: 0,
        rate: 24,
      }).video_contributions[0]?.bundle_path
    ).toBe('media/a%20b.mp4');
    expect<string | null | undefined>(
      sourceSpansForOtioRange(
        externalVideo,
        'timeline-sequence',
        'track-sequence',
        {
          start_time: { value: 0, rate: 24 },
          duration: { value: 1, rate: 24 },
        }
      )[0]?.bundle_path
    ).toBe('media/a%20b.mp4');
    const externalAudio = document(external, Object.create(null), 'Audio');
    expect<string | null | undefined>(
      evaluateOtioAt(externalAudio, 'timeline-sequence', {
        value: 0,
        rate: 24,
      }).audio_contributions[0]?.bundle_path
    ).toBe('media/a%20b.mp4');
    for (const [targetUrl, entry] of [
      ['media/%253F.png', 'media/%3F.png'],
      ['media/%3F.png', 'media/?.png'],
      ['media/a%2520b.png', 'media/a%20b.png'],
      ['media/a%20b.png', 'media/a b.png'],
    ] as const) {
      const canonical = document({ ...external, target_url: targetUrl });
      expect<string | null | undefined>(
        evaluateOtioAt(canonical, 'timeline-sequence', {
          value: 0,
          rate: 24,
        }).video_contributions[0]?.bundle_path
      ).toBe(entry);
      expect<string | null | undefined>(
        sourceSpansForOtioRange(
          canonical,
          'timeline-sequence',
          'track-sequence',
          {
            start_time: { value: 0, rate: 24 },
            duration: { value: 1, rate: 24 },
          }
        )[0]?.bundle_path
      ).toBe(entry);
    }
  });
});
