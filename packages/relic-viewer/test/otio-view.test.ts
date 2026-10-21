import { describe, expect, test } from 'bun:test';
import { readOtioDocument, type OtioAnchorResolution, type OtioAnchorV1 } from '@relic/format';
import { otioAdapter, otioTargetLabel } from '../src/annotate-otio.ts';
import { attachOtioController, otioControllerFor, type OtioUiController } from '../src/otio-bridge.ts';
import { createOtioSelection, formatOtioTime, otioLanes, otioProjectionTarget, otioScopeRange } from '../src/otio-view.ts';

const range = (start: number, duration: number) => ({ start_time: { value: start, rate: 24 }, duration: { value: duration, rate: 24 } });
const clip = (id: string, name: string) => ({
  OTIO_SCHEMA: 'Clip.1', name, metadata: { relic: { id } }, source_range: range(48, 24),
  media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: `media/${id}.mp4`, available_range: range(24, 96) },
});
const document = readOtioDocument(JSON.stringify({
  OTIO_SCHEMA: 'Timeline.1', name: 'Relik Feature Editorial', metadata: { relic: { id: 'timeline' } },
  global_start_time: { value: 86400, rate: 24 },
  tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: [
    { OTIO_SCHEMA: 'Track.1', name: 'Video 2', kind: 'Video', metadata: { relic: { id: 'video-first' } }, children: [
      clip('primary', 'Primary Grade A'), clip('secondary', 'Secondary Grade B'),
      { OTIO_SCHEMA: 'Stack.1', name: 'VFX Submaster Stack', source_range: range(0, 24), children: [
        { OTIO_SCHEMA: 'Track.1', name: 'Plate Base', kind: 'Video', metadata: { relic: { id: 'plate-track' } }, children: [clip('plate', 'Background CG Plate')] },
      ] },
    ] },
    { OTIO_SCHEMA: 'Track.1', name: 'Video 2', kind: 'Video', metadata: { relic: { id: 'video-second' } }, enabled: false, children: [clip('overlay', 'Picture-in-Picture Alpha')] },
    { OTIO_SCHEMA: 'Track.1', name: 'Dialogue DX', kind: 'Audio', metadata: { relic: { id: 'dialogue' } }, children: [clip('dialogue-clip', 'Interview Mic 1')] },
  ] },
}));

const anchor = createOtioSelection(document, 'timeline', 'video-second', 1, range(12, 0));

function resolution(status: OtioAnchorResolution['status']): OtioAnchorResolution {
  return { status, original_anchor: anchor, mapped_ranges: [range(24, 12)], mapped_range: range(24, 12), mapped_timeline_id: 'timeline', mapped_track_id: 'video-second', source_spans: [], diagnostics: [] };
}

describe('OTIO track selection contract', () => {
  test('two identically named tracks retain independent IDs and paths', () => {
    const duplicates = otioLanes(document, 'timeline').filter(lane => lane.node.name === 'Video 2');
    expect(duplicates.map(lane => lane.node.id)).toEqual(['video-first', 'video-second']);
    expect(new Set(duplicates.map(lane => lane.node.json_pointer)).size).toBe(2);
    expect(new Set(duplicates.map(lane => lane.code)).size).toBe(2);
    expect(duplicates[1]?.node.enabled).toBe(false);
    const nested = otioLanes(document, 'timeline').find(lane => lane.node.id === 'plate-track');
    expect(nested?.depth).toBe(1);
    expect(nested?.path).toContain('VFX Submaster Stack');
  });

  test('a point has zero duration and binds the second duplicate track', () => {
    expect(anchor.kind).toBe('otio');
    expect(anchor.relic_version).toBe(1);
    expect(anchor.document_sha256).toBe(document.document_sha256);
    expect(anchor.track_id).toBe('video-second');
    expect(anchor.range).toEqual(range(12, 0));
    expect(anchor.snapshot.track).toBe('Video 2');
    expect(otioTargetLabel(anchor)).toContain('point 12 @ 24');
  });

  test('a one-frame range stays one frame; mixed rational coordinates stay exact', () => {
    expect(createOtioSelection(document, 'timeline', 'video-second', 1, range(12, 1)).range).toEqual(range(12, 1));
    const mixed = { start_time: { value: 1001, rate: 30000 }, duration: { value: 1, rate: 30000 / 1001 } };
    expect(createOtioSelection(document, 'timeline', null, 1, mixed).range).toEqual(mixed);
  });

  test('a range across clips retains the range without claiming one item', () => {
    const multi = createOtioSelection(document, 'timeline', 'video-first', 1, range(12, 24));
    expect(multi.range).toEqual(range(12, 24));
    expect(multi.item_id).toBeUndefined();
  });

  test('whole-track selection uses exposed core windows rather than the composition duration', () => {
    expect(otioScopeRange(document, 'timeline', 'plate-track')).toEqual(range(48, 24));
    expect(otioScopeRange(document, 'timeline', 'video-second')).toEqual(range(0, 24));
    expect(otioScopeRange(document, 'timeline', null)).toEqual(range(0, 72));
    expect(otioScopeRange(document, 'timeline', 'missing-track')).toBeUndefined();
    expect(otioScopeRange(document, 'another-timeline', 'plate-track')).toBeUndefined();
  });

  test('global start affects the displayed timecode only', () => {
    expect(formatOtioTime({ value: 36, rate: 24 }, { value: 86400, rate: 24 })).toBe('01:00:01:12');
    expect(anchor.range.start_time.value).toBe(12);
  });
});

