import {
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  FLAC,
  Input,
  MATROSKA,
  MP3,
  MP4,
  OGG,
  WAVE,
  WEBM,
  type InputAudioTrack,
} from 'mediabunny';

const MEDIA_RENDER_TIMEOUT_MS = 15_000;
const AUDIO_SECONDS = 12;
const AUDIO_MAX_FRAMES = 576_000;
const AUDIO_BARS = 240;

async function drawWaveform(
  track: InputAudioTrack,
  target: HTMLCanvasElement
): Promise<boolean> {
  const [channels, sampleRate] = await Promise.all([
    track.getNumberOfChannels(),
    track.getSampleRate(),
  ]);
  if (
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 2 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > 192_000 ||
    !(await track.canDecode())
  )
    return false;
  const first = await track.getFirstTimestamp();
  if (!Number.isFinite(first)) return false;
  const limit = Math.min(sampleRate * AUDIO_SECONDS, AUDIO_MAX_FRAMES);
  const peaks = new Float32Array(AUDIO_BARS);
  let total = 0;
  const samples = new AudioSampleSink(track).samples(
    first,
    first + AUDIO_SECONDS
  );
  try {
    for await (const sample of samples) {
      try {
        const count = Math.min(sample.numberOfFrames, limit - total);
        if (count <= 0) break;
        const plane = new Float32Array(count);
        for (let channel = 0; channel < channels; channel++) {
          sample.copyTo(plane, {
            planeIndex: channel,
            format: 'f32-planar',
            frameCount: count,
          });
          for (let at = 0; at < count; at++) {
            const amplitude = Math.abs(plane[at] ?? 0);
            if (!Number.isFinite(amplitude)) continue;
            const index = Math.min(
              AUDIO_BARS - 1,
              Math.floor(((total + at) * AUDIO_BARS) / limit)
            );
            peaks[index] = Math.max(peaks[index] ?? 0, amplitude);
          }
        }
        total += count;
      } finally {
        sample.close();
      }
      if (total >= limit) break;
    }
  } finally {
    await samples.return();
  }
  if (total === 0) return false;
  const ctx = target.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.fillStyle = '#f1f2f0';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.fillStyle = '#5a6163';
  ctx.font = '26px system-ui, sans-serif';
  ctx.fillText('Audio excerpt', 48, 68);
  ctx.fillStyle = '#1f6b64';
  const center = target.height / 2 + 20;
  const width = (target.width - 96) / AUDIO_BARS;
  for (let index = 0; index < AUDIO_BARS; index++) {
    const height = Math.max(2, Math.min(1, peaks[index] ?? 0) * 360);
    ctx.fillRect(
      48 + index * width,
      center - height / 2,
      Math.max(1, width - 1),
      height
    );
  }
  return true;
}

/**
 * Decode only local BlobSource bytes, using container formats rather than HLS
 * or URL sources. File-internal URLs are never supplied as media inputs.
 */
export async function drawPublishMedia(
  source: Blob,
  target: HTMLCanvasElement,
  maxPixels: number
): Promise<'video' | 'audio-waveform' | undefined> {
  const input = new Input({
    source: new BlobSource(source),
    formats: [MP4, WEBM, MATROSKA, OGG, MP3, WAVE, FLAC],
  });
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error('Media preview timed out')),
    MEDIA_RENDER_TIMEOUT_MS
  );
  const render = async (): Promise<'video' | 'audio-waveform' | undefined> => {
    if (!(await input.canRead())) return undefined;
    const video = await input.getPrimaryVideoTrack();
    if (video) {
      const [width, height] = await Promise.all([
        video.getCodedWidth(),
        video.getCodedHeight(),
      ]);
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width * height > maxPixels ||
        !(await video.canDecode())
      )
        return undefined;
      const frames = new CanvasSink(video, {
        width: target.width,
        height: target.height,
        fit: 'cover',
      }).canvases();
      try {
        const frame = await frames.next();
        if (frame.done) return undefined;
        const ctx = target.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(frame.value.canvas, 0, 0);
        return 'video';
      } finally {
        await frames.return();
      }
    }
    const audio = await input.getPrimaryAudioTrack();
    if (audio && (await drawWaveform(audio, target))) return 'audio-waveform';
    return undefined;
  };
  try {
    return await Promise.race([render(), timeout]);
  } finally {
    clearTimeout(timer);
    input.dispose();
  }
}
