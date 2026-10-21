import { describe, expect, test } from 'bun:test';
import { readOtioDocument, resolveOtioAnchor } from '../src/otio-identity.ts';
import type { OtioAnchorResolution, OtioAnchorV1, OtioTimeRange } from '../src/otio-types.ts';

function clip(id: string, start: number, duration: number, scalar?: number) {
  return {
    OTIO_SCHEMA: 'Clip.1',
    name: id,
    metadata: { relic: { id } },
    source_range: {
      start_time: { value: start, rate: 24 },
      duration: { value: duration, rate: 24 },
    },
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: 'media/primary_a.mp4',
      available_range: {
        start_time: { value: 0, rate: 24 },
        duration: { value: 200, rate: 24 },
      },
    },
    effects: scalar === undefined ? [] : [{
      OTIO_SCHEMA: scalar === 0 ? 'FreezeFrame.1' : 'LinearTimeWarp.1',
      name: 'warp',
      effect_name: scalar === 0 ? 'FreezeFrame' : 'LinearTimeWarp',
      time_scalar: scalar,
      enabled: true,
    }],
  };
}

function timeline(children: unknown[], name = 'Timeline') {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name,
    metadata: { relic: { id: 'timeline' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [{
        OTIO_SCHEMA: 'Track.1',
        name: 'Video',
        kind: 'Video',
        metadata: { relic: { id: 'track' } },
        children,
      }],
    },
  });
}

function anchor(rangeStart: number, duration: number, sha: string, item = 'clip'): OtioAnchorV1 {
  return {
    kind: 'otio',
    v: 1,
    relic_version: 1,
    document_sha256: sha,
    timeline_id: 'timeline',
    track_id: 'track',
    item_id: item,
    range: {
      start_time: { value: rangeStart, rate: 24 },
      duration: { value: duration, rate: 24 },
    },
    snapshot: { timeline: 'Timeline', track: 'Video', item },
  };
}

function span(start: number, end: number) {
  return {
    start_time: { value: start, rate: 24 },
    duration: { value: end - start, rate: 24 },
  };
}

function documentD3(
  stackStart: number,
  stackEnd: number,
  includeNested = true
): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'D3',
    metadata: { relic: { id: 'timeline-d3' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track-m3' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Head',
              metadata: { relic: { id: 'clip-head' } },
              source_range: span(0, 24),
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/head.mp4',
                available_range: span(0, 24),
              },
            },
            {
              OTIO_SCHEMA: 'Stack.1',
              name: 'Nested',
              metadata: { relic: { id: 'stack-n' } },
              source_range: span(stackStart, stackEnd),
              children: includeNested
                ? [
                    {
                      OTIO_SCHEMA: 'Track.1',
                      kind: 'Video',
                      metadata: { relic: { id: 'track-n' } },
                      children: [
                        {
                          OTIO_SCHEMA: 'Clip.1',
                          name: 'Nested clip',
                          metadata: { relic: { id: 'clip-x' } },
                          source_range: span(0, 72),
                          media_reference: {
                            OTIO_SCHEMA: 'ExternalReference.1',
                            target_url: 'media/x.mp4',
                            available_range: span(0, 72),
                          },
                          markers: [
                            {
                              OTIO_SCHEMA: 'Marker.2',
                              name: 'early',
                              marked_range: span(0, 6),
                            },
                            {
                              OTIO_SCHEMA: 'Marker.2',
                              name: 'late',
                              marked_range: span(12, 18),
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
            },
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Tail',
              metadata: { relic: { id: 'clip-tail' } },
              source_range: span(0, 24),
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/tail.mp4',
                available_range: span(0, 24),
              },
            },
          ],
        },
      ],
    },
  });
}

function d3Anchor(
  documentSha: string,
  start: number,
  duration: number
): OtioAnchorV1 {
  return {
    kind: 'otio',
    v: 1,
    relic_version: 1,
    document_sha256: documentSha,
    timeline_id: 'timeline-d3',
    track_id: 'track-n',
    item_id: 'clip-x',
    range: {
      start_time: { value: start, rate: 24 },
      duration: { value: duration, rate: 24 },
    },
    snapshot: { timeline: 'D3', track: 'Nested', item: 'Nested clip' },
  };
}

