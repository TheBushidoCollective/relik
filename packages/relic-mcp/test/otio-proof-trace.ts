// Installed only in the loopback proof browser before viewer scripts execute.
// This is instrumentation, not a performance oracle: controls and source-pixel
// comparisons must qualify it before a trace can support a playback claim.
export const otioProofWorkletSource = `
class RelicProofTap extends AudioWorkletProcessor {
 constructor() { super(); this.active = false; this.used = 0; this.first = 0; this.sequence = 0; this.ordinal = 0; this.offset = 0; this.quantumFrames = []; this.quantumTimes = []; this.quantumLengths = []; this.quantumOrdinals = []; this.quantumOffsets = []; this.left = new Float32Array(2048); this.right = new Float32Array(2048); this.marker = new Float32Array(2048); this.witness = [new Float32Array(2048),new Float32Array(2048)];
  this.port.onmessage = ({data}) => { if (data === 'start') { this.active = true; this.used = 0; this.quantumFrames = []; this.quantumTimes = []; this.quantumLengths = []; this.quantumOrdinals = []; this.quantumOffsets = []; this.sequence = 0; this.ordinal = 0; this.offset = 0; this.port.postMessage({kind:'started', frame:currentFrame}); }
   if (data === 'stop') { this.flush(); this.active = false; this.port.postMessage({kind:'stopped', frame:currentFrame}); }
   if (data?.kind === 'observe-resume') { if (this.resumeNonce !== undefined) this.port.postMessage({kind:'resume-observer-overwritten', previous:this.resumeNonce, next:data.nonce}); this.resumeNonce = data.nonce; } }; }
 flush() { if (!this.used) return; this.port.postMessage({kind:'pcm', frame:this.first, sequence:this.sequence++, quantumFrames:this.quantumFrames, quantumTimes:this.quantumTimes, quantumLengths:this.quantumLengths, quantumOrdinals:this.quantumOrdinals, quantumOffsets:this.quantumOffsets, channels:[this.left.slice(0,this.used),this.right.slice(0,this.used)], marker:this.marker.slice(0,this.used), witness:this.witness.map(channel => channel.slice(0,this.used))}); this.used = 0; this.quantumFrames = []; this.quantumTimes = []; this.quantumLengths = []; this.quantumOrdinals = []; this.quantumOffsets = []; }
 process(inputs, outputs) { const output=outputs[0]; for (const channel of output) channel.fill(0);
  if (this.resumeNonce !== undefined) { this.port.postMessage({kind:'resume-render', nonce:this.resumeNonce, frame:currentFrame, contextTime:currentTime, renderWall:typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : null}); this.resumeNonce = undefined; }
  if (!this.active) return true;
  const channels=inputs[0] || []; const count=output[0].length;
  if (count < 2 || count > this.left.length || channels.length !== 2 || channels[0].length !== count || channels[1].length !== count) { this.port.postMessage({kind:'capture-fault', reason:'invalid PCM layout or quantum', frame:currentFrame}); this.active=false; return true; }
  if (this.used + count > this.left.length) this.flush(); if (!this.used) this.first=currentFrame;
  this.quantumFrames.push(currentFrame); this.quantumTimes.push(currentTime); this.quantumLengths.push(count); this.quantumOrdinals.push(this.ordinal++); this.quantumOffsets.push(this.offset); this.offset += count;
  const witness=inputs[1] || [];
  for (let i=0; i<count; i++) { const left=channels[0][i], right=channels[1][i], marker=inputs[2]?.[0]?.[i] ?? 0; if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(marker)) { this.port.postMessage({kind:'capture-fault', reason:'non-finite PCM', frame:currentFrame}); this.active=false; return true; } this.left[this.used+i]=left; this.right[this.used+i]=right; this.marker[this.used+i]=marker; for(let ch=0; ch<2; ch++) this.witness[ch][this.used+i]=witness[ch]?.[i] ?? NaN; }
  this.used += count; if (this.used === this.left.length) this.flush(); return true; }
}
registerProcessor('relic-proof-pcm', RelicProofTap);`;

