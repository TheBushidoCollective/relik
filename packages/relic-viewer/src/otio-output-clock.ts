// Candidate policy, not a calibrated physical-output accuracy bound. Qualification
// must freeze and measure these values before scheduled PCM can be claimed safe.
export const DEFAULT_CLOCK_POLICY = Object.freeze({
  maxSamples: 64,
  minAdvances: 3,
  minWindowMs: 30,
  freshnessMs: 50,
  futureToleranceMs: 2,
  performanceLeadToleranceMs: 10,
  maxOffsetSpreadMs: 10,
});

// performanceLeadToleranceMs: how far a stamp's performanceTime may lead the read. On a sink that
// delivers a callback every 10 ms (Chrome 156, Linux, muted output) 2.2% of 10,178 reads led the
// read, by up to 2.1 ms, and one more run recorded 4.0 ms. The pair's offset stayed inside the
// calibrated window each time. The bound is set to that sink's callback period. The offset spread
// still judges the mapping. futureToleranceMs keeps bounding contextTime against currentTime,
// where no lead was seen.

// Chromium rounds performanceTime to a 100 us grid on a pseudo-random threshold
// (time_clamper.cc:43-58). Its per-quantum promotion (audio_destination.cc:739-758)
// can move contextTime while performanceTime holds still. An advance under two
// grid steps is therefore a held read: it never interrupts and never counts as
// evidence. Inputs 200 us or more apart never collapse onto one performanceTime.
export const PERFORMANCE_RESOLUTION_US = 100;
export type ClockPolicy = {
  maxSamples: number;
  minAdvances: number;
  minWindowMs: number;
  freshnessMs: number;
  futureToleranceMs: number;
  performanceLeadToleranceMs: number;
  maxOffsetSpreadMs: number;
};
export type ClockState =
  | 'preparing'
  | 'calibrating'
  | 'calibrated'
  | 'armed'
  | 'playing'
  | 'failed'
  | 'interrupted';
export type ClockObservation = {
  readBegin: number;
  readEnd: number;
  contextBefore: number;
  contextAfter: number;
  state: string;
  contextTime: number | undefined;
  performanceTime: number | undefined;
};
export type ClockResult = {
  status: ClockState;
  reason: string;
  offsetMin: number | null;
  offsetMax: number | null;
};
export type ClockRecord = {
  observation: ClockObservation;
  result: ClockResult;
};

