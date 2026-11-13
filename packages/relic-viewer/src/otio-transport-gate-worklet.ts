import {
  OtioTransportGateState,
  type OtioGateDecodeDiagnostic,
  type OtioGateDecodeRange,
  type OtioGateDecodeReason,
  type OtioGateDecodeSamples,
} from './otio-transport-gate-state';

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

/** Scans at most one render quantum. Non-finite samples are counted, never folded into min or max. */
const summarizeLane = (
  values: Float32Array | undefined
): OtioGateDecodeRange | null => {
  if (!values || values.length === 0) return null;
  const scan = Math.min(values.length, MAX_QUANTUM);
  let min = Infinity;
  let max = -Infinity;
  let nonFinite = 0;
  for (let i = 0; i < scan; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value)) nonFinite++;
    else {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return {
    first: values[0]!,
    last: values[values.length - 1]!,
    min,
    max,
    nonFinite,
    count: values.length,
  };
};

/** Copies one bank's raw frame and tag lanes, bounded to one render quantum. Used only on fault. */
const copyLane = (
  parameters: Record<string, Float32Array | undefined>,
  bank: 0 | 1
): OtioGateDecodeSamples => {
  const lane = bank === 0 ? 'A' : 'B';
  const copy = (values: Float32Array | undefined): number[] =>
    values ? Array.from(values.subarray(0, MAX_QUANTUM)) : [];
  return {
    frame: copy(parameters[`clockFrame${lane}`]),
    tag: copy(parameters[`clockTag${lane}`]),
  };
};

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
  private callbacks = 0;
  private prestartSamples = 0;
  private readonly prestartBudget: number;
  private stalePrevious: StalePrevious | null = null;
  private staleCount = 0;
  private staleStopped = false;
  private staleLimit = 0;
  private staleCaptureId: number | null = null;

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
    // Only a running start carries a prestart budget. A frozen start omits it: no silence precedes it, so the budget is 0.
    const budget =
      'prestartBudgetFrames' in config
        ? config.prestartBudgetFrames
        : undefined;
    this.prestartBudget = integer(budget) ? budget : 0;
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
      (proofSerial !== undefined && proofSerial !== 2 ** 24 - 1) ||
      (budget !== undefined && !integer(budget))
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
      if (msg.type === 'proof-stale-start' || msg.type === 'proof-stale-stop') {
        if (!this.stalePrevious) return;
        if (
          !integer(msg.captureId) ||
          msg.captureId === 0 ||
          (msg.type === 'proof-stale-start'
            ? this.staleCaptureId !== null
            : this.staleCaptureId !== msg.captureId)
        ) {
          this.port.postMessage({
            type: 'clock-stale-control-error',
            clockEpoch: this.epoch,
            captureId: msg.captureId,
          });
          return;
        }
        if (msg.type === 'proof-stale-start') {
          this.staleCaptureId = msg.captureId;
          this.stalePrevious.callbackOrdinal = 0;
          this.staleCount = 0;
          this.staleStopped = false;
          this.port.postMessage({
            type: 'clock-stale-started',
            clockEpoch: this.epoch,
            captureId: msg.captureId,
            afterCallbackOrdinal: this.ordinal,
          });
        } else {
          this.port.postMessage({
            type: 'clock-stale-stopped',
            clockEpoch: this.epoch,
            captureId: msg.captureId,
            lastCallbackOrdinal: this.ordinal,
            pairs: this.staleCount,
            overflow: this.staleStopped,
          });
          this.staleCaptureId = null;
          this.stalePrevious.callbackOrdinal = 0;
        }
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

  private lastDecode: OtioGateDecodeDiagnostic | null = null;

  /** Records bounded evidence for a rejected decode. Returns null, so callers keep their rejection. */
  private diagnose(
    bank: Bank,
    parameters: Record<string, Float32Array | undefined>,
    length: number,
    reason: OtioGateDecodeReason,
    sample: number
  ): null {
    const lane = bank.bank === 0 ? 'A' : 'B';
    const frames = parameters[`clockFrame${lane}`];
    const tags = parameters[`clockTag${lane}`];
    const inside = sample >= 0 && sample < length;
    const tagIndex = tags && tags.length === 1 ? 0 : sample;
    const warming = this.warming;
    this.lastDecode = {
      location: warming !== null && bank === warming ? 'warming' : 'active',
      reason,
      failingSample: sample,
      failingFrame:
        frames && inside && sample < frames.length ? frames[sample]! : null,
      failingTag:
        tags && inside && tagIndex < tags.length ? tags[tagIndex]! : null,
      length,
      cachedCurrentFrame: currentFrame,
      bank,
      frame: summarizeLane(frames),
      tag: summarizeLane(tags),
      activeBank: this.active,
      warmingBank: warming,
      samples: {
        active: copyLane(parameters, this.active.bank),
        warming: warming ? copyLane(parameters, warming.bank) : null,
      },
    };
    return null;
  }

  private decode(
    bank: Bank,
    parameters: Record<string, Float32Array | undefined>,
    length: number
  ): number | null {
    this.lastDecode = null;
    const lane = bank.bank === 0 ? 'A' : 'B';
    const frames = parameters[`clockFrame${lane}`];
    const tags = parameters[`clockTag${lane}`];
    if (!frames)
      return this.diagnose(bank, parameters, length, 'missing-frame', -1);
    if (!tags)
      return this.diagnose(bank, parameters, length, 'missing-tag', -1);
    if (frames.length !== length)
      return this.diagnose(bank, parameters, length, 'frame-length', -1);
    if (tags.length !== 1 && tags.length !== length)
      return this.diagnose(bank, parameters, length, 'tag-length', -1);
    let first = 0;
    for (let i = 0; i < length; i++) {
      if (tags[tags.length === 1 ? 0 : i] !== bank.serial)
        return this.diagnose(bank, parameters, length, 'tag-mismatch', i);
      const value = frames[i]!;
      if (!Number.isFinite(value))
        return this.diagnose(bank, parameters, length, 'non-finite-frame', i);
      const rounded = Math.round(value);
      if (Math.abs(value - rounded) > 0.125)
        return this.diagnose(bank, parameters, length, 'frame-residual', i);
      if (rounded < 0 || rounded >= SPAN)
        return this.diagnose(bank, parameters, length, 'frame-out-of-bank', i);
      if (i > 0 && rounded !== first + i)
        return this.diagnose(bank, parameters, length, 'frame-progression', i);
      if (i === 0) first = rounded;
    }
    const result = bank.startFrame + first;
    if (!Number.isSafeInteger(result))
      return this.diagnose(bank, parameters, length, 'unsafe-result', -1);
    if (result + length > bank.endFrame)
      return this.diagnose(bank, parameters, length, 'bank-overrun', -1);
    return result;
  }

  private recordStale(
    parameters: Record<string, Float32Array>,
    frame: number,
    length: number
  ): void {
    const previous = this.stalePrevious;
    if (!previous || this.staleCaptureId === null || this.staleStopped) return;
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
        captureId: this.staleCaptureId,
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
          captureId: this.staleCaptureId,
        });
        return;
      }
      this.staleCount++;
      this.port.postMessage({
        type: 'clock-stale-pair',
        clockEpoch: this.epoch,
        captureId: this.staleCaptureId,
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

  /**
   * Classifies a block before the first tagged quantum. `silent` means every bank lane is exactly
   * zero and the carrier is absent, empty, or exactly zero on both channels. Anything else goes
   * through the strict tagged decode.
   */
  private prestartKind(
    inputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
    length: number
  ): 'silent' | 'carrier' | 'tagged' {
    for (const name of [
      'clockFrameA',
      'clockTagA',
      'clockFrameB',
      'clockTagB',
    ]) {
      const lane = parameters[name];
      if (!lane || lane.some((value) => value !== 0)) return 'tagged';
    }
    const carrier = inputs[1];
    // An unconnected or not-yet-started source reaches the worklet as an absent or empty input.
    if (!carrier || carrier.every((channel) => channel.length === 0))
      return 'silent';
    const left = carrier[0];
    const right = carrier[1];
    if (
      carrier.length !== 2 ||
      !left ||
      !right ||
      left.length !== length ||
      right.length !== length
    )
      return 'tagged';
    return left.every((value) => value === 0) &&
      right.every((value) => value === 0)
      ? 'silent'
      : 'carrier';
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
    if (this.overflow) return this.end(outputs, 'protocol-fault');
    this.callbacks++;
    // Before the first tagged quantum the only admissible block is exact silence.
    if (!this.anchored && this.expected === null) {
      const kind = this.prestartKind(inputs, parameters, length);
      if (kind === 'silent') {
        this.prestartSamples += length;
        if (this.prestartSamples > this.prestartBudget)
          return this.end(outputs, 'anchor-late', {
            firstFrame: this.active.startFrame,
            observedFrame: null,
            prestartSamples: this.prestartSamples,
            budget: this.prestartBudget,
          });
        this.silence(outputs);
        return true;
      }
      if (kind === 'carrier') {
        this.diagnose(
          this.active,
          parameters,
          length,
          'carrier-before-anchor',
          -1
        );
        return this.end(outputs, 'clock-fault', {
          expectedFrame: this.active.startFrame,
          observedFrame: -1,
          diagnostic: this.lastDecode,
        });
      }
    }
    const observed = this.decode(this.active, parameters, length);
    if (
      observed === null ||
      (this.expected !== null && observed !== this.expected)
    ) {
      if (observed !== null)
        this.diagnose(this.active, parameters, length, 'expected-mismatch', -1);
      return this.end(outputs, 'clock-fault', {
        expectedFrame: this.expected,
        observedFrame: observed ?? -1,
        diagnostic: this.lastDecode,
      });
    }
    if (this.overflow) return this.end(outputs, 'protocol-fault');
    if (!this.anchored) {
      const carrier = inputs[1];
      // The first tagged quantum landed past A: the start was missed, whether or not silence came first.
      if (this.samples === 0 && observed > this.active.startFrame)
        return this.end(outputs, 'anchor-late', {
          firstFrame: this.active.startFrame,
          observedFrame: observed,
          prestartSamples: this.prestartSamples,
          budget: this.prestartBudget,
        });
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
        if (this.decode(candidate, parameters, length) !== certifiedFrame)
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
      const compared = this.decode(this.warming, parameters, length);
      if (compared !== observed) {
        if (compared !== null)
          this.diagnose(
            this.warming,
            parameters,
            length,
            'expected-mismatch',
            -1
          );
        return this.end(outputs, 'clock-fault', {
          expectedFrame: observed,
          observedFrame: compared ?? -1,
          diagnostic: this.lastDecode,
        });
      }
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
    if (this.anchored) this.gate.render(inputs, output, observed);
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
      if (this.staleLimit)
        this.port.postMessage({
          type: 'proof-promotion-tags',
          clockEpoch: this.epoch,
          requestId: this.warmRequest,
          promoted: promote,
          retiredSerial: retired.serial,
          observed,
          tagA: Array.from(parameters.clockTagA ?? []),
          tagB: Array.from(parameters.clockTagB ?? []),
          frameA: Array.from(parameters.clockFrameA ?? []),
          frameB: Array.from(parameters.clockFrameB ?? []),
        });
    }
    return true;
  }
}
registerProcessor('otio-transport-gate', OtioTransportGateProcessor);
