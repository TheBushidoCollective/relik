import { OtioTransportGateState } from './otio-transport-gate-state';

declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor
): void;

class OtioTransportGateProcessor extends AudioWorkletProcessor {
  private readonly gate = new OtioTransportGateState();
  private disposed = false;
  private expectedFrame: number | null = null;
  private firstCommand: unknown;
  private secondCommand: unknown;
  private commandCount = 0;
  private commandOverflow = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (this.disposed) return;
      if (
        event.data !== null &&
        typeof event.data === 'object' &&
        'type' in event.data &&
        event.data.type === 'dispose'
      ) {
        this.disposed = true;
        return;
      }
      if (this.commandCount === 0) this.firstCommand = event.data;
      else if (this.commandCount === 1) this.secondCommand = event.data;
      else {
        this.commandOverflow = true;
        return;
      }
      this.commandCount++;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.disposed) {
      for (const output of outputs) {
        for (const channel of output) channel.fill(0);
      }
      this.port.postMessage({ type: 'disposed' });
      return false;
    }
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const observed = currentFrame;
    if (
      !Number.isSafeInteger(observed) ||
      observed < 0 ||
      (this.expectedFrame !== null && observed !== this.expectedFrame)
    ) {
      for (let channel = 0; channel < output.length; channel++)
        output[channel]!.fill(0);
      this.disposed = true;
      this.port.postMessage({
        type: 'clock-fault',
        expectedFrame: this.expectedFrame,
        observedFrame: observed,
      });
      return false;
    }
    this.expectedFrame = observed + output[0]!.length;
    if (this.commandOverflow) {
      for (let channel = 0; channel < output.length; channel++)
        output[channel]!.fill(0);
      this.disposed = true;
      this.port.postMessage({ type: 'protocol-fault' });
      return false;
    }
    const expiredBefore = this.gate.expire(observed);
    if (expiredBefore) this.port.postMessage(expiredBefore);
    if (this.commandCount > 0) {
      this.port.postMessage(this.gate.command(this.firstCommand, observed));
      this.firstCommand = undefined;
    }
    if (this.commandCount > 1) {
      this.port.postMessage(this.gate.command(this.secondCommand, observed));
      this.secondCommand = undefined;
    }
    this.commandCount = 0;
    this.gate.render(inputs[0], output, observed);
    const expired = this.gate.expire(this.expectedFrame);
    if (expired) this.port.postMessage(expired);
    return true;
  }
}

registerProcessor('otio-transport-gate', OtioTransportGateProcessor);
