import type { OtioAnchorV1, OtioRationalTime } from '@relic/format';
import type { AnchorAdapter } from './anchoring.ts';
import { otioControllerFor } from './otio-bridge.ts';

function rationalLabel(time: OtioRationalTime): string {
  return `${time.value} @ ${time.rate}`;
}

export function otioTargetLabel(anchor: OtioAnchorV1): string {
  const scope = anchor.snapshot.track ?? 'Composition';
  const start = rationalLabel(anchor.range.start_time);
  const span =
    anchor.range.duration.value === 0
      ? `point ${start}`
      : `${start}, duration ${rationalLabel(anchor.range.duration)}`;
  return `v${anchor.relic_version} · ${anchor.snapshot.timeline} · ${scope} · ${span}`;
}

export const otioAdapter: AnchorAdapter<'otio'> = {
  kind: 'otio',
  label: otioTargetLabel,
  supports: (surface) => otioControllerFor(surface.content) !== undefined,
  paint: (surface, _overlay, anchor, commentId) =>
    otioControllerFor(surface.content)?.paint(anchor, commentId) ?? false,
  reveal: (surface, anchor) =>
    otioControllerFor(surface.content)?.reveal(anchor),
};
