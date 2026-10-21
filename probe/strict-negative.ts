// Probe: does the real evaluator emit representationally-zero negative
// source_time with no missing-handles diagnostic for accepted mixed-rate OTIO?
import {
  compareRationalTimes,
  evaluateOtioAt,
  readOtioDocument,
  timeToSeconds,
} from '../packages/relic-format/src/index.ts';

type Json = Record<string, unknown>;
const RT = (value: number, rate: number): Json => ({
  OTIO_SCHEMA: 'RationalTime.1',
  value,
  rate,
});
const TR = (start: Json, duration: Json): Json => ({
  OTIO_SCHEMA: 'TimeRange.1',
  start_time: start,
  duration,
});

function clip(
  id: string,
  sourceRange: Json | null,
  availableRange: Json | null,
  url: string
): Json {
  return {
    OTIO_SCHEMA: 'Clip.1',
    name: id,
    metadata: { relic: { id } },
    source_range: sourceRange,
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: url,
      available_range: availableRange,
    },
  };
}

function timeline(kind: 'Video' | 'Audio', children: Json[]): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'probe',
    metadata: { relic: { id: 'timeline_1' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: { relic: { id: 'stack_1' } },
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind,
          metadata: { relic: { id: 'track_1' } },
          children,
        },
      ],
    },
  });
}

// Same predicate as otio-playback.ts sampleUnavailable at bf48a31.
function viewerWithholds(contrib: {
  diagnostics: readonly { code: string }[];
  source_time: { value: number; rate: number };
}): boolean {
  return (
    contrib.diagnostics.some((d) => d.code === 'missing-handles') ||
    timeToSeconds(contrib.source_time) < 0
  );
}

function report(
  label: string,
  kind: 'Video' | 'Audio',
  children: Json[],
  at: { value: number; rate: number }
): void {
  const doc = readOtioDocument(timeline(kind, children));
  const result = evaluateOtioAt(doc, 'timeline_1', at);
  const contribs =
    kind === 'Video' ? result.video_contributions : result.audio_contributions;
  for (const c of contribs) {
    const st = c.source_time;
    const tolerantSign = compareRationalTimes(st, { value: 0, rate: st.rate });
    console.log(
      JSON.stringify({
        label,
        kind,
        at,
        node: c.node_id,
        source_time: st,
        seconds: timeToSeconds(st),
        missing_handles: c.diagnostics.some(
          (d) => d.code === 'missing-handles'
        ),
        diagnostics: c.diagnostics.map((d) => d.code),
        tolerant_compare_vs_zero: tolerantSign,
        viewer_withholds: viewerWithholds(c),
      })
    );
  }
  if (contribs.length === 0)
    console.log(JSON.stringify({ label, kind, at, contributions: 0 }));
}

const r2398 = 24000 / 1001;
const r2997 = 30000 / 1001;

// Case 1: reviewer's simple case. source 4@23.976, available 5@29.97.
for (const kind of ['Video', 'Audio'] as const) {
  report(
    'source 4@24000/1001, available 5@30000/1001, first frame',
    kind,
    [
      clip(
        'clip_b',
        TR(RT(4, r2398), RT(24, r2398)),
        TR(RT(5, r2997), RT(60, r2997)),
        kind === 'Video' ? 'media/b.mp4' : 'media/b.wav'
      ),
    ],
    { value: 0, rate: r2398 }
  );
}

// Case 2: sequential placement drift. Clip A 24@24, clip B 40@30, then clip C
// whose start is the float cursor. Seek exactly at C's integer start.
for (const trackRate of [24, r2398]) {
  const a = clip(
    'clip_a',
    TR(RT(0, trackRate), RT(trackRate === 24 ? 24 : 24, trackRate)),
    TR(RT(0, trackRate), RT(48, trackRate)),
    'media/a.mp4'
  );
  const b = clip(
    'clip_b',
    TR(RT(0, 30), RT(40, 30)),
    TR(RT(0, 30), RT(60, 30)),
    'media/b.mp4'
  );
  const c = clip(
    'clip_c',
    TR(RT(0, 24), RT(24, 24)),
    TR(RT(0, 24), RT(48, 24)),
    'media/c.mp4'
  );
  const doc = readOtioDocument(timeline('Video', [a, b, c]));
  const nodeC = Object.values(doc.nodes).find((n) => n.name === 'clip_c');
  console.log(
    JSON.stringify({
      label: 'cursor drift',
      trackRate,
      clip_c_timeline_range: nodeC?.timeline_range,
      clip_c_visible: nodeC?.visible_timeline_range,
    })
  );
  const start = nodeC?.timeline_range?.start_time;
  if (start) {
    const rounded = { value: Math.round(start.value), rate: start.rate };
    report(`cursor drift track ${trackRate}`, 'Video', [a, b, c], rounded);
  }
}
