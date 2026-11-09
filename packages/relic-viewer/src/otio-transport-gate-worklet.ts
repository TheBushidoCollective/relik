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

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const expired = this.gate.expire(currentFrame);
      if (expired) this.port.postMessage(expired);
      this.port.postMessage(this.gate.command(event.data, currentFrame));
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    this.gate.render(inputs[0], output, currentFrame);
    const expired = this.gate.expire(currentFrame + output[0]!.length);
    if (expired) this.port.postMessage(expired);
    return true;
  }
}

registerProcessor('otio-transport-gate', OtioTransportGateProcessor);
