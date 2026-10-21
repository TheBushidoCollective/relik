/**
 * OpenTimelineIO timing, evaluation, and source-span mapping.
 *
 * Placement lives in otio-identity.ts. This module is the only sampler:
 * point evaluation, interval traversal, and inverse projection share one
 * rational affine map. Tree branch weights are the video transition weights.
 * Flat video transition_weight is reporting only.
 */

import type {
  OtioAudioContribution,
  OtioDiagnostic,
  OtioDocumentV1,
  OtioEffect,
  OtioEvaluationResult,
  OtioMediaReference,
  OtioNode,
  OtioRationalTime,
  OtioSourceMapping,
  OtioSourceSpan,
  OtioTimeRange,
  OtioTimelineMarker,
  OtioVideoComposition,
  OtioVideoContribution,
} from './otio-types.ts';

const EPSILON_SECONDS = 1e-7;
const MAX_FRAME_PAD = 32;
const MAX_SEQUENCE_PATH = 1024;

export interface OtioBoundMap {
  /** Root time of local_origin. Independent of ancestor clipping. */
  readonly timeline_origin: OtioRationalTime;
  /** Owner-local coordinate that lands on timeline_origin. */
  readonly local_origin: OtioRationalTime;
  /** Media sample at timeline_origin. Last selected frame when scalar is negative. */
  readonly sample_origin: OtioRationalTime;
  readonly scalar: number;
  readonly available_start: OtioRationalTime | null;
}

const boundMaps = new WeakMap<OtioNode, OtioBoundMap>();

export function bindOtioSamplingMap(node: OtioNode, map: OtioBoundMap): void {
  boundMaps.set(node, map);
}

export function otioSamplingMap(node: OtioNode): OtioBoundMap | undefined {
  return boundMaps.get(node);
}

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

export function secondsToTime(seconds: number, rate: number): OtioRationalTime {
  if (!Number.isFinite(seconds) || !Number.isFinite(rate) || rate <= 0) {
    throw new TypeError(
      'Invalid seconds or rate: rate must be positive and finite'
    );
  }
  return { value: seconds * rate, rate };
}

export function rescaleTime(
  time: OtioRationalTime,
  targetRate: number
): OtioRationalTime {
  if (time.rate === targetRate) return time;
  return {
    value: (time.value * targetRate) / time.rate,
    rate: targetRate,
  };
}

export function compareRationalTimes(
  a: OtioRationalTime,
  b: OtioRationalTime
): number {
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return NaN;
  if (a.rate === b.rate) {
    const diff = a.value - b.value;
    if (Math.abs(diff) < EPSILON_SECONDS) return 0;
    return diff < 0 ? -1 : 1;
  }
  if (
    !Number.isFinite(a.rate) ||
    !Number.isFinite(b.rate) ||
    a.rate === 0 ||
    b.rate === 0
  ) {
    return NaN;
  }
  const cross = a.value * b.rate - b.value * a.rate;
  const scale = Math.max(Math.abs(a.rate), Math.abs(b.rate), 1);
  if (Math.abs(cross) <= EPSILON_SECONDS * scale * scale) return 0;
  return cross < 0 ? -1 : 1;
}

export function addRationalTimes(
  a: OtioRationalTime,
  b: OtioRationalTime
): OtioRationalTime {
  if (a.rate === b.rate) return { value: a.value + b.value, rate: a.rate };
  const rescaledB = rescaleTime(b, a.rate);
  return { value: a.value + rescaledB.value, rate: a.rate };
}

export function subtractRationalTimes(
  a: OtioRationalTime,
  b: OtioRationalTime
): OtioRationalTime {
  if (a.rate === b.rate) return { value: a.value - b.value, rate: a.rate };
  const rescaledB = rescaleTime(b, a.rate);
  return { value: a.value - rescaledB.value, rate: a.rate };
}

export function rangeEndTime(range: OtioTimeRange): OtioRationalTime {
  return addRationalTimes(range.start_time, range.duration);
}

