/**
 * OpenTimelineIO timing arithmetic, rational rates, evaluation, and source span mapping.
 *
 * Implements:
 * - Pure rational arithmetic with exact integer rates and fractional rates (e.g. 30000/1001).
 * - Half-open intervals [start, start + duration), where zero duration represents a point.
 * - Multi-track evaluation in Stack painter order (bottom to top for video, additive for audio).
 * - Sequential track placement with SMPTE_Dissolve transition overlapping and weighting.
 * - Missing transition handle detection against available_range.
 * - File-relative source offsets by subtracting available_range.start_time after transforms.
 * - Retiming: FreezeFrame (holds first frame) and LinearTimeWarp (positive, zero, negative scalar).
 * - ImageSequenceReference resolution (padding, frame step, missing frame policies).
 * - Marker transformation from item source coordinates into timeline coordinates.
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

const EPSILON_SECONDS = 1e-7;

/** Convert rational time to floating seconds. */
export function timeToSeconds(time: OtioRationalTime): number {
  if (
    !Number.isFinite(time.value) ||
    !Number.isFinite(time.rate) ||
    time.rate <= 0
  ) {
    throw new TypeError(
      `Invalid rational time: rate must be positive and finite (got rate=${time.rate}, value=${time.value})`
    );
  }
  return time.value / time.rate;
}

