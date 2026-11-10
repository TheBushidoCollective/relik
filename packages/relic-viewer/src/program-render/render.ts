/**
 * Offline render of one OTIO timeline to a playable H.264/AAC MP4.
 *
 * Output frame n is at MP4 time n * den / num. It is evaluated at timeline time
 * origin + n * den / num, where origin is the timeline range's start_time, so a
 * non-zero origin is honoured. Each frame is evaluated with the viewer's
 * evaluator and composited by the viewer's compositor, so the pixels match
 * playback. Audio comes from the viewer's audio schedule and is mixed at 48 kHz
 * against the same origin. Anything the render cannot reproduce fails with
 * explicit reasons. No degraded output is made.
 */
import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
  type StreamTargetChunk,
} from 'mediabunny';
import {
  classifyOtioTransition,
  evaluateOtioAt,
  otioBundleEntry,
  readOtioImageSequence,
  type OtioDiagnostic,
  type OtioDocumentV1,
  type OtioEffect,
  type OtioEvaluationResult,
  type OtioRationalTime,
} from '@relic/format';
import {
  renderOtioVideoTree,
  type OtioPreparedLeaf,
} from '../otio-composite.ts';
import {
  mixProgramAudio,
  planProgramAudio,
  type ProgramAudioPlan,
} from './audio-mix.ts';
import {
  ProgramRenderFailure,
  failure,
  reasonForDiagnostic,
} from './failure.ts';
import type { ProgramMedia } from './media.ts';
import {
  PROGRAM_AUDIO_CHANNELS,
  PROGRAM_AUDIO_CODEC,
  PROGRAM_AUDIO_RATE,
  type ProgramRenderProgram,
  type ProgramRenderReason,
} from './protocol.ts';

const AUDIO_BITRATE = 128_000;
const VIDEO_BITS_PER_PIXEL_SECOND = 0.1;
const VIDEO_BITRATE_MIN = 500_000;
const VIDEO_BITRATE_MAX = 8_000_000;
/** One second of audio per encoded sample. */
const AUDIO_WINDOW_FRAMES = PROGRAM_AUDIO_RATE;
const MAX_FRAME_RATE = 240;
const MAX_FRAME_RATE_DENOMINATOR = 1001;
const MAX_REASONS = 64;
const AVC_CODEC_PATTERN = /^avc1\.[0-9a-f]{6}$/i;
const BYTE_BLOCK_BYTES = 1 << 20;

export interface ProgramRenderInput {
  readonly document: OtioDocumentV1;
  readonly timelineId: string;
  readonly width: number;
  readonly height: number;
  readonly maxBytes: number;
  readonly media: ProgramMedia;
  readonly createCanvas: () => HTMLCanvasElement;
}

export interface ProgramRenderedFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly program: ProgramRenderProgram;
}

/** Collects Mediabunny's writes and enforces the byte cap during writing. */
class ByteSink {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private length = 0;
  exceeded = false;

  constructor(private readonly maxBytes: number) {}