export function rangeContainsTime(
  range: OtioTimeRange,
  time: OtioRationalTime
): boolean {
  const startCmp = compareRationalTimes(time, range.start_time);
  if (startCmp < 0) return false;
  if (range.duration.value === 0) return startCmp === 0;
  return compareRationalTimes(time, rangeEndTime(range)) < 0;
}

export function rangesIntersect(a: OtioTimeRange, b: OtioTimeRange): boolean {
  if (a.duration.value === 0) return rangeContainsTime(b, a.start_time);
  if (b.duration.value === 0) return rangeContainsTime(a, b.start_time);
  const startMax =
    compareRationalTimes(a.start_time, b.start_time) >= 0
      ? a.start_time
      : b.start_time;
  const endMin =
    compareRationalTimes(rangeEndTime(a), rangeEndTime(b)) <= 0
      ? rangeEndTime(a)
      : rangeEndTime(b);
  return compareRationalTimes(startMax, endMin) < 0;
}

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
  return {
    start_time: startMax,
    duration: subtractRationalTimes(endMin, startMax),
  };
}

function ownNode(
  nodes: Readonly<Record<string, OtioNode>>,
  id: string
): OtioNode | undefined {
  return Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : undefined;
}

function isTimeline(schema: string): boolean {
  return schema === 'Timeline.1';
}
function isStack(schema: string): boolean {
  return schema === 'Stack.1';
}
function isTrack(schema: string): boolean {
  return schema === 'Track.1';
}
function isClip(schema: string): boolean {
  return schema === 'Clip.1' || schema === 'Clip.2';
}
function isGap(schema: string): boolean {
  return schema === 'Gap.1';
}
function isTransition(schema: string): boolean {
  return schema === 'Transition.1';
}

export function sampleOtioMedia(map: OtioBoundMap, time: OtioRationalTime): OtioRationalTime {
  const delta = subtractRationalTimes(time, map.timeline_origin);
  const scaled = rescaleTime(delta, map.sample_origin.rate);
  return {
    value: map.sample_origin.value + scaled.value * map.scalar,
    rate: map.sample_origin.rate,
  };
}

function fileRelative(
  map: OtioBoundMap,
  media: OtioRationalTime
): OtioRationalTime | null {
  if (!map.available_start) return null;
  return subtractRationalTimes(media, map.available_start);
}

function editorialTime(
  map: OtioBoundMap,
  local: OtioRationalTime
): OtioRationalTime {
  const delta = subtractRationalTimes(local, map.local_origin);
  return addRationalTimes(map.timeline_origin, delta);
}

export function invertOtioSample(
  map: OtioBoundMap,
  media: OtioRationalTime
): OtioRationalTime | null {
  if (!Number.isFinite(map.scalar) || map.scalar === 0) return null;
  const delta = subtractRationalTimes(media, map.sample_origin);
  const unscaled = {
    value: delta.value / map.scalar,
    rate: delta.rate,
  };
  return addRationalTimes(map.timeline_origin, unscaled);
}

function effectScalar(node: OtioNode): number {
  let scalar = 1;
  for (const effect of node.effects ?? []) {
    if (!effect.enabled) continue;
    if (effect.schema === 'FreezeFrame.1') {
      scalar = 0;
      continue;
    }
    if (effect.schema === 'LinearTimeWarp.1') {
      const value = effect.time_scalar;
      if (typeof value === 'number' && Number.isFinite(value)) {
        scalar *= value;
      }
    }
  }
  return scalar;
}

function activeReference(node: OtioNode): OtioMediaReference | null {
  const refs = node.media_references;
  const key = node.active_media_reference_key;
  if (!refs || !key) return null;
  if (!Object.prototype.hasOwnProperty.call(refs, key)) return null;
  return refs[key] ?? null;
}

function formatFrame(frame: number, pad: number): string | null {
  if (!Number.isSafeInteger(frame)) return null;
  if (!Number.isInteger(pad) || pad < 0 || pad > MAX_FRAME_PAD) return null;
  const negative = frame < 0;
  const digits = String(Math.abs(frame));
  const body = digits.length >= pad ? digits : digits.padStart(pad, '0');
  return `${negative ? '-' : ''}${body}`;
}