/** Create rational time from seconds and rate. */
export function secondsToTime(seconds: number, rate: number): OtioRationalTime {
  if (!Number.isFinite(seconds) || !Number.isFinite(rate) || rate <= 0) {
    throw new TypeError(
      'Invalid seconds or rate: rate must be positive and finite'
    );
  }
  return {
    value: seconds * rate,
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
    const diff = a.value - b.value;
    if (Math.abs(diff) < EPSILON_SECONDS) return 0;
    return diff < 0 ? -1 : 1;
  }
  const aSec = a.value / a.rate;
  const bSec = b.value / b.rate;
  const diffSec = aSec - bSec;
  if (Math.abs(diffSec) < EPSILON_SECONDS) return 0;
  return diffSec < 0 ? -1 : 1;
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

  if (a.duration.value === 0) {
    return {
      start_time: a.start_time,
      duration: { value: 0, rate: a.start_time.rate },
    };
  }
  if (b.duration.value === 0) {
    return {
      start_time: b.start_time,
      duration: { value: 0, rate: b.start_time.rate },
    };
  }

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
  // Check markers on this node
  if (node.markers) {
    for (const marker of node.markers) {
      let markerTimelineRange = marker.marked_range;
      if (node.timeline_range && node.source_range) {
        // Marker in source coordinates on a clip: transform to timeline coordinates
        const offset = subtractRationalTimes(
          marker.marked_range.start_time,
          node.source_range.start_time
        );
        markerTimelineRange = {
          start_time: addRationalTimes(node.timeline_range.start_time, offset),
          duration: marker.marked_range.duration,
        };
      } else if (node.timeline_range) {
        markerTimelineRange = {
          start_time: addRationalTimes(
            node.timeline_range.start_time,
            marker.marked_range.start_time
          ),
          duration: marker.marked_range.duration,
        };
      }

      if (rangeContainsTime(markerTimelineRange, timelineTime)) {
        markersOut.push({
          marker,
          owner_node_id: node.id,
          timeline_range: markerTimelineRange,
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
        if (child.schema.startsWith('Track')) {
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
        } else {
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

interface ItemActiveEvaluation {
  readonly child: OtioNode;
  readonly sampleTime: OtioRationalTime;
  readonly weight: number;
  readonly transitionType?: string;
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
  const children = track.children_ids
    .map((id) => document.nodes[id])
    .filter(Boolean) as OtioNode[];

  // Find active items taking into account Transitions
  const activeItems: ItemActiveEvaluation[] = [];

  for (let i = 0; i < children.length; i++) {
    const item = children[i] as OtioNode;

    if (item.schema.startsWith('Transition')) {
      const prevItem = i > 0 ? (children[i - 1] as OtioNode) : null;
      const nextItem =
        i + 1 < children.length ? (children[i + 1] as OtioNode) : null;

      const inOffset = item.in_offset ?? { value: 0, rate: localTime.rate };
      const outOffset = item.out_offset ?? { value: 0, rate: localTime.rate };

      // Transition edit point:
      // If prevItem has parent_range: edit point = prevItem.parent_range.end
      // Else if nextItem has parent_range: edit point = nextItem.parent_range.start
      const editPoint = prevItem?.parent_range
        ? rangeEndTime(prevItem.parent_range)
        : nextItem?.parent_range
          ? nextItem.parent_range.start_time
          : localTime;

      const transStart = subtractRationalTimes(editPoint, inOffset);
      const transEnd = addRationalTimes(editPoint, outOffset);
      const transRange: OtioTimeRange = {
        start_time: transStart,
        duration: addRationalTimes(inOffset, outOffset),
      };

      if (rangeContainsTime(transRange, localTime)) {
        const transDurationSec = timeToSeconds(transRange.duration);
        const progressSec =
          transDurationSec > 0
            ? (timeToSeconds(localTime) - timeToSeconds(transStart)) /
              transDurationSec
            : 1.0;
        const progress = Math.max(0, Math.min(1, progressSec));

        // Prev item (outgoing)
        if (prevItem && prevItem.parent_range) {
          const sample = calculateSourceSampleTime(prevItem, localTime);
          activeItems.push({
            child: prevItem,
            sampleTime: sample,
            weight: 1.0 - progress,
            transitionType: item.transition_type ?? 'SMPTE_Dissolve',
          });
        }

        // Next item (incoming)
        if (nextItem && nextItem.parent_range) {
          const sample = calculateSourceSampleTime(nextItem, localTime);
          activeItems.push({
            child: nextItem,
            sampleTime: sample,
            weight: progress,
            transitionType: item.transition_type ?? 'SMPTE_Dissolve',
          });
        }
        break; // Transition handles this moment on this track
      }
    } else if (
      item.parent_range &&
      rangeContainsTime(item.parent_range, localTime)
    ) {
      // Check if this item is inside an adjacent transition
      // Lookahead/lookbehind for transition overlap
      const nextSibling = i + 1 < children.length ? children[i + 1] : null;
      const prevSibling = i > 0 ? children[i - 1] : null;

      let inTransition = false;
      if (
        nextSibling?.schema.startsWith('Transition') &&
        nextSibling.in_offset
      ) {
        const editPoint = rangeEndTime(item.parent_range);
        const transStart = subtractRationalTimes(
          editPoint,
          nextSibling.in_offset
        );
        if (compareRationalTimes(localTime, transStart) >= 0) {
          inTransition = true;
        }
      }
      if (
        prevSibling?.schema.startsWith('Transition') &&
        prevSibling.out_offset
      ) {
        const editPoint = item.parent_range.start_time;
        const transEnd = addRationalTimes(editPoint, prevSibling.out_offset);
        if (compareRationalTimes(localTime, transEnd) < 0) {
          inTransition = true;
        }
      }

      if (!inTransition) {
        const sample = calculateSourceSampleTime(item, localTime);
        activeItems.push({
          child: item,
          sampleTime: sample,
          weight: 1.0,
        });
        break;
      }
    }
  }

  // Process active item evaluations
  for (const { child, sampleTime, weight, transitionType } of activeItems) {
    if (!child.enabled) continue;

    // Check nested composition
    if (child.schema.startsWith('Stack') || child.schema.startsWith('Track')) {
      // Nested composition: map time into child coordinates
      let childLocalTime = sampleTime;
      if (child.source_range) {
        childLocalTime = sampleTime;
      }
      evaluateNodeAt(
        document,
        child,
        timelineTime,
        childLocalTime,
        [...ancestry, track.id, child.id],
        videoOut,
        audioOut,
        markersOut,
        diagnosticsOut
      );
      continue;
    }

    const activeKey = child.active_media_reference_key;
    const activeMedia =
      activeKey && child.media_references
        ? child.media_references[activeKey]
        : null;

    // File-relative time: subtract available_range.start_time
    let fileRelativeTime = sampleTime;
    if (activeMedia?.available_range) {
      fileRelativeTime = subtractRationalTimes(
        sampleTime,
        activeMedia.available_range.start_time
      );

      // Check transition handles against available_range
      if (
        compareRationalTimes(
          sampleTime,
          activeMedia.available_range.start_time
        ) < 0
      ) {
        diagnosticsOut.push({
          severity: 'warning',
          code: 'missing-handles',
          message: `Sample time ${timeToSeconds(sampleTime)}s precedes available media start ${timeToSeconds(activeMedia.available_range.start_time)}s`,
          target: { node_id: child.id, media_key: activeKey ?? undefined },
        });
      }
      const availEnd = rangeEndTime(activeMedia.available_range);
      if (compareRationalTimes(sampleTime, availEnd) > 0) {
        diagnosticsOut.push({
          severity: 'warning',
          code: 'missing-handles',
          message: `Sample time ${timeToSeconds(sampleTime)}s exceeds available media end ${timeToSeconds(availEnd)}s`,
          target: { node_id: child.id, media_key: activeKey ?? undefined },
        });
      }
    }

    let bundlePath = activeMedia?.target_url ?? null;
    let sourceFrame: number | undefined;
    let alpha = weight;

    // ImageSequenceReference
    if (
      activeMedia &&
      activeMedia.schema.startsWith('ImageSequenceReference')
    ) {
      const seqRate = activeMedia.rate ?? 24;
      const startFrame = activeMedia.start_frame ?? 0;
      const frameStep = activeMedia.frame_step ?? 1;
      const padding = activeMedia.frame_zero_padding ?? 0;
      const prefix = activeMedia.name_prefix ?? '';
      const suffix = activeMedia.name_suffix ?? '';
      const base = activeMedia.target_url_base ?? '';

      const fileSec = timeToSeconds(fileRelativeTime);
      const frameIdx = Math.floor(fileSec * seqRate);
      const frameNumber = startFrame + frameIdx * frameStep;
      const padStr =
        padding > 0
          ? String(Math.max(0, frameNumber)).padStart(padding, '0')
          : String(frameNumber);
      const frameFileName = prefix + padStr + suffix;
      const frameBundlePath = (base + frameFileName)
        .replace(/\/+/g, '/')
        .replace(/^\//, '');

      sourceFrame = frameNumber;
      bundlePath = frameBundlePath;

      if (document.media && Object.keys(document.media).length > 0) {
        if (!document.media[frameBundlePath]) {
          const policy = activeMedia.missing_frame_policy ?? 'error';
          if (policy === 'error') {
            diagnosticsOut.push({
              severity: 'error',
              code: 'missing-media',
              message: `Image sequence frame missing: ${frameBundlePath}`,
              target: { node_id: child.id, media_key: activeKey ?? undefined },
            });
          } else if (policy === 'black') {
            alpha = 0;
          }
        }
      }
    }

    // Diagnostics for unsupported effects / codecs / schemas
    const itemDiags: OtioDiagnostic[] = [...(child.diagnostics ?? [])];
    if (child.effects) {
      for (const eff of child.effects) {
        if (
          eff.enabled &&
          !eff.schema.startsWith('FreezeFrame') &&
          !eff.schema.startsWith('LinearTimeWarp')
        ) {
          itemDiags.push({
            severity: 'warning',
            code: 'unsupported-effect',
            message: `Unsupported effect: ${eff.effect_name || eff.name || eff.schema}`,
            target: { node_id: child.id },
          });
        }
      }
    }

    if (isVideo && !child.schema.startsWith('Gap')) {
      videoOut.push({
        track_id: track.id,
        track_index: trackIndex,
        node_id: child.id,
        name: child.name,
        media_key: activeKey ?? null,
        bundle_path: bundlePath,
        source_time: fileRelativeTime,
        source_frame: sourceFrame,
        alpha,
        transition_weight: weight,
        transition_type: transitionType,
        active_effects: child.effects ?? [],
        diagnostics: itemDiags,
      });
    }

    if (isAudio && !child.schema.startsWith('Gap')) {
      audioOut.push({
        track_id: track.id,
        track_index: trackIndex,
        node_id: child.id,
        name: child.name,
        media_key: activeKey ?? null,
        bundle_path: bundlePath,
        source_time: fileRelativeTime,
        volume: weight,
        transition_weight: weight,
        transition_type: transitionType,
        active_effects: child.effects ?? [],
        diagnostics: itemDiags,
      });
    }
  }
}

/**
 * Calculate source sample time for an item at local track time,
 * factoring in source_range trims, FreezeFrame, and LinearTimeWarp.
 */
function calculateSourceSampleTime(
  item: OtioNode,
  localTime: OtioRationalTime
): OtioRationalTime {
  const itemStart = item.parent_range?.start_time ?? {
    value: 0,
    rate: localTime.rate,
  };
  const offsetFromStart = subtractRationalTimes(localTime, itemStart);

  let sourceTime = item.source_range
    ? addRationalTimes(item.source_range.start_time, offsetFromStart)
    : offsetFromStart;

  if (item.effects) {
    for (const eff of item.effects) {
      if (!eff.enabled) continue;
      if (eff.schema.startsWith('FreezeFrame')) {
        if (item.source_range) {
          sourceTime = item.source_range.start_time;
        }
      } else if (
        eff.schema.startsWith('LinearTimeWarp') &&
        eff.time_scalar !== undefined
      ) {
        if (item.source_range) {
          if (eff.time_scalar === 0) {
            sourceTime = item.source_range.start_time;
          } else if (eff.time_scalar > 0) {
            sourceTime = addRationalTimes(item.source_range.start_time, {
              value: offsetFromStart.value * eff.time_scalar,
              rate: offsetFromStart.rate,
            });
          } else {
            // Negative scalar: reverse sampling from source range end
            const itemEnd = rangeEndTime(item.source_range);
            sourceTime = addRationalTimes(itemEnd, {
              value: offsetFromStart.value * eff.time_scalar,
              rate: offsetFromStart.rate,
            });
          }
        }
      }
    }
  }

  return sourceTime;
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
          const offsetStart = subtractRationalTimes(
            intersection.start_time,
            child.timeline_range.start_time
          );
          const sourceStartTime = addRationalTimes(
            child.source_range.start_time,
            offsetStart
          );

          fileRelativeRange = {
            start_time: subtractRationalTimes(sourceStartTime, availStart),
            duration: intersection.duration,
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
