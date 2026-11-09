// Installed only in the loopback proof browser before viewer scripts execute.
// This is instrumentation, not a performance oracle: controls and source-pixel
// comparisons must qualify it before a trace can support a playback claim.
export const otioProofWorkletSource = `
class RelicProofTap extends AudioWorkletProcessor {
 constructor() { super(); this.active = false; this.used = 0; this.first = 0; this.left = new Float32Array(1024); this.right = new Float32Array(1024);
  this.port.onmessage = ({data}) => { if (data === 'start') { this.active = true; this.used = 0; this.port.postMessage({kind:'started', frame:currentFrame}); }
   if (data === 'stop') { this.flush(); this.active = false; this.port.postMessage({kind:'stopped', frame:currentFrame}); } }; }
 flush() { if (!this.used) return; this.port.postMessage({kind:'pcm', frame:this.first, channels:[this.left.slice(0,this.used),this.right.slice(0,this.used)]}); this.used = 0; }
 process(inputs, outputs) { const output=outputs[0]; for (const channel of output) channel.fill(0); if (!this.active) return true;
  const channels=inputs[0] || []; const count=output[0].length; if (!this.used) this.first=currentFrame;
  for (let i=0; i<count; i++) { this.left[this.used+i]=channels[0]?.[i] || 0; this.right[this.used+i]=channels[1]?.[i] ?? channels[0]?.[i] ?? 0; }
  this.used += count; if (this.used === 1024) this.flush(); return true; }
}
registerProcessor('relic-proof-pcm', RelicProofTap);`;