function joinSequenceUrl(
  ref: OtioMediaReference,
  imageIndex: number
): { path: string; frame: number } | null {
  const step = ref.frame_step ?? 1;
  const start = ref.start_frame ?? 0;
  const pad = ref.frame_zero_padding ?? 0;
  if (!Number.isFinite(step) || step <= 0) return null;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(imageIndex)) {
    return null;
  }
  const frame = start + imageIndex * step;
  const text = formatFrame(frame, pad);
  if (text === null || !Number.isSafeInteger(frame)) return null;
  const base = ref.target_url_base ?? '';
  const slash = base.length > 0 && !base.endsWith('/') ? '/' : '';
  const path = `${base}${slash}${ref.name_prefix ?? ''}${text}${ref.name_suffix ?? ''}`;
  if (path.length === 0 || path.length > MAX_SEQUENCE_PATH) return null;
  return { path, frame };
}

function sequenceOffset(
  ref: OtioMediaReference,
  media: OtioRationalTime
): number | null {
  const rate = ref.rate && ref.rate > 0 ? ref.rate : media.rate;
  const local = rescaleTime(media, rate);
  const start = ref.available_range?.start_time;
  const offset = start ? subtractRationalTimes(local, rescaleTime(start, rate)) : local;
  if (!Number.isFinite(offset.value)) return null;
  return offset.value;
}

function presentationImageCount(ref: OtioMediaReference): number | null {
  const step = ref.frame_step ?? 1;
  const duration = ref.available_range?.duration.value;
  if (!duration || !Number.isFinite(duration) || !Number.isFinite(step) || step <= 0) {
    return null;
  }
  return Math.floor(duration / step);
}

interface SequenceChoice {
  readonly path: string | null;
  readonly frame: number | undefined;
  readonly kind: 'media' | 'black';
  readonly diagnostics: OtioDiagnostic[];
}

function chooseSequenceFrame(
  document: OtioDocumentV1,
  node: OtioNode,
  ref: OtioMediaReference,
  media: OtioRationalTime
): SequenceChoice {
  const diagnostics: OtioDiagnostic[] = [];
  const step = ref.frame_step ?? 1;
  const offset = sequenceOffset(ref, media);
  if (offset === null || !Number.isFinite(step) || step <= 0) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid-timing',
      message: `Image sequence timing on ${node.name || node.id} is not a finite positive step`,
      target: { node_id: node.id, json_pointer: node.json_pointer },
    });
    return { path: null, frame: undefined, kind: 'media', diagnostics };
  }
  const imageIndex = Math.floor(offset / step);
  const count = presentationImageCount(ref);
  const outside = imageIndex < 0 || (count !== null && imageIndex >= count);
  const policy = ref.missing_frame_policy ?? 'error';
  const indexHasEntries = Object.keys(document.media).length > 0;

  const resolve = (index: number): { path: string; frame: number } | null => {
    const built = joinSequenceUrl(ref, index);
    return built;
  };

  const inIndex = (path: string): boolean => {
    if (!indexHasEntries) return true;
    return Object.prototype.hasOwnProperty.call(document.media, path);
  };

  if (!outside) {
    const built = resolve(imageIndex);
    if (!built) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-timing',
        message: `Image sequence path for ${node.name || node.id} is not a safe frame number`,
        target: { node_id: node.id },
      });
      return { path: null, frame: undefined, kind: 'media', diagnostics };
    }
    if (inIndex(built.path)) {
      return {
        path: built.path,
        frame: built.frame,
        kind: 'media',
        diagnostics,
      };
    }
  }

  if (policy === 'black') {
    return { path: null, frame: undefined, kind: 'black', diagnostics };
  }

  if (policy === 'hold') {
    const startIndex = outside
      ? Math.max(0, (count ?? imageIndex) - 1)
      : imageIndex - 1;
    for (let index = startIndex; index >= 0; index -= 1) {
      const built = resolve(index);
      if (!built) continue;
      if (!indexHasEntries || inIndex(built.path)) {
        return {
          path: built.path,
          frame: built.frame,
          kind: 'media',
          diagnostics,
        };
      }
    }
  }

  diagnostics.push({
    severity: 'warning',
    code: 'missing-media',
    message: `Image sequence frame for ${node.name || node.id} is not in the bundle`,
    target: { node_id: node.id, media_key: node.active_media_reference_key ?? undefined },
  });
  return { path: null, frame: undefined, kind: 'media', diagnostics };
}

