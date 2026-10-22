/**
 * OpenTimelineIO playback for the Relik viewer.
 *
 * The shared evaluator owns placement, sequence paths, and sampling. This
 * controller owns decoders, the composition tree, the transport clock, and
 * resource teardown. It does not dispose an injected media resolver.
 */

import type {
  OtioAudioContribution,
  OtioBundleEntryName,
  OtioDiagnostic,
  OtioDocumentV1,
  OtioEffect,
  OtioEvaluationResult,
  OtioNode,
  OtioRationalTime,
  OtioVideoContribution,
} from '@relic/format';
import {
  addRationalTimes,
  compareRationalTimes,
  evaluateOtioAt,
  rescaleTime,
  timeToSeconds,
} from '@relic/format';
import { inferMediaMimeType, type OtioMediaResolver } from './otio-media.ts';
import {
  type OtioVideoTiming,
  readOtioVideoTiming,
} from './otio-video-timing.ts';

export const OTIO_MAX_IMAGE_EDGE = 4096;
export const OTIO_MAX_IMAGE_PIXELS = 4096 * 4096;
export const OTIO_RETAINED_IMAGE_PIXELS = 32 * 1024 * 1024;
const HAVE_CURRENT_DATA = 2;
const OTIO_RETAINED_VIDEO_TIMING_BYTES = 16 * 1024 * 1024;

const DECODER_LOCAL_ZERO_SOURCE_VALUE_TOLERANCE = 1e-7;
export interface OtioTrackState {
  readonly id: string;
  readonly name: string;
  readonly kind: 'Video' | 'Audio';
  readonly visible: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
}

export interface OtioPlaybackState {
  readonly time: OtioRationalTime;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly duration: OtioRationalTime;
  readonly rate: number;
  readonly diagnostics: readonly OtioDiagnostic[];
  readonly tracks: Readonly<Record<string, OtioTrackState>>;
  readonly baseMediaPreviewAllowed: boolean;
  readonly previewBlocked: boolean;
}

export type OtioPlaybackListener = (state: OtioPlaybackState) => void;

export interface CreateOtioPlaybackOptions {
  readonly document: OtioDocumentV1;
  readonly timelineId: string;
  readonly canvas: HTMLCanvasElement;
  readonly resolveMedia:
    | OtioMediaResolver
    | ((
        entryName: OtioBundleEntryName
      ) => Promise<string | Blob | null> | string | Blob | null);
  readonly audioContext?: AudioContext;
  readonly readVideoTiming?: typeof readOtioVideoTiming;
}

export interface OtioPlaybackController {
  getState(): OtioPlaybackState;
  play(): Promise<void>;
  pause(): void;
  seek(time: OtioRationalTime): Promise<void>;
  subscribe(listener: OtioPlaybackListener): () => void;
  setTrackVisibility(trackId: string, visible: boolean): void;
  setTrackMute(trackId: string, muted: boolean): void;
  setTrackSolo(trackId: string, solo: boolean): void;
  setBaseMediaPreviewAllowed(allowed: boolean): void;
  dispose(): void;
}

export type OtioVideoCompositionTree =
  | {
      readonly kind: 'stack';
      readonly node_id: string;
      readonly ancestry: readonly string[];
      readonly children: readonly OtioVideoCompositionTree[];
    }
  | {
      readonly kind: 'track';
      readonly node_id: string;
      readonly ancestry: readonly string[];
      readonly transition_id?: string;
      readonly branches: readonly {
        readonly weight: number;
        readonly child: OtioVideoCompositionTree | null;
      }[];
    }
  | {
      readonly kind: 'leaf';
      readonly contribution_index: number;
    };

export type OtioPreparedLeaf =
  | {
      readonly kind: 'image';
      readonly source: CanvasImageSource;
      readonly alpha: number;
    }
  | { readonly kind: 'black' }
  | { readonly kind: 'empty' };

type FidelityKind = 'ok' | 'freeze' | 'effect' | 'rate';

interface Fidelity {
  readonly kind: FidelityKind;
  readonly rate: number;
  readonly diagnostic: OtioDiagnostic | null;
}

interface LoadedVideo {
  readonly element: HTMLVideoElement;
  readonly key: string;
  readonly path: string;
}

interface LoadedAudio {
  readonly element: HTMLAudioElement;
  readonly key: string;
  readonly path: string;
  readonly trackId: string;
  sourceNode?: MediaElementAudioSourceNode;
  gainNode?: GainNode;
  failed: boolean;
}

interface LoadedImage {
  readonly element: HTMLImageElement;
  readonly path: string;
  readonly pixels: number;
}

interface ClockAnchor {
  readonly wallMs: number;
  readonly time: OtioRationalTime;
}

export function decodedImageAllowed(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (width > OTIO_MAX_IMAGE_EDGE || height > OTIO_MAX_IMAGE_EDGE) return false;
  if (width * height > OTIO_MAX_IMAGE_PIXELS) return false;
  return true;
}

export class ImageFrameCache {
  private readonly entries = new Map<
    string,
    { pixels: number; release: () => void }
  >();
  private readonly pinned = new Set<string>();
  private pixels = 0;

  constructor(private readonly budget: number) {}

  get size(): number {
    return this.entries.size;
  }

  get retainedPixels(): number {
    return this.pixels;
  }

  clearPins(): void {
    this.pinned.clear();
  }

  pin(key: string): void {
    this.pinned.add(key);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  put(key: string, pixels: number, release: () => void): boolean {
    if (!Number.isFinite(pixels) || pixels <= 0 || pixels > this.budget) {
      release();
      return false;
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.pixels -= existing.pixels;
      existing.release();
      this.entries.delete(key);
    }
    this.entries.set(key, { pixels, release });
    this.pixels += pixels;
    this.pinned.add(key);
    this.evict();
    return this.entries.has(key);
  }

  evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.pixels <= this.budget) break;
      if (this.pinned.has(key)) continue;
      this.pixels -= entry.pixels;
      entry.release();
      this.entries.delete(key);
    }
  }

  releaseAll(): void {
    for (const entry of this.entries.values()) entry.release();
    this.entries.clear();
    this.pinned.clear();
    this.pixels = 0;
  }
}

export function renderOtioVideoTree(
  output: CanvasRenderingContext2D,
  width: number,
  height: number,
  tree: OtioVideoCompositionTree | null,
  leaves: readonly (OtioPreparedLeaf | null)[],
  checkout: () => HTMLCanvasElement,
  hidden?: (nodeId: string, ancestry: readonly string[]) => boolean
): void {
  output.globalCompositeOperation = 'source-over';
  output.globalAlpha = 1;
  output.fillStyle = '#000000';
  output.fillRect(0, 0, width, height);
  if (!tree) return;
  const root = paintNode(tree, width, height, leaves, checkout, hidden);
  if (!root) return;
  output.globalCompositeOperation = 'source-over';
  output.globalAlpha = 1;
  output.drawImage(root, 0, 0, width, height);
}