export const otioProofTracePrelude = String.raw`(() => {
  const MAX_AUDIO_SAMPLES = 48000 * 20 * 2;
  const MAX_VISUAL_SAMPLES = 3000;
  let fault = 'none';
  let lastStall = 0;
  for (const name of ['drawImage', 'clearRect', 'fillRect']) {
    const original = CanvasRenderingContext2D.prototype[name];
    CanvasRenderingContext2D.prototype[name] = function(...args) {
      const frame = Number(document.querySelector('.otio-view')?.dataset.frame);
      const skippingStill = fault === 'skip-still' && frame >= 89 && frame < 105;
      if ((fault === 'freeze' || skippingStill) && (visual.active || screenOnlyActive) && this.canvas?.matches?.('canvas.otio-canvas')) return;
      return original.apply(this, args);
    };
  }
  const graphs = [];
  const violations = [];
  document.addEventListener('securitypolicyviolation', event => {
    violations.push({directive:event.effectiveDirective, blockedURI:event.blockedURI});
  });
  const events = [];
  let eventsOverflow = false;
  const elementIds = new WeakMap();
  let nextElementId = 0;
  const sourceIds = new Map();
  function recordEvent(kind, element, value) {
    if (!visual.active) return;
    if (events.length >= 10000) { eventsOverflow = true; return; }
    let elementId = null;
    if (element) {
      if (!elementIds.has(element)) elementIds.set(element, nextElementId++);
      elementId = elementIds.get(element);
    }
    const source = element?.currentSrc || element?.src || '';
    if (source && !sourceIds.has(source)) sourceIds.set(source, sourceIds.size);
    events.push({kind, value, elementId, sourceId:source ? sourceIds.get(source) : null, mediaType:element?.tagName ?? null,
      timestamp: performance.now(),
      frame: document.querySelector('.otio-view')?.getAttribute('data-frame') ?? null,
      source: element?.dataset?.bundlePath ?? null,
      currentTime: element?.currentTime ?? null});
  }
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    if (args[0] === 'OTIO_PROOF_MISSING_TAG') recordEvent('missing-tag', null, args[1]);
    if (args[0] === 'OTIO_PROOF_PILOT') recordEvent('pilot', null, args[1]);
    if (args[0] === 'OTIO_PROOF_RING') recordEvent('ring', null, args[1]);
    return originalConsoleLog.apply(this, args);
  };
  const NativeVideoFrame = globalThis.VideoFrame;
  if (typeof NativeVideoFrame === 'function') {
    globalThis.VideoFrame = class extends NativeVideoFrame {
      constructor(source, ...args) {
        super(source, ...args);
        if (source instanceof HTMLVideoElement)
          recordEvent('video-frame-readout', source, {timestamp:this.timestamp});
      }
    };
  }
  for (const name of ['play', 'pause']) {
    const original = HTMLMediaElement.prototype[name];
    HTMLMediaElement.prototype[name] = function(...args) {
      const result = original.apply(this, args);
      recordEvent(name, this, null);
      return result;
    };
  }
  const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  if (currentTime?.configurable && currentTime.get && currentTime.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true, enumerable: currentTime.enumerable,
      get() { return currentTime.get.call(this); },
      set(value) {
        currentTime.set.call(this, value);
        recordEvent('seek', this, value);
      },
    });
  }
  for (const kind of ['seeking', 'seeked', 'waiting', 'playing', 'pause'])
    document.addEventListener(kind, event => {
      if (event.target instanceof HTMLMediaElement) recordEvent(kind, event.target, null);
    }, true);
  const originalRvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (typeof originalRvfc === 'function') {
    HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
      const element = this;
      const callbackId = originalRvfc.call(this, (now, metadata) => {
        recordEvent('rvfc', element, {callbackId, callbackTime:now, mediaTime:metadata.mediaTime,
          presentedFrames:metadata.presentedFrames, expectedDisplayTime:metadata.expectedDisplayTime});
        try { return callback(now, metadata); }
        finally { recordEvent('rvfc-return', element, {callbackId}); }
      });
      recordEvent('rvfc-request', element, {callbackId});
      return callbackId;
    };
  }
  let bufferingObserver = null;
  const originalConnect = AudioNode.prototype.connect;
  function command(graph, name) {
    const {promise, resolve, reject} = Promise.withResolvers();
    const timer = setTimeout(() => { graph.pending = null; reject(new Error('audio worklet ' + name + ' timed out')); }, 5000);
    graph.pending = {kind: name === 'start' ? 'started' : 'stopped',
      resolve: frame => { clearTimeout(timer); graph.pending = null; resolve(frame); }};
    graph.node.port.postMessage(name);
    return promise;
  }
  AudioNode.prototype.connect = function(destination, ...rest) {
    const result = originalConnect.call(this, destination, ...rest);
    if (this instanceof GainNode && destination === this.context.destination &&
        !graphs.some(graph => graph.master === this)) {
      const master = this, context = this.context;
      const graph = {master, context, node: null, chunks: [], samples: 0,
        overflow: false, pending: null, ready: null};
      graphs.push(graph);
      graph.ready = (async () => {
        if (!context.audioWorklet || typeof AudioWorkletNode !== 'function')
          throw new Error('AudioWorklet unavailable in viewer sandbox');
        const url = '/__proof/otio-audio-worklet.js';
        try { await context.audioWorklet.addModule(url); }
        catch (error) {
          const {promise, resolve} = Promise.withResolvers();
          setTimeout(resolve, 50); await promise;
          throw new Error('AudioWorklet addModule failed: ' + String(error) + '; CSP=' + JSON.stringify(violations));
        }
        const node = new AudioWorkletNode(context, 'relic-proof-pcm',
          {numberOfInputs:1, numberOfOutputs:1, channelCount:2,
            channelCountMode:'explicit', outputChannelCount:[1]});
        graph.node = node;
        node.port.onmessage = ({data}) => {
          if (data.kind === 'pcm') {
            const channels = data.channels.map(channel => Array.from(channel));
            const size = channels.reduce((sum, channel) => sum + channel.length, 0);
            if (graph.samples + size > MAX_AUDIO_SAMPLES) graph.overflow = true;
            else { graph.chunks.push({sampleFrame:data.frame, channels}); graph.samples += size; }
          } else if (graph.pending?.kind === data.kind) graph.pending.resolve(data.frame);
        };
        originalConnect.call(master, node);
        originalConnect.call(node, destination);
      })();
      // The viewer's connection is already established. Retain the error for
      // start() to report without changing the controller's own audio graph.
      graph.ready.catch(() => {});
    }
    return result;
  };
  const visual = {active: false, overflow: false, samples: []};
  let screenOnlyActive = false;
  let lightweightEvents = [];
  let lightweightOverflow = false;
  let clockRaf = null;
  let clockRafOverflow = false;
  function tick(now) {
    if (clockRaf) {
      if (clockRaf.length < 3000) clockRaf.push(now);
      else clockRafOverflow = true;
    }
    if (screenOnlyActive) {
      if (fault === 'stall' && now - lastStall >= 300) {
        lastStall = now;
        const until = performance.now() + 200;
        while (performance.now() < until) {}
      }
      if (lightweightEvents.length >= 3000) lightweightOverflow = true;
      else lightweightEvents.push({timestamp: performance.now(), frame: document.querySelector('.otio-view')?.getAttribute('data-frame') ?? null});
    }
    if (visual.active) {
      if (fault === 'stall' && now - lastStall >= 300) {
        lastStall = now;
        const until = performance.now() + 200;
        while (performance.now() < until) {}
      }
      if (visual.samples.length >= MAX_VISUAL_SAMPLES) visual.overflow = true;
      else {
        const canvas = document.querySelector('canvas.otio-canvas');
        const root = document.querySelector('.otio-view');
        try {
          if (!canvas || !canvas.width || !canvas.height) throw new Error('missing canvas');
          const ctx = canvas.getContext('2d');
          const sampleStarted = performance.now();
          if (!ctx) throw new Error('missing context');
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let hash = 2166136261;
          // Sample spatially across the actual backing store; hashes are a cadence
          // signal only, never a substitute for independently decoded pixels.
          const stride = Math.max(4, Math.floor(pixels.length / 4096 / 4) * 4);
          for (let i = 0; i < pixels.length; i += stride) {
            hash = Math.imul(hash ^ pixels[i], 16777619);
            hash = Math.imul(hash ^ pixels[i + 1], 16777619);
            hash = Math.imul(hash ^ pixels[i + 2], 16777619);
          }
          const pixels16 = [];
          for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
            const i = (Math.min(canvas.height - 1, Math.floor((y + .5) * canvas.height / 36)) * canvas.width + Math.min(canvas.width - 1, Math.floor((x + .5) * canvas.width / 64))) * 4;
            pixels16.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
          }
          visual.samples.push({timestamp: performance.now(), sampleDuration: performance.now() - sampleStarted, hash: hash >>> 0, pixels16,
            frame: root?.getAttribute('data-frame') ?? null});
        } catch (error) {
          visual.samples.push({timestamp: now, error: String(error)});
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  globalThis.__otioProofTrace = {
    setFault(value) {
      if (!['none', 'freeze', 'stall', 'skip-still'].includes(value)) throw new Error('unknown proof fault');
      fault = value; lastStall = performance.now();
    },
    async waitForPresentedChanges(required, timeoutMs) {
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        let count = 0, previous = null;
        for (const sample of visual.samples) {
          if (sample.error || sample.hash === undefined) throw new Error('warm readiness missing canvas provenance');
          if (previous !== null && sample.hash !== previous) count++;
          previous = sample.hash;
        }
        if (count >= required) {
          const root = document.querySelector('.otio-view');
          return {timestamp:performance.now(), frame:Number(root?.dataset.frame),
            sampleCount:visual.samples.length, changes:count};
        }
        const {promise, resolve} = Promise.withResolvers(); setTimeout(resolve, 10); await promise;
      }
      throw new Error('warm readiness did not observe ' + required + ' distinct canvas changes');
    },
    startClockCalibration() { clockRaf = []; clockRafOverflow = false; return performance.now(); },
    stopClockCalibration() {
      const samples = clockRaf; clockRaf = null;
      return {samples, overflow:clockRafOverflow, timestamp:performance.now()};
    },
    startLightweight() {
      lightweightEvents = []; lightweightOverflow = false; screenOnlyActive = true;
      return {timestamp:performance.now(), frame:Number(document.querySelector('.otio-view')?.dataset.frame)};
    },
    stopLightweight() {
      screenOnlyActive = false;
      return {timestamp:performance.now(), frame:Number(document.querySelector('.otio-view')?.dataset.frame),
        samples:lightweightEvents, overflow:lightweightOverflow};
    },
    async start() {
      if (graphs.length !== 1) throw new Error('expected exactly one controller destination gain, got ' + graphs.length);
      const graph = graphs[0];
      await graph.ready;
      graph.chunks = []; graph.samples = 0; graph.overflow = false;
      const sampleFrame = await command(graph, 'start');
      visual.samples = []; visual.overflow = false; visual.active = true;
      events.length = 0; eventsOverflow = false;
      const root = document.querySelector('.otio-view');
      if (!(root instanceof HTMLElement)) throw new Error('proof view missing');
      recordEvent('buffering-initial', null, root.dataset.buffering ?? null);
      bufferingObserver?.disconnect();
      bufferingObserver = new MutationObserver(records => {
        for (const record of records)
          recordEvent('buffering-change', null, {old:record.oldValue, current:root.dataset.buffering});
      });
      bufferingObserver.observe(root, {attributes:true, attributeOldValue:true, attributeFilter:['data-buffering']});
      return {sampleRate: graph.context.sampleRate, contextState: graph.context.state,
        sampleFrame, timestamp: performance.now(),
        frame: Number(document.querySelector('.otio-view')?.dataset.frame)};
    },
    mute() {
      if (graphs.length !== 1) throw new Error('controller destination gain ambiguous');
      const graph = graphs[0];
      const old = graph.master.gain.value;
      graph.master.gain.setValueAtTime(0, graph.context.currentTime);
      return {value: old, sampleFrame: Math.round(graph.context.currentTime * graph.context.sampleRate)};
    },
    restore(value) {
      if (graphs.length !== 1) throw new Error('controller destination gain ambiguous');
      const graph = graphs[0];
      graph.master.gain.setValueAtTime(value, graph.context.currentTime);
      return Math.round(graph.context.currentTime * graph.context.sampleRate);
    },
    async stop() {
      if (graphs.length !== 1) throw new Error('controller destination gain ambiguous');
      const graph = graphs[0]; visual.active = false;
      bufferingObserver?.disconnect();
      const timestamp = performance.now();
      const frame = Number(document.querySelector('.otio-view')?.dataset.frame);
      const sampleFrame = await command(graph, 'stop');
      return {sampleRate: graph.context.sampleRate, contextState: graph.context.state,
        timestamp, frame, sampleFrame,
        audio: graph.chunks, audioOverflow: graph.overflow,
        visual: visual.samples, visualOverflow: visual.overflow, events, eventsOverflow};
    },
  };
})();`;