function mediaIndex(sha256: string) {
  return {
    'media/primary_a.mp4': {
      key: 'media/primary_a.mp4',
      bundle_path: 'media/primary_a.mp4',
      size: 1,
      sha256,
    },
  };
}

function expectRange(
  value: OtioTimeRange | undefined,
  start: number,
  duration: number
): void {
  expect(value?.start_time.value).toBe(start);
  expect(value?.duration.value).toBe(duration);
}

function expectNoMappedIdentityFields(resolved: OtioAnchorResolution): void {
  expect(Object.hasOwn(resolved, 'mapped_range')).toBe(false);
  expect(resolved.mapped_ranges ?? []).toEqual([]);
  expect(Object.hasOwn(resolved, 'mapped_timeline_id')).toBe(false);
  expect(Object.hasOwn(resolved, 'mapped_track_id')).toBe(false);
  expect(Object.hasOwn(resolved, 'mapped_item_id')).toBe(false);
}

function twoTrackTimeline(): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track' } },
          children: [clip('clip', 0, 24)],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track-b' } },
          children: [clip('other', 0, 24)],
        },
      ],
    },
  });
}


describe('OTIO identity and projection', () => {
  test('insert before a clip shifts the projected range', () => {
    const original = readOtioDocument(timeline([clip('clip', 0, 48)]));
    const current = readOtioDocument(timeline([
      clip('head', 0, 24),
      clip('clip', 0, 48),
    ]));
    const resolved = resolveOtioAnchor(anchor(12, 12, original.document_sha256), original, current);
    expect(resolved.status).toBe('mapped');
    expect(resolved.mapped_range?.start_time.value).toBeCloseTo(36, 5);
    expect(resolved.mapped_range?.duration.value).toBeCloseTo(12, 5);
    expect(resolved.mapped_ranges).toHaveLength(1);
    expect(resolved.original_anchor.range.start_time.value).toBe(12);
  });

  test('a trimmed-away interval is missing and not a boundary point', () => {
    const original = readOtioDocument(timeline([clip('clip', 0, 48)]));
    const current = readOtioDocument(timeline([clip('clip', 24, 24)]));
    const resolved = resolveOtioAnchor(anchor(0, 12, original.document_sha256), original, current);
    expect(resolved.status).toBe('missing');
    expect(Object.hasOwn(resolved, 'mapped_range')).toBe(false);
    expect(resolved.mapped_range).toBeUndefined();
    expect(resolved.mapped_ranges).toEqual([]);
  });

  test('scalar change inverts both maps', () => {
    const original = readOtioDocument(timeline([clip('clip', 0, 24, 2)]));
    const current = readOtioDocument(timeline([clip('clip', 0, 48, 1)]));
    const resolved = resolveOtioAnchor(anchor(0, 24, original.document_sha256), original, current);
    expect(resolved.status).toBe('mapped');
    expect(resolved.mapped_range?.duration.value).toBeCloseTo(48, 5);
  });

  test('unchanged freeze anchors stay same without map inversion', () => {
    const source = timeline([clip('clip', 0, 24, 0)]);
    const original = readOtioDocument(source);
    const current = readOtioDocument(source);
    const resolved = resolveOtioAnchor(
      anchor(0, 12, original.document_sha256),
      original,
      current
    );
    expect(resolved.status).toBe('same');
    expectRange(resolved.mapped_range, 0, 12);
    expect(resolved.mapped_ranges).toEqual([
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 12, rate: 24 },
      },
    ]);
    expect(resolved.mapped_track_id).toBe('track');
    expect(resolved.mapped_item_id).toBe('clip');
    expect(resolved.source_spans).toHaveLength(1);
    expect(resolved.source_spans[0]?.source_mapping?.scalar).toBe(0);
    expectRange(resolved.source_spans[0]?.source_range ?? undefined, 0, 0);
  });


  test('a freeze current revision is ambiguous when it must be inverted', () => {
    const original = readOtioDocument(timeline([clip('clip', 0, 24, 0)]));
    const current = readOtioDocument(
      timeline([clip('head', 0, 24), clip('clip', 0, 24, 0)])
    );
    const saved = anchor(0, 12, original.document_sha256);
    const resolved = resolveOtioAnchor(saved, original, current);
    expect(resolved.status).toBe('ambiguous');
    expect(resolved.original_anchor).toEqual(saved);
    expect(resolved.source_spans).toHaveLength(1);
    expectNoMappedIdentityFields(resolved);
  });


  test('a forward anchor is ambiguous when the current revision freezes it', () => {
    const original = readOtioDocument(timeline([clip('clip', 0, 24)]));
    const current = readOtioDocument(
      timeline([clip('head', 0, 24), clip('clip', 0, 24, 0)])
    );
    const saved = anchor(0, 12, original.document_sha256);
    const resolved = resolveOtioAnchor(saved, original, current);
    expect(resolved.status).toBe('ambiguous');
    expect(resolved.original_anchor).toEqual(saved);
    expect(resolved.source_spans).toHaveLength(1);
    expectNoMappedIdentityFields(resolved);
  });

  test('a wrong digest cannot return same', () => {
    const doc = readOtioDocument(timeline([clip('clip', 0, 24)]));
    const resolved = resolveOtioAnchor(anchor(0, 12, '0'.repeat(64)), doc, doc);
    expect(resolved.status).not.toBe('same');
    expect(resolved.source_spans.length).toBeGreaterThan(0);
  });


  test('an item on another track changes the anchor', () => {
    const doc = readOtioDocument(twoTrackTimeline());
    const resolved = resolveOtioAnchor(
      anchor(0, 12, doc.document_sha256, 'other'),
      doc
    );
    expect(resolved.status).toBe('changed');
    expect(resolved.diagnostics[0]?.code).toBe('invalid-timing');
  });


  test('different indexed media digest prevents same for identical JSON', () => {
    const source = timeline([clip('clip', 0, 24)]);
    const original = readOtioDocument(source, {
      mediaIndex: mediaIndex('a'.repeat(64)),
    });
    const different = readOtioDocument(source, {
      mediaIndex: mediaIndex('b'.repeat(64)),
    });
    const matching = readOtioDocument(source, {
      mediaIndex: mediaIndex('a'.repeat(64)),
    });
    const saved = anchor(0, 12, original.document_sha256);

    expect(resolveOtioAnchor(saved, original, different).status).toBe(
      'changed'
    );
    expect(resolveOtioAnchor(saved, original, matching).status).toBe('same');
  });


  test('a nested trim maps only current exposed media', () => {
    const original = readOtioDocument(documentD3(12, 60));
    const current = readOtioDocument(documentD3(24, 48));

    const missing = resolveOtioAnchor(
      d3Anchor(original.document_sha256, 24, 12),
      original,
      current
    );
    expect(missing.status).toBe('missing');
    expect(missing.mapped_ranges).toEqual([]);

    const partial = resolveOtioAnchor(
      d3Anchor(original.document_sha256, 30, 18),
      original,
      current
    );
    expect(partial.status).toBe('partial');
    expectRange(partial.mapped_range, 24, 12);
    expectRange(partial.mapped_ranges?.[0], 24, 12);

    const mapped = resolveOtioAnchor(
      d3Anchor(original.document_sha256, 48, 12),
      original,
      current
    );
    expect(mapped.status).toBe('mapped');
    expectRange(mapped.mapped_range, 36, 12);
    expectRange(mapped.mapped_ranges?.[0], 36, 12);
  });


  test('rejects an item/range combination outside the original item exposure', () => {
    const original = readOtioDocument(
      timeline([clip('head', 0, 24), clip('clip', 24, 24)])
    );
    const current = readOtioDocument(timeline([clip('clip', 0, 24)]));
    const outside = anchor(0, 12, original.document_sha256);

    for (const resolved of [
      resolveOtioAnchor(outside, original),
      resolveOtioAnchor(outside, original, current),
    ]) {
      expect(resolved.status).toBe('changed');
      expect(resolved.diagnostics[0]?.code).toBe('invalid-timing');
      expectNoMappedIdentityFields(resolved);
    }

    const atEnd = resolveOtioAnchor(
      anchor(48, 0, original.document_sha256),
      original
    );
    expect(atEnd.status).toBe('changed');
    expect(atEnd.diagnostics[0]?.code).toBe('invalid-timing');
    expectNoMappedIdentityFields(atEnd);

    expect(
      resolveOtioAnchor(anchor(24, 0, original.document_sha256), original)
        .status
    ).toBe('same');
  });

  test('omits unestablished optional OTIO fields without dropping meaningful zero or null values', () => {
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
              start_time: { value: 0, rate: 24 },
              duration: { value: 12, rate: 24 },
            },
            media_reference: {
              OTIO_SCHEMA: 'ImageSequenceReference.1',
              target_url: null,
              available_range: null,
              start_frame: 0,
              frame_step: 1,
              rate: 24,
              frame_zero_padding: 0,
            },
            effects: [{
              OTIO_SCHEMA: 'LinearTimeWarp.1',
              time_scalar: 0,
            }],
            markers: [{ OTIO_SCHEMA: 'Marker.2' }],
          }],
        }],
      },
    }));
    const clipNode = doc.nodes['clip'];
    if (!clipNode) throw new Error('expected clip node');
    const reference = clipNode.media_references?.['DEFAULT_MEDIA'];
    const effect = clipNode.effects?.[0];
    const marker = clipNode.markers?.[0];
    if (!reference || !effect || !marker) throw new Error('expected parsed OTIO fields');

    for (const key of [
      'name',
      'target_url_base',
      'name_prefix',
      'name_suffix',
      'missing_frame_policy',
      'metadata',
    ]) {
      expect(Object.hasOwn(reference, key)).toBe(false);
    }
    expect(Object.hasOwn(reference, 'start_frame')).toBe(true);
    expect(Object.hasOwn(reference, 'frame_zero_padding')).toBe(true);
    expect(reference.start_frame).toBe(0);
    expect(reference.frame_zero_padding).toBe(0);
    expect(reference.target_url).toBeNull();
    expect(reference.available_range).toBeNull();

    for (const key of ['name', 'effect_name', 'metadata']) {
      expect(Object.hasOwn(effect, key)).toBe(false);
    }
    expect(Object.hasOwn(effect, 'time_scalar')).toBe(true);
    expect(effect.time_scalar).toBe(0);

    for (const key of ['name', 'color', 'comment', 'metadata']) {
      expect(Object.hasOwn(marker, key)).toBe(false);
    }
    expect(marker.marked_range).toBeNull();

    const timelineId = doc.timeline_ids[0];
    if (timelineId === undefined) throw new Error('expected timeline ID');
    const resolution = resolveOtioAnchor({
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: doc.document_sha256,
      timeline_id: timelineId,
      track_id: null,
      range: {
        start_time: { value: 0, rate: 24 },
        duration: { value: 0, rate: 24 },
      },
      snapshot: { timeline: 'Timeline', track: null, item: null },
    }, doc);
    expect(Object.hasOwn(resolution, 'mapped_track_id')).toBe(true);
    expect(resolution.mapped_track_id).toBeNull();
    expect(Object.hasOwn(resolution, 'mapped_item_id')).toBe(false);
  });

  test('authored proto keys stay ordinary own keys', () => {
    const doc = readOtioDocument(JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Proto',
      metadata: { relic: { id: '__proto__' } },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [{
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'constructor' } },
          children: [clip('clip', 0, 12)],
        }],
      },
    }));
    expect(Object.prototype.hasOwnProperty.call(doc.nodes, '__proto__')).toBe(true);
    expect(doc.nodes['__proto__']?.schema).toBe('Timeline.1');
    expect(Object.prototype.hasOwnProperty.call(doc.nodes, 'constructor')).toBe(true);
    expect(doc.nodes['constructor']?.schema).toBe('Track.1');
  });

  test('a second timeline does not leak spans', () => {
    const doc = readOtioDocument(JSON.stringify({
      OTIO_SCHEMA: 'SerializableCollection.1',
      name: 'Collection',
      children: [
        {
          OTIO_SCHEMA: 'Timeline.1',
          name: 'Left',
          metadata: { relic: { id: 'left-timeline' } },
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [{
              OTIO_SCHEMA: 'Track.1',
              name: 'Video',
              kind: 'Video',
              metadata: { relic: { id: 'left-track' } },
              children: [clip('left', 0, 24)],
            }],
          },
        },
        {
          OTIO_SCHEMA: 'Timeline.1',
          name: 'Right',
          metadata: { relic: { id: 'right-timeline' } },
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [{
              OTIO_SCHEMA: 'Track.1',
              name: 'Video',
              kind: 'Video',
              metadata: { relic: { id: 'right-track' } },
              children: [clip('right', 0, 24)],
            }],
          },
        },
      ],
    }));
    const resolved = resolveOtioAnchor({
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: doc.document_sha256,
      timeline_id: 'left-timeline',
      track_id: 'left-track',
      item_id: 'left',
      range: {
        start_time: { value: 0, rate: 24 },
        duration: { value: 12, rate: 24 },
      },
      snapshot: { timeline: 'Left', track: 'Video', item: 'left' },
    }, doc);
    expect(resolved.status).toBe('same');
    expect(resolved.source_spans.map((span) => span.node_id)).toEqual(['left']);
  });
});
function reverseTimeline(
  scalar: number,
  sourceStart = 0,
  sourceDuration = 48,
  name = 'Timeline'
): string {
  return timeline([clip('clip', sourceStart, sourceDuration, scalar)], name);
}