function paintNode(
  node: OtioVideoCompositionTree,
  width: number,
  height: number,
  leaves: readonly (OtioPreparedLeaf | null)[],
  checkout: () => HTMLCanvasElement,
  hidden?: (nodeId: string, ancestry: readonly string[]) => boolean
): HTMLCanvasElement | null {
  if (node.kind !== 'leaf' && hidden?.(node.node_id, node.ancestry)) {
    return null;
  }
  if (node.kind === 'leaf') {
    const leaf = leaves[node.contribution_index] ?? null;
    if (!leaf || leaf.kind === 'empty') return null;
    const surface = checkout();
    const ctx = surface.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    if (leaf.kind === 'black') {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.globalAlpha = clamp01(leaf.alpha);
      ctx.drawImage(leaf.source, 0, 0, width, height);
    }
    ctx.globalAlpha = 1;
    return surface;
  }

  const surface = checkout();
  const ctx = surface.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  if (node.kind === 'stack') {
    ctx.globalCompositeOperation = 'source-over';
    for (const child of node.children) {
      const painted = paintNode(child, width, height, leaves, checkout, hidden);
      if (!painted) continue;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(painted, 0, 0, width, height);
    }
    return surface;
  }

  for (const branch of node.branches) {
    if (!branch.child || !(branch.weight > 0)) continue;
    const painted = paintNode(
      branch.child,
      width,
      height,
      leaves,
      checkout,
      hidden
    );
    if (!painted) continue;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(branch.weight);
    ctx.drawImage(painted, 0, 0, width, height);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return surface;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function schemaBase(schema: string): string {
  return schema.split('.')[0] ?? schema;
}

function isFreeze(effect: OtioEffect): boolean {
  return (
    schemaBase(effect.schema) === 'FreezeFrame' ||
    effect.effect_name === 'FreezeFrame'
  );
}

function isLinear(effect: OtioEffect): boolean {
  return (
    schemaBase(effect.schema) === 'LinearTimeWarp' ||
    effect.effect_name === 'LinearTimeWarp'
  );
}

function isDissolve(type: string | undefined): boolean {
  return type === 'SMPTE_Dissolve';
}

function effectFidelity(
  effects: readonly OtioEffect[],
  nodeId: string
): Fidelity {
  let rate = 1;
  let freeze = false;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    if (isFreeze(effect)) {
      freeze = true;
      continue;
    }
    if (isLinear(effect)) {
      const scalar = effect.time_scalar;
      if (scalar === undefined || !Number.isFinite(scalar) || scalar < 0) {
        return {
          kind: 'rate',
          rate: 1,
          diagnostic: diagnostic(
            'error',
            'unsupported-browser',
            `Reverse playback is not supported by this decoder` +
              ` (time_scalar ${String(scalar)})`,
            nodeId
          ),
        };
      }
      if (scalar === 0) {
        freeze = true;
        continue;
      }
      rate *= scalar;
      continue;
    }
    return {
      kind: 'effect',
      rate: 1,
      diagnostic: diagnostic(
        'warning',
        'unsupported-effect',
        `Unsupported effect: ${effect.name || effect.effect_name || effect.schema}`,
        nodeId
      ),
    };
  }
  if (freeze || rate === 0) {
    return { kind: 'freeze', rate: 0, diagnostic: null };
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      kind: 'rate',
      rate: 1,
      diagnostic: diagnostic(
        'error',
        'unsupported-browser',
        'Reverse playback is not supported by this decoder',
        nodeId
      ),
    };
  }
  return { kind: 'ok', rate, diagnostic: null };
}

function diagnostic(
  severity: OtioDiagnostic['severity'],
  code: OtioDiagnostic['code'],
  message: string,
  nodeId?: string
): OtioDiagnostic {
  return nodeId === undefined
    ? { severity, code, message }
    : { severity, code, message, target: { node_id: nodeId } };
}

function videoTree(
  result: OtioEvaluationResult
): OtioVideoCompositionTree | null {
  const extra = result as OtioEvaluationResult & {
    video_composition?: OtioVideoCompositionTree | null;
  };
  return extra.video_composition ?? null;
}

function sampleKind(contrib: OtioVideoContribution): 'media' | 'black' {
  const kind = (contrib as OtioVideoContribution & { sample_kind?: string })
    .sample_kind;
  return kind === 'black' ? 'black' : 'media';
}

// Decoder-only compatibility for legacy start-edge samples, in source-value
// units after both values are expressed on the same source clock.

function compareDecoderSourceTimes(
  sourceTime: OtioRationalTime,
  candidate: OtioRationalTime
): number {
  const candidateAtSourceRate =
    candidate.rate === sourceTime.rate
      ? candidate
      : rescaleTime(candidate, sourceTime.rate);
  const difference = sourceTime.value - candidateAtSourceRate.value;
  if (!Number.isFinite(difference)) return NaN;
  if (Math.abs(difference) < DECODER_LOCAL_ZERO_SOURCE_VALUE_TOLERANCE) {
    return 0;
  }
  return difference < 0 ? -1 : 1;
}

function acceptsDecoderLocalZero(sourceTime: OtioRationalTime): boolean {
  if (sourceTime.value >= 0) return false;
  return (
    compareDecoderSourceTimes(sourceTime, {
      value: 0,
      rate: sourceTime.rate,
    }) === 0
  );
}

function decoderLocalSourceTime(
  sourceTime: OtioRationalTime
): OtioRationalTime {
  if (sourceTime.value === 0) {
    return Object.is(sourceTime.value, -0)
      ? { value: 0, rate: sourceTime.rate }
      : sourceTime;
  }
  return acceptsDecoderLocalZero(sourceTime)
    ? { value: 0, rate: sourceTime.rate }
    : sourceTime;
}

function sampleUnavailable(
  contrib: OtioVideoContribution | OtioAudioContribution
): boolean {
  const acceptedLocalZero = acceptsDecoderLocalZero(contrib.source_time);
  const localSourceTime = decoderLocalSourceTime(contrib.source_time);
  return (
    localSourceTime.value < 0 ||
    (!acceptedLocalZero &&
      contrib.diagnostics.some(
        (diagnostic) => diagnostic.code === 'missing-handles'
      ))
  );
}

