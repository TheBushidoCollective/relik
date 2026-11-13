import {
  addRationalTimes,
  intersectRanges,
  type OtioRationalTime,
  type OtioTimeRange,
  rangeEndTime,
  rescaleTime,
  subtractRationalTimes,
} from '@relic/format';

/** Display coordinates only. Playback, source sampling and anchors stay canonical. */
export interface OtioTimelineDomain {
  readonly origin: OtioRationalTime;
  readonly range: OtioTimeRange;
  readonly rate: number;
}

export interface OtioTimelineViewport {
  readonly domain: OtioTimelineDomain;
  readonly pixelsPerFrame: number;
  readonly scrollLeft: number;
}

export function otioLocalTime(
  domain: OtioTimelineDomain,
  composition: OtioRationalTime
): OtioRationalTime {
  return rescaleTime(
    subtractRationalTimes(composition, domain.origin),
    domain.rate
  );
}

export function otioCompositionTime(
  domain: OtioTimelineDomain,
  localFrame: number
): OtioRationalTime {
  return addRationalTimes(domain.origin, {
    value: localFrame,
    rate: domain.rate,
  });
}

export interface OtioDomainFrameBounds {
  readonly start: number;
  readonly end: number;
  readonly last: number;
  readonly duration: number;
}

export function otioDomainFrames(
  domain: OtioTimelineDomain
): OtioDomainFrameBounds {
  const start = otioLocalTime(domain, domain.range.start_time).value;
  const end = otioLocalTime(domain, rangeEndTime(domain.range)).value;
  return {
    start,
    end,
    // The final partial frame is selectable, but the exclusive end never is.
    last: Math.max(start, Math.ceil(end) - 1),
    duration: rescaleTime(domain.range.duration, domain.rate).value,
  };
}

/** A full rail rectangle already includes its scroller's translation. */
export function otioPointerTime(
  domain: OtioTimelineDomain,
  clientX: number,
  rail: { readonly left: number; readonly width: number }
): OtioRationalTime {
  const fraction =
    rail.width > 0
      ? Math.max(0, Math.min(1, (clientX - rail.left) / rail.width))
      : 0;
  return addRationalTimes(domain.range.start_time, {
    value: domain.range.duration.value * fraction,
    rate: domain.range.duration.rate,
  });
}

export function otioRangeGeometry(
  domain: OtioTimelineDomain,
  range: OtioTimeRange
): { readonly left: number; readonly width: number } | undefined {
  if (domain.range.duration.value <= 0) return undefined;
  const visible = intersectRanges(domain.range, range);
  if (!visible) return undefined;
  const total = rescaleTime(domain.range.duration, domain.rate).value;
  return {
    left:
      rescaleTime(
        subtractRationalTimes(visible.start_time, domain.range.start_time),
        domain.rate
      ).value / total,
    width: rescaleTime(visible.duration, domain.rate).value / total,
  };
}

// Stay below Chromium/WebKit's layout-coordinate ceilings, including labels.
const MAX_RAIL_PIXELS = 8_000_000;
export const OTIO_INSPECTION_PIXELS_PER_FRAME = 16;
export function otioZoomLimits(
  domain: OtioTimelineDomain,
  width: number
): {
  readonly fit: number;
  readonly maximum: number;
} {
  const frames = otioDomainFrames(domain).duration;
  const fit = frames > 0 ? Math.max(1, width) / frames : 1;
  return {
    fit,
    maximum: Math.max(
      fit,
      Math.min(
        Math.max(OTIO_INSPECTION_PIXELS_PER_FRAME, fit * 16),
        MAX_RAIL_PIXELS / Math.max(1, frames)
      )
    ),
  };
}

/** pointerX is relative to the unobscured rail viewport, after sticky labels. */
export function otioZoomAt(
  viewport: OtioTimelineViewport,
  width: number,
  pointerX: number,
  requestedScale: number
): OtioTimelineViewport {
  const { fit, maximum } = otioZoomLimits(viewport.domain, width);
  const pixelsPerFrame = Math.max(fit, Math.min(maximum, requestedScale));
  const pivot = Math.max(0, Math.min(width, pointerX));
  const frame = (viewport.scrollLeft + pivot) / viewport.pixelsPerFrame;
  const railWidth = otioDomainFrames(viewport.domain).duration * pixelsPerFrame;
  return {
    domain: viewport.domain,
    pixelsPerFrame,
    scrollLeft: Math.max(
      0,
      Math.min(Math.max(0, railWidth - width), frame * pixelsPerFrame - pivot)
    ),
  };
}
