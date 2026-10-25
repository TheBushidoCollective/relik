import type { OtioAnchorV1, OtioRationalTime } from '@relic/format';
import type { AnchorAdapter } from './anchoring.ts';
import { otioControllerFor } from './otio-bridge.ts';

function rationalLabel(time: OtioRationalTime): string {
  return `${time.value} @ ${time.rate}`;
}

export function otioTargetLabel(anchor: OtioAnchorV1): string {
  const scope = anchor.snapshot?.track ?? anchor.track_id ?? 'Composition';
  const start = rationalLabel(anchor.range.start_time);
  const span =
    anchor.range.duration.value === 0
      ? `point ${start}`
      : `${start}, duration ${rationalLabel(anchor.range.duration)}`;
  const timeline = anchor.snapshot?.timeline ?? anchor.timeline_id ?? '';
  return `v${anchor.relic_version} · ${timeline} · ${scope} · ${span}`;
}

export const otioAdapter: AnchorAdapter<'otio'> = {
  kind: 'otio',
  label: otioTargetLabel,
  supports: (surface) => otioControllerFor(surface.content) !== undefined,
  paint: (surface, _overlay, anchor, commentId) =>
    otioControllerFor(surface.content)?.paint(anchor, commentId) ?? false,
  reveal: (surface, anchor, commentId) =>
    otioControllerFor(surface.content)?.reveal(anchor, commentId),
};
