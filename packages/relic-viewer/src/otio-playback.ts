/**
 * OpenTimelineIO playback for the Relik viewer.
 *
 * The shared evaluator owns placement, sequence paths, and sampling. This
 * controller owns decoders, the composition tree, the transport clock, and
 * resource teardown. It does not dispose an injected media resolver.
 */

import type {
  OtioAudioContribution,
  OtioAudioScheduleSpan,
  OtioAudioSampleLattice,
  OtioBundleEntryName,
  OtioDiagnostic,
  OtioDocumentV1,
  OtioEffect,
  OtioEvaluationResult,
  OtioNode,
  OtioPlaybackBoundary,
  OtioRationalTime,
  OtioTimeRange,
  OtioVideoContribution,
} from '@relic/format';
import {
  addRationalTimes,
  audioScheduleForOtioRange,
  compareRationalTimes,
  evaluateOtioAt,
  otioPlaybackBoundaries,
  otioAudioSampleLattice,
  otioSamplingMap,
  rangeContainsTime,
  rescaleTime,
} from '@relic/format';
import { inferMediaMimeType, type OtioMediaResolver } from './otio-media.ts';
import { preflightWavePcm, type WavePcmHeader } from './otio-wave-pcm.ts';
import {
  OtioPcmBudget,
  OtioPcmProvider,
  OtioPcmScheduler,
  type OtioPcmGainFactor,
  type OtioPcmPrepared,
} from './otio-audio-pcm.ts';
import {
  createOtioTransportGate,
  OtioGateModuleLoadError,
  OtioGateRenderClockError,
  type OtioTransportGate,
  type OtioGateAck,
} from './otio-transport-gate.ts';
import { OutputClock } from './otio-output-clock.ts';
import {
  OTIO_PCM_MAX_BYTES,
  OTIO_PCM_PULL_SCRATCH_BYTES,
  OTIO_PCM_MAX_HORIZON_SECONDS,
  OTIO_PCM_MAX_NODES,
  OTIO_PCM_PACKET_FRAMES,
  OTIO_PCM_MAX_STREAMS,
  OTIO_PCM_MIN_LEAD_FRAMES,
} from './otio-audio-pcm-protocol.ts';
import {
  type OtioVideoTiming,
  readOtioVideoTiming,
} from './otio-video-timing.ts';
import {
  acceptsDecoderLocalZero,
  certifiedWindowIndex,
  checkNativeTimingEligibility,
  computePhaseAnchor,
  decoderLocalSeconds,
  decoderLocalSourceTime,
  maxWindowDuration,
  minWindowDuration,
  NativeDecoderRing,
  OTIO_PACKET_START_TOLERANCE_SECONDS,
  OTIO_RETAINED_SNAPSHOT_PIXELS,
  presentedWindowOutcome,
  readPresentedFrame,
  SNAPSHOT_SLOTS_PER_DECODER,
  selectOtioCausalEpoch,
  SnapshotPixelBudget,
  videoDecoderTime,
  VsyncTracker,
  type DecoderPhaseSample,
  type HTMLVideoElementWithRvfc,
  type NativeSnapshotReservation,
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

/** Keeps worklet-node credits until render-thread or owned-context retirement. */
export class OtioPcmGateRetirements {
  private readonly releases = new Set<() => void>();
  constructor(private readonly budget: OtioPcmBudget) {}

  reserve(): () => void {
    this.budget.reserveNodes(2);
    const release = () => {
      if (!this.releases.delete(release)) return;
      this.budget.releaseNodes(2);
    };
    this.releases.add(release);
    return release;
  }

  retire(gate: Pick<OtioTransportGate, 'dispose'>, release: () => void): void {
    try {
      void gate.dispose().then(release, () => undefined);
    } catch {
      // Failed shutdown is not evidence that the processor retired.
    }
  }

  contextClosed(): void {
    for (const release of this.releases) release();
  }
}
export const OTIO_MAX_IMAGE_EDGE = 4096;
export const OTIO_MAX_IMAGE_PIXELS = 4096 * 4096;
export const OTIO_RETAINED_IMAGE_PIXELS = 32 * 1024 * 1024;
const HAVE_CURRENT_DATA = 2;
// Operational candidate; integrated startup qualification must measure this guard.
const OTIO_PCM_EPOCH_GUARD_FRAMES = 512;
const OTIO_PCM_SELECTION_RESERVE_FRAMES = 704;
const OTIO_PCM_TARGET_LEAD_SECONDS = 0.4;
// Chromium can quantize an assigned midpoint twice: the loopback proof saw
// 4.020833333333334 report 4.020832 on seeked. Two microseconds cover that
// measured granularity without accepting a neighboring ordinary video frame.
const MEDIA_SEEK_TIME_PRECISION_SECONDS = 2e-6;
// Chromium presents a seeked frame within about 250 ms. A paused leaf waits
// four times that for its certified window before it is withheld.
export const OTIO_PAUSED_PRESENT_TIMEOUT_MS = 1000;
const OTIO_PAUSED_PRESENT_POLL_MS = 16;
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

export interface OtioPlaybackScope {
  readonly nodeId: string;
  readonly range: OtioTimeRange;
}

export interface OtioPlaybackState {
  readonly time: OtioRationalTime;
  readonly scope: OtioPlaybackScope | null;
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
  setScope(scope: OtioPlaybackScope | null): Promise<void>;
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
  private readonly leased = new Map<string, number>();
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
    if (this.leased.has(key)) {
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
    if (this.pixels > this.budget) {
      this.entries.delete(key);
      this.pinned.delete(key);
      this.pixels -= pixels;
      release();
      return false;
    }
    return true;
  }

  evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.pixels <= this.budget) break;
      if (this.pinned.has(key) || this.leased.has(key)) continue;
      this.pixels -= entry.pixels;
      entry.release();
      this.entries.delete(key);
    }
  }

  reserve(key: string): { isValid(): boolean; release(): void } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.leased.set(key, (this.leased.get(key) ?? 0) + 1);
    let released = false;
    return {
      isValid: () =>
        !released && this.entries.get(key) === entry && this.leased.has(key),
      release: () => {
        if (released) return;
        released = true;
        if (this.entries.get(key) !== entry) return;
        const count = this.leased.get(key) ?? 0;
        if (count <= 1) this.leased.delete(key);
        else this.leased.set(key, count - 1);
      },
    };
  }

  releaseAll(): void {
    for (const entry of this.entries.values()) entry.release();
    this.entries.clear();
    this.pinned.clear();
    this.leased.clear();
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
): 'painted' | 'empty' | 'failed' {
  try {
    const root = tree
      ? paintNode(tree, 0, width, height, leaves, checkout, hidden)
      : null;
    output.globalCompositeOperation = 'source-over';
    output.globalAlpha = 1;
    output.fillStyle = '#000000';
    output.fillRect(0, 0, width, height);
    if (!root) return 'empty';
    output.globalCompositeOperation = 'source-over';
    output.globalAlpha = 1;
    output.drawImage(root, 0, 0, width, height);
    return 'painted';
  } catch {
    return 'failed';
  }
}

function closeFrames(frames: VideoFrame[]): void {
  for (const frame of frames.splice(0)) frame.close();
}

function presentClockMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Resolves at the next presented frame or after pollMs, whichever comes first.
// The loser is cancelled so no callback outlives the wait.
function nextPresentation(
  media: HTMLVideoElement,
  pollMs: number
): Promise<void> {
  const rvfcMedia = media as HTMLVideoElementWithRvfc;
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  let handle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    if (handle !== null) rvfcMedia.cancelVideoFrameCallback?.(handle);
    resolve();
  };
  if (typeof rvfcMedia.requestVideoFrameCallback === 'function') {
    handle = rvfcMedia.requestVideoFrameCallback(() => {
      handle = null;
      finish();
    });
  }
  timer = setTimeout(finish, pollMs);
  return promise;
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
    if (!leaf) throw new Error('Composition leaf is unavailable');
    if (leaf.kind === 'empty') return null;
    const surface = checkout(depth);
    const ctx = surface.getContext('2d');
    if (!ctx) throw new Error('Canvas surface context unavailable');
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
        if (!ctx) throw new Error('Canvas surface context unavailable');
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
      if (!ctx) throw new Error('Canvas surface context unavailable');
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

function collectAudioOccurrenceKeys(
  contributions: readonly OtioAudioContribution[]
): string[] {
  const seen = new Map<string, number>();
  return contributions.map((contrib) => {
    const identity = `${ancestryOf(contrib).join('/')}|${contrib.node_id}`;
    const dup = seen.get(identity) ?? 0;
    seen.set(identity, dup + 1);
    return occurrenceKey(contrib.node_id, ancestryOf(contrib), dup);
  });
}