function unknownEffectDiagnostics(node: OtioNode): OtioDiagnostic[] {
  const found: OtioDiagnostic[] = [];
  for (const effect of node.effects ?? []) {
    if (!effect.enabled) continue;
    if (
      effect.schema === 'FreezeFrame.1' ||
      effect.schema === 'LinearTimeWarp.1'
    ) {
      continue;
    }
    found.push({
      severity: 'warning',
      code: 'unsupported-effect',
      message: `Enabled effect ${effect.effect_name || effect.schema} is not applied; preview is base media`,
      target: { node_id: node.id, json_pointer: node.json_pointer },
    });
  }
  if (
    isTransition(node.schema) &&
    node.transition_type &&
    node.transition_type !== 'SMPTE_Dissolve'
  ) {
    found.push({
      severity: 'warning',
      code: 'unsupported-effect',
      message: `Transition ${node.transition_type} is previewed as a linear dissolve`,
      target: { node_id: node.id },
    });
  }
  return found;
}

function missingHandleDiagnostic(
  node: OtioNode,
  media: OtioRationalTime,
  available: OtioTimeRange | null | undefined
): OtioDiagnostic | null {
  if (!available) return null;
  if (rangeContainsTime(available, media)) return null;
  return {
    severity: 'warning',
    code: 'missing-handles',
    message: `Requested source for ${node.name || node.id} is outside available media`,
    target: { node_id: node.id, json_pointer: node.json_pointer },
  };
}


function transitionAt(
  document: OtioDocumentV1,
  track: OtioNode,
  time: OtioRationalTime
): { transition: OtioNode; progress: number } | null {
  for (const childId of track.children_ids) {
    const child = ownNode(document.nodes, childId);
    if (!child || !isTransition(child.schema) || !child.timeline_range) continue;
    if (!rangeContainsTime(child.timeline_range, time)) continue;
    const duration = timeToSeconds(child.timeline_range.duration);
    const into = timeToSeconds(
      subtractRationalTimes(time, child.timeline_range.start_time)
    );
    const progress = duration === 0 ? 0 : into / duration;
    return { transition: child, progress };
  }
  return null;
}

function neighborItem(
  document: OtioDocumentV1,
  track: OtioNode,
  transitionId: string,
  direction: -1 | 1
): OtioNode | null {
  const ids = track.children_ids;
  const index = ids.indexOf(transitionId);
  if (index < 0) return null;
  for (
    let cursor = index + direction;
    cursor >= 0 && cursor < ids.length;
    cursor += direction
  ) {
    const child = ownNode(document.nodes, ids[cursor] as string);
    if (!child || isTransition(child.schema)) continue;
    return child;
  }
  return null;
}

