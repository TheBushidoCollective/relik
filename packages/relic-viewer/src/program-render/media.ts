/**
 * Bundle media access for the offline program renderer. Every byte comes from
 * the local virtual origin for paths the request listed. Video and audio decode
 * through Mediabunny; still images through createImageBitmap.
 *
 * Audio channels: mono and stereo only, which is exactly what the viewer's
 * scheduled PCM path accepts (WAVE reader, PCM ledger and worker all reject
 * anything else). Mono is duplicated to both channels, which is the Web Audio
 * mono-to-stereo up-mix the viewer's graph performs. Any other layout, including
 * 5.1 with its LFE, is rejected with unsupported-codec rather than downmixed.
 */
import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
  VideoSampleSink,
  type AudioSample,
  type VideoSample,
} from 'mediabunny';
import { failure } from './failure.ts';
import { PROGRAM_MEDIA_PREFIX } from './protocol.ts';

/** Half a microsecond beyond a frame boundary still selects that frame. */
const FRAME_LOOKUP_EPSILON_SECONDS = 1e-6;
const IMAGE_PATH = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** Unpinned decoded images kept between frames. Pinned ones are never evicted. */
const IMAGE_CACHE_LIMIT = 8;

interface VideoState {
  readonly sink: VideoSampleSink;
  last: VideoSample | null;
  readonly frameRate: number;
  iterator: AsyncGenerator<VideoSample, void, unknown> | null;
}

interface AudioState {
  readonly sink: AudioSampleSink;
  /** Native sample rate of the track, in hertz. */
  readonly rate: number;
  readonly channels: 1 | 2;
  iterator: AsyncGenerator<AudioSample, void, unknown> | null;
  samples: AudioSample[];
  discardedBefore: number;
  ended: boolean;
}

export interface AudioInfo {
  readonly rate: number;
  readonly channels: 1 | 2;
}

/**
 * Native-rate stereo for source frames [start, start + count). `begin` and `end`
 * bound the frames the decoder actually produced; frames outside them are zero.
 */
export interface NativeRead {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly begin: number;
  readonly end: number;
}

export class ProgramMedia {
  private readonly inputs: Input[] = [];
  private readonly videos = new Map<string, Promise<VideoState>>();
  private readonly audios = new Map<string, Promise<AudioState>>();
  private readonly images = new Map<string, Promise<ImageBitmap>>();
  private readonly pinned = new Set<string>();

  /** Bundle paths the request supplied. Nothing else is fetched. */
  constructor(readonly allowed: ReadonlySet<string>) {}

  /** Called before each output frame. Images used by that frame stay alive. */
  beginFrame(): void {
    this.pinned.clear();
  }

  isImage(path: string): boolean {
    return IMAGE_PATH.test(path);
  }

  async videoFrameRate(path: string): Promise<number> {
    return (await this.video(path)).frameRate;
  }

  /** The frame whose presentation interval contains `seconds` in file time. */
  async videoSample(path: string, seconds: number): Promise<VideoSample> {
    const state = await this.video(path);
    const target = seconds + FRAME_LOOKUP_EPSILON_SECONDS;
    const last = state.last;
    if (
      last &&
      target >= last.timestamp &&
      target < last.timestamp + last.duration
    ) {
      return last;
    }
    if (!Number.isFinite(target) || seconds < 0) {
      throw failure(
        'invalid-timing',
        `Invalid source time in ${path}: ${seconds}`
      );
    }
    if (
      !state.iterator ||
      (last && (target < last.timestamp || target - last.timestamp > 1))
    ) {
      await state.iterator?.return();
      state.iterator = state.sink.samples(target);
      const first = await state.sink.getSample(target);
      state.last?.close();
      state.last = first;
    }
    while (state.last && target >= state.last.timestamp + state.last.duration) {
      const item = await state.iterator!.next();
      if (item.done) break;
      state.last.close();
      state.last = item.value;
    }
    const next = state.last;
    if (
      !next ||
      next.duration <= 0 ||
      target < next.timestamp ||
      target >= next.timestamp + next.duration
    ) {
      throw failure(
        'invalid-timing',
        `No source frame in ${path} at ${seconds} seconds`
      );
    }
    if (next.rotation !== 0 || next.flip) {
      throw failure(
        'unsupported-codec',
        `Rotation or flip in ${path} is not rendered`
      );
    }
    return next;
  }