  write(chunk: StreamTargetChunk): void {
    const end = chunk.position + chunk.data.byteLength;
    if (end > this.maxBytes) {
      this.exceeded = true;
      throw new Error(`Output exceeds ${this.maxBytes} bytes`);
    }
    if (end > this.buffer.byteLength) {
      const next = new Uint8Array(
        Math.min(
          this.maxBytes,
          Math.max(end, this.buffer.byteLength * 2, BYTE_BLOCK_BYTES)
        )
      );
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(chunk.data, chunk.position);
    this.length = Math.max(this.length, end);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.buffer.subarray(0, this.length);
  }
}

function seconds(time: OtioRationalTime): number {
  return time.value / time.rate;
}

function timelineRange(
  document: OtioDocumentV1,
  timelineId: string
): { origin: OtioRationalTime; duration: OtioRationalTime } {
  const range = document.nodes[timelineId]?.timeline_range;
  const duration = range?.duration;
  if (
    !range ||
    !duration ||
    !Number.isFinite(duration.value) ||
    !Number.isFinite(duration.rate) ||
    !(duration.value > 0) ||
    !(duration.rate > 0)
  ) {
    throw failure(
      'invalid-timing',
      `Timeline ${timelineId} has no known positive duration`,
      timelineId
    );
  }
  if (range.start_time.value !== 0) {
    throw failure(
      'invalid-timing',
      `Timeline ${timelineId} starts at a non-zero origin; only origin 0 is rendered`,
      timelineId
    );
  }
  return { origin: range.start_time, duration };
}
/** Exact rational frame rate for a timeline rate, or a failure. */
export function frameRateOf(rate: number): { num: number; den: number } {
  for (let den = 1; den <= MAX_FRAME_RATE_DENOMINATOR; den++) {
    const num = Math.round(rate * den);
    if (num <= 0 || Math.abs(num / den - rate) > 1e-9 * rate) continue;
    if (num < den || num / den > MAX_FRAME_RATE) {
      throw failure(
        'invalid-timing',
        `Timeline rate ${rate} fps is outside 1 to ${MAX_FRAME_RATE} fps`
      );
    }
    return { num, den };
  }
  throw failure(
    'invalid-timing',
    `Timeline rate ${rate} has no rational form at or below ${MAX_FRAME_RATE} fps`
  );
}

/**
 * Timeline time of output frame n: origin + n * den / num, as an exact rational.
 */
export function frameTime(
  origin: OtioRationalTime,
  frame: number,
  rate: { num: number; den: number }
): OtioRationalTime {
  const fps = rate.num / rate.den;
  if (origin.value === 0) return { value: frame, rate: fps };
  return { value: (origin.value * fps) / origin.rate + frame, rate: fps };
}

/** Refuse ambiguous or mixed video grids rather than silently decimating. */
export async function compositionFrameRate(
  document: OtioDocumentV1,
  timelineId: string,
  media: Pick<ProgramMedia, 'videoFrameRate' | 'isImage'>
): Promise<{ num: number; den: number }> {
  const clips: { id: string; path: string | null; authored: number }[] = [];
  const visit = (id: string, video: boolean): void => {
    const node = document.nodes[id];
    if (!node || !node.enabled) return;
    const inVideo =
      node.schema === 'Track.1' ? node.track_kind !== 'Audio' : video;
    if (inVideo && (node.schema === 'Clip.1' || node.schema === 'Clip.2')) {
      const ref =
        node.media_references?.[node.active_media_reference_key ?? ''];
      const authored = node.source_range?.duration.rate;
      if (!ref || !authored || authored <= 1) {
        throw failure(
          'invalid-timing',
          `Video cadence on ${id} is ambiguous`,
          id
        );
      }
      if (ref.schema === 'ImageSequenceReference.1') {
        const sequence = readOtioImageSequence(ref.raw ?? ref);
        if (
          !sequence.ok ||
          ref.rate !== authored ||
          sequence.sequence.frameStep !== 1 ||
          !ref.available_range ||
          (ref.missing_frame_policy && ref.missing_frame_policy !== 'error')
        ) {
          throw failure(
            'invalid-timing',
            `Sequence cadence on ${id} cannot be certified`,
            id
          );
        }
        clips.push({ id, path: null, authored });
      } else {
        const path = ref.target_url && otioBundleEntry(ref.target_url);
        if (!path)
          throw failure('missing-media', `Video media on ${id} is missing`, id);
        if (!media.isImage(path)) clips.push({ id, path, authored });
      }
    }
    for (const child of node.children_ids) visit(child, inVideo);
  };
  visit(timelineId, false);
  if (clips.length === 0)
    throw failure('invalid-timing', 'Timeline has no certified video cadence');
  const fps = clips[0]!.authored;
  for (const clip of clips) {
    const measured =
      clip.path === null
        ? clip.authored
        : await media.videoFrameRate(clip.path);
    if (clip.authored !== fps || Math.abs(measured - fps) > fps * 1e-5) {
      throw failure(
        'invalid-timing',
        `Source cadence on ${clip.id} differs from its composition grid`,
        clip.id
      );
    }
  }
  return frameRateOf(fps);
}

export function isDisabled(document: OtioDocumentV1, nodeId: string): boolean {
  const seen = new Set<string>();
  let id: string | null = nodeId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const node = document.nodes[id];
    if (!node) break;
    if (!node.enabled) return true;
    id = node.parent_id;
  }
  return false;
}

export function assertCanvasAvailable(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  const target = canvas as HTMLCanvasElement & {
    isContextLost?: () => boolean;
  };
  if (!context || target.isContextLost?.() || context.isContextLost?.()) {
    throw failure('render-failed', 'Canvas context was lost');
  }
}