function composeChild(
  document: OtioDocumentV1,
  node: OtioNode,
  ancestry: readonly string[],
  trackPath: readonly string[],
  time: OtioRationalTime,
  weight: number,
  transition: OtioNode | null,
  video: OtioVideoContribution[],
  audio: OtioAudioContribution[],
  diagnostics: OtioDiagnostic[]
): OtioVideoComposition | null {
  if (isStack(node.schema) || isTimeline(node.schema)) {
    const children: OtioVideoComposition[] = [];
    for (const childId of node.children_ids) {
      const child = ownNode(document.nodes, childId);
      if (!child) continue;
      const childTrackPath = isTrack(child.schema)
        ? [...trackPath, child.id]
        : trackPath;
      const composed = composeChild(
        document,
        child,
        [...ancestry, child.id],
        childTrackPath,
        time,
        weight,
        transition,
        video,
        audio,
        diagnostics
      );
      if (!composed) continue;
      if (isTrack(child.schema) && child.track_kind === 'Audio') continue;
      children.push(composed);
    }
    if (isTimeline(node.schema) && children.length === 1) {
      return children[0] ?? null;
    }
    if (children.length === 0 && !isTimeline(node.schema)) return null;
    return {
      kind: 'stack',
      node_id: node.id,
      ancestry,
      children,
    };
  }

  if (isTrack(node.schema)) {
    if (node.track_kind === 'Audio') {
      emitTrackItems(
        document,
        node,
        ancestry,
        trackPath,
        time,
        weight,
        video,
        audio,
        diagnostics,
        'audio'
      );
      return null;
    }
    const active = transitionAt(document, node, time);
    if (active) {
      const outgoing = neighborItem(document, node, active.transition.id, -1);
      const incoming = neighborItem(document, node, active.transition.id, 1);
      const outWeight = 1 - active.progress;
      const inWeight = active.progress;
      diagnostics.push(...unknownEffectDiagnostics(active.transition));
      return {
        kind: 'track',
        node_id: node.id,
        ancestry,
        transition_id: active.transition.id,
        branches: [
          {
            weight: outWeight,
            child: outgoing
              ? composeChild(
                  document,
                  outgoing,
                  [...ancestry, outgoing.id],
                  trackPath,
                  time,
                  weight * outWeight,
                  active.transition,
                  video,
                  audio,
                  diagnostics
                )
              : null,
          },
          {
            weight: inWeight,
            child: incoming
              ? composeChild(
                  document,
                  incoming,
                  [...ancestry, incoming.id],
                  trackPath,
                  time,
                  weight * inWeight,
                  active.transition,
                  video,
                  audio,
                  diagnostics
                )
              : null,
          },
        ],
      };
    }
    const item = itemAt(document, node, time, false);
    if (!item) return null;
    return {
      kind: 'track',
      node_id: node.id,
      ancestry,
      branches: [
        {
          weight: 1,
          child: composeChild(
            document,
            item,
            [...ancestry, item.id],
            trackPath,
            time,
            weight,
            null,
            video,
            audio,
            diagnostics
          ),
        },
      ],
    };
  }

  if (isGap(node.schema) || !node.enabled) return null;
  if (!isClip(node.schema) && !isStack(node.schema)) return null;
  if (isClip(node.schema)) {
    const contribution = buildVideoContribution(
      document,
      node,
      ancestry,
      trackPath,
      time,
      weight,
      transition,
      diagnostics
    );
    if (!contribution) return null;
    const index = video.length;
    video.push(contribution);
    return { kind: 'leaf', contribution_index: index };
  }
  return null;
}

function itemAt(
  document: OtioDocumentV1,
  track: OtioNode,
  time: OtioRationalTime,
  includeHandles: boolean
): OtioNode | null {
  for (const childId of track.children_ids) {
    const child = ownNode(document.nodes, childId);
    if (!child || isTransition(child.schema)) continue;
    const range = includeHandles
      ? child.visible_timeline_range
      : child.timeline_range;
    if (range && rangeContainsTime(range, time)) return child;
  }
  return null;
}

function emitTrackItems(
  document: OtioDocumentV1,
  track: OtioNode,
  ancestry: readonly string[],
  trackPath: readonly string[],
  time: OtioRationalTime,
  weight: number,
  video: OtioVideoContribution[],
  audio: OtioAudioContribution[],
  diagnostics: OtioDiagnostic[],
  kind: 'audio'
): void {
  const active = transitionAt(document, track, time);
  const candidates: { node: OtioNode; weight: number; transition: OtioNode | null }[] =
    [];
  if (active) {
    const outgoing = neighborItem(document, track, active.transition.id, -1);
    const incoming = neighborItem(document, track, active.transition.id, 1);
    if (outgoing) {
      candidates.push({
        node: outgoing,
        weight: weight * (1 - active.progress),
        transition: active.transition,
      });
    }
    if (incoming) {
      candidates.push({
        node: incoming,
        weight: weight * active.progress,
        transition: active.transition,
      });
    }
  } else {
    const item = itemAt(document, track, time, false);
    if (item) candidates.push({ node: item, weight, transition: null });
  }
  for (const candidate of candidates) {
    if (!candidate.node.enabled || isGap(candidate.node.schema)) continue;
    if (isStack(candidate.node.schema) || isTrack(candidate.node.schema)) {
      composeChild(
        document,
        candidate.node,
        [...ancestry, candidate.node.id],
        trackPath,
        time,
        candidate.weight,
        candidate.transition,
        video,
        audio,
        diagnostics
      );
      continue;
    }
    const built = buildAudioContribution(
      document,
      candidate.node,
      [...ancestry, candidate.node.id],
      track,
      time,
      candidate.weight,
      candidate.transition,
      diagnostics
    );
    if (built) audio.push(built);
  }
  void kind;
}