  async image(path: string): Promise<ImageBitmap> {
    this.pinned.add(path);
    const cached = this.images.get(path);
    if (cached) {
      this.images.delete(path);
      this.images.set(path, cached);
      return cached;
    }
    const entry = this.blob(path).then((blob) => createImageBitmap(blob));
    entry.catch(() => {});
    this.images.set(path, entry);
    this.evictImages();
    return entry;
  }

  async audioInfo(path: string): Promise<AudioInfo> {
    const state = await this.audio(path);
    return { rate: state.rate, channels: state.channels };
  }

  /**
   * Decoded stereo at the native rate for native frames [start, start + count).
   * Throws if the decoder yields non-contiguous frames, because a hole would
   * otherwise read as silence.
   */
  async readNative(
    path: string,
    start: number,
    count: number
  ): Promise<NativeRead> {
    const state = await this.audio(path);
    const planes = [new Float32Array(count), new Float32Array(count)];
    const scratch = new Float32Array(count);
    const stop = start + count;
    let begin = Number.POSITIVE_INFINITY;
    let end = start;
    let covered = 0;
    if (start < state.discardedBefore) {
      await state.iterator?.return();
      for (const sample of state.samples) sample.close();
      state.samples = [];
      state.iterator = null;
      state.discardedBefore = 0;
      state.ended = false;
    }
    state.iterator ??= state.sink.samples();
    while (!state.ended) {
      const last = state.samples[state.samples.length - 1];
      if (
        last &&
        Math.round(last.timestamp * state.rate) + last.numberOfFrames >= stop
      )
        break;
      const result = await state.iterator.next();
      if (result.done) {
        state.ended = true;
        break;
      }
      const sample = result.value;
      const sampleEnd =
        Math.round(sample.timestamp * state.rate) + sample.numberOfFrames;
      if (sampleEnd <= start - state.rate) {
        state.discardedBefore = Math.max(state.discardedBefore, sampleEnd);
        sample.close();
      } else {
        state.samples.push(sample);
      }
    }
    while (state.samples.length > 0) {
      const first = state.samples[0]!;
      const sampleEnd =
        Math.round(first.timestamp * state.rate) + first.numberOfFrames;
      if (sampleEnd > start - state.rate) break;
      state.discardedBefore = Math.max(state.discardedBefore, sampleEnd);
      state.samples.shift()!.close();
    }
    for (const sample of state.samples) {
      const first = Math.round(sample.timestamp * state.rate);
      const from = Math.max(start, first);
      const to = Math.min(stop, first + sample.numberOfFrames);
      if (to <= from) continue;
      const frames = to - from;
      const offset = from - first;
      const view = scratch.subarray(0, frames);
      for (let channel = 0; channel < 2; channel++) {
        sample.copyTo(view, {
          planeIndex: state.channels === 1 ? 0 : channel,
          format: 'f32-planar',
          frameOffset: offset,
          frameCount: frames,
        });
        planes[channel]!.set(view, from - start);
      }
      begin = Math.min(begin, from);
      end = Math.max(end, to);
      covered += frames;
    }
    if (covered === 0) {
      return { left: planes[0]!, right: planes[1]!, begin: start, end: start };
    }
    if (covered !== end - begin) {
      throw failure(
        'invalid-timing',
        `Decoded audio in ${path} is not contiguous between frames ${begin} and ${end}`
      );
    }
    return { left: planes[0]!, right: planes[1]!, begin, end };
  }

