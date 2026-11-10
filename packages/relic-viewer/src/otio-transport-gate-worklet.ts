import { OtioTransportGateState } from './otio-transport-gate-state';

declare const currentFrame: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor
): void;

type Bank = {
  clockEpoch: number;
  bank: 0 | 1;
  serial: number;
  startFrame: number;
  endFrame: number;
};
type StalePrevious = {
  callbackOrdinal: number;
  sampleCount: number;
  cachedCurrentFrame: number;
  certifiedFrame: number;
  quantumLength: number;
  active: Bank;
  warming: Bank | null;
  frameA: Float32Array;
  tagA: Float32Array;
  frameB: Float32Array;
  tagB: Float32Array;
  frameALength: number;
  tagALength: number;
  frameBLength: number;
  tagBLength: number;
};
const SPAN = 65536;
const STEP = 32768;
const MAX_QUANTUM = 2048;
const EMPTY = new Float32Array(0);
const integer = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

class OtioTransportGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['clockFrameA', 'clockTagA', 'clockFrameB', 'clockTagB'].map(
      (name) => ({ name, defaultValue: 0, automationRate: 'a-rate' })
    );
  }
  private readonly epoch: number;
  private readonly gate: OtioTransportGateState;
  private active: Bank;
  private warming: Bank | null = null;
  private warmRequest = 0;
  private expected: number | null = null;
  private ordinal = 0;
  private samples = 0;
  private quantum = 0;
  private anchored = false;
  private clockCommand: Record<string, unknown> | null = null;
  private firstCommand: Record<string, unknown> | null = null;
  private secondCommand: Record<string, unknown> | null = null;
  private overflow = false;
  private terminal = false;
  private terminalSent = false;
  private readonly traceMaxCallbacks: number;
  private traceRemaining = -1;
  private stalePrevious: StalePrevious | null = null;
  private staleCount = 0;
  private staleStopped = false;
  private staleLimit = 0;

  constructor(options?: unknown) {
    super(options);
    const config =
      options &&
      typeof options === 'object' &&
      'processorOptions' in options &&
      options.processorOptions &&
      typeof options.processorOptions === 'object'
        ? options.processorOptions
        : {};
    const epoch = 'clockEpoch' in config ? config.clockEpoch : undefined;
    const start = 'initialFrame' in config ? config.initialFrame : undefined;
    const proofSerial =
      'proofInitialSerial' in config ? config.proofInitialSerial : undefined;
    const traceLimit =
      'traceMaxCallbacks' in config ? config.traceMaxCallbacks : 0;
    const staleLimit =
      'proofStaleMaxPairs' in config ? config.proofStaleMaxPairs : 0;
    this.staleLimit = staleLimit === 16 ? 16 : 0;
    this.traceMaxCallbacks =
      integer(traceLimit) && traceLimit > 0 && traceLimit <= 512
        ? traceLimit
        : 0;
    this.epoch = integer(epoch) && epoch > 0 ? epoch : 0;
    const initial = integer(start) ? start : 0;
    this.active = {
      clockEpoch: this.epoch,
      bank: 0,
      serial: proofSerial === 2 ** 24 - 1 ? proofSerial : 1,
      startFrame: initial,
      endFrame: initial + SPAN,
    };
    if (this.staleLimit) {
      this.stalePrevious = {
        callbackOrdinal: 0,
        sampleCount: 0,
        cachedCurrentFrame: 0,
        certifiedFrame: 0,
        quantumLength: 0,
        active: this.active,
        warming: null,
        frameA: new Float32Array(MAX_QUANTUM),
        tagA: new Float32Array(MAX_QUANTUM),
        frameB: new Float32Array(MAX_QUANTUM),
        tagB: new Float32Array(MAX_QUANTUM),
        frameALength: 0,
        tagALength: 0,
        frameBLength: 0,
        tagBLength: 0,
      };
    }
    this.gate = new OtioTransportGateState(this.epoch);
    if (
      !this.epoch ||
      !integer(start) ||
      initial + SPAN > 2 ** 40 ||
      (proofSerial !== undefined && proofSerial !== 2 ** 24 - 1)
    )
      this.overflow = true;
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (this.terminal || !event.data || typeof event.data !== 'object')
        return;
      const msg = event.data as Record<string, unknown>;
      if (msg.clockEpoch !== this.epoch) return;
      if (msg.type === 'proof-trace-start' && this.traceMaxCallbacks) {
        this.traceRemaining = this.traceMaxCallbacks;
        this.port.postMessage({
          type: 'clock-trace-started',
          clockEpoch: this.epoch,
        });
        return;
      }
      if (msg.type === 'proof-trace-stop' && this.traceMaxCallbacks) {
        this.traceRemaining = -1;
        this.port.postMessage({
          type: 'clock-trace-stopped',
          clockEpoch: this.epoch,
        });
        return;
      }
      if (msg.type === 'dispose') {
        this.terminal = true;
        return;
      }
      if (msg.type === 'install-bank') {
        if (this.clockCommand) this.overflow = true;
        else this.clockCommand = msg;
        return;
      }
      if (!this.firstCommand) this.firstCommand = msg;
      else if (
        !this.secondCommand &&
        (msg.type === 'abort' || this.firstCommand.type === 'abort')
      )
        this.secondCommand = msg;
      else this.overflow = true;
    };
  }

  private decode(
    bank: Bank,
    frames: Float32Array | undefined,
    tags: Float32Array | undefined,
    length: number
  ): number | null {
    if (
      !frames ||
      frames.length !== length ||
      !tags ||
      (tags.length !== 1 && tags.length !== length)
    )
      return null;
    let first = 0;
    for (let i = 0; i < length; i++) {
      if (tags[tags.length === 1 ? 0 : i] !== bank.serial) return null;
      const value = frames[i]!;
      const rounded = Math.round(value);
      if (
        !Number.isFinite(value) ||
        Math.abs(value - rounded) > 0.125 ||
        rounded < 0 ||
        rounded >= SPAN ||
        (i > 0 && rounded !== first + i)
      )
        return null;
      if (i === 0) first = rounded;
    }
    const result = bank.startFrame + first;
    return Number.isSafeInteger(result) && result + length <= bank.endFrame
      ? result
      : null;
  }

  private recordStale(
    parameters: Record<string, Float32Array>,
    frame: number,
    length: number
  ): void {
    const previous = this.stalePrevious;
    if (!previous || this.staleStopped) return;
    const frameA = parameters.clockFrameA ?? EMPTY;
    const tagA = parameters.clockTagA ?? EMPTY;
    const frameB = parameters.clockFrameB ?? EMPTY;
    const tagB = parameters.clockTagB ?? EMPTY;
    if (
      frameA.length > MAX_QUANTUM ||
      tagA.length > MAX_QUANTUM ||
      frameB.length > MAX_QUANTUM ||
      tagB.length > MAX_QUANTUM
    ) {
      this.staleStopped = true;
      this.port.postMessage({
        type: 'clock-stale-overflow',
        clockEpoch: this.epoch,
      });
      return;
    }
    if (
      previous.callbackOrdinal !== 0 &&
      previous.cachedCurrentFrame === currentFrame
    ) {
      if (this.staleCount >= this.staleLimit) {
        this.staleStopped = true;
        this.port.postMessage({
          type: 'clock-stale-overflow',
          clockEpoch: this.epoch,
        });
        return;
      }
      this.staleCount++;
      this.port.postMessage({
        type: 'clock-stale-pair',
        clockEpoch: this.epoch,
        previous: {
          callbackOrdinal: previous.callbackOrdinal,
          sampleCount: previous.sampleCount,
          cachedCurrentFrame: previous.cachedCurrentFrame,
          certifiedFrame: previous.certifiedFrame,
          quantumLength: previous.quantumLength,
          active: previous.active,
          warming: previous.warming,
          clockFrameA: Array.from(
            previous.frameA.subarray(0, previous.frameALength)
          ),
          clockTagA: Array.from(previous.tagA.subarray(0, previous.tagALength)),
          clockFrameB: Array.from(
            previous.frameB.subarray(0, previous.frameBLength)
          ),
          clockTagB: Array.from(previous.tagB.subarray(0, previous.tagBLength)),
        },
        current: {
          callbackOrdinal: this.ordinal,
          sampleCount: this.samples - length,
          cachedCurrentFrame: currentFrame,
          certifiedFrame: frame,
          quantumLength: length,
          active: this.active,
          warming: this.warming,
          clockFrameA: Array.from(frameA),
          clockTagA: Array.from(tagA),
          clockFrameB: Array.from(frameB),
          clockTagB: Array.from(tagB),
        },
      });
    }
    previous.callbackOrdinal = this.ordinal;
    previous.sampleCount = this.samples - length;
    previous.cachedCurrentFrame = currentFrame;
    previous.certifiedFrame = frame;
    previous.quantumLength = length;
    previous.active = this.active;
    previous.warming = this.warming;
    previous.frameA.set(frameA);
    previous.tagA.set(tagA);
    previous.frameB.set(frameB);
    previous.tagB.set(tagB);
    previous.frameALength = frameA.length;
    previous.tagALength = tagA.length;
    previous.frameBLength = frameB.length;
    previous.tagBLength = tagB.length;
  }

  private silence(outputs: Float32Array[][]) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
  }
  private end(
    outputs: Float32Array[][],
    type: string,
    detail: object = {}
  ): false {
    this.silence(outputs);
    this.terminal = true;
    if (!this.terminalSent) {
      this.terminalSent = true;
      this.port.postMessage({ type, clockEpoch: this.epoch, ...detail });
    }
    return false;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    if (this.terminal) return this.end(outputs, 'disposed');
    const output = outputs[0];
    const length = output?.[0]?.length ?? 0;
    if (
      !output ||
      output.length !== 2 ||
      length < 2 ||
      length > MAX_QUANTUM ||
      output[1]!.length !== length
    )
      return this.end(outputs, 'clock-fault', {
        expectedFrame: this.expected,
        observedFrame: -1,
      });
    const suffix = this.active.bank === 0 ? 'A' : 'B';
    const observed = this.decode(
      this.active,
      parameters['clockFrame' + suffix],
      parameters['clockTag' + suffix],
      length
    );
    if (
      observed === null ||
      (this.expected !== null && observed !== this.expected)
    )
      return this.end(outputs, 'clock-fault', {
        expectedFrame: this.expected,
        observedFrame: observed ?? -1,
      });
    if (this.overflow) return this.end(outputs, 'protocol-fault');
    if (!this.anchored) {
      const carrier = inputs[1];
      if (
        observed !== this.active.startFrame + this.samples ||
        !carrier ||
        carrier.length !== 2 ||
        carrier[0]?.length !== length ||
        carrier[1]?.length !== length ||
        this.samples + length > 8192
      )
        return this.end(outputs, 'clock-fault', {
          expectedFrame: this.active.startFrame + this.samples,
          observedFrame: observed,
        });
      for (let i = 0; i < length; i++) {
        const frame = observed + i;
        if (
          carrier[0]![i] !== 1 + Math.floor(frame / 65536) ||
          carrier[1]![i] !== frame % 65536
        )
          return this.end(outputs, 'clock-fault', {
            expectedFrame: frame,
            observedFrame: -1,
          });
      }
    }
    if (this.traceRemaining > 0) {
      let certifiedFrame =
        observed !== null &&
        (this.expected === null || observed === this.expected) &&
        !this.overflow
          ? observed
          : null;
      const candidate = this.warming;
      if (
        certifiedFrame !== null &&
        candidate &&
        certifiedFrame >= candidate.startFrame &&
        certifiedFrame + length <= candidate.endFrame
      ) {
        const suffix = candidate.bank === 0 ? 'A' : 'B';
        if (
          this.decode(
            candidate,
            parameters['clockFrame' + suffix],
            parameters['clockTag' + suffix],
            length
          ) !== certifiedFrame
        )
          certifiedFrame = null;
      }
      this.port.postMessage({
        type: 'clock-trace',
        clockEpoch: this.epoch,
        callbackOrdinal: this.ordinal + 1,
        sampleCount: this.samples,
        cachedCurrentFrame: currentFrame,
        certifiedFrame,
        active: this.active,
        warming: this.warming,
        clockFrameA: Array.from(parameters.clockFrameA ?? []),
        clockTagA: Array.from(parameters.clockTagA ?? []),
        clockFrameB: Array.from(parameters.clockFrameB ?? []),
        clockTagB: Array.from(parameters.clockTagB ?? []),
      });
      this.traceRemaining--;
    } else if (this.traceRemaining === 0) {
      this.traceRemaining = -1;
      this.port.postMessage({
        type: 'clock-trace-overflow',
        clockEpoch: this.epoch,
      });
    }
    this.expected = observed + length;
    this.ordinal++;
    this.samples += length;
    this.quantum = length;
    if (!Number.isSafeInteger(this.samples))
      return this.end(outputs, 'protocol-fault');
    if (!this.anchored && this.ordinal === 2) {
      this.anchored = true;
      this.port.postMessage({
        type: 'anchor-certified',
        clockEpoch: this.epoch,
        firstFrame: this.active.startFrame,
        lastCertifiedEnd: this.expected,
        sampleCount: this.samples,
        callbackOrdinal: this.ordinal,
        quantumLength: this.quantum,
        bankSerial: this.active.serial,
        clockCoverageEnd: this.active.endFrame - MAX_QUANTUM,
      });
    }
    const clockCommand = this.clockCommand;
    this.clockCommand = null;
    if (clockCommand?.type === 'install-bank') {
      const b = clockCommand.descriptor as Bank;
      const valid =
        b &&
        b.clockEpoch === this.epoch &&
        b.bank === 1 - this.active.bank &&
        integer(b.serial) &&
        b.serial === this.active.serial + 1 &&
        b.serial <= 2 ** 24 - 1 &&
        b.startFrame === this.active.startFrame + STEP &&
        b.endFrame === b.startFrame + SPAN &&
        b.endFrame <= 2 ** 40 &&
        !this.warming &&
        integer(clockCommand.requestId) &&
        b.startFrame - this.expected >= Math.max(512, 2 * length);
      if (!valid)
        this.port.postMessage({
          type: 'bank-rejected',
          clockEpoch: this.epoch,
          requestId: clockCommand.requestId,
        });
      else {
        this.warming = b;
        this.warmRequest = clockCommand.requestId as number;
        this.port.postMessage({
          type: 'bank-installed',
          clockEpoch: this.epoch,
          requestId: this.warmRequest,
          descriptor: b,
        });
      }
    }
    let promote: Bank | null = null;
    if (
      this.warming &&
      observed >= this.warming.startFrame &&
      this.expected <= this.warming.endFrame
    ) {
      const suffix = this.warming.bank === 0 ? 'A' : 'B';
      const compared = this.decode(
        this.warming,
        parameters['clockFrame' + suffix],
        parameters['clockTag' + suffix],
        length
      );
      if (compared !== observed)
        return this.end(outputs, 'clock-fault', {
          expectedFrame: observed,
          observedFrame: compared ?? -1,
        });
      promote = this.warming;
    }
    this.recordStale(parameters, observed, length);
    const expiredBefore = this.gate.expire(observed);
    if (expiredBefore) this.port.postMessage(expiredBefore);
    if (this.firstCommand || this.secondCommand) {
      if (!this.anchored) return this.end(outputs, 'protocol-fault');
      if (this.firstCommand)
        this.port.postMessage(
          this.gate.command(
            this.firstCommand,
            observed,
            this.active.endFrame - MAX_QUANTUM
          )
        );
      if (this.secondCommand)
        this.port.postMessage(
          this.gate.command(
            this.secondCommand,
            observed,
            this.active.endFrame - MAX_QUANTUM
          )
        );
    }
    this.firstCommand = this.secondCommand = null;
    if (this.anchored) this.gate.render(inputs[0], output, observed);
    else this.silence(outputs);
    const expired = this.gate.expire(this.expected);
    if (expired) this.port.postMessage(expired);
    if (promote) {
      const retired = this.active;
      this.active = promote;
      this.warming = null;
      this.port.postMessage({
        type: 'clock-promoted',
        clockEpoch: this.epoch,
        requestId: this.warmRequest,
        active: promote,
        retired,
        boundary: this.expected,
        clockCoverageEnd: promote.endFrame - MAX_QUANTUM,
      });
    }
    return true;
  }
}
registerProcessor('otio-transport-gate', OtioTransportGateProcessor);
