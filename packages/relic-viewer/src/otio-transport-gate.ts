import type { OtioGateAck, OtioGateCommand } from './otio-transport-gate-state';
export type { OtioGateAck } from './otio-transport-gate-state';

const ASSET = '/assets/otio-transport-gate-worklet.js';

/** Module loading failed before any AudioWorkletNode was constructed. */
export class OtioGateModuleLoadError extends Error {
  constructor(cause: unknown) {
    super('Transport gate module load failed', { cause });
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

type Pending = {
  resolve: (ack: OtioGateAck) => void;
  reject: (error: Error) => void;
  type: OtioGateCommand['type'];
  generation: number;
};

export interface OtioTransportGate {
  readonly node: AudioWorkletNode;
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

/** Load only the fixed, same-origin worklet. The caller owns the AudioContext. */
export async function createOtioTransportGate(
  context: AudioContext,
  onClosed: (ack: OtioGateAck) => void,
  onError?: (error: Error) => void
): Promise<OtioTransportGate> {
  try {
    await context.audioWorklet.addModule(ASSET);
  } catch (cause) {
    throw new OtioGateModuleLoadError(cause);
  }
  const node = new AudioWorkletNode(context, 'otio-transport-gate', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    outputChannelCount: [2],
  });
  let sequence = 0;
  let disposed = false;
  let normalPending: number | null = null;
  let abortPending: number | null = null;
  let pendingStop: {
    generation: number;
    frame: number;
    promise: Promise<OtioGateAck>;
  } | null = null;
  let failed: Error | null = null;
  let activeGeneration: number | null = null;
  let processorTerminated = false;
  let shutdown: Promise<void> | null = null;
  let shutdownResolve: (() => void) | null = null;
  let shutdownReject: ((error: Error) => void) | null = null;
  let sink: GainNode | null = null;
  const finishShutdown = (error?: Error) => {
    node.disconnect();
    sink?.disconnect();
    sink = null;
    node.port.onmessage = null;
    node.port.onmessageerror = null;
    node.onprocessorerror = null;
    node.port.close();
    if (error) shutdownReject?.(error);
    else shutdownResolve?.();
    shutdownResolve = null;
    shutdownReject = null;
  };
  const pending = new Map<number, Pending>();
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    normalPending = null;
    abortPending = null;
    if (!disposed) onError?.(error);
  };
  const validFrame = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'protocol-fault'
    ) {
      processorTerminated = true;
      if (disposed) finishShutdown();
      else fail(new Error('Transport gate command queue overflow'));
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'clock-fault'
    ) {
      if (
        !('expectedFrame' in message) ||
        !('observedFrame' in message) ||
        !(
          message.expectedFrame === null || validFrame(message.expectedFrame)
        ) ||
        typeof message.observedFrame !== 'number'
      ) {
        if (disposed)
          finishShutdown(new Error('Malformed transport clock fault'));
        else fail(new Error('Malformed transport clock fault'));
        return;
      }
      processorTerminated = true;
      if (disposed) finishShutdown();
      else
        fail(
          new OtioGateRenderClockError(
            message.expectedFrame,
            message.observedFrame
          )
        );
      return;
    }
    if (disposed) {
      if (
        event.data &&
        typeof event.data === 'object' &&
        'type' in event.data &&
        event.data.type === 'disposed'
      )
        finishShutdown();
      return;
    }
    const ack = event.data as Partial<OtioGateAck> | null;
    if (
      !ack ||
      !validFrame(ack.generation) ||
      !validFrame(ack.sequence) ||
      typeof ack.accepted !== 'boolean' ||
      !(ack.throughFrame === null || validFrame(ack.throughFrame)) ||
      !(ack.closedFrame === null || validFrame(ack.closedFrame)) ||
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
    if (disposed) finishShutdown(error);
    else fail(error);
  };
  node.onprocessorerror = () => {
    const error = new Error('Transport gate processor error');
    if (disposed) finishShutdown(error);
    else fail(error);
  };
  const send = (
    command:
      | Omit<Extract<OtioGateCommand, { type: 'arm' }>, 'sequence'>
      | Omit<Extract<OtioGateCommand, { type: 'extend' }>, 'sequence'>
      | Omit<Extract<OtioGateCommand, { type: 'stop' }>, 'sequence'>
      | Omit<Extract<OtioGateCommand, { type: 'abort' }>, 'sequence'>
  ): Promise<OtioGateAck> => {
    if (disposed) return Promise.reject(new Error('Transport gate disposed'));
    if (failed) return Promise.reject(failed);
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
    // ES2022 browsers do not necessarily provide Promise.withResolvers.
    return new Promise((resolve, reject) => {
      pending.set(next, {
        resolve,
        reject,
        type: command.type,
        generation: command.generation,
      });
      try {
        node.port.postMessage({ ...command, sequence: next });
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
    arm: (generation, f0, throughFrame) =>
      send({ type: 'arm', generation, f0, throughFrame }),
    extend: (generation, expectedThroughFrame, throughFrame) =>
      send({ type: 'extend', generation, expectedThroughFrame, throughFrame }),
    stop: (generation, stopFrame) => {
      if (pendingStop) {
        return pendingStop.generation === generation &&
          pendingStop.frame === stopFrame
          ? pendingStop.promise
          : Promise.reject(new Error('Conflicting transport gate stop'));
      }
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
      // Keep an inaudible route alive until the worklet returns false.
      shutdown = new Promise<void>((resolve, reject) => {
        shutdownResolve = resolve;
        shutdownReject = reject;
      });
      // Callers may intentionally defer awaiting retirement while suspended.
      if (processorTerminated) {
        shutdown = Promise.resolve();
        finishShutdown();
        return shutdown;
      }
      void shutdown.catch(() => {});
      try {
        node.disconnect();
        sink = context.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(context.destination);
        node.port.postMessage({ type: 'dispose' });
      } catch (error) {
        finishShutdown(
          error instanceof Error ? error : new Error(String(error))
        );
      }
      return shutdown;
    },
  };
}
