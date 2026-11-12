/**
 * A signed statement from the service that does not verify under the key it
 * must be signed by: a grant, a recovery designation, a device certificate or
 * a seal. Nothing is wrapped or sent for it. The message is a sentence the
 * owner or reader can read, and `problemMessage` shows it as written.
 */
export class VerificationRefusedError extends Error {
  override readonly name = 'VerificationRefusedError';
}
