/**
 * OpenTimelineIO timing arithmetic, rational rates, evaluation, and source span mapping.
 */

import type {
  OtioAudioContribution,
  OtioDiagnostic,
  OtioDocumentV1,
  OtioEffect,
  OtioEvaluationResult,
  OtioMarker,
  OtioMediaReference,
  OtioNode,
  OtioRationalTime,
  OtioSourceSpan,
  OtioTimeRange,
  OtioVideoContribution,
} from './otio-types.ts';

/** Convert rational time to floating seconds. */
export function timeToSeconds(time: OtioRationalTime): number {
  if (time.rate === 0) return 0;
  return time.value / time.rate;
}

/** Create rational time from seconds and rate. */
export function secondsToTime(seconds: number, rate: number): OtioRationalTime {
  return {
    value: Math.round(seconds * rate),
    rate,
  };
}

/** Rescale rational time to a target rate. */
export function rescaleTime(
  time: OtioRationalTime,
  targetRate: number
): OtioRationalTime {
  if (time.rate === targetRate) {
    return time;
  }
  return {
    value: (time.value * targetRate) / time.rate,
    rate: targetRate,
  };
}

/** Compare two rational times (-1 if a < b, 0 if equal, 1 if a > b). */
export function compareRationalTimes(
  a: OtioRationalTime,
  b: OtioRationalTime
): number {
  if (a.rate === b.rate) {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  }
  const diff = a.value * b.rate - b.value * a.rate;
  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return 0;
}

/** Add two rational times, preserving the rate of the first operand. */
export function addRationalTimes(
  a: OtioRationalTime,
  b: OtioRationalTime
): OtioRationalTime {
  if (a.rate === b.rate) {
    return { value: a.value + b.value, rate: a.rate };
  }
  const rescaledB = rescaleTime(b, a.rate);
  return { value: a.value + rescaledB.value, rate: a.rate };
}

/** Subtract rational time b from a (a - b), preserving a.rate. */
export function subtractRationalTimes(
  a: OtioRationalTime,
  b: OtioRationalTime
): OtioRationalTime {
  if (a.rate === b.rate) {
    return { value: a.value - b.value, rate: a.rate };
  }
  const rescaledB = rescaleTime(b, a.rate);
  return { value: a.value - rescaledB.value, rate: a.rate };
}

/** Compute end time (start_time + duration) of a range. */
export function rangeEndTime(range: OtioTimeRange): OtioRationalTime {
  return addRationalTimes(range.start_time, range.duration);
}

/** Check if half-open range [start, start + duration) contains time. */
export function rangeContainsTime(
  range: OtioTimeRange,
  time: OtioRationalTime
): boolean {
  const startCmp = compareRationalTimes(time, range.start_time);
  if (startCmp < 0) return false;
  if (range.duration.value === 0) {
    return startCmp === 0;
  }
  const end = rangeEndTime(range);
  const endCmp = compareRationalTimes(time, end);
  return endCmp < 0;
}

/** Check if two half-open ranges intersect. */
export function rangesIntersect(a: OtioTimeRange, b: OtioTimeRange): boolean {
  if (a.duration.value === 0) {
    return rangeContainsTime(b, a.start_time);
  }
  if (b.duration.value === 0) {
    return rangeContainsTime(a, b.start_time);
  }
  const aEnd = rangeEndTime(a);
  const bEnd = rangeEndTime(b);
  const startMax =
    compareRationalTimes(a.start_time, b.start_time) >= 0
      ? a.start_time
      : b.start_time;
  const endMin = compareRationalTimes(aEnd, bEnd) <= 0 ? aEnd : bEnd;
  return compareRationalTimes(startMax, endMin) < 0;
}

/** Compute intersection of two half-open ranges, or null if no overlap. */
export function intersectRanges(
  a: OtioTimeRange,
  b: OtioTimeRange
): OtioTimeRange | null {
  if (!rangesIntersect(a, b)) return null;
  const aEnd = rangeEndTime(a);
  const bEnd = rangeEndTime(b);
  const startMax =
    compareRationalTimes(a.start_time, b.start_time) >= 0
      ? a.start_time
      : b.start_time;
  const endMin = compareRationalTimes(aEnd, bEnd) <= 0 ? aEnd : bEnd;
  const duration = subtractRationalTimes(endMin, startMax);
  return { start_time: startMax, duration };
}

/**
 * Pure evaluator for OpenTimelineIO documents at a given timeline time.
 */