function decoderLocalSeconds(sourceTime: OtioRationalTime): number {
  return timeToSeconds(decoderLocalSourceTime(sourceTime));
}

function containerTimeAtSourceRate(
  seconds: number,
  sourceTime: OtioRationalTime
): OtioRationalTime {
  return { value: seconds * sourceTime.rate, rate: sourceTime.rate };
}

function videoDecoderTime(
  sourceTime: OtioRationalTime,
  timing: OtioVideoTiming | null
): number | null {
  if (
    timing === null ||
    timing.kind !== 'windows' ||
    timing.starts.length === 0 ||
    timing.starts.length !== timing.ends.length
  ) {
    return null;
  }
  const localTime = decoderLocalSourceTime(sourceTime);
  let lower = 0;
  let upper = timing.starts.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const start = timing.starts[middle];
    if (
      start !== undefined &&
      compareDecoderSourceTimes(
        localTime,
        containerTimeAtSourceRate(start, localTime)
      ) >= 0
    ) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const index = lower - 1;
  if (index < 0) return null;
  const start = timing.starts[index];
  const end = timing.ends[index];
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    compareDecoderSourceTimes(
      localTime,
      containerTimeAtSourceRate(end, localTime)
    ) >= 0
  ) {
    return null;
  }
  return start + (end - start) / 2;
}

function ancestryOf(contrib: {
  readonly ancestry?: readonly string[];
}): readonly string[] {
  return contrib.ancestry ?? [];
}

function occurrenceKey(
  nodeId: string,
  ancestry: readonly string[],
  dup: number
): string {
  return `${ancestry.join('\u0001')}\u0001${nodeId}\u0001${dup}`;
}

function readTimelineClock(
  doc: OtioDocumentV1,
  timelineId: string
): { duration: OtioRationalTime; rate: number; known: boolean } {
  const range = doc.nodes[timelineId]?.timeline_range;
  if (
    range &&
    Number.isFinite(range.duration.value) &&
    range.duration.value >= 0 &&
    Number.isFinite(range.duration.rate) &&
    range.duration.rate > 0
  ) {
    return {
      duration: range.duration,
      rate: range.duration.rate,
      known: true,
    };
  }
  const display = doc.global_start_times?.[timelineId];
  if (display && Number.isFinite(display.rate) && display.rate > 0) {
    return {
      duration: { value: 0, rate: display.rate },
      rate: display.rate,
      known: false,
    };
  }
  return { duration: { value: 0, rate: 1 }, rate: 1, known: false };
}

function collectTracks(
  doc: OtioDocumentV1,
  timelineId: string
): Record<string, OtioTrackState> {
  const tracks: Record<string, OtioTrackState> = {};
  const root = doc.nodes[timelineId];
  if (!root) return tracks;
  const visit = (node: OtioNode): void => {
    if (schemaBase(node.schema) === 'Track') {
      const kind = node.track_kind === 'Audio' ? 'Audio' : 'Video';
      tracks[node.id] = {
        id: node.id,
        name: node.name || (kind === 'Audio' ? 'Audio Track' : 'Video Track'),
        kind,
        visible: node.enabled !== false,
        muted: false,
        solo: false,
      };
    }
    for (const childId of node.children_ids) {
      const child = doc.nodes[childId];
      if (child) visit(child);
    }
  };
  visit(root);
  return tracks;
}

function isElement(value: unknown): value is HTMLElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HTMLElement).setAttribute === 'function' &&
    typeof (value as HTMLElement).appendChild === 'function'
  );
}

function isAssignableUrl(url: string): boolean {
  return url.startsWith('blob:');
}