function handleTimeline(): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { relic: { id: 'timeline-handle' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track-handle' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              metadata: { relic: { id: 'clip-a' } },
              source_range: span(0, 72),
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/a.mp4',
                available_range: span(0, 96),
              },
            },
            {
              OTIO_SCHEMA: 'Transition.1',
              metadata: { relic: { id: 'trans-handle' } },
              transition_type: 'SMPTE_Dissolve',
              in_offset: { value: 12, rate: 24 },
              out_offset: { value: 12, rate: 24 },
            },
            {
              OTIO_SCHEMA: 'Clip.1',
              metadata: { relic: { id: 'clip-b' } },
              source_range: span(0, 96),
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/b.mp4',
                available_range: span(0, 96),
              },
            },
          ],
        },
      ],
    },
  });
}

function stackAnchor(
  documentSha: string,
  start: number,
  duration: number
): OtioAnchorV1 {
  return {
    kind: 'otio',
    v: 1,
    relic_version: 1,
    document_sha256: documentSha,
    timeline_id: 'timeline-d3',
    track_id: 'track-m3',
    item_id: 'stack-n',
    range: {
      start_time: { value: start, rate: 24 },
      duration: { value: duration, rate: 24 },
    },
    snapshot: { timeline: 'D3', track: 'Nested', item: 'Nested' },
  };
}