export function evaluateOtioAt(
  document: OtioDocumentV1,
  timelineId: string,
  time: OtioRationalTime
): OtioEvaluationResult {
  const timelineNode = document.nodes[timelineId];
  const videoContribs: OtioVideoContribution[] = [];
  const audioContribs: OtioAudioContribution[] = [];
  const activeMarkers: {
    marker: OtioMarker;
    owner_node_id: string;
    timeline_range: OtioTimeRange;
  }[] = [];
  const diagnostics: OtioDiagnostic[] = [];

  if (!timelineNode) {
    return {
      timeline_id: timelineId,
      timeline_time: time,
      video_contributions: [],
      audio_contributions: [],
      active_markers: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'invalid-timing',
          message: `Timeline not found: ${timelineId}`,
        },
      ],
    };
  }

  // Traverse children stacks and tracks
  evaluateNodeAt(
    document,
    timelineNode,
    time,
    time,
    [],
    videoContribs,
    audioContribs,
    activeMarkers,
    diagnostics
  );

  return {
    timeline_id: timelineId,
    timeline_time: time,
    video_contributions: videoContribs,
    audio_contributions: audioContribs,
    active_markers: activeMarkers,
    diagnostics,
  };
}

function evaluateNodeAt(
  document: OtioDocumentV1,
  node: OtioNode,
  timelineTime: OtioRationalTime,
  localTime: OtioRationalTime,
  ancestry: readonly string[],
  videoOut: OtioVideoContribution[],
  audioOut: OtioAudioContribution[],
  markersOut: {
    marker: OtioMarker;
    owner_node_id: string;
    timeline_range: OtioTimeRange;
  }[],
  diagnosticsOut: OtioDiagnostic[]
): void {
  // Collect markers
  if (node.markers) {
    for (const marker of node.markers) {
      if (
        node.timeline_range &&
        rangesIntersect(marker.marked_range, node.timeline_range)
      ) {
        markersOut.push({
          marker,
          owner_node_id: node.id,
          timeline_range: marker.marked_range,
        });
      }
    }
  }

  if (node.schema.startsWith('Timeline')) {
    for (const childId of node.children_ids) {
      const child = document.nodes[childId];
      if (child) {
        evaluateNodeAt(
          document,
          child,
          timelineTime,
          localTime,
          [...ancestry, node.id],
          videoOut,
          audioOut,
          markersOut,
          diagnosticsOut
        );
      }
    }
    return;
  }

  if (node.schema.startsWith('Stack')) {
    // Stack children evaluated in painter order (first child at bottom)
    let trackIndex = 0;
    for (const childId of node.children_ids) {
      const child = document.nodes[childId];
      if (child) {
        evaluateTrackAt(
          document,
          child,
          trackIndex++,
          timelineTime,
          localTime,
          [...ancestry, node.id],
          videoOut,
          audioOut,
          markersOut,
          diagnosticsOut
        );
      }
    }
    return;
  }

  if (node.schema.startsWith('Track')) {
    evaluateTrackAt(
      document,
      node,
      0,
      timelineTime,
      localTime,
      ancestry,
      videoOut,
      audioOut,
      markersOut,
      diagnosticsOut
    );
  }
}

