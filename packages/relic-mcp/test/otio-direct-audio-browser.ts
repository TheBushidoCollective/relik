import {
  ALL_FORMATS,
  AudioSampleSink,
  Input,
  UrlSource,
} from '../../relic-viewer/node_modules/mediabunny/dist/modules/src/index.js';

// Proof only: 48 kHz mono PCM fixtures, unit playback rate, bounded authored edit.
const RATE = 48000;
const TOTAL = 72000;
const CUT = 24000;
const FADE_START = 48000;
const FADE_END = 60000;
const MAX_DECODED_FRAMES = 200000;
type Clip = {
  url: string;
  source: number;
  start: number;
  end: number;
  fade?: 'in' | 'out';
};
const clips: Clip[] = [
  { url: '/bed.wav', source: 12000, start: 0, end: CUT },
  { url: '/dialog.wav', source: 0, start: CUT, end: TOTAL, fade: 'out' },
  { url: '/bed.wav', source: 72000, start: FADE_START, end: TOTAL, fade: 'in' },
];

async function prepare(
  ctx: AudioContext,
  clip: Clip,
  counters: { frames: number; peak: number }
) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(location.origin + clip.url),
  });
  const chunks: { buffer: AudioBuffer; timeline: number; frames: number }[] =
    [];
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`No audio track: ${clip.url}`);
    const sink = new AudioSampleSink(track);
    const first = clip.source,
      last = first + clip.end - clip.start;
    let next = first;
    for await (const sample of sink.samples(first / RATE, last / RATE)) {
      try {
        if (sample.sampleRate !== RATE || sample.numberOfChannels !== 1)
          throw new Error('Fixture format mismatch');
        const sampleStart = Math.round(sample.timestamp * RATE);
        if (Math.abs(sample.timestamp * RATE - sampleStart) > 0.01)
          throw new Error('Non-integral sample timestamp');
        const begin = Math.max(first, sampleStart),
          end = Math.min(last, sampleStart + sample.numberOfFrames);
        if (end <= begin) continue;
        if (begin !== next)
          throw new Error(`Audio packet gap or overlap: ${next} vs ${begin}`);
        const trimmed = sample.trim(begin - sampleStart, end - sampleStart);
        try {
          const buffer = trimmed.toAudioBuffer();
          counters.frames += buffer.length;
          counters.peak = Math.max(counters.peak, counters.frames);
          if (counters.frames > MAX_DECODED_FRAMES)
            throw new Error('PCM retention bound exceeded');
          chunks.push({
            buffer,
            timeline: clip.start + begin - first,
            frames: end - begin,
          });
        } finally {
          trimmed.close();
        }
        next = end;
      } finally {
        sample.close();
      }
    }
    if (next !== last)
      throw new Error(`Incomplete decoded range: ${next} != ${last}`);
    return chunks;
  } finally {
    input.dispose();
  }
}