export class OutputClock {
  readonly deadline: number;
  readonly observations: ClockRecord[] = [];
  readonly inheritedObservations: ClockObservation[] = [];
  lastRejection: ClockRecord | null = null;
  state: ClockState = 'preparing';
  private first: ClockObservation | null = null;
  private last: ClockObservation | null = null;
  private heldContextTime: number | null = null;
  private advances = 0;
  private min = Infinity;
  private readonly runtimeOffsets: {
    time: number;
    offset: number;
    observation: ClockObservation;
  }[] = [];
  private readonly recoveryOffsets: {
    time: number;
    offset: number;
    observation: ClockObservation;
  }[] = [];
  // Fork only, until it calibrates or resets: the samples calibration may count,
  // oldest first. An accepted read first drops every sample more than
  // freshnessMs older than its readEnd; a dropped sample never returns.
  private evidence:
    | { time: number; offset: number; observation: ClockObservation }[]
    | null = null;
  private max = -Infinity;
  constructor(
    readonly requestMs: number,
    readonly policy: ClockPolicy = DEFAULT_CLOCK_POLICY,
    readonly onObservation?: (record: ClockRecord) => void
  ) {
    if (
      !Number.isFinite(requestMs) ||
      !Number.isSafeInteger(policy.maxSamples) ||
      policy.maxSamples < 1 ||
      !Number.isSafeInteger(policy.minAdvances) ||
      policy.minAdvances < 1 ||
      ![
        policy.minWindowMs,
        policy.freshnessMs,
        policy.futureToleranceMs,
        policy.performanceLeadToleranceMs,
        policy.maxOffsetSpreadMs,
      ].every((n) => Number.isFinite(n) && n >= 0)
    )
      throw new Error('invalid clock policy');
    this.deadline = requestMs + 350;
  }
  private result(reason: string): ClockResult {
    return {
      status: this.state,
      reason,
      offsetMin: Number.isFinite(this.min) ? this.min : null,
      offsetMax: Number.isFinite(this.max) ? this.max : null,
    };
  }
  invalidate(reason: string): ClockResult {
    if (this.state !== 'failed' && this.state !== 'interrupted')
      this.state = this.state === 'playing' ? 'interrupted' : 'failed';
    return this.result(reason);
  }
  arm(): void {
    if (this.state !== 'calibrated') throw new Error('clock not calibrated');
    this.state = 'armed';
  }
  start(): void {
    if (this.state !== 'armed') throw new Error('clock not armed');
    const last = this.last!;
    this.runtimeOffsets.push({
      time: last.performanceTime!,
      offset: last.performanceTime! - 1000 * last.contextTime!,
      observation: last,
    });
    this.recoveryOffsets.push(this.runtimeOffsets[0]!);
    this.min = this.max = this.runtimeOffsets[0]!.offset;
    this.state = 'playing';
  }
  /** Last accepted pair. Mapping evidence comes from here, never from a held read. */
  get lastAccepted(): { contextTime: number; performanceTime: number } | null {
    if (!this.last) return null;
    return {
      contextTime: this.last.contextTime!,
      performanceTime: this.last.performanceTime!,
    };
  }
  /** Diagnostic copy for a failed recovery-fork probe. */
  recoveryEvidence(nowMs: number): {
    retained: Array<{ time: number; offset: number; readEnd: number }>;
    policy: ClockPolicy;
    nowMs: number;
  } {
    return {
      retained: this.recoveryOffsets.map((entry) => ({
        time: entry.time,
        offset: entry.offset,
        readEnd: entry.observation.readEnd,
      })),
      policy: { ...this.policy },
      nowMs,
    };
  }

