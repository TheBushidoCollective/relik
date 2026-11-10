export type OtioGateCommand =
  | {
      type: 'arm';
      generation: number;
      sequence: number;
      f0: number;
      throughFrame: number;
      slot: 0 | 1;
    }
  | {
      type: 'extend';
      generation: number;
      sequence: number;
      expectedThroughFrame: number;
      throughFrame: number;
    }
  | { type: 'stop'; generation: number; sequence: number; stopFrame: number }
  | { type: 'abort'; generation: number; sequence: number };

export interface OtioGateAck {
  clockEpoch: number;
  type: OtioGateCommand['type'] | 'closed';
  generation: number;
  sequence: number;
  accepted: boolean;
  throughFrame: number | null;
  closedFrame: number | null;
  reason?: string;
}

/** Why a bank decode rejected a quantum. Recorded only on a failing decode. */
export type OtioGateDecodeReason =
  | 'missing-frame'
  | 'missing-tag'
  | 'frame-length'
  | 'tag-length'
  | 'tag-mismatch'
  | 'non-finite-frame'
  | 'frame-residual'
  | 'frame-out-of-bank'
  | 'frame-progression'
  | 'unsafe-result'
  | 'bank-overrun'
  | 'expected-mismatch';

export interface OtioGateBankDescriptor {
  clockEpoch: number;
  bank: 0 | 1;
  serial: number;
  startFrame: number;
  endFrame: number;
}

/** Fixed-size summary of one raw parameter array. Scans at most one render quantum. */
export interface OtioGateDecodeRange {
  first: number;
  last: number;
  min: number;
  max: number;
  nonFinite: number;
  count: number;
}

/** Raw per-sample lanes of one bank, bounded to one render quantum. */
export interface OtioGateDecodeSamples {
  frame: number[];
  tag: number[];
}

/** Bounded evidence for a clock fault. Recorded once, on the terminal fault path only. */
export interface OtioGateDecodeDiagnostic {
  /** Which bank's decode rejected the quantum. */
  location: 'active' | 'warming';
  reason: OtioGateDecodeReason;
  failingSample: number;
  failingFrame: number | null;
  failingTag: number | null;
  length: number;
  cachedCurrentFrame: number;
  bank: OtioGateBankDescriptor;
  frame: OtioGateDecodeRange | null;
  tag: OtioGateDecodeRange | null;
  activeBank: OtioGateBankDescriptor;
  warmingBank: OtioGateBankDescriptor | null;
  samples: {
    active: OtioGateDecodeSamples;
    warming: OtioGateDecodeSamples | null;
  };
}

const frame = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Render-thread authority. A generation, once sealed, cannot be armed again. */
export class OtioTransportGateState {
  constructor(private readonly clockEpoch = 0) {}

  private generation = -1;
  private sequence = -1;
  private f0 = 0;
  private frontier: number | null = null;
  private closedFrame: number | null = null;
  private stopFrame: number | null = null;
  private slot: 0 | 1 = 0;

  private result(
    type: OtioGateAck['type'],
    generation: number,
    sequence: number,
    accepted: boolean,
    reason?: string
  ): OtioGateAck {
    return {
      type,
      clockEpoch: this.clockEpoch,
      generation,
      sequence,
      accepted,
      throughFrame: this.frontier,
      closedFrame: this.closedFrame,
      ...(reason ? { reason } : {}),
    };
  }

  /** Called at a quantum boundary and before every command, on the render thread. */
  expire(now: number): OtioGateAck | null {
    if (
      this.frontier === null ||
      this.closedFrame !== null ||
      now < this.frontier
    )
      return null;
    this.closedFrame = this.frontier;
    return this.result('closed', this.generation, this.sequence, true);
  }