function buildVideoContribution(
  document: OtioDocumentV1,
  node: OtioNode,
  ancestry: readonly string[],
  trackPath: readonly string[],
  time: OtioRationalTime,
  weight: number,
  transition: OtioNode | null,
  diagnostics: OtioDiagnostic[]
): OtioVideoContribution | null {
  if (!node.enabled) return null;
  const visible = node.visible_timeline_range;
  if (!visible || !rangeContainsTime(visible, time)) return null;
  const map = boundMaps.get(node);
  const media = map ? sampleOtioMedia(map, time) : { value: 0, rate: time.rate };
  const relative = map ? fileRelative(map, media) : null;
  const ref = activeReference(node);
  const localDiagnostics = [
    ...unknownEffectDiagnostics(node),
    ...(map ? [missingHandleDiagnostic(node, media, node.available_range)].filter(
      (item): item is OtioDiagnostic => item !== null
    ) : []),
  ];
  if (!relative && map && !map.available_start && !isSequence(ref)) {
    localDiagnostics.push({
      severity: 'info',
      code: 'invalid-timing',
      message: `Available range for ${node.name || node.id} is unknown; source_time is the media sample`,
      target: { node_id: node.id },
    });
  }
  let bundlePath = ref?.target_url ?? null;
  let sourceFrame: number | undefined;
  let sampleKind: 'media' | 'black' = 'media';
  if (ref && isSequence(ref)) {
    const chosen = chooseSequenceFrame(document, node, ref, media);
    bundlePath = chosen.path;
    sourceFrame = chosen.frame;
    sampleKind = chosen.kind;
    localDiagnostics.push(...chosen.diagnostics);
  }
  diagnostics.push(...localDiagnostics);
  const trackId = trackPath[trackPath.length - 1] ?? node.parent_id ?? node.id;
  return {
    track_id: trackId,
    track_index: trackPath.length > 0 ? trackPath.length - 1 : 0,
    node_id: node.id,
    name: node.name,
    media_key: node.active_media_reference_key ?? null,
    bundle_path: sampleKind === 'black' ? null : bundlePath,
    source_time: relative ?? media,
    source_frame: sourceFrame,
    alpha: 1,
    transition_weight: weight,
    transition_type: transition?.transition_type,
    active_effects: (node.effects ?? []).filter((effect) => effect.enabled),
    diagnostics: localDiagnostics,
    ancestry,
    sample_kind: sampleKind,
  };
}

function buildAudioContribution(
  document: OtioDocumentV1,
  node: OtioNode,
  ancestry: readonly string[],
  track: OtioNode,
  time: OtioRationalTime,
  weight: number,
  transition: OtioNode | null,
  diagnostics: OtioDiagnostic[]
): OtioAudioContribution | null {
  if (!node.enabled || !isClip(node.schema)) return null;
  const visible = node.visible_timeline_range ?? node.timeline_range;
  if (!visible || !rangeContainsTime(visible, time)) return null;
  const map = boundMaps.get(node);
  const media = map ? sampleOtioMedia(map, time) : { value: 0, rate: time.rate };
  const relative = map ? fileRelative(map, media) : null;
  const ref = activeReference(node);
  const localDiagnostics = unknownEffectDiagnostics(node);
  const handle = map
    ? missingHandleDiagnostic(node, media, node.available_range)
    : null;
  if (handle) localDiagnostics.push(handle);
  diagnostics.push(...localDiagnostics);
  return {
    track_id: track.id,
    track_index: 0,
    node_id: node.id,
    name: node.name,
    media_key: node.active_media_reference_key ?? null,
    bundle_path: ref?.target_url ?? null,
    source_time: relative ?? media,
    volume: 1,
    transition_weight: weight,
    transition_type: transition?.transition_type,
    active_effects: (node.effects ?? []).filter((effect) => effect.enabled),
    diagnostics: localDiagnostics,
    ancestry,
    sample_kind: 'media',
  };
}

