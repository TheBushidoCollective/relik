import {
  createOtioTransportGate,
  type OtioTransportGate,
} from '../../relic-viewer/src/otio-transport-gate';
import { otioProofWorkletSource } from './otio-proof-trace';

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
const timeout = async <T>(
  promise: Promise<T>,
  ms: number,
  name: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Each invocation is a fresh context and is intended for a fresh browser profile.
export async function runLifecycleExperiment() {
  const query = new URLSearchParams(location.search);
  const graph = query.get('graph') || 'native';
  const two = query.get('lifecycle') === 'two';
  if (
    ![
      'native',
      'worklet',
      'gate',
      'gate-tap',
      'gate-carrier',
      'gate-visual',
    ].includes(graph)
  )
    throw new Error('invalid graph');
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: 'interactive',
  });
  const events: {
    event: string;
    wall: number;
    state: string;
    frame: number;
    detail?: unknown;
  }[] = [];
  const observe = (event: string, detail?: unknown) =>
    events.push({
      event,
      wall: performance.now(),
      state: context.state,
      frame: context.currentTime * context.sampleRate,
      detail,
    });
  context.addEventListener('statechange', () => observe('statechange'));
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  const source = context.createBufferSource();
  const buffer = context.createBuffer(
    2,
    context.sampleRate * 10,
    context.sampleRate
  );
  for (let c = 0; c < 2; c++) buffer.getChannelData(c).fill(c ? 0.2 : 0.1);
  source.buffer = buffer;
  let tap: AudioWorkletNode | undefined,
    carrier: AudioBufferSourceNode | undefined;
  let gate: OtioTransportGate | undefined, moduleUrl: string | undefined;
  let gateError = '';
  const samples: {
    wall: number;
    frame: number;
    contextTime: number | undefined;
    performanceTime: number | undefined;
  }[] = [];
  const sample = () => {
    const stamp = context.getOutputTimestamp();
    samples.push({
      wall: performance.now(),
      frame: context.currentTime * context.sampleRate,
      contextTime: stamp.contextTime,
      performanceTime: stamp.performanceTime,
    });
  };
  const sampler = setInterval(sample, 25);
  let visualTimer: number | undefined;
  if (graph === 'gate-visual') {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    document.body.append(canvas);
    const paint = canvas.getContext('2d');
    if (!paint) throw new Error('visual canvas unavailable');
    let tick = 0;
    visualTimer = window.setInterval(() => {
      paint.fillStyle = tick++ % 2 ? '#17374b' : '#d0d8bf';
      paint.fillRect(0, 0, canvas.width, canvas.height);
    }, 50);
  }
  const transition = async (label: string, operation: () => Promise<void>) => {
    observe(label + '-request');
    let settled = false;
    const pending = operation();
    void pending.then(
      () => {
        settled = true;
        observe(label + '-resolved');
      },
      (error) => {
        settled = true;
        observe(label + '-rejected', String(error));
      }
    );
    try {
      await timeout(pending, 2500, label);
    } catch (error) {
      if (!settled) observe(label + '-still-pending-at-timeout');
      throw error;
    }
  };
  const resume = (label: string) => transition(label, () => context.resume());
  const suspend = () => transition('suspend', () => context.suspend());
  const progress = async (label: string) => {
    const start = context.currentTime;
    for (let i = 0; i < 12; i++) {
      // The independent sampler continues even while resume is pending.
      await delay(25);
    }
    observe(label + '-progress', {
      start,
      end: context.currentTime,
      advanced: context.currentTime > start,
    });
  };
  try {
    if (context.state !== 'suspended') await suspend();
    if (graph !== 'native' && graph !== 'gate') {
      const source =
        graph === 'worklet'
          ? `class Tap extends AudioWorkletProcessor{constructor(){super();this.count=0;this.port.onmessage=()=>this.port.postMessage({count:this.count})}process(i,o){this.count++;for(let c=0;c<o[0].length;c++)if(i[0]&&i[0][c])o[0][c].set(i[0][c]);return true}}registerProcessor('lifecycle-tap',Tap);`
          : otioProofWorkletSource;
      moduleUrl = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' })
      );
      await context.audioWorklet.addModule(moduleUrl);
    }
    if (graph.startsWith('gate')) {
      const exact = context.currentTime * context.sampleRate,
        frame = Math.round(exact);
      if (!Number.isSafeInteger(frame) || Math.abs(exact - frame) > 1 / 1024)
        throw new Error('invalid frozen frame');
      gate = await timeout(
        createOtioTransportGate(
          context,
          () => {},
          (e) => {
            gateError = String(e);
            observe('gate-error', gateError);
          },
          frame
        ),
        2500,
        'gate construction'
      );
      source.connect(gate.node);
      if (graph === 'gate') gate.node.connect(sink);
      else {
        tap = new AudioWorkletNode(context, 'relic-proof-pcm', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          outputChannelCount: [1],
        });
        gate.node.connect(tap);
        tap.connect(sink);
        tap.port.onmessage = ({ data }) => {
          if (data?.kind === 'pcm') {
            observe('proof-pcm', {
              sequence: data.sequence,
              quantumFrames: data.quantumFrames,
              quantumOrdinals: data.quantumOrdinals,
              quantumLengths: data.quantumLengths,
              quantumOffsets: data.quantumOffsets,
              witness: data.witness.map((channel: Float32Array) =>
                Array.from(channel)
              ),
            });
          } else observe('proof-tap', data);
        };
        tap.port.postMessage('start');
      }
      if (graph === 'gate-carrier' || graph === 'gate-visual') {
        carrier = context.createBufferSource();
        const b = context.createBuffer(
          2,
          context.sampleRate * 10,
          context.sampleRate
        );
        b.getChannelData(0).fill(0.75);
        for (let i = 0; i < b.length; i++) b.getChannelData(1)[i] = i / 1048576;
        carrier.buffer = b;
        carrier.connect(tap!, 0, 1);
        carrier.start();
      }
    } else if (graph === 'worklet') {
      tap = new AudioWorkletNode(context, 'lifecycle-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      source.connect(tap);
      tap.connect(sink);
    } else source.connect(sink);
    source.start();
    await resume('resume-1');
    if (gate) {
      await timeout(gate.ready(), 2500, 'gate ready');
      observe('gate-ready');
    }
    await progress('resume-1');
    if (two || gate) {
      await suspend();
      if (gate) {
        const exact = context.currentTime * context.sampleRate,
          before = Math.round(exact);
        if (Math.abs(exact - before) > 1 / 1024)
          throw new Error('checkpoint conversion');
        const snapshot = await timeout(gate.checkpoint(1), 2500, 'checkpoint');
        const after = context.currentTime * context.sampleRate;
        observe('checkpoint', { before, after, snapshot });
        if (after !== exact || snapshot.lastCertifiedEnd !== before)
          throw new Error('checkpoint mismatch');
        const accepted = gate.acceptAnchor(snapshot);
        await resume('resume-2');
        await timeout(accepted, 2500, 'anchor');
        observe('anchor-accepted');
      } else await resume('resume-2');
      await progress('resume-2');
    }
    if (tap) {
      if (graph === 'worklet') {
        tap.port.onmessage = ({ data }) => observe('tap-count', data);
        tap.port.postMessage({});
      } else tap.port.postMessage('stop');
      await delay(40);
    }
    return {
      graph,
      two,
      rate: context.sampleRate,
      events,
      samples,
      gateError,
      limitation: 'silent diagnostic graph, not player qualification',
    };
  } catch (error) {
    observe('failure', String(error));
    return {
      graph,
      two,
      rate: context.sampleRate,
      events,
      samples,
      gateError,
      error: String(error),
    };
  } finally {
    clearInterval(sampler);
    clearInterval(visualTimer);
    try {
      source.stop();
    } catch {}
    source.disconnect();
    if (carrier) {
      try {
        carrier.stop();
      } catch {}
      carrier.disconnect();
    }
    tap?.disconnect();
    gate?.node.disconnect();
    sink.disconnect();
    if (context.state !== 'closed') {
      try {
        await timeout(context.close(), 2500, 'close');
      } catch (error) {
        observe('close-failed', String(error));
      }
    }
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
  }
}

