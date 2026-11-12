/**
 * Same-trial capture of the audio the program renderer hands to its tee, for the sampled audio
 * arms. One fresh viewer page, one Chrome trace, one MediaStreamTrackProcessor reader over the
 * program element's captureStream() audio track, and one trusted Play.
 *
 * What is sampled: the program renderer's output as its own tee delivers it. Not the mixer, the
 * browser output stream or the device. Stamps are opaque pairing keys: they join each chunk to a
 * program render in the same trace (otio-program-audio-join.ts) and are never read as times.
 *
 * No AudioContext, createMediaStreamSource or createScriptProcessor is used here: the reader is
 * the only tap.
 */
import {
  PLAY_MARK,
  PRIMER_TRACE_CATEGORIES,
  TRACE_START_MARK,
} from './otio-program-trace.ts';
import {
  armPointer,
  pointerObservation,
} from './otio-program-primer-controls.ts';
import { VIEWER_CONTRACT, type ViewerPage } from './otio-program-viewer.ts';
import {
  AUDIO_CAPTURE_STOP_MARK,
  AUDIO_READER_START_MARK,
  AUDIO_READER_STOP_MARK,
  type CaptureRecord,
} from './otio-program-audio-join.ts';

export const AUDIO_DRAIN_QUIET_MS = 250;
/** The MediaStreamTrackProcessor maxBufferSize. Chunks are copied and closed as they arrive. */
export const AUDIO_READER_BUFFER = 512;
/** How long the early-start control waits after its element play() before the trusted click. */
export const EARLY_START_LEAD_MS = 200;

export interface CaptureOptions {
  /** The window the Play observer watches, from the trusted Play. */
  readonly seconds: number;
  /** Runs after the reader is installed and the Play observer is armed, before the trusted click. */
  readonly beforePlay?: ((page: ViewerPage) => Promise<void>) | undefined;
  /** Runs after beforePlay, immediately before the trusted click. */
  readonly beforeClick?: ((page: ViewerPage) => Promise<void>) | undefined;
}

interface WireChunk {
  readonly stampUs: number;
  readonly frames: number;
  readonly rate: number;
  readonly deliveredMs: number;
  readonly left: string;
  readonly right: string;
}

/** Installs the reader in the page. Each chunk's samples are copied as f32 planar and base64 coded. */
function installReader(): string {
  return `(() => {
  const video = document.querySelector('video.otio-program-video');
  if (!video) throw new Error('audio capture: program video missing');
  if (typeof video.captureStream !== 'function') throw new Error('captureStream unavailable');
  if (typeof MediaStreamTrackProcessor !== 'function') throw new Error('MediaStreamTrackProcessor unavailable');
  const track = video.captureStream().getAudioTracks()[0];
  if (!track) throw new Error('program captureStream has no audio track');
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: ${AUDIO_READER_BUFFER} }).readable.getReader();
  const chunks = [];
  const toBase64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const state = { chunks, lastAt: performance.now(), reader, loop: null };
  state.loop = (async () => {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const data = result.value;
      try {
        const frames = data.numberOfFrames;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
        data.copyTo(right, { planeIndex: data.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
        chunks.push({
          stampUs: data.timestamp,
          frames,
          rate: data.sampleRate,
          deliveredMs: performance.now(),
          left: toBase64(left),
          right: toBase64(right),
        });
        state.lastAt = performance.now();
      } finally {
        data.close();
      }
    }
  })();
  performance.mark(${JSON.stringify(AUDIO_READER_START_MARK)});
  window.__audioCapture = state;
  return true;
})()`;
}

/** Resolves once no chunk has arrived for AUDIO_DRAIN_QUIET_MS, then stops the reader. */
function drainReader(): string {
  return `(async () => {
  const capture = window.__audioCapture;
  await new Promise((resolve) => {
    const check = () => {
      if (performance.now() - capture.lastAt >= ${AUDIO_DRAIN_QUIET_MS}) resolve();
      else setTimeout(check, 25);
    };
    check();
  });
  performance.mark(${JSON.stringify(AUDIO_READER_STOP_MARK)});
  await capture.reader.cancel();
  await capture.loop;
  return true;
})()`;
}

function decodeFloat32(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/**
 * Captures the program renderer's audio for one trusted Play. Returns the record the join and the
 * gate read. The trace and the reader are stopped before it returns; nothing else is left running.
 */
export async function captureProgramAudio(
  page: ViewerPage,
  options: CaptureOptions
): Promise<CaptureRecord> {
  await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);
  await page.evaluate(`performance.mark(${JSON.stringify(TRACE_START_MARK)})`);
  await page.evaluate(installReader());
  await armPointer(page, 'button.otio-play', PLAY_MARK, options.seconds * 1000);
  if (options.beforePlay) await options.beforePlay(page);
  if (options.beforeClick) await options.beforeClick(page);
  await page.click('button.otio-play');
  const observation = await pointerObservation(page, PLAY_MARK);
  await page.evaluate(
    `performance.mark(${JSON.stringify(AUDIO_CAPTURE_STOP_MARK)})`
  );
  await page.evaluate(
    `(async () => { await window.${VIEWER_CONTRACT.hook}.pause(); })()`
  );
  await page.evaluate(drainReader());
  const wire = await page.evaluate<WireChunk[]>('window.__audioCapture.chunks');
  const done = await page.stopPerformanceTrace();
  return {
    chunks: wire.map((chunk) => ({
      stampUs: chunk.stampUs,
      frames: chunk.frames,
      rate: chunk.rate,
      deliveredMs: chunk.deliveredMs,
      left: decodeFloat32(chunk.left),
      right: decodeFloat32(chunk.right),
    })),
    events: done.events,
    truncated: done.truncated,
    dataLossOccurred: done.dataLossOccurred,
    // A missing resting read is recorded as null. The join fails closed on it.
    restCurrentTime: observation.restCurrentTime ?? null,
    observerFrames: observation.frames ?? [],
  };
}