function isSequence(ref: OtioMediaReference | null): ref is OtioMediaReference {
  return ref?.schema === 'ImageSequenceReference.1';
}

export function evaluateOtioAt(
  document: OtioDocumentV1,
  timelineId: string,
  time: OtioRationalTime
): OtioEvaluationResult {
  const video: OtioVideoContribution[] = [];
  const audio: OtioAudioContribution[] = [];
  const diagnostics: OtioDiagnostic[] = [];
  const timeline = ownNode(document.nodes, timelineId);
  if (!timeline || !document.timeline_ids.includes(timelineId)) {
    return {
      timeline_id: timelineId,
      timeline_time: time,
      video_contributions: [],
      audio_contributions: [],
      active_markers: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'unplaced-item',
          message: `Timeline ${timelineId} is not in this document`,
        },
      ],
      video_composition: null,
    };
  }
  const composition = composeChild(
    document,
    timeline,
    [timeline.id],
    [],
    time,
    1,
    null,
    video,
    audio,
    diagnostics
  );
  const markers = markersForOtioTimeline(document, timelineId).filter((marker) =>
    rangeContainsTime(marker.timeline_range, time)
  );
  return {
    timeline_id: timelineId,
    timeline_time: time,
    video_contributions: video,
    audio_contributions: audio,
    active_markers: markers,
    diagnostics,
    video_composition: composition,
  };
}

function withinTimeline(
  document: OtioDocumentV1,
  timelineId: string,
  nodeId: string
): boolean {
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === timelineId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = ownNode(document.nodes, cursor)?.parent_id ?? null;
  }
  return false;
}

export function markersForOtioTimeline(
  document: OtioDocumentV1,
  timelineId: string
): readonly OtioTimelineMarker[] {
  const timeline = ownNode(document.nodes, timelineId);
  if (!timeline) return [];
  const found: OtioTimelineMarker[] = [];
  const visit = (node: OtioNode): void => {
    if (!withinTimeline(document, timelineId, node.id) && node.id !== timelineId) {
      return;
    }
    const map = boundMaps.get(node);
    const exposed = node.visible_timeline_range ?? node.timeline_range;
    if (map && exposed) {
      for (const marker of node.markers ?? []) {
        if (!marker.marked_range) continue;
        const start = editorialTime(map, marker.marked_range.start_time);
        const end = editorialTime(
          map,
          addRationalTimes(
            marker.marked_range.start_time,
            marker.marked_range.duration
          )
        );
        const projected: OtioTimeRange = {
          start_time: start,
          duration: subtractRationalTimes(end, start),
        };
        const clipped = intersectRanges(projected, exposed);
        if (!clipped) continue;
        found.push({
          marker,
          owner_node_id: node.id,
          timeline_range: clipped,
        });
      }
    }
    for (const childId of node.children_ids) {
      const child = ownNode(document.nodes, childId);
      if (child) visit(child);
    }
  };
  visit(timeline);
  return found;
}

function ancestryOf(
  document: OtioDocumentV1,
  timelineId: string,
  nodeId: string
): string[] {
  const chain: string[] = [];
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor) {
    chain.push(cursor);
    if (cursor === timelineId || seen.has(cursor)) break;
    seen.add(cursor);
    cursor = ownNode(document.nodes, cursor)?.parent_id ?? null;
  }
  return chain.reverse();
}

function trackPathOf(document: OtioDocumentV1, ancestry: readonly string[]): string[] {
  return ancestry.filter((id) => {
    const node = ownNode(document.nodes, id);
    return node ? isTrack(node.schema) : false;
  });
}