describe('OTIO revision-bound mark placement', () => {
  test('same revision still requires its encrypted document digest and timeline', () => {
    expect(otioProjectionTarget(anchor, 1, document, 'timeline')?.track).toBe('video-second');
    expect(otioProjectionTarget({ ...anchor, document_sha256: '0'.repeat(64) }, 1, document, 'timeline')).toBeUndefined();
    expect(otioProjectionTarget(anchor, 1, document, 'another-timeline')).toBeUndefined();
  });

  test('earlier feedback gets no guessed coordinates without a projection', () => {
    expect(otioProjectionTarget(anchor, 2, document, 'timeline')).toBeUndefined();
    for (const status of ['ambiguous', 'changed', 'missing'] as const) {
      expect(otioProjectionTarget(anchor, 2, document, 'timeline', resolution(status))).toBeUndefined();
    }
  });

  test('safe and partial mappings use separate current ranges and leave the original immutable', () => {
    for (const status of ['mapped', 'partial', 'same'] as const) {
      expect(otioProjectionTarget(anchor, 2, document, 'timeline', resolution(status))?.ranges).toEqual([range(24, 12)]);
    }
    expect(anchor.range).toEqual(range(12, 0));
    expect(anchor.relic_version).toBe(1);
  });

  test('disjoint current pieces are retained without filling their gap', () => {
    const pieces = [range(24, 12), range(60, 6)];
    const projected = { ...resolution('partial'), mapped_ranges: pieces };
    delete projected.mapped_range;
    const target = otioProjectionTarget(anchor, 2, document, 'timeline', projected);
    expect(target?.ranges).toBe(pieces);
    expect(target?.track).toBe('video-second');
    expect(anchor.range).toEqual(range(12, 0));
  });

  test('an explicitly empty projection never falls back to the old contiguous range', () => {
    const projected = { ...resolution('partial'), mapped_ranges: [] };
    expect(otioProjectionTarget(anchor, 2, document, 'timeline', projected)).toBeUndefined();
  });

  test('legacy contiguous output is used only when mapped_ranges is omitted', () => {
    const projected = { ...resolution('mapped') };
    delete projected.mapped_ranges;
    expect(otioProjectionTarget(anchor, 2, document, 'timeline', projected)?.ranges).toEqual([range(24, 12)]);
  });

  test('placement requires the core mapped timeline identity, including composition projections', () => {
    const missingTimeline = { ...resolution('mapped') };
    delete missingTimeline.mapped_timeline_id;
    expect(otioProjectionTarget(anchor, 2, document, 'timeline', missingTimeline)).toBeUndefined();
    const wrongTimeline = { ...resolution('mapped'), mapped_timeline_id: 'another-timeline' };
    expect(otioProjectionTarget(anchor, 2, document, 'timeline', wrongTimeline)).toBeUndefined();
    const composition = { ...resolution('mapped'), mapped_track_id: null };
    expect(otioProjectionTarget(anchor, 2, document, 'timeline', composition)?.track).toBeNull();
  });
});

describe('OTIO eager-shell bridge', () => {
  test('an unrelated content surface does not require DOM query methods', () => {
    expect(otioControllerFor({ tagName: 'VIDEO' } as HTMLElement)).toBeUndefined();
    expect(otioAdapter.supports({ host: {} as HTMLElement, content: {} as HTMLElement })).toBe(false);
  });

  test('adapter paint and reveal call the native controller without substituting time anchors', () => {
    const root = { matches: (selector: string) => selector === '.otio-view' } as HTMLElement;
    const seen: { anchor: OtioAnchorV1; id?: string }[] = [];
    const controller: OtioUiController = {
      document, revision: 1,
      paint(value, id) { seen.push({ anchor: value, id }); return true; },
      reveal(value) { seen.push({ anchor: value }); },
      clearMarks() {},
      project: async value => ({ status: 'same', original_anchor: value, source_spans: [], diagnostics: [] }),
      projection: () => undefined,
      dispose() {},
    };
    attachOtioController(root, controller);
    const surface = { host: root, content: root };
    expect(otioAdapter.supports(surface)).toBe(true);
    expect(otioAdapter.paint(surface, {} as HTMLElement, anchor, 'comment-1')).toBe(true);
    otioAdapter.reveal?.(surface, anchor);
    expect(seen).toEqual([{ anchor, id: 'comment-1' }, { anchor }]);
  });
});
