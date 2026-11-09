import type { OtioGateAck, OtioGateCommand } from './otio-transport-gate-state';
export type { OtioGateAck } from './otio-transport-gate-state';

const ASSET = '/assets/otio-transport-gate-worklet.js';

type Pending = {
  resolve: (ack: OtioGateAck) => void;
  reject: (error: Error) => void;
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
  dispose(): void;
}

/** Load only the fixed, same-origin worklet. The caller owns the AudioContext. */
export async function createOtioTransportGate(
  context: AudioContext,
  onClosed: (ack: OtioGateAck) => void
): Promise<OtioTransportGate> {
  await context.audioWorklet.addModule(ASSET);
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
  const pending = new Map<number, Pending>();
  const fail = (error: Error) => {
    failed = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    normalPending = null;
    abortPending = null;
  };
  node.port.onmessage = (event: MessageEvent<OtioGateAck>) => {
    const ack = event.data;
    if (ack?.type === 'closed') {
      onClosed(ack);
      return;
    }
    const item = pending.get(ack?.sequence);
    if (!item) return;
    pending.delete(ack.sequence);
    if (normalPending === ack.sequence) normalPending = null;
    if (abortPending === ack.sequence) abortPending = null;
    item.resolve(ack);
  };
  node.port.onmessageerror = () =>
    fail(new Error('Transport gate message error'));
  node.onprocessorerror = () =>
    fail(new Error('Transport gate processor error'));
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
      pending.set(next, { resolve, reject });
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
      if (disposed) return;
      disposed = true;
      fail(new Error('Transport gate disposed'));
      node.port.onmessage = null;
      node.port.onmessageerror = null;
      node.onprocessorerror = null;
      node.port.close();
      node.disconnect();
    },
  };
}
