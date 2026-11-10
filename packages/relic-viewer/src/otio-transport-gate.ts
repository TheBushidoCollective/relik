import type {
  OtioGateAck,
  OtioGateBankDescriptor,
  OtioGateCommand,
  OtioGateDecodeDiagnostic,
  OtioGateDecodeRange,
  OtioGateDecodeSamples,
} from './otio-transport-gate-state';
export type {
  OtioGateAck,
  OtioGateDecodeDiagnostic,
} from './otio-transport-gate-state';

const ASSET = '/assets/otio-transport-gate-worklet.js';
const SPAN = 65536;
const STEP = 32768;
const MAX_QUANTUM = 2048;
let nextEpoch = 0;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Shape check for the worklet's diagnostic before it is attached to an error. */
const isDecodeDiagnostic = (
  value: unknown
): value is OtioGateDecodeDiagnostic =>
  typeof value === 'object' &&
  value !== null &&
  'location' in value &&
  'reason' in value &&
  'failingSample' in value &&
  'bank' in value &&
  'samples' in value;

interface ClockBank {
  clockEpoch: number;
  bank: 0 | 1;
  serial: number;
  startFrame: number;
  endFrame: number;
}
type ClockPending = {
  type: 'bank';
  id: number;
  resolve: () => void;
  reject: (error: Error) => void;
  bank?: ClockBank;
  installed?: boolean;
};
type Pending = {
  resolve: (ack: OtioGateAck) => void;
  reject: (error: Error) => void;
  type: OtioGateCommand['type'];
  generation: number;
};

/** No AudioWorkletNode was constructed, so the reserved node credits remain free. */
export class OtioGatePreconstructionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OtioGatePreconstructionError';
  }
}
export class OtioGateModuleLoadError extends OtioGatePreconstructionError {
  constructor(cause: unknown) {
    super('Transport gate module load failed', cause);
    this.name = 'OtioGateModuleLoadError';
  }
}
export class OtioGateRenderClockError extends Error {
  /**
   * Bounded decode evidence. Non-enumerable, so generic error logging and
   * serialisation do not print the per-sample lanes. Read it deliberately.
   */
  declare readonly diagnostic: OtioGateDecodeDiagnostic | null;
  constructor(
    readonly expectedFrame: number | null,
    readonly observedFrame: number,
    diagnostic: OtioGateDecodeDiagnostic | null = null
  ) {
    super(
      `Transport render clock discontinuity: expected ${expectedFrame}, observed ${observedFrame}`
    );
    this.name = 'OtioGateRenderClockError';
    Object.defineProperty(this, 'diagnostic', {
      value: diagnostic,
      enumerable: false,
    });
  }
}
/** Bounded, JSON-safe evidence for a loopback proof. Explicit copies only; never the error object. */
export interface OtioGateFaultEvidence {
  location: 'active' | 'warming';
  reason: OtioGateDecodeDiagnostic['reason'];
  failingSample: number;
  /** Raw value. NaN and Infinity serialise as null in JSON; `nonFinite` in the summaries counts them. */
  failingFrame: number | null;
  failingTag: number | null;
  length: number;
  cachedCurrentFrame: number;
  expectedFrame: number | null;
  observedFrame: number;
  bank: OtioGateBankDescriptor;
  activeBank: OtioGateBankDescriptor;
  warmingBank: OtioGateBankDescriptor | null;
  frame: OtioGateDecodeRange | null;
  tag: OtioGateDecodeRange | null;
  /** First four raw samples of each bank's frame and tag lanes. */
  firstSamples: {
    active: { frame: number[]; tag: number[] };
    warming: { frame: number[]; tag: number[] } | null;
  };
}