  command(
    raw: unknown,
    now: number,
    coverage = Number.MAX_SAFE_INTEGER
  ): OtioGateAck {
    const value = raw as {
      type?: unknown;
      clockEpoch?: unknown;
      generation?: unknown;
      sequence?: unknown;
      f0?: unknown;
      throughFrame?: unknown;
      expectedThroughFrame?: unknown;
      stopFrame?: unknown;
      slot?: unknown;
    } | null;
    const type = value?.type;
    const generation = value?.generation;
    const sequence = value?.sequence;
    if (
      !value ||
      (this.clockEpoch !== 0 && value.clockEpoch !== this.clockEpoch) ||
      !frame(generation) ||
      !frame(sequence) ||
      !frame(now) ||
      (type !== 'arm' &&
        type !== 'extend' &&
        type !== 'stop' &&
        type !== 'abort')
    ) {
      return this.result(
        type === 'arm' ||
          type === 'extend' ||
          type === 'stop' ||
          type === 'abort'
          ? type
          : 'abort',
        frame(generation) ? generation : 0,
        frame(sequence) ? sequence : 0,
        false,
        'invalid command'
      );
    }
    if (sequence <= this.sequence)
      return this.result(type, generation, sequence, false, 'stale sequence');
    this.sequence = sequence;
    if (type === 'arm') {
      if (
        (value.slot !== 0 && value.slot !== 1) ||
        !frame(value.f0) ||
        !frame(value.throughFrame) ||
        value.throughFrame > coverage ||
        value.throughFrame <= value.f0 ||
        value.f0 < now ||
        generation <= this.generation ||
        (this.frontier !== null && this.closedFrame === null)
      ) {
        return this.result(
          type,
          generation,
          sequence,
          false,
          'invalid or late arm'
        );
      }
      this.generation = generation;
      this.slot = value.slot as 0 | 1;
      this.f0 = value.f0;
      this.frontier = value.throughFrame;
      this.closedFrame = null;
      this.stopFrame = null;
      return this.result(type, generation, sequence, true);
    }
    if (generation !== this.generation || this.frontier === null)
      return this.result(type, generation, sequence, false, 'stale generation');
    if (type === 'stop' && this.stopFrame !== null) {
      return this.result(
        type,
        generation,
        sequence,
        value.stopFrame === this.stopFrame,
        value.stopFrame === this.stopFrame ? undefined : 'conflicting stop'
      );
    }
    if (this.closedFrame !== null || now >= this.frontier) {
      if (this.closedFrame === null) this.closedFrame = this.frontier;
      return this.result(
        type,
        generation,
        sequence,
        false,
        'generation closed'
      );
    }
    if (type === 'abort') {
      this.closedFrame = now;
      return this.result(type, generation, sequence, true);
    }
    if (type === 'extend') {
      if (
        this.stopFrame !== null ||
        !frame(value.expectedThroughFrame) ||
        !frame(value.throughFrame) ||
        value.throughFrame > coverage ||
        value.expectedThroughFrame !== this.frontier ||
        value.throughFrame <= this.frontier
      )
        return this.result(
          type,
          generation,
          sequence,
          false,
          'invalid extension'
        );
      this.frontier = value.throughFrame;
      return this.result(type, generation, sequence, true);
    }
    if (
      !frame(value.stopFrame) ||
      value.stopFrame < now ||
      value.stopFrame < this.f0 ||
      value.stopFrame > this.frontier
    )
      return this.result(type, generation, sequence, false, 'invalid stop');
    this.frontier = value.stopFrame;
    this.stopFrame = value.stopFrame;
    return this.result(type, generation, sequence, true);
  }

  /** Writes every sample, including silent prefixes and suffixes, without allocation. */
  render(
    inputs: Float32Array[][],
    output: Float32Array[],
    start: number
  ): void {
    const end = this.closedFrame === null ? this.frontier : null;
    for (let channel = 0; channel < output.length; channel++) {
      const out = output[channel]!;
      const source = inputs[this.slot === 0 ? 0 : 2]?.[channel];
      for (let i = 0; i < out.length; i++) {
        const at = start + i;
        out[i] =
          end !== null && at >= this.f0 && at < end && source
            ? (source[i] ?? 0)
            : 0;
      }
    }
  }
}