function spanFor(
  document: OtioDocumentV1,
  timelineId: string,
  node: OtioNode,
  query: OtioTimeRange
): OtioSourceSpan | null {
  const visible = isTransition(node.schema)
    ? node.timeline_range
    : node.visible_timeline_range ?? node.timeline_range;
  if (!visible) return null;
  const overlap = intersectRanges(visible, query);
  if (!overlap) return null;
  const ancestry = ancestryOf(document, timelineId, node.id);
  const trackPath = trackPathOf(document, ancestry);
  const trackId = trackPath[trackPath.length - 1] ?? node.id;
  const map = boundMaps.get(node);
  let sourceRange: OtioTimeRange | null = null;
  let fileRange: OtioTimeRange | null = null;
  let mapping: OtioSourceMapping | null = null;
  const diagnostics = [...(node.diagnostics ?? [])];
  if (map && !isTransition(node.schema) && !isGap(node.schema)) {
    const startMedia = sampleOtioMedia(map, overlap.start_time);
    const endMedia = sampleOtioMedia(map, rangeEndTime(overlap));
    sourceRange = directedExtent(startMedia, endMedia, map.scalar);
    const startFile = fileRelative(map, startMedia);
    const endFile = fileRelative(map, endMedia);
    if (startFile && endFile) {
      fileRange = directedExtent(startFile, endFile, map.scalar);
      mapping = {
        timeline_origin: overlap.start_time,
        source_origin: startFile,
        scalar: map.scalar,
      };
    }
    const handle = missingHandleDiagnostic(
      node,
      startMedia,
      node.available_range
    );
    const handleEnd = missingHandleDiagnostic(node, endMedia, node.available_range);
    if (handle) diagnostics.push(handle);
    else if (handleEnd) diagnostics.push(handleEnd);
  }
  const ref = activeReference(node);
  return {
    timeline_id: timelineId,
    track_id: trackId,
    track_path: trackPath,
    node_id: node.id,
    schema: node.schema,
    name: node.name,
    enabled: node.enabled,
    timeline_range: visible,
    intersected_timeline_range: overlap,
    source_range: sourceRange,
    available_range: node.available_range ?? null,
    file_relative_source_range: fileRange,
    source_mapping: mapping,
    media_key: node.active_media_reference_key ?? null,
    bundle_path: ref?.target_url ?? ref?.target_url_base ?? null,
    active_media_reference_key: node.active_media_reference_key ?? null,
    media_references: node.media_references ?? Object.create(null),
    effects: node.effects ?? [],
    markers: node.markers ?? [],
    diagnostics,
    ancestry,
  };
}

function directedExtent(
  start: OtioRationalTime,
  end: OtioRationalTime,
  scalar: number
): OtioTimeRange {
  if (scalar < 0 && compareRationalTimes(start, end) > 0) {
    return {
      start_time: end,
      duration: subtractRationalTimes(start, end),
    };
  }
  if (compareRationalTimes(end, start) < 0) {
    return {
      start_time: end,
      duration: subtractRationalTimes(start, end),
    };
  }
  return {
    start_time: start,
    duration: subtractRationalTimes(end, start),
  };
}

export function sourceSpansForOtioRange(
  document: OtioDocumentV1,
  timelineId: string,
  trackId: string | null,
  range: OtioTimeRange
): OtioSourceSpan[] {
  const timeline = ownNode(document.nodes, timelineId);
  if (!timeline || !document.timeline_ids.includes(timelineId)) return [];
  const root =
    trackId === null ? timeline : ownNode(document.nodes, trackId);
  if (!root || !withinTimeline(document, timelineId, root.id)) return [];
  const spans: OtioSourceSpan[] = [];
  const visit = (node: OtioNode): void => {
    if (
      isClip(node.schema) ||
      isGap(node.schema) ||
      isTransition(node.schema)
    ) {
      const span = spanFor(document, timelineId, node, range);
      if (span) spans.push(span);
    }
    for (const childId of node.children_ids) {
      const child = ownNode(document.nodes, childId);
      if (child) visit(child);
    }
  };
  visit(root);
  return spans;
}

export function effectScalarOf(node: OtioNode): number {
  return effectScalar(node);
}

