/**
 * RFC 9457 problem details.
 *
 * One taxonomy, one set of codes, for every caller (`spec/service.md` 1.1).
 * The publishing client and a browser reach the same endpoints, and a
 * taxonomy that varies by caller is a bug generator.
 *
 * `type` is generated from `code` through one table, so the two can never
 * disagree. Clients branch on `code`; the bare status is what every
 * status-only surface reads, which is why `413` beats `422` for an oversized
 * declared object even though `422` fits the letter better.
 */
import type { CoverValidationFailure } from '@relic/format/cover';

/** Every code the app server can emit. */
export type ProblemCode =
  // The twelve cases (`spec/service.md` 1.1)
  | 'relic_not_found'
  | 'relic_expired'
  | 'relic_removed'
  | 'relic_never_published'
  | 'size_over_cap'
  | 'publish_rate_limited'
  | 'mint_rate_limited'
  | 'download_cap_exhausted'
  | 'service_paused'
  | 'invalid_publish_metadata'
  // The grant-time refusals `format.md` obliges (`spec/service.md` 1.6)
  | 'invalid_relic_id'
  | 'relic_id_collision'
  | 'relic_not_yet_published'
  | 'invalid_challenge_nonce'
  // Mint-time validation for the optional historical version selector.
  | 'invalid_relic_version'
  // The one bearer credential the public surface ever checks. Republishing
  // is authorized by possession of the publish token, not by an account,
  // and a wrong or missing token is an authorization failure rather than a
  // malformed request.
  | 'invalid_publish_token'
  // Comments. A comment body is ciphertext the server cannot read, so the
  // only thing it can validate is that the transport encoding is what it
  // claims to be. `format.md` 3.13 puts the caps in `@relic/format`, before
  // encryption, so re-checking a plaintext length here is impossible by
  // construction rather than merely redundant.
  | 'invalid_comment'
  | 'comment_not_found'
  | 'comment_rate_limited'
  // A commenter may delete their own comment and no one else's. The operator
  // path is the abuse surface, not this one.
  | 'comment_forbidden'
  // A patch that carries neither an edit nor a resolution has nothing to
  // apply, and saying so is cheaper than a silent 204 that changed nothing.
  | 'nothing_to_change'
  // Magic-link session. A dead or spent link is not a malformed request.
  | 'invalid_session'
  | 'auth_rate_limited'
  | 'invalid_cover'
  | 'cover_version_stale'
  | 'share_rate_limited'
  | 'invalid_share'
  | 'share_limit_reached'
  | 'share_unavailable'
  | 'invalid_share_proof'
  | 'sign_in_required'
  | 'decision_requires_reader'
  | 'invalid_decision'
  | 'decision_unavailable'
  | 'decision_digest_mismatch'
  | 'decision_rate_limited'
  | 'passkey_required'
  | 'passkey_assertion_required'
  | 'invalid_passkey'
  | 'passkey_verification_failed'
  | 'passkey_rate_limited';

const STATUS: Readonly<Record<ProblemCode, number>> = {
  relic_not_found: 404,
  relic_expired: 410,
  relic_removed: 410,
  relic_never_published: 410,
  size_over_cap: 413,
  publish_rate_limited: 429,
  mint_rate_limited: 429,
  download_cap_exhausted: 410,
  service_paused: 503,
  invalid_publish_metadata: 400,
  invalid_relic_id: 400,
  relic_id_collision: 409,
  relic_not_yet_published: 409,
  invalid_challenge_nonce: 409,
  invalid_relic_version: 400,
  invalid_publish_token: 403,
  invalid_comment: 400,
  comment_not_found: 404,
  comment_rate_limited: 429,
  comment_forbidden: 403,
  nothing_to_change: 400,
  invalid_session: 401,
  auth_rate_limited: 429,
  invalid_cover: 400,
  cover_version_stale: 409,
  share_rate_limited: 429,
  invalid_share: 400,
  share_limit_reached: 409,
  share_unavailable: 409,
  invalid_share_proof: 403,
  sign_in_required: 401,
  decision_requires_reader: 403,
  invalid_decision: 400,
  decision_unavailable: 409,
  decision_digest_mismatch: 409,
  decision_rate_limited: 429,
  passkey_required: 409,
  passkey_assertion_required: 409,
  invalid_passkey: 400,
  passkey_verification_failed: 403,
  passkey_rate_limited: 429,
};