/** Returns bounded evidence for a clock fault, or null for any other error. */
export function clockFaultEvidence(
  error: unknown
): OtioGateFaultEvidence | null {
  if (!(error instanceof OtioGateRenderClockError) || error.diagnostic === null)
    return null;
  const d = error.diagnostic;
  const descriptor = (b: OtioGateBankDescriptor): OtioGateBankDescriptor => ({
    clockEpoch: b.clockEpoch,
    bank: b.bank,
    serial: b.serial,
    startFrame: b.startFrame,
    endFrame: b.endFrame,
  });
  const head = (s: OtioGateDecodeSamples) => ({
    frame: s.frame.slice(0, 4),
    tag: s.tag.slice(0, 4),
  });
  return {
    location: d.location,
    reason: d.reason,
    failingSample: d.failingSample,
    failingFrame: d.failingFrame,
    failingTag: d.failingTag,
    length: d.length,
    cachedCurrentFrame: d.cachedCurrentFrame,
    expectedFrame: error.expectedFrame,
    observedFrame: error.observedFrame,
    bank: descriptor(d.bank),
    activeBank: descriptor(d.activeBank),
    warmingBank: d.warmingBank ? descriptor(d.warmingBank) : null,
    frame: d.frame ? { ...d.frame } : null,
    tag: d.tag ? { ...d.tag } : null,
    firstSamples: {
      active: head(d.samples.active),
      warming: d.samples.warming ? head(d.samples.warming) : null,
    },
  };
}

export interface OtioTransportGate {
  readonly node: AudioWorkletNode;
  readonly clockEpoch: number;
  readonly clockCoverageEnd: number | null;
  readonly certifiedQuantum: number | null;
  ready(): Promise<void>;
  prepareNextBank(): Promise<void>;
  arm(
    generation: number,
    f0: number,
    throughFrame: number,
    slot: 0 | 1
  ): Promise<OtioGateAck>;
  extend(
    generation: number,
    expectedThroughFrame: number,
    throughFrame: number
  ): Promise<OtioGateAck>;
  stop(generation: number, stopFrame: number): Promise<OtioGateAck>;
  abort(generation: number): Promise<OtioGateAck>;
  dispose(): Promise<void>;
}

