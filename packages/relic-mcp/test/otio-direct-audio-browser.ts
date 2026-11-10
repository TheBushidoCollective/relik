import {
  DEFAULT_CLOCK_POLICY,
  OutputClock,
} from '../../relic-viewer/src/otio-output-clock';

import {
  ALL_FORMATS,
  AudioSampleSink,
  Input,
  UrlSource,
} from '../../relic-viewer/node_modules/mediabunny/dist/modules/src/index.js';
import { runNativeBanks } from './otio-native-bank-experiment';
import {
  runGainSeamExperiment,
  runLifecycleExperiment,
} from './otio-lifecycle-experiment';

(
  globalThis as typeof globalThis & {
    runGainSeamExperiment: typeof runGainSeamExperiment;
    runLifecycleExperiment: typeof runLifecycleExperiment;
  }
).runGainSeamExperiment = runGainSeamExperiment;
(
  globalThis as typeof globalThis & {
    runLifecycleExperiment: typeof runLifecycleExperiment;
  }
).runLifecycleExperiment = runLifecycleExperiment;

(
  globalThis as typeof globalThis & { runNativeBanks: typeof runNativeBanks }
).runNativeBanks = runNativeBanks;

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

async function prepare(clip: Clip, counters: { frames: number; peak: number }) {
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
function sampleAt(samples: Float32Array, index: number): number {
  const value = samples[index];
  if (value === undefined)
    throw new Error(`PCM sample out of bounds: ${index}`);
  return value;
}

function expected(
  refs: readonly [Float32Array, Float32Array],
  wrongOffset = false,
  muted = false
) {
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
      out[n] = sampleAt(out, n) + sampleAt(ref, sourceIndex) * gain;
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
    const targetSample = sampleAt(target, n);
    const d = sampleAt(actual, n) - targetSample;
    error += d * d;
    energy += targetSample * targetSample;
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
    for (const clip of clips) all.push(await prepare(clip, counters));
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
      const chunks = all[i];
      if (!clip || !chunks)
        throw new Error(`Missing clip or decoded chunks: ${i}`);
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
      for (const chunk of chunks) {
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
    for (let i = 0; i < RATE; i++)
      uncanceled[i] = sampleAt(uncanceled, i) + 0.4;
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
      if (Math.abs(sampleAt(actual, n) - sampleAt(target, n)) <= 0.003)
        continue;
      const first = n;
      while (
        n + 1 < TOTAL &&
        Math.abs(sampleAt(actual, n + 1) - sampleAt(target, n + 1)) > 0.003
      )
        n++;
      if (n - first >= 8)
        badRuns.push({
          first,
          last: n,
          actual: sampleAt(actual, first),
          expected: sampleAt(target, first),
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

// Optimistic lower-bound probe: all PCM and both independent video frames are
// prepared before the request. This does not exercise a streaming worker.
async function runIdealCold() {
  const params = new URLSearchParams(location.search);
  const guard = Number(params.get('guard') ?? '256');
  if (![0, 128, 256].includes(guard)) throw new Error('invalid guard');
  const condition = params.get('condition') ?? 'running';
  if (!['running', 'suspended'].includes(condition))
    throw new Error('invalid condition');
  const hint = params.get('hint') === '0' ? 0 : 'interactive';
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: hint });
  const diagnostic: Record<string, unknown> = {
    status: 'preparing',
    policy: DEFAULT_CLOCK_POLICY,
    policyQualification: 'candidate, not calibrated',
    observations: [],
    cleanup: 'pending',
  };
  (
    globalThis as typeof globalThis & { coldDiagnostic?: unknown }
  ).coldDiagnostic = diagnostic;
  const cleanup: Array<() => void> = [];
  try {
    const refs = await reference('/bed.f32');
    const counters = { frames: 0, peak: 0 };
    const clip: Clip = { url: '/bed.wav', source: 12000, start: 0, end: 12000 };
    const chunks = await prepare(clip, counters);
    const images = await Promise.all(
      ['/frame0.png', '/frame1.png'].map(async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`frame fetch ${r.status}`);
        return createImageBitmap(await r.blob());
      })
    );
    cleanup.push(() => {
      for (const image of images) image.close();
    });
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    document.body.style.margin = '0';
    document.body.replaceChildren(canvas);
    const gc = canvas.getContext('2d', { willReadFrequently: true });
    if (!gc || !images[0] || !images[1])
      throw new Error('Missing canvas or frames');
    gc.imageSmoothingEnabled = false;
    const image0 = images[0],
      image1 = images[1];
    gc.drawImage(image0, 0, 0, 640, 160);
    const pixel0 = gc.getImageData(0, 0, 640, 160).data;
    gc.drawImage(image1, 0, 0, 640, 160);
    const pixel1 = gc.getImageData(0, 0, 640, 160).data;
    let diff = 0;
    for (let n = 0; n < pixel0.length; n++)
      diff += Math.abs((pixel0[n] ?? 0) - (pixel1[n] ?? 0));
    if (diff < 10000) throw new Error('Video frames indistinguishable');
    gc.drawImage(image0, 0, 0, 640, 160);
    const code = `class Recorder extends AudioWorkletProcessor { process(inputs) { const x=inputs[0][0]; if(x) this.port.postMessage({frame:currentFrame, samples:x.slice()}); return true; } } registerProcessor('ideal-recorder', Recorder);`;
    const workletUrl = URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })
    );
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const master = ctx.createGain();
    const tap = new AudioWorkletNode(ctx, 'ideal-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silent = ctx.createGain();
    silent.gain.value = 0;
    master.connect(tap);
    tap.connect(silent);
    silent.connect(ctx.destination);
    const blocks: { frame: number; samples: Float32Array }[] = [];
    tap.port.onmessage = (e) => blocks.push(e.data);
    cleanup.push(() => {
      master.disconnect();
      tap.disconnect();
      silent.disconnect();
    });
    diagnostic.blocks = blocks;
    const sources = chunks.map((chunk) => {
      const node = ctx.createBufferSource();
      node.buffer = chunk.buffer;
      node.connect(master);
      return node;
    });
    cleanup.push(() =>
      sources.forEach((node) => {
        try {
          node.stop();
        } catch {}
        node.disconnect();
      })
    );
    if (condition === 'running') await ctx.resume();
    let request = 0;
    let requestState = ctx.state;
    if (condition === 'suspended') {
      if (ctx.state !== 'suspended')
        throw new Error(`Expected suspended context, got ${ctx.state}`);
      const button = document.createElement('button');
      button.textContent = 'Start';
      button.style.cssText =
        'position:fixed;left:650px;top:0;width:100px;height:50px';
      document.body.append(button);
      await new Promise<void>((resolve, reject) => {
        button.addEventListener(
          'click',
          (event) => {
            if (!event.isTrusted) {
              reject(new Error('Input is not trusted'));
              return;
            }
            request = performance.now();
            requestState = ctx.state;
            diagnostic.request = request;
            diagnostic.deadline = request + 350;
            const timeout = setTimeout(
              () => reject(new Error('resume exceeded startup deadline')),
              350
            );
            ctx.resume().then(
              () => {
                clearTimeout(timeout);
                resolve();
              },
              (error) => {
                clearTimeout(timeout);
                reject(error);
              }
            );
          },
          { once: true }
        );
        (globalThis as typeof globalThis & { coldReady?: boolean }).coldReady =
          true;
      });
      button.remove();
    }
    if (condition === 'running') {
      request = performance.now();
      requestState = ctx.state;
    }
    const observationRecords: unknown[] = [];
    const validator = new OutputClock(request, DEFAULT_CLOCK_POLICY, (record) =>
      observationRecords.push(record)
    );
    diagnostic.request = request;
    diagnostic.deadline = validator.deadline;
    diagnostic.generation = 1;
    diagnostic.observations = observationRecords;
    const fault = params.get('fault') ?? 'none';
    diagnostic.fault = fault;
    diagnostic.rawBridgeSamples = [];
    let frozen: AudioTimestamp | undefined;
    const bridgeSamples: {
      before: number;
      after: number;
      clock: AudioTimestamp;
    }[] = [];
    const recordBridge = () => {
      const before = performance.now();
      const contextBefore = ctx.currentTime;
      const state = ctx.state;
      const clock = ctx.getOutputTimestamp();
      const contextAfter = ctx.currentTime;
      const after = performance.now();
      const raw = { ...clock };
      (diagnostic.rawBridgeSamples as unknown[]).push({
        before,
        after,
        clock: raw,
      });
      let injectedContext: number | undefined = clock.contextTime;
      let injectedPerformance: number | undefined = clock.performanceTime;
      if (validator.state === 'playing') {
        if (fault === 'nan') injectedContext = NaN;
        if (fault === 'missing') injectedContext = undefined;
        if (fault === 'infinity') injectedPerformance = Infinity;
        if (fault === 'jump' && typeof clock.contextTime === 'number')
          injectedContext = clock.contextTime - 0.054015;
        if (fault === 'stagnant') {
          frozen ??= raw;
          injectedContext = frozen.contextTime;
          injectedPerformance = frozen.performanceTime;
        }
      }
      const outcome = validator.observe({
        readBegin: before,
        readEnd: after,
        contextBefore,
        contextAfter,
        state,
        contextTime: injectedContext,
        performanceTime: injectedPerformance,
      });
      bridgeSamples.push({ before, after, clock });
      diagnostic.state = validator.state;
      if (validator.state === 'failed' || validator.state === 'interrupted')
        throw new Error(`output clock ${outcome.reason}`);
      return clock;
    };
    for (;;) {
      recordBridge();
      if (validator.state === 'calibrated') break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 8);
      await promise;
    }
    const bridgeBeforePerf = performance.now();
    const bridge = recordBridge();
    const bridgeAfterPerf = performance.now();
    if (validator.state !== 'calibrated')
      throw new Error('clock lost before scheduling');
    const { contextTime, performanceTime } = bridge;
    if (contextTime === undefined || performanceTime === undefined)
      throw new Error('clock missing');
    const minimumTimerStep = null;
    validator.arm();
    const requestContextTime = ctx.currentTime;
    const f0 = Math.ceil((requestContextTime * RATE + guard) / 128) * 128;
    const c0 = f0 / RATE;
    diagnostic.f0 = f0;
    diagnostic.c0 = c0;
    diagnostic.sourceFrameAtF0 = 12000;
    if (
      performanceTime + (c0 - contextTime) * 1000 + 1000 / 30 >
      validator.deadline
    )
      throw new Error('insufficient startup deadline');
    recordBridge();
    if (ctx.currentTime >= c0) throw new Error('scheduling lead expired');
    for (const [index, chunk] of chunks.entries()) {
      const source = sources[index];
      if (!source) throw new Error('Missing scheduled node');
      source.start(c0 + chunk.timeline / RATE, 0, chunk.frames / RATE);
    }
    validator.start();
    recordBridge();
    const outputEpochPerf = performanceTime + (c0 - contextTime) * 1000;
    let canvasChangedPerf = 0;
    let wakeupPerf = 0;
    const intendedDeadline = outputEpochPerf + 1000 / 30;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('video render timeout')),
        1000
      );
      const tick = () => {
        try {
          wakeupPerf = performance.now();
          const clock = recordBridge();
          if (
            typeof clock.contextTime !== 'number' ||
            !Number.isFinite(clock.contextTime) ||
            typeof clock.performanceTime !== 'number' ||
            !Number.isFinite(clock.performanceTime)
          ) {
            clearTimeout(timeout);
            reject(new Error('output clock unavailable at presentation'));
            return;
          }
          const nowOutput =
            clock.contextTime + (wakeupPerf - clock.performanceTime) / 1000;
          if (nowOutput >= c0 + 1 / 30) {
            gc.drawImage(image1, 0, 0, 640, 160);
            canvasChangedPerf = performance.now();
            clearTimeout(timeout);
            resolve();
          } else
            setTimeout(tick, Math.max(0, (c0 + 1 / 30 - nowOutput) * 1000));
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      setTimeout(tick, Math.max(0, intendedDeadline - performance.now()));
    });
    recordBridge();
    const captureUntil = performance.now() + 350;
    while (performance.now() < captureUntil) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 16);
      await promise;
      recordBridge();
    }
    const actual = new Float32Array(12000);
    const seen = new Uint8Array(12000);
    for (const block of blocks)
      for (let i = 0; i < block.samples.length; i++) {
        const index = block.frame + i - f0;
        if (index >= 0 && index < actual.length) {
          actual[index] = sampleAt(block.samples, i);
          seen[index] = 1;
        }
      }
    if (seen.some((x) => x !== 1))
      throw new Error(
        `Missing prefix samples ${seen.filter((x) => !x).length}`
      );
    let error = 0,
      shifted = 0,
      missingPrefixError = 0,
      dropoutRun = 0,
      maxDropoutFrames = 0;
    for (let n = 0; n < actual.length; n++) {
      const a = sampleAt(actual, n),
        expected = sampleAt(refs, 12000 + n),
        wrong = sampleAt(refs, 12000 + n + 240);
      error += (a - expected) ** 2;
      shifted += (a - wrong) ** 2;
      const missingPrefixSample = n < 960 ? 0 : a;
      missingPrefixError += (missingPrefixSample - expected) ** 2;
      if (Math.abs(a) < 0.000001 && Math.abs(expected) > 0.003) {
        dropoutRun++;
        maxDropoutFrames = Math.max(maxDropoutFrames, dropoutRun);
      } else dropoutRun = 0;
    }
    const pcmRmse = Math.sqrt(error / actual.length),
      shiftedRmse = Math.sqrt(shifted / actual.length),
      missingPrefixRmse = Math.sqrt(missingPrefixError / actual.length);
    const projectedEpochs = bridgeSamples.flatMap(({ clock }) =>
      typeof clock.contextTime === 'number' &&
      typeof clock.performanceTime === 'number'
        ? [clock.performanceTime + (c0 - clock.contextTime) * 1000]
        : []
    );
    const bridgeSpreadMs = projectedEpochs.length
      ? Math.max(...projectedEpochs) - Math.min(...projectedEpochs)
      : null;
    const result = {
      request,
      requestContextTime,
      state: requestState,
      condition,
      requestedLatencyHint: hint,
      actualSampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency,
      outputLatency: ctx.outputLatency,
      f0,
      c0,
      sourceFrameAtF0: 12000,
      referenceSampleAtF0: sampleAt(refs, 12000),
      firstSampleMatches: sampleAt(actual, 0) === sampleAt(refs, 12000),
      firstSamples: Array.from(actual.slice(0, 8)),
      pcmRmse,
      maxDropoutFrames,
      maxDropoutMs: (maxDropoutFrames * 1000) / RATE,
      dropoutMethod:
        'consecutive exact-zero output samples where reference exceeds 0.003; waveform zero crossings can split runs',
      shiftedRmse,
      missingPrefixRmse,
      missingPrefixControlFrames: 960,
      outputEpochPerf,
      predictedOutputEpochAfterRequestMs: outputEpochPerf - request,
      bridge,
      bridgeSamples,
      minimumObservedTimerStepMs: minimumTimerStep,
      bridgeSpreadMs,
      bridgeSamplingBracketMs: bridgeAfterPerf - bridgeBeforePerf,
      bridgeUncertainty:
        'timestamp accuracy, timer quantization, and output-device latency are not independently calibrated',
      schedulingGuardFrames: guard,
      schedulingGuardQualification:
        'qualifies only with exact prefix and dropout checks',
      intendedDeadline,
      wakeupPerf,
      canvasChangedPerf,
      canvasAfterRequestMs: canvasChangedPerf - request,
      performanceTimeOrigin: performance.timeOrigin,
      predecodedFrameDifference: diff,
      framesRetained: counters.peak,
      scheduledNodes: sources.length,
      copying: 'AudioSample trim and toAudioBuffer per packet',
      limitation: 'preprepared PCM, no bounded worker, no streaming startup',
    };
    if (
      sampleAt(actual, 0) !== sampleAt(refs, 12000) ||
      pcmRmse > 0.003 ||
      shiftedRmse < 0.01 ||
      missingPrefixRmse <= 0.003 ||
      maxDropoutFrames > 960
    )
      throw new Error(
        `PCM prefix or offset control failed: ${JSON.stringify(result)}`
      );
    diagnostic.status = 'success';
    return result;
  } catch (error) {
    diagnostic.status = 'failure';
    diagnostic.error = String(error);
    throw error;
  } finally {
    const errors: string[] = [];
    for (const dispose of cleanup.reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      await ctx.close();
    } catch (error) {
      errors.push(String(error));
    }
    diagnostic.cleanup = { contextState: ctx.state, errors };
  }
}
(
  globalThis as typeof globalThis & { runIdealCold: typeof runIdealCold }
).runIdealCold = runIdealCold;