function effectReason(
  effect: OtioEffect,
  nodeId: string
): ProgramRenderReason | null {
  if (effect.schema === 'FreezeFrame.1') return null;
  if (effect.schema === 'LinearTimeWarp.1') {
    const scalar = effect.time_scalar;
    if (typeof scalar !== 'number' || !Number.isFinite(scalar)) {
      return {
        code: 'unsupported-effect',
        message: `LinearTimeWarp on ${nodeId} has no finite time_scalar`,
        node_id: nodeId,
      };
    }
    if (scalar < 0) {
      return {
        code: 'unsupported-effect',
        message: `Reverse playback on ${nodeId} is not rendered`,
        node_id: nodeId,
      };
    }
    return null;
  }
  return {
    code: 'unsupported-effect',
    message: `Effect ${effect.name || effect.effect_name || effect.schema} on ${nodeId} is not rendered`,
    node_id: nodeId,
  };
}

/**
 * Structural features of the timeline subtree that cannot be rendered. They
 * fail the whole timeline, even where a feature never reaches a frame, so an
 * unsupported item is never silently omitted.
 */
export function staticReasons(
  document: OtioDocumentV1,
  timelineId: string
): ProgramRenderReason[] {
  const reasons: ProgramRenderReason[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = document.nodes[id];
    if (!node) return;
    for (const diagnostic of node.diagnostics ?? []) {
      const code = reasonForDiagnostic(diagnostic);
      if (code) {
        reasons.push({ code, message: diagnostic.message, node_id: id });
      }
    }
    for (const effect of node.effects ?? []) {
      if (!effect.enabled) continue;
      const reason =
        node.schema === 'Clip.1' || node.schema === 'Clip.2'
          ? effectReason(effect, id)
          : {
              code: 'unsupported-effect' as const,
              message: `Effect on ${id} is not applied to its children`,
              node_id: id,
            };
      if (reason) reasons.push(reason);
    }
    if (
      node.schema === 'Transition.1' &&
      classifyOtioTransition(node) === 'opaque'
    ) {
      reasons.push({
        code: 'unsupported-transition',
        message: `Transition ${node.transition_type || '(missing type)'} is not SMPTE_Dissolve`,
        node_id: id,
      });
    }
    for (const child of node.children_ids) visit(child);
  };
  visit(timelineId);
  return reasons;
}

function diagnosticFailures(
  diagnostics: readonly OtioDiagnostic[]
): ProgramRenderReason[] {
  const reasons: ProgramRenderReason[] = [];
  for (const diagnostic of diagnostics) {
    const code = reasonForDiagnostic(diagnostic);
    if (code) {
      const node = diagnostic.target?.node_id;
      reasons.push(
        node === undefined
          ? { code, message: diagnostic.message }
          : { code, message: diagnostic.message, node_id: node }
      );
    }
  }
  return reasons;
}

/** Throws on the first frame-level feature that the render cannot reproduce. */
function assertFrameFaithful(evaluation: OtioEvaluationResult): void {
  for (const active of evaluation.active_transitions) {
    if (active.render_kind === 'opaque') {
      throw failure(
        'unsupported-transition',
        `Transition ${active.node_id} is not SMPTE_Dissolve`,
        active.node_id
      );
    }
  }
  const reasons = [
    ...diagnosticFailures(evaluation.diagnostics),
    ...evaluation.video_contributions.flatMap((contribution) =>
      diagnosticFailures(contribution.diagnostics)
    ),
  ];
  const first = reasons[0];
  if (first) {
    throw new ProgramRenderFailure([first]);
  }
}

async function probeEncoders(
  width: number,
  height: number,
  bitrate: number
): Promise<void> {
  if (
    typeof VideoEncoder !== 'function' ||
    typeof AudioEncoder !== 'function' ||
    typeof VideoFrame !== 'function'
  ) {
    throw failure(
      'encoder-unavailable',
      'WebCodecs video and audio encoders are not available in this browser'
    );
  }
  const video = await canEncodeVideo('avc', { width, height, bitrate });
  const audio = await canEncodeAudio('aac', {
    numberOfChannels: PROGRAM_AUDIO_CHANNELS,
    sampleRate: PROGRAM_AUDIO_RATE,
    bitrate: AUDIO_BITRATE,
  });
  if (!video || !audio) {
    throw failure(
      'encoder-unavailable',
      `H.264/AAC encoding is unavailable for ${width}x${height}`
    );
  }
}

