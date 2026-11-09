// Candidate policy, not a calibrated physical-output accuracy bound. Qualification
// must freeze and measure these values before scheduled PCM can be claimed safe.
export const DEFAULT_CLOCK_POLICY = Object.freeze({
  maxSamples: 64,
  minAdvances: 3,
  minWindowMs: 30,
  freshnessMs: 50,
  futureToleranceMs: 2,
  maxOffsetSpreadMs: 10,
});
export type ClockPolicy = {
  maxSamples: number;
  minAdvances: number;
  minWindowMs: number;
  freshnessMs: number;
  futureToleranceMs: number;
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
  lastRejection: ClockRecord | null = null;
  state: ClockState = 'preparing';
  private first: ClockObservation | null = null;
  private last: ClockObservation | null = null;
  private advances = 0;
  private min = Infinity;
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
    this.state = 'playing';
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
      performanceTime! > readEnd + this.policy.futureToleranceMs ||
      contextTime! > contextAfter + this.policy.futureToleranceMs / 1000
    )
      reason = 'future';
    else if (readEnd - performanceTime! > this.policy.freshnessMs)
      reason = 'stale';
    else if (
      this.last &&
      (contextTime! < this.last.contextTime! ||
        performanceTime! < this.last.performanceTime!)
    )
      reason = 'regression';
    else if (
      this.last &&
      (contextTime === this.last.contextTime) !==
        (performanceTime === this.last.performanceTime)
    )
      reason = 'partial-advance';
    else if (
      this.last &&
      contextTime === this.last.contextTime &&
      performanceTime === this.last.performanceTime
    )
      reason = 'duplicate';
    else {
      const offset = performanceTime! - 1000 * contextTime!;
      const min = Math.min(this.min, offset),
        max = Math.max(this.max, offset);
      if (max - min > this.policy.maxOffsetSpreadMs) {
        reason = 'discontinuity';
        if (priorState === 'playing' || priorState === 'armed')
          this.invalidate(reason);
        else {
          this.first = null;
          this.last = null;
          this.advances = 0;
          this.min = Infinity;
          this.max = -Infinity;
          this.state = 'calibrating';
        }
      } else {
        this.min = min;
        this.max = max;
        if (!this.first) this.first = o;
        if (this.last) this.advances++;
        this.last = o;
        if (priorState !== 'playing' && priorState !== 'armed') {
          this.state =
            this.advances >= this.policy.minAdvances &&
            performanceTime! - this.first.performanceTime! >=
              this.policy.minWindowMs
              ? 'calibrated'
              : 'calibrating';
        }
      }
    }
    if (
      !terminal &&
      reason !== 'accepted' &&
      reason !== 'duplicate' &&
      reason !== 'discontinuity' &&
      priorState === 'playing'
    )
      this.invalidate(reason);
    if (
      reason === 'duplicate' &&
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
      priorState === 'armed'
    )
      this.invalidate(reason);
    if (
      !terminal &&
      reason !== 'accepted' &&
      reason !== 'duplicate' &&
      reason !== 'discontinuity' &&
      priorState !== 'playing' &&
      priorState !== 'armed' &&
      this.state !== 'failed'
    ) {
      this.first = null;
      this.last = null;
      this.advances = 0;
      this.min = Infinity;
      this.max = -Infinity;
      this.state = 'calibrating';
    }
    const result = this.result(reason);
    const record = { observation: o, result };
    if (priorState !== 'playing' && !terminal) this.observations.push(record);
    if (reason !== 'accepted' && reason !== 'duplicate')
      this.lastRejection = record;
    this.onObservation?.(record);
    return result;
  }
}
