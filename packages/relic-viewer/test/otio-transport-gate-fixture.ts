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
  node.emit({ type: 'clock-ready', clockEpoch: gate.clockEpoch });
  await gate.ready();
  const checkpoint = gate.checkpoint(1);
  node.emit({
    type: 'checkpoint',
    clockEpoch: gate.clockEpoch,
    nonce: 1,
    bankSerial: proof?.proofInitialSerial ?? 1,
    callbackOrdinal: 2,
    sampleCount: 256,
    lastCertifiedEnd: 256,
    quantumLength: 128,
    fault: false,
  });
  const snapshot = await checkpoint;
  const anchor = gate.acceptAnchor(snapshot);
  node.emit({
    type: 'anchor-accepted',
    clockEpoch: gate.clockEpoch,
    requestId: node.sent[node.sent.length - 1]!.requestId,
    clockCoverageEnd: 63488,
  });
  await anchor;
  return { gate, node };
}