function fractionalReverseTimeline(
  durationValue: number,
  durationRate: number
): string {
  const sourceRate = 30000 / 1001;
  return JSON.stringify({
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
                start_time: { value: 100, rate: sourceRate },
                duration: { value: durationValue, rate: durationRate },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/fractional.mp4',
                available_range: {
                  start_time: { value: 90, rate: sourceRate },
                  duration: { value: 30, rate: sourceRate },
                },
              },
              effects: [
                {
                  OTIO_SCHEMA: 'LinearTimeWarp.1',
                  effect_name: 'LinearTimeWarp',
                  time_scalar: -1,
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

describe('OTIO original selection and reverse projection edges', () => {
  test('keeps a handle point structurally valid while reporting its missing media handle', () => {
    const doc = readOtioDocument(handleTimeline());
    const saved: OtioAnchorV1 = {
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: doc.document_sha256,
      timeline_id: 'timeline-handle',
      track_id: 'track-handle',
      item_id: 'clip-b',
      range: {
        start_time: { value: 66, rate: 24 },
        duration: { value: 0, rate: 24 },
      },
      snapshot: { timeline: '', track: '', item: '' },
    };
    const resolved = resolveOtioAnchor(saved, doc);
    expect(resolved.status).toBe('same');
    const span = resolved.source_spans.find(
      (item) => item.node_id === 'clip-b'
    );
    expect(
      span?.diagnostics.some((item) => item.code === 'missing-handles')
    ).toBe(true);
  });

  test('accepts Stack anchors through their checked descendant spans', () => {
    const original = readOtioDocument(documentD3(12, 60));
    const saved = stackAnchor(original.document_sha256, 24, 12);
    expect(resolveOtioAnchor(saved, original).status).toBe('same');

    const current = readOtioDocument(documentD3(12, 72));
    const partial = resolveOtioAnchor(
      stackAnchor(original.document_sha256, 60, 24),
      original,
      current
    );
    expect(partial.status).toBe('partial');
    expectRange(partial.mapped_range, 60, 12);
    expectRange(partial.mapped_ranges?.[0], 60, 12);

    const withoutDescendant = readOtioDocument(documentD3(12, 60, false));
    const missing = resolveOtioAnchor(saved, original, withoutDescendant);
    expect(missing.status).toBe('missing');
    expect(missing.mapped_ranges).toEqual([]);
  });

  test('retains whole-track traversal for anchors without an item target', () => {
    const doc = readOtioDocument(timeline([clip('clip', 0, 24)]));
    const resolved = resolveOtioAnchor(
      {
        kind: 'otio',
        v: 1,
        relic_version: 1,
        document_sha256: doc.document_sha256,
        timeline_id: 'timeline',
        track_id: 'track',
        range: {
          start_time: { value: 0, rate: 24 },
          duration: { value: 12, rate: 24 },
        },
        snapshot: { timeline: 'Timeline', track: 'Video', item: null },
      },
      doc
    );
    expect(resolved.status).toBe('same');
    expect(resolved.source_spans.map((span) => span.node_id)).toEqual(['clip']);
  });

  test('maps reverse interval edges and reverse points without changing sample coordinates', () => {
    const cases = [
      { original: -1, current: 1, expectedStart: 36 },
      { original: 1, current: -1, expectedStart: 36 },
      { original: -1, current: -1, expectedStart: 0 },
    ];
    for (const {
      original: originalScalar,
      current: currentScalar,
      expectedStart,
    } of cases) {
      const original = readOtioDocument(reverseTimeline(originalScalar));
      const current = readOtioDocument(
        reverseTimeline(currentScalar, 0, 48, 'Current')
      );
      const resolved = resolveOtioAnchor(
        anchor(0, 12, original.document_sha256),
        original,
        current
      );
      expect(resolved.status).toBe('mapped');
      expectRange(resolved.mapped_range, expectedStart, 12);
    }

    const original = readOtioDocument(reverseTimeline(1));
    const current = readOtioDocument(reverseTimeline(-1, 0, 48, 'Current'));
    const point = resolveOtioAnchor(
      anchor(0, 0, original.document_sha256),
      original,
      current
    );
    expect(point.status).toBe('mapped');
    expectRange(point.mapped_range, 47, 0);
  });

  test('clips a forward anchor against a shorter reverse current selection at exact frame edges', () => {
    const original = readOtioDocument(reverseTimeline(1));
    const current = readOtioDocument(reverseTimeline(-1, 24, 24, 'Current'));
    const partial = resolveOtioAnchor(
      anchor(12, 24, original.document_sha256),
      original,
      current
    );
    expect(partial.status).toBe('partial');
    expectRange(partial.mapped_range, 12, 12);
    expectRange(partial.mapped_ranges?.[0], 12, 12);

    const missing = resolveOtioAnchor(
      anchor(0, 24, original.document_sha256),
      original,
      current
    );
    expect(missing.status).toBe('missing');
    expect(missing.mapped_ranges).toEqual([]);
  });

  test('projects equal fractional-rate reverse selections encoded with different duration rates', () => {
    const sourceRate = 30000 / 1001;
    const timelineRate = 24000 / 1001;
    const original = readOtioDocument(
      fractionalReverseTimeline(10, sourceRate)
    );
    const current = readOtioDocument(
      fractionalReverseTimeline(8, timelineRate)
    );
    const saved = anchor(0, 8, original.document_sha256);
    const rateAware: OtioAnchorV1 = {
      ...saved,
      range: {
        start_time: { value: 0, rate: timelineRate },
        duration: { value: 8, rate: timelineRate },
      },
    };
    const resolved = resolveOtioAnchor(rateAware, original, current);
    expect(resolved.status).toBe('mapped');
    expect(resolved.mapped_range).toEqual({
      start_time: { value: 0, rate: timelineRate },
      duration: { value: 8, rate: timelineRate },
    });
  });
});