function clampBitrate(value: number): number {
  return Math.min(VIDEO_BITRATE_MAX, Math.max(VIDEO_BITRATE_MIN, value));
}

function checkoutPool(
  create: () => HTMLCanvasElement,
  width: number,
  height: number
): (depth: number) => HTMLCanvasElement {
  const pool: HTMLCanvasElement[] = [];
  return (depth) => {
    while (pool.length <= depth) {
      const canvas = create();
      canvas.width = width;
      canvas.height = height;
      pool.push(canvas);
    }
    const canvas = pool[depth]!;
    assertCanvasAvailable(canvas);
    return canvas;
  };
}

/** Reject a sequence selection that fell across a floating-point frame boundary. */
export function assertSequenceFrame(
  offset: number,
  startFrame: number,
  frameStep: number,
  actual: number | undefined
): void {
  if (!Number.isFinite(offset)) {
    throw failure('invalid-timing', 'Invalid sequence frame offset');
  }
  const nearest = Math.round(offset);
  const index = Math.floor(
    Math.abs(offset - nearest) < 1e-7 ? nearest : offset
  );
  if (actual !== startFrame + index * frameStep) {
    throw failure('invalid-timing', 'Unreliable sequence frame selection');
  }
}

async function prepareLeaves(
  media: ProgramMedia,
  document: OtioDocumentV1,
  evaluation: OtioEvaluationResult,
  opened: VideoFrame[]
): Promise<OtioPreparedLeaf[]> {
  const leaves: OtioPreparedLeaf[] = [];
  for (const contribution of evaluation.video_contributions) {
    const node = document.nodes[contribution.node_id];
    const ref = node?.media_references?.[node.active_media_reference_key ?? ''];
    if (ref?.schema === 'ImageSequenceReference.1') {
      const parsed = readOtioImageSequence(ref.raw ?? ref);
      if (!parsed.ok || !ref.rate)
        throw failure(
          'invalid-timing',
          `Invalid sequence on ${contribution.node_id}`
        );
      const offset =
        (contribution.source_time.value * ref.rate) /
        contribution.source_time.rate;
      assertSequenceFrame(
        offset,
        parsed.sequence.startFrame,
        parsed.sequence.frameStep,
        contribution.source_frame
      );
    }
    if (contribution.sample_kind === 'black') {
      leaves.push({ kind: 'black' });
      continue;
    }
    const path = contribution.bundle_path;
    if (path === null) {
      throw failure(
        'missing-media',
        `Clip ${contribution.node_id} has no media reference`,
        contribution.node_id
      );
    }
    if (media.isImage(path)) {
      leaves.push({
        kind: 'image',
        source: await media.image(path),
        alpha: contribution.alpha,
      });
      continue;
    }
    const sample = await media.videoSample(
      path,
      seconds(contribution.source_time)
    );
    const frame = sample.toVideoFrame();
    opened.push(frame);
    leaves.push({ kind: 'image', source: frame, alpha: contribution.alpha });
  }
  return leaves;
}

function closeSource(source: { close(): void }): void {
  try {
    source.close();
  } catch {
    // The source is already closed or never opened; nothing else to release.
  }
}