// Independent clock probe. Arrays remain in callback order; cached worklet
// globals are recorded but never used as native-frame authority.
async function runWorkletClock() {
  const code = `
    class ClockProbe extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [{name:'native',defaultValue:0,automationRate:'a-rate'}]; }
      constructor(options) { super(); this.anchor=options.processorOptions.anchor;this.rows=[];this.ord=0;this.samples=0;this.f0=null;this.expected=null;this.fault='';this.admitted=false;
        this.port.onmessage=e=>{if(e.data.type==='checkpoint')this.port.postMessage({type:'checkpoint',nonce:e.data.nonce,end:this.lastEnd,ordinal:this.ord-1,samples:this.samples,quantumLength:this.lastLength,fault:this.fault,rows:this.rows.splice(0)});else if(e.data.type==='arm'){this.f0=e.data.f0;this.late=this.lastEnd>this.f0;}else if(e.data.type==='finish')this.port.postMessage({type:'finish',rows:this.rows.splice(0)});};
      }
      process(inputs,outputs,params) {
        const p=params.native, len=outputs[0][0].length, raw=Array.from(p), carrier=inputs[0]||[];
        const relative=Math.round(p[0]*1000000), native=this.anchor+relative, input=carrier.map(x=>Array.from(x)); let reason=this.fault;
        const warming = !this.admitted && (p.length===1 || (p[0]===0 && p[p.length-1]===0));
        if(!reason&&warming)reason='warming';
        else if(!reason&&p.length!==len)reason='held-or-shifted-param';
        else if(!reason) for(let i=0;i<p.length;i++)if(!Number.isFinite(p[i])||Math.abs(p[i]*1000000-(relative+i))>0.12) {reason='held-or-shifted-param';break;}
        if(!reason&&this.expected!==null&&native!==this.expected)reason='native-discontinuity';
        if(!reason&&this.f0!==null&&native>=this.f0) {
          if(carrier.length!==5)reason='missing-carrier';
          else for(let i=0;i<len;i++) {
            const at=native+i-this.f0;
            if(carrier[0][i]!==0.75||Math.abs(carrier[1][i]-(at%4096)/4096)>0.000001||Math.abs(carrier[2][i]-Math.floor(at/4096)/256)>0.000001) {reason='carrier-disagreement';break;}
          }
        }
        if(!reason&&this.late)reason='late-arm';
        if(reason&&reason!=='warming')this.fault=reason;
        const output=outputs[0]; let decision='silent';
        if(!reason&&this.f0!==null&&native>=this.f0&&carrier.length===5) { output[0].set(carrier[3]); output[1].set(carrier[4]); decision='pass';this.admitted=true; }
        else for(const channel of output)channel.fill(0);
        if(!reason) {this.lastEnd=native+len;this.expected=native+len;this.lastLength=len;}
        this.rows.push({ordinal:this.ord++,appendSampleOffset:this.samples,quantumLength:len,cachedCurrentFrame:currentFrame,cachedCurrentTime:currentTime,rawNative:raw,decodedNativeFrame:native,rawCarrier:input,rawOutput:output.map(x=>Array.from(x)),decision,reason});this.samples+=len;
        return true;
      }
    } registerProcessor('clock-probe',ClockProbe);`;
  const cases = [
    { construction: 'suspended', mutation: false, control: 'none' },
    { construction: 'running', mutation: true, control: 'none' },
    { construction: 'suspended', mutation: false, control: 'held' },
    { construction: 'suspended', mutation: false, control: 'shift' },
    { construction: 'suspended', mutation: false, control: 'late' },
    { construction: 'suspended', mutation: false, control: 'late-automation' },
    { construction: 'suspended', mutation: false, control: 'late-origin' },
    { construction: 'suspended', mutation: false, control: 'missing' },
  ] as const;
  const results = [];
  const selected = new URLSearchParams(location.search).get('clockcase');
  for (const spec of cases) {
    if (selected && selected !== spec.control) continue;
    const context = new AudioContext({ sampleRate: RATE });
    if (context.sampleRate !== RATE) {
      await context.close();
      throw new Error(`unexpected actual sample rate ${context.sampleRate}`);
    }
    if (spec.construction === 'running') {
      await context.resume();
      await new Promise<void>((r) => setTimeout(r, 40));
      await context.suspend();
    }
    const moduleUrl = URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const anchor = Math.ceil((context.currentTime * RATE + 4800) / 128) * 128;
    const probe = new AudioWorkletNode(context, 'clock-probe', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 5,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { anchor },
      outputChannelCount: [2],
    });
    const muted = context.createGain();
    muted.gain.value = 0;
    probe.connect(muted);
    muted.connect(context.destination);
    const param = probe.parameters.get('native');
    if (!param) throw new Error('missing native clock parameter');
    const origin = anchor + (spec.control === 'late-origin' ? 128 : 0);
    if (spec.control !== 'late-automation') {
      param.setValueAtTime(0, origin / RATE);
      param.linearRampToValueAtTime(1, (origin + 1000000) / RATE);
    }
    const messages: {
      type: string;
      nonce?: string;
      end?: number;
      rows?: unknown[];
      fault?: string;
    }[] = [];
    probe.port.onmessage = (e) => messages.push(e.data);
    await context.resume();
    const warmingDeadline = performance.now() + 5000;
    while (
      context.currentTime * RATE < anchor + 512 &&
      performance.now() < warmingDeadline
    )
      await new Promise<void>((r) => setTimeout(r, 20));
    if (context.currentTime * RATE < anchor + 512)
      throw new Error('native clock did not reach checkpoint');
    if (spec.control === 'late-automation') {
      // Actually submit a ramp whose start is in the past. A control-side
      // deadline check rejects it before a descriptor or media can be armed.
      const submittedFrame = context.currentTime * RATE;
      param.setValueAtTime(0, origin / RATE);
      param.linearRampToValueAtTime(1, (origin + 1000000) / RATE);
      const rejected = submittedFrame > origin - 512;
      if (!rejected) throw new Error('late automation did not cross deadline');
      await context.suspend();
      results.push({
        spec,
        anchor,
        submittedFrame,
        deadline: origin - 512,
        injected: true,
        deadlineReached: true,
        rejected,
        mediaArmed: false,
      });
      probe.disconnect();
      muted.disconnect();
      await context.close();
      continue;
    }
    await context.suspend();
    const nativeEndExact = context.currentTime * RATE;
    const nativeEnd = Math.round(nativeEndExact);
    if (Math.abs(nativeEndExact - nativeEnd) > 0.001)
      throw new Error('native checkpoint precision');
    const nonce = crypto.randomUUID();
    probe.port.postMessage({ type: 'checkpoint', nonce });
    for (
      let n = 0;
      n < 100 && !messages.some((m) => m.type === 'checkpoint');
      n++
    )
      await new Promise<void>((r) => setTimeout(r, 5));
    const checkpoint = messages.find(
      (m) => m.type === 'checkpoint' && m.nonce === nonce
    );
    const afterCheckpoint = context.currentTime * RATE;
    if (context.state !== 'suspended' || afterCheckpoint !== nativeEndExact)
      throw new Error('context moved during suspended checkpoint');
    if (!checkpoint || checkpoint.fault || checkpoint.end !== nativeEnd) {
      results.push({
        spec,
        nativeCheckpointFrame: nativeEnd,
        checkpointEnd: checkpoint?.end ?? null,
        anchorRejected: true,
        rows: checkpoint?.rows ?? [],
      });
      probe.disconnect();
      muted.disconnect();
      await context.close();
      continue;
    }
    const f0 = nativeEnd + 4096,
      length = 144000;
    const buffer = context.createBuffer(5, length, RATE);
    for (let n = 0; n < length; n++) {
      const position = n + (spec.control === 'shift' ? 1 : 0);
      buffer.getChannelData(0)[n] = 0.75;
      buffer.getChannelData(1)[n] = (position % 4096) / 4096;
      buffer.getChannelData(2)[n] = Math.floor(position / 4096) / 256;
      buffer.getChannelData(3)[n] = ((n % 127) - 63) / 128;
      buffer.getChannelData(4)[n] = ((n % 113) - 56) / 128;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.channelCount = 5;
    source.channelCountMode = 'explicit';
    source.channelInterpretation = 'discrete';
    if (spec.control !== 'missing') source.connect(probe);
    if (spec.control === 'held') {
      // Holding a future ramp must preserve the source-correct admitted prefix.
      const heldFrame = f0 + 2048;
      if (typeof param.cancelAndHoldAtTime !== 'function')
        throw new Error('cancelAndHoldAtTime unavailable');
      param.cancelAndHoldAtTime(heldFrame / RATE);
    }
    if (spec.control !== 'late') probe.port.postMessage({ type: 'arm', f0 });
    source.start(f0 / RATE);
    await context.resume();
    if (spec.control === 'late') {
      while (context.currentTime * RATE <= f0 + 256)
        await new Promise<void>((r) => setTimeout(r, 10));
      probe.port.postMessage({ type: 'arm', f0 });
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    if (spec.mutation)
      interval = setInterval(() => {
        const g = context.createGain();
        g.gain.value = 0;
        g.connect(context.destination);
        g.disconnect();
      }, 1);
    await new Promise<void>((r) => setTimeout(r, 3300));
    if (interval) clearInterval(interval);
    await context.suspend();
    probe.port.postMessage({ type: 'finish' });
    for (let n = 0; n < 100 && !messages.some((m) => m.type === 'finish'); n++)
      await new Promise<void>((r) => setTimeout(r, 5));
    const end = messages.find((m) => m.type === 'finish');
    if (!end?.rows) throw new Error('missing capture');
    const rows = [...(checkpoint.rows ?? []), ...end.rows] as {
      ordinal: number;
      appendSampleOffset: number;
      quantumLength: number;
      decodedNativeFrame: number;
      decision: string;
      reason: string;
      rawOutput: number[][];
    }[];
    if (spec.control === 'held') {
      const firstFault = rows.findIndex(
        (row) => row.reason === 'held-or-shifted-param'
      );
      const prefix = rows
        .slice(0, firstFault)
        .filter((row) => row.decision === 'pass');
      if (
        firstFault < 0 ||
        prefix.length === 0 ||
        prefix.some((row) => row.decodedNativeFrame < f0) ||
        rows
          .slice(firstFault)
          .some(
            (row) =>
              row.decision !== 'silent' ||
              row.rawOutput.some((channel) =>
                channel.some((sample) => sample !== 0)
              )
          )
      ) {
        throw new Error(
          'held control did not fault silently after an admitted source-correct prefix'
        );
      }
    }
    source.disconnect();
    probe.disconnect();
    muted.disconnect();
    await context.close();
    results.push({
      spec,
      nativeCheckpointFrame: nativeEnd,
      checkpointEnd: checkpoint.end,
      f0,
      sampleRate: RATE,
      carrierLength: length,
      rows,
    });
  }
  return {
    results,
    limitation: 'independent direct copier, not a production transport gate',
  };
}
(
  globalThis as typeof globalThis & { runWorkletClock: typeof runWorkletClock }
).runWorkletClock = runWorkletClock;
