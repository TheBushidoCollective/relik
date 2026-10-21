import { describe, expect, test } from 'bun:test';
import { readOtioDocument, resolveOtioAnchor } from '../src/otio-identity.ts';
import type { OtioAnchorV1 } from '../src/otio-types.ts';

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

  test('freeze is not inverted into a guessed range', () => {
    const original = readOtioDocument(timeline([clip('clip', 0, 24, 0)]));
    const current = readOtioDocument(timeline([clip('clip', 0, 24, 0)]));
    const resolved = resolveOtioAnchor(anchor(0, 12, original.document_sha256), original, current);
    expect(resolved.status).toBe('ambiguous');
    expect(resolved.mapped_range).toBeUndefined();
  });

  test('a wrong digest cannot return same', () => {
    const doc = readOtioDocument(timeline([clip('clip', 0, 24)]));
    const resolved = resolveOtioAnchor(anchor(0, 12, '0'.repeat(64)), doc, doc);
    expect(resolved.status).not.toBe('same');
    expect(resolved.source_spans.length).toBeGreaterThan(0);
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
