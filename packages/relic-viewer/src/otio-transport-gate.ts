import type { OtioGateAck, OtioGateCommand } from './otio-transport-gate-state';
export type { OtioGateAck } from './otio-transport-gate-state';

const ASSET = '/assets/otio-transport-gate-worklet.js';
const SPAN = 65536;
const STEP = 32768;
const MAX_QUANTUM = 2048;
let nextEpoch = 0;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export interface OtioClockSnapshot {
  clockEpoch: number;
  nonce: number;
  bankSerial: number;
  callbackOrdinal: number;
  sampleCount: number;
  lastCertifiedEnd: number;
  quantumLength: number;
  fault: false;
}
interface ClockBank {
  clockEpoch: number;
  bank: 0 | 1;
  serial: number;
  startFrame: number;
  endFrame: number;
}
type ClockPending = {
  type: 'anchor' | 'bank';
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
  constructor(
    readonly expectedFrame: number | null,
    readonly observedFrame: number
  ) {
    super(
      `Transport render clock discontinuity: expected ${expectedFrame}, observed ${observedFrame}`
    );
    this.name = 'OtioGateRenderClockError';
  }
}
export interface OtioTransportGate {
  readonly node: AudioWorkletNode;
  readonly clockEpoch: number;
  readonly clockCoverageEnd: number | null;
  ready(): Promise<void>;
  checkpoint(nonce: number): Promise<OtioClockSnapshot>;
  acceptAnchor(snapshot: OtioClockSnapshot): Promise<void>;
  prepareNextBank(): Promise<void>;
  arm(
    generation: number,
    f0: number,
    throughFrame: number
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
  proof?: { proofInitialSerial: number }
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
  const node = new AudioWorkletNode(context, 'otio-transport-gate', {
    numberOfInputs: 1,
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
  let checkpointPending: {
    nonce: number;
    resolve: (snapshot: OtioClockSnapshot) => void;
    reject: (error: Error) => void;
  } | null = null;
  let lastSnapshot: OtioClockSnapshot | null = null;
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
  const finishShutdown = () => {
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
    readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    normalPending = abortPending = null;
    clockPending?.reject(error);
    clockPending = null;
    checkpointPending?.reject(error);
    checkpointPending = null;
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
    const frame = node.parameters.get('clockFrame' + suffix),
      tag = node.parameters.get('clockTag' + suffix);
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
    sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(context.destination);
  } catch (error) {
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
              message.observedFrame
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
      message.type === 'clock-trace-stopped'
    )
      return;
    if (message.type === 'clock-ready') {
      if (readySeen) {
        fail(new Error('Duplicate transport clock readiness'));
        return;
      }
      readySeen = true;
      readyResolve();
      return;
    }
    if (
      message.type === 'checkpoint' ||
      message.type === 'checkpoint-rejected'
    ) {
      const item = checkpointPending;
      if (!item || message.nonce !== item.nonce) {
        fail(new Error('Mismatched clock checkpoint'));
        return;
      }
      checkpointPending = null;
      if (message.type === 'checkpoint-rejected') {
        item.reject(new Error('Clock checkpoint rejected'));
        return;
      }
      if (
        !integer(message.bankSerial) ||
        message.bankSerial !== active.serial ||
        !integer(message.callbackOrdinal) ||
        message.callbackOrdinal < 2 ||
        !integer(message.sampleCount) ||
        !integer(message.lastCertifiedEnd) ||
        !integer(message.quantumLength) ||
        message.quantumLength < 2 ||
        message.quantumLength > MAX_QUANTUM ||
        message.fault !== false
      ) {
        fail(new Error('Malformed clock checkpoint'));
        item.reject(failed!);
        return;
      }
      const snapshot: OtioClockSnapshot = {
        clockEpoch,
        nonce: item.nonce,
        bankSerial: message.bankSerial,
        callbackOrdinal: message.callbackOrdinal,
        sampleCount: message.sampleCount,
        lastCertifiedEnd: message.lastCertifiedEnd,
        quantumLength: message.quantumLength,
        fault: false,
      };
      observedQuantum = snapshot.quantumLength;
      lastSnapshot = snapshot;
      item.resolve(snapshot);
      return;
    }
    if (
      message.type === 'anchor-accepted' ||
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
      if (message.type === 'anchor-accepted') {
        if (
          item.type !== 'anchor' ||
          message.clockCoverageEnd !== active.endFrame - MAX_QUANTUM
        ) {
          fail(new Error('Malformed clock anchor'));
          return;
        }
        coverage = active.endFrame - MAX_QUANTUM;
        lastSnapshot = null;
        clockPending = null;
        item.resolve();
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
    ready: () => readyPromise,
    checkpoint: (nonce) => {
      if (disposed || failed)
        return Promise.reject(failed ?? new Error('Transport gate disposed'));
      if (
        !integer(nonce) ||
        !readySeen ||
        coverage !== null ||
        clockPending ||
        checkpointPending ||
        lastSnapshot ||
        context.state !== 'suspended'
      )
        return Promise.reject(new Error('Invalid clock checkpoint request'));
      return new Promise((resolve, reject) => {
        checkpointPending = { nonce, resolve, reject };
        try {
          node.port.postMessage({ type: 'checkpoint', clockEpoch, nonce });
        } catch (error) {
          checkpointPending = null;
          reject(error);
        }
      });
    },
    acceptAnchor: (snapshot) => {
      if (disposed || failed)
        return Promise.reject(failed ?? new Error('Transport gate disposed'));
      if (
        clockPending ||
        !lastSnapshot ||
        snapshot !== lastSnapshot ||
        coverage !== null
      )
        return Promise.reject(new Error('Invalid clock anchor'));
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        clockPending = { type: 'anchor', id, resolve, reject };
        try {
          node.port.postMessage({
            type: 'accept-anchor',
            clockEpoch,
            requestId: id,
            snapshot,
          });
        } catch (error) {
          clockPending = null;
          reject(error);
        }
      });
    },
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
    arm: (generation, f0, throughFrame) =>
      send({ type: 'arm', generation, f0, throughFrame }),
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
