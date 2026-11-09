// Installed only in the loopback proof browser before viewer scripts execute.
// This is instrumentation, not a performance oracle: controls and source-pixel
// comparisons must qualify it before a trace can support a playback claim.
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
      if ((fault === 'freeze' || skippingStill) && visual.active && this.canvas?.matches?.('canvas.otio-canvas')) return;
      return original.apply(this, args);
    };
  }
  const graphs = [];
  const originalConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, ...rest) {
    const result = originalConnect.call(this, destination, ...rest);
    if (this instanceof GainNode && destination === this.context.destination &&
        !graphs.some(graph => graph.master === this)) {
      const context = this.context;
      const processor = context.createScriptProcessor(1024, 2, 1);
      const graph = {master: this, context, processor, chunks: [], samples: 0,
        overflow: false, active: false};
      processor.onaudioprocess = event => {
        event.outputBuffer.getChannelData(0).fill(0);
        if (!graph.active) return;
        const input = event.inputBuffer;
        const size = input.length;
        if (graph.samples + size * input.numberOfChannels > MAX_AUDIO_SAMPLES) {
          graph.overflow = true;
          return;
        }
        const channels = [];
        for (let channel = 0; channel < input.numberOfChannels; channel++)
          channels.push(Array.from(input.getChannelData(channel)));
        graph.chunks.push({sampleFrame: Math.round(event.playbackTime * context.sampleRate), channels});
        graph.samples += size * input.numberOfChannels;
      };
      originalConnect.call(this, processor);
      originalConnect.call(processor, destination);
      graphs.push(graph);
    }
    return result;
  };
  const visual = {active: false, overflow: false, samples: []};
  function tick(now) {
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
          for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) {
            const i = (Math.floor(y * canvas.height / 9) * canvas.width + Math.floor(x * canvas.width / 16)) * 4;
            pixels16.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
          }
          visual.samples.push({timestamp: performance.now(), hash: hash >>> 0, pixels16,
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
    start() {
      if (graphs.length !== 1) throw new Error('expected exactly one controller destination gain, got ' + graphs.length);
      const graph = graphs[0];
      graph.chunks = []; graph.samples = 0; graph.overflow = false; graph.active = true;
      visual.samples = []; visual.overflow = false; visual.active = true;
      return {sampleRate: graph.context.sampleRate, contextState: graph.context.state,
        sampleFrame: Math.round(graph.context.currentTime * graph.context.sampleRate),
        timestamp: performance.now(), frame: Number(document.querySelector('.otio-view')?.dataset.frame)};
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
    stop() {
      if (graphs.length !== 1) throw new Error('controller destination gain ambiguous');
      const graph = graphs[0]; graph.active = false; visual.active = false;
      return {sampleRate: graph.context.sampleRate, contextState: graph.context.state,
        timestamp: performance.now(), frame: Number(document.querySelector('.otio-view')?.dataset.frame),
        audio: graph.chunks, audioOverflow: graph.overflow,
        visual: visual.samples, visualOverflow: visual.overflow};
    },
  };
})();`;