/** `title` SHOULD NOT change from occurrence to occurrence, per RFC 9457. */
const TITLE: Readonly<Record<ProblemCode, string>> = {
  relic_not_found: 'No such relic',
  relic_expired: 'Relic expired',
  relic_removed: 'Relic removed',
  relic_never_published: 'Relic was never published',
  size_over_cap: 'Declared size is over the cap',
  publish_rate_limited: 'Too many publishes',
  mint_rate_limited: 'Too many requests',
  download_cap_exhausted: 'Download cap exhausted',
  service_paused: 'Service paused',
  invalid_publish_metadata: 'Invalid publish metadata',
  invalid_relic_id: 'Invalid relic id',
  relic_id_collision: 'Relic id already exists',
  relic_not_yet_published: 'Relic is still uploading',
  invalid_challenge_nonce: 'Challenge nonce is dead',
  invalid_relic_version: 'Invalid relic version',
  invalid_publish_token: 'Publish token is missing or wrong',
  invalid_comment: 'Invalid comment',
  comment_not_found: 'No such comment',
  comment_rate_limited: 'Too many comments',
  comment_forbidden: 'Not your comment',
  nothing_to_change: 'Nothing to change',
  invalid_session: 'Sign-in link is dead or already used',
  auth_rate_limited: 'Too many sign-in requests',
  invalid_cover: 'Invalid cover image',
  cover_version_stale: 'Cover is for a version that is no longer current',
  share_rate_limited: 'Too many share requests',
  invalid_share: 'Invalid share request',
  share_limit_reached: 'Share list is full',
  share_unavailable: 'Share unavailable',
  invalid_share_proof: 'Invalid share proof',
  sign_in_required: 'Sign-in required',
  decision_requires_reader:
    'A decision needs a signed-in reader, never the publish token',
  invalid_decision: 'Invalid decision request',
  decision_unavailable: 'Decisions unavailable until the publisher republishes',
  decision_digest_mismatch:
    'The stored version is not the version this page shows',
  decision_rate_limited: 'Too many decision requests',
  passkey_required: 'No passkey is registered for this address',
  passkey_assertion_required: 'Adding a passkey needs one you already have',
  invalid_passkey: 'Invalid passkey payload',
  passkey_verification_failed: 'Passkey did not verify',
  passkey_rate_limited: 'Too many passkey requests',
};

export interface ProblemExtensions {
  readonly relic_id?: string;
  readonly id_validation_failure?: 'alphabet' | 'length' | 'reserved';
  readonly retry_after_seconds?: number;
  readonly size_limit_bytes?: number;
  readonly declared_size_bytes?: number;
  readonly size_basis?: 'plaintext' | 'ciphertext';
  readonly download_cap?: number;
  readonly report_url?: string;
  readonly comment_id?: string;
  readonly cover_validation_failure?: CoverValidationFailure;
  readonly current_version?: number;
  readonly share_limit?: number;
  readonly shared_count?: number;
  readonly share_max_per_call?: number;
  readonly version?: number;
  readonly version_digest?: string;
  readonly passkey_check?: string;
}

export interface ProblemOptions extends ProblemExtensions {
  readonly detail?: string;
}

export class ProblemError extends Error {
  override readonly name = 'ProblemError';
  constructor(
    readonly code: ProblemCode,
    readonly options: ProblemOptions = {}
  ) {
    super(options.detail ?? TITLE[code]);
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function statusFor(code: ProblemCode): number {
  return STATUS[code];
}

/**
 * `instance` carries an occurrence id, which is the entire point of the
 * member. The request path fails on its face: every failure on one relic has
 * the identical path, so spending `instance` on it throws away the one member
 * designed to join a support report to a log line.
 */
export function newOccurrenceId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RenderedProblem {
  readonly body: Record<string, unknown>;
  readonly status: number;
  readonly occurrenceId: string;
}

export function renderProblem(
  error: ProblemError,
  serviceOrigin: string,
  occurrenceId: string = newOccurrenceId()
): RenderedProblem {
  const base = serviceOrigin.replace(/\/$/, '');
  const body: Record<string, unknown> = {
    type: `${base}/problems/${error.code}`,
    title: TITLE[error.code],
    status: error.status,
    detail: error.options.detail ?? TITLE[error.code],
    instance: `${base}/problems/occurrences/${occurrenceId}`,
    code: error.code,
  };

  for (const [key, value] of Object.entries(error.options)) {
    if (key === 'detail' || value === undefined) continue;
    body[key] = value;
  }

  return { body, status: error.status, occurrenceId };
}

export function problemResponse(
  error: ProblemError,
  serviceOrigin: string,
  occurrenceId?: string
): Response {
  const rendered = renderProblem(error, serviceOrigin, occurrenceId);
  const headers: Record<string, string> = {
    'content-type': 'application/problem+json',
    // The viewing origin sends this on every response (`format.md` section 0):
    // the relic id appears in the origin's own Referer otherwise.
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
  };

  // `Retry-After` stays authoritative; the extension member mirrors it.
  if (error.options.retry_after_seconds !== undefined) {
    headers['retry-after'] = String(error.options.retry_after_seconds);
  }

  return new Response(JSON.stringify(rendered.body), {
    status: rendered.status,
    headers,
  });
}