function getDrawnLeafIndices(
  tree: OtioVideoCompositionTree | null,
  isHidden: (nodeId: string, ancestry: readonly string[]) => boolean,
  includeZeroWeight = false
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
        if (branch.child && (includeZeroWeight || branch.weight > 0))
          visit(branch.child);
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
  let scope: OtioPlaybackScope | null = null;
  let scopeRootId: string | null = null;
  let scopeNodes = new Set<string>();
  let scopeContext = new Set<string>();
  let scopeEpoch = 0;
  let scopeAbort = new AbortController();

  function scopedEvaluation(time: OtioRationalTime): OtioEvaluationResult {
    const result = evaluateOtioAt(doc, timelineId, time);
    if (!scope || !scopeRootId) return result;
    const selected = (item: { node_id: string; ancestry: readonly string[] }) =>
      doc.nodes[scope!.nodeId]?.enabled !== false &&
      (scopeNodes.has(item.node_id) || item.ancestry.includes(scopeRootId!)) &&
      item.ancestry.every((id) => doc.nodes[id]?.enabled !== false);
    const video: OtioVideoContribution[] = [];
    const indices = new Map<number, number>();
    result.video_contributions.forEach((item, index) => {
      if (selected(item)) {
        indices.set(index, video.length);
        video.push(item);
      }
    });
    function prune(
      tree: OtioVideoCompositionTree | null
    ): OtioVideoCompositionTree | null {
      if (!tree) return null;
      if (tree.kind === 'leaf') {
        const index = indices.get(tree.contribution_index);
        return index === undefined
          ? null
          : { ...tree, contribution_index: index };
      }
      if (tree.kind === 'stack') {
        const children = tree.children
          .map(prune)
          .filter((child): child is OtioVideoCompositionTree => child !== null);
        return children.length ? { ...tree, children } : null;
      }
      const branches = tree.branches.map((branch) => ({
        ...branch,
        child: prune(branch.child),
      }));
      return branches.some((branch) => branch.child !== null)
        ? { ...tree, branches }
        : null;
    }
    return {
      ...result,
      video_contributions: video,
      audio_contributions: result.audio_contributions.filter(selected),
      active_transitions: result.active_transitions.filter(
        (item) =>
          scopeContext.has(item.track_id) ||
          scopeNodes.has(item.node_id) ||
          item.ancestry.includes(scopeRootId!)
      ),
      video_composition: prune(result.video_composition),
      active_markers: result.active_markers.filter((marker) =>
        scopeNodes.has(marker.owner_node_id)
      ),
      diagnostics: result.diagnostics.filter(
        (issue) =>
          !issue.target?.node_id || scopeContext.has(issue.target.node_id)
      ),
    };
  }

  function scopeEnd(): OtioRationalTime {
    return scope
      ? addRationalTimes(scope.range.start_time, scope.range.duration)
      : clock.duration;
  }

  function scopeLastSample(): OtioRationalTime {
    if (!scope) return clock.duration;
    const start = rescaleTime(scope.range.start_time, clock.rate);
    const end = rescaleTime(scopeEnd(), clock.rate);
    return {
      value: Math.max(
        start.value,
        end.value - Math.min(1, (end.value - start.value) / 2)
      ),
      rate: clock.rate,
    };
  }
  let isPlaying = false;
  let isBuffering = false;
  let isDisposed = false;
  let baseMediaPreviewAllowed = false;
  let renderGeneration = 0;
  let renderInFlight = false;
  let frameHandle: number | null = null;
  let clockAnchor: ClockAnchor | null = null;
  let renderTail: Promise<void> = Promise.resolve();
  let pendingRender: Promise<void> | null = null;

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
  const imageOwners = new Map<string, Set<() => boolean>>();
  const videos = new Map<string, LoadedVideo>();
  const audios = new Map<string, LoadedAudio>();
  const decodedAt = new WeakMap<HTMLMediaElement, number>();
  const images = new ImageFrameCache(OTIO_RETAINED_IMAGE_PIXELS);
  const imageElements = new Map<string, LoadedImage>();
  const surfacePool: HTMLCanvasElement[] = [];
  const coldProofGlobal = globalThis as typeof globalThis & {
    __otioProofCold?: boolean;
    __otioProofPcm?: boolean;
    __otioProofPcmFault?:
      | 'invalidate-next-reserved-tag'
      | 'withhold-future-video';
  };
  function coldProof(
    event: string,
    details: Record<string, unknown> = {}
  ): void {
    if (coldProofGlobal.__otioProofCold === true)
      console.log('OTIO_PROOF_COLD', {
        event,
        wall: presentClockMs(),
        ...details,
      });
  }
  function pcmProof(
    event: string,
    generation: number,
    details: Record<string, unknown> = {}
  ): void {
    if (coldProofGlobal.__otioProofPcm === true)
      console.log('OTIO_PROOF_PCM', {
        event,
        generation,
        wallMs: presentClockMs(),
        ...details,
      });
  }
  type PcmLattice = Extract<OtioAudioSampleLattice, { eligible: true }>;
  type PcmSpan = { span: OtioAudioScheduleSpan; lattice: PcmLattice };
  type PcmAsset = { blob: Blob; header: WavePcmHeader };
  type PcmAdmission = {
    rate: number;
    spans: PcmSpan[];
    assets: Map<OtioBundleEntryName, PcmAsset>;
  };
  type PcmSelection =
    | { kind: 'pcm'; admission: PcmAdmission }
    | { kind: 'native'; reason: string };
  type PcmChunk = {
    plan: PcmSpan;
    timelineStart: number;
    sourceStart: number;
    prepared: OtioPcmPrepared;
    count: number;
  };
  type PcmRun = {
    generation: number;
    context: AudioContext;
    routeVersion: number;
    admission: PcmAdmission;
    provider: OtioPcmProvider;
    scheduler: OtioPcmScheduler;
    outputClock: OutputClock;
    clockCalibration: Promise<boolean> | null;
    gate: OtioTransportGate;
    releaseGateCredit: () => void;
    tracks: Map<string, GainNode>;
    streams: Map<OtioBundleEntryName, string>;
    chunks: PcmChunk[];
    startFrame: number;
    startTime: OtioRationalTime;
    preparedThrough: number;
    scheduledThrough: number;
    contextFrame: number | null;
    phaseSamples: readonly DecoderPhaseSample[];
    frontierFrame: number | null;
    frontierCrossedAt: number | null;
    bridge: {
      contextTime: number;
      performanceTime: number;
      mappingAllowanceMs: number;
    } | null;
    holds: PcmVideoHold[];
    loading: Promise<void> | null;
    stopping: boolean;
    command: Promise<boolean> | null;
    stopWatchdog: ReturnType<typeof setTimeout> | null;
    onContextState: () => void;
    closeReason: 'pause' | 'frontier' | 'resync' | 'resource' | 'error';
    stopped: boolean;
  };
  let pcmRun: PcmRun | null = null;
  let pcmAdmission: PcmAdmission | null = null;
  let audioBackend: 'native' | 'pcm' = 'native';
  let pcmGeneration = 0;
  const pcmBudget = new OtioPcmBudget();
  const pcmGateRetirements = new OtioPcmGateRetirements(pcmBudget);
  let pcmPlayIntent = false;
  let pcmBackendStarted = false;
  let pcmRecoveryWake: (() => void) | null = null;
  let pcmResumeFrame: number | null = null;
  let pcmRequestWall = 0;
  async function beforePcmDeadline<T>(
    operation: Promise<T>,
    requestMs: number
  ): Promise<T> {
    const deadline = new OutputClock(requestMs).deadline;
    const remaining = deadline - presentClockMs();
    if (remaining <= 0)
      throw new Error('scheduled audio startup deadline expired');
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(
      () =>
        timeout.reject(new Error('scheduled audio startup deadline expired')),
      remaining
    );
    try {
      const result = await Promise.race([operation, timeout.promise]);
      if (presentClockMs() > deadline)
        throw new Error('scheduled audio startup deadline expired');
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  let coldFirstTick = false;
  let coldFirstPaint = false;
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
  let nativeLastPresentMs: number | null = null;
  let nativeEpoch = 0;
  let isNativeHolding = false;
  let failureResyncTimestamps: number[] = [];
  let drawnSetChangeTimestamps: number[] = [];
  let lastDrawnOccurrenceKeys = new Set<string>();
  let lastRenderDrawnOccurrenceKeys = new Set<string>();
  const lastRenderVideoContributions = new Map<string, OtioVideoContribution>();
  const hiddenWarmSeen = new Set<string>();
  const hiddenWarmInFlight = new Set<string>();
  let isStarting = false;
  let playRequestEpoch = 0;
  let cancelStartupSampling: (() => void) | null = null;
  let startingStartTime = 0;
  const videoTimingCache = new Map<string, OtioVideoTiming>();
  const audioSeeking = new WeakSet<LoadedAudio>();
  let audioReconcileRevision = 0;
  const desiredAudioGain = new WeakMap<
    LoadedAudio,
    { gain: number; audible: boolean }
  >();
  type BoundaryPreparation = {
    readonly at: OtioRationalTime;
    readonly keys: Set<string>;
    readonly generation: number;
    readonly scope: number;
    readonly anchor: { wallMs: number; time: OtioRationalTime };
    readonly abort: AbortController;
    status: 'preparing' | 'ready' | 'failed';
    readonly rings: Map<string, NativeDecoderRing>;
    readonly audioKeys: Set<string>;
    readonly audio: Map<string, LoadedAudio>;
    readonly imagePaths: Set<OtioBundleEntryName>;
  };
  let preparedBoundary: BoundaryPreparation | null = null;
  let playbackBoundaries: OtioPlaybackBoundary[] = [];

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
    const blocked = blockedTracks(evaluation);
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
      ring = new NativeDecoderRing(element, key, bundlePath, snapshotBudget, {
        strictProducerOrder: audioBackend === 'pcm',
      });
      nativeRings.set(key, ring);
    }
    ring.setStrictProducerOrder(audioBackend === 'pcm');
    return ring;
  }

  type PcmVisualInterval = {
    end: OtioRationalTime;
    reservations: NativeSnapshotReservation[];
    images: Array<{
      path: OtioBundleEntryName;
      isValid(): boolean;
      release(): void;
    }>;
  };
  type PcmVideoHold = {
    through: OtioRationalTime;
    intervals: PcmVisualInterval[];
    isValid(): boolean;
    releaseThrough(time: OtioRationalTime): void;
    release(): void;
  };

  /** Reserve only an actually captured contiguous visual prefix. */
  function reserveVisualPrefix(
    from: OtioRationalTime,
    limit: OtioRationalTime
  ): PcmVideoHold {
    let cursor = from;
    const intervals: PcmVisualInterval[] = [];
    const ownerGeneration = renderGeneration;
    const ownerScope = scopeEpoch;
    const ownerAnchor = nativeAnchor;
    const ownerSize = outputSize();
    const ownerRun = pcmRun;
    const proofHost = typeof location === 'undefined' ? '' : location.hostname;
    const withholdFuture =
      coldProofGlobal.__otioProofPcm === true &&
      coldProofGlobal.__otioProofPcmFault === 'withhold-future-video' &&
      (proofHost === '127.0.0.1' ||
        proofHost === 'localhost' ||
        proofHost.endsWith('.localhost') ||
        proofHost === '[::1]');
    let released = false;
    for (
      let iteration = 0;
      !withholdFuture &&
      iteration < 512 &&
      compareRationalTimes(cursor, limit) < 0;
      iteration++
    ) {
      if (graphicsLost || isCanvasContextLost(canvas)) break;
      const evaluation = scopedEvaluation(cursor);
      if (previewBlocked(evaluation)) break;
      const tree = videoTree(evaluation);
      if (!tree && evaluation.video_contributions.length > 0) break;
      const blocked = blockedTracks(evaluation);
      const indices = getDrawnLeafIndices(
        tree,
        (id, ancestry) => videoHidden(id, ancestry) || blocked.has(id),
        true
      );
      const keys = collectVideoOccurrenceKeys(evaluation.video_contributions);
      let end = limit;
      for (const boundary of playbackBoundaries) {
        if (
          compareRationalTimes(boundary.time, cursor) > 0 &&
          compareRationalTimes(boundary.time, end) < 0
        )
          end = boundary.time;
      }
      const requested = new Map<NativeDecoderRing, Set<number>>();
      const intervalImages = new Set<OtioBundleEntryName>();
      let valid = true;
      for (const index of indices) {
        const contribution = evaluation.video_contributions[index];
        if (!contribution || sampleKind(contribution) === 'black') continue;
        const path = contribution.bundle_path;
        if (!path || sampleUnavailable(doc, contribution)) {
          valid = false;
          break;
        }
        const node = doc.nodes[contribution.node_id];
        if (
          node?.active_media_reference_key &&
          node.media_references?.[node.active_media_reference_key]?.schema ===
            'ImageSequenceReference.1'
        ) {
          valid = false;
          break;
        }
        const mime = inferMediaMimeType(path);
        if (mime.startsWith('image/')) {
          if (!imageElements.has(path)) {
            valid = false;
            break;
          }
          intervalImages.add(path);
          continue;
        }
        if (!mime.startsWith('video/')) {
          valid = false;
          break;
        }
        const fidelity = effectFidelity(
          contribution.active_effects,
          contribution.node_id
        );
        const key = keys[index];
        if (
          !key ||
          fidelity.kind === 'rate' ||
          (fidelity.kind === 'effect' && !baseMediaPreviewAllowed)
        ) {
          valid = false;
          break;
        }
        const timing = videoTimingCache.get(path);
        if (fidelity.kind === 'freeze') {
          valid = false;
          break;
        }
        const ring = nativeRings.get(key);
        const candidate = preparedBoundary;
        const owned =
          lastDrawnOccurrenceKeys.has(key) ||
          (candidate?.status === 'ready' &&
            candidate.anchor === nativeAnchor &&
            candidate.generation === renderGeneration &&
            candidate.scope === scopeEpoch &&
            !candidate.abort.signal.aborted &&
            candidate.rings.get(key) === ring);
        const rate = fidelity.kind === 'effect' ? 1 : fidelity.rate;
        const tag = certifiedWindowIndex(
          contribution.source_time,
          timing ?? null
        );
        const size = outputSize();
        if (
          !ring ||
          ring.bundlePath !== path ||
          videos.get(key)?.element !== ring.videoElement ||
          !owned ||
          !timing ||
          timing.kind !== 'windows' ||
          tag === null ||
          ring.videoElement.playbackRate !== rate ||
          ring.hasLostContext() ||
          ring.slots.some(
            (slot) =>
              slot.canvas.width !== size.width ||
              slot.canvas.height !== size.height
          )
        ) {
          valid = false;
          break;
        }
        const windowEnd = timing.ends[tag];
        if (windowEnd === undefined) {
          valid = false;
          break;
        }
        const remaining =
          (windowEnd - decoderLocalSeconds(contribution.source_time)) / rate;
        if (!(remaining > 0)) {
          valid = false;
          break;
        }
        const packetEnd = addRationalTimes(cursor, {
          value: remaining * clock.rate,
          rate: clock.rate,
        });
        if (compareRationalTimes(packetEnd, end) < 0) end = packetEnd;
        let tags = requested.get(ring);
        if (!tags) {
          tags = new Set();
          requested.set(ring, tags);
        }
        tags.add(tag);
      }
      if (!valid || compareRationalTimes(end, cursor) <= 0) break;
      const intervalReservations: NativeSnapshotReservation[] = [];
      for (const [ring, tags] of requested) {
        const reservation = ring.reserveTags([...tags], ring.captureEpoch, {
          videoElement: ring.videoElement,
          bundlePath: ring.bundlePath,
          width: ownerSize.width,
          onInvalidated: () => {
            if (ownerRun && pcmRun === ownerRun && !ownerRun.stopped) {
              pcmProof('error', ownerRun.generation, {
                stage: 'visual',
                code: 'certified video reservation was invalidated',
              });
              failScheduledAudio('certified video reservation was invalidated');
            }
          },
          height: ownerSize.height,
        });
        if (!reservation) {
          valid = false;
          break;
        }
        intervalReservations.push(reservation);
      }
      const intervalLeases: PcmVisualInterval['images'] = [];
      if (valid) {
        for (const path of intervalImages) {
          const lease = images.reserve(path);
          if (!lease) {
            valid = false;
            break;
          }
          intervalLeases.push({ path, ...lease });
        }
      }
      if (!valid) {
        for (const reservation of intervalReservations) reservation.release();
        for (const lease of intervalLeases) lease.release();
        break;
      }
      intervals.push({
        end,
        reservations: intervalReservations,
        images: intervalLeases,
      });
      cursor = end;
    }
    return {
      through: cursor,
      intervals,
      isValid: () =>
        !released &&
        !isDisposed &&
        !graphicsLost &&
        !isCanvasContextLost(canvas) &&
        renderGeneration === ownerGeneration &&
        scopeEpoch === ownerScope &&
        nativeAnchor === ownerAnchor &&
        outputSize().width === ownerSize.width &&
        outputSize().height === ownerSize.height &&
        intervals.every(
          (interval) =>
            interval.reservations.every((reservation) =>
              reservation.isValid()
            ) && interval.images.every((lease) => lease.isValid())
        ),
      releaseThrough: (time) => {
        while (
          intervals.length &&
          compareRationalTimes(intervals[0]!.end, time) <= 0
        ) {
          const interval = intervals.shift()!;
          for (const reservation of interval.reservations)
            reservation.release();
          for (const lease of interval.images) lease.release();
        }
      },
      release: () => {
        if (released) return;
        released = true;
        for (const interval of intervals.splice(0)) {
          for (const reservation of interval.reservations)
            reservation.release();
          for (const lease of interval.images) lease.release();
        }
      },
    };
  }

  function cancelPreparedBoundary(): void {
    const candidate = preparedBoundary;
    if (!candidate) return;
    preparedBoundary = null;
    candidate.abort.abort();
    for (const [key, ring] of candidate.rings) {
      if (nativeRings.get(key) !== ring) continue;
      ring.videoElement.pause();
      decodedAt.delete(ring.videoElement);
      ring.release();
      nativeRings.delete(key);
    }
    for (const [key, audio] of candidate.audio) {
      if (
        audios.get(key) !== audio ||
        audio.element.getAttribute('data-active') === 'true'
      )
        continue;
      audio.element.pause();
      if (audio.gainNode) audio.gainNode.gain.value = 0;
      else audio.element.volume = 0;
    }
  }

  function prepareNextBoundary(): void {
    const anchor = nativeAnchor;
    if (!anchor || !nativeMode || !isPlaying || preparedBoundary) return;
    for (const boundary of playbackBoundaries) {
      if (compareRationalTimes(boundary.time, currentTime) <= 0) continue;
      const evaluation = scopedEvaluation(boundary.time);
      const tree = videoTree(evaluation);
      const blocked = blockedTracks(evaluation);
      const indices = getDrawnLeafIndices(
        tree,
        (id, ancestry) => videoHidden(id, ancestry) || blocked.has(id),
        true
      );
      const keys = collectVideoOccurrenceKeys(evaluation.video_contributions);
      const incoming = indices.flatMap((index) => {
        const contribution = evaluation.video_contributions[index];
        const key = keys[index];
        if (
          !contribution ||
          !key ||
          !contribution.bundle_path ||
          !inferMediaMimeType(contribution.bundle_path).startsWith('video/') ||
          lastDrawnOccurrenceKeys.has(key)
        )
          return [];
        return [{ contribution, key }];
      });
      const currentEvaluation = scopedEvaluation(currentTime);
      const previousAudio = new Set(
        collectAudioOccurrenceKeys(currentEvaluation.audio_contributions)
      );
      const currentTree = videoTree(currentEvaluation);
      const currentBlocked = blockedTracks(currentEvaluation);
      const currentImages = new Set(
        getDrawnLeafIndices(
          currentTree,
          (id, ancestry) => videoHidden(id, ancestry) || currentBlocked.has(id)
        ).map(
          (index) => currentEvaluation.video_contributions[index]?.bundle_path
        )
      );
      const audioKeys = collectAudioOccurrenceKeys(
        evaluation.audio_contributions
      );
      const incomingAudio =
        audioBackend === 'pcm'
          ? []
          : evaluation.audio_contributions.flatMap((contribution, index) => {
              const key = audioKeys[index];
              if (
                !key ||
                previousAudio.has(key) ||
                !trackAudible(contribution.track_id)
              )
                return [];
              return [{ contribution, key }];
            });
      const incomingImages = new Set<OtioBundleEntryName>();
      for (const index of indices) {
        const path = evaluation.video_contributions[index]?.bundle_path;
        if (
          path &&
          inferMediaMimeType(path).startsWith('image/') &&
          !currentImages.has(path)
        )
          incomingImages.add(path);
      }
      if (
        incoming.length === 0 &&
        incomingAudio.length === 0 &&
        incomingImages.size === 0
      )
        continue;
      if (incoming.some(({ key }) => hiddenWarmInFlight.has(key))) return;
      if (previewBlocked(evaluation)) return;
      const candidate: BoundaryPreparation = {
        at: boundary.time,
        keys: new Set(incoming.map((item) => item.key)),
        generation: renderGeneration,
        scope: scopeEpoch,
        anchor,
        abort: new AbortController(),
        status: 'preparing',
        rings: new Map(),
        audioKeys: new Set(incomingAudio.map((item) => item.key)),
        audio: new Map(),
        imagePaths: new Set(incomingImages),
      };
      preparedBoundary = candidate;
      for (const path of incomingImages) images.pin(path);
      const valid = (): boolean =>
        preparedBoundary === candidate &&
        !candidate.abort.signal.aborted &&
        !isDisposed &&
        isPlaying &&
        nativeMode &&
        renderGeneration === candidate.generation &&
        scopeEpoch === candidate.scope &&
        nativeAnchor === candidate.anchor;
      const fail = (): void => {
        if (preparedBoundary !== candidate) return;
        candidate.status = 'failed';
        pcmProof('boundary-failed', pcmGeneration, { at: candidate.at });
        pcmRecoveryWake?.();
        candidate.abort.abort();
        for (const [key, ring] of candidate.rings) {
          if (nativeRings.get(key) !== ring) continue;
          ring.videoElement.pause();
          ring.release();
          nativeRings.delete(key);
        }
        for (const [key, audio] of candidate.audio) {
          if (
            audios.get(key) !== audio ||
            audio.element.getAttribute('data-active') === 'true'
          )
            continue;
          audio.element.pause();
          if (audio.gainNode) audio.gainNode.gain.value = 0;
          else audio.element.volume = 0;
        }
        candidate.audio.clear();
        candidate.rings.clear();
      };
      const bounded = async <T>(
        promise: Promise<T>,
        ms: number
      ): Promise<T> => {
        const interruption = Promise.withResolvers<never>();
        const timer = setTimeout(
          () => interruption.reject(new Error('boundary-timeout')),
          ms
        );
        const abort = () =>
          interruption.reject(new Error('boundary-cancelled'));
        candidate.abort.signal.addEventListener('abort', abort, { once: true });
        try {
          return await Promise.race([promise, interruption.promise]);
        } finally {
          clearTimeout(timer);
          candidate.abort.signal.removeEventListener('abort', abort);
        }
      };
      const starts: Promise<void>[] = [];
      const prepareOne = async ({
        contribution,
        key,
      }: (typeof incoming)[number]): Promise<void> => {
        const path = contribution.bundle_path!;
        const node = doc.nodes[contribution.node_id];
        const map = node && otioSamplingMap(node);
        const fidelity = effectFidelity(
          contribution.active_effects,
          contribution.node_id
        );
        if (
          !map ||
          fidelity.kind !== 'ok' ||
          map.scalar !== fidelity.rate ||
          sampleUnavailable(doc, contribution) ||
          (node?.active_media_reference_key &&
            node.media_references?.[node.active_media_reference_key]?.schema ===
              'ImageSequenceReference.1') ||
          nativeIneligiblePaths.has(path) ||
          nativeRings.has(key)
        )
          return fail();
        try {
          const video = await bounded(
            acquireVideo(key, path, candidate.generation),
            3000
          );
          if (
            !valid() ||
            !video ||
            videos.get(key) !== video ||
            lastDrawnOccurrenceKeys.has(key)
          )
            return fail();
          const timing = await bounded(
            sharedVideoTiming(path, inferMediaMimeType(path)),
            3000
          );
          if (
            !valid() ||
            !timing ||
            timing.kind !== 'windows' ||
            !checkNativeTimingEligibility(
              timing,
              fidelity.rate,
              vsyncTracker.medianSeconds
            ) ||
            typeof VideoFrame !== 'function' ||
            typeof (video.element as HTMLVideoElementWithRvfc)
              .requestVideoFrameCallback !== 'function' ||
            !applyRate(video.element, fidelity.rate)
          )
            return fail();
          const tag = certifiedWindowIndex(contribution.source_time, timing);
          const midpoint = videoDecoderTime(contribution.source_time, timing);
          if (tag === null || midpoint === null) return fail();
          if (nativeRings.has(key) || lastDrawnOccurrenceKeys.has(key))
            return fail();
          const ring = getOrCreateNativeRing(key, video.element, path);
          candidate.rings.set(key, ring);
          const { width, height } = outputSize();
          if (!ring.allocate(width, height)) return fail();
          ring.resetEpoch(ring.captureEpoch + 1);
          if (
            !(await bounded(
              seekElement(
                video.element,
                midpoint,
                candidate.generation,
                candidate.abort.signal
              ),
              1000
            )) ||
            !valid()
          )
            return fail();
          const presentDeadline =
            presentClockMs() + OTIO_PAUSED_PRESENT_TIMEOUT_MS;
          while (!ring.capturePausedFrame(tag, ring.captureEpoch, timing)) {
            if (!valid() || presentClockMs() >= presentDeadline) return fail();
            await bounded(
              nextPresentation(video.element, OTIO_PAUSED_PRESENT_POLL_MS),
              Math.max(1, presentDeadline - presentClockMs())
            );
          }
          if (!valid()) return fail();
          if (timing.starts[tag + 1] === undefined) {
            const exposure =
              node?.visible_timeline_range ?? node?.timeline_range;
            if (!exposure) return fail();
            const end = addRationalTimes(
              exposure.start_time,
              exposure.duration
            );
            const exposedEnd =
              compareRationalTimes(end, scopeEnd()) < 0 ? end : scopeEnd();
            const remaining =
              exposedEnd.value / exposedEnd.rate -
              boundary.time.value / boundary.time.rate;
            const sourceEnd =
              decoderLocalSeconds(contribution.source_time) +
              remaining * fidelity.rate;
            const windowEnd = timing.ends[tag];
            if (
              remaining <= 0 ||
              windowEnd === undefined ||
              sourceEnd > windowEnd
            )
              return fail();
            return;
          }
          const vsync = vsyncTracker.medianSeconds;
          const wMin = minWindowDuration(timing, fidelity.rate);
          const lead = wMin + vsync / 2;
          const sB = decoderLocalSeconds(contribution.source_time);
          const boundaryWall =
            anchor.wallMs +
            1000 *
              (boundary.time.value / boundary.time.rate -
                anchor.time.value / anchor.time.rate);
          starts.push(
            (async () => {
              try {
                const requestWall =
                  boundaryWall +
                  1000 * ((midpoint - sB) / fidelity.rate - lead);
                const delay = Math.max(0, requestWall - presentClockMs());
                const wait = Promise.withResolvers<void>();
                const waitTimer = setTimeout(wait.resolve, delay);
                try {
                  await bounded(wait.promise, delay + 1000);
                } finally {
                  clearTimeout(waitTimer);
                }
                if (!valid()) return fail();
                ring.isStarting = true;
                ring.startupFirstAdvancedTag = tag + 1;
                const advanced = Promise.withResolvers<{
                  now: number;
                  tag: number;
                }>();
                ring.startupWaiter = advanced;
                const playing = video.element.play();
                ring.startCallbacks(timing, fidelity.rate, () => {
                  nativeIneligiblePaths.add(path);
                  if (preparedBoundary === candidate) fail();
                  else if (nativeRings.get(key) === ring && isPlaying) {
                    if (audioBackend === 'pcm')
                      failScheduledAudio(
                        'video decoder lost certified progress'
                      );
                    else void startSequence(currentTime, true);
                  }
                });
                const [sample] = await bounded(
                  Promise.all([advanced.promise, playing]),
                  Math.max(
                    500,
                    4 * maxWindowDuration(timing, fidelity.rate) * 1000
                  )
                );
                if (!valid() || nativeRings.get(key) !== ring) return fail();
                const sampleStart = timing.starts[sample.tag];
                if (sampleStart === undefined) return fail();
                const preferred =
                  sample.now +
                  1000 * (lead - (sampleStart - sB) / fidelity.rate);
                if (
                  Math.abs(boundaryWall - preferred) >
                  1000 * (wMin - vsync / 2)
                )
                  return fail();
                ring.isStarting = false;
              } catch {
                fail();
              }
            })()
          );
        } catch {
          fail();
        }
      };
      const prepareAudio = async ({
        contribution,
        key,
      }: (typeof incomingAudio)[number]): Promise<void> => {
        const path = contribution.bundle_path;
        const node = doc.nodes[contribution.node_id];
        const map = node && otioSamplingMap(node);
        const fidelity = effectFidelity(
          contribution.active_effects,
          contribution.node_id
        );
        if (
          !path ||
          !map ||
          fidelity.kind !== 'ok' ||
          map.scalar !== fidelity.rate ||
          sampleUnavailable(doc, contribution)
        )
          return fail();
        try {
          const audio = await bounded(
            acquireAudio(
              key,
              path,
              contribution.track_id,
              candidate.generation
            ),
            3000
          );
          if (
            !valid() ||
            !audio ||
            audio.failed ||
            audios.get(key) !== audio ||
            audio.element.getAttribute('data-active') === 'true'
          )
            return fail();
          candidate.audio.set(key, audio);
          if (audio.gainNode) audio.gainNode.gain.value = 0;
          else audio.element.volume = 0;
          if (!applyRate(audio.element, fidelity.rate)) return fail();
          if (
            !(await bounded(
              seekElement(
                audio.element,
                decoderLocalSeconds(contribution.source_time),
                candidate.generation,
                candidate.abort.signal
              ),
              1000
            )) ||
            !valid()
          )
            return fail();
          const boundaryWall =
            anchor.wallMs +
            1000 *
              (boundary.time.value / boundary.time.rate -
                anchor.time.value / anchor.time.rate);
          const delay = Math.max(
            0,
            boundaryWall - 1000 / clock.rate - presentClockMs()
          );
          starts.push(
            (async () => {
              try {
                const wait = Promise.withResolvers<void>();
                const timer = setTimeout(wait.resolve, delay);
                try {
                  await bounded(wait.promise, delay + 1000);
                } finally {
                  clearTimeout(timer);
                }
                if (!valid()) return fail();
                await bounded(audio.element.play(), 1000);
                if (!valid() || audios.get(key) !== audio) return fail();
              } catch {
                fail();
              }
            })()
          );
        } catch {
          fail();
        }
      };
      const jobs = [
        ...[...incomingImages].map((path) => async () => {
          try {
            const image = await bounded(
              acquireImage(path, candidate.generation, valid),
              3000
            );
            if (!valid() || !image || imageElements.get(path) !== image) fail();
          } catch {
            fail();
          }
        }),
        ...incomingAudio.map((item) => () => prepareAudio(item)),
        ...incoming.map((item) => () => prepareOne(item)),
      ];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (valid()) {
          const job = jobs[next++];
          if (!job) return;
          await job();
        }
      };
      void Promise.all([worker(), worker()])
        .then(() => Promise.all(starts))
        .then(() => {
          if (valid()) {
            candidate.status = 'ready';
            pcmProof('boundary-ready', pcmGeneration, { at: candidate.at });
            pcmRecoveryWake?.();
          }
        });
      return;
    }
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
    if (audioBackend === 'pcm' && (pcmRun || pcmPlayIntent))
      failScheduledAudio('pooled graphics context lost');
    else stopPcm('context');
    cancelPreparedBoundary();
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
    if (audioBackend === 'pcm' && (pcmRun || pcmPlayIntent))
      failScheduledAudio('visible graphics context lost');
    else stopPcm('context');
    cancelPreparedBoundary();
    hideVisibleCanvas();
    graphicsLost = true;
    isNativeHolding = false;
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
    nativeLastPresentMs = null;
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
  let pcmRouteVersion = 0;
  let observedAudioContext: AudioContext | null = null;
  const onPcmSinkChange = () => {
    pcmRouteVersion++;
    if (audioBackend === 'pcm' && (pcmRun || pcmPlayIntent))
      failScheduledAudio('audio output route changed');
  };
  const onPcmContextChange = () => {
    if (audioContext?.state === 'running') return;
    pcmRouteVersion++;
    if (audioBackend === 'pcm' && !pcmRun && pcmPlayIntent)
      failScheduledAudio('audio context interrupted during recovery');
  };
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
    if (
      audioContext &&
      observedAudioContext !== audioContext &&
      typeof audioContext.addEventListener === 'function'
    ) {
      observedAudioContext?.removeEventListener('sinkchange', onPcmSinkChange);
      observedAudioContext?.removeEventListener(
        'statechange',
        onPcmContextChange
      );
      audioContext.addEventListener('sinkchange', onPcmSinkChange);
      audioContext.addEventListener('statechange', onPcmContextChange);
      observedAudioContext = audioContext;
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

  function blockedTracks(evaluation: OtioEvaluationResult): Set<string> {
    const blocked = new Set<string>();
    if (baseMediaPreviewAllowed) return blocked;
    for (const transition of evaluation.active_transitions) {
      if (transition.render_kind === 'opaque') blocked.add(transition.track_id);
    }
    return blocked;
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
    }
    for (const contrib of result.audio_contributions) {
      push(effectFidelity(contrib.active_effects, contrib.node_id).diagnostic);
    }
    for (const transition of result.active_transitions) {
      if (transition.render_kind !== 'opaque') continue;
      const node = doc.nodes[transition.node_id];
      push(
        diagnostic(
          'warning',
          'unsupported-effect',
          `Unsupported transition: ${node?.transition_type || 'unknown'}`,
          transition.node_id
        )
      );
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
    const evaluation = result ?? scopedEvaluation(currentTime);
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

  function pcmInitialDemand(
    admission: PcmAdmission,
    start: number
  ): { nodes: number; bytes: number; streams: number } {
    const end = Math.min(
      Math.floor((scopeEnd().value * admission.rate) / scopeEnd().rate),
      start + Math.floor(admission.rate * OTIO_PCM_TARGET_LEAD_SECONDS)
    );
    const tracks = new Set<string>();
    const streams = new Set<OtioBundleEntryName>();
    let nodes = 2;
    let bytes = OTIO_PCM_PULL_SCRATCH_BYTES;
    let largestBlock = 0;
    for (const { span, lattice } of admission.spans) {
      const frames = Math.max(
        0,
        Math.min(end, lattice.timeline_end) -
          Math.max(start, lattice.timeline_start)
      );
      if (!frames || !span.bundle_path) continue;
      tracks.add(span.track_id);
      streams.add(span.bundle_path);
      nodes += 1 + span.gain_factors.length;
      const asset = admission.assets.get(span.bundle_path);
      if (!asset) throw new Error('PCM admitted asset is unavailable');
      const channels = asset.header.channels;
      bytes += frames * channels * 4;
      largestBlock = Math.max(largestBlock, frames * channels * 4);
    }
    return {
      nodes: nodes + tracks.size,
      bytes: bytes + largestBlock,
      streams: streams.size,
    };
  }

  async function admitPcmScope(context: AudioContext): Promise<PcmSelection> {
    const rate = context.sampleRate;
    if (
      (rate !== 44100 && rate !== 48000) ||
      typeof context.getOutputTimestamp !== 'function' ||
      typeof context.audioWorklet?.addModule !== 'function' ||
      typeof AudioWorkletNode === 'undefined' ||
      typeof Worker === 'undefined'
    )
      return {
        kind: 'native',
        reason:
          'the PCM output clock, sample rate, worker, or transport worklet is unavailable',
      };
    if (
      graphicsLost ||
      isCanvasContextLost(canvas) ||
      !canvas.getContext('2d')
    ) {
      return { kind: 'native', reason: 'compositor context is unavailable' };
    }
    const selectedNodes = scope ? scopeNodes : new Set<string>();
    if (!scope) {
      const pending = [timelineId];
      while (pending.length) {
        const id = pending.pop()!;
        if (selectedNodes.has(id)) continue;
        selectedNodes.add(id);
        const node = doc.nodes[id];
        if (node) pending.push(...node.children_ids);
      }
    }
    const cursor = Math.round((currentTime.value * rate) / currentTime.rate);
    if (
      !Number.isSafeInteger(cursor) ||
      compareRationalTimes(currentTime, { value: cursor, rate }) !== 0
    ) {
      return {
        kind: 'native',
        reason: 'requested position is not on the audio sample lattice',
      };
    }
    for (const node of Object.values(doc.nodes)) {
      if (!selectedNodes.has(node.id)) continue;
      const sequence =
        node.active_media_reference_key &&
        node.media_references?.[node.active_media_reference_key]?.schema ===
          'ImageSequenceReference.1';
      const freeze = node.effects?.some(
        (effect) => effect.enabled && isFreeze(effect)
      );
      if (sequence || freeze)
        return {
          kind: 'native',
          reason: 'scope contains a sequence or freeze requiring native timing',
        };
    }
    const range = scope?.range ?? {
      start_time: { value: 0, rate: clock.rate },
      duration: clock.duration,
    };
    const planned = audioScheduleForOtioRange(doc, timelineId, range);
    const spans: PcmSpan[] = [];
    const assets = new Map<OtioBundleEntryName, PcmAsset>();
    for (const span of planned) {
      if (
        scope &&
        !scopeNodes.has(span.node_id) &&
        span.node_id !== scope.nodeId
      )
        continue;
      if (span.disposition === 'silence') continue;
      if (span.disposition !== 'media' || !span.bundle_path)
        return {
          kind: 'native',
          reason: 'audio contains unavailable or unsupported media',
        };
      const lattice = otioAudioSampleLattice(span, rate);
      if (!lattice.eligible) return { kind: 'native', reason: lattice.reason };
      let asset = assets.get(span.bundle_path);
      if (!asset) {
        const blob = await sharedBlob(span.bundle_path);
        if (!blob)
          return {
            kind: 'native',
            reason: 'local audio bytes are unavailable',
          };
        try {
          const header = await preflightWavePcm(blob);
          if (header.sampleRate !== rate)
            return {
              kind: 'native',
              reason: 'sample-rate conversion is required',
            };
          asset = { blob, header };
          assets.set(span.bundle_path, asset);
        } catch {
          return {
            kind: 'native',
            reason: 'audio format is not supported by scheduled PCM',
          };
        }
      }
      if (lattice.source_end > asset.header.totalFrames)
        return {
          kind: 'native',
          reason: 'audio source exceeds certified WAV extent',
        };
      spans.push({ span, lattice });
    }
    if (!spans.length)
      return { kind: 'native', reason: 'scope has no scheduled audio voices' };
    const scopeEndTime = addRationalTimes(range.start_time, range.duration);
    const probes = [
      range.start_time,
      ...otioPlaybackBoundaries(doc, timelineId, range)
        .map((boundary) => boundary.time)
        .filter((time) => compareRationalTimes(time, scopeEndTime) < 0),
    ];
    const checkedVideo = new Set<string>();
    for (const time of probes) {
      for (const contribution of scopedEvaluation(time).video_contributions) {
        if (sampleKind(contribution) === 'black') continue;
        const path = contribution.bundle_path;
        if (!path || sampleUnavailable(doc, contribution))
          return { kind: 'native', reason: 'video media is unavailable' };
        const mime = inferMediaMimeType(path);
        if (mime.startsWith('image/')) continue;
        if (
          !mime.startsWith('video/') ||
          typeof VideoFrame !== 'function' ||
          typeof HTMLVideoElement === 'undefined' ||
          typeof HTMLVideoElement.prototype.requestVideoFrameCallback !==
            'function'
        )
          return {
            kind: 'native',
            reason: 'certified video capture is unavailable',
          };
        const fidelity = effectFidelity(
          contribution.active_effects,
          contribution.node_id
        );
        if (
          fidelity.kind === 'freeze' ||
          fidelity.kind === 'rate' ||
          (fidelity.kind === 'effect' && !baseMediaPreviewAllowed)
        )
          return {
            kind: 'native',
            reason: 'video timing requires native playback',
          };
        const videoRate = fidelity.kind === 'effect' ? 1 : fidelity.rate;
        const key = `${path}\u0000${videoRate}`;
        if (checkedVideo.has(key)) continue;
        const timing = await sharedVideoTiming(path, mime);
        if (
          !timing ||
          timing.kind !== 'windows' ||
          !checkNativeTimingEligibility(
            timing,
            videoRate,
            vsyncTracker.medianSeconds
          )
        )
          return { kind: 'native', reason: 'video timing cannot be certified' };
        checkedVideo.add(key);
      }
    }
    const events = spans.flatMap(({ span, lattice }) => [
      { at: lattice.timeline_start, end: false, occurrence: span.occurrence },
      { at: lattice.timeline_end, end: true, occurrence: span.occurrence },
    ]);
    events.sort((a, b) => a.at - b.at || Number(b.end) - Number(a.end));
    const active = new Map<string, number>();
    for (const event of events) {
      const count = active.get(event.occurrence) ?? 0;
      if (event.end) {
        if (count <= 1) active.delete(event.occurrence);
        else active.set(event.occurrence, count - 1);
      } else {
        active.set(event.occurrence, count + 1);
        if (active.size > 8)
          return {
            kind: 'native',
            reason: 'scope exceeds the simultaneous audio voice limit',
          };
      }
    }
    // Reject only demand that is intrinsic to the scope or the actual initial
    // batch. Later node retirement is governed by real ended callbacks and the
    // shared budget, not by an assumed callback-latency bound.
    const streamEvents = spans
      .flatMap(({ span, lattice }) => [
        {
          at: lattice.timeline_start,
          delta: 1,
          path: span.bundle_path!,
        },
        { at: lattice.timeline_end, delta: -1, path: span.bundle_path! },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    const streamUse = new Map<OtioBundleEntryName, number>();
    for (const event of streamEvents) {
      const count = (streamUse.get(event.path) ?? 0) + event.delta;
      if (count) streamUse.set(event.path, count);
      else streamUse.delete(event.path);
      if (streamUse.size > OTIO_PCM_MAX_STREAMS)
        return {
          kind: 'native',
          reason: 'simultaneous audio exceeds the stream budget',
        };
    }
    const trackNodes = new Set(spans.map(({ span }) => span.track_id)).size;
    if (trackNodes + 2 > OTIO_PCM_MAX_NODES)
      return { kind: 'native', reason: 'audio tracks exceed the graph budget' };
    const nodeEvents = spans
      .flatMap(({ span, lattice }) => [
        { at: lattice.timeline_start, delta: 1 + span.gain_factors.length },
        { at: lattice.timeline_end, delta: -(1 + span.gain_factors.length) },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let simultaneousNodes = 2;
    for (const event of nodeEvents) {
      simultaneousNodes += event.delta;
      if (simultaneousNodes > OTIO_PCM_MAX_NODES)
        return {
          kind: 'native',
          reason: 'simultaneous audio exceeds the graph budget',
        };
    }
    const admission = { rate, spans, assets };
    const initial = pcmInitialDemand(admission, cursor);
    if (
      initial.nodes > OTIO_PCM_MAX_NODES ||
      initial.bytes > OTIO_PCM_MAX_BYTES ||
      initial.streams > OTIO_PCM_MAX_STREAMS
    )
      return {
        kind: 'native',
        reason: 'initial audio exceeds the resource budget',
      };
    return { kind: 'pcm', admission };
  }

  function stopPcm(reason: string): void {
    const run = pcmRun;
    if (!run) return;
    pcmRun = null;
    run.stopped = true;
    clearTimeout(run.stopWatchdog ?? undefined);
    pcmGeneration++;
    run.context.removeEventListener('statechange', run.onContextState);
    pcmProof('cancel', run.generation, { reason });
    let retirementStarted = false;
    let retirementTimer: ReturnType<typeof setTimeout> | undefined;
    const retireGate = () => {
      if (retirementStarted) return;
      retirementStarted = true;
      clearTimeout(retirementTimer);
      pcmGateRetirements.retire(run.gate, run.releaseGateCredit);
    };
    retirementTimer = setTimeout(retireGate, 100);
    if (run.context.state !== 'running') retireGate();
    void run.gate
      .abort(run.generation)
      .then((ack) => {
        if (
          !ack.accepted ||
          ack.closedFrame === null ||
          run.contextFrame === null
        )
          return;
        pcmProof('gate-close', run.generation, {
          reason: 'abort',
          contextStopFrame: ack.closedFrame,
          compositionStop: {
            value: run.startFrame + ack.closedFrame - run.contextFrame,
            rate: run.admission.rate,
          },
        });
      })
      .catch(() => undefined)
      .finally(retireGate);
    run.scheduler.dispose();
    for (const hold of run.holds) hold.release();
    for (const chunk of run.chunks) chunk.prepared.cancel();
    run.chunks.length = 0;
    run.provider.dispose();
    for (const node of run.tracks.values()) {
      node.disconnect();
      pcmBudget.releaseNodes(1);
    }
  }

  function pcmTrack(run: PcmRun, trackId: string): GainNode {
    const existing = run.tracks.get(trackId);
    if (existing) return existing;
    pcmBudget.reserveNodes(1);
    try {
      const track = run.context.createGain();
      track.gain.value = trackAudible(trackId) ? 1 : 0;
      track.connect(run.gate.node);
      run.tracks.set(trackId, track);
      return track;
    } catch (error) {
      pcmBudget.releaseNodes(1);
      throw error;
    }
  }

  async function fillPcm(
    run: PcmRun,
    target: number,
    blockLimit = OTIO_PCM_PACKET_FRAMES
  ): Promise<void> {
    if (run.stopping || run.stopped)
      throw new Error('PCM generation is draining');
    if (run.loading) return run.loading;
    const work = (async () => {
      const from = run.preparedThrough;
      if (target <= from) return;
      const pending: PcmChunk[] = [];
      try {
        const needed = new Set<OtioBundleEntryName>();
        for (const plan of run.admission.spans) {
          if (
            plan.lattice.timeline_end > from &&
            plan.lattice.timeline_start < target &&
            plan.span.bundle_path
          )
            needed.add(plan.span.bundle_path);
        }
        if (needed.size > OTIO_PCM_MAX_STREAMS)
          throw new Error('PCM stream budget exceeded');
        for (const [path, streamId] of run.streams) {
          if (!needed.has(path)) {
            run.provider.cancel(streamId);
            run.streams.delete(path);
          }
        }
        for (const plan of run.admission.spans) {
          const path = plan.span.bundle_path;
          if (!path) continue;
          const start = Math.max(from, plan.lattice.timeline_start);
          const end = Math.min(target, plan.lattice.timeline_end);
          if (end <= start) continue;
          let streamId = run.streams.get(path);
          if (!streamId) {
            const asset = run.admission.assets.get(path);
            if (!asset || run.stopped) throw new Error('PCM asset unavailable');
            streamId = `stream-${run.streams.size}-${run.generation}-${run.preparedThrough}`;
            await run.provider.open(streamId, asset.blob, asset.header);
            if (run.stopped || run.stopping)
              throw new Error('PCM generation cancelled');
            run.streams.set(path, streamId);
          }
          for (let frame = start; frame < end; ) {
            const count = Math.min(blockLimit, end - frame);
            const source =
              plan.lattice.source_start + frame - plan.lattice.timeline_start;
            const block = await run.provider.pull(streamId, source, count);
            if (run.stopped || run.stopping) {
              run.provider.release(block.planes);
              throw new Error('PCM generation cancelled');
            }
            try {
              const prepared = run.scheduler.prepare({
                generation: run.generation,
                planes: block.planes,
                gainFactorCount: plan.span.gain_factors.length,
                destination: pcmTrack(run, plan.span.track_id),
              });
              pending.push({
                plan,
                timelineStart: frame,
                sourceStart: source,
                prepared,
                count,
              });
            } finally {
              run.provider.release(block.planes);
            }
            frame += count;
          }
        }
        if (run.stopped || run.stopping)
          throw new Error('PCM generation cancelled');
        run.chunks.push(...pending);
        pending.length = 0;
        run.preparedThrough = target;
      } finally {
        for (const chunk of pending) chunk.prepared.cancel();
      }
    })();
    run.loading = work;
    try {
      await work;
    } finally {
      if (run.loading === work) run.loading = null;
    }
  }

  async function preparePcmRun(
    context: AudioContext,
    admission: PcmAdmission,
    start: OtioRationalTime,
    inheritedClock?: OutputClock
  ): Promise<PcmRun> {
    const rate = admission.rate;
    const frame = Math.round((start.value * rate) / start.rate);
    if (
      !Number.isSafeInteger(frame) ||
      compareRationalTimes(start, { value: frame, rate }) !== 0
    )
      throw new Error('fractional PCM start');
    if (!masterGain) throw new Error('audio graph unavailable');
    const destination = masterGain;
    const preparationGeneration = renderGeneration;
    const generation = ++pcmGeneration;
    const budget = pcmBudget;
    // Reserve before construction: a timed-out or failed constructor must not
    // leave an unaccounted worklet that may still be alive.
    const releaseGateCredit = pcmGateRetirements.reserve();
    let gate: OtioTransportGate;
    try {
      gate = await createOtioTransportGate(
        context,
        (ack) => onPcmGateClosed(ack),
        (error) => {
          if (pcmRun?.generation !== generation || pcmRun.stopped) return;
          pcmProof('error', generation, {
            stage: 'gate',
            code:
              error instanceof OtioGateRenderClockError
                ? 'render-clock-discontinuity'
                : error.message,
            ...(error instanceof OtioGateRenderClockError
              ? {
                  expectedFrame: error.expectedFrame,
                  observedFrame: error.observedFrame,
                }
              : {}),
          });
          failScheduledAudio(`transport gate failed: ${error.message}`);
        }
      );
    } catch (error) {
      if (error instanceof OtioGateModuleLoadError) releaseGateCredit();
      throw error;
    }
    if (
      isDisposed ||
      !isPlaying ||
      generation !== pcmGeneration ||
      renderGeneration !== preparationGeneration
    ) {
      pcmGateRetirements.retire(gate, releaseGateCredit);
      throw new Error('PCM generation cancelled');
    }
    let provider: OtioPcmProvider | undefined;
    try {
      provider = new OtioPcmProvider(generation, budget);
      gate.node.connect(destination);
    } catch (error) {
      provider?.dispose();
      pcmGateRetirements.retire(gate, releaseGateCredit);
      throw error;
    }
    const scheduler = new OtioPcmScheduler(
      context,
      gate.node,
      generation,
      budget
    );
    const run: PcmRun = {
      generation,
      context,
      routeVersion: pcmRouteVersion,
      admission,
      provider,
      scheduler,
      gate,
      releaseGateCredit,
      outputClock: inheritedClock ?? new OutputClock(pcmRequestWall),
      clockCalibration: null,
      tracks: new Map(),
      streams: new Map(),
      chunks: [],
      startFrame: frame,
      startTime: start,
      preparedThrough: frame,
      scheduledThrough: frame,
      contextFrame: null,
      phaseSamples: [],
      frontierFrame: null,
      frontierCrossedAt: null,
      bridge: null,
      holds: [],
      loading: null,
      stopping: false,
      stopWatchdog: null,
      command: null,
      closeReason: 'frontier',
      onContextState: () => {
        if (pcmRun?.generation === generation && context.state !== 'running') {
          pcmProof('error', generation, {
            stage: 'clock',
            code: 'context-not-running',
          });
          failScheduledAudio('audio context interrupted');
        }
      },
      stopped: false,
    };
    pcmRun = run;
    context.addEventListener('statechange', run.onContextState);
    run.clockCalibration = calibratePcmClock(run);
    const end = Math.floor((scopeEnd().value * rate) / scopeEnd().rate);
    await fillPcm(
      run,
      Math.min(end, frame + Math.floor(rate * OTIO_PCM_TARGET_LEAD_SECONDS)),
      Math.floor(rate * OTIO_PCM_TARGET_LEAD_SECONDS)
    );
    if (run.stopped) throw new Error('PCM generation cancelled');
    return run;
  }

  function schedulePreparedPcm(run: PcmRun): void {
    if (run.contextFrame === null) throw new Error('PCM epoch not established');
    const rate = run.admission.rate;
    const maxFrame = Math.floor(
      (run.context.currentTime + OTIO_PCM_MAX_HORIZON_SECONDS) * rate
    );
    for (let index = 0; index < run.chunks.length; ) {
      const chunk = run.chunks[index]!;
      const first = run.contextFrame + chunk.timelineStart - run.startFrame;
      const count = chunk.count;
      if (first + count > maxFrame) {
        index++;
        continue;
      }
      const gainFactors: OtioPcmGainFactor[] = chunk.plan.span.gain_factors.map(
        (factor) => {
          const start = rescaleTime(factor.range.start_time, rate).value;
          const end = rescaleTime(
            addRationalTimes(factor.range.start_time, factor.range.duration),
            rate
          ).value;
          return {
            startFrame: run.contextFrame! + start - run.startFrame,
            endFrame: run.contextFrame! + end - run.startFrame,
            startGain: factor.direction === 'in' ? 0 : 1,
            endGain: factor.direction === 'in' ? 1 : 0,
          };
        }
      );
      try {
        chunk.prepared.start(first, gainFactors);
        pcmProof('scheduled', run.generation, {
          occurrenceId: chunk.plan.span.occurrence,
          trackId: chunk.plan.span.track_id,
          sourceStartFrame: chunk.sourceStart,
          sourceEndFrame: chunk.sourceStart + count,
          contextStartFrame: first,
          contextEndFrame: first + count,
          sampleRate: rate,
        });
      } finally {
        run.chunks.splice(index, 1);
      }
    }
    const earliestPending = run.chunks.reduce(
      (min, chunk) => Math.min(min, chunk.timelineStart),
      run.preparedThrough
    );
    run.scheduledThrough = Math.max(run.scheduledThrough, earliestPending);
  }

  function paintRetainedPcmAt(time: OtioRationalTime): boolean {
    const evaluation = scopedEvaluation(time);
    const tree = videoTree(evaluation);
    if (!tree && evaluation.video_contributions.length) return false;
    const keys = collectVideoOccurrenceKeys(evaluation.video_contributions);
    const leaves: (OtioPreparedLeaf | null)[] =
      evaluation.video_contributions.map((contribution, index) => {
        if (sampleKind(contribution) === 'black') return { kind: 'black' };
        const path = contribution.bundle_path;
        if (!path || sampleUnavailable(doc, contribution)) return null;
        const mime = inferMediaMimeType(path);
        if (mime.startsWith('image/')) {
          const image = imageElements.get(path);
          return image
            ? {
                kind: 'image',
                source: image.element,
                alpha: contribution.alpha,
              }
            : null;
        }
        if (!mime.startsWith('video/')) return null;
        const key = keys[index];
        const ring = key ? nativeRings.get(key) : undefined;
        const timing = videoTimingCache.get(path);
        const tag = certifiedWindowIndex(
          contribution.source_time,
          timing ?? null
        );
        const slot =
          ring && tag !== null
            ? ring.findSlotWithTag(tag, ring.captureEpoch)
            : null;
        return slot
          ? { kind: 'image', source: slot.canvas, alpha: contribution.alpha }
          : null;
      });
    return paint(evaluation, tree, leaves);
  }

  function onPcmGateClosed(ack: OtioGateAck): void {
    const run = pcmRun;
    if (
      !run ||
      run.generation !== ack.generation ||
      run.stopped ||
      ack.closedFrame === null ||
      run.contextFrame === null
    )
      return;
    clearTimeout(run.stopWatchdog ?? undefined);
    run.stopWatchdog = null;
    run.stopping = true;
    const closedFrame = ack.closedFrame;
    run.provider.dispose();
    const compositionStop = {
      value: run.startFrame + ack.closedFrame - run.contextFrame,
      rate: run.admission.rate,
    };
    pcmProof('gate-close', run.generation, {
      reason: run.closeReason,
      contextStopFrame: ack.closedFrame,
      compositionStop,
    });
    void (async () => {
      const deadline = presentClockMs() + 1000;
      while (pcmRun === run && !run.stopped && !isDisposed) {
        if (run.context.state !== 'running') {
          failScheduledAudio('audio context interrupted during drain');
          return;
        }
        const readBegin = presentClockMs();
        const contextBefore = run.context.currentTime;
        let stamp: AudioTimestamp | null = null;
        try {
          stamp = run.context.getOutputTimestamp();
        } catch {}
        const contextAfter = run.context.currentTime;
        const readEnd = presentClockMs();
        const result = run.outputClock.observe({
          readBegin,
          readEnd,
          contextBefore,
          contextAfter,
          state: run.context.state,
          contextTime: stamp?.contextTime,
          performanceTime: stamp?.performanceTime,
        });
        if (
          !stamp ||
          result.status === 'failed' ||
          typeof stamp.contextTime !== 'number' ||
          !Number.isFinite(stamp.contextTime) ||
          typeof stamp.performanceTime !== 'number' ||
          !Number.isFinite(stamp.performanceTime) ||
          result.status === 'interrupted'
        ) {
          failScheduledAudio(
            `audio output clock interrupted during drain: ${result.reason}`
          );
          return;
        }
        if (stamp.contextTime * run.admission.rate >= closedFrame) {
          const ended = compareRationalTimes(compositionStop, scopeEnd()) >= 0;
          const settledTime = ended ? scopeLastSample() : compositionStop;
          if (ended || !pcmPlayIntent) {
            for (const video of videos.values()) video.element.pause();
            if (!paintRetainedPcmAt(settledTime)) {
              pcmProof('error', run.generation, {
                stage: 'visual',
                code: 'paused-frame-unavailable',
              });
              failScheduledAudio(
                'paused video frame unavailable at the acknowledged boundary'
              );
              return;
            }
            restoreVisibleCanvas();
          }
          pcmResumeFrame = compositionStop.value;
          stopPcm(ended ? 'end' : run.closeReason);
          currentTime = settledTime;
          if (ended) {
            pcmPlayIntent = false;
            isPlaying = false;
            isBuffering = false;
          } else if (pcmPlayIntent) {
            isBuffering = true;
            const request = playRequestEpoch;
            notify();
            void recoverPcmAt(
              compositionStop,
              request,
              run.context,
              run.routeVersion,
              run.outputClock
            ).catch((error: unknown) => {
              if (!isDisposed && pcmPlayIntent && request === playRequestEpoch)
                failScheduledAudio(
                  error instanceof Error ? error.message : String(error)
                );
            });
            return;
          } else {
            isPlaying = false;
            isBuffering = false;
          }
          notify();
          return;
        }
        if (readEnd > deadline) {
          failScheduledAudio('audio output drain was not observed');
          return;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 8);
        await promise;
      }
    })();
  }
  function watchPcmClosure(run: PcmRun): void {
    if (run.stopWatchdog !== null) return;
    run.stopWatchdog = setTimeout(() => {
      run.stopWatchdog = null;
      if (pcmRun === run && run.stopping && !run.stopped)
        failScheduledAudio('transport gate closure was not acknowledged');
    }, 100);
  }

  function armPcmStop(run: PcmRun, stopFrame: number, reason: string): void {
    if (run.stopped || run.stopping) return;
    run.stopping = true;
    run.provider.dispose();
    watchPcmClosure(run);
    run.closeReason =
      reason === 'pause'
        ? 'pause'
        : reason === 'resync'
          ? 'resync'
          : reason === 'resource'
            ? 'resource'
            : 'error';
    void (async () => {
      if (run.command) await run.command;
      if (pcmRun !== run || run.stopped) return;
      const frontier = run.frontierFrame;
      if (frontier === null) {
        failScheduledAudio('transport has no committed frontier');
        return;
      }
      const boundary = Math.min(stopFrame, frontier);
      const ack = await run.gate.stop(run.generation, boundary);
      if (pcmRun !== run || run.stopped) return;
      if (!ack.accepted || ack.throughFrame !== boundary) {
        failScheduledAudio(
          `transport stop rejected: ${ack.reason ?? 'invalid acknowledgment'}`
        );
        return;
      }
      run.frontierFrame = boundary;
      try {
        run.scheduler.stopAtFrame(boundary);
      } catch {
        failScheduledAudio('PCM source stop failed');
      }
    })().catch(() => {
      if (pcmRun === run) failScheduledAudio('transport stop failed');
    });
  }

  function pcmCommitClockValid(run: PcmRun): boolean {
    if (run.contextFrame === null || !run.bridge) return false;
    const readBegin = presentClockMs();
    const contextBefore = run.context.currentTime;
    let stamp: AudioTimestamp | null = null;
    try {
      stamp = run.context.getOutputTimestamp();
    } catch {}
    const contextAfter = run.context.currentTime;
    const readEnd = presentClockMs();
    const observation = run.outputClock.observe({
      readBegin,
      readEnd,
      contextBefore,
      contextAfter,
      state: run.context.state,
      contextTime: stamp?.contextTime,
      performanceTime: stamp?.performanceTime,
    });
    if (
      !stamp ||
      typeof stamp.contextTime !== 'number' ||
      !Number.isFinite(stamp.contextTime) ||
      typeof stamp.performanceTime !== 'number' ||
      !Number.isFinite(stamp.performanceTime) ||
      observation.status !== 'calibrated' ||
      observation.offsetMin === null ||
      observation.offsetMax === null ||
      readEnd > run.outputClock.deadline ||
      run.contextFrame <
        Math.ceil(contextAfter * run.admission.rate) +
          OTIO_PCM_EPOCH_GUARD_FRAMES
    ) {
      pcmProof('clock-commit-detail', run.generation, {
        reason: 'observation-or-lead',
        stamp,
        observation,
        readBegin,
        readEnd,
        contextBefore,
        contextAfter,
        contextFrame: run.contextFrame,
        deadline: run.outputClock.deadline,
        guardFrames: OTIO_PCM_EPOCH_GUARD_FRAMES,
      });
      return false;
    }
    const allowance = observation.offsetMax - observation.offsetMin;
    const mapped =
      stamp.performanceTime +
      1000 * (run.contextFrame / run.admission.rate - stamp.contextTime);
    const original =
      run.bridge.performanceTime +
      1000 * (run.contextFrame / run.admission.rate - run.bridge.contextTime);
    if (Math.abs(mapped - original) > allowance + 1e-6 || mapped < readEnd) {
      pcmProof('clock-commit-detail', run.generation, {
        reason: 'mapping-or-time',
        mapped,
        original,
        allowance,
        readEnd,
      });
      return false;
    }
    const vsync = vsyncTracker.medianSeconds;
    for (const sample of run.phaseSamples) {
      const preferred =
        sample.dL +
        1000 *
          (sample.wMinSeconds +
            vsync / 2 -
            (sample.iL0Plus1Start - sample.sourceT0Seconds) / sample.rL);
      const half = 1000 * (sample.wMinSeconds - vsync / 2);
      if (
        mapped - allowance < preferred - half ||
        mapped + allowance > preferred + half
      ) {
        pcmProof('clock-commit-detail', run.generation, {
          reason: 'phase-band',
          mapped,
          allowance,
          preferred,
          half,
          sample,
        });
        return false;
      }
    }
    return true;
  }

  async function renewPcmFrontier(run: PcmRun): Promise<boolean> {
    if (
      run.stopped ||
      run.contextFrame === null ||
      !run.bridge ||
      pcmRun !== run
    )
      return false;
    if (run.stopping) return true;
    if (run.command) return run.command;
    const rate = run.admission.rate;
    const nowFrame = Math.ceil(run.context.currentTime * rate);
    const old = run.frontierFrame;
    if (old !== null && run.holds.some((hold) => !hold.isValid())) {
      pcmProof('error', run.generation, {
        stage: 'visual',
        code: 'certified video reservation was invalidated',
      });
      failScheduledAudio('certified video reservation was invalidated');
      return false;
    }
    if (old !== null && nowFrame + OTIO_PCM_MIN_LEAD_FRAMES >= old) return true;
    schedulePreparedPcm(run);
    const fromFrame =
      old === null ? run.startFrame : run.startFrame + old - run.contextFrame;
    const limitFrame = run.scheduledThrough;
    if (limitFrame <= fromFrame) return old !== null;
    const hold = reserveVisualPrefix(
      { value: fromFrame, rate },
      { value: limitFrame, rate }
    );
    const visualFrame = Math.floor(
      (hold.through.value * rate) / hold.through.rate
    );
    const next =
      run.contextFrame + Math.min(limitFrame, visualFrame) - run.startFrame;
    if (next <= (old ?? run.contextFrame) || !hold.isValid()) {
      hold.release();
      return old !== null;
    }
    const afterWorkFrame = Math.ceil(run.context.currentTime * rate);
    const protectedDeadline = old ?? run.contextFrame;
    if (
      !hold.isValid() ||
      afterWorkFrame + OTIO_PCM_MIN_LEAD_FRAMES >= protectedDeadline
    ) {
      hold.release();
      if (old !== null) {
        run.stopping = true;
        run.provider.dispose();
        watchPcmClosure(run);
        return true;
      }
      return false;
    }
    const command = (async () => {
      if (old === null) {
        if (!pcmCommitClockValid(run)) {
          pcmProof('error', run.generation, {
            stage: 'clock',
            code: 'commit-clock-rejected',
          });
          hold.release();
          return false;
        }
        run.outputClock.arm();
      }
      const ack =
        old === null
          ? await run.gate.arm(run.generation, run.contextFrame!, next)
          : await run.gate.extend(run.generation, old, next);
      if (
        pcmRun !== run ||
        run.stopped ||
        !ack.accepted ||
        ack.throughFrame !== next ||
        !hold.isValid()
      ) {
        hold.release();
        return false;
      }
      run.frontierFrame = next;
      run.frontierCrossedAt = null;
      run.holds.push(hold);
      if (old === null) {
        run.outputClock.start();
        pcmBackendStarted = true;
        pcmProof('epoch', run.generation, {
          f0: run.contextFrame,
          c0: run.contextFrame! / rate,
          contextSampleRate: rate,
          compositionT0: run.startTime,
          bridge: run.bridge,
          bridgeMappingAllowanceMs: run.bridge!.mappingAllowanceMs,
        });
      }
      return true;
    })();
    run.command = command;
    let accepted: boolean;
    try {
      accepted = await command;
    } catch (error) {
      hold.release();
      throw error;
    } finally {
      if (run.command === command) run.command = null;
    }
    if (!accepted) return false;
    const hostname = typeof location === 'undefined' ? '' : location.hostname;
    if (
      coldProofGlobal.__otioProofPcm === true &&
      coldProofGlobal.__otioProofPcmFault === 'invalidate-next-reserved-tag' &&
      (hostname === '127.0.0.1' ||
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '[::1]')
    ) {
      const reservation = hold.intervals.flatMap(
        (interval) => interval.reservations
      )[0];
      if (reservation) {
        delete coldProofGlobal.__otioProofPcmFault;
        reservation.release();
        pcmProof('fault', run.generation, {
          code: 'reserved-frame-invalidated',
          occurrenceId: reservation.occurrence,
          tag: reservation.tags[0],
        });
        pcmProof('error', run.generation, {
          stage: 'visual',
          code: 'certified video reservation was invalidated',
        });
        failScheduledAudio('certified video reservation was invalidated');
        return false;
      }
    }
    // The accepted acknowledgment, not a timer, is the frontier authority.
    const compositionStop = {
      value: run.startFrame + next - run.contextFrame,
      rate,
    };
    pcmProof('frontier', run.generation, {
      compositionThrough: compositionStop,
      contextFrameThrough: next,
      gateFrame: next,
    });
    return true;
  }

  async function calibratePcmClock(run: PcmRun): Promise<boolean> {
    while (
      !run.stopped &&
      pcmRun === run &&
      presentClockMs() <= run.outputClock.deadline
    ) {
      const readBegin = presentClockMs();
      const contextBefore = run.context.currentTime;
      let stamp: AudioTimestamp | null = null;
      try {
        stamp = run.context.getOutputTimestamp();
      } catch {}
      const contextAfter = run.context.currentTime;
      const readEnd = presentClockMs();
      const result = run.outputClock.observe({
        readBegin,
        readEnd,
        contextBefore,
        contextAfter,
        state: run.context.state,
        contextTime: stamp?.contextTime,
        performanceTime: stamp?.performanceTime,
      });
      if (result.status === 'calibrated') return true;
      if (result.status === 'failed' || result.status === 'interrupted') {
        pcmProof('error', run.generation, {
          stage: 'clock',
          code: result.reason,
        });
        return false;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, run.outputClock.inheritedObservations.length ? 1 : 8);
      await promise;
    }
    return false;
  }

  async function selectPcmEpoch(
    run: PcmRun,
    samples: readonly DecoderPhaseSample[],
    time: OtioRationalTime
  ): Promise<number | null> {
    if (compareRationalTimes(run.startTime, time) !== 0) return null;
    if (run.clockCalibration && !(await run.clockCalibration)) return null;
    let stamp: AudioTimestamp | null = null;
    let after = presentClockMs();
    let mappingAllowanceMs = 0;
    while (
      !run.stopped &&
      pcmRun === run &&
      after <= run.outputClock.deadline
    ) {
      const before = presentClockMs();
      const contextBefore = run.context.currentTime;
      try {
        stamp = run.context.getOutputTimestamp();
      } catch {
        stamp = null;
      }
      const contextAfter = run.context.currentTime;
      after = presentClockMs();
      const result = run.outputClock.observe({
        readBegin: before,
        readEnd: after,
        contextBefore,
        contextAfter,
        state: run.context.state,
        contextTime: stamp?.contextTime,
        performanceTime: stamp?.performanceTime,
      });
      if (result.status === 'failed' || result.status === 'interrupted') {
        pcmProof('error', run.generation, {
          stage: 'clock',
          code: result.reason,
        });
        return null;
      }
      if (
        result.status === 'calibrated' &&
        stamp &&
        result.offsetMin !== null &&
        result.offsetMax !== null
      ) {
        mappingAllowanceMs = result.offsetMax - result.offsetMin;
        break;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 8);
      await promise;
    }
    if (
      !stamp ||
      typeof stamp.contextTime !== 'number' ||
      !Number.isFinite(stamp.contextTime) ||
      typeof stamp.performanceTime !== 'number' ||
      !Number.isFinite(stamp.performanceTime) ||
      run.outputClock.state !== 'calibrated' ||
      run.stopped
    ) {
      if (!run.stopped && pcmRun === run)
        pcmProof('error', run.generation, {
          stage: 'clock',
          code: 'clock-admission-expired',
        });
      return null;
    }
    // This allowance describes the observed browser mapping, not a bound on
    // physical speaker or display timing.
    const bridge = {
      contextTime: stamp.contextTime,
      performanceTime: stamp.performanceTime,
      mappingAllowanceMs,
    };
    const epoch = selectOtioCausalEpoch(
      samples,
      vsyncTracker.medianSeconds,
      bridge,
      run.admission.rate,
      run.context.currentTime,
      pcmRequestWall,
      after,
      OTIO_PCM_SELECTION_RESERVE_FRAMES
    );
    if (!epoch || epoch.performanceTime > run.outputClock.deadline) return null;
    run.contextFrame = epoch.contextFrame;
    run.phaseSamples = samples;
    run.bridge = bridge;
    return epoch.performanceTime;
  }

  // Wait against the existing decoder rings. Never restart or seek a producer
  // while deciding whether the exact committed boundary can be recovered.
  async function recoverPcmAt(
    time: OtioRationalTime,
    request: number,
    previousContext: AudioContext,
    previousRouteVersion: number,
    previousClock: OutputClock
  ): Promise<void> {
    const admission = pcmAdmission;
    const context = audioContext;
    if (
      !admission ||
      !context ||
      context !== previousContext ||
      previousRouteVersion !== pcmRouteVersion
    ) {
      failScheduledAudio('PCM recovery graph unavailable');
      return;
    }
    const generation = renderGeneration;
    const scopeAtStart = scopeEpoch;
    const alive = () =>
      !isDisposed &&
      pcmPlayIntent &&
      request === playRequestEpoch &&
      generation === renderGeneration &&
      scopeAtStart === scopeEpoch &&
      previousRouteVersion === pcmRouteVersion &&
      audioContext === previousContext;
    const deadline = presentClockMs() + 3000;
    let readiness: PcmVideoHold | null = null;
    while (alive()) {
      if (
        context.state !== 'running' ||
        graphicsLost ||
        isCanvasContextLost(canvas)
      ) {
        failScheduledAudio('PCM recovery lost audio or graphics context');
        return;
      }
      const limit = { value: time.value + 1, rate: admission.rate };
      const hold = reserveVisualPrefix(time, limit);
      const demand = pcmInitialDemand(admission, time.value);
      const capacityReady =
        pcmBudget.usedNodes + demand.nodes <= OTIO_PCM_MAX_NODES &&
        pcmBudget.usedBytes + demand.bytes <= OTIO_PCM_MAX_BYTES;
      if (
        capacityReady &&
        hold.isValid() &&
        compareRationalTimes(hold.through, time) > 0
      ) {
        readiness = hold;
        break;
      }
      hold.release();
      const evaluation = scopedEvaluation(time);
      const tree = videoTree(evaluation);
      const blocked = blockedTracks(evaluation);
      const keys = collectVideoOccurrenceKeys(evaluation.video_contributions);
      const indices = getDrawnLeafIndices(
        tree,
        (id, ancestry) => videoHidden(id, ancestry) || blocked.has(id),
        true
      );
      for (const index of indices) {
        const contribution = evaluation.video_contributions[index];
        const key = keys[index];
        if (
          !contribution?.bundle_path ||
          !key ||
          !inferMediaMimeType(contribution.bundle_path).startsWith('video/')
        )
          continue;
        const ring = nativeRings.get(key);
        const timing = videoTimingCache.get(contribution.bundle_path);
        const tag = certifiedWindowIndex(
          contribution.source_time,
          timing ?? null
        );
        if (
          !ring ||
          ring.hasLostContext() ||
          tag === null ||
          (ring.highestObservedTag !== null &&
            ring.highestObservedTag > tag &&
            !ring.hasTag(tag, ring.captureEpoch))
        ) {
          pcmProof('error', pcmGeneration, {
            stage: 'visual',
            code: 'recovery-frame-unavailable',
          });
          failScheduledAudio('committed recovery frame is unavailable');
          return;
        }
        if (
          timing?.kind === 'windows' &&
          ring.lastProgressTag !== null &&
          ring.lastProgressWallMs !== null
        ) {
          const start = timing.starts[ring.lastProgressTag];
          const fidelity = effectFidelity(
            contribution.active_effects,
            contribution.node_id
          );
          const videoRate = fidelity.kind === 'effect' ? 1 : fidelity.rate;
          if (start !== undefined && videoRate > 0) {
            const w = minWindowDuration(timing, videoRate);
            const vsync = vsyncTracker.medianSeconds;
            const preferred =
              ring.lastProgressWallMs +
              1000 *
                (w +
                  vsync / 2 -
                  (start - decoderLocalSeconds(contribution.source_time)) /
                    videoRate);
            const upper = preferred + 1000 * (w - vsync / 2);
            if (presentClockMs() > upper) {
              pcmProof('error', pcmGeneration, {
                stage: 'visual',
                code: 'recovery-phase-expired',
              });
              failScheduledAudio('video recovery phase expired');
              return;
            }
          }
        }
      }
      if (presentClockMs() >= deadline) {
        failScheduledAudio('video recovery readiness timed out');
        return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      let wakeQueued = false;
      const wake = () => {
        if (wakeQueued) return;
        wakeQueued = true;
        queueMicrotask(resolve);
      };
      pcmRecoveryWake = wake;
      const unsubscribe = [...nativeRings.values()].map((ring) =>
        ring.subscribeProgress(wake)
      );
      unsubscribe.push(pcmBudget.subscribe(wake));
      const timer = setTimeout(
        resolve,
        Math.min(250, Math.max(0, deadline - presentClockMs()))
      );
      await promise;
      clearTimeout(timer);
      if (pcmRecoveryWake === wake) pcmRecoveryWake = null;
      for (const remove of unsubscribe) remove();
    }
    if (!alive() || !readiness) {
      readiness?.release();
      return;
    }
    let run: PcmRun | null = null;
    try {
      pcmRequestWall = presentClockMs();
      const inherited = previousClock.forkForRequest(
        pcmRequestWall,
        presentClockMs()
      );
      run = await beforePcmDeadline(
        preparePcmRun(context, admission, time, inherited ?? undefined),
        pcmRequestWall
      );
      if (!alive() || pcmRun !== run) return;
      if (!readiness.isValid())
        throw new Error('video recovery reservation lost');
      const evaluation = scopedEvaluation(time);
      const blocked = blockedTracks(evaluation);
      const keys = collectVideoOccurrenceKeys(evaluation.video_contributions);
      const indices = getDrawnLeafIndices(
        videoTree(evaluation),
        (id, ancestry) => videoHidden(id, ancestry) || blocked.has(id),
        true
      );
      const samples: DecoderPhaseSample[] = [];
      for (const index of indices) {
        const contribution = evaluation.video_contributions[index];
        const key = keys[index];
        if (
          !contribution?.bundle_path ||
          !key ||
          !inferMediaMimeType(contribution.bundle_path).startsWith('video/')
        )
          continue;
        const ring = nativeRings.get(key);
        const timing = videoTimingCache.get(contribution.bundle_path);
        const fidelity = effectFidelity(
          contribution.active_effects,
          contribution.node_id
        );
        const rate = fidelity.kind === 'effect' ? 1 : fidelity.rate;
        const targetTag = certifiedWindowIndex(
          contribution.source_time,
          timing ?? null
        );
        if (
          ring &&
          timing?.kind === 'windows' &&
          ring.videoElement.paused &&
          targetTag === timing.starts.length - 1 &&
          ring.hasTag(targetTag, ring.captureEpoch)
        )
          continue;
        const tag = ring?.lastProgressTag;
        if (
          !ring ||
          !timing ||
          timing.kind !== 'windows' ||
          tag === null ||
          tag === undefined ||
          ring.lastProgressWallMs === null ||
          timing.starts[tag] === undefined
        ) {
          throw new Error('video recovery phase unavailable');
        }
        samples.push({
          dL: ring.lastProgressWallMs,
          iL0Plus1Start: timing.starts[tag]!,
          sourceT0Seconds: decoderLocalSeconds(contribution.source_time),
          rL: rate,
          wMinSeconds: minWindowDuration(timing, rate),
        });
      }
      const epochWall = await beforePcmDeadline(
        selectPcmEpoch(run, samples, time),
        pcmRequestWall
      );
      if (!alive() || pcmRun !== run) return;
      if (!readiness.isValid())
        throw new Error('video recovery reservation lost');
      if (epochWall === null)
        throw new Error('video recovery phase has no causal audio epoch');
      const candidate = preparedBoundary;
      if (
        candidate?.status === 'ready' &&
        candidate.anchor === nativeAnchor &&
        compareRationalTimes(candidate.at, time) <= 0
      ) {
        const required = drawnVideoKeys(evaluation, videoTree(evaluation));
        for (const key of required) {
          const ring = candidate.rings.get(key);
          if (!ring || nativeRings.get(key) !== ring) continue;
          lastDrawnOccurrenceKeys.add(key);
          candidate.keys.delete(key);
          candidate.rings.delete(key);
        }
      }
      nativeAnchor = { wallMs: epochWall, time };
      readiness.release();
      readiness = null;
      if (candidate && preparedBoundary === candidate) cancelPreparedBoundary();
      if (!(await beforePcmDeadline(renewPcmFrontier(run), pcmRequestWall)))
        throw new Error('recovery frontier unavailable');
      if (!alive() || pcmRun !== run) return;
      isStarting = false;
      isBuffering = false;
      nativeLastPresentMs = null;
      notify();
      scheduleTick();
    } catch (error) {
      if (alive())
        failScheduledAudio(
          error instanceof Error ? error.message : String(error)
        );
    } finally {
      readiness?.release();
      if (!alive() && run && pcmRun === run) stopPcm('recovery-cancelled');
    }
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
    gen: number,
    signal: AbortSignal = scopeAbort.signal
  ): Promise<boolean> {
    if (stale(gen) || signal.aborted) return Promise.resolve(false);
    const matchesTarget = (): boolean =>
      Math.abs(media.currentTime - target) <= MEDIA_SEEK_TIME_PRECISION_SECONDS;
    if (
      !media.seeking &&
      matchesTarget() &&
      media.readyState >= HAVE_CURRENT_DATA &&
      (decodedAt.get(media) === target || !decodedAt.has(media))
    ) {
      decodedAt.set(media, target);
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
      signal.removeEventListener('abort', onAbort);
      if (
        ok &&
        !stale(gen) &&
        !media.seeking &&
        matchesTarget() &&
        media.readyState >= HAVE_CURRENT_DATA
      ) {
        decodedAt.set(media, target);
        resolve(true);
        return;
      }
      resolve(false);
    };
    const onSeeked = (): void => {
      if (
        !media.seeking &&
        matchesTarget() &&
        media.readyState >= HAVE_CURRENT_DATA
      )
        finish(true);
    };
    const onReady = (): void => {
      if (
        !media.seeking &&
        media.readyState >= HAVE_CURRENT_DATA &&
        matchesTarget()
      ) {
        finish(true);
      }
    };
    const onError = (): void => finish(false);
    const onAbort = (): void => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    media.addEventListener('seeked', onSeeked);
    media.addEventListener('loadeddata', onReady);
    media.addEventListener('error', onError);
    try {
      if (!media.seeking || !matchesTarget()) media.currentTime = target;
    } catch {
      finish(false);
      return promise;
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
    gen: number,
    owns: () => boolean = () => true
  ): Promise<LoadedImage | null> {
    const loaded = imageElements.get(path);
    if (loaded) return Promise.resolve(loaded);
    let owners = imageOwners.get(path);
    if (!owners) {
      owners = new Set();
      imageOwners.set(path, owners);
    }
    const ownerSet = owners;
    ownerSet.add(() => !stale(gen) && owns());
    const existing = imagePromises.get(path);
    if (existing) return existing;
    const hasOwner = (): boolean => [...ownerSet].some((owner) => owner());
    const pending = (async () => {
      const url = await sharedUrl(path);
      if (!hasOwner()) {
        if (imageOwners.get(path) === ownerSet) {
          imageOwners.delete(path);
          imagePromises.delete(path);
        }
        return null;
      }
      if (!url || isDisposed || typeof Image === 'undefined') {
        if (!isDisposed) {
          rememberFailure(
            path,
            diagnostic('error', 'missing-media', `Missing image: ${path}`, path)
          );
        }
        return null;
      }
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
      if (isDisposed || !hasOwner()) {
        element.src = '';
        if (imageOwners.get(path) === ownerSet) {
          imageOwners.delete(path);
          imagePromises.delete(path);
        }
        return null;
      }
      const width = element.naturalWidth;
      const height = element.naturalHeight;
      if (width > 0 && height > 0 && !decodedImageAllowed(width, height)) {
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
        if (imageElements.get(path) === loaded) imageElements.delete(path);
        if (imagePromises.get(path) === pending) imagePromises.delete(path);
      });
      if (!kept) {
        rememberFailure(
          path,
          diagnostic(
            'error',
            'unsupported-codec',
            `Image cannot fit the retained pixel budget: ${path}`,
            path
          )
        );
        return null;
      }
      imageElements.set(path, loaded);
      mediaFailures.delete(path);
      return loaded;
    })();
    imagePromises.set(path, pending);
    void pending.then(
      (result) => {
        if (imageOwners.get(path) === ownerSet) imageOwners.delete(path);
        if (!result && !hasOwner() && imagePromises.get(path) === pending)
          imagePromises.delete(path);
      },
      () => {
        if (imageOwners.get(path) === ownerSet) imageOwners.delete(path);
        if (imagePromises.get(path) === pending) imagePromises.delete(path);
      }
    );
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
    stopPcm('pause');
    cancelStartupSampling?.();
    audioReconcileRevision++;
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
    gen: number,
    frames: VideoFrame[]
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
          gen,
          frames
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

  // Waits until the decoder presents the certified window for req. Returns the
  // verified frame, which the caller owns, 'element' when the browser cannot
  // report frame identity, or 'empty' when no media may paint this leaf.
  async function awaitPresentedFrame(
    media: HTMLVideoElement,
    timing: OtioVideoTiming | null,
    req: number,
    gen: number,
    contrib: OtioVideoContribution,
    key: string
  ): Promise<{ readonly frame: VideoFrame } | 'element' | 'empty'> {
    let deadline: number | null = null;
    for (;;) {
      const { outcome, frame } = readPresentedFrame(media, timing);
      if (outcome.kind === 'match' && frame !== null) {
        if (outcome.index === req) return { frame };
        frame.close();
      }
      if (outcome.kind === 'uncovered' || outcome.kind === 'readout-failed') {
        return 'element';
      }
      if (stale(gen)) return 'empty';
      const now = presentClockMs();
      deadline ??= now + OTIO_PAUSED_PRESENT_TIMEOUT_MS;
      if (now >= deadline) {
        const shown =
          outcome.kind === 'match' ? String(outcome.index) : 'outside';
        videoTimingFailures.set(
          key,
          diagnostic(
            'error',
            'invalid-timing',
            `Decoder presented window ${shown} instead of certified window ${req}: ${contrib.bundle_path}`,
            contrib.node_id
          )
        );
        return 'empty';
      }
      await nextPresentation(media, OTIO_PAUSED_PRESENT_POLL_MS);
      if (stale(gen)) return 'empty';
    }
  }

  async function prepareLeaf(
    contrib: OtioVideoContribution,
    key: string,
    gen: number,
    frames: VideoFrame[]
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
    if (midpoint !== null && typeof VideoFrame === 'function') {
      const req = certifiedWindowIndex(contrib.source_time, timing);
      if (req !== null) {
        const verified = await awaitPresentedFrame(
          video.element,
          timing,
          req,
          gen,
          contrib,
          key
        );
        if (verified === 'empty') return { kind: 'empty' };
        if (verified !== 'element') {
          frames.push(verified.frame);
          return {
            kind: 'image',
            source: verified.frame,
            alpha: contrib.alpha,
          };
        }
      }
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
    if (audioBackend === 'pcm') return;
    const revision = ++audioReconcileRevision;
    const active = new Set<string>();
    const seen = new Map<string, number>();
    for (const contrib of result.audio_contributions) {
      if (stale(gen) || revision !== audioReconcileRevision) return;
      const fidelity = effectFidelity(contrib.active_effects, contrib.node_id);
      const opaqueTransition = result.active_transitions.some(
        (transition) =>
          transition.render_kind === 'opaque' &&
          (transition.track_id === contrib.track_id ||
            ancestryOf(contrib).includes(transition.track_id))
      );
      const withheld =
        !baseMediaPreviewAllowed &&
        (opaqueTransition ||
          fidelity.kind === 'effect' ||
          fidelity.kind === 'rate');
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
      if (stale(gen) || revision !== audioReconcileRevision) return;
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
      desiredAudioGain.set(loaded, { gain, audible });
      if (!audioSeeking.has(loaded)) applyAudioGain(loaded, gain, audible);
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
        asyncSeekAudio(loaded, target);
      }
      if (loaded.element.paused && !audioSeeking.has(loaded)) {
        try {
          decodedAt.delete(loaded.element);
          await loaded.element.play();
        } catch (error) {
          if (stale(gen) || revision !== audioReconcileRevision) return;
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
    if (stale(gen) || revision !== audioReconcileRevision) return;
    for (const [key, entry] of audios) {
      if (active.has(key) || preparedBoundary?.audio.get(key) === entry)
        continue;
      entry.element.pause();
      entry.element.setAttribute('data-active', 'false');
      if (entry.gainNode) entry.gainNode.gain.value = 0;
      else entry.element.volume = 0;
    }
  }

  function paint(
    evaluation: OtioEvaluationResult,
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
    const blocked = blockedTracks(evaluation);
    if (audioBackend === 'pcm' && pcmRun) {
      const drawn = getDrawnLeafIndices(
        tree,
        (id, ancestry) => videoHidden(id, ancestry) || blocked.has(id)
      );
      if (
        drawn.some((index) => {
          const contribution = evaluation.video_contributions[index];
          return (
            contribution &&
            sampleKind(contribution) !== 'black' &&
            (!leaves[index] || leaves[index]?.kind === 'empty')
          );
        })
      )
        return false;
    }
    const outcome = renderOtioVideoTree(
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
        if (surface.width !== width) surface.width = width;
        if (surface.height !== height) surface.height = height;
        return surface;
      },
      (nodeId, ancestry) => videoHidden(nodeId, ancestry) || blocked.has(nodeId)
    );
    if (outcome === 'failed') return false;
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
    const frames: VideoFrame[] = [];
    try {
      const evaluation = scopedEvaluation(time);
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
      const leaves = await prepareLeaves(evaluation, tree, gen, frames);
      if (stale(gen)) return;
      let presented = false;
      try {
        presented = paint(evaluation, tree, leaves);
      } catch {
        // A missing surface must not paint a stale frame.
      }
      closeFrames(frames);
      images.evict();
      if (!presented && audioBackend === 'pcm' && pcmRun) {
        pcmProof('error', pcmRun.generation, {
          stage: 'visual',
          code: 'compositor-failed',
        });
        failScheduledAudio('video compositor failed');
        return;
      }
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
      closeFrames(frames);
      if (gen === renderGeneration) renderInFlight = false;
    }
  }

  function enqueueRender(time: OtioRationalTime, gen: number): Promise<void> {
    const run = (): Promise<void> => renderAt(time, gen);
    const done = renderTail.then(run, run);
    pendingRender = done;
    void done.then(
      () => {
        if (pendingRender === done) pendingRender = null;
      },
      () => {
        if (pendingRender === done) pendingRender = null;
      }
    );
    renderTail = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  }

  function asyncSeekAudio(audio: LoadedAudio, target: number): void {
    if (audioSeeking.has(audio)) return;
    const epoch = scopeEpoch;
    const generation = renderGeneration;
    audioSeeking.add(audio);
    if (audio.gainNode) {
      audio.gainNode.gain.value = 0;
    } else {
      audio.element.volume = 0;
    }
    const onSeeked = (): void => {
      audio.element.removeEventListener('seeked', onSeeked);
      audioSeeking.delete(audio);
      const desired = desiredAudioGain.get(audio);
      if (
        epoch === scopeEpoch &&
        generation === renderGeneration &&
        audios.get(audio.key) === audio &&
        !isDisposed &&
        isPlaying &&
        audio.element.getAttribute('data-active') === 'true' &&
        desired
      ) {
        applyAudioGain(
          audio,
          desired.gain,
          desired.audible && trackAudible(audio.trackId)
        );
      }
    };
    audio.element.addEventListener('seeked', onSeeked);
    try {
      audio.element.currentTime = target;
    } catch {
      audio.element.removeEventListener('seeked', onSeeked);
      audioSeeking.delete(audio);
      const desired = desiredAudioGain.get(audio);
      if (desired && isPlaying) {
        applyAudioGain(
          audio,
          desired.gain,
          desired.audible && trackAudible(audio.trackId)
        );
      }
    }
  }

  function failScheduledAudio(code: string): void {
    // Abort on clock, compositor, or source failure. A future boundary inferred
    // from an old wall bridge is not evidence of an audible drain.
    const generation = pcmRun?.generation ?? pcmGeneration;
    pcmResumeFrame = null;
    pcmPlayIntent = false;
    playRequestEpoch++;
    pcmRecoveryWake?.();
    stopPcm('underflow');
    isPlaying = false;
    isStarting = false;
    isBuffering = false;
    nativeAnchor = null;
    pauseAllMedia();
    mediaFailures.set(
      'pcm-scheduler',
      diagnostic(
        'error',
        'unsupported-browser',
        `Scheduled audio stopped: ${code}`,
        timelineId
      )
    );
    pcmProof('error', generation, { stage: 'schedule', code });
    notify();
  }

  function fallbackToSeekCadence(): void {
    if (audioBackend === 'pcm') {
      failScheduledAudio(
        'native video cannot sustain the scheduled audio epoch'
      );
      return;
    }
    cancelPreparedBoundary();
    isNativeHolding = false;
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
    nativeLastPresentMs = null;
    clockAnchor = null;
    notify();
    if (isPlaying) scheduleTick();
  }

  async function startSequence(
    T0: OtioRationalTime,
    buffering: boolean = false
  ): Promise<void> {
    const outgoing = pcmRun;
    if (
      audioBackend === 'pcm' &&
      outgoing?.frontierFrame !== null &&
      outgoing?.frontierFrame !== undefined &&
      !outgoing.stopped
    ) {
      if (!outgoing.stopping) {
        pcmPlayIntent = isPlaying;
        isBuffering = true;
        const stop = Math.min(
          outgoing.frontierFrame,
          Math.max(
            outgoing.contextFrame ?? 0,
            Math.ceil(outgoing.context.currentTime * outgoing.admission.rate) +
              OTIO_PCM_MIN_LEAD_FRAMES * 2
          )
        );
        armPcmStop(outgoing, stop, 'resync');
        notify();
      }
      return;
    }
    stopPcm('replacement');
    cancelPreparedBoundary();
    if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    isNativeHolding = false;
    const gen = ++renderGeneration;
    isStarting = !buffering;
    if (buffering) {
      isBuffering = true;
    }
    startingStartTime =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    nativeEpoch++;
    nativeAnchor = null;
    nativeLastPresentMs = null;
    clockAnchor = null;
    pauseAllMedia();
    notify();
    // The new time is published by renderAt together with the exact paint, so
    // the clock never runs ahead of the canvas during the resync.
    currentTime = T0;
    if (audioBackend === 'pcm') {
      const context = getAudioContext();
      if (!context || !pcmAdmission) {
        failScheduledAudio('PCM audio context unavailable');
        return;
      }
      try {
        await preparePcmRun(context, pcmAdmission, T0);
      } catch {
        if (!stale(gen)) failScheduledAudio('PCM preparation failed');
        return;
      }
      if (stale(gen)) return;
    }

    await enqueueRender(T0, gen);
    if (stale(gen)) return;

    if (graphicsLost || isCanvasContextLost(canvas)) {
      isStarting = false;
      isBuffering = true;
      notify();
      return;
    }

    const evaluation = scopedEvaluation(T0);
    const tree = videoTree(evaluation);
    const blocked = blockedTracks(evaluation);
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

    const finalWindowOnly =
      audioBackend === 'pcm' &&
      eligible &&
      drawnVideoLeaves.length > 0 &&
      drawnVideoLeaves.every(
        (leaf) => leaf.iL0 + 1 >= leaf.timing.starts.length
      );
    if (!eligible || drawnVideoLeaves.length === 0 || finalWindowOnly) {
      if (audioBackend === 'pcm') {
        if (!eligible || !pcmRun) {
          failScheduledAudio(
            'native video timing is not eligible for a scheduled epoch'
          );
          return;
        }
        if (finalWindowOnly) {
          for (const leaf of drawnVideoLeaves) {
            const ring = nativeRings.get(leaf.key);
            if (!ring) {
              failScheduledAudio('final video window is unavailable');
              return;
            }
            ring.resetEpoch(nativeEpoch);
            if (!ring.capturePausedFrame(leaf.iL0, nativeEpoch, leaf.timing)) {
              failScheduledAudio('final video window could not be captured');
              return;
            }
          }
        }
        const epochWall = await selectPcmEpoch(pcmRun, [], T0);
        if (epochWall === null) {
          failScheduledAudio('audio output clock bridge unavailable');
          return;
        }
        nativeMode = true;
        nativeAnchor = { wallMs: epochWall, time: T0 };
        nativeLastPresentMs = null;
        lastDrawnOccurrenceKeys = new Set(
          drawnVideoLeaves.map((leaf) => leaf.key)
        );
        playbackBoundaries = otioPlaybackBoundaries(
          doc,
          timelineId,
          scope?.range ?? {
            start_time: { value: 0, rate: clock.rate },
            duration: clock.duration,
          }
        );
        try {
          if (!(await renewPcmFrontier(pcmRun))) {
            failScheduledAudio('no certified initial audiovisual frontier');
            return;
          }
        } catch {
          failScheduledAudio('PCM scheduling failed');
          return;
        }
        if (stale(gen) || !pcmRun) return;
        isStarting = false;
        isBuffering = false;
        prepareNextBoundary();
        notify();
        scheduleTick();
        return;
      }
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
        if (audioBackend === 'pcm') {
          failScheduledAudio('native video startup could not establish phase');
          return;
        }
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

      const firstAdvancedPromises: Promise<{
        now: number;
        capturedAt: number;
        tag: number;
      }>[] = [];
      const playPromises: Promise<void>[] = [];

      for (const leaf of drawnVideoLeaves) {
        const ring = nativeRings.get(leaf.key);
        if (!ring) continue;
        ring.isStarting = true;
        ring.startupFirstAdvancedTag = leaf.iL0 + 1;
        const { promise, resolve, reject } = Promise.withResolvers<{
          now: number;
          capturedAt: number;
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
            if (audioBackend === 'pcm')
              failScheduledAudio('video decoder lost certified progress');
            else void startSequence(currentTime, true);
          }
        });
      }
      // Sample while startup waits for its first rVFC too. Otherwise the
      // browser can present and skip the first advanced packet before the
      // ordinary playback tick has been scheduled.
      let startupFrame: number | null = null;
      let startupSampling = true;
      const cancelled = Promise.withResolvers<'cancelled'>();
      const cancelSampling = (): void => {
        startupSampling = false;
        if (
          startupFrame !== null &&
          typeof cancelAnimationFrame === 'function'
        ) {
          cancelAnimationFrame(startupFrame);
          startupFrame = null;
        }
        cancelled.resolve('cancelled');
      };
      cancelStartupSampling = cancelSampling;
      const sampleStartup = (now: number): void => {
        startupFrame = null;
        if (!startupSampling || !isPlaying || stale(gen)) return;
        for (const leaf of drawnVideoLeaves) {
          const ring = nativeRings.get(leaf.key);
          if (!ring || ring.videoElement.paused || ring.hasLostContext())
            continue;
          const outcome = ring.readoutFrame(leaf.timing, ring.captureEpoch);
          if (outcome.kind === 'producer-fault' && audioBackend === 'pcm') {
            failScheduledAudio('video decoder timestamp regressed');
            return;
          }
          ring.recordProgress(outcome, now);
          ring.admitStartupCapture(
            outcome,
            ring.captureEpoch,
            now,
            presentClockMs()
          );
        }
        if (typeof requestAnimationFrame === 'function')
          startupFrame = requestAnimationFrame(sampleStartup);
      };
      if (typeof requestAnimationFrame === 'function')
        startupFrame = requestAnimationFrame(sampleStartup);

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
        | [
            { now: number; capturedAt: number; tag: number }[],
            PromiseSettledResult<void>[],
          ]
        | 'timeout'
        | 'failed'
        | 'cancelled';
      try {
        raceResult = await Promise.race([
          waitAll,
          timeoutPromise,
          cancelled.promise,
        ]);
      } catch {
        raceResult = 'failed';
      }
      cancelSampling();
      if (cancelStartupSampling === cancelSampling)
        cancelStartupSampling = null;
      clearTimeout(timeoutTimer);
      if (raceResult === 'cancelled' || stale(gen)) return;

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
        coldProof('capture', {
          occurrence: leaf.key,
          tag: adv.tag,
          epoch: nativeRings.get(leaf.key)?.captureEpoch,
          schedulingTime: adv.now,
          capturedAt: adv.capturedAt,
          sourceT0: sourceT0Seconds,
          packetStart: actualStart,
          rate: leaf.rL,
          wMin: leaf.wMinSeconds,
        });
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
      if (coldProofGlobal.__otioProofCold === true) {
        const phaseVsync = vsyncTracker.medianSeconds;
        const intervals = phaseSamples.map((sample) => {
          const preferred =
            sample.dL +
            1000 *
              (sample.wMinSeconds +
                phaseVsync / 2 -
                (sample.iL0Plus1Start - sample.sourceT0Seconds) / sample.rL);
          const half = 1000 * (sample.wMinSeconds - phaseVsync / 2);
          return { lower: preferred - half, upper: preferred + half };
        });
        coldProof('solver', {
          samples: phaseSamples,
          intervalLower: Math.max(
            ...intervals.map((interval) => interval.lower)
          ),
          intervalUpper: Math.min(
            ...intervals.map((interval) => interval.upper)
          ),
          chosenAnchor: anchorResult.tauStar,
          spreadAcceptable: anchorResult.spreadAcceptable,
        });
      }
      if (audioBackend !== 'pcm' && !anchorResult.spreadAcceptable) {
        if (attempt === 0) continue;
        fallbackToSeekCadence();
        return;
      }

      let anchorWall = anchorResult.tauStar;
      if (audioBackend === 'pcm') {
        const run = pcmRun;
        const epochWall = run
          ? await selectPcmEpoch(run, phaseSamples, T0)
          : null;
        if (
          epochWall === null ||
          drawnVideoLeaves.some((leaf, index) => {
            const ring = nativeRings.get(leaf.key);
            const sample = advancedSamples[index];
            return (
              !ring || !sample || !ring.hasTag(sample.tag, ring.captureEpoch)
            );
          })
        ) {
          failScheduledAudio(
            'no causal audio epoch inside the certified video phase intersection'
          );
          return;
        }
        anchorWall = epochWall;
      }
      nativeAnchor = { wallMs: anchorWall, time: T0 };
      nativeLastPresentMs = null;
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

    if (audioBackend !== 'pcm') {
      isStarting = false;
      isBuffering = false;
    }
    coldFirstTick = true;
    coldFirstPaint = true;
    coldProof('startup-complete', { chosenAnchor: nativeAnchor?.wallMs });
    playbackBoundaries = otioPlaybackBoundaries(
      doc,
      timelineId,
      scope?.range ?? {
        start_time: { value: 0, rate: clock.rate },
        duration: clock.duration,
      }
    );
    if (audioBackend === 'pcm') {
      const run = pcmRun;
      try {
        if (!run || !(await renewPcmFrontier(run))) {
          failScheduledAudio('no certified initial audiovisual frontier');
          return;
        }
      } catch {
        failScheduledAudio('PCM scheduling failed');
        return;
      }
      if (stale(gen) || pcmRun !== run) return;
      isStarting = false;
      isBuffering = false;
    }
    prepareNextBoundary();
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
    let outputTime: number | null = null;
    if (audioBackend === 'pcm') {
      const run = pcmRun;
      if (!run && isBuffering && pcmPlayIntent) return;
      if (!run) {
        failScheduledAudio('audio context unavailable');
        return;
      }
      const readBegin = presentClockMs();
      const contextBefore = run.context.currentTime;
      let stamp: AudioTimestamp | null = null;
      try {
        stamp = run.context.getOutputTimestamp();
      } catch {}
      const contextAfter = run.context.currentTime;
      const readEnd = presentClockMs();
      const result = run.outputClock.observe({
        readBegin,
        readEnd,
        contextBefore,
        contextAfter,
        state: run.context.state,
        contextTime: stamp?.contextTime,
        performanceTime: stamp?.performanceTime,
      });
      if (
        !stamp ||
        typeof stamp.contextTime !== 'number' ||
        !Number.isFinite(stamp.contextTime) ||
        typeof stamp.performanceTime !== 'number' ||
        !Number.isFinite(stamp.performanceTime) ||
        result.status === 'failed' ||
        result.status === 'interrupted'
      ) {
        pcmProof('error', run.generation, {
          stage: 'clock',
          code: result.reason,
        });
        failScheduledAudio(`audio output clock interrupted: ${result.reason}`);
        return;
      }
      outputTime =
        stamp.contextTime + Math.max(0, readEnd - stamp.performanceTime) / 1000;
    }
    vsyncTracker.recordTick(now);
    if (renderInFlight || isBuffering || isStarting) {
      clockAnchor = null;
      scheduleTick();
      return;
    }
    if (nativeMode && nativeAnchor !== null) {
      // rVFC may omit a presented packet. Sample each owned running decoder
      // once on the render tick; the ring admits only timestamp-certified
      // frames, and duplicate matches do not consume another slot.
      for (const ring of nativeRings.values()) {
        if (
          !ring.videoElement.paused &&
          ring.timing &&
          !ring.hasLostContext()
        ) {
          const outcome = ring.readoutFrame(ring.timing, ring.captureEpoch);
          if (outcome.kind === 'producer-fault' && audioBackend === 'pcm') {
            failScheduledAudio('video decoder timestamp regressed');
            return;
          }
          ring.recordProgress(outcome, now);
        }
      }
      if (nativeLastPresentMs === null) {
        nativeLastPresentMs = now;
      }
      const elapsed =
        outputTime !== null &&
        pcmRun?.contextFrame !== null &&
        pcmRun?.contextFrame !== undefined
          ? outputTime - pcmRun.contextFrame / pcmRun.admission.rate
          : (now - nativeAnchor.wallMs) / 1000;
      let T: OtioRationalTime;
      if (elapsed <= 0) {
        T = nativeAnchor.time;
      } else {
        T = addRationalTimes(nativeAnchor.time, {
          value: elapsed * clock.rate,
          rate: clock.rate,
        });
      }
      const pcm = pcmRun;
      if (
        audioBackend === 'pcm' &&
        pcm?.contextFrame !== null &&
        pcm?.frontierFrame !== null &&
        pcm?.contextFrame !== undefined &&
        pcm?.frontierFrame !== undefined &&
        compareRationalTimes(T, {
          value: pcm.startFrame + pcm.frontierFrame - pcm.contextFrame,
          rate: pcm.admission.rate,
        }) >= 0
      ) {
        if (pcm.frontierCrossedAt === null)
          pcm.frontierCrossedAt = presentClockMs();
        else if (
          !pcm.stopping &&
          presentClockMs() - pcm.frontierCrossedAt > 100
        ) {
          failScheduledAudio('transport gate closure was not acknowledged');
          return;
        }
        scheduleTick();
        return;
      }
      if (coldFirstTick) {
        coldFirstTick = false;
        coldProof('first-tick', {
          compositionTime: T,
          schedulingTime: now,
          anchor: nativeAnchor.wallMs,
          futureAnchorWait: Math.max(0, nativeAnchor.wallMs - now),
        });
      }

      if (compareRationalTimes(T, scopeEnd()) >= 0) {
        if (audioBackend === 'pcm' && pcmRun) {
          scheduleTick();
          return;
        }
        cancelPreparedBoundary();
        currentTime = scopeLastSample();
        isPlaying = false;
        nativeAnchor = null;
        nativeLastPresentMs = null;
        pauseAllMedia();
        void enqueueRender(currentTime, ++renderGeneration);
        notify();
        return;
      }

      const evaluation = scopedEvaluation(T);
      images.clearPins();
      if (preparedBoundary) {
        for (const path of preparedBoundary.imagePaths) images.pin(path);
      }
      const tree = videoTree(evaluation);
      const blocked = blockedTracks(evaluation);
      const isHidden = (nodeId: string, ancestry: readonly string[]) =>
        videoHidden(nodeId, ancestry) || blocked.has(nodeId);
      const drawnLeafIndices = getDrawnLeafIndices(tree, isHidden);
      const occurrenceKeys = collectVideoOccurrenceKeys(
        evaluation.video_contributions
      );

      const currentDrawnOccurrenceKeys = drawnVideoKeys(evaluation, tree);
      for (
        let index = 0;
        index < evaluation.video_contributions.length;
        index++
      ) {
        const contribution = evaluation.video_contributions[index];
        const key = occurrenceKeys[index];
        if (
          !contribution?.bundle_path ||
          !key ||
          currentDrawnOccurrenceKeys.has(key) ||
          hiddenWarmSeen.has(key) ||
          hiddenWarmInFlight.size >= 2 ||
          preparedBoundary?.keys.has(key) ||
          nativeRings.has(key) ||
          !inferMediaMimeType(contribution.bundle_path).startsWith('video/')
        )
          continue;
        hiddenWarmSeen.add(key);
        hiddenWarmInFlight.add(key);
        const frames: VideoFrame[] = [];
        void prepareLeaf(contribution, key, renderGeneration, frames).finally(
          () => {
            closeFrames(frames);
            hiddenWarmInFlight.delete(key);
          }
        );
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
            if (!mediaFailures.has(contrib.bundle_path)) {
              void startSequence(T, true);
              return;
            }
          } else {
            images.pin(contrib.bundle_path);
          }
          continue;
        }
        if (!mime.startsWith('video/')) continue;
        const fidelity = effectFidelity(
          contrib.active_effects,
          contrib.node_id
        );
        if (fidelity.kind === 'freeze') {
          const key = occurrenceKeys[idx];
          const video = key ? videos.get(key) : undefined;
          const timing = videoTimingCache.get(contrib.bundle_path);
          const target =
            videoDecoderTime(contrib.source_time, timing ?? null) ??
            decoderLocalSeconds(contrib.source_time);
          if (
            (!video || decodedAt.get(video.element) !== target) &&
            !mediaFailures.has(contrib.bundle_path) &&
            !(key && videoTimingFailures.has(key))
          ) {
            void startSequence(T, true);
            return;
          }
          continue;
        }

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
      const candidate = preparedBoundary;
      const enteringAudio: {
        key: string;
        contribution: OtioAudioContribution;
      }[] = [];
      if (
        audioBackend === 'native' &&
        (drawnSetChanged ||
          (candidate && compareRationalTimes(T, candidate.at) >= 0))
      ) {
        const previousKeys = new Set(
          collectAudioOccurrenceKeys(
            scopedEvaluation(currentTime).audio_contributions
          )
        );
        const currentAudioKeys = collectAudioOccurrenceKeys(
          evaluation.audio_contributions
        );
        evaluation.audio_contributions.forEach((contribution, index) => {
          const key = currentAudioKeys[index];
          if (
            key &&
            !previousKeys.has(key) &&
            trackAudible(contribution.track_id)
          )
            enteringAudio.push({ key, contribution });
        });
      }
      const hasEnteringAudio =
        audioBackend === 'native' && enteringAudio.length > 0;

      const onlyRetiring =
        drawnSetChanged &&
        !hasEnteringAudio &&
        [...currentDrawnOccurrenceKeys].every((key) =>
          lastDrawnOccurrenceKeys.has(key)
        );
      const joinedPrepared =
        (drawnSetChanged || hasEnteringAudio) &&
        candidate !== null &&
        candidate.status === 'ready' &&
        candidate.anchor === nativeAnchor &&
        candidate.generation === renderGeneration &&
        candidate.scope === scopeEpoch &&
        compareRationalTimes(T, candidate.at) >= 0 &&
        enteringAudio.every(({ key, contribution }) => {
          const audio = candidate.audio.get(key);
          const fidelity = effectFidelity(
            contribution.active_effects,
            contribution.node_id
          );
          return (
            !!audio &&
            audios.get(key) === audio &&
            !audio.failed &&
            !audio.element.error &&
            fidelity.kind === 'ok' &&
            audio.element.playbackRate === fidelity.rate &&
            !audio.element.paused &&
            !audio.element.seeking &&
            audio.element.readyState >= HAVE_CURRENT_DATA &&
            Math.abs(
              audio.element.currentTime -
                decoderLocalSeconds(contribution.source_time)
            ) <=
              2 / Math.max(1, clock.rate)
          );
        }) &&
        [...candidate.keys].every(
          (key) =>
            !currentDrawnOccurrenceKeys.has(key) ||
            candidate.rings.get(key) === nativeRings.get(key)
        ) &&
        [...currentDrawnOccurrenceKeys].every(
          (key) => lastDrawnOccurrenceKeys.has(key) || candidate.keys.has(key)
        );
      if (
        (drawnSetChanged || hasEnteringAudio) &&
        !onlyRetiring &&
        !joinedPrepared
      ) {
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
        if (ring && ring.videoElement.playbackRate !== leaf.rL) {
          allApproved = false;
          failureResyncNeeded = true;
        }
        if (
          !ring ||
          ring.hasLostContext() ||
          !ring.hasTag(leaf.req, ring.captureEpoch)
        ) {
          allApproved = false;
          if (ring?.hasLostContext()) {
            ring.resetEpoch(ring.captureEpoch + 1);
          }
        }

        if (ring && ring.lastProgressWallMs !== null) {
          const t = ring.lastProgressTag ?? leaf.req;
          const stallWindowSec =
            (leaf.timing.ends[t] ?? leaf.timing.ends[leaf.req] ?? 0) -
            (leaf.timing.starts[t] ?? leaf.timing.starts[leaf.req] ?? 0);
          const stallLimit = Math.max(
            3 * (stallWindowSec / leaf.rL) * 1000,
            100
          );
          if (now - ring.lastProgressWallMs > stallLimit) {
            failureResyncNeeded = true;
            break;
          }
        }
      }

      const computePresentLimitMs = (): number => {
        let limit = 100;
        for (const leaf of drawnNativeLeaves) {
          const windowSec =
            (leaf.timing.ends[leaf.req] ?? 0) -
            (leaf.timing.starts[leaf.req] ?? 0);
          const leafLimit = Math.max(2 * (windowSec / leaf.rL) * 1000, 100);
          if (leafLimit > limit) limit = leafLimit;
        }
        return limit;
      };

      if (!allApproved) {
        if (
          nativeLastPresentMs !== null &&
          now - nativeLastPresentMs > computePresentLimitMs()
        ) {
          failureResyncNeeded = true;
        }
      }

      const triggerFailureResync = (): void => {
        failureResyncTimestamps = failureResyncTimestamps.filter(
          (t) => now - t <= 10000
        );
        failureResyncTimestamps.push(now);
        if (failureResyncTimestamps.length >= 3) {
          fallbackToSeekCadence();
          return;
        }
        void startSequence(T, true);
      };

      if (failureResyncNeeded) {
        triggerFailureResync();
        return;
      }

      if (!allApproved) {
        if (!isNativeHolding) {
          isNativeHolding = true;
          notify();
        }
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
            const timing = videoTimingCache.get(contrib.bundle_path);
            const target =
              videoDecoderTime(contrib.source_time, timing ?? null) ??
              decoderLocalSeconds(contrib.source_time);
            if (!video || decodedAt.get(video.element) !== target)
              return { kind: 'empty' as const };
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
          const slot = ring.findSlotWithTag(req, ring.captureEpoch);
          if (!slot) return { kind: 'empty' as const };
          return {
            kind: 'image' as const,
            source: slot.canvas,
            alpha: contrib.alpha,
          };
        });

      let presented = false;
      try {
        presented = paint(evaluation, tree, leaves);
      } catch {}
      if (!presented && audioBackend === 'pcm' && pcmRun) {
        pcmProof('error', pcmRun.generation, {
          stage: 'visual',
          code: 'compositor-failed',
        });
        failScheduledAudio('video compositor failed');
        return;
      }

      if (presented && !graphicsLost && !isCanvasContextLost(canvas)) {
        if (audioBackend === 'pcm' && pcmRun) {
          for (const hold of pcmRun.holds) hold.releaseThrough(T);
          pcmRun.holds = pcmRun.holds.filter((hold) => {
            if (compareRationalTimes(hold.through, T) > 0) return true;
            hold.release();
            return false;
          });
        }
        if (onlyRetiring || joinedPrepared) {
          for (const key of lastDrawnOccurrenceKeys) {
            if (currentDrawnOccurrenceKeys.has(key)) continue;
            const ring = nativeRings.get(key);
            if (!ring) continue;
            ring.videoElement.pause();
            decodedAt.delete(ring.videoElement);
            ring.release();
            if (nativeRings.get(key) === ring) nativeRings.delete(key);
          }
          lastDrawnOccurrenceKeys = currentDrawnOccurrenceKeys;
          if (joinedPrepared && candidate) {
            for (const { key, contribution } of enteringAudio) {
              const audio = candidate.audio.get(key);
              if (!audio) continue;
              const gain = Math.max(
                0,
                contribution.volume * contribution.transition_weight
              );
              applyAudioGain(audio, gain, trackAudible(contribution.track_id));
              audio.element.setAttribute('data-active', 'true');
              candidate.audio.delete(key);
              candidate.audioKeys.delete(key);
            }
          }
          if (joinedPrepared && candidate && preparedBoundary === candidate) {
            for (const key of currentDrawnOccurrenceKeys) {
              candidate.keys.delete(key);
              candidate.rings.delete(key);
            }
          }
        }
        if (
          candidate &&
          preparedBoundary === candidate &&
          candidate.status === 'ready' &&
          compareRationalTimes(T, candidate.at) >= 0
        ) {
          for (const index of drawnLeafIndices) {
            const path = evaluation.video_contributions[index]?.bundle_path;
            if (path && imageElements.has(path))
              candidate.imagePaths.delete(path);
          }
          if (
            candidate.keys.size === 0 &&
            candidate.audioKeys.size === 0 &&
            candidate.imagePaths.size === 0
          )
            preparedBoundary = null;
        }
        if (
          candidate &&
          preparedBoundary === candidate &&
          candidate.status === 'failed' &&
          candidate.keys.size === 0 &&
          candidate.audioKeys.size === 0 &&
          compareRationalTimes(T, candidate.at) >= 0 &&
          [...candidate.imagePaths].every(
            (path) => imageElements.has(path) || mediaFailures.has(path)
          )
        ) {
          preparedBoundary = null;
        }
        nativeLastPresentMs = now;
        isNativeHolding = false;
        currentTime = T;
        if (audioBackend === 'pcm' && pcmRun) {
          const run = pcmRun;
          void renewPcmFrontier(run)
            .then((accepted) => {
              if (!accepted && pcmRun === run && !run.stopping)
                failScheduledAudio('audiovisual frontier is unavailable');
            })
            .catch(() => {
              if (pcmRun === run && !run.stopping)
                failScheduledAudio('PCM scheduling failed');
            });
          const frame = Math.floor((T.value * run.admission.rate) / T.rate);
          const target = Math.min(
            Math.floor(
              (scopeEnd().value * run.admission.rate) / scopeEnd().rate
            ),
            Math.ceil(
              (frame +
                Math.floor(run.admission.rate * OTIO_PCM_TARGET_LEAD_SECONDS)) /
                OTIO_PCM_PACKET_FRAMES
            ) * OTIO_PCM_PACKET_FRAMES
          );
          if (!run.stopping && !run.loading && target > run.preparedThrough) {
            void fillPcm(run, target).catch((error: unknown) => {
              if (pcmRun !== run || run.stopping) return;
              if (
                error instanceof Error &&
                (error.message === 'PCM byte budget exceeded' ||
                  error.message === 'PCM graph node limit exceeded')
              ) {
                const frontier = run.frontierFrame;
                if (frontier === null) {
                  failScheduledAudio(
                    'PCM resources exhausted before a committed frontier'
                  );
                  return;
                }
                const stop = Math.min(
                  frontier,
                  Math.max(
                    run.contextFrame ?? 0,
                    Math.ceil(run.context.currentTime * run.admission.rate) +
                      OTIO_PCM_MIN_LEAD_FRAMES * 2
                  )
                );
                pcmProof('starvation', run.generation, { code: error.message });
                armPcmStop(run, stop, 'resource');
                return;
              }
              pcmProof('error', run.generation, {
                stage: 'provider',
                code: error instanceof Error ? error.message : String(error),
              });
              failScheduledAudio('PCM provider failed');
            });
          }
        }
        if (coldFirstPaint) {
          coldFirstPaint = false;
          coldProof('first-paint', {
            compositionTime: T,
            schedulingTime: now,
            anchor: nativeAnchor.wallMs,
          });
        }
        void reconcileAudio(evaluation, renderGeneration);
        prepareNextBoundary();
        notify();
      } else if (
        nativeLastPresentMs !== null &&
        now - nativeLastPresentMs > computePresentLimitMs()
      ) {
        triggerFailureResync();
        return;
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

    if (audioBackend === 'pcm' && pcmRun) {
      failScheduledAudio('scheduled audio lost its video clock');
      return;
    }
    if (clockAnchor !== null && clock.rate > 0) {
      const elapsed = (now - clockAnchor.wallMs) / 1000;
      if (elapsed > 0) {
        const advanced = addRationalTimes(clockAnchor.time, {
          value: elapsed * clock.rate,
          rate: clock.rate,
        });
        if (compareRationalTimes(advanced, scopeEnd()) >= 0) {
          currentTime = scopeLastSample();
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
    const evaluation = scopedEvaluation(currentTime);
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
    const relevantFailure = (
      issue: OtioDiagnostic,
      sourcePath?: string
    ): boolean => {
      if (!scope) return true;
      const target = issue.target?.node_id;
      if (target && scopeContext.has(target)) return true;
      const path = issue.target?.media_key ?? sourcePath ?? target;
      if (!path) return true;
      return [
        ...evaluation.video_contributions,
        ...evaluation.audio_contributions,
      ].some((item) => item.bundle_path === path || item.media_key === path);
    };
    const issues = [
      ...Array.from(videoTimingFailures.values()).filter((issue) =>
        relevantFailure(issue)
      ),
      ...evaluation.diagnostics.filter(
        (issue) => !suppressedPresentationDiagnostics.has(issue)
      ),
      ...contributionIssues(evaluation),
      ...withheldAudioSampleIssues(evaluation),
      ...Array.from(mediaFailures.entries())
        .filter(([path, issue]) => relevantFailure(issue, path))
        .map(([, issue]) => issue),
    ];
    if (scope) {
      const target = doc.nodes[scope.nodeId];
      let disabled = false;
      let ancestor = target;
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        disabled ||= !ancestor.enabled;
        ancestor = ancestor.parent_id
          ? doc.nodes[ancestor.parent_id]
          : undefined;
      }
      if (disabled) {
        issues.push(
          diagnostic(
            'info',
            'supported',
            'This item is disabled and has no playback',
            scope.nodeId
          )
        );
      } else if (target && schemaBase(target.schema) === 'Gap') {
        issues.push(
          diagnostic('info', 'supported', 'Gap contains no media', scope.nodeId)
        );
      }
    }
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
      scope,
      playing: isPlaying,
      buffering:
        isBuffering ||
        isNativeHolding ||
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
    const start = scope?.range.start_time ?? { value: 0, rate: clock.rate };
    if (
      !Number.isFinite(time.value) ||
      !Number.isFinite(time.rate) ||
      time.rate <= 0 ||
      compareRationalTimes(time, start) < 0
    )
      return start;
    if (scope && compareRationalTimes(time, scopeEnd()) >= 0)
      return scopeLastSample();
    if (compareRationalTimes(time, clock.duration) > 0) return clock.duration;
    return rescaleTime(time, clock.rate);
  }

  return {
    getState,

    async play(): Promise<void> {
      if (pcmRun?.stopping) {
        pcmPlayIntent = true;
        isPlaying = true;
        isBuffering = true;
        notify();
        return;
      }
      if (isDisposed || isPlaying) return;
      if (pcmResumeFrame !== null && pcmAdmission) {
        currentTime = { value: pcmResumeFrame, rate: pcmAdmission.rate };
      }
      pcmRequestWall = presentClockMs();
      coldProof('play-request', { compositionTime: currentTime });
      if (previewBlocked()) {
        notify();
        return;
      }
      const lastFrameTime: OtioRationalTime = scope
        ? scopeLastSample()
        : {
            value: Math.max(0, clock.duration.value - 1),
            rate: clock.rate,
          };
      if (
        clock.known &&
        ((pcmResumeFrame === null &&
          compareRationalTimes(currentTime, lastFrameTime) >= 0) ||
          compareRationalTimes(currentTime, scopeEnd()) >= 0)
      ) {
        currentTime = scope?.range.start_time ?? { value: 0, rate: clock.rate };
        pcmResumeFrame = null;
      }
      const playGeneration = renderGeneration;
      const requestEpoch = ++playRequestEpoch;
      const ctx = getAudioContext();
      let selection: PcmSelection;
      try {
        if (ctx?.state === 'suspended')
          await beforePcmDeadline(ctx.resume(), pcmRequestWall);
        if (stale(playGeneration) || requestEpoch !== playRequestEpoch) return;
        if (!ctx)
          selection = { kind: 'native', reason: 'audio context unavailable' };
        else if (
          typeof ctx.getOutputTimestamp === 'function' &&
          typeof ctx.audioWorklet?.addModule === 'function' &&
          typeof AudioWorkletNode !== 'undefined' &&
          typeof Worker !== 'undefined'
        )
          selection = await beforePcmDeadline(
            admitPcmScope(ctx),
            pcmRequestWall
          );
        else selection = await admitPcmScope(ctx);
      } catch (error) {
        if (!stale(playGeneration) && requestEpoch === playRequestEpoch)
          failScheduledAudio(
            error instanceof Error ? error.message : String(error)
          );
        return;
      }
      if (stale(playGeneration) || requestEpoch !== playRequestEpoch) return;
      if (selection.kind === 'pcm') {
        // PCM selection is scope-wide and made before authored sound starts.
        audioBackend = 'pcm';
        pcmAdmission = selection.admission;
        pcmPlayIntent = true;
        mediaFailures.delete('pcm-admission');
      } else {
        if (pcmBackendStarted) {
          failScheduledAudio(
            `scheduled audio cannot resume: ${selection.reason}`
          );
          return;
        }
        audioBackend = 'native';
        pcmAdmission = null;
        mediaFailures.set(
          'pcm-admission',
          diagnostic(
            'info',
            'supported',
            `Browser-native audio timing is in use because ${selection.reason}.`,
            timelineId
          )
        );
      }
      pcmProof('backend', pcmGeneration, {
        backend: audioBackend,
        reason: selection.kind === 'native' ? selection.reason : undefined,
        scopeNodeId: scope?.nodeId ?? null,
      });
      isPlaying = true;
      failureSeekCadence = false;
      if (audioBackend === 'pcm') {
        try {
          await beforePcmDeadline(startSequence(currentTime), pcmRequestWall);
        } catch (error) {
          if (requestEpoch !== playRequestEpoch || isDisposed) return;
          renderGeneration++;
          failScheduledAudio(
            error instanceof Error ? error.message : String(error)
          );
        }
      } else {
        await startSequence(currentTime);
      }
    },

    pause(): void {
      if (isDisposed) return;
      pcmPlayIntent = false;
      playRequestEpoch++;
      pcmRecoveryWake?.();
      if (audioBackend === 'pcm' && !pcmRun && isBuffering) {
        isPlaying = false;
        isStarting = false;
        isBuffering = false;
        pauseAllMedia();
        notify();
        return;
      }
      if (
        audioBackend === 'pcm' &&
        pcmRun?.frontierFrame !== null &&
        pcmRun?.frontierFrame !== undefined &&
        !pcmRun.stopped
      ) {
        const run = pcmRun;
        const frontier = run.frontierFrame;
        if (frontier === null) return;
        const stop = Math.min(
          frontier,
          Math.max(
            run.contextFrame ?? 0,
            Math.ceil(run.context.currentTime * run.admission.rate) +
              OTIO_PCM_MIN_LEAD_FRAMES * 2
          )
        );
        isPlaying = false;
        isStarting = false;
        isBuffering = true;
        armPcmStop(run, stop, 'pause');
        notify();
        return;
      }
      if (!isPlaying && isBuffering && !isStarting) {
        pauseAllMedia();
        return;
      }
      const replaceRender = isBuffering || pendingRender !== null;
      cancelPreparedBoundary();
      renderGeneration++;
      scopeAbort.abort();
      scopeAbort = new AbortController();
      renderTail = Promise.resolve();
      renderInFlight = false;
      isNativeHolding = false;
      isPlaying = false;
      isStarting = false;
      clockAnchor = null;
      nativeAnchor = null;
      nativeLastPresentMs = null;
      if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      if (replaceRender) isBuffering = true;
      pauseAllMedia();
      notify();
      if (replaceRender) {
        const gen = renderGeneration;
        void enqueueRender(currentTime, gen).catch((error: unknown) => {
          if (stale(gen)) return;
          mediaFailures.set(
            timelineId,
            diagnostic(
              'error',
              'unsupported-browser',
              `Paused preview could not settle: ${error instanceof Error ? error.message : String(error)}`,
              timelineId
            )
          );
          isBuffering = false;
          notify();
        });
      }
    },

    async seek(time: OtioRationalTime): Promise<void> {
      if (isDisposed) return;
      playRequestEpoch++;
      pcmRecoveryWake?.();
      pcmResumeFrame = null;
      stopPcm('seek');
      cancelPreparedBoundary();
      renderGeneration++;
      scopeAbort.abort();
      scopeAbort = new AbortController();
      renderTail = Promise.resolve();
      renderInFlight = false;
      currentTime = clampTime(time);
      failureSeekCadence = false;
      clockAnchor = null;
      nativeAnchor = null;
      nativeLastPresentMs = null;
      if (isPlaying) {
        if (audioBackend === 'pcm') {
          const context = getAudioContext();
          const seekGeneration = renderGeneration;
          if (!context) {
            failScheduledAudio('audio context unavailable after seek');
            return;
          }
          const selection = await admitPcmScope(context);
          if (stale(seekGeneration)) return;
          if (selection.kind !== 'pcm') {
            failScheduledAudio(
              `seek cannot use scheduled audio: ${selection.reason}`
            );
            return;
          }
          pcmAdmission = selection.admission;
          pcmRequestWall = presentClockMs();
        }
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

    async setScope(next: OtioPlaybackScope | null): Promise<void> {
      if (isDisposed) return;
      let root: OtioNode | undefined;
      const nodes = new Set<string>();
      const context = new Set<string>();
      if (next) {
        const target = doc.nodes[next.nodeId];
        const start = next.range.start_time;
        const duration = next.range.duration;
        if (
          !target ||
          !clock.known ||
          !Number.isFinite(start.value) ||
          !Number.isFinite(start.rate) ||
          start.rate <= 0 ||
          !Number.isFinite(duration.value) ||
          !Number.isFinite(duration.rate) ||
          duration.rate <= 0 ||
          duration.value <= 0 ||
          start.value < 0 ||
          compareRationalTimes(
            addRationalTimes(start, duration),
            clock.duration
          ) > 0
        ) {
          throw new RangeError('Invalid OTIO playback scope');
        }
        root =
          schemaBase(target.schema) === 'Transition'
            ? doc.nodes[target.parent_id ?? '']
            : target;
        if (!root)
          throw new RangeError('OTIO playback scope has no owning track');
        let ancestor: OtioNode | undefined = root;
        while (ancestor && !context.has(ancestor.id)) {
          context.add(ancestor.id);
          ancestor = ancestor.parent_id
            ? doc.nodes[ancestor.parent_id]
            : undefined;
        }
        if (!context.has(timelineId))
          throw new RangeError('OTIO scope is outside the timeline');
        const pending = [root.id];
        while (pending.length) {
          const id = pending.pop()!;
          if (nodes.has(id)) continue;
          nodes.add(id);
          context.add(id);
          const node = doc.nodes[id];
          if (node) pending.push(...node.children_ids);
        }
        context.add(target.id);
      }
      pcmPlayIntent = false;
      pcmBackendStarted = false;
      playRequestEpoch++;
      pcmRecoveryWake?.();
      pcmResumeFrame = null;
      stopPcm('scope');
      cancelPreparedBoundary();
      isNativeHolding = false;
      scope = next
        ? {
            nodeId: next.nodeId,
            range: {
              start_time: { ...next.range.start_time },
              duration: { ...next.range.duration },
            },
          }
        : null;
      scopeRootId = root?.id ?? null;
      scopeNodes = nodes;
      scopeContext = context;
      isPlaying = false;
      isStarting = false;
      isBuffering = true;
      nativeMode = false;
      nativeEpoch++;
      clockAnchor = null;
      nativeAnchor = null;
      nativeLastPresentMs = null;
      if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
      }
      pauseAllMedia();
      for (const ring of nativeRings.values()) ring.release();
      nativeRings.clear();
      lastDrawnOccurrenceKeys.clear();
      lastRenderDrawnOccurrenceKeys.clear();
      lastRenderVideoContributions.clear();
      hiddenWarmSeen.clear();
      hideVisibleCanvas();
      scopeEpoch++;
      failureSeekCadence = false;
      currentTime = next ? scope!.range.start_time : clampTime(currentTime);
      scopeAbort.abort();
      scopeAbort = new AbortController();
      // Stale renders check their generation before painting or reconciling.
      // Do not let an unrelated unresolved media request hold the new scope.
      renderTail = Promise.resolve();
      const gen = ++renderGeneration;
      notify();
      await enqueueRender(currentTime, gen);
      if (stale(gen)) return;
      notify();
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
      if (audioBackend === 'pcm' && pcmRun) {
        const node = pcmRun.tracks.get(trackId);
        if (node) node.gain.value = trackAudible(trackId) ? 1 : 0;
        notify();
        return;
      }
      cancelPreparedBoundary();
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
      if (audioBackend === 'pcm' && pcmRun && track.kind === 'Audio') {
        tracks[trackId] = { ...track, solo };
        for (const [id, node] of pcmRun.tracks)
          node.gain.value = trackAudible(id) ? 1 : 0;
        notify();
        return;
      }
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
      if (audioBackend === 'pcm' && (pcmRun || pcmPlayIntent))
        failScheduledAudio('preview policy changed during scheduled playback');
      else stopPcm('policy');
      cancelPreparedBoundary();
      baseMediaPreviewAllowed = allowed;
      notify();
      if (isPlaying) {
        void startSequence(currentTime, true);
      } else {
        void enqueueRender(currentTime, ++renderGeneration);
      }
    },

    dispose(): void {
      if (isDisposed) return;
      pcmPlayIntent = false;
      pcmRecoveryWake?.();
      pcmResumeFrame = null;
      stopPcm('dispose');
      cancelPreparedBoundary();
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
      scopeAbort.abort();
      isPlaying = false;
      isStarting = false;
      for (const ring of nativeRings.values()) ring.release();
      nativeRings.clear();
      videoTimingCache.clear();
      nativeAnchor = null;
      nativeLastPresentMs = null;
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
      imageOwners.clear();
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
      observedAudioContext?.removeEventListener('sinkchange', onPcmSinkChange);
      observedAudioContext?.removeEventListener(
        'statechange',
        onPcmContextChange
      );
      observedAudioContext = null;
      if (audioContext && !options.audioContext) {
        try {
          void audioContext.close().then(
            () => pcmGateRetirements.contextClosed(),
            () => undefined
          );
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
