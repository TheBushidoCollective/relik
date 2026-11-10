/**
 * Canonical runtime type guards for @relic/format.
 *
 * `isRecord` proves only that a value is a non-array object. Its fields stay
 * `unknown` and must be checked where they are read.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
