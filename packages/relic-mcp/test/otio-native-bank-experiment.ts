// Independent experimental clock, not the production gate or its validator.
export async function runNativeBanks() {
  const mode = new URLSearchParams(location.search).get('bankmode');
  if (mode === 'retry' || mode === 'exhaust') {
    const request = performance.now();
    const first = await runBankAttempt(false, true, true);
    const second = await runBankAttempt(false, mode === 'exhaust', true);
    const elapsed = performance.now() - request;
    if (
      !first.rejected ||
      (mode === 'retry' ? second.rejected : !second.rejected)
    )
      throw new Error(
        'checkpoint retry control did not reach expected outcome'
      );
    return {
      mode,
      first,
      second,
      elapsed,
      withinOriginal350ms: elapsed <= 350,
      limitation: 'independent silent bootstrap only, not production startup',
    };
  }
  return runBankAttempt(mode === 'long', false, false);
}

async function runBankAttempt(
  long: boolean,
  injectMismatch: boolean,
  bootstrapOnly: boolean
) {
  const code = `
class BankProbe extends AudioWorkletProcessor {
 static get parameterDescriptors(){return ['frameA','tagA','frameB','tagB'].map(name=>({name,defaultValue:0,automationRate:'a-rate'}))}
 constructor(){super();this.banks=[null,null];this.active=0;this.end=null;this.ordinal=0;this.samples=0;this.promotions=[];this.maxResidual=0;this.fault='';this.capture=false;this.mediaStart=0;this.mediaEnd=0;this.passed=0;this.port.onmessage=({data:d})=>{if(d.type==='bank')this.banks[d.bank]=d;else if(d.type==='checkpoint')this.port.postMessage({type:'checkpoint',nonce:d.nonce,end:this.end,ordinal:this.ordinal,samples:this.samples,fault:this.fault,promotions:this.promotions.length});else if(d.type==='capture'){this.capture=true;this.mediaStart=d.start;this.mediaEnd=d.end}else if(d.type==='finish')this.port.postMessage({type:'finish',end:this.end,ordinal:this.ordinal,samples:this.samples,fault:this.fault,promotions:this.promotions,maxResidual:this.maxResidual,passed:this.passed})}}
 process(inputs,outputs,p){
  const output=outputs[0], n=output[0].length;for(const c of output)c.fill(0);
  if(this.fault)return true;
  const active=this.banks[this.active];if(!active)return true;
  const decode=(d)=>{const f=p[d.bank?'frameB':'frameA'],t=p[d.bank?'tagB':'tagA'];if(f.length!==n||!(t.length===1||t.length===n))return null;let first=null;for(let i=0;i<n;i++){const v=f[i],r=Math.round(v),tag=t[t.length===1?0:i];if(tag!==d.serial||!Number.isFinite(v)||Math.abs(v-r)>0.125||r<0||r>=65536)return null;this.maxResidual=Math.max(this.maxResidual,Math.abs(v-r));const frame=d.start+r;if(!Number.isSafeInteger(frame)||frame>=d.end||(first!==null&&frame!==first+i))return null;if(first===null)first=frame;}return first};
  let frame=decode(active);if(frame===null){if(this.end===null){this.ordinal++;this.samples+=n;return true}this.fault='invalid-active-bank';return true}if(this.end!==null&&frame!==this.end){this.fault='discontinuous';return true}
  const other=this.banks[1-this.active];if(other&&frame>=other.start&&frame+n<=other.end){const next=decode(other);if(next!==frame){this.fault='bank-disagreement';return true}this.active=1-this.active;this.banks[1-this.active]=null;this.promotions.push({from:active.serial,to:other.serial,boundary:frame+n});this.port.postMessage({type:'retired',bank:active.bank,serial:active.serial,boundary:frame+n,nextStart:other.start+32768})}
  if(this.capture&&frame>=this.mediaStart&&frame+n<=this.mediaEnd){const input=inputs[0];if(input.length!==5){this.fault='missing-carrier';return true}for(let i=0;i<n;i++){const x=frame+i-this.mediaStart;if(input[0][i]!==0.75||input[1][i]!==x%4096/4096||input[2][i]!==Math.floor(x/4096)/256||input[3][i]!==((x%127)-63)/128||input[4][i]!==((x%113)-56)/128){this.fault='carrier-disagreement';return true}}output[0].set(input[3]);output[1].set(input[4]);this.passed+=n}
  this.end=frame+n;this.ordinal++;this.samples+=n;return true
 }
}registerProcessor('native-bank-probe',BankProbe);`;
  const context = new AudioContext({ sampleRate: 48000 });
  const rate = context.sampleRate;
  if (rate !== 48000 && rate !== 44100)
    throw new Error('unsupported actual context rate');
  const url = URL.createObjectURL(
    new Blob([code], { type: 'text/javascript' })
  );
  let node: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  let source: AudioBufferSourceNode | undefined;
  try {
    await context.audioWorklet.addModule(url);
    await context.suspend();
    const frozenExact = context.currentTime * rate;
    const frozen = Math.round(frozenExact);
    if (
      !Number.isSafeInteger(frozen) ||
      Math.abs(frozenExact - frozen) > 1 / 1024
    )
      throw new Error('non-integral frozen frame');
    node = new AudioWorkletNode(context, 'native-bank-probe', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 5,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [2],
    });
    sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(context.destination);
    const messages: {
      type: string;
      nonce?: string;
      end?: number;
      fault?: string;
      bank: number;
      nextStart: number;
      maxResidual: number;
      passed: number;
      promotions: { from: number; to: number; boundary: number }[];
    }[] = [];
    let serial = 0;
    let failure = '';
    const install = (bank: number, start: number) => {
      const end = start + 65536;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end > 2 ** 40 ||
        serial >= 2 ** 24 - 1
      )
        throw new Error('bank bounds');
      for (const frame of [start, end])
        if (Math.abs((frame / rate) * rate - frame) > 1 / 1024)
          throw new Error('endpoint conversion');
      const p = node!.parameters.get(bank ? 'frameB' : 'frameA'),
        t = node!.parameters.get(bank ? 'tagB' : 'tagA');
      if (!p || !t) throw new Error('missing bank parameters');
      p.cancelScheduledValues(0);
      t.cancelScheduledValues(0);
      p.setValueAtTime(0, start / rate);
      p.linearRampToValueAtTime(65536, end / rate);
      t.setValueAtTime(++serial, start / rate);
      t.setValueAtTime(0, end / rate);
      node!.port.postMessage({ type: 'bank', bank, serial, start, end });
    };
    node.port.onmessage = ({ data }) => {
      messages.push(data);
      if (data.type === 'retired')
        try {
          install(data.bank, data.nextStart);
        } catch (e) {
          failure = String(e);
        }
    };
    const start = Math.ceil((frozen + 4096) / 128) * 128;
    install(0, start);
    install(1, start + 32768);
    await context.resume();
    const waitUntil = async (predicate: () => boolean, ms: number) => {
      const limit = performance.now() + ms;
      while (!predicate() && performance.now() < limit) {
        if (failure) throw new Error(failure);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 10);
        await promise;
      }
      if (!predicate()) throw new Error('native bank experiment timeout');
    };
    await waitUntil(() => context.currentTime * rate >= start + 1024, 5000);
    await context.suspend();
    const beforeExact = context.currentTime * rate;
    const before = Math.round(beforeExact);
    const nonce = crypto.randomUUID();
    node.port.postMessage({ type: 'checkpoint', nonce });
    await waitUntil(
      () => messages.some((m) => m.type === 'checkpoint' && m.nonce === nonce),
      2000
    );
    const checkpoint = messages.find(
        (m) => m.type === 'checkpoint' && m.nonce === nonce
      ),
      after = context.currentTime * rate;
    if (
      context.state !== 'suspended' ||
      beforeExact !== after ||
      !Number.isSafeInteger(before) ||
      Math.abs(beforeExact - before) > 1 / 1024 ||
      !checkpoint ||
      checkpoint.fault ||
      !Number.isSafeInteger(checkpoint.end)
    )
      throw new Error('malformed suspended checkpoint');
    const comparedEnd = checkpoint.end! + (injectMismatch ? 1 : 0);
    if (comparedEnd !== before) {
      if (!injectMismatch)
        throw new Error('exact suspended checkpoint mismatch');
      return {
        rejected: true,
        injected: true,
        before,
        after,
        actualEnd: checkpoint.end,
        comparedEnd,
        mediaArmed: false,
      };
    }
    await context.resume();
    if (bootstrapOnly) {
      await waitUntil(() => context.currentTime * rate >= before + 256, 2000);
      await context.suspend();
      const resumedExact = context.currentTime * rate;
      const resumedEnd = Math.round(resumedExact);
      if (
        !Number.isSafeInteger(resumedEnd) ||
        Math.abs(resumedExact - resumedEnd) > 1 / 1024
      )
        throw new Error('non-integral resumed frame');
      const resumeNonce = crypto.randomUUID();
      node.port.postMessage({ type: 'checkpoint', nonce: resumeNonce });
      await waitUntil(
        () =>
          messages.some(
            (m) => m.type === 'checkpoint' && m.nonce === resumeNonce
          ),
        2000
      );
      const resumed = messages.find(
        (m) => m.type === 'checkpoint' && m.nonce === resumeNonce
      );
      if (
        !resumed ||
        resumed.fault ||
        resumed.end !== resumedEnd ||
        resumedEnd <= before
      )
        throw new Error('resumed checkpoint discontinuity');
      return {
        rejected: false,
        before,
        after,
        actualEnd: checkpoint.end,
        resumedEnd,
        mediaArmed: false,
      };
    }
    if (long)
      await waitUntil(
        () => context.currentTime * rate > 2 ** 24 - 100000,
        420000
      );
    const f0 = long
        ? 2 ** 24 - 32768
        : Math.ceil((context.currentTime * rate + 4096) / 128) * 128,
      length = 131072;
    if (f0 - context.currentTime * rate < 4096)
      throw new Error('missed source scheduling lead');
    const buffer = context.createBuffer(5, length, rate);
    for (let i = 0; i < length; i++) {
      buffer.getChannelData(0)[i] = 0.75;
      buffer.getChannelData(1)[i] = (i % 4096) / 4096;
      buffer.getChannelData(2)[i] = Math.floor(i / 4096) / 256;
      buffer.getChannelData(3)[i] = ((i % 127) - 63) / 128;
      buffer.getChannelData(4)[i] = ((i % 113) - 56) / 128;
    }
    source = context.createBufferSource();
    source.buffer = buffer;
    source.channelCount = 5;
    source.channelCountMode = 'explicit';
    source.channelInterpretation = 'discrete';
    source.connect(node);
    node.port.postMessage({ type: 'capture', start: f0, end: f0 + length });
    source.start(f0 / rate);
    await waitUntil(
      () => context.currentTime * rate >= f0 + length + 512,
      10000
    );
    await context.suspend();
    node.port.postMessage({ type: 'finish' });
    await waitUntil(() => messages.some((m) => m.type === 'finish'), 2000);
    const result = messages.find((m) => m.type === 'finish');
    if (
      !result ||
      result.fault ||
      result.maxResidual >= 1 / 16 ||
      result.passed !== length ||
      result.promotions.length < 2
    )
      throw new Error('bank qualification rejected: ' + JSON.stringify(result));
    return {
      rejected: false,
      long,
      rate,
      checkpoint,
      f0,
      length,
      result,
      limitation: 'independent copier only; not production gate qualification',
    };
  } finally {
    source?.disconnect();
    node?.disconnect();
    sink?.disconnect();
    if (context.state !== 'closed') await context.close();
    URL.revokeObjectURL(url);
  }
}
