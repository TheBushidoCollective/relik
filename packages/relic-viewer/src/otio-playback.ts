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
  otioSamplingMap,
  rangeContainsTime,
  rescaleTime,
} from '@relic/format';
import { inferMediaMimeType, type OtioMediaResolver } from './otio-media.ts';
import {
  type OtioVideoTiming,
  readOtioVideoTiming,
} from './otio-video-timing.ts';
import {
  acceptsDecoderLocalZero,
  certifiedWindowIndex,
  checkNativeTimingEligibility,
  computePhaseAnchor,
  containerTimeAtSourceRate,
  decoderLocalSeconds,
  decoderLocalSourceTime,
  maxWindowDuration,
  minWindowDuration,
  NativeDecoderRing,
  OTIO_PACKET_START_TOLERANCE_SECONDS,
  OTIO_RETAINED_SNAPSHOT_PIXELS,
  presentedWindowOutcome,
  SNAPSHOT_SLOTS_PER_DECODER,
  SnapshotPixelBudget,
  videoDecoderTime,
  VsyncTracker,
  type DecoderPhaseSample,
  type HTMLVideoElementWithRvfc,
  type NativeSnapshotSlot,
  type PhaseAnchorResult,
  type PresentedWindowOutcome,
} from './otio-video-decoders.ts';

export {
  certifiedWindowIndex,
  checkNativeTimingEligibility,
  computePhaseAnchor,
  OTIO_PACKET_START_TOLERANCE_SECONDS,
  OTIO_RETAINED_SNAPSHOT_PIXELS,
  presentedWindowOutcome,
  SNAPSHOT_SLOTS_PER_DECODER,
  videoDecoderTime,
};
export type {
  DecoderPhaseSample,
  HTMLVideoElementWithRvfc,
  NativeSnapshotSlot,
  PhaseAnchorResult,
  PresentedWindowOutcome,
};
export const OTIO_MAX_IMAGE_EDGE = 4096;
export const OTIO_MAX_IMAGE_PIXELS = 4096 * 4096;
export const OTIO_RETAINED_IMAGE_PIXELS = 32 * 1024 * 1024;
const HAVE_CURRENT_DATA = 2;
const OTIO_RETAINED_VIDEO_TIMING_BYTES = 16 * 1024 * 1024;
export const OTIO_GRAPHICS_RESTORE_MS = 3000;

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
  readonly graphicsFailed: boolean;
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
  checkout: (depth: number) => HTMLCanvasElement,
  hidden?: (nodeId: string, ancestry: readonly string[]) => boolean
): void {
  output.globalCompositeOperation = 'source-over';
  output.globalAlpha = 1;
  output.fillStyle = '#000000';
  output.fillRect(0, 0, width, height);
  if (!tree) return;
  const root = paintNode(tree, 0, width, height, leaves, checkout, hidden);
  if (!root) return;
  output.globalCompositeOperation = 'source-over';
  output.globalAlpha = 1;
  output.drawImage(root, 0, 0, width, height);
}

