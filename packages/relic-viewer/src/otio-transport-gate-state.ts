export type OtioGateCommand =
  | {
      type: 'arm';
      generation: number;
      sequence: number;
      f0: number;
      throughFrame: number;
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
  type: OtioGateCommand['type'] | 'closed';
  generation: number;
  sequence: number;
  accepted: boolean;
  throughFrame: number | null;
  closedFrame: number | null;
  reason?: string;
}

const frame = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Render-thread authority. A generation, once sealed, cannot be armed again. */
export class OtioTransportGateState {
  private generation = -1;
  private sequence = -1;
  private f0 = 0;
  private frontier: number | null = null;
  private closedFrame: number | null = null;
  private stopFrame: number | null = null;

  private result(
    type: OtioGateAck['type'],
    generation: number,
    sequence: number,
    accepted: boolean,
    reason?: string
  ): OtioGateAck {
    return {
      type,
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

  command(raw: unknown, now: number): OtioGateAck {
    const value = raw as {
      type?: unknown;
      generation?: unknown;
      sequence?: unknown;
      f0?: unknown;
      throughFrame?: unknown;
      expectedThroughFrame?: unknown;
      stopFrame?: unknown;
    } | null;
    const type = value?.type;
    const generation = value?.generation;
    const sequence = value?.sequence;
    if (
      !value ||
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
        !frame(value.f0) ||
        !frame(value.throughFrame) ||
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
    input: Float32Array[] | undefined,
    output: Float32Array[],
    start: number
  ): void {
    const end = this.closedFrame === null ? this.frontier : null;
    for (let channel = 0; channel < output.length; channel++) {
      const out = output[channel]!;
      const source = input?.[channel];
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