// Two independent browser launches must use the same input WAV and differ only
// in intrinsic gain initialization. The marker is source-bound, not currentFrame.
export async function runGainSeamExperiment() {
  const initialized =
    new URLSearchParams(location.search).get('gain') === 'initialized';
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: 'interactive',
  });
  if (context.sampleRate !== 48000) throw new Error('sample rate mismatch');
  const response = await fetch('/indexed-stereo.wav');
  if (!response.ok) throw new Error('missing source WAV');
  const original = await context.decodeAudioData(await response.arrayBuffer());
  if (
    original.sampleRate !== 48000 ||
    original.numberOfChannels !== 2 ||
    original.length < 75904 + 1024
  )
    throw new Error('invalid source WAV');
  const code = `class SeamTap extends AudioWorkletProcessor{constructor(){super();this.out=[];this.complete=false}process(inputs){if(this.complete)return true;const a=inputs[0]||[],w=inputs[1]||[];if(w.length>=2)for(let i=0;i<w[0].length;i++){if(w[0][i]===0.75){if(a.length!==2){this.port.postMessage({error:'missing stereo'});this.complete=true;return true}this.out.push([w[1][i],a[0][i],a[1][i]])}}if(this.out.length>=1024){this.complete=true;this.port.postMessage({rows:this.out});}return true}}registerProcessor('seam-tap',SeamTap);`;
  const url = URL.createObjectURL(
    new Blob([code], { type: 'text/javascript' })
  );
  const nodes: AudioNode[] = [];
  const sources: AudioBufferSourceNode[] = [];
  try {
    await context.audioWorklet.addModule(url);
    const tap = new AudioWorkletNode(context, 'seam-tap', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [2],
    });
    const sink = context.createGain();
    sink.gain.value = 0;
    tap.connect(sink);
    sink.connect(context.destination);
    nodes.push(tap, sink);
    const seam = 112576,
      captureStart = seam - 128;
    if (context.currentTime * 48000 >= captureStart - 4096)
      throw new Error('missed exact seam scheduling lead');
    const marker = context.createBuffer(2, 1024, 48000);
    for (let i = 0; i < 1024; i++) {
      marker.getChannelData(0)[i] = 0.75;
      marker.getChannelData(1)[i] = i / 2048;
    }
    const witness = context.createBufferSource();
    witness.buffer = marker;
    witness.connect(tap, 0, 1);
    witness.start(captureStart / 48000);
    sources.push(witness);
    const results = Promise.withResolvers<{
      rows?: number[][];
      error?: string;
    }>();
    tap.port.onmessage = ({ data }) => results.resolve(data);
    for (const [offset, innerStart, innerEnd] of [
      [33600, 1, 0.912],
      [75200, 0, 0.088],
    ] as const) {
      const src = context.createBufferSource();
      src.buffer = original;
      const outerGain = context.createGain(),
        innerGain = context.createGain();
      outerGain.gain.value = 8000 / 9600;
      innerGain.gain.value = innerStart;
      outerGain.gain.setValueAtTime(8000 / 9600, 111872 / 48000);
      outerGain.gain.linearRampToValueAtTime(0.9066666666666666, seam / 48000);
      innerGain.gain.setValueAtTime(innerStart, 111872 / 48000);
      innerGain.gain.linearRampToValueAtTime(innerEnd, seam / 48000);
      src.connect(innerGain);
      innerGain.connect(outerGain);
      outerGain.connect(tap, 0, 0);
      src.start(111872 / 48000, offset / 48000, 704 / 48000);
      sources.push(src);
      nodes.push(outerGain, innerGain);
    }
    for (const [offset, inner] of [
      [34304, 0.912],
      [75904, 0.088],
    ] as const) {
      const src = context.createBufferSource();
      src.buffer = original;
      const outerGain = context.createGain(),
        innerGain = context.createGain();
      if (initialized) {
        outerGain.gain.value = 0.9066666666666666;
        innerGain.gain.value = inner;
      }
      outerGain.gain.setValueAtTime(0.9066666666666666, seam / 48000);
      outerGain.gain.linearRampToValueAtTime(1, 113472 / 48000);
      innerGain.gain.setValueAtTime(inner, seam / 48000);
      innerGain.gain.linearRampToValueAtTime(
        inner === 0.912 ? 0 : 1,
        119872 / 48000
      );
      src.connect(innerGain);
      innerGain.connect(outerGain);
      outerGain.connect(tap, 0, 0);
      src.start(seam / 48000, offset / 48000, 896 / 48000);
      sources.push(src);
      nodes.push(outerGain, innerGain);
    }
    await context.resume();
    const capture = await timeout(results.promise, 6000, 'seam capture');
    if (capture.error || capture.rows?.length !== 1024)
      throw new Error('invalid seam capture ' + JSON.stringify(capture));
    const rows = capture.rows;
    for (let i = 0; i < rows.length; i++)
      if (rows[i]?.[0] !== i / 2048)
        throw new Error('missing or shifted source witness');
    const b1 = [
        original.getChannelData(0)[34304],
        original.getChannelData(1)[34304],
      ],
      b2 = [
        original.getChannelData(0)[75904],
        original.getChannelData(1)[75904],
      ];
    const expected = b1.map(
      (x, c) =>
        x! * 0.9066666666666666 * 0.912 + b2[c]! * 0.9066666666666666 * 0.088
    );
    return {
      initialized,
      rate: context.sampleRate,
      seam,
      captureStart,
      sourceOffsets: [34304, 75904],
      sourceSamples: [b1, b2],
      expected,
      rawSum: b1.map((x, c) => x! + b2[c]!),
      actual: rows[128]?.slice(1),
      rows,
    };
  } finally {
    for (const source of sources) {
      try {
        source.stop();
      } catch {}
      source.disconnect();
    }
    for (const node of nodes) node.disconnect();
    if (context.state !== 'closed') await context.close();
    URL.revokeObjectURL(url);
  }
}
