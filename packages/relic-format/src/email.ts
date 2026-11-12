/**
 * Email address normalization, the one definition every writer and reader of
 * an address shares. A private-share fingerprint is computed from the
 * normalized address, so the publisher, the viewer and the service must agree
 * on it byte for byte.
 *
 * Trim, then lowercase ASCII letters only. Anything else is kept as typed, so
 * a mailbox name with non-ASCII letters is never rewritten. Moved verbatim from
 * `relic-server/src/store.ts`.
 */

export function normalizeEmail(value: string): string {
  return value.trim().replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}
