// Policy for the early output-clock reader. The reader calls the clock once per
// read; these functions decide how often to read and when to stop. The clock's
// own guards (freshness, regression, spread, deadline) are unchanged.

/** Hard cap on reads per calibration, shared by every cadence. */
export const CALIBRATION_READ_LIMIT = 64;
/** Cadence while a usable stamp is waiting for calibration. */
export const CALIBRATION_FINE_CADENCE_MS = 4;
/** Cadence before a usable stamp appears, and after the fine reads are spent. */
export const CALIBRATION_COARSE_CADENCE_MS = 8;
/** Usable-stamp reads allowed at the fine cadence. */
export const CALIBRATION_FINE_READ_LIMIT = 16;

/** Counts reads and refuses the read beyond the limit. */
export class CalibrationReadBudget {
  private reads = 0;

  take(): boolean {
    if (this.reads >= CALIBRATION_READ_LIMIT) return false;
    this.reads++;
    return true;
  }

  get used(): number {
    return this.reads;
  }
}

/**
 * The next wait after a read that was not calibrated. Fine cadence applies only
 * while a usable stamp is pending and its reads are not yet spent, so the total
 * reads stay under the limit across the deadline.
 */
export function calibrationCadenceMs(input: {
  readonly usableStamp: boolean;
  readonly fineReads: number;
}): number {
  return input.usableStamp && input.fineReads < CALIBRATION_FINE_READ_LIMIT
    ? CALIBRATION_FINE_CADENCE_MS
    : CALIBRATION_COARSE_CADENCE_MS;
}

/**
 * A stamp is usable when both of its times are positive and finite. A stamp
 * read before the device has started reports zero and carries no offset.
 */
export function isUsableOutputStamp(
  stamp: {
    readonly contextTime?: number;
    readonly performanceTime?: number;
  } | null
): boolean {
  return (
    stamp !== null &&
    stamp.contextTime !== undefined &&
    stamp.performanceTime !== undefined &&
    Number.isFinite(stamp.contextTime) &&
    Number.isFinite(stamp.performanceTime) &&
    stamp.contextTime > 0 &&
    stamp.performanceTime > 0
  );
}

/**
 * Only an accepted observation proves a usable offset to the clock. Ring sizing
 * waits for that proof, so it never sizes from a zero or rejected stamp.
 */
export function observationProvesOutput(reason: string): boolean {
  return reason === 'accepted';
}