  // Caller must bind this to the same uninterrupted AudioContext and sink.
  // A fork inherits only fresh, consistent samples, at least minAdvances of
  // them. It is not armed until a new advancing observation, read after the
  // request, completes calibration under the rule every clock uses: minAdvances
  // advances spanning minWindowMs. Only samples within freshnessMs of that
  // read's readEnd count, so inherited samples age out instead of carrying over.
  // A playback read can take the closing stamp before the request. Its first
  // valid re-read after the request counts once as that stamp's fork read.
  forkForRequest(
    requestMs: number,
    nowMs: number,
    onObservation?: (record: ClockRecord) => void
  ): OutputClock | null {
    const window = this.recoveryOffsets.filter(
      (entry) => nowMs - entry.time <= this.policy.freshnessMs
    );
    const first = window[0];
    const last = window[window.length - 1];
    if (
      this.state !== 'playing' ||
      !Number.isFinite(requestMs) ||
      !Number.isFinite(nowMs) ||
      nowMs < requestMs ||
      nowMs > requestMs + 350 ||
      !first ||
      !last ||
      nowMs < last.observation.readEnd ||
      nowMs - last.time > this.policy.freshnessMs ||
      window.length < this.policy.minAdvances ||
      window.length >= this.policy.maxSamples
    )
      return null;
    let min = Infinity;
    let max = -Infinity;
    for (const entry of window) {
      min = Math.min(min, entry.offset);
      max = Math.max(max, entry.offset);
    }
    if (max - min > this.policy.maxOffsetSpreadMs) return null;
    const fork = new OutputClock(requestMs, this.policy, onObservation);
    for (const entry of window)
      fork.inheritedObservations.push({ ...entry.observation });
    fork.evidence = window.map((entry, index) => ({
      time: entry.time,
      offset: entry.offset,
      observation: fork.inheritedObservations[index]!,
    }));
    fork.first = fork.inheritedObservations[0]!;
    fork.last =
      fork.inheritedObservations[fork.inheritedObservations.length - 1]!;
    if (last.observation === this.last)
      fork.heldContextTime = this.heldContextTime;
    fork.advances = window.length - 1;
    fork.min = min;
    fork.max = max;
    fork.state = 'calibrating';
    return fork;
  }
  observe(observation: ClockObservation): ClockResult {
    const o = { ...observation };
    let reason = 'accepted';
    const priorState = this.state;
    const terminal = priorState === 'failed' || priorState === 'interrupted';
    const {
      readBegin,
      readEnd,
      contextBefore,
      contextAfter,
      contextTime,
      performanceTime,
    } = o;
    const numbers = [
      readBegin,
      readEnd,
      contextBefore,
      contextAfter,
      contextTime,
      performanceTime,
    ];
    const rereadInherited =
      this.evidence !== null &&
      this.last !== null &&
      this.last === this.inheritedObservations.at(-1) &&
      contextTime === this.last.contextTime &&
      performanceTime === this.last.performanceTime;
    const last = rereadInherited
      ? (this.evidence!.at(-2)?.observation ?? null)
      : this.last;
    if (terminal) reason = 'terminal';
    else if (priorState !== 'playing' && readEnd > this.deadline) {
      this.invalidate('deadline');
      reason = 'deadline';
    } else if (
      this.observations.length >= this.policy.maxSamples &&
      priorState !== 'playing'
    ) {
      this.invalidate('sample-cap');
      reason = 'sample-cap';
    } else if (
      !numbers.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
      reason = 'nonfinite-or-missing';
    else if (
      readBegin > readEnd ||
      contextBefore > contextAfter ||
      readBegin < this.requestMs
    )
      reason = 'invalid-bracket';
    else if (o.state !== 'running') reason = 'context-not-running';
    else if (contextTime! <= 0 || performanceTime! <= 0)
      reason = 'unusable-zero';
    else if (
      performanceTime! > readEnd + this.policy.performanceLeadToleranceMs ||
      contextTime! > contextAfter + this.policy.futureToleranceMs / 1000
    )
      reason = 'future';
    else if (readEnd - performanceTime! > this.policy.freshnessMs)
      reason = 'stale';
    else if (
      last &&
      (contextTime! <
        Math.max(last.contextTime!, this.heldContextTime ?? -Infinity) ||
        performanceTime! < last.performanceTime!)
    )
      reason = 'regression';
    else if (
      last &&
      performanceTime === last.performanceTime &&
      contextTime !== last.contextTime &&
      Math.round(1e6 * (contextTime! - last.contextTime!)) <
        2 * PERFORMANCE_RESOLUTION_US
    ) {
      reason = 'sub-resolution';
      this.heldContextTime = Math.max(
        this.heldContextTime ?? -Infinity,
        contextTime!
      );
    } else if (
      last &&
      (contextTime === last.contextTime) !==
        (performanceTime === last.performanceTime)
    )
      reason = 'partial-advance';
    else if (
      last &&
      contextTime === last.contextTime &&
      performanceTime === last.performanceTime
    )
      reason = 'duplicate';
    else {
      const offset = performanceTime! - 1000 * contextTime!;
      let min = Math.min(this.min, offset);
      let max = Math.max(this.max, offset);
      if (priorState === 'playing') {
        const window = this.runtimeOffsets;
        const cutoff = performanceTime! - this.policy.minWindowMs;
        while (window.length > 1 && window[1]!.time < cutoff) window.shift();
        min = offset;
        max = offset;
        for (const entry of window) {
          min = Math.min(min, entry.offset);
          max = Math.max(max, entry.offset);
        }
        if (window.length >= this.policy.maxSamples) {
          reason = 'runtime-window-cap';
          this.invalidate(reason);
        }
      }
      if (reason === 'runtime-window-cap') {
        // Do not discard in-window evidence to make room for a new sample.
      } else if (max - min > this.policy.maxOffsetSpreadMs) {
        reason = 'discontinuity';
        if (priorState === 'playing' || priorState === 'armed')
          this.invalidate(reason);
        else {
          this.first = null;
          this.last = null;
          this.heldContextTime = null;
          this.advances = 0;
          this.min = Infinity;
          this.max = -Infinity;
          this.evidence = null;
          this.state = 'calibrating';
        }
      } else {
        this.min = min;
        this.max = max;
        if (this.evidence) {
          if (rereadInherited) this.evidence.pop();
          while (
            this.evidence.length > 0 &&
            readEnd - this.evidence[0]!.time > this.policy.freshnessMs
          )
            this.evidence.shift();
          this.evidence.push({
            time: performanceTime!,
            offset,
            observation: o,
          });
          this.first = this.evidence[0]!.observation;
          this.advances = this.evidence.length - 1;
        } else {
          if (!this.first) this.first = o;
          if (this.last) this.advances++;
        }
        this.last = o;
        this.heldContextTime = null;
        if (priorState === 'playing') {
          const entry = { time: performanceTime!, offset, observation: o };
          this.runtimeOffsets.push(entry);
          this.recoveryOffsets.push(entry);
          while (
            this.recoveryOffsets.length > 1 &&
            this.recoveryOffsets[0]!.time < entry.time - this.policy.freshnessMs
          )
            this.recoveryOffsets.shift();
          if (this.recoveryOffsets.length > this.policy.maxSamples)
            this.recoveryOffsets.shift();
        }
        if (priorState !== 'playing' && priorState !== 'armed') {
          this.state =
            this.advances >= this.policy.minAdvances &&
            performanceTime! - this.first.performanceTime! >=
              this.policy.minWindowMs
              ? 'calibrated'
              : 'calibrating';
          if (this.state === 'calibrated') this.evidence = null;
        }
      }
    }
    if (
      !terminal &&
      reason !== 'accepted' &&
      reason !== 'duplicate' &&
      reason !== 'sub-resolution' &&
      reason !== 'discontinuity' &&
      priorState === 'playing'
    )
      this.invalidate(reason);
    if (
      (reason === 'duplicate' || reason === 'sub-resolution') &&
      this.last &&
      readEnd - this.last.performanceTime! > this.policy.freshnessMs
    ) {
      reason = 'stagnant';
      if (priorState === 'playing' || priorState === 'armed')
        this.invalidate(reason);
    }
    if (
      reason !== 'accepted' &&
      reason !== 'duplicate' &&
      reason !== 'discontinuity' &&
      reason !== 'sub-resolution' &&
      priorState === 'armed'
    )
      this.invalidate(reason);
    if (
      !terminal &&
      reason !== 'accepted' &&
      reason !== 'duplicate' &&
      reason !== 'discontinuity' &&
      reason !== 'sub-resolution' &&
      priorState !== 'playing' &&
      priorState !== 'armed' &&
      this.state !== 'failed'
    ) {
      this.first = null;
      this.last = null;
      this.heldContextTime = null;
      this.advances = 0;
      this.min = Infinity;
      this.max = -Infinity;
      this.evidence = null;
      this.state = 'calibrating';
    }
    const result = this.result(reason);
    const record = { observation: o, result };
    if (priorState !== 'playing' && !terminal) this.observations.push(record);
    if (
      reason !== 'accepted' &&
      reason !== 'duplicate' &&
      reason !== 'sub-resolution'
    )
      this.lastRejection = record;
    this.onObservation?.(record);
    return result;
  }
}

/**
 * The pair a read may map time with. A held read adds no evidence, so it
 * resolves to the clock's last accepted pair. Every other read keeps its own
 * stamp. Null only for a held read with no accepted pair, which the hold rule
 * never produces.
 */
export function evidencePair(
  clock: OutputClock,
  result: ClockResult,
  contextTime: number,
  performanceTime: number
): { contextTime: number; performanceTime: number } | null {
  if (result.reason !== 'sub-resolution')
    return { contextTime, performanceTime };
  return clock.lastAccepted;
}