function evaluateTrackAt(
  document: OtioDocumentV1,
  track: OtioNode,
  trackIndex: number,
  timelineTime: OtioRationalTime,
  localTime: OtioRationalTime,
  ancestry: readonly string[],
  videoOut: OtioVideoContribution[],
  audioOut: OtioAudioContribution[],
  markersOut: {
    marker: OtioMarker;
    owner_node_id: string;
    timeline_range: OtioTimeRange;
  }[],
  diagnosticsOut: OtioDiagnostic[]
): void {
  if (!track.enabled) return;

  const isVideo = track.track_kind === 'Video';
  const isAudio = track.track_kind === 'Audio';

  // Evaluate items in track
  for (let i = 0; i < track.children_ids.length; i++) {
    const childId = track.children_ids[i] as string;
    const child = document.nodes[childId];
    if (!child || !child.parent_range) continue;

    // Check if child is a Transition
    if (child.schema.startsWith('Transition')) {
      continue;
    }

    // Check if child range contains localTime
    // Consider adjacent transitions before or after this child
    const inRange = rangeContainsTime(child.parent_range, localTime);
    if (!inRange) {
      // Check transition overlaps
      continue;
    }

    if (!child.enabled) continue;

    // Compute source sample time
    let sourceTime = child.source_range
      ? addRationalTimes(
          child.source_range.start_time,
          subtractRationalTimes(localTime, child.parent_range.start_time)
        )
      : subtractRationalTimes(localTime, child.parent_range.start_time);

    // Apply FreezeFrame or LinearTimeWarp
    if (child.effects) {
      for (const eff of child.effects) {
        if (!eff.enabled) continue;
        if (eff.schema.startsWith('FreezeFrame')) {
          if (child.source_range) {
            sourceTime = child.source_range.start_time;
          }
        } else if (
          eff.schema.startsWith('LinearTimeWarp') &&
          eff.time_scalar !== undefined
        ) {
          if (child.source_range) {
            const offset = subtractRationalTimes(
              localTime,
              child.parent_range.start_time
            );
            sourceTime = addRationalTimes(child.source_range.start_time, {
              value: offset.value * eff.time_scalar,
              rate: offset.rate,
            });
          }
        }
      }
    }

    // Media offset: subtract available_range.start_time
    const activeKey = child.active_media_reference_key;
    const activeMedia =
      activeKey && child.media_references
        ? child.media_references[activeKey]
        : null;
    let fileRelativeTime = sourceTime;
    if (activeMedia?.available_range) {
      fileRelativeTime = subtractRationalTimes(
        sourceTime,
        activeMedia.available_range.start_time
      );
    }

    const bundlePath = activeMedia?.target_url ?? null;
    const mediaKey = activeKey ?? null;

    if (isVideo && !child.schema.startsWith('Gap')) {
      videoOut.push({
        track_id: track.id,
        track_index: trackIndex,
        node_id: child.id,
        name: child.name,
        media_key: mediaKey,
        bundle_path: bundlePath,
        source_time: fileRelativeTime,
        alpha: 1.0,
        transition_weight: 1.0,
        active_effects: child.effects ?? [],
        diagnostics: child.diagnostics ?? [],
      });
    }

    if (isAudio && !child.schema.startsWith('Gap')) {
      audioOut.push({
        track_id: track.id,
        track_index: trackIndex,
        node_id: child.id,
        name: child.name,
        media_key: mediaKey,
        bundle_path: bundlePath,
        source_time: fileRelativeTime,
        volume: 1.0,
        transition_weight: 1.0,
        active_effects: child.effects ?? [],
        diagnostics: child.diagnostics ?? [],
      });
    }
  }
}

/**
 * Identify all source spans intersecting a given timeline range on a track.
 */
export function sourceSpansForOtioRange(
  document: OtioDocumentV1,
  timelineId: string,
  trackId: string | null,
  range: OtioTimeRange
): readonly OtioSourceSpan[] {
  const spans: OtioSourceSpan[] = [];
  const timelineNode = document.nodes[timelineId];
  if (!timelineNode) return spans;

  const tracksToSearch: OtioNode[] = [];
  for (const nodeId in document.nodes) {
    const node = document.nodes[nodeId];
    if (node && node.schema.startsWith('Track')) {
      if (trackId === null || node.id === trackId) {
        tracksToSearch.push(node);
      }
    }
  }

  for (const track of tracksToSearch) {
    for (const childId of track.children_ids) {
      const child = document.nodes[childId];
      if (!child || !child.timeline_range) continue;

      const intersection = intersectRanges(child.timeline_range, range);
      if (intersection) {
        const activeKey = child.active_media_reference_key;
        const activeMedia =
          activeKey && child.media_references
            ? child.media_references[activeKey]
            : null;

        let fileRelativeRange: OtioTimeRange | null = null;
        if (child.source_range) {
          const availStart = activeMedia?.available_range?.start_time ?? {
            value: 0,
            rate: child.source_range.start_time.rate,
          };
          fileRelativeRange = {
            start_time: subtractRationalTimes(
              child.source_range.start_time,
              availStart
            ),
            duration: child.source_range.duration,
          };
        }

        spans.push({
          timeline_id: timelineId,
          track_id: track.id,
          track_path: [timelineId, track.id],
          node_id: child.id,
          schema: child.schema,
          name: child.name,
          enabled: child.enabled,
          timeline_range: child.timeline_range,
          intersected_timeline_range: intersection,
          source_range: child.source_range ?? null,
          available_range: activeMedia?.available_range ?? null,
          file_relative_source_range: fileRelativeRange,
          media_key: activeKey ?? null,
          bundle_path: activeMedia?.target_url ?? null,
          active_media_reference_key: activeKey ?? null,
          media_references: child.media_references ?? {},
          effects: child.effects ?? [],
          markers: child.markers ?? [],
          diagnostics: child.diagnostics ?? [],
        });
      }
    }
  }

  return spans;
}