/** The caller freezes and owns the context; this module never changes its state. */
export async function createOtioTransportGate(
  context: AudioContext,
  onClosed: (ack: OtioGateAck) => void,
  onError?: (error: Error) => void,
  initialFrame?: number,
  proof?: { proofInitialSerial: number },
  releaseCarrier: () => void = () => {},
  registerCarrierCleanup: (cleanup: () => void) => void = () => {}
): Promise<OtioTransportGate> {
  let frozen: number;
  let initialSerial: number;
  let clockEpoch: number;
  try {
    if (
      context.state !== 'suspended' ||
      !integer(initialFrame) ||
      initialFrame + SPAN > 2 ** 40 ||
      (context.sampleRate !== 44100 && context.sampleRate !== 48000)
    )
      throw new Error(
        'Transport clock requires a frozen supported context and checked frame'
      );
    const proofGlobals = globalThis as typeof globalThis & {
      __otioProofPcm?: boolean;
      __otioProofClockSerialExhaustion?: boolean;
    };
    const host = globalThis.location?.hostname;
    if (
      proof &&
      (proof.proofInitialSerial !== 2 ** 24 - 1 ||
        proofGlobals.__otioProofPcm !== true ||
        proofGlobals.__otioProofClockSerialExhaustion !== true ||
        (host !== 'localhost' &&
          host !== '127.0.0.1' &&
          host !== '[::1]' &&
          host !== '::1'))
    ) {
      throw new Error(
        'Transport clock proof serial requires explicit loopback proof mode'
      );
    }
    initialSerial = proof ? proof.proofInitialSerial : 1;
    frozen = initialFrame;
    try {
      await context.audioWorklet.addModule(ASSET);
    } catch (cause) {
      throw new OtioGateModuleLoadError(cause);
    }
    if (
      context.state !== 'suspended' ||
      Math.abs(context.currentTime * context.sampleRate - frozen) > 1 / 1024
    )
      throw new Error('Transport clock context changed during construction');
    if (!Number.isSafeInteger(++nextEpoch))
      throw new Error('Transport clock epoch exhausted');
    clockEpoch = nextEpoch;
  } catch (cause) {
    if (cause instanceof OtioGatePreconstructionError) throw cause;
    throw new OtioGatePreconstructionError(
      cause instanceof Error
        ? cause.message
        : 'Transport gate preconstruction failed',
      cause
    );
  }
  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(context, 'otio-transport-gate', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [2],
      processorOptions: {
        clockEpoch,
        initialFrame: frozen,
        ...(proof ? { proofInitialSerial: initialSerial } : {}),
      },
    });
  } catch (error) {
    releaseCarrier();
    throw error;
  }
  let active: ClockBank = {
    clockEpoch,
    bank: 0,
    serial: initialSerial,
    startFrame: frozen,
    endFrame: frozen + SPAN,
  };
  let coverage: number | null = null;
  let readySeen = false;
  let bankProgrammingFailed = false;
  let sequence = 0,
    requestId = 0;
  let failed: Error | null = null,
    disposed = false,
    terminated = false;
  let normalPending: number | null = null,
    abortPending: number | null = null,
    activeGeneration: number | null = null;
  let pendingStop: {
    generation: number;
    frame: number;
    promise: Promise<OtioGateAck>;
  } | null = null;
  let clockPending: ClockPending | null = null;
  let observedQuantum = 0;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void readyPromise.catch(() => {});
  const pending = new Map<number, Pending>();
  let shutdown: Promise<void> | null = null,
    shutdownResolve: (() => void) | null = null,
    shutdownReject: ((error: Error) => void) | null = null;
  let sink: GainNode | null = null;
  let carrier: AudioBufferSourceNode | null = null;
  let carrierStartAttempted = false;
  let carrierStopRequested = false;
  const stopCarrier = () => {
    if (!carrier || carrierStopRequested) return;
    carrierStopRequested = true;
    try {
      carrier.stop(0);
    } catch {}
  };
  const releaseEndedCarrier = () => {
    if (!carrier) return;
    carrier.onended = null;
    carrier.disconnect();
    carrier.buffer = null;
    carrier = null;
    releaseCarrier();
  };
  const finishShutdown = () => {
    stopCarrier();
    node.disconnect();
    sink?.disconnect();
    sink = null;
    node.port.onmessage = null;
    node.port.onmessageerror = null;
    node.onprocessorerror = null;
    node.port.close();
    shutdownResolve?.();
    shutdownResolve = null;
    shutdownReject = null;
  };
  const failShutdown = (error: Error) => {
    // A failed message or processor is not a terminal acknowledgment.
    // Keep the route and its retirement credit until a real acknowledgment.
    shutdownReject?.(error);
    shutdownReject = null;
  };
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    stopCarrier();
    readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    normalPending = abortPending = null;
    clockPending?.reject(error);
    clockPending = null;
    if (!disposed) onError?.(error);
  };
  const schedule = (bank: ClockBank) => {
    const start = bank.startFrame / context.sampleRate,
      end = bank.endFrame / context.sampleRate;
    if (
      Math.abs(start * context.sampleRate - bank.startFrame) > 1 / 1024 ||
      Math.abs(end * context.sampleRate - bank.endFrame) > 1 / 1024
    )
      throw new Error('Transport clock endpoint conversion lost precision');
    const suffix = bank.bank === 0 ? 'A' : 'B';
    const frame = node.parameters.get(`clockFrame${suffix}`),
      tag = node.parameters.get(`clockTag${suffix}`);
    if (!frame || !tag) throw new Error('Transport clock parameters missing');
    frame.cancelScheduledValues(0);
    tag.cancelScheduledValues(0);
    frame.setValueAtTime(0, start);
    frame.linearRampToValueAtTime(SPAN, end);
    tag.setValueAtTime(bank.serial, start);
    tag.setValueAtTime(0, end);
  };
  try {
    schedule(active);
    const buffer = context.createBuffer(2, 8192, context.sampleRate);
    const high = buffer.getChannelData(0);
    const low = buffer.getChannelData(1);
    for (let i = 0; i < 8192; i++) {
      const frame = frozen + i;
      high[i] = 1 + Math.floor(frame / 65536);
      low[i] = frame % 65536;
    }
    carrier = context.createBufferSource();
    registerCarrierCleanup(releaseEndedCarrier);
    carrier.buffer = buffer;
    carrier.playbackRate.value = 1;
    carrier.detune.value = 0;
    carrier.loop = false;
    carrier.channelCount = 2;
    carrier.channelCountMode = 'explicit';
    carrier.channelInterpretation = 'discrete';
    carrier.connect(node, 0, 1);
    carrier.onended = releaseEndedCarrier;
    carrierStartAttempted = true;
    carrier.start(frozen / context.sampleRate, 0);
    sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(context.destination);
  } catch (error) {
    if (carrierStartAttempted) stopCarrier();
    else if (carrier) releaseEndedCarrier();
    else releaseCarrier();
    node.disconnect();
    sink?.disconnect();
    node.port.close();
    throw error;
  }
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    const raw = event.data;
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('type' in raw) ||
      !('clockEpoch' in raw) ||
      raw.clockEpoch !== clockEpoch
    ) {
      fail(new Error('Mismatched transport clock message'));
      return;
    }
    const message = raw as Record<string, unknown>;
    if (message.type === 'disposed') {
      if (disposed) {
        terminated = true;
        finishShutdown();
      } else fail(new Error('Unexpected transport gate disposal'));
      return;
    }
    if (message.type === 'clock-fault' || message.type === 'protocol-fault') {
      terminated = true;
      const error =
        message.type === 'clock-fault' &&
        (message.expectedFrame === null || integer(message.expectedFrame)) &&
        typeof message.observedFrame === 'number'
          ? new OtioGateRenderClockError(
              message.expectedFrame,
              message.observedFrame,
              isDecodeDiagnostic(message.diagnostic) ? message.diagnostic : null
            )
          : new Error('Transport gate protocol fault');
      if (disposed) finishShutdown();
      else fail(error);
      return;
    }
    if (disposed) return;
    // A proof harness can opt in at construction and observe these independently.
    if (
      message.type === 'clock-trace' ||
      message.type === 'clock-trace-overflow' ||
      message.type === 'clock-trace-started' ||
      message.type === 'clock-trace-stopped' ||
      message.type === 'clock-stale-pair' ||
      message.type === 'clock-stale-overflow' ||
      message.type === 'clock-stale-started' ||
      message.type === 'clock-stale-stopped' ||
      message.type === 'clock-stale-control-error'
    )
      return;
    if (message.type === 'anchor-certified') {
      if (
        readySeen ||
        coverage !== null ||
        message.firstFrame !== frozen ||
        !integer(message.lastCertifiedEnd) ||
        !integer(message.sampleCount) ||
        message.lastCertifiedEnd !== frozen + message.sampleCount ||
        message.callbackOrdinal !== 2 ||
        !integer(message.quantumLength) ||
        message.quantumLength < 2 ||
        message.quantumLength > MAX_QUANTUM ||
        message.sampleCount < message.quantumLength + 2 ||
        message.sampleCount - message.quantumLength > MAX_QUANTUM ||
        message.sampleCount > 8192 ||
        message.bankSerial !== active.serial ||
        message.clockCoverageEnd !== active.endFrame - MAX_QUANTUM
      ) {
        fail(new Error('Malformed clock anchor certification'));
        return;
      }
      readySeen = true;
      observedQuantum = Math.max(
        message.quantumLength,
        message.sampleCount - message.quantumLength
      );
      coverage = active.endFrame - MAX_QUANTUM;
      stopCarrier();
      readyResolve();
      return;
    }
    if (
      message.type === 'bank-installed' ||
      message.type === 'bank-rejected' ||
      message.type === 'clock-promoted'
    ) {
      const item = clockPending;
      if (!item || message.requestId !== item.id) {
        fail(new Error('Mismatched clock transaction'));
        return;
      }
      if (message.type === 'bank-installed') {
        if (
          item.type !== 'bank' ||
          item.installed ||
          JSON.stringify(message.descriptor) !== JSON.stringify(item.bank)
        ) {
          fail(new Error('Malformed clock installation'));
          return;
        }
        item.installed = true;
        return;
      }
      if (message.type === 'bank-rejected') {
        if (item.type !== 'bank') {
          fail(new Error('Mismatched clock rejection'));
          return;
        }
        clockPending = null;
        item.reject(new Error('Clock bank rejected'));
        return;
      }
      if (
        item.type !== 'bank' ||
        !item.installed ||
        !item.bank ||
        JSON.stringify(message.active) !== JSON.stringify(item.bank) ||
        JSON.stringify(message.retired) !== JSON.stringify(active) ||
        !integer(message.boundary) ||
        message.boundary < item.bank.startFrame ||
        message.boundary > active.endFrame ||
        message.clockCoverageEnd !== item.bank.endFrame - MAX_QUANTUM
      ) {
        fail(new Error('Malformed clock promotion'));
        return;
      }
      active = item.bank;
      coverage = active.endFrame - MAX_QUANTUM;
      clockPending = null;
      item.resolve();
      return;
    }
    const ack = message as unknown as Partial<OtioGateAck>;
    if (
      !integer(ack.generation) ||
      !integer(ack.sequence) ||
      typeof ack.accepted !== 'boolean' ||
      !(ack.throughFrame === null || integer(ack.throughFrame)) ||
      !(ack.closedFrame === null || integer(ack.closedFrame)) ||
      (ack.reason !== undefined && typeof ack.reason !== 'string')
    ) {
      fail(new Error('Malformed transport gate acknowledgment'));
      return;
    }
    if (ack.type === 'closed') {
      if (
        !ack.accepted ||
        ack.generation !== activeGeneration ||
        ack.sequence > sequence ||
        ack.throughFrame === null ||
        ack.closedFrame !== ack.throughFrame
      ) {
        fail(new Error('Mismatched transport gate closure'));
        return;
      }
      onClosed(ack as OtioGateAck);
      return;
    }
    const item = pending.get(ack.sequence);
    if (!item || item.type !== ack.type || item.generation !== ack.generation) {
      fail(new Error('Mismatched transport gate acknowledgment'));
      return;
    }
    if (
      ack.accepted &&
      (ack.throughFrame === null ||
        (ack.type === 'abort'
          ? ack.closedFrame === null
          : ack.type === 'stop'
            ? ack.closedFrame !== null && ack.closedFrame !== ack.throughFrame
            : ack.closedFrame !== null))
    ) {
      fail(new Error('Malformed accepted transport gate acknowledgment'));
      return;
    }
    pending.delete(ack.sequence);
    if (normalPending === ack.sequence) normalPending = null;
    if (abortPending === ack.sequence) abortPending = null;
    if (ack.type === 'arm' && ack.accepted) activeGeneration = ack.generation;
    item.resolve(ack as OtioGateAck);
  };
  node.port.onmessageerror = () => {
    const error = new Error('Transport gate message error');
    if (disposed) failShutdown(error);
    else fail(error);
  };
  node.onprocessorerror = () => {
    const error = new Error('Transport gate processor error');
    if (disposed) failShutdown(error);
    else fail(error);
  };
  const send = (
    command:
      | Omit<Extract<OtioGateCommand, { type: 'arm' }>, 'sequence'>
      | Omit<Extract<OtioGateCommand, { type: 'extend' }>, 'sequence'>
      | Omit<Extract<OtioGateCommand, { type: 'stop' }>, 'sequence'>
      | Omit<Extract<OtioGateCommand, { type: 'abort' }>, 'sequence'>
  ): Promise<OtioGateAck> => {
    if (disposed || failed)
      return Promise.reject(failed ?? new Error('Transport gate disposed'));
    if (coverage === null)
      return Promise.reject(new Error('Transport clock not anchored'));
    const isAbort = command.type === 'abort';
    if (isAbort ? abortPending !== null : normalPending !== null)
      return Promise.reject(
        new Error('Transport gate command already pending')
      );
    if (!Number.isSafeInteger(sequence + 1))
      return Promise.reject(new Error('Transport gate sequence exhausted'));
    const next = ++sequence;
    if (isAbort) abortPending = next;
    else normalPending = next;
    return new Promise((resolve, reject) => {
      pending.set(next, {
        resolve,
        reject,
        type: command.type,
        generation: command.generation,
      });
      try {
        node.port.postMessage({ ...command, clockEpoch, sequence: next });
      } catch (error) {
        pending.delete(next);
        if (isAbort) abortPending = null;
        else normalPending = null;
        reject(error);
      }
    });
  };
  return {
    node,
    clockEpoch,
    get clockCoverageEnd() {
      return coverage;
    },
    get certifiedQuantum() {
      return readySeen ? observedQuantum : null;
    },
    ready: () => readyPromise,
    prepareNextBank: () => {
      if (disposed || failed)
        return Promise.reject(failed ?? new Error('Transport gate disposed'));
      if (
        bankProgrammingFailed ||
        clockPending ||
        coverage === null ||
        active.serial >= 2 ** 24 - 1 ||
        active.startFrame + STEP + SPAN > 2 ** 40
      )
        return Promise.reject(new Error('Clock bank unavailable'));
      const bank: ClockBank = {
        clockEpoch,
        bank: active.bank === 0 ? 1 : 0,
        serial: active.serial + 1,
        startFrame: active.startFrame + STEP,
        endFrame: active.startFrame + STEP + SPAN,
      };
      const lead = Math.max(512, 2 * observedQuantum);
      if (bank.startFrame - context.currentTime * context.sampleRate < lead)
        return Promise.reject(new Error('Clock bank preparation too late'));
      try {
        schedule(bank);
      } catch (error) {
        bankProgrammingFailed = true;
        return Promise.reject(error);
      }
      if (bank.startFrame - context.currentTime * context.sampleRate < lead) {
        bankProgrammingFailed = true;
        return Promise.reject(new Error('Clock bank preparation too late'));
      }
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        clockPending = { type: 'bank', id, resolve, reject, bank };
        try {
          node.port.postMessage({
            type: 'install-bank',
            clockEpoch,
            requestId: id,
            descriptor: bank,
          });
        } catch (error) {
          clockPending = null;
          bankProgrammingFailed = true;
          reject(error);
        }
      });
    },
    arm: (generation, f0, throughFrame, slot) =>
      send({ type: 'arm', generation, f0, throughFrame, slot }),
    extend: (generation, expectedThroughFrame, throughFrame) =>
      send({ type: 'extend', generation, expectedThroughFrame, throughFrame }),
    stop: (generation, stopFrame) => {
      if (pendingStop)
        return pendingStop.generation === generation &&
          pendingStop.frame === stopFrame
          ? pendingStop.promise
          : Promise.reject(new Error('Conflicting transport gate stop'));
      const promise = send({ type: 'stop', generation, stopFrame });
      pendingStop = { generation, frame: stopFrame, promise };
      void promise.then(
        () => {
          if (pendingStop?.promise === promise) pendingStop = null;
        },
        () => {
          if (pendingStop?.promise === promise) pendingStop = null;
        }
      );
      return promise;
    },
    abort: (generation) => send({ type: 'abort', generation }),
    dispose: () => {
      if (shutdown) return shutdown;
      disposed = true;
      stopCarrier();
      fail(new Error('Transport gate disposed'));
      shutdown = new Promise<void>((resolve, reject) => {
        shutdownResolve = resolve;
        shutdownReject = reject;
      });
      if (terminated) {
        finishShutdown();
        return shutdown;
      }
      void shutdown.catch(() => {});
      try {
        node.port.postMessage({ type: 'dispose', clockEpoch });
      } catch (error) {
        failShutdown(error instanceof Error ? error : new Error(String(error)));
      }
      return shutdown;
    },
  };
}
