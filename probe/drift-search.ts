// Search sequential-placement drift: third clip starts at a float cursor that
// compares equal to an integer timeline frame. Report what the evaluator emits
// at that integer frame and whether the bf48a31 viewer predicate withholds it.
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
const clip = (id: string, rate: number, dur: number, url: string): Json => ({
  OTIO_SCHEMA: 'Clip.1',
  name: id,
  metadata: { relic: { id } },
  source_range: TR(RT(0, rate), RT(dur, rate)),
  media_reference: {
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url: url,
    available_range: TR(RT(0, rate), RT(dur * 2, rate)),
  },
});
const timeline = (kind: string, children: Json[]): string =>
  JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
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

const rates = [24, 25, 30, 60, 24000 / 1001, 30000 / 1001, 60000 / 1001];
let found = 0;
let withheld = 0;
const examples: unknown[] = [];
for (const ra of rates) {
  for (const rb of rates) {
    if (ra === rb) continue;
    for (const da of [12, 24]) {
      for (let db = 1; db <= 60; db += 1) {
        const children = [
          clip('a', ra, da, 'media/a.mp4'),
          clip('b', rb, db, 'media/b.mp4'),
          clip('c', ra, 24, 'media/c.mp4'),
        ];
        const doc = readOtioDocument(timeline('Video', children));
        const c = Object.values(doc.nodes).find((n) => n.name === 'c');
        const start = c?.timeline_range?.start_time;
        if (!start) continue;
        const nearest = Math.round(start.value);
        if (nearest === start.value) continue;
        const at = { value: nearest, rate: start.rate };
        if (compareRationalTimes(at, start) !== 0) continue;
        found += 1;
        const result = evaluateOtioAt(doc, 'timeline_1', at);
        for (const v of result.video_contributions) {
          const negative = timeToSeconds(v.source_time) < 0;
          const handles = v.diagnostics.some(
            (d) => d.code === 'missing-handles'
          );
          if (negative && !handles) {
            withheld += 1;
            if (examples.length < 4)
              examples.push({
                ra,
                rb,
                da,
                db,
                c_start: start,
                at,
                node: v.node_id,
                source_time: v.source_time,
                tolerant_vs_zero: compareRationalTimes(v.source_time, {
                  value: 0,
                  rate: v.source_time.rate,
                }),
              });
          }
        }
      }
    }
  }
}
console.log(
  JSON.stringify({ drift_cases: found, withheld_without_handles: withheld })
);
for (const e of examples) console.log(JSON.stringify(e));
