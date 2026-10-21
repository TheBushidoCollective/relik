import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateOtioAt, markersForOtioTimeline, sourceSpansForOtioRange } from '../src/otio-timing.ts';
import { readOtioDocument } from '../src/otio-identity.ts';
import type { OtioDocumentV1, OtioNode } from '../src/otio-types.ts';
const root = new URL('./fixtures/otio/', import.meta.url);
function load(name: string) {
  return readOtioDocument(readFileSync(new URL(name, root)));
}

function node(doc: OtioDocumentV1, id: string): OtioNode {
  const found = doc.nodes[id];
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe('official OTIO placement and Relik sampling', () => {
  test('standard dissolve, handles, nested frame, and retained effects', () => {
    const doc = load('standard-sample.otiod/content.otio');
    const timelineId = doc.timeline_ids[0] as string;
    const timeline = node(doc, timelineId);
    expect(timeline.timeline_range?.start_time.value).toBe(0);
    expect(timeline.timeline_range?.duration.value).toBeCloseTo(240, 5);
    expect(timeline.timeline_range?.duration.rate).toBeCloseTo(24, 5);

    const clipA = node(doc, 'clip-v1-primary-a');
    expect(clipA.source_range?.start_time.value).toBeCloseTo(48, 5);
    expect(clipA.source_range?.duration.value).toBeCloseTo(72, 5);
    expect(clipA.parent_range?.start_time.value).toBeCloseTo(0, 5);
    expect(clipA.parent_range?.duration.value).toBeCloseTo(72, 5);
    expect(clipA.visible_timeline_range?.duration.value).toBeCloseTo(84, 5);

    const clipB = node(doc, 'clip-v1-secondary-b');
    expect(clipB.parent_range?.start_time.value).toBeCloseTo(72, 5);
    expect(clipB.parent_range?.duration.value).toBeCloseTo(96, 5);
    expect(clipB.visible_timeline_range?.start_time.value).toBeCloseTo(60, 5);

    const transition = node(doc, 'trans-v1-dissolve-1');
    expect(transition.timeline_range?.start_time.value).toBeCloseTo(60, 5);
    expect(transition.timeline_range?.duration.value).toBeCloseTo(24, 5);

    const timewarp = node(doc, 'clip-v2-timewarp');
    expect(timewarp.parent_range?.start_time.value).toBeCloseTo(60, 5);
    expect(timewarp.parent_range?.start_time.rate).toBeCloseTo(30, 5);
    expect(timewarp.parent_range?.duration.rate).toBeCloseTo(24, 5);

    const at84 = evaluateOtioAt(doc, timelineId, { value: 84, rate: 24 });
    expect(at84.video_contributions.some((item) => item.node_id === 'trans-v1-dissolve-1')).toBe(false);
    expect(at84.video_contributions.some((item) => item.node_id === 'clip-v1-primary-a')).toBe(false);

    const query = sourceSpansForOtioRange(doc, timelineId, 'track-v1-main', {
      start_time: { value: 60, rate: 24 },
      duration: { value: 30, rate: 24 },
    });
    const spanA = query.find((span) => span.node_id === 'clip-v1-primary-a');
    const spanB = query.find((span) => span.node_id === 'clip-v1-secondary-b');
    const spanT = query.find((span) => span.node_id === 'trans-v1-dissolve-1');
    expect(spanA?.source_range?.start_time.value).toBeCloseTo(108, 5);
    expect(spanA?.source_range?.duration.value).toBeCloseTo(24, 5);
    expect(spanA?.file_relative_source_range?.start_time.value).toBeCloseTo(84, 5);
    expect(spanA?.file_relative_source_range?.duration.value).toBeCloseTo(24, 5);
    expect(spanB?.source_range?.start_time.value).toBeCloseTo(12, 5);
    expect(spanB?.source_range?.duration.value).toBeCloseTo(30, 5);
    expect(spanB?.file_relative_source_range?.start_time.value).toBeCloseTo(12, 5);
    expect(spanT?.intersected_timeline_range.start_time.value).toBeCloseTo(60, 5);
    expect(spanT?.intersected_timeline_range.duration.value).toBeCloseTo(24, 5);

    const at200 = evaluateOtioAt(doc, timelineId, { value: 200, rate: 24 });
    const plate = at200.video_contributions.find((item) => item.node_id === 'clip-nested-plate');
    const flare = at200.video_contributions.find((item) => item.node_id === 'clip-nested-flare');
    expect(plate?.source_frame).toBe(1009);
    expect(plate?.bundle_path).toBe('media/plate_1009.png');
    expect(flare).toBeDefined();
    expect(node(doc, 'track-nested-plate-base').timeline_range).not.toBeNull();
    expect(node(doc, 'track-nested-fx-glow').timeline_range).not.toBeNull();
    expect(node(doc, 'stack-vfx-submaster').parent_range?.start_time.value).toBeCloseTo(192, 5);

    const at72 = evaluateOtioAt(doc, timelineId, { value: 72, rate: 24 });
    expect(at72.video_contributions.map((item) => item.node_id)).toContain('clip-v2-timewarp');
    const at180 = evaluateOtioAt(doc, timelineId, { value: 180, rate: 24 });
    const unsupported = at180.video_contributions.find((item) => item.node_id === 'clip-v2-unsupported');
    expect(unsupported?.diagnostics.some((item) => item.code === 'unsupported-effect')).toBe(true);

    const markers = markersForOtioTimeline(doc, timelineId);
    expect(markers.some((item) => item.owner_node_id === 'clip-v1-primary-a' && item.marker.name === 'Grade Correction Required')).toBe(false);
    const at36 = evaluateOtioAt(doc, timelineId, { value: 36, rate: 24 });
    expect(at36.active_markers.some((item) => item.marker.name === 'Grade Correction Required')).toBe(false);
  });

  test('nested trim samples from the stack source, not zero', () => {
    const doc = load('edge-cases/nested-trims.otio');
    const timelineId = doc.timeline_ids[0] as string;
    const stack = node(doc, 'stack-inner-trims');
    expect(stack.source_range?.start_time.value).toBeCloseTo(12, 5);
    expect(stack.source_range?.duration.value).toBeCloseTo(48, 5);
    expect(stack.parent_range?.start_time.value).toBeCloseTo(24, 5);
    const track = node(doc, 'track-inner-1');
    const inner = Object.values(doc.nodes).find(
      (item) => item.name === 'Inner Clip 1'
    );
    expect(track.timeline_range?.start_time.value).toBeCloseTo(24, 5);
    expect(track.timeline_range?.duration.value).toBeCloseTo(48, 5);
    expect(inner?.timeline_range?.start_time.value).toBeCloseTo(24, 5);
    expect(inner?.timeline_range?.duration.value).toBeCloseTo(48, 5);
    expect(inner?.visible_timeline_range?.start_time.value).toBeCloseTo(24, 5);
    expect(inner?.visible_timeline_range?.duration.value).toBeCloseTo(48, 5);

    const expected: readonly [number, string, number][] = [
      [12, 'Head Clip', 12],
      [24, 'Inner Clip 1', 12],
      [36, 'Inner Clip 1', 24],
      [71, 'Inner Clip 1', 59],
      [72, 'Tail Clip', 0],
    ];
    for (const [time, name, source] of expected) {
      const evaluation = evaluateOtioAt(doc, timelineId, {
        value: time,
        rate: 24,
      });
      expect(evaluation.video_contributions).toHaveLength(1);
      expect(evaluation.video_contributions[0]?.name).toBe(name);
      expect(evaluation.video_contributions[0]?.source_time.value).toBeCloseTo(
        source,
        5
      );
    }

    const full = sourceSpansForOtioRange(
      doc,
      timelineId,
      'track-nested-master',
      {
        start_time: { value: 12, rate: 24 },
        duration: { value: 72, rate: 24 },
      }
    );
    expect(
      full.map((span) => ({
        name: span.name,
        timeline: [
          span.intersected_timeline_range.start_time.value,
          span.intersected_timeline_range.duration.value,
        ],
        source: [
          span.source_range?.start_time.value,
          span.source_range?.duration.value,
        ],
      }))
    ).toEqual([
      { name: 'Head Clip', timeline: [12, 12], source: [12, 12] },
      { name: 'Inner Clip 1', timeline: [24, 48], source: [12, 48] },
      { name: 'Tail Clip', timeline: [72, 12], source: [0, 12] },
    ]);

    const innerOnly = sourceSpansForOtioRange(
      doc,
      timelineId,
      'track-nested-master',
      {
        start_time: { value: 24, rate: 24 },
        duration: { value: 48, rate: 24 },
      }
    );
    expect(innerOnly).toHaveLength(1);
    expect(innerOnly[0]?.name).toBe('Inner Clip 1');
    expect(innerOnly[0]?.source_range).toEqual({
      start_time: { value: 12, rate: 24 },
      duration: { value: 48, rate: 24 },
    });
  });

  test('step two keeps image zero for one source frame', () => {
    const doc = load('edge-cases/image-sequence.otio');
    const timelineId = doc.timeline_ids[0] as string;
    const one = evaluateOtioAt(doc, timelineId, { value: 1, rate: 24 });
    const two = evaluateOtioAt(doc, timelineId, { value: 2, rate: 24 });
    const stepOne = one.video_contributions.find((item) => item.node_id === 'clip-sequence-step-two');
    const stepTwo = two.video_contributions.find((item) => item.node_id === 'clip-sequence-step-two');
    expect(stepOne?.bundle_path).toBe('media/step_0000.png');
    expect(stepTwo?.bundle_path).toBe('media/step_0002.png');
    const signed = one.video_contributions.find((item) => item.node_id === 'clip-sequence-signed-start');
    expect(signed?.bundle_path).toBe('media/signed_-0002.png');
  });
});
