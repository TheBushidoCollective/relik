import {
  createOtioTransportGate,
  type OtioGateAck,
} from '../src/otio-transport-gate';

const param = () => ({
  cancelScheduledValues() {},
  setValueAtTime() {},
  linearRampToValueAtTime() {},
});
export class FakeGateNode {
  constructor(
    _context: AudioContext,
    _name: string,
    readonly options: AudioWorkletNodeOptions
  ) {}
  parameters = new Map(
    ['clockFrameA', 'clockTagA', 'clockFrameB', 'clockTagB'].map((name) => [
      name,
      param(),
    ])
  );
  sent: Array<Record<string, unknown>> = [];
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onmessageerror: null,
    postMessage: (value: Record<string, unknown>) => {
      this.sent.push(value);
    },
    close() {},
  };
  onprocessorerror = null;
  connect() {}
  disconnect() {}
  emit(data: Record<string, unknown>) {
    this.port.onmessage?.({ data });
  }
}
export const fakeGateContext = () =>
  ({
    state: 'suspended',
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    audioWorklet: { addModule: async () => {} },
    createBuffer: (_channels: number, frames: number) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      detune: { value: 0 },
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    }),
    createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
  }) as unknown as AudioContext;

export async function anchoredGate(
  onClosed: (ack: OtioGateAck) => void = () => {},
  onError?: (error: Error) => void,
  proof?: { proofInitialSerial: number }
) {
  const gate = await createOtioTransportGate(
    fakeGateContext(),
    onClosed,
    onError,
    0,
    proof
  );
  const node = gate.node as unknown as FakeGateNode;
  node.emit({
    type: 'anchor-certified',
    clockEpoch: gate.clockEpoch,
    firstFrame: 0,
    lastCertifiedEnd: 256,
    sampleCount: 256,
    callbackOrdinal: 2,
    quantumLength: 128,
    bankSerial: proof?.proofInitialSerial ?? 1,
    clockCoverageEnd: 63488,
  });
  await gate.ready();
  return { gate, node };
}