  dispose(): void {
    for (const entry of this.videos.values()) {
      void entry.then(
        (state) => {
          state.last?.close();
          void state.iterator?.return();
        },
        () => {}
      );
    }
    for (const entry of this.audios.values()) {
      void entry.then(
        (state) => {
          for (const sample of state.samples) sample.close();
          void state.iterator?.return();
        },
        () => {}
      );
    }
    for (const entry of this.images.values()) {
      void entry.then(
        (bitmap) => bitmap.close(),
        () => {}
      );
    }
    this.images.clear();
    for (const input of this.inputs) input.dispose();
    this.inputs.length = 0;
  }

  private video(path: string): Promise<VideoState> {
    let entry = this.videos.get(path);
    if (!entry) {
      entry = this.openVideo(path);
      this.videos.set(path, entry);
    }
    return entry;
  }

  private audio(path: string): Promise<AudioState> {
    let entry = this.audios.get(path);
    if (!entry) {
      entry = this.openAudio(path);
      this.audios.set(path, entry);
    }
    return entry;
  }

  private async openVideo(path: string): Promise<VideoState> {
    const input = await this.open(path);
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw failure('unsupported-codec', `${path} has no video track`);
    }
    if (!(await track.canDecode())) {
      throw failure(
        'unsupported-codec',
        `The video codec in ${path} cannot be decoded by this browser`
      );
    }
    const metrics = await track.computeFrameRateMetrics({
      targetPacketCount: Infinity,
    });
    if (!metrics.frameRateIsConstant || !metrics.underlyingFrameRate) {
      throw failure(
        'invalid-timing',
        `${path} has no certified constant video cadence`
      );
    }
    return {
      sink: new VideoSampleSink(track),
      frameRate: metrics.underlyingFrameRate,
      last: null,
      iterator: null,
    };
  }

  private async openAudio(path: string): Promise<AudioState> {
    const input = await this.open(path);
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw failure('unsupported-codec', `${path} has no audio track`);
    }
    if (!(await track.canDecode())) {
      throw failure(
        'unsupported-codec',
        `The audio codec in ${path} cannot be decoded by this browser`
      );
    }
    if (!(track.sampleRate > 0)) {
      throw failure('unsupported-codec', `${path} reports no sample rate`);
    }
    const channels = track.numberOfChannels;
    if (channels !== 1 && channels !== 2) {
      throw failure(
        'unsupported-codec',
        `${path} has ${channels} audio channels; the viewer's scheduled PCM path mixes only mono and stereo, so this layout is not rendered`
      );
    }
    return {
      sink: new AudioSampleSink(track),
      rate: track.sampleRate,
      channels,
      iterator: null,
      samples: [],
      discardedBefore: 0,
      ended: false,
    };
  }

  private async open(path: string): Promise<Input> {
    const blob = await this.blob(path);
    let input: Input;
    try {
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    } catch {
      throw failure(
        'unsupported-codec',
        `${path} is not a readable media container`
      );
    }
    this.inputs.push(input);
    return input;
  }

  private async blob(path: string): Promise<Blob> {
    if (!this.allowed.has(path)) {
      throw failure('missing-media', `${path} is not in the render request`);
    }
    let response: Response;
    try {
      response = await fetch(PROGRAM_MEDIA_PREFIX + encodeURIComponent(path));
    } catch {
      throw failure('missing-media', `${path} could not be fetched`);
    }
    if (!response.ok) {
      throw failure(
        'missing-media',
        `${path} returned HTTP ${response.status}`
      );
    }
    return response.blob();
  }

  private evictImages(): void {
    if (this.images.size <= IMAGE_CACHE_LIMIT) return;
    for (const path of [...this.images.keys()]) {
      if (this.images.size <= IMAGE_CACHE_LIMIT) return;
      if (this.pinned.has(path)) continue;
      const entry = this.images.get(path);
      this.images.delete(path);
      if (entry)
        void entry.then(
          (bitmap) => bitmap.close(),
          () => {}
        );
    }
  }
}