export const otioProofTracePrelude = String.raw`(() => {
  globalThis.__otioProofCold = true;
  globalThis.__otioProofPcm = true;
  if (globalThis.__otioProofSampleRate != null) {
    const NativeAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = class extends NativeAudioContext {
      constructor(options) { super({...options, sampleRate:globalThis.__otioProofSampleRate}); }
    };
  }
  let borrowedProof = null;
  if (globalThis.__otioProofBorrowedMode) {
    const context = new AudioContext();
    const events = [];
    let actor = 'controller';
    const call = async (name, as) => {
      const previous = actor; actor = as;
      try { return await context[name](); } finally { actor = previous; }
    };
    for (const name of ['suspend', 'resume', 'close']) {
      const native = context[name].bind(context);
      context[name] = (...args) => { events.push({name, actor, state:context.state}); return native(...args); };
    }
    const acquireLease = async signal => {
      events.push({name:'acquire', actor:'lease', state:context.state});
      return {context, signal,
        suspend:() => call('suspend', 'lease'), resume:() => call('resume', 'lease'),
        release:async () => { events.push({name:'release', actor:'lease', state:context.state}); }};
    };
    borrowedProof = {context, events, call};
    globalThis.__otioProofBorrowedAudio = globalThis.__otioProofBorrowedMode === 'lease'
      ? {context, acquireLease} : {context};
  }
  // Hold worker responses, not requests, so cancellation preserves the
  // worker port's ordering while late results can be replayed to the client.
  const NativeWorker = globalThis.Worker;
  let holdPcmResponses = false;
  let failNextPcm = false;
  let failNextSourceStart = false;
  let invalidControllerClock = false;
  const anchorSourceFaults = new WeakMap();
  const productionAnchorSources = new WeakMap();
  let recoveryOverrunRequested = false;
  let recoveryClosureSeen = false;
  let recoverySelection = null;
  const originalSourceStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...args) {
    if (failNextSourceStart) {
      failNextSourceStart = false;
      recordEvent('source-start-fault', null, null);
      throw new Error('proof-injected-source-start-failure');
    }
    const anchorSource = productionAnchorSources.get(this);
    if (anchorSource) recordEvent('production-anchor-start-request', null,
      {clockEpoch:anchorSource.clockEpoch, when:args[0], offset:args[1] ?? 0,
        playbackRate:this.playbackRate.value, detune:this.detune.value, loop:this.loop});
    const fault = anchorSourceFaults.get(this);
    if (fault) {
      anchorSourceFaults.delete(this);
      const rate = this.context.sampleRate;
      if (!Number.isFinite(args[0])) throw new Error('anchor carrier has no explicit native start time');
      recordEvent('anchor-carrier-control-injected', null, {kind:fault, args});
      if (fault === 'missing') return;
      if (fault === 'source-offset') return originalSourceStart.call(this, args[0], 1 / rate);
      if (fault === 'start-time') return originalSourceStart.call(this, args[0] + 1 / rate);
      if (fault === 'missing-first-quantum') return originalSourceStart.call(this, args[0] + 128 / rate);
    }
    const result=originalSourceStart.apply(this, args);
    if (recoveryOverrunRequested && recoveryClosureSeen && !anchorSource && Number.isFinite(args[0])) {
      recoveryOverrunRequested=false;
      const rate=this.context.sampleRate, f1=Math.round(args[0]*rate), start=performance.now();
      const deadline=Number(recoverySelection?.deadline);
      if (!Number.isFinite(deadline) || recoverySelection?.f0!==f1)
        throw new Error('recovery overrun lacks the actual selected F1/deadline');
      while (Math.ceil(this.context.currentTime*rate)+512<=f1 && performance.now()<deadline) {}
      const observedAt=performance.now(), contextFrame=Math.ceil(this.context.currentTime*rate);
      recordEvent('recovery-overrun-injected',null,{f1,contextFrame,observedAt,
        crossedBeforeDeadline:contextFrame+512>f1 && observedAt<=deadline,
        elapsed:observedAt-start,deadline,sourceStarted:true});
    }
    return result;
  };
  const originalOutputTimestamp = AudioContext.prototype.getOutputTimestamp;
  if (typeof originalOutputTimestamp === 'function') {
    AudioContext.prototype.getOutputTimestamp = function() {
      const before = performance.now(), currentBefore = this.currentTime;
      const result = invalidControllerClock
        ? {contextTime: NaN, performanceTime: NaN}
        : originalOutputTimestamp.call(this);
      const currentAfter = this.currentTime, after = performance.now();
      recordEvent('audio-output-timestamp-observed', null, {before, after, currentBefore, currentAfter,
        state:this.state, injected:invalidControllerClock,
        output:{contextTime:result.contextTime, performanceTime:result.performanceTime}});
      return result;
    };
  }
  const heldPcmResponses = [];
  const releasedPcmResponses = new WeakSet();
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (new URL(String(url), location.href).pathname !== '/assets/otio-audio-pcm-worker.js') return;
      this.addEventListener('message', event => {
        if (!releasedPcmResponses.has(event) && failNextPcm && event.data?.protocol === 1 && event.data?.kind === 'pcm') {
          failNextPcm = false;
          event.stopImmediatePropagation();
          const data = event.data;
          const failed = new MessageEvent('message', {data: {protocol:1, kind:'failed', generation:data.generation,
            streamId:data.streamId, requestId:data.requestId, reason:'proof-injected-provider-failure'}});
          releasedPcmResponses.add(failed);
          this.dispatchEvent(failed);
          return;
        }
        if (releasedPcmResponses.has(event) || !holdPcmResponses ||
            event.data?.protocol !== 1 || event.data?.kind !== 'pcm') return;
        event.stopImmediatePropagation();
        heldPcmResponses.push({worker:this, data:event.data});
      });
    }
  };
  const MAX_AUDIO_SAMPLES = 48000 * 20 * 5;
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
  let lastPcmBackend = null;
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
    if (args[0] === 'OTIO_PROOF_COLD') recordEvent('cold-controller', null, args[1]);
    if (args[0] === 'OTIO_PROOF_PCM') {
      if (args[1]?.event === 'backend') lastPcmBackend = args[1];
      recordEvent('scheduled-pcm', null, args[1]);
      if (args[1]?.event === 'recovery-render-closed') recoveryClosureSeen=true;
      if (args[1]?.event === 'recovery-selection') recoverySelection=args[1];
      if (args[1]?.event === 'recovery-old-drained') {
        const graph=graphs.length===1 ? graphs[0] : null;
        if (graph) recordEvent('recovery-old-drain-native-read',null,
          {boundaryFrame:args[1].boundaryFrame, contextTime:graph.context.currentTime,
            state:graph.context.state});
      }
    }
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
  // Only transport-owned zero-gain routes are exempt from master discovery.
  // Other destination gains remain ambiguous.
  const transportNodes = new WeakSet();
  const retirementSinks = new Set();
  const witnesses = new WeakMap();
  const proofGates = new WeakMap();
  let staleCaptureSerial = 0;
  let activeStaleCaptureId = null;
  const staleWaiters = new Map();
  function staleControl(gate, action, captureId) {
    const epoch=gate.initialEpoch, type='clock-stale-'+(action==='start'?'started':'stopped');
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(captureId)) return Promise.resolve(false);
    const key=epoch+':'+captureId+':'+type;
    if (staleWaiters.has(key)) throw new Error('duplicate stale capture operation');
    const {promise,resolve}=Promise.withResolvers();
    const timer=setTimeout(()=>{staleWaiters.delete(key); recordEvent('clock-stale-control-timeout', null,
      {clockEpoch:epoch,captureId,action}); resolve(false);},500);
    staleWaiters.set(key,()=>{clearTimeout(timer); staleWaiters.delete(key); resolve(true);});
    gate.node.port.postMessage({type:'proof-stale-'+action,clockEpoch:epoch,captureId});
    return promise;
  }
  const observedContexts = new WeakSet();
  let nextBankControl = null;
  let nextRecoveryMarker = false;
  let nextAnchorControl = null;
  const syntheticAnchors = new WeakSet();
  function attachWitness(context) {
    const witness = witnesses.get(context);
    const graph = graphs.find(item => item.context === context);
    if (witness && graph?.node && !witness.attached) {
      for (const source of witness.sources) originalConnect.call(source, graph.node, 0, 1);
      witness.attached = true;
    }
  }
  const NativeAudioWorkletNode = globalThis.AudioWorkletNode;
  if (typeof NativeAudioWorkletNode === 'function') {
    globalThis.AudioWorkletNode = class extends NativeAudioWorkletNode {
      constructor(context, name, options) {
        super(context, name, name === 'otio-transport-gate' ? {...options, processorOptions:{...options?.processorOptions, traceMaxCallbacks:512, proofStaleMaxPairs:16}} : options);
        if (name === 'otio-transport-gate') {
          transportNodes.add(this);
          recordEvent('transport-layout', null, {inputs:this.numberOfInputs, outputs:this.numberOfOutputs,
            channelCount:this.channelCount, channelCountMode:this.channelCountMode,
            channelInterpretation:this.channelInterpretation, outputChannels:options?.outputChannelCount});
          const proofGate = {node:this, epoch:null, active:null, anchor:null, initialFrame:options?.processorOptions?.initialFrame,
            initialEpoch:options?.processorOptions?.clockEpoch,
            anchorControl:nextAnchorControl, control:nextBankControl, bootstrapTrace:true, bootstrapTimer:null, bootstrapSettled:false, traceOverlap:false, terminated:false, staleCaptureId:null};
          nextAnchorControl = null; nextBankControl = null;
          proofGates.set(context, proofGate);
          if (!observedContexts.has(context)) {
            observedContexts.add(context);
            context.addEventListener('statechange', () =>
              recordEvent('audio-context-statechange', null,
                {state:context.state, contextTime:context.currentTime}));
          }
          const send = this.port.postMessage.bind(this.port);
          this.port.postMessage = (...args) => {
            recordEvent('transport-command', null, args[0]);
            const message = args[0];
            if (message?.type === 'arm' && nextRecoveryMarker) {
              if ((message.slot !== 0 && message.slot !== 1) || !Number.isSafeInteger(message.generation))
                throw new Error('old recovery slot unavailable');
              const graph=graphs.find(item=>item.context===context);
              if (!graph?.node) throw new Error('independent marker tap unavailable');
              const source=context.createConstantSource(), gain=context.createGain();
              source.offset.value=0.375; gain.gain.value=0;
              originalConnect.call(source,gain);
              originalConnect.call(gain,this,0,message.slot===0?0:2);
              originalConnect.call(gain,graph.node,0,2);
              source.start();
              proofGate.marker={source,gain,generation:message.generation,slot:message.slot};
              nextRecoveryMarker=false;
              recordEvent('recovery-old-marker-connected',null,{generation:message.generation,
                slot:message.slot,physicalInput:message.slot===0?0:2,value:0.375});
            }
            if (message?.type === 'arm') {
              const before=performance.now(), contextBefore=context.currentTime;
              const output=typeof originalOutputTimestamp==='function' ? originalOutputTimestamp.call(context) : null;
              const contextAfter=context.currentTime, after=performance.now();
              recordEvent('audio-arm-native-output', null, {clockEpoch:message.clockEpoch,
                generation:message.generation, sequence:message.sequence, f0:message.f0, slot:message.slot,
                before,after,contextBefore,contextAfter, state:context.state,
                output:output ? {contextTime:output.contextTime,performanceTime:output.performanceTime} : null});
            }
            if (message?.type === 'install-bank')
              recordEvent('audio-context-gate-observation', null, {direction:'send', type:message.type,
                state:context.state, contextTime:context.currentTime, clockEpoch:message.clockEpoch});
            if (message?.type === 'dispose' && proofGate.dropDispose) {
              recordEvent('clock-dispose-withheld', null, message);
              return;
            }
            if (message?.type === 'arm' && proofGate.control === 'late-arm') {
              proofGate.control = null;
              recordEvent('clock-late-arm-injected', null, message);
              const delay = Math.max(0, ((message.f0 + 256) / context.sampleRate - context.currentTime) * 1000);
              setTimeout(() => { recordEvent('clock-late-arm-submitted', null, {sequence:message.sequence, contextTime:context.currentTime}); send(message); }, delay);
              return;
            }
            if (message?.type === 'install-bank' && proofGate.control && proofGate.control !== 'late-arm' && proofGate.control !== 'delay-ack') {
              const kind = proofGate.control, bank = message.descriptor;
              proofGate.control = null;
              if (!bank || (bank.bank !== 0 && bank.bank !== 1)) throw new Error('invalid intercepted bank');
              recordEvent('clock-bank-control-injected', null, {kind, descriptor:bank, requestId:message.requestId});
              if (kind === 'withhold') return;
              if (kind === 'late-install') {
                const delay = Math.max(0, ((bank.startFrame - 256) / context.sampleRate - context.currentTime) * 1000);
                setTimeout(() => { recordEvent('clock-bank-late-submitted', null, {requestId:message.requestId, contextTime:context.currentTime}); send(message); }, delay);
                return;
              }
              if (kind === 'stale-serial') {
                const stale = {...message, descriptor:{...bank, serial:bank.serial - 1}};
                recordEvent('clock-stale-serial-submitted', null, stale);
                send(stale);
                return;
              }
              if (kind === 'late-origin') {
                const param = this.parameters.get(bank.bank === 0 ? 'clockFrameA' : 'clockFrameB');
                if (!param) throw new Error('warming bank parameter unavailable');
                const origin = bank.startFrame - 256;
                param.cancelScheduledValues(origin / context.sampleRate);
                param.setValueAtTime(-384, origin / context.sampleRate);
                param.linearRampToValueAtTime(65536, (bank.endFrame + 128) / context.sampleRate);
              }
            }
            return send(...args);
          };
          // This source is not connected to the destination or to the gate.
          // Its non-looping position carrier is anchored only while native
          // context time is frozen, never from a production bank descriptor.
          if (context.state === 'suspended') {
            const prior = witnesses.get(context);
            if (prior) for (const source of prior.sources) source.disconnect();
            const exact = context.currentTime * context.sampleRate;
            const frozenAnchor = Math.round(exact);
            if (!Number.isSafeInteger(frozenAnchor) || Math.abs(exact - frozenAnchor) > 1 / 1024)
              throw new Error('proof witness has no integral frozen origin');
            const laterAnchor = globalThis.__otioProofClockMode === 'long'
              ? Math.max(frozenAnchor + context.sampleRate * 21, 2 ** 24 - context.sampleRate) : null;
            const length = Math.ceil(context.sampleRate * 20);
            const starts = laterAnchor === null ? [frozenAnchor] : [frozenAnchor,laterAnchor];
            const sources = starts.map(anchor => {
              if (!Number.isSafeInteger(anchor) || Math.abs((anchor / context.sampleRate) * context.sampleRate - anchor) > 1 / 1024)
                throw new Error('proof witness start cannot round-trip to a frame');
              const buffer = context.createBuffer(2, length, context.sampleRate);
              const high = buffer.getChannelData(0), low = buffer.getChannelData(1);
              for (let i = 0; i < length; i++) { const frame = anchor + i; high[i] = 1 + Math.floor(frame / 65536); low[i] = frame % 65536; }
              const source = context.createBufferSource();
              source.buffer = buffer; source.channelCount = 2;
              source.channelCountMode = 'explicit'; source.channelInterpretation = 'discrete';
              return source;
            });
            const witness = {sources, anchor:frozenAnchor, laterAnchor, frozenAnchor, length, attached:false,
              gateInitialFrame:options?.processorOptions?.initialFrame, clockEpoch:options?.processorOptions?.clockEpoch};
            witnesses.set(context, witness);
            attachWitness(context);
            for(let i=0;i<sources.length;i++) sources[i].start(starts[i] / context.sampleRate);
          }
          this.port.addEventListener('message', event => {
            if (syntheticAnchors.has(event)) return;
            if (event.data?.type === 'anchor-certified' && proofGate.anchorControl === 'stale-epoch') {
              proofGate.anchorControl = null;
              event.stopImmediatePropagation();
              const altered = {...event.data, clockEpoch:event.data.clockEpoch - 1};
              recordEvent('anchor-stale-epoch-injected', null, {actual:event.data, altered});
              const replay = new MessageEvent('message', {data:altered});
              syntheticAnchors.add(replay); this.port.dispatchEvent(replay); return;
            }
            recordEvent(event.data?.type === 'clock-trace'
              ? (proofGate.traceOverlap ? 'transport-overlap-clock' : proofGate.bootstrapTrace
                ? 'transport-bootstrap-clock' : 'transport-message') : 'transport-message', null, event.data);
            const marker=proofGate.marker, ack=event.data;
            if (marker && ack?.accepted === true && ack.generation === marker.generation &&
                ['arm','extend','stop'].includes(ack.type) && Number.isSafeInteger(ack.throughFrame)) {
              const now=context.currentTime, at=ack.throughFrame/context.sampleRate;
              marker.gain.gain.cancelScheduledValues(now);
              marker.gain.gain.setValueAtTime(0,now);
              marker.gain.gain.setValueAtTime(1,at);
              recordEvent('recovery-old-marker-scheduled',null,{generation:marker.generation,
                slot:marker.slot,frame:ack.throughFrame,scheduledAt:now,late:at<now});
            }
            if (event.data?.type === 'clock-stale-started' || event.data?.type === 'clock-stale-stopped') {
              const key=event.data.clockEpoch+':'+event.data.captureId+':'+event.data.type;
              staleWaiters.get(key)?.();
            }
            if (event.data?.type === 'clock-fault' || event.data?.type === 'protocol-fault' || event.data?.type === 'disposed')
              proofGate.terminated = true;
            if (event.data?.type === 'clock-trace-stopped' && proofGate.bootstrapTrace) proofGate.bootstrapSettled = true;
            if (['anchor-certified', 'bank-installed', 'bank-rejected', 'clock-promoted'].includes(event.data?.type))
              recordEvent('audio-context-gate-observation', null, {direction:'receive', type:event.data.type,
                state:context.state, contextTime:context.currentTime, clockEpoch:event.data.clockEpoch});
            if (event.data?.type === 'clock-trace') proofGate.active = event.data.active;
            if (event.data?.type === 'clock-promoted' && proofGate.control === 'delay-ack') {
              proofGate.control = null;
              event.stopImmediatePropagation();
              proofGate.active = event.data.active;
              recordEvent('clock-promotion-ack-held', null, event.data);
              const held = event.data;
              setTimeout(() => {
                recordEvent('clock-promotion-ack-released', null, held);
                this.port.dispatchEvent(new MessageEvent('message', {data:held}));
              }, 250);
              return;
            }
            if (event.data?.type === 'clock-promoted') proofGate.active = event.data.active;
            if (event.data?.type === 'anchor-certified') {
              proofGate.epoch = event.data.clockEpoch;
              proofGate.anchor = event.data;
            }
            if (event.data?.type === 'clock-fault')
              recordEvent('transport-render-clock-fault', null, {
                expectedFrame:event.data.expectedFrame,
                observedFrame:event.data.observedFrame
              });
          });
          this.port.start();
          if (activeStaleCaptureId !== null) {
            proofGate.staleCaptureId=activeStaleCaptureId;
            void staleControl(proofGate,'start',activeStaleCaptureId);
          }
          const bootstrapEpoch = options?.processorOptions?.clockEpoch;
          if (Number.isSafeInteger(bootstrapEpoch)) {
            send({type:'proof-trace-start', clockEpoch:bootstrapEpoch});
            proofGate.bootstrapTimer = setTimeout(() => {
              if (proofGate.bootstrapTrace) send({type:'proof-trace-stop', clockEpoch:bootstrapEpoch});
            }, 500);
          }
        }
      }
    };
  }
  function command(graph, name) {
    const {promise, resolve, reject} = Promise.withResolvers();
    const timer = setTimeout(() => { graph.pending = null; reject(new Error('audio worklet ' + name + ' timed out')); }, 5000);
    graph.pending = {kind: name === 'start' ? 'started' : 'stopped',
      resolve: frame => { clearTimeout(timer); graph.pending = null; resolve(frame); }};
    graph.node.port.postMessage(name);
    return promise;
  }
  AudioNode.prototype.connect = function(destination, ...rest) {
    if (this instanceof AudioBufferSourceNode && transportNodes.has(destination) && rest[1] === 1) {
      const gate = proofGates.get(this.context), kind = gate?.anchorControl;
      if (gate?.node !== destination) throw new Error('anchor carrier belongs to another gate');
      productionAnchorSources.set(this,{clockEpoch:gate.initialEpoch});
      if (!this.buffer || this.buffer.numberOfChannels !== 2 || this.buffer.sampleRate !== this.context.sampleRate)
        throw new Error('production anchor carrier layout unavailable');
      recordEvent('production-anchor-carrier-connected', null,
        {clockEpoch:gate.initialEpoch, frames:this.buffer.length,
          channels:this.buffer.numberOfChannels, rate:this.buffer.sampleRate, input:1,
          channelCount:this.channelCount, channelCountMode:this.channelCountMode,
          channelInterpretation:this.channelInterpretation});
      if (kind === 'truncated') {
        const original=this.buffer, shortened=this.context.createBuffer(2,128,this.context.sampleRate);
        for(let ch=0;ch<2;ch++) shortened.copyToChannel(original.getChannelData(ch).subarray(0,128),ch);
        this.buffer=shortened; gate.anchorControl=null;
        recordEvent('anchor-carrier-control-injected', null, {kind, originalFrames:original.length, frames:128});
      } else if (['source-offset','start-time','missing-first-quantum','missing'].includes(kind)) {
        anchorSourceFaults.set(this,kind); gate.anchorControl=null;
      } else if (kind === 'held-bank' || kind === 'shift-bank') {
        const param=destination.parameters.get('clockFrameA'), start=gate.initialFrame/this.context.sampleRate;
        if (!param || !Number.isFinite(start)) throw new Error('anchor bank parameter unavailable');
        param.cancelScheduledValues(0);
        param.setValueAtTime(kind === 'held-bank' ? 0 : 1, start);
        if (kind === 'shift-bank') param.linearRampToValueAtTime(65537,(gate.initialFrame+65536)/this.context.sampleRate);
        gate.anchorControl=null;
        recordEvent('anchor-bank-control-injected', null, {kind, initialFrame:gate.initialFrame});
      }
    }
    const result = originalConnect.call(this, destination, ...rest);
    // The clock session keeps a zero-gain route alive from construction,
    // not only after detachment. Never classify the discovered master as it.
    if (transportNodes.has(this) && destination instanceof GainNode &&
        destination.gain.value === 0 && !graphs.some(graph => graph.master === destination))
      retirementSinks.add(destination);
    if (retirementSinks.has(this) && destination === this.context.destination) {
      if (this.gain.value !== 0) throw new Error('transport retirement sink is audible');
      recordEvent('transport-retirement-sink', null, {gain:this.gain.value});
      return result;
    }
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
          {numberOfInputs:3, numberOfOutputs:1, channelCount:2,
            channelCountMode:'explicit', channelInterpretation:'discrete', outputChannelCount:[1]});
        graph.node = node;
        attachWitness(context);
        node.port.onmessage = ({data}) => {
          if (data.kind === 'pcm') {
            const receivedAt = performance.now();
            const channels = data.channels.map(channel => Array.from(channel));
            const size = channels.reduce((sum, channel) => sum + channel.length, 0) + data.witness.reduce((sum, channel) => sum + channel.length, 0) + data.marker.length;
            const carrierAt = i => { const high=data.witness[0]?.[i], low=data.witness[1]?.[i]; return Number.isSafeInteger(high) && high >= 1 && Number.isSafeInteger(low) && low >= 0 && low < 65536 ? (high-1)*65536+low : null; };
            recordEvent('audio-pcm-batch-received', null, {receivedAt, sequence:data.sequence,
              quantumFrames:data.quantumFrames, quantumOrdinals:data.quantumOrdinals,
              quantumOffsets:data.quantumOffsets, quantumLengths:data.quantumLengths,
              carrierFirst:carrierAt(0), carrierLast:carrierAt(channels[0].length-1)});
            if (graph.samples + size > MAX_AUDIO_SAMPLES) graph.overflow = true;
            else { graph.chunks.push({receivedAt, sampleFrame:data.frame, sequence:data.sequence, quantumFrames:data.quantumFrames, quantumTimes:data.quantumTimes, quantumLengths:data.quantumLengths, quantumOrdinals:data.quantumOrdinals, quantumOffsets:data.quantumOffsets, channels, marker:Array.from(data.marker), witness:data.witness.map(channel => Array.from(channel))}); graph.samples += size; }
          } else if (data.kind === 'capture-fault') { graph.overflow = true; recordEvent('audio-capture-fault', null, data); }
          else if (data.kind === 'resume-render') recordEvent('audio-resume-first-render', null, data);
          else if (data.kind === 'resume-observer-overwritten') recordEvent('audio-resume-observer-overwritten', null, data);
          else if (graph.pending?.kind === data.kind) graph.pending.resolve(data.frame);
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
  const originalContextResume = AudioContext.prototype.resume;
  let resumeNonce = 0;
  AudioContext.prototype.resume = function(...args) {
    const nonce = ++resumeNonce, context = this;
    const graph = graphs.find(item => item.context === context);
    const initialState = context.state;
    if (initialState === 'suspended' && graph?.node)
      graph.node.port.postMessage({kind:'observe-resume', nonce});
    recordEvent('audio-resume-request', null, {nonce, state:initialState,
      contextTime:context.currentTime, observedTap:!!graph?.node});
    return originalContextResume.apply(context, args).then(value => {
      recordEvent('audio-resume-resolved', null, {nonce, state:context.state, contextTime:context.currentTime});
      return value;
    }, error => {
      recordEvent('audio-resume-rejected', null, {nonce, error:String(error)});
      throw error;
    });
  };
  const originalContextSuspend = AudioContext.prototype.suspend;
  let suspendNonce = 0;
  AudioContext.prototype.suspend = function(...args) {
    const nonce = ++suspendNonce, context = this;
    recordEvent('audio-suspend-request', null, {nonce, state:context.state, contextTime:context.currentTime});
    return originalContextSuspend.apply(context, args).then(value => {
      recordEvent('audio-suspend-resolved', null, {nonce, state:context.state, contextTime:context.currentTime});
      return value;
    }, error => {
      recordEvent('audio-suspend-rejected', null, {nonce, error:String(error)});
      throw error;
    });
  };
  function audioBridge(graph) {
    const before = performance.now();
    const currentBefore = graph.context.currentTime;
    const output = typeof originalOutputTimestamp === 'function'
      ? originalOutputTimestamp.call(graph.context) : null;
    const currentAfter = graph.context.currentTime;
    const after = performance.now();
    return {before, after, currentBefore, currentAfter,
      output: output ? {contextTime:output.contextTime, performanceTime:output.performanceTime} : null};
  }
  const visual = {active: false, overflow: false, samples: []};
  let screenOnlyActive = false;
  let lightweightEvents = [];
  let lightweightOverflow = false;
  let clockRaf = null;
  let startupMonitor = null;
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
    async resumeBorrowed() {
      if (!borrowedProof) throw new Error('borrowed context unavailable');
      await borrowedProof.call('resume', 'owner');
    },
    async disposeBorrowed() {
      if (!borrowedProof || !globalThis.__otioProofBorrowedAudio?.controller)
        throw new Error('borrowed controller unavailable');
      const controller = globalThis.__otioProofBorrowedAudio.controller;
      await controller.prepareAudioContextChange();
      controller.dispose();
      const context = borrowedProof.context, before = context.currentTime;
      const oscillator = context.createOscillator(), silent = context.createGain();
      silent.gain.value = 0;
      originalConnect.call(oscillator, silent);
      originalConnect.call(silent, context.destination);
      oscillator.start();
      const {promise,resolve} = Promise.withResolvers();
      setTimeout(resolve, 100);
      await promise;
      oscillator.stop(); oscillator.disconnect(); silent.disconnect();
      return {state:context.state, before, after:context.currentTime,
        events:borrowedProof.events.slice()};
    },
    enableRecoveryMarker() {
      if (nextRecoveryMarker) throw new Error('recovery marker already requested');
      nextRecoveryMarker=true;
    },
    injectRecoveryOverrun() {
      recoveryClosureSeen=false; recoverySelection=null; recoveryOverrunRequested=true;
    },
    nextAnchorControl(kind) {
      if (!['source-offset', 'start-time', 'missing-first-quantum', 'missing', 'truncated', 'held-bank', 'shift-bank', 'stale-epoch'].includes(kind))
        throw new Error('unknown anchor control');
      nextAnchorControl = kind;
    },
    nextClockBankControl(kind) {
      if (!['withhold', 'late-install', 'late-origin', 'late-arm', 'stale-serial', 'delay-ack'].includes(kind)) throw new Error('unknown clock control');
      nextBankControl = kind;
    },
    clockTraceReady() {
      return graphs.length === 1 && proofGates.get(graphs[0].context)?.epoch != null;
    },
    clockTrace(action) {
      if (action !== 'start' && action !== 'stop') throw new Error('invalid clock trace action');
      if (graphs.length !== 1) throw new Error('controller audio graph ambiguous');
      const gate = proofGates.get(graphs[0].context);
      if (!gate || gate.epoch == null) throw new Error('native gate anchor unavailable');
      if (action === 'start') {
        clearTimeout(gate.bootstrapTimer);
        if (gate.bootstrapTrace && !gate.bootstrapSettled) {
          gate.traceOverlap = true;
          recordEvent('clock-trace-phase-overlap', null, {clockEpoch:gate.epoch});
          gate.node.port.postMessage({type:'proof-trace-stop', clockEpoch:gate.epoch});
        }
        gate.bootstrapTrace = false;
      }
      gate.node.port.postMessage({type:'proof-trace-' + action, clockEpoch:gate.epoch});
    },
    corruptClock(kind) {
      if (kind !== 'hold' && kind !== 'wrong-tag') throw new Error('unknown native clock corruption');
      if (graphs.length !== 1) throw new Error('controller audio graph ambiguous');
      const graph = graphs[0], gate = proofGates.get(graph.context), active = gate?.active;
      if (!active || (active.bank !== 0 && active.bank !== 1)) throw new Error('active native clock bank unavailable');
      const suffix = active.bank === 0 ? 'A' : 'B';
      const parameter = gate.node.parameters.get((kind === 'hold' ? 'clockFrame' : 'clockTag') + suffix);
      if (!parameter) throw new Error('native clock parameter unavailable');
      const time = graph.context.currentTime;
      if (kind === 'hold') {
        if (typeof parameter.cancelAndHoldAtTime !== 'function') throw new Error('native parameter hold unavailable');
        parameter.cancelAndHoldAtTime(time);
      } else {
        parameter.cancelScheduledValues(time);
        parameter.setValueAtTime(active.serial + 1, time);
      }
      const receipt = {kind, clockEpoch:gate.epoch, bank:active.bank, serial:active.serial, contextTime:time};
      recordEvent('clock-corruption-injected', null, receipt);
      return receipt;
    },
    withholdRetirement() {
      if (graphs.length !== 1) throw new Error('controller audio graph ambiguous');
      const gate = proofGates.get(graphs[0].context);
      if (!gate) throw new Error('native gate unavailable');
      gate.dropDispose = true;
    },
    clockIdentity() {
      if (graphs.length !== 1) throw new Error('controller audio graph ambiguous');
      const graph = graphs[0], gate = proofGates.get(graph.context);
      if (!gate || gate.epoch == null) throw new Error('native gate anchor unavailable');
      return {clockEpoch:gate.epoch, contextState:graph.context.state,
        sampleFrame:Math.round(graph.context.currentTime * graph.context.sampleRate),
        sampleRate:graph.context.sampleRate};
    },
    audioFrame() {
      if (graphs.length !== 1) throw new Error('controller audio graph ambiguous');
      return Math.ceil(graphs[0].context.currentTime * graphs[0].context.sampleRate);
    },
    hasPcmEvent(name) {
      return events.some(entry => entry.kind === 'scheduled-pcm' && entry.value?.event === name);
    },
    hasTraceEvent(name) { return events.some(entry=>entry.kind===name); },
    hasPcmCancel(reason) {
      return events.some(entry => entry.kind === 'scheduled-pcm' &&
        entry.value?.event === 'cancel' && entry.value?.reason === reason);
    },
    failNextPcm() { failNextPcm = true; },
    failNextSourceStart() { failNextSourceStart = true; },
    setInvalidControllerClock(value) { invalidControllerClock = Boolean(value); },
    heldPcmCount() { return heldPcmResponses.length; },
    holdPcmResponses(value) {
      holdPcmResponses = Boolean(value);
      if (holdPcmResponses) return heldPcmResponses.length;
      const held = heldPcmResponses.splice(0);
      for (const item of held) {
        const event = new MessageEvent('message', {data:item.data});
        releasedPcmResponses.add(event);
        item.worker.dispatchEvent(event);
      }
      return held.length;
    },
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
      if (activeStaleCaptureId !== null) throw new Error('stale capture already active');
      if (graphs.length !== 1) throw new Error('expected exactly one controller destination gain, got ' + graphs.length);
      const graph = graphs[0];
      await graph.ready;
      graph.chunks = []; graph.samples = 0; graph.overflow = false;
      const sampleFrame = await command(graph, 'start');
      visual.samples = []; visual.overflow = false; visual.active = true;
      events.length = 0; eventsOverflow = false;
      if (!Number.isSafeInteger(++staleCaptureSerial)) throw new Error('stale capture id exhausted');
      activeStaleCaptureId = staleCaptureSerial;
      recordEvent('clock-stale-window-requested', null, {captureId:activeStaleCaptureId});
      const currentGate = proofGates.get(graph.context);
      if (currentGate?.anchor) recordEvent('transport-message', null, currentGate.anchor);
      if (currentGate && !currentGate.terminated) {
        currentGate.staleCaptureId=activeStaleCaptureId;
        await staleControl(currentGate,'start',activeStaleCaptureId);
      }
      const root = document.querySelector('.otio-view');
      if (lastPcmBackend) recordEvent('scheduled-pcm', null, lastPcmBackend);
      if (!(root instanceof HTMLElement)) throw new Error('proof view missing');
      recordEvent('buffering-initial', null, root.dataset.buffering ?? null);
      bufferingObserver?.disconnect();
      bufferingObserver = new MutationObserver(records => {
        for (const record of records)
          recordEvent('buffering-change', null, {old:record.oldValue, current:root.dataset.buffering});
      });
      bufferingObserver.observe(root, {attributes:true, attributeOldValue:true, attributeFilter:['data-buffering']});
      const bridge = audioBridge(graph);
      return {sampleRate: graph.context.sampleRate, contextState: graph.context.state,
        sampleFrame, bridge, timestamp: performance.now(),
        frame: Number(document.querySelector('.otio-view')?.dataset.frame)};
    },
    playRequest() {
      if (graphs.length !== 1) throw new Error('controller audio graph ambiguous at play edge');
      const edge = {timestamp:performance.now(), bridge:audioBridge(graphs[0]),
        frame:Number(document.querySelector('.otio-view')?.dataset.frame)};
      recordEvent('play-request', null, edge);
      clearInterval(startupMonitor);
      startupMonitor = setInterval(() => {
        if (performance.now() - edge.timestamp > 1000) {
          clearInterval(startupMonitor); startupMonitor = null; return;
        }
        const graph = graphs[0];
        recordEvent('audio-startup-monitor', null, {state:graph.context.state, bridge:audioBridge(graph)});
      }, 20);
      return edge;
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
      if (activeStaleCaptureId === null) throw new Error('stale capture is not active');
      if (graphs.length !== 1) throw new Error('controller destination gain ambiguous');
      for (const sink of retirementSinks)
        if (sink.gain.value !== 0) throw new Error('transport retirement sink became audible');
      const graph = graphs[0], captureId = activeStaleCaptureId, currentGate = proofGates.get(graph.context);
      if (currentGate && !currentGate.terminated && captureId !== null && currentGate.staleCaptureId === captureId)
        await staleControl(currentGate,'stop',captureId);
      activeStaleCaptureId = null;
      visual.active = false;
      clearInterval(startupMonitor); startupMonitor = null;
      bufferingObserver?.disconnect();
      const timestamp = performance.now();
      const frame = Number(document.querySelector('.otio-view')?.dataset.frame);
      const bridge = audioBridge(graph);
      const sampleFrame = await command(graph, 'stop');
      nextRecoveryMarker=false;
      recoveryOverrunRequested=false; recoveryClosureSeen=false; recoverySelection=null;
      if (currentGate?.marker) {
        const marker=currentGate.marker; currentGate.marker=null;
        try { marker.source.stop(); } catch {}
        marker.source.disconnect(); marker.gain.disconnect();
      }
      return {sampleRate: graph.context.sampleRate, contextState: graph.context.state,
        timestamp, frame, sampleFrame, bridge, staleCaptureId:captureId,
        audio: graph.chunks, audioOverflow: graph.overflow, witness: (() => { const item = witnesses.get(graph.context); return item ? {anchor:item.anchor, laterAnchor:item.laterAnchor, frozenAnchor:item.frozenAnchor, length:item.length, gateInitialFrame:item.gateInitialFrame, clockEpoch:item.clockEpoch} : null; })(),
        visual: visual.samples, visualOverflow: visual.overflow, events, eventsOverflow};
    },
  };
})();`;