/** Render one timeline to MP4 bytes. Throws ProgramRenderFailure for anything unfaithful. */
export async function renderProgramTimeline(
  input: ProgramRenderInput
): Promise<ProgramRenderedFile> {
  const { document, timelineId, width, height, maxBytes, media } = input;
  const { origin, duration } = timelineRange(document, timelineId);
  const structural = staticReasons(document, timelineId);
  if (structural.length > 0) {
    throw new ProgramRenderFailure(structural.slice(0, MAX_REASONS));
  }
  const rate = await compositionFrameRate(document, timelineId, media);
  const frameSeconds = rate.den / rate.num;
  const frameCount = Math.ceil(seconds(duration) / frameSeconds - 1e-6);
  if (frameCount < 1) {
    throw failure('invalid-timing', 'Timeline is shorter than one frame');
  }
  const videoBitrate = clampBitrate(
    Math.round(
      width * height * (rate.num / rate.den) * VIDEO_BITS_PER_PIXEL_SECOND
    )
  );
  await probeEncoders(width, height, videoBitrate);
  const audio: ProgramAudioPlan = planProgramAudio(
    document,
    timelineId,
    origin,
    duration,
    media.allowed
  );

  const sink = new ByteSink(maxBytes);
  const checkout = checkoutPool(input.createCanvas, width, height);
  const outputCanvas = input.createCanvas();
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) {
    throw failure('render-failed', 'Output canvas context is unavailable');
  }

  let videoCodec: string | undefined;
  const videoSource = new CanvasSource(outputCanvas, {
    codec: 'avc',
    bitrate: videoBitrate,
    onEncoderConfig: (config) => {
      videoCodec = config.codec;
    },
  });
  const audioSource = new AudioSampleSource({
    codec: 'aac',
    bitrate: AUDIO_BITRATE,
  });
  const muxer = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        write: (chunk) => sink.write(chunk),
      })
    ),
  });
  muxer.addVideoTrack(videoSource, { frameRate: rate.num / rate.den });
  muxer.addAudioTrack(audioSource);

  let audioCursor = 0;
  const feedAudio = async (untilSeconds: number): Promise<void> => {
    while (
      audioCursor < audio.sampleCount &&
      audioCursor / PROGRAM_AUDIO_RATE < untilSeconds
    ) {
      const count = Math.min(
        AUDIO_WINDOW_FRAMES,
        audio.sampleCount - audioCursor
      );
      const data = await mixProgramAudio(audio, media, audioCursor, count);
      const sample = new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: PROGRAM_AUDIO_CHANNELS,
        sampleRate: PROGRAM_AUDIO_RATE,
        timestamp: audioCursor / PROGRAM_AUDIO_RATE,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
      audioCursor += count;
    }
  };

  try {
    await muxer.start();
    for (let n = 0; n < frameCount; n++) {
      const start = (n * rate.den) / rate.num;
      media.beginFrame();
      const evaluation = evaluateOtioAt(
        document,
        timelineId,
        frameTime(origin, n, rate)
      );
      assertFrameFaithful(evaluation);
      const opened: VideoFrame[] = [];
      try {
        const leaves = await prepareLeaves(media, document, evaluation, opened);
        if (!evaluation.video_composition && leaves.length > 0) {
          throw failure(
            'render-failed',
            `Frame ${n} has media but no composition tree`
          );
        }
        const outcome = renderOtioVideoTree(
          outputContext,
          width,
          height,
          evaluation.video_composition,
          leaves,
          checkout,
          (id, ancestry) =>
            isDisabled(document, id) ||
            ancestry.some((ancestor) => isDisabled(document, ancestor))
        );
        assertCanvasAvailable(outputCanvas);
        if (outcome === 'failed') {
          throw failure('render-failed', `Compositing failed at frame ${n}`);
        }
      } finally {
        for (const frame of opened) frame.close();
      }
      assertCanvasAvailable(outputCanvas);
      await videoSource.add(start, frameSeconds);
      await feedAudio(start + frameSeconds);
    }
    await feedAudio(Infinity);
    await muxer.finalize();
  } catch (error) {
    await muxer.cancel().catch(() => {});
    closeSource(videoSource);
    closeSource(audioSource);
    if (error instanceof ProgramRenderFailure) throw error;
    if (sink.exceeded) {
      throw failure('size-cap-exceeded', `Output exceeds ${maxBytes} bytes`);
    }
    throw failure(
      'render-failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (!videoCodec || !AVC_CODEC_PATTERN.test(videoCodec)) {
    throw failure(
      'encoder-unavailable',
      'The encoder reported no AVC codec string'
    );
  }
  return {
    bytes: sink.bytes(),
    program: {
      frame_rate: { num: rate.num, den: rate.den },
      frames: frameCount,
      width,
      height,
      video_codec: videoCodec,
      video_bitrate: videoBitrate,
      audio_codec: PROGRAM_AUDIO_CODEC,
      audio_rate: PROGRAM_AUDIO_RATE,
      channels: PROGRAM_AUDIO_CHANNELS,
      audio_samples: audio.sampleCount,
      range: {
        start_time: origin,
        duration,
      },
    },
  };
}