function expected(refs: Float32Array[], wrongOffset = false, muted = false) {
  const out = new Float32Array(TOTAL);
  if (muted) return out;
  for (const clip of clips) {
    const ref = refs[clip.url === '/bed.wav' ? 0 : 1];
    for (let n = clip.start; n < clip.end; n++) {
      const sourceIndex =
        clip.source + n - clip.start + (wrongOffset ? 240 : 0);
      if (sourceIndex >= ref.length)
        throw new Error('Reference range overflow');
      const x = Math.max(
        0,
        Math.min(1, (n - FADE_START) / (FADE_END - FADE_START))
      );
      const gain = clip.fade === 'in' ? x : clip.fade === 'out' ? 1 - x : 1;
      out[n] += ref[sourceIndex] * gain;
    }
  }
  return out;
}
function metric(
  actual: Float32Array,
  target: Float32Array,
  start = 0,
  end = TOTAL
) {
  let error = 0,
    energy = 0;
  for (let n = start; n < end; n++) {
    const d = actual[n] - target[n];
    error += d * d;
    energy += target[n] * target[n];
  }
  return {
    rmse: Math.sqrt(error / (end - start)),
    referenceRms: Math.sqrt(energy / (end - start)),
  };
}
async function reference(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Reference fetch ${response.status}`);
  return new Float32Array(await response.arrayBuffer());
}

async function run() {
  const ctx = new AudioContext({ sampleRate: RATE });
  if (ctx.sampleRate !== RATE)
    throw new Error(`AudioContext sample rate ${ctx.sampleRate}`);
  const refs = await Promise.all([
    reference('/bed.f32'),
    reference('/dialog.f32'),
  ]);
  const counters = { frames: 0, peak: 0 };
  const all = [];
  const sources: AudioBufferSourceNode[] = [];
  const nodes: AudioNode[] = [];
  try {
    for (const clip of clips) all.push(await prepare(ctx, clip, counters));
    await ctx.resume();
    const master = ctx.createGain();
    const worklet = URL.createObjectURL(
      new Blob(
        [
          `
      class PcmTap extends AudioWorkletProcessor {
        constructor(options) { super(); this.start = options.processorOptions.start; this.length = options.processorOptions.length; this.samples = new Float32Array(this.length); this.count = 0; }
        process(inputs) {
          const data = inputs[0][0];
          if (data) for (let i = 0; i < data.length; i++) {
            const index = currentFrame + i - this.start;
            if (index >= 0 && index < this.length) { this.samples[index] = data[i]; this.count++; }
          }
          if (currentFrame >= this.start + this.length) {
            this.port.postMessage({ samples: this.samples, count: this.count }, [this.samples.buffer]);
            return false;
          }
          return true;
        }
      }
      registerProcessor('pcm-tap', PcmTap);
    `,
        ],
        { type: 'text/javascript' }
      )
    );
    try {
      await ctx.audioWorklet.addModule(worklet);
    } finally {
      URL.revokeObjectURL(worklet);
    }
    const startFrame = Math.ceil(((ctx.currentTime + 0.3) * RATE) / 128) * 128;
    const start = startFrame / RATE;
    const tap = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { start: startFrame, length: TOTAL },
    });
    const silent = ctx.createGain();
    silent.gain.value = 0;
    master.connect(ctx.destination);
    master.connect(tap);
    tap.connect(silent);
    silent.connect(ctx.destination);
    nodes.push(master, tap, silent);
    const done = Promise.withResolvers<{
      samples: Float32Array;
      count: number;
    }>();
    tap.port.onmessage = (event) => done.resolve(event.data);
    // A stopped scheduled source supplies a direct cancellation negative control.
    const canceled = ctx.createBufferSource();
    canceled.buffer = ctx.createBuffer(1, RATE, RATE);
    canceled.buffer.getChannelData(0).fill(0.4);
    canceled.connect(master);
    canceled.start(start);
    canceled.stop(start);
    sources.push(canceled);
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const gain = ctx.createGain();
      nodes.push(gain);
      gain.connect(master);
      if (clip.fade) {
        gain.gain.value = clip.fade === 'in' ? 0 : 1;
        gain.gain.setValueAtTime(
          clip.fade === 'in' ? 0 : 1,
          start + FADE_START / RATE
        );
        gain.gain.linearRampToValueAtTime(
          clip.fade === 'in' ? 1 : 0,
          start + FADE_END / RATE
        );
      }
      for (const chunk of all[i]) {
        const source = ctx.createBufferSource();
        sources.push(source);
        source.buffer = chunk.buffer;
        source.connect(gain);
        source.start(start + chunk.timeline / RATE, 0, chunk.frames / RATE);
      }
    }
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => timeout.reject(new Error('PCM tap timed out')),
      6000
    );
    let capture: { samples: Float32Array; count: number };
    try {
      capture = await Promise.race([done.promise, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    if (capture.count !== TOTAL)
      throw new Error(`Tap captured ${capture.count}/${TOTAL} frames`);
    const actual = capture.samples;
    const target = expected(refs);
    const good = metric(actual, target);
    const wrong = metric(actual, expected(refs, true));
    const mute = metric(actual, expected(refs, false, true));
    const uncanceled = target.slice();
    for (let i = 0; i < RATE; i++) uncanceled[i] += 0.4;
    const cancellationControl = metric(actual, uncanceled);
    const regions = {
      beforeCut: metric(actual, target, CUT - 2400, CUT),
      afterCut: metric(actual, target, CUT, CUT + 2400),
      dissolve: metric(actual, target, FADE_START, FADE_END),
      afterDissolve: metric(actual, target, FADE_END, TOTAL),
      early: metric(actual, target, 0, CUT - 2400),
      middle: metric(actual, target, CUT + 2400, FADE_START),
    };
    const badWindows = [];
    for (let n = 0; n < TOTAL; n += 480) {
      const m = metric(actual, target, n, Math.min(n + 480, TOTAL));
      if (m.rmse > 0.003)
        badWindows.push({
          start: n,
          rmse: m.rmse,
          actual: actual[n],
          target: target[n],
        });
    }
    const badRuns: {
      first: number;
      last: number;
      actual: number;
      expected: number;
    }[] = [];
    for (let n = 0; n < TOTAL; n++) {
      if (Math.abs(actual[n] - target[n]) <= 0.003) continue;
      const first = n;
      while (n + 1 < TOTAL && Math.abs(actual[n + 1] - target[n + 1]) > 0.003)
        n++;
      if (n - first >= 8)
        badRuns.push({
          first,
          last: n,
          actual: actual[first],
          expected: target[first],
        });
    }
    // WAV PCM and context share a sample rate; small tolerance covers browser float mixing.
    if (
      good.referenceRms < 0.001 ||
      good.rmse > 0.003 ||
      Object.values(regions).some((r) => r.rmse > 0.003)
    )
      throw new Error(
        `PCM mismatch ${JSON.stringify({ good, regions, badWindows, badRuns, chunks: all.map((chunks) => chunks.map((c) => [c.timeline, c.frames])) })}`
      );
    if (
      wrong.rmse < Math.max(0.01, good.rmse * 4) ||
      mute.rmse < Math.max(0.01, good.rmse * 4) ||
      cancellationControl.rmse < Math.max(0.01, good.rmse * 4)
    )
      throw new Error(
        `False control did not fail: ${JSON.stringify({ good, wrong, mute, cancellationControl })}`
      );
    return {
      sampleRate: RATE,
      frames: TOTAL,
      cutFrame: CUT,
      dissolve: [FADE_START, FADE_END],
      offsets: clips.map((c) => c.source),
      retainedPeakFrames: counters.peak,
      retentionBoundFrames: MAX_DECODED_FRAMES,
      good,
      regions,
      uncanceledControl: cancellationControl,
      wrongOffsetControl: wrong,
      muteControl: mute,
      canceledSource: 'stopped at scheduled start',
      playbackRate: 1,
      pitchSemantics:
        'unit rate only; non-unit pitch-preserving retimes remain unqualified',
      tap: 'post-gain AudioWorklet input; browser graph, not speakers',
    };
  } finally {
    for (const source of sources) {
      try {
        source.stop();
      } catch {}
      source.disconnect();
    }
    for (const node of nodes) node.disconnect();
    await ctx.close();
  }
}
(
  globalThis as typeof globalThis & { runDirectAudio: typeof run }
).runDirectAudio = run;