export function createOtioPlayback(
  options: CreateOtioPlaybackOptions
): OtioPlaybackController {
  const readVideoTiming = options.readVideoTiming ?? readOtioVideoTiming;
  const videoTimingAbort = new AbortController();
  const { document: doc, timelineId, canvas, resolveMedia } = options;
  const clock = readTimelineClock(doc, timelineId);
  const tracks: Record<string, OtioTrackState> = collectTracks(doc, timelineId);

  let currentTime: OtioRationalTime = { value: 0, rate: clock.rate };
  let isPlaying = false;
  let isBuffering = false;
  let isDisposed = false;
  let baseMediaPreviewAllowed = false;
  let renderGeneration = 0;
  let renderInFlight = false;
  let frameHandle: number | null = null;
  let clockAnchor: ClockAnchor | null = null;
  let renderTail: Promise<void> = Promise.resolve();

  const listeners = new Set<OtioPlaybackListener>();
  const mediaFailures = new Map<string, OtioDiagnostic>();
  const urlPromises = new Map<OtioBundleEntryName, Promise<string | null>>();
  const callbackMediaPromises = new Map<
    OtioBundleEntryName,
    Promise<string | Blob | null>
  >();
  const blobPromises = new Map<OtioBundleEntryName, Promise<Blob | null>>();
  const videoTimingPromises = new Map<
    OtioBundleEntryName,
    Promise<OtioVideoTiming | null>
  >();
  const videoTimingFailures = new Map<string, OtioDiagnostic>();
  let retainedVideoTimingBytes = 0;
  const ownedUrls = new Set<string>();
  const videoPromises = new Map<string, Promise<LoadedVideo | null>>();
  const audioPromises = new Map<string, Promise<LoadedAudio | null>>();
  const imagePromises = new Map<string, Promise<LoadedImage | null>>();
  const videos = new Map<string, LoadedVideo>();
  const audios = new Map<string, LoadedAudio>();
  const decodedAt = new WeakMap<HTMLMediaElement, number>();
  const images = new ImageFrameCache(OTIO_RETAINED_IMAGE_PIXELS);
  const imageElements = new Map<string, LoadedImage>();
  const surfacePool: HTMLCanvasElement[] = [];
  let surfaceCursor = 0;

  let audioContext: AudioContext | null = options.audioContext ?? null;
  let masterGain: GainNode | null = null;
  const trackGains = new Map<string, GainNode>();
  let audioGraph: HTMLElement | null = null;
  let videoHost: HTMLElement | null = null;

  function stale(gen: number): boolean {
    return isDisposed || gen !== renderGeneration;
  }

  function outputSize(): { width: number; height: number } {
    return {
      width: canvas.width || 1920,
      height: canvas.height || 1080,
    };
  }

  function notify(): void {
    if (isDisposed) return;
    const state = getState();
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A subscriber error must not stop the transport.
      }
    }
  }

  function ensureHost(className: string): HTMLElement | null {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const el = document.createElement('div');
    if (!isElement(el)) return null;
    el.className = className;
    el.setAttribute('aria-hidden', 'true');
    el.style.position = 'absolute';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.overflow = 'hidden';
    el.style.clipPath = 'inset(50%)';
    el.style.pointerEvents = 'none';
    const parent = canvas.parentElement ?? document.body ?? null;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(el);
    }
    return el;
  }

  function audioHost(): HTMLElement | null {
    if (audioGraph) return audioGraph;
    audioGraph = ensureHost('otio-audio-graph');
    return audioGraph;
  }

  function decoderHost(): HTMLElement | null {
    if (videoHost) return videoHost;
    videoHost = ensureHost('otio-video-decoders');
    return videoHost;
  }

  function getAudioContext(): AudioContext | null {
    if (isDisposed) return null;
    if (!audioContext && typeof AudioContext !== 'undefined') {
      try {
        audioContext = new AudioContext();
      } catch {
        audioContext = null;
      }
    }
    if (audioContext && !masterGain) {
      try {
        masterGain = audioContext.createGain();
        masterGain.connect(audioContext.destination);
      } catch {
        masterGain = null;
      }
    }
    return masterGain ? audioContext : null;
  }

  function trackGain(trackId: string): GainNode | null {
    const ctx = getAudioContext();
    if (!ctx || !masterGain) return null;
    let node = trackGains.get(trackId);
    if (!node) {
      try {
        node = ctx.createGain();
        node.connect(masterGain);
        trackGains.set(trackId, node);
      } catch {
        return null;
      }
    }
    return node;
  }

  function anySolo(kind: 'Video' | 'Audio'): boolean {
    return Object.values(tracks).some(
      (track) => track.kind === kind && track.solo
    );
  }

  function trackAudible(trackId: string): boolean {
    const track = tracks[trackId];
    if (!track || track.kind !== 'Audio') return true;
    if (track.muted) return false;
    if (anySolo('Audio') && !track.solo) return false;
    return true;
  }

  function videoHidden(nodeId: string, ancestry: readonly string[]): boolean {
    const solo = anySolo('Video');
    for (const id of [nodeId, ...ancestry]) {
      const track = tracks[id];
      if (!track || track.kind !== 'Video') continue;
      if (!track.visible) return true;
      if (solo && !track.solo) return true;
    }
    return false;
  }

  function unknownTransition(transitionId: string | undefined): boolean {
    if (!transitionId) return false;
    const node = doc.nodes[transitionId];
    if (!node || node.enabled === false) return false;
    return !isDissolve(node.transition_type);
  }

  function blockedTracks(tree: OtioVideoCompositionTree | null): Set<string> {
    const blocked = new Set<string>();
    if (!tree || baseMediaPreviewAllowed) return blocked;
    const visit = (node: OtioVideoCompositionTree): void => {
      if (node.kind === 'leaf') return;
      if (node.kind === 'track') {
        if (unknownTransition(node.transition_id)) blocked.add(node.node_id);
        for (const branch of node.branches) {
          if (branch.child) visit(branch.child);
        }
        return;
      }
      for (const child of node.children) visit(child);
    };
    visit(tree);
    return blocked;
  }

  function transitionIssue(
    type: string | undefined,
    nodeId: string
  ): OtioDiagnostic | null {
    if (!type || isDissolve(type)) return null;
    return diagnostic(
      'warning',
      'unsupported-effect',
      `Unsupported transition: ${type}`,
      nodeId
    );
  }

  function contributionIssues(result: OtioEvaluationResult): OtioDiagnostic[] {
    const issues: OtioDiagnostic[] = [];
    const seen = new Set<string>();
    const push = (issue: OtioDiagnostic | null): void => {
      if (!issue) return;
      const key = `${issue.code}:${issue.target?.node_id ?? ''}:${issue.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push(issue);
    };
    for (const contrib of result.video_contributions) {
      push(effectFidelity(contrib.active_effects, contrib.node_id).diagnostic);
      push(transitionIssue(contrib.transition_type, contrib.node_id));
    }
    for (const contrib of result.audio_contributions) {
      push(effectFidelity(contrib.active_effects, contrib.node_id).diagnostic);
      push(transitionIssue(contrib.transition_type, contrib.node_id));
    }
    const tree = videoTree(result);
    if (tree) {
      const visit = (node: OtioVideoCompositionTree): void => {
        if (node.kind === 'track') {
          if (unknownTransition(node.transition_id)) {
            push(
              diagnostic(
                'warning',
                'unsupported-effect',
                `Unsupported transition: ${
                  doc.nodes[node.transition_id ?? '']?.transition_type ??
                  'unknown'
                }`,
                node.node_id
              )
            );
          }
          for (const branch of node.branches) {
            if (branch.child) visit(branch.child);
          }
        } else if (node.kind === 'stack') {
          for (const child of node.children) visit(child);
        }
      };
      visit(tree);
    }
    return issues;
  }

  function previewBlocked(result?: OtioEvaluationResult): boolean {
    if (baseMediaPreviewAllowed) return false;
    const evaluation = result ?? evaluateOtioAt(doc, timelineId, currentTime);
    return contributionIssues(evaluation).length > 0;
  }

  function revokeOwned(url: string): void {
    ownedUrls.delete(url);
    if (
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore revoke errors.
      }
    }
  }

  // A callback Blob must keep one identity for URL creation and timing reads.
  function callbackMedia(
    path: OtioBundleEntryName
  ): Promise<string | Blob | null> {
    const existing = callbackMediaPromises.get(path);
    if (existing) return existing;
    const pending = (async () => {
      if (typeof resolveMedia !== 'function') return null;
      return resolveMedia(path);
    })();
    callbackMediaPromises.set(path, pending);
    return pending;
  }

  async function resolveOne(path: OtioBundleEntryName): Promise<string | null> {
    if (isDisposed) return null;
    if (
      typeof resolveMedia === 'object' &&
      resolveMedia !== null &&
      'resolveUrl' in resolveMedia
    ) {
      const url = await resolveMedia.resolveUrl(path);
      if (isDisposed || !url || !isAssignableUrl(url)) return null;
      return url;
    }
    const resolved = await callbackMedia(path);
    if (isDisposed || resolved == null) return null;
    if (typeof resolved === 'string') {
      return isAssignableUrl(resolved) ? resolved : null;
    }
    if (
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return null;
    }
    const url = URL.createObjectURL(resolved);
    if (isDisposed) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore revoke errors.
      }
      return null;
    }
    ownedUrls.add(url);
    return url;
  }

  async function resolveBlob(path: OtioBundleEntryName): Promise<Blob | null> {
    if (isDisposed) return null;
    if (
      typeof resolveMedia === 'object' &&
      resolveMedia !== null &&
      'resolveBlob' in resolveMedia
    ) {
      const blob = await resolveMedia.resolveBlob(path);
      return isDisposed ? null : blob;
    }
    // URL-only callbacks stay decoder-only; timing never fetches a URL.
    const resolved = await callbackMedia(path);
    return !isDisposed && resolved instanceof Blob ? resolved : null;
  }

  function sharedUrl(path: OtioBundleEntryName): Promise<string | null> {
    const existing = urlPromises.get(path);
    if (existing) return existing;
    const pending = resolveOne(path);
    urlPromises.set(path, pending);
    return pending;
  }

  function sharedBlob(path: OtioBundleEntryName): Promise<Blob | null> {
    const existing = blobPromises.get(path);
    if (existing) return existing;
    const pending = resolveBlob(path);
    blobPromises.set(path, pending);
    return pending;
  }

  function reserveVideoTiming(timing: OtioVideoTiming): OtioVideoTiming {
    if (timing.kind !== 'windows') return timing;
    const bytes = timing.starts.byteLength + timing.ends.byteLength;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > OTIO_RETAINED_VIDEO_TIMING_BYTES - retainedVideoTimingBytes
    ) {
      return { kind: 'unknown', reason: 'index-budget' };
    }
    retainedVideoTimingBytes += bytes;
    return timing;
  }

  function sharedVideoTiming(
    path: OtioBundleEntryName,
    mimeType: string
  ): Promise<OtioVideoTiming | null> {
    const existing = videoTimingPromises.get(path);
    if (existing) return existing;
    const pending = (async () => {
      const blob = await sharedBlob(path);
      if (blob === null || isDisposed || videoTimingAbort.signal.aborted) {
        return null;
      }
      try {
        const timing = await readVideoTiming(
          blob,
          mimeType,
          videoTimingAbort.signal
        );
        if (isDisposed || videoTimingAbort.signal.aborted) {
          return { kind: 'unknown', reason: 'cancelled' } as const;
        }
        return reserveVideoTiming(timing);
      } catch (error) {
        if (isDisposed || videoTimingAbort.signal.aborted) {
          return { kind: 'unknown', reason: 'cancelled' } as const;
        }
        throw error;
      }
    })();
    videoTimingPromises.set(path, pending);
    return pending;
  }

  function rememberFailure(path: string, issue: OtioDiagnostic): void {
    mediaFailures.set(path, issue);
  }

  function seekElement(
    media: HTMLMediaElement,
    target: number,
    gen: number
  ): Promise<boolean> {
    if (stale(gen)) return Promise.resolve(false);
    if (
      decodedAt.get(media) === target &&
      media.readyState >= HAVE_CURRENT_DATA
    ) {
      return Promise.resolve(true);
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('loadeddata', onReady);
      media.removeEventListener('error', onError);
      if (ok && !stale(gen) && media.readyState >= HAVE_CURRENT_DATA) {
        decodedAt.set(media, target);
        resolve(true);
        return;
      }
      resolve(false);
    };
    const onSeeked = (): void => {
      if (media.readyState >= HAVE_CURRENT_DATA) finish(true);
    };
    const onReady = (): void => {
      if (
        media.readyState >= HAVE_CURRENT_DATA &&
        media.currentTime === target
      ) {
        finish(true);
      }
    };
    const onError = (): void => finish(false);
    media.addEventListener('seeked', onSeeked);
    media.addEventListener('loadeddata', onReady);
    media.addEventListener('error', onError);
    try {
      media.currentTime = target;
    } catch {
      finish(false);
      return promise;
    }
    if (media.readyState >= HAVE_CURRENT_DATA && media.currentTime === target) {
      finish(true);
    }
    return promise;
  }

  function acquireVideo(
    key: string,
    path: OtioBundleEntryName,
    gen: number
  ): Promise<LoadedVideo | null> {
    const existing = videoPromises.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const url = await sharedUrl(path);
      if (!url || isDisposed) return null;
      if (typeof document === 'undefined' || !document.createElement)
        return null;
      const element = document.createElement('video');
      if (isDisposed) return null;
      element.preload = 'auto';
      element.playsInline = true;
      element.muted = true;
      element.volume = 0;
      element.src = url;
      const entry: LoadedVideo = { element, key, path };
      videos.set(key, entry);
      const host = decoderHost();
      if (host) host.appendChild(element);
      if (isDisposed) {
        releaseVideo(entry);
        return null;
      }
      if (element.readyState < HAVE_CURRENT_DATA) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const done = (): void => {
          element.removeEventListener('loadeddata', done);
          element.removeEventListener('error', done);
          resolve();
        };
        element.addEventListener('loadeddata', done);
        element.addEventListener('error', done);
        await promise;
      }
      if (isDisposed) {
        releaseVideo(entry);
        return null;
      }
      if (element.error) {
        rememberFailure(
          path,
          diagnostic(
            'error',
            'unsupported-codec',
            `Undecodable video: ${path}`,
            key
          )
        );
        return null;
      }
      mediaFailures.delete(path);
      return entry;
    })();
    videoPromises.set(key, pending);
    return pending;
  }

  function acquireAudio(
    key: string,
    path: OtioBundleEntryName,
    trackId: string,
    gen: number
  ): Promise<LoadedAudio | null> {
    const existing = audioPromises.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const url = await sharedUrl(path);
      if (!url || isDisposed) return null;
      const element =
        typeof document !== 'undefined' && document.createElement
          ? document.createElement('audio')
          : typeof Audio !== 'undefined'
            ? new Audio()
            : null;
      if (!element || isDisposed) return null;
      element.preload = 'auto';
      element.src = url;
      const entry: LoadedAudio = {
        element,
        key,
        path,
        trackId,
        failed: false,
      };
      audios.set(key, entry);
      element.setAttribute('data-track-id', trackId);
      element.setAttribute('data-bundle-path', path);
      element.setAttribute('data-active', 'false');
      const host = audioHost();
      if (host) host.appendChild(element);
      const ctx = getAudioContext();
      const destination = trackGain(trackId);
      if (ctx && destination) {
        try {
          const source = ctx.createMediaElementSource(element);
          const clip = ctx.createGain();
          source.connect(clip);
          clip.connect(destination);
          entry.sourceNode = source;
          entry.gainNode = clip;
        } catch {
          // Keep the element-volume fallback when the media graph is unavailable.
        }
      }
      element.addEventListener('error', () => {
        entry.failed = true;
        rememberFailure(
          path,
          diagnostic(
            'error',
            'unsupported-codec',
            `Undecodable audio: ${path}`,
            key
          )
        );
        notify();
      });
      if (isDisposed) {
        releaseAudio(entry);
        return null;
      }
      return entry;
    })();
    audioPromises.set(key, pending);
    return pending;
  }

  function acquireImage(
    path: OtioBundleEntryName,
    gen: number
  ): Promise<LoadedImage | null> {
    const existing = imagePromises.get(path);
    if (existing) return existing;
    const pending = (async () => {
      const url = await sharedUrl(path);
      if (!url || isDisposed || typeof Image === 'undefined') return null;
      const element = new Image();
      element.src = url;
      if (!element.complete || element.naturalWidth === 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const done = (): void => {
          element.onload = null;
          element.onerror = null;
          resolve();
        };
        element.onload = done;
        element.onerror = done;
        await promise;
      }
      if (isDisposed) {
        element.src = '';
        return null;
      }
      const width = element.naturalWidth;
      const height = element.naturalHeight;
      if (!decodedImageAllowed(width, height)) {
        element.src = '';
        rememberFailure(
          path,
          diagnostic(
            'error',
            'unsupported-codec',
            `Decoded image exceeds the pixel budget: ${path}`,
            path
          )
        );
        return null;
      }
      if (width <= 0 || height <= 0) {
        rememberFailure(
          path,
          diagnostic('error', 'missing-media', `Missing image: ${path}`, path)
        );
        return null;
      }
      const loaded: LoadedImage = {
        element,
        path,
        pixels: width * height,
      };
      const kept = images.put(path, loaded.pixels, () => {
        loaded.element.src = '';
        imageElements.delete(path);
      });
      if (!kept) return null;
      imageElements.set(path, loaded);
      mediaFailures.delete(path);
      return loaded;
    })();
    imagePromises.set(path, pending);
    return pending;
  }

  function releaseVideo(entry: LoadedVideo): void {
    try {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.element.load();
    } catch {
      // Ignore decoder reset errors.
    }
    entry.element.remove();
    videos.delete(entry.key);
  }

  function releaseAudio(entry: LoadedAudio): void {
    try {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.element.load();
      entry.gainNode?.disconnect();
      entry.sourceNode?.disconnect();
    } catch {
      // Ignore audio reset errors.
    }
    entry.element.remove();
    audios.delete(entry.key);
  }

  function pauseAllMedia(): void {
    for (const video of videos.values()) video.element.pause();
    for (const audio of audios.values()) {
      audio.element.pause();
      audio.element.setAttribute('data-active', 'false');
      if (audio.gainNode) audio.gainNode.gain.value = 0;
      else audio.element.volume = 0;
    }
  }

  function applyAudioGain(
    entry: LoadedAudio,
    gain: number,
    audible: boolean
  ): void {
    const trackScale = audible ? 1 : 0;
    const node = trackGain(entry.trackId);
    if (node) node.gain.value = trackScale;
    if (entry.gainNode) {
      entry.gainNode.gain.value = gain;
      entry.element.volume = 1;
      return;
    }
    entry.element.volume = Math.min(1, Math.max(0, gain * trackScale));
  }

  function applyRate(element: HTMLMediaElement, rate: number): boolean {
    if (!Number.isFinite(rate) || rate <= 0) return false;
    try {
      element.playbackRate = rate;
    } catch {
      return false;
    }
    return element.playbackRate === rate;
  }

  async function prepareLeaves(
    result: OtioEvaluationResult,
    tree: OtioVideoCompositionTree | null,
    gen: number
  ): Promise<(OtioPreparedLeaf | null)[]> {
    const leaves: (OtioPreparedLeaf | null)[] = result.video_contributions.map(
      () => null
    );
    if (!tree) return leaves;
    const seen = new Map<string, number>();
    const visit = async (node: OtioVideoCompositionTree): Promise<void> => {
      if (stale(gen)) return;
      if (node.kind === 'leaf') {
        const contrib = result.video_contributions[node.contribution_index];
        if (!contrib) return;
        leaves[node.contribution_index] = await prepareLeaf(contrib, seen, gen);
        return;
      }
      if (node.kind === 'stack') {
        for (const child of node.children) await visit(child);
        return;
      }
      for (const branch of node.branches) {
        if (branch.child) await visit(branch.child);
      }
    };
    await visit(tree);
    return leaves;
  }

  async function prepareLeaf(
    contrib: OtioVideoContribution,
    seen: Map<string, number>,
    gen: number
  ): Promise<OtioPreparedLeaf> {
    if (sampleKind(contrib) === 'black') return { kind: 'black' };
    const fidelity = effectFidelity(contrib.active_effects, contrib.node_id);
    const withheld =
      !baseMediaPreviewAllowed &&
      (fidelity.kind === 'effect' || fidelity.kind === 'rate');
    if (withheld) return { kind: 'empty' };
    if (!contrib.bundle_path) {
      mediaFailures.set(
        contrib.node_id,
        diagnostic(
          'error',
          'missing-media',
          `Missing video: ${contrib.name}`,
          contrib.node_id
        )
      );
      return { kind: 'empty' };
    }
    const mime = inferMediaMimeType(contrib.bundle_path);
    if (mime === 'image/x-exr' || mime === 'image/x-dpx') {
      rememberFailure(
        contrib.bundle_path,
        diagnostic(
          'error',
          'unsupported-codec',
          `Unsupported image decoder: ${contrib.bundle_path}`,
          contrib.node_id
        )
      );
      return { kind: 'empty' };
    }
    if (mime.startsWith('image/')) {
      const image = await acquireImage(contrib.bundle_path, gen);
      if (stale(gen) || !image) return { kind: 'empty' };
      images.pin(contrib.bundle_path);
      return {
        kind: 'image',
        source: image.element,
        alpha: contrib.alpha,
      };
    }
    if (!mime.startsWith('video/')) {
      rememberFailure(
        contrib.bundle_path,
        diagnostic(
          'error',
          'unsupported-codec',
          `Unsupported codec for ${contrib.bundle_path}`,
          contrib.node_id
        )
      );
      return { kind: 'empty' };
    }
    if (sampleUnavailable(contrib)) return { kind: 'empty' };
    const dupKey = `${ancestryOf(contrib).join('/')}|${contrib.node_id}`;
    const dup = seen.get(dupKey) ?? 0;
    seen.set(dupKey, dup + 1);
    const key = occurrenceKey(contrib.node_id, ancestryOf(contrib), dup);
    const video = await acquireVideo(key, contrib.bundle_path, gen);
    if (stale(gen) || !video) return { kind: 'empty' };
    const timing = await sharedVideoTiming(contrib.bundle_path, mime);
    if (stale(gen)) return { kind: 'empty' };
    const midpoint = videoDecoderTime(contrib.source_time, timing);
    const target = midpoint ?? decoderLocalSeconds(contrib.source_time);
    if (midpoint === null) {
      const message =
        timing === null
          ? `Video packet timing is unavailable: ${contrib.bundle_path}`
          : timing.kind === 'unknown'
            ? `Video packet timing is ${timing.reason}: ${contrib.bundle_path}`
            : `Video source sample is outside certified packet timing: ${contrib.bundle_path}`;
      videoTimingFailures.set(
        key,
        diagnostic('error', 'invalid-timing', message, contrib.node_id)
      );
    } else {
      videoTimingFailures.delete(key);
    }
    const ready = await seekElement(video.element, target, gen);
    if (stale(gen)) return { kind: 'empty' };
    if (!ready) {
      rememberFailure(
        contrib.bundle_path,
        diagnostic(
          'error',
          'missing-media',
          `Missing or unplayable video: ${contrib.bundle_path}`,
          contrib.node_id
        )
      );
      return { kind: 'empty' };
    }
    return {
      kind: 'image',
      source: video.element,
      alpha: contrib.alpha,
    };
  }

  async function reconcileAudio(
    result: OtioEvaluationResult,
    gen: number
  ): Promise<void> {
    const active = new Set<string>();
    const seen = new Map<string, number>();
    for (const contrib of result.audio_contributions) {
      if (stale(gen)) return;
      const fidelity = effectFidelity(contrib.active_effects, contrib.node_id);
      const withheld =
        !baseMediaPreviewAllowed &&
        (fidelity.kind === 'effect' || fidelity.kind === 'rate');
      if (!contrib.bundle_path) {
        mediaFailures.set(
          contrib.node_id,
          diagnostic(
            'error',
            'missing-media',
            `Missing audio: ${contrib.name}`,
            contrib.node_id
          )
        );
        continue;
      }
      if (withheld || fidelity.kind === 'rate') {
        if (fidelity.diagnostic) {
          mediaFailures.set(contrib.node_id, fidelity.diagnostic);
        }
        continue;
      }
      if (sampleUnavailable(contrib)) continue;
      const dupKey = `${ancestryOf(contrib).join('/')}|${contrib.node_id}`;
      const dup = seen.get(dupKey) ?? 0;
      seen.set(dupKey, dup + 1);
      const key = occurrenceKey(contrib.node_id, ancestryOf(contrib), dup);
      active.add(key);
      const loaded = await acquireAudio(
        key,
        contrib.bundle_path,
        contrib.track_id,
        gen
      );
      if (stale(gen)) {
        loaded?.element.pause();
        return;
      }
      if (!loaded || loaded.failed) {
        if (!loaded) {
          rememberFailure(
            contrib.bundle_path,
            diagnostic(
              'error',
              'missing-media',
              `Missing audio: ${contrib.bundle_path}`,
              contrib.node_id
            )
          );
        }
        continue;
      }
      const audible = trackAudible(contrib.track_id);
      const gain = Math.max(0, contrib.volume * contrib.transition_weight);
      applyAudioGain(loaded, gain, audible);
      loaded.element.setAttribute('data-active', audible ? 'true' : 'false');
      const target = decoderLocalSeconds(contrib.source_time);
      if (fidelity.kind === 'freeze' || !audible || !isPlaying) {
        loaded.element.pause();
        if (decodedAt.get(loaded.element) !== target) {
          await seekElement(loaded.element, target, gen);
        }
        continue;
      }
      const rate = fidelity.kind === 'effect' ? 1 : fidelity.rate;
      if (!applyRate(loaded.element, rate)) {
        loaded.element.pause();
        applyAudioGain(loaded, 0, false);
        rememberFailure(
          contrib.bundle_path,
          diagnostic(
            'error',
            'unsupported-browser',
            `Decoder cannot apply playback rate ${rate}`,
            contrib.node_id
          )
        );
        continue;
      }
      const frame = 1 / Math.max(1, contrib.source_time.rate);
      if (Math.abs(loaded.element.currentTime - target) > frame) {
        await seekElement(loaded.element, target, gen);
        if (stale(gen)) {
          loaded.element.pause();
          return;
        }
      }
      if (loaded.element.paused) {
        try {
          await loaded.element.play();
        } catch (error) {
          rememberFailure(
            contrib.bundle_path,
            diagnostic(
              'error',
              'unsupported-browser',
              `Audio playback failed: ${
                error instanceof Error ? error.message : 'playback rejected'
              }`,
              contrib.node_id
            )
          );
          notify();
        }
      }
    }
    for (const [key, entry] of audios) {
      if (active.has(key)) continue;
      entry.element.pause();
      entry.element.setAttribute('data-active', 'false');
      if (entry.gainNode) entry.gainNode.gain.value = 0;
      else entry.element.volume = 0;
    }
  }

  function paint(
    tree: OtioVideoCompositionTree | null,
    leaves: readonly (OtioPreparedLeaf | null)[]
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = outputSize();
    surfaceCursor = 0;
    const blocked = blockedTracks(tree);
    renderOtioVideoTree(
      ctx,
      width,
      height,
      tree,
      leaves,
      () => {
        let surface = surfacePool[surfaceCursor];
        if (!surface && typeof document !== 'undefined') {
          surface = document.createElement('canvas');
          surfacePool.push(surface);
        }
        if (!surface) {
          throw new Error('Canvas surface unavailable');
        }
        surfaceCursor += 1;
        surface.width = width;
        surface.height = height;
        return surface;
      },
      (nodeId, ancestry) => videoHidden(nodeId, ancestry) || blocked.has(nodeId)
    );
  }

  async function renderAt(time: OtioRationalTime, gen: number): Promise<void> {
    if (stale(gen)) return;
    renderInFlight = true;
    try {
      const evaluation = evaluateOtioAt(doc, timelineId, time);
      if (stale(gen)) return;
      videoTimingFailures.clear();
      images.clearPins();
      const tree = videoTree(evaluation);
      if (tree === null && evaluation.video_contributions.length > 0) {
        mediaFailures.set(
          timelineId,
          diagnostic(
            'error',
            'invalid-timing',
            'Video evaluation has no composition tree',
            timelineId
          )
        );
      }
      const leaves = await prepareLeaves(evaluation, tree, gen);
      if (stale(gen)) return;
      try {
        paint(tree, leaves);
      } catch {
        // A missing surface must not paint a stale frame.
      }
      images.evict();
      await reconcileAudio(evaluation, gen);
      if (stale(gen)) return;
      isBuffering = false;
      notify();
    } finally {
      if (gen === renderGeneration) renderInFlight = false;
    }
  }

  function enqueueRender(time: OtioRationalTime, gen: number): Promise<void> {
    const run = (): Promise<void> => renderAt(time, gen);
    const done = renderTail.then(run, run);
    renderTail = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  }

  function scheduleTick(): void {
    if (!isPlaying || isDisposed || frameHandle !== null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    frameHandle = requestAnimationFrame(onTick);
  }

  function onTick(now: number): void {
    frameHandle = null;
    if (!isPlaying || isDisposed) return;
    if (renderInFlight || isBuffering) {
      clockAnchor = null;
      scheduleTick();
      return;
    }
    if (clockAnchor !== null && clock.rate > 0) {
      const elapsed = (now - clockAnchor.wallMs) / 1000;
      if (elapsed > 0) {
        const advanced = addRationalTimes(clockAnchor.time, {
          value: elapsed * clock.rate,
          rate: clock.rate,
        });
        if (compareRationalTimes(advanced, clock.duration) >= 0) {
          currentTime = clock.duration;
          isPlaying = false;
          clockAnchor = null;
          pauseAllMedia();
          void enqueueRender(currentTime, ++renderGeneration);
          notify();
          return;
        }
        currentTime = advanced;
      }
    }
    clockAnchor = { wallMs: now, time: currentTime };
    const gen = ++renderGeneration;
    void enqueueRender(currentTime, gen).finally(() => {
      if (isPlaying && !isDisposed && !isBuffering) scheduleTick();
    });
  }

  function getState(): OtioPlaybackState {
    const evaluation = evaluateOtioAt(doc, timelineId, currentTime);
    const issues = [
      ...videoTimingFailures.values(),
      ...evaluation.diagnostics,
      ...contributionIssues(evaluation),
      ...mediaFailures.values(),
    ];
    if (!clock.known) {
      issues.unshift(
        diagnostic(
          'error',
          'invalid-timing',
          'Timeline has no canonical timeline_range',
          timelineId
        )
      );
    }
    const seen = new Set<string>();
    const diagnostics: OtioDiagnostic[] = [];
    for (const issue of issues) {
      const key = `${issue.code}:${issue.target?.node_id ?? ''}:${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(issue);
    }
    return {
      time: currentTime,
      playing: isPlaying,
      buffering: isBuffering,
      duration: clock.duration,
      rate: clock.rate,
      diagnostics,
      tracks: { ...tracks },
      baseMediaPreviewAllowed,
      previewBlocked:
        !baseMediaPreviewAllowed && contributionIssues(evaluation).length > 0,
    };
  }

  function clampTime(time: OtioRationalTime): OtioRationalTime {
    if (!Number.isFinite(time.value) || time.value < 0) {
      return { value: 0, rate: clock.rate };
    }
    if (compareRationalTimes(time, clock.duration) > 0) return clock.duration;
    return rescaleTime(time, clock.rate);
  }

  return {
    getState,

    async play(): Promise<void> {
      if (isDisposed || isPlaying) return;
      if (previewBlocked()) {
        notify();
        return;
      }
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          // Ignore resume failure; fallback volume still applies.
        }
      }
      if (isDisposed) return;
      isPlaying = true;
      clockAnchor = null;
      notify();
      scheduleTick();
    },

    pause(): void {
      if (isDisposed || !isPlaying) return;
      isPlaying = false;
      clockAnchor = null;
      if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      pauseAllMedia();
      notify();
    },

    async seek(time: OtioRationalTime): Promise<void> {
      if (isDisposed) return;
      const gen = ++renderGeneration;
      currentTime = clampTime(time);
      clockAnchor = null;
      isBuffering = true;
      notify();
      await enqueueRender(currentTime, gen);
      if (stale(gen)) return;
      isBuffering = false;
      clockAnchor = null;
      notify();
      if (isPlaying) scheduleTick();
    },

    subscribe(listener: OtioPlaybackListener): () => void {
      listeners.add(listener);
      listener(getState());
      return () => {
        listeners.delete(listener);
      };
    },

    setTrackVisibility(trackId: string, visible: boolean): void {
      if (isDisposed) return;
      const track = tracks[trackId];
      if (!track) return;
      tracks[trackId] = { ...track, visible };
      notify();
      void enqueueRender(currentTime, ++renderGeneration);
    },

    setTrackMute(trackId: string, muted: boolean): void {
      if (isDisposed) return;
      const track = tracks[trackId];
      if (!track) return;
      tracks[trackId] = { ...track, muted };
      for (const entry of audios.values()) {
        if (entry.trackId !== trackId) continue;
        applyAudioGain(
          entry,
          entry.gainNode?.gain.value ?? entry.element.volume,
          trackAudible(trackId)
        );
        if (!trackAudible(trackId)) {
          entry.element.pause();
          entry.element.setAttribute('data-active', 'false');
        }
      }
      notify();
    },

    setTrackSolo(trackId: string, solo: boolean): void {
      if (isDisposed) return;
      const track = tracks[trackId];
      if (!track) return;
      tracks[trackId] = { ...track, solo };
      notify();
      void enqueueRender(currentTime, ++renderGeneration);
    },

    setBaseMediaPreviewAllowed(allowed: boolean): void {
      if (isDisposed) return;
      baseMediaPreviewAllowed = allowed;
      notify();
      void enqueueRender(currentTime, ++renderGeneration);
    },

    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;
      videoTimingAbort.abort();
      isPlaying = false;
      renderGeneration += 1;
      renderInFlight = false;
      clockAnchor = null;
      if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      for (const entry of videos.values()) releaseVideo(entry);
      for (const entry of audios.values()) releaseAudio(entry);
      images.releaseAll();
      for (const image of imageElements.values()) image.element.src = '';
      imageElements.clear();
      videoPromises.clear();
      audioPromises.clear();
      imagePromises.clear();
      urlPromises.clear();
      callbackMediaPromises.clear();
      blobPromises.clear();
      videoTimingPromises.clear();
      videoTimingFailures.clear();
      retainedVideoTimingBytes = 0;
      for (const url of ownedUrls) revokeOwned(url);
      ownedUrls.clear();
      audioGraph?.remove();
      videoHost?.remove();
      audioGraph = null;
      videoHost = null;
      if (audioContext && !options.audioContext) {
        try {
          void audioContext.close();
        } catch {
          // Ignore context close errors.
        }
      }
      audioContext = null;
      masterGain = null;
      trackGains.clear();
      listeners.clear();
      const ctx = canvas.getContext('2d');
      if (ctx) {
        try {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } catch {
          // Ignore canvas clear errors.
        }
      }
    },
  };
}