function paintNode(
  node: OtioVideoCompositionTree,
  depth: number,
  width: number,
  height: number,
  leaves: readonly (OtioPreparedLeaf | null)[],
  checkout: (depth: number) => HTMLCanvasElement,
  hidden?: (nodeId: string, ancestry: readonly string[]) => boolean
): HTMLCanvasElement | null {
  if (node.kind !== 'leaf' && hidden?.(node.node_id, node.ancestry)) {
    return null;
  }
  if (node.kind === 'leaf') {
    const leaf = leaves[node.contribution_index] ?? null;
    if (!leaf || leaf.kind === 'empty') return null;
    const surface = checkout(depth);
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

  if (node.kind === 'stack') {
    let surface: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    for (const child of node.children) {
      const painted = paintNode(
        child,
        depth + 1,
        width,
        height,
        leaves,
        checkout,
        hidden
      );
      if (!painted) continue;
      if (!surface || !ctx) {
        surface = checkout(depth);
        ctx = surface.getContext('2d');
        if (!ctx) return null;
        ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(painted, 0, 0, width, height);
    }
    return surface;
  }

  let surface: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  for (const branch of node.branches) {
    if (!branch.child || !(branch.weight > 0)) continue;
    const painted = paintNode(
      branch.child,
      depth + 1,
      width,
      height,
      leaves,
      checkout,
      hidden
    );
    if (!painted) continue;
    if (!surface || !ctx) {
      surface = checkout(depth);
      ctx = surface.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(branch.weight);
    ctx.drawImage(painted, 0, 0, width, height);
  }
  if (ctx) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
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

function acceptsDecoderLocalZeroAtAvailableStart(
  document: OtioDocumentV1,
  contrib: OtioVideoContribution | OtioAudioContribution,
  acceptedLocalZero: boolean
): boolean {
  if (!acceptedLocalZero) return false;
  if (!Object.hasOwn(document.nodes, contrib.node_id)) return false;
  const node = document.nodes[contrib.node_id];
  const available = node?.available_range;
  if (
    !node ||
    !available ||
    !Number.isFinite(available.start_time.value) ||
    !Number.isFinite(available.start_time.rate) ||
    available.start_time.rate <= 0 ||
    !Number.isFinite(available.duration.value) ||
    available.duration.value <= 0 ||
    !Number.isFinite(available.duration.rate) ||
    available.duration.rate <= 0
  ) {
    return false;
  }
  const map = otioSamplingMap(node);
  if (
    !map?.available_start ||
    contrib.source_time.rate !== map.sample_origin.rate ||
    map.available_start.value !== available.start_time.value ||
    map.available_start.rate !== available.start_time.rate
  ) {
    return false;
  }
  return rangeContainsTime(available, map.available_start);
}

function sampleUnavailable(
  document: OtioDocumentV1,
  contrib: OtioVideoContribution | OtioAudioContribution
): boolean {
  const acceptedLocalZero = acceptsDecoderLocalZero(contrib.source_time);
  const acceptedAtAvailableStart = acceptsDecoderLocalZeroAtAvailableStart(
    document,
    contrib,
    acceptedLocalZero
  );
  if (acceptedLocalZero && !acceptedAtAvailableStart) return true;
  const localSourceTime = decoderLocalSourceTime(contrib.source_time);
  return (
    localSourceTime.value < 0 ||
    (!acceptedAtAvailableStart &&
      contrib.diagnostics.some(
        (diagnostic) => diagnostic.code === 'missing-handles'
      ))
  );
}

function collectDecoderPresentationHandleDiagnostics(
  document: OtioDocumentV1,
  contribution: OtioVideoContribution | OtioAudioContribution,
  suppressed: Set<OtioDiagnostic>,
  retained: Set<OtioDiagnostic>
): void {
  let qualifies: boolean | undefined;
  for (const issue of contribution.diagnostics) {
    if (issue.code !== 'missing-handles') continue;
    if (issue.target?.node_id !== contribution.node_id) {
      retained.add(issue);
      continue;
    }
    if (qualifies === undefined) {
      const acceptedLocalZero = acceptsDecoderLocalZero(
        contribution.source_time
      );
      qualifies = acceptsDecoderLocalZeroAtAvailableStart(
        document,
        contribution,
        acceptedLocalZero
      );
    }
    if (qualifies) suppressed.add(issue);
    else retained.add(issue);
  }
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

function collectVideoOccurrenceKeys(
  contributions: readonly OtioVideoContribution[]
): string[] {
  const seen = new Map<string, number>();
  return contributions.map((contrib) => {
    const dupKey = `${ancestryOf(contrib).join('/')}|${contrib.node_id}`;
    const dup = seen.get(dupKey) ?? 0;
    seen.set(dupKey, dup + 1);
    return occurrenceKey(contrib.node_id, ancestryOf(contrib), dup);
  });
}

function getDrawnLeafIndices(
  tree: OtioVideoCompositionTree | null,
  isHidden: (nodeId: string, ancestry: readonly string[]) => boolean
): number[] {
  const indices: number[] = [];
  if (!tree) return indices;
  const visit = (node: OtioVideoCompositionTree): void => {
    if (node.kind !== 'leaf' && isHidden(node.node_id, node.ancestry)) {
      return;
    }
    if (node.kind === 'leaf') {
      indices.push(node.contribution_index);
      return;
    }
    if (node.kind === 'stack') {
      for (const child of node.children) visit(child);
      return;
    }
    if (node.kind === 'track') {
      for (const branch of node.branches) {
        if (branch.child && branch.weight > 0) visit(branch.child);
      }
    }
  };
  visit(tree);
  return indices;
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
  let graphicsLost = false;
  let graphicsFailed = false;
  let restoreTimeout: ReturnType<typeof setTimeout> | undefined;
  let priorCanvasVisibility: string | null = null;
  let canvasHidden = false;
  let nativeMode = false;
  let failureSeekCadence = false;
  const nativeIneligiblePaths = new Set<string>();
  const nativeRings = new Map<string, NativeDecoderRing>();
  const snapshotBudget = new SnapshotPixelBudget(OTIO_RETAINED_SNAPSHOT_PIXELS);
  const vsyncTracker = new VsyncTracker();
  let nativeAnchor: { wallMs: number; time: OtioRationalTime } | null = null;
  let nativeEpoch = 0;
  let failureResyncTimestamps: number[] = [];
  let drawnSetChangeTimestamps: number[] = [];
  let lastDrawnOccurrenceKeys = new Set<string>();
  let lastRenderDrawnOccurrenceKeys = new Set<string>();
  const lastRenderVideoContributions = new Map<string, OtioVideoContribution>();
  let knownVideoKeys = new Set<string>();
  let isStarting = false;
  let startingStartTime = 0;
  const videoTimingCache = new Map<string, OtioVideoTiming>();
  const audioSeeking = new WeakSet<LoadedAudio>();

  function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  function drawnVideoKeys(
    evaluation: OtioEvaluationResult,
    tree: OtioVideoCompositionTree | null
  ): Set<string> {
    const keys = new Set<string>();
    if (!tree) return keys;
    const blocked = blockedTracks(tree);
    const isHidden = (nodeId: string, ancestry: readonly string[]) =>
      videoHidden(nodeId, ancestry) || blocked.has(nodeId);
    const drawnLeafIndices = getDrawnLeafIndices(tree, isHidden);
    const occurrenceKeys = collectVideoOccurrenceKeys(
      evaluation.video_contributions
    );
    for (const idx of drawnLeafIndices) {
      const contrib = evaluation.video_contributions[idx];
      if (!contrib || contrib.bundle_path === null) continue;
      const mime = inferMediaMimeType(contrib.bundle_path);
      if (!mime.startsWith('video/')) continue;
      const fidelity = effectFidelity(contrib.active_effects, contrib.node_id);
      if (fidelity.kind === 'freeze') continue;
      const key = occurrenceKeys[idx];
      if (key) {
        keys.add(key);
        lastRenderVideoContributions.set(key, contrib);
      }
    }
    return keys;
  }

  function getOrCreateNativeRing(
    key: string,
    element: HTMLVideoElement,
    bundlePath: string
  ): NativeDecoderRing {
    let ring = nativeRings.get(key);
    if (!ring) {
      ring = new NativeDecoderRing(element, key, bundlePath, snapshotBudget);
      nativeRings.set(key, ring);
    }
    return ring;
  }

  function hideVisibleCanvas(): void {
    if (canvasHidden) return;
    canvasHidden = true;
    priorCanvasVisibility = canvas.style?.visibility ?? '';
    if (canvas.style) {
      canvas.style.visibility = 'hidden';
    }
  }

  function restoreVisibleCanvas(): void {
    if (!canvasHidden) return;
    canvasHidden = false;
    if (canvas.style) {
      canvas.style.visibility = priorCanvasVisibility ?? '';
    }
    priorCanvasVisibility = null;
  }
  const pooledSurfaceListeners = new Map<
    HTMLCanvasElement,
    (e: Event) => void
  >();

  function isCanvasContextLost(target: HTMLCanvasElement): boolean {
    const anyTarget = target as HTMLCanvasElement & {
      isContextLost?: () => boolean;
    };
    if (
      typeof anyTarget.isContextLost === 'function' &&
      anyTarget.isContextLost()
    ) {
      return true;
    }
    if (typeof target.getContext !== 'function') return false;
    const ctx = target.getContext('2d');
    if (!ctx) return true;
    const anyCtx = ctx as CanvasRenderingContext2D & {
      isContextLost?: () => boolean;
    };
    if (typeof anyCtx.isContextLost === 'function') {
      return anyCtx.isContextLost();
    }
    return false;
  }

  function attachSurfaceListener(
    surface: HTMLCanvasElement,
    depth: number
  ): void {
    if (typeof surface.addEventListener === 'function') {
      const listener = (): void => {
        onPooledSurfaceContextLost(surface, depth);
      };
      pooledSurfaceListeners.set(surface, listener);
      surface.addEventListener('contextlost', listener);
    }
  }

  function removeSurfaceListener(surface: HTMLCanvasElement): void {
    const listener = pooledSurfaceListeners.get(surface);
    if (listener) {
      pooledSurfaceListeners.delete(surface);
      if (typeof surface.removeEventListener === 'function') {
        surface.removeEventListener('contextlost', listener);
      }
    }
  }

  function onPooledSurfaceContextLost(
    surface: HTMLCanvasElement,
    depth: number
  ): void {
    if (isDisposed) return;
    removeSurfaceListener(surface);
    surface.width = 0;
    surface.height = 0;
    if (surfacePool[depth] === surface) {
      surfacePool[depth] = undefined as unknown as HTMLCanvasElement;
    }
    if (!graphicsLost && !isCanvasContextLost(canvas)) {
      const gen = ++renderGeneration;
      void enqueueRender(currentTime, gen).finally(() => {
        if (isPlaying && !isDisposed && !isBuffering) scheduleTick();
      });
    }
  }

  function onVisibleContextLost(): void {
    if (isDisposed) return;
    hideVisibleCanvas();
    graphicsLost = true;
    isBuffering = true;
    for (const surface of surfacePool) {
      if (surface) {
        removeSurfaceListener(surface);
        surface.width = 0;
        surface.height = 0;
      }
    }
    surfacePool.length = 0;
    if (restoreTimeout === undefined) {
      restoreTimeout = setTimeout(() => {
        restoreTimeout = undefined;
        if (isDisposed) return;
        graphicsFailed = true;
        mediaFailures.set(
          'graphics-context-lost',
          diagnostic(
            'error',
            'unsupported-browser',
            'Preview graphics context was lost and the browser did not restore it. Reload the page to try again.'
          )
        );
        isBuffering = false;
        notify();
      }, OTIO_GRAPHICS_RESTORE_MS);
    }
    notify();
  }

  function onVisibleContextRestored(): void {
    if (isDisposed) return;
    graphicsLost = false;
    clockAnchor = null;
    nativeAnchor = null;
    isBuffering = true;
    notify();
    if (isPlaying) {
      void startSequence(currentTime, true);
    } else {
      const gen = ++renderGeneration;
      void enqueueRender(currentTime, gen).finally(() => {
        if (stale(gen)) return;
        clockAnchor = null;
        notify();
      });
    }
  }

  if (typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('contextlost', onVisibleContextLost);
    canvas.addEventListener('contextrestored', onVisibleContextRestored);
  }

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

  // Audio's decoder guard can suppress a contribution without a core timing
  // diagnostic. Report that state so the view does not call silent audio ready.
  // Video preserves its evaluator diagnostics and sequence-frame policy intent.
  // Kept out of contributionIssues, which blocks preview.
  function withheldAudioSampleIssues(
    result: OtioEvaluationResult
  ): OtioDiagnostic[] {
    const issues: OtioDiagnostic[] = [];
    for (const contrib of result.audio_contributions) {
      if (!sampleUnavailable(doc, contrib)) continue;
      const explained = contrib.diagnostics.some(
        (issue) =>
          issue.code === 'missing-handles' || issue.code === 'invalid-timing'
      );
      if (explained) continue;
      issues.push(
        diagnostic(
          'warning',
          'invalid-timing',
          `Source sample for ${contrib.name || contrib.node_id} is outside known media availability and was withheld`,
          contrib.node_id
        )
      );
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
        const reserved = reserveVideoTiming(timing);
        if (reserved) {
          videoTimingCache.set(path, reserved);
        }
        return reserved;
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
    _gen: number
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
    _gen: number
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
    _gen: number
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
    const ring = nativeRings.get(entry.key);
    if (ring) {
      ring.release();
      nativeRings.delete(entry.key);
    }
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
      const currentActive = audio.element.getAttribute('data-active');
      if (currentActive !== 'false') {
        audio.element.setAttribute('data-active', 'false');
      }
      if (audio.gainNode) {
        if (audio.gainNode.gain.value !== 0) audio.gainNode.gain.value = 0;
      } else {
        if (audio.element.volume !== 0) audio.element.volume = 0;
      }
    }
    for (const ring of nativeRings.values()) {
      ring.cancelCallback();
    }
  }

  function applyAudioGain(
    entry: LoadedAudio,
    gain: number,
    audible: boolean
  ): void {
    const trackScale = audible ? 1 : 0;
    const node = trackGain(entry.trackId);
    if (node && node.gain.value !== trackScale) {
      node.gain.value = trackScale;
    }
    if (entry.gainNode) {
      if (entry.gainNode.gain.value !== gain) {
        entry.gainNode.gain.value = gain;
      }
      if (entry.element.volume !== 1) {
        entry.element.volume = 1;
      }
      return;
    }
    const desired = Math.min(1, Math.max(0, gain * trackScale));
    if (entry.element.volume !== desired) {
      entry.element.volume = desired;
    }
  }

  function applyRate(element: HTMLMediaElement, rate: number): boolean {
    if (!Number.isFinite(rate) || rate <= 0) return false;
    if (element.playbackRate === rate) return true;
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
    const occurrenceKeys = collectVideoOccurrenceKeys(
      result.video_contributions
    );
    const visit = async (node: OtioVideoCompositionTree): Promise<void> => {
      if (stale(gen)) return;
      if (node.kind === 'leaf') {
        const contrib = result.video_contributions[node.contribution_index];
        if (!contrib) return;
        leaves[node.contribution_index] = await prepareLeaf(
          contrib,
          occurrenceKeys[node.contribution_index] ?? '',
          gen
        );
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
    key: string,
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
    if (sampleUnavailable(doc, contrib)) return { kind: 'empty' };
    // Key is precomputed by caller
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
      if (sampleUnavailable(doc, contrib)) continue;
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
      const currentActive = loaded.element.getAttribute('data-active');
      const nextActive = audible ? 'true' : 'false';
      if (currentActive !== nextActive) {
        loaded.element.setAttribute('data-active', nextActive);
      }
      const target = decoderLocalSeconds(contrib.source_time);
      if (
        fidelity.kind === 'freeze' ||
        !audible ||
        !isPlaying ||
        isStarting ||
        isBuffering
      ) {
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
      const tolerance = 2 / Math.max(1, clock.rate);
      const drift = Math.abs(loaded.element.currentTime - target);
      if (drift > tolerance && !audioSeeking.has(loaded)) {
        asyncSeekAudio(loaded, target, gain, audible);
      }
      if (loaded.element.paused && !audioSeeking.has(loaded)) {
        try {
          decodedAt.delete(loaded.element);
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
  ): boolean {
    if (graphicsLost || isCanvasContextLost(canvas)) {
      if (isCanvasContextLost(canvas)) {
        hideVisibleCanvas();
      }
      return false;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const { width, height } = outputSize();
    const blocked = blockedTracks(tree);
    renderOtioVideoTree(
      ctx,
      width,
      height,
      tree,
      leaves,
      (depth: number) => {
        let surface = surfacePool[depth];
        if (surface && isCanvasContextLost(surface)) {
          removeSurfaceListener(surface);
          surface.width = 0;
          surface.height = 0;
          surface = undefined as unknown as HTMLCanvasElement;
        }
        if (!surface && typeof document !== 'undefined') {
          surface = document.createElement('canvas');
          attachSurfaceListener(surface, depth);
          surfacePool[depth] = surface;
        }
        if (!surface) {
          throw new Error('Canvas surface unavailable');
        }
        surface.width = width;
        surface.height = height;
        return surface;
      },
      (nodeId, ancestry) => videoHidden(nodeId, ancestry) || blocked.has(nodeId)
    );
    if (graphicsLost || isCanvasContextLost(canvas)) {
      if (isCanvasContextLost(canvas)) {
        hideVisibleCanvas();
      }
      return false;
    }
    return true;
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
      lastRenderDrawnOccurrenceKeys = drawnVideoKeys(evaluation, tree);
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
      let presented = false;
      try {
        presented = paint(tree, leaves);
      } catch {
        // A missing surface must not paint a stale frame.
      }
      images.evict();
      await reconcileAudio(evaluation, gen);
      if (stale(gen)) return;
      if (presented && !graphicsLost && !isCanvasContextLost(canvas)) {
        restoreVisibleCanvas();
        clearTimeout(restoreTimeout);
        restoreTimeout = undefined;
        graphicsFailed = false;
        mediaFailures.delete('graphics-context-lost');
        isBuffering = false;
      }
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

  function asyncSeekAudio(
    audio: LoadedAudio,
    target: number,
    volume: number,
    audible: boolean
  ): void {
    if (audioSeeking.has(audio)) return;
    audioSeeking.add(audio);
    if (audio.gainNode) {
      audio.gainNode.gain.value = 0;
    } else {
      audio.element.volume = 0;
    }
    const onSeeked = (): void => {
      audio.element.removeEventListener('seeked', onSeeked);
      audioSeeking.delete(audio);
      applyAudioGain(audio, volume, audible);
    };
    audio.element.addEventListener('seeked', onSeeked);
    try {
      audio.element.currentTime = target;
    } catch {
      audio.element.removeEventListener('seeked', onSeeked);
      audioSeeking.delete(audio);
      applyAudioGain(audio, volume, audible);
    }
  }

  function fallbackToSeekCadence(): void {
    nativeEpoch++;
    pauseAllMedia();
    for (const ring of nativeRings.values()) {
      decodedAt.delete(ring.videoElement);
      ring.release();
    }
    nativeRings.clear();
    failureSeekCadence = true;
    nativeMode = false;
    isStarting = false;
    isBuffering = false;
    nativeAnchor = null;
    clockAnchor = null;
    notify();
    if (isPlaying) scheduleTick();
  }

  async function startSequence(
    T0: OtioRationalTime,
    buffering: boolean = false
  ): Promise<void> {
    const gen = ++renderGeneration;
    isStarting = !buffering;
    if (buffering) {
      isBuffering = true;
    }
    startingStartTime =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    nativeEpoch++;
    nativeAnchor = null;
    clockAnchor = null;
    pauseAllMedia();
    notify();
    // The new time is published by renderAt together with the exact paint, so
    // the clock never runs ahead of the canvas during the resync.
    currentTime = T0;

    await enqueueRender(T0, gen);
    if (stale(gen)) return;

    if (graphicsLost || isCanvasContextLost(canvas)) {
      isStarting = false;
      isBuffering = true;
      notify();
      return;
    }

    const evaluation = evaluateOtioAt(doc, timelineId, T0);
    const tree = videoTree(evaluation);
    const blocked = blockedTracks(tree);
    const isHidden = (nodeId: string, ancestry: readonly string[]) =>
      videoHidden(nodeId, ancestry) || blocked.has(nodeId);
    const drawnLeafIndices = getDrawnLeafIndices(tree, isHidden);

    let hasImageSequence = false;
    for (const idx of drawnLeafIndices) {
      const contrib = evaluation.video_contributions[idx];
      if (contrib) {
        const node = doc.nodes[contrib.node_id] as
          | (OtioNode & {
              readonly media_reference?: { readonly schema?: string };
            })
          | undefined;
        if (node?.media_reference?.schema === 'ImageSequenceReference.1') {
          hasImageSequence = true;
          break;
        }
      }
    }

    const occurrenceKeys = collectVideoOccurrenceKeys(
      evaluation.video_contributions
    );

    const drawnVideoLeaves: {
      contrib: OtioVideoContribution & { bundle_path: OtioBundleEntryName };
      video: LoadedVideo;
      timing: Extract<OtioVideoTiming, { kind: 'windows' }>;
      rL: number;
      wMinSeconds: number;
      key: string;
      iL0: number;
    }[] = [];

    let eligible = !failureSeekCadence && !hasImageSequence;

    if (eligible) {
      const drawnKeys = new Set<string>();
      for (const idx of drawnLeafIndices) {
        const k = occurrenceKeys[idx];
        if (k) drawnKeys.add(k);
      }
      for (const [key, ring] of nativeRings) {
        if (!drawnKeys.has(key)) {
          decodedAt.delete(ring.videoElement);
          ring.release();
          nativeRings.delete(key);
        }
      }
      const vsync = vsyncTracker.medianSeconds;
      for (const idx of drawnLeafIndices) {
        const contrib = evaluation.video_contributions[idx];
        if (!contrib || contrib.bundle_path === null) continue;
        const mime = inferMediaMimeType(contrib.bundle_path);
        if (!mime.startsWith('video/')) continue;
        const fidelity = effectFidelity(
          contrib.active_effects,
          contrib.node_id
        );
        if (fidelity.kind === 'freeze') continue;

        const key = occurrenceKeys[idx];
        if (!key) {
          eligible = false;
          break;
        }

        if (nativeIneligiblePaths.has(contrib.bundle_path)) {
          eligible = false;
          break;
        }
        const video = videos.get(key);
        if (!video) {
          eligible = false;
          break;
        }

        if (typeof VideoFrame !== 'function') {
          eligible = false;
          break;
        }
        const rvfcVideo = video.element as HTMLVideoElementWithRvfc;
        if (typeof rvfcVideo.requestVideoFrameCallback !== 'function') {
          eligible = false;
          break;
        }

        const rL = fidelity.kind === 'effect' ? 1 : fidelity.rate;
        if (!applyRate(video.element, rL)) {
          eligible = false;
          break;
        }

        const timing = await sharedVideoTiming(contrib.bundle_path, mime);
        if (stale(gen)) return;
        if (
          !timing ||
          timing.kind !== 'windows' ||
          !checkNativeTimingEligibility(timing, rL, vsync)
        ) {
          eligible = false;
          break;
        }

        const iL0 = certifiedWindowIndex(contrib.source_time, timing);
        if (iL0 === null) {
          eligible = false;
          break;
        }

        const wMin = minWindowDuration(timing, rL);
        const ring = getOrCreateNativeRing(
          key,
          video.element,
          contrib.bundle_path
        );
        const { width, height } = outputSize();
        if (!ring || !ring.allocate(width, height)) {
          eligible = false;
          break;
        }

        drawnVideoLeaves.push({
          contrib: contrib as OtioVideoContribution & {
            bundle_path: OtioBundleEntryName;
          },
          video,
          timing,
          rL,
          wMinSeconds: wMin,
          key,
          iL0,
        });
      }
    }

    if (!eligible || drawnVideoLeaves.length === 0) {
      for (const ring of nativeRings.values()) {
        decodedAt.delete(ring.videoElement);
        ring.release();
      }
      nativeRings.clear();
      nativeMode = false;
      isStarting = false;
      isBuffering = false;
      clockAnchor = null;
      lastDrawnOccurrenceKeys = drawnVideoKeys(evaluation, tree);
      if (isPlaying) {
        await reconcileAudio(evaluation, gen);
      }
      notify();
      if (isPlaying) scheduleTick();
      return;
    }

    nativeMode = true;
    lastDrawnOccurrenceKeys = new Set(drawnVideoLeaves.map((l) => l.key));

    let startSuccess = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (stale(gen)) return;
      if (attempt > 0) {
        nativeEpoch++;
        pauseAllMedia();
        await enqueueRender(T0, gen);
        if (stale(gen)) return;
      }
      let pausedCaptureOk = true;
      for (const leaf of drawnVideoLeaves) {
        const ring = nativeRings.get(leaf.key);
        if (ring) {
          ring.resetEpoch(nativeEpoch);
          const ok = ring.capturePausedFrame(
            leaf.iL0,
            nativeEpoch,
            leaf.timing
          );
          if (!ok) {
            pausedCaptureOk = false;
          }
        }
      }

      if (!pausedCaptureOk) {
        if (attempt === 0) continue;
        fallbackToSeekCadence();
        return;
      }

      const firstAdvancedPromises: Promise<{ now: number; tag: number }>[] = [];
      const playPromises: Promise<void>[] = [];

      for (const leaf of drawnVideoLeaves) {
        const ring = nativeRings.get(leaf.key);
        if (!ring) continue;
        ring.isStarting = true;
        ring.startupFirstAdvancedTag = leaf.iL0 + 1;
        const { promise, resolve, reject } = Promise.withResolvers<{
          now: number;
          tag: number;
        }>();
        ring.startupWaiter = { resolve, reject };
        firstAdvancedPromises.push(promise);
        applyRate(leaf.video.element, leaf.rL);
        decodedAt.delete(leaf.video.element);
        playPromises.push(leaf.video.element.play());
        ring.startCallbacks(leaf.timing, leaf.rL, () => {
          nativeIneligiblePaths.add(leaf.contrib.bundle_path);
          if (isPlaying && !isStarting) {
            void startSequence(currentTime, true);
          }
        });
      }

      let maxW = 0;
      for (const leaf of drawnVideoLeaves) {
        const maxWin = maxWindowDuration(leaf.timing, leaf.rL);
        if (maxWin > maxW) maxW = maxWin;
      }
      const timeoutMs = Math.max(500, 4 * maxW * 1000);

      const waitAll = Promise.all([
        Promise.all(firstAdvancedPromises),
        Promise.allSettled(playPromises),
      ]);

      const { promise: timeoutPromise, resolve: resolveTimeout } =
        Promise.withResolvers<'timeout'>();
      const timeoutTimer = setTimeout(
        () => resolveTimeout('timeout'),
        timeoutMs
      );

      let raceResult:
        | [{ now: number; tag: number }[], PromiseSettledResult<void>[]]
        | 'timeout'
        | 'failed';
      try {
        raceResult = await Promise.race([waitAll, timeoutPromise]);
      } catch {
        raceResult = 'failed';
      }
      clearTimeout(timeoutTimer);
      if (stale(gen)) return;

      if (
        drawnVideoLeaves.some((leaf) =>
          nativeIneligiblePaths.has(leaf.contrib.bundle_path)
        )
      ) {
        fallbackToSeekCadence();
        return;
      }

      if (raceResult === 'timeout' || raceResult === 'failed') {
        if (attempt === 0) continue;
        fallbackToSeekCadence();
        return;
      }

      const [advancedSamples, settledPlays] = raceResult;
      const anyPlayRejected = settledPlays.some((p) => p.status === 'rejected');
      if (anyPlayRejected) {
        if (attempt === 0) continue;
        fallbackToSeekCadence();
        return;
      }

      const phaseSamples: DecoderPhaseSample[] = [];
      let anchorFailed = false;
      for (let i = 0; i < drawnVideoLeaves.length; i++) {
        const leaf = drawnVideoLeaves[i]!;
        const adv = advancedSamples[i]!;
        const actualStart = leaf.timing.starts[adv.tag];
        if (actualStart === undefined) {
          anchorFailed = true;
          break;
        }
        const sourceT0Seconds = decoderLocalSeconds(leaf.contrib.source_time);
        phaseSamples.push({
          dL: adv.now,
          iL0Plus1Start: actualStart,
          sourceT0Seconds,
          rL: leaf.rL,
          wMinSeconds: leaf.wMinSeconds,
        });
      }

      if (anchorFailed) {
        if (attempt === 0) continue;
        fallbackToSeekCadence();
        return;
      }

      const anchorResult = computePhaseAnchor(
        phaseSamples,
        vsyncTracker.medianSeconds
      );
      if (!anchorResult.spreadAcceptable) {
        if (attempt === 0) continue;
        fallbackToSeekCadence();
        return;
      }

      nativeAnchor = { wallMs: anchorResult.tauStar, time: T0 };

      for (const leaf of drawnVideoLeaves) {
        const ring = nativeRings.get(leaf.key);
        if (ring) ring.isStarting = false;
      }

      startSuccess = true;
      break;
    }
    if (!startSuccess) {
      fallbackToSeekCadence();
      return;
    }

    const startOccurrenceKeys = collectVideoOccurrenceKeys(
      evaluation.video_contributions
    );
    knownVideoKeys = new Set(startOccurrenceKeys.filter(Boolean));

    isStarting = false;
    isBuffering = false;
    notify();
    if (isPlaying) scheduleTick();
  }

  function scheduleTick(): void {
    if (!isPlaying || isDisposed || frameHandle !== null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    frameHandle = requestAnimationFrame(onTick);
  }

  function onTick(now: number): void {
    frameHandle = null;
    if (!isPlaying || isDisposed) return;
    vsyncTracker.recordTick(now);
    if (renderInFlight || isBuffering || isStarting) {
      clockAnchor = null;
      scheduleTick();
      return;
    }
    if (nativeMode && nativeAnchor !== null) {
      const elapsed = (now - nativeAnchor.wallMs) / 1000;
      let T: OtioRationalTime;
      if (elapsed <= 0) {
        T = nativeAnchor.time;
      } else {
        T = addRationalTimes(nativeAnchor.time, {
          value: elapsed * clock.rate,
          rate: clock.rate,
        });
      }

      if (compareRationalTimes(T, clock.duration) >= 0) {
        currentTime = clock.duration;
        isPlaying = false;
        nativeAnchor = null;
        pauseAllMedia();
        void enqueueRender(currentTime, ++renderGeneration);
        notify();
        return;
      }

      const evaluation = evaluateOtioAt(doc, timelineId, T);
      const tree = videoTree(evaluation);
      const blocked = blockedTracks(tree);
      const isHidden = (nodeId: string, ancestry: readonly string[]) =>
        videoHidden(nodeId, ancestry) || blocked.has(nodeId);
      const drawnLeafIndices = getDrawnLeafIndices(tree, isHidden);
      const occurrenceKeys = collectVideoOccurrenceKeys(
        evaluation.video_contributions
      );

      const currentDrawnOccurrenceKeys = drawnVideoKeys(evaluation, tree);
      for (let idx = 0; idx < evaluation.video_contributions.length; idx++) {
        const contrib = evaluation.video_contributions[idx];
        if (!contrib || contrib.bundle_path === null) continue;
        const mime = inferMediaMimeType(contrib.bundle_path);
        if (!mime.startsWith('video/')) continue;
        const key = occurrenceKeys[idx];
        if (
          key &&
          !currentDrawnOccurrenceKeys.has(key) &&
          !knownVideoKeys.has(key)
        ) {
          knownVideoKeys.add(key);
          void prepareLeaf(contrib, key, renderGeneration);
        }
      }

      const drawnNativeLeaves: {
        contrib: OtioVideoContribution & { bundle_path: OtioBundleEntryName };
        key: string;
        timing: Extract<OtioVideoTiming, { kind: 'windows' }>;
        req: number;
        idx: number;
        rL: number;
      }[] = [];
      let uncertifiedTailSample = false;

      for (const idx of drawnLeafIndices) {
        const contrib = evaluation.video_contributions[idx];
        if (!contrib || contrib.bundle_path === null) continue;
        const mime = inferMediaMimeType(contrib.bundle_path);
        if (mime.startsWith('image/')) {
          if (!imageElements.has(contrib.bundle_path)) {
            scheduleTick();
            return;
          }
          continue;
        }
        if (!mime.startsWith('video/')) continue;
        const fidelity = effectFidelity(
          contrib.active_effects,
          contrib.node_id
        );
        if (fidelity.kind === 'freeze') continue;

        const key = occurrenceKeys[idx];
        if (!key) continue;

        const timing = videoTimingCache.get(contrib.bundle_path);
        const req = certifiedWindowIndex(contrib.source_time, timing ?? null);
        if (req === null || !timing || timing.kind !== 'windows') {
          uncertifiedTailSample = true;
          continue;
        }
        const rL = fidelity.kind === 'effect' ? 1 : fidelity.rate;
        drawnNativeLeaves.push({
          contrib: contrib as OtioVideoContribution & {
            bundle_path: OtioBundleEntryName;
          },
          key,
          timing,
          req,
          idx,
          rL,
        });
      }

      const drawnSetChanged = !setsEqual(
        currentDrawnOccurrenceKeys,
        lastDrawnOccurrenceKeys
      );

      if (drawnSetChanged) {
        lastDrawnOccurrenceKeys = currentDrawnOccurrenceKeys;
        drawnSetChangeTimestamps = drawnSetChangeTimestamps.filter(
          (t) => now - t <= 5000
        );
        drawnSetChangeTimestamps.push(now);
        if (drawnSetChangeTimestamps.length > 3) {
          fallbackToSeekCadence();
          return;
        }
        void startSequence(T, true);
        return;
      }

      if (uncertifiedTailSample) {
        void startSequence(T, true);
        return;
      }

      let allApproved = true;
      let failureResyncNeeded = false;

      for (const leaf of drawnNativeLeaves) {
        const ring = nativeRings.get(leaf.key);
        if (
          !ring ||
          ring.hasLostContext() ||
          !ring.hasTag(leaf.req, nativeEpoch)
        ) {
          allApproved = false;
          if (ring?.hasLostContext()) {
            ring.resetEpoch(nativeEpoch);
          }
          const missingWindowSec =
            (leaf.timing.ends[leaf.req] ?? 0) -
            (leaf.timing.starts[leaf.req] ?? 0);
          const outOfBandLimit = Math.max(
            2 * (missingWindowSec / leaf.rL) * 1000,
            100
          );
          if (ring) {
            if (ring.missingSince === null) ring.missingSince = now;
            if (now - ring.missingSince > outOfBandLimit) {
              failureResyncNeeded = true;
              break;
            }
          }
        } else if (ring) {
          ring.missingSince = null;
        }

        if (ring && ring.lastCallbackWallMs !== null) {
          const t = ring.lastCapturedTag ?? leaf.req;
          const stallWindowSec =
            (leaf.timing.ends[t] ?? leaf.timing.ends[leaf.req] ?? 0) -
            (leaf.timing.starts[t] ?? leaf.timing.starts[leaf.req] ?? 0);
          const stallLimit = Math.max(
            3 * (stallWindowSec / leaf.rL) * 1000,
            100
          );
          if (now - ring.lastCallbackWallMs > stallLimit) {
            failureResyncNeeded = true;
            break;
          }
        }
      }

      if (failureResyncNeeded) {
        failureResyncTimestamps = failureResyncTimestamps.filter(
          (t) => now - t <= 10000
        );
        failureResyncTimestamps.push(now);
        if (failureResyncTimestamps.length >= 3) {
          fallbackToSeekCadence();
          return;
        }
        void startSequence(T, true);
        return;
      }

      if (!allApproved) {
        scheduleTick();
        return;
      }

      const leaves: (OtioPreparedLeaf | null)[] =
        evaluation.video_contributions.map((contrib, idx) => {
          if (sampleKind(contrib) === 'black')
            return { kind: 'black' as const };
          const fidelity = effectFidelity(
            contrib.active_effects,
            contrib.node_id
          );
          const withheld =
            !baseMediaPreviewAllowed &&
            (fidelity.kind === 'effect' || fidelity.kind === 'rate');
          if (withheld) return { kind: 'empty' as const };
          if (contrib.bundle_path === null) return { kind: 'empty' as const };
          const mime = inferMediaMimeType(contrib.bundle_path);
          if (mime.startsWith('image/')) {
            const loaded = imageElements.get(contrib.bundle_path);
            if (!loaded) return { kind: 'empty' as const };
            return {
              kind: 'image' as const,
              source: loaded.element,
              alpha: contrib.alpha,
            };
          }
          if (!mime.startsWith('video/')) return { kind: 'empty' as const };
          if (sampleUnavailable(doc, contrib))
            return { kind: 'empty' as const };
          if (fidelity.kind === 'freeze') {
            const key = occurrenceKeys[idx];
            const video = key ? videos.get(key) : undefined;
            if (!video) return { kind: 'empty' as const };
            return {
              kind: 'image' as const,
              source: video.element,
              alpha: contrib.alpha,
            };
          }
          const key = occurrenceKeys[idx];
          const ring = key ? nativeRings.get(key) : undefined;
          if (!ring) return { kind: 'empty' as const };
          const timing = videoTimingCache.get(contrib.bundle_path);
          const req = certifiedWindowIndex(contrib.source_time, timing ?? null);
          if (req === null) return { kind: 'empty' as const };
          const slot = ring.findSlotWithTag(req, nativeEpoch);
          if (!slot) return { kind: 'empty' as const };
          return {
            kind: 'image' as const,
            source: slot.canvas,
            alpha: contrib.alpha,
          };
        });

      let presented = false;
      try {
        presented = paint(tree, leaves);
      } catch {}

      if (presented && !graphicsLost && !isCanvasContextLost(canvas)) {
        currentTime = T;
        void reconcileAudio(evaluation, renderGeneration);
        notify();
      }
      scheduleTick();
      return;
    }
    if (
      !failureSeekCadence &&
      !setsEqual(lastRenderDrawnOccurrenceKeys, lastDrawnOccurrenceKeys)
    ) {
      let canGoNative = lastRenderDrawnOccurrenceKeys.size > 0;
      if (canGoNative) {
        for (const key of lastRenderDrawnOccurrenceKeys) {
          const video = videos.get(key);
          if (!video) {
            canGoNative = false;
            break;
          }
          if (typeof VideoFrame !== 'function') {
            canGoNative = false;
            break;
          }
          const rvfcVideo = video.element as HTMLVideoElementWithRvfc;
          if (typeof rvfcVideo.requestVideoFrameCallback !== 'function') {
            canGoNative = false;
            break;
          }
          const contrib = lastRenderVideoContributions.get(key);
          const bundlePath = contrib?.bundle_path;
          if (!bundlePath || nativeIneligiblePaths.has(bundlePath)) {
            canGoNative = false;
            break;
          }
          const timing = videoTimingCache.get(bundlePath);
          if (!timing || timing.kind !== 'windows') {
            canGoNative = false;
            break;
          }
          const node = contrib
            ? (doc.nodes[contrib.node_id] as
                | (OtioNode & {
                    readonly media_reference?: { readonly schema?: string };
                  })
                | undefined)
            : undefined;
          if (node?.media_reference?.schema === 'ImageSequenceReference.1') {
            canGoNative = false;
            break;
          }
        }
      }
      if (canGoNative) {
        drawnSetChangeTimestamps = drawnSetChangeTimestamps.filter(
          (t) => now - t <= 5000
        );
        drawnSetChangeTimestamps.push(now);
        if (drawnSetChangeTimestamps.length > 3) {
          fallbackToSeekCadence();
          return;
        }
        void startSequence(currentTime, true);
        return;
      } else {
        lastDrawnOccurrenceKeys = lastRenderDrawnOccurrenceKeys;
      }
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
    const suppressedPresentationDiagnostics = new Set<OtioDiagnostic>();
    const retainedPresentationDiagnostics = new Set<OtioDiagnostic>();
    for (const contribution of evaluation.video_contributions) {
      collectDecoderPresentationHandleDiagnostics(
        doc,
        contribution,
        suppressedPresentationDiagnostics,
        retainedPresentationDiagnostics
      );
    }
    for (const contribution of evaluation.audio_contributions) {
      collectDecoderPresentationHandleDiagnostics(
        doc,
        contribution,
        suppressedPresentationDiagnostics,
        retainedPresentationDiagnostics
      );
    }
    for (const issue of retainedPresentationDiagnostics) {
      suppressedPresentationDiagnostics.delete(issue);
    }
    const issues = [
      ...videoTimingFailures.values(),
      ...evaluation.diagnostics.filter(
        (issue) => !suppressedPresentationDiagnostics.has(issue)
      ),
      ...contributionIssues(evaluation),
      ...withheldAudioSampleIssues(evaluation),
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
      buffering:
        isBuffering ||
        (isStarting &&
          (typeof performance !== 'undefined'
            ? performance.now() - startingStartTime > 250
            : Date.now() - startingStartTime > 250)),
      duration: clock.duration,
      rate: clock.rate,
      diagnostics,
      tracks: { ...tracks },
      baseMediaPreviewAllowed,
      previewBlocked:
        !baseMediaPreviewAllowed && contributionIssues(evaluation).length > 0,
      graphicsFailed,
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
      const lastFrameTime: OtioRationalTime = {
        value: Math.max(0, clock.duration.value - 1),
        rate: clock.rate,
      };
      if (
        clock.known &&
        (compareRationalTimes(currentTime, lastFrameTime) >= 0 ||
          compareRationalTimes(currentTime, clock.duration) >= 0)
      ) {
        currentTime = { value: 0, rate: clock.rate };
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
      failureSeekCadence = false;
      await startSequence(currentTime);
    },

    pause(): void {
      if (isDisposed || !isPlaying) return;
      isPlaying = false;
      isStarting = false;
      clockAnchor = null;
      nativeAnchor = null;
      if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      pauseAllMedia();
      notify();
    },

    async seek(time: OtioRationalTime): Promise<void> {
      if (isDisposed) return;
      currentTime = clampTime(time);
      failureSeekCadence = false;
      clockAnchor = null;
      nativeAnchor = null;
      if (isPlaying) {
        await startSequence(currentTime);
      } else {
        const gen = ++renderGeneration;
        isBuffering = true;
        notify();
        await enqueueRender(currentTime, gen);
        if (stale(gen)) return;
        clockAnchor = null;
        notify();
      }
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
      if (isPlaying) {
        void startSequence(currentTime, true);
      } else {
        void enqueueRender(currentTime, ++renderGeneration);
      }
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
      if (isPlaying) {
        void startSequence(currentTime, true);
      } else {
        void enqueueRender(currentTime, ++renderGeneration);
      }
    },

    setBaseMediaPreviewAllowed(allowed: boolean): void {
      if (isDisposed) return;
      baseMediaPreviewAllowed = allowed;
      notify();
      void enqueueRender(currentTime, ++renderGeneration);
    },

    dispose(): void {
      if (isDisposed) return;
      restoreVisibleCanvas();
      isDisposed = true;
      graphicsFailed = false;
      clearTimeout(restoreTimeout);
      restoreTimeout = undefined;
      if (typeof canvas.removeEventListener === 'function') {
        canvas.removeEventListener('contextlost', onVisibleContextLost);
        canvas.removeEventListener('contextrestored', onVisibleContextRestored);
      }
      videoTimingAbort.abort();
      isPlaying = false;
      isStarting = false;
      for (const ring of nativeRings.values()) ring.release();
      nativeRings.clear();
      videoTimingCache.clear();
      nativeAnchor = null;
      vsyncTracker.reset();
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
      for (const surface of surfacePool) {
        if (surface) {
          removeSurfaceListener(surface);
          surface.width = 0;
          surface.height = 0;
        }
      }
      surfacePool.length = 0;
      pooledSurfaceListeners.clear();
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
