/**
 * Every operating number, in one place, each traceable to `docs/decisions.md`.
 *
 * Nothing here is a magic constant. A value that cannot be accounted for is a
 * value nobody can defend when it turns out to be wrong.
 */

import { ciphertextCapBytes, PLAINTEXT_CAP_BYTES } from '@relic/format';
import { COVER_CAP_BYTES } from '@relic/format/cover';

export interface RelicConfig {
  /** The service origin: the API and the PWA shell. */
  readonly serviceOrigin: string;
  /**
   * The usercontent origin, where untrusted HTML renders. A distinct
   * registrable domain, never a subdomain of the service (`preconditions.md`
   * section 2).
   */
  readonly usercontentOrigin: string;

  /** Published cap, on plaintext, verifiable with `ls`. */
  readonly plaintextCapBytes: number;
  /** The signed grant's ciphertext constraint, derived from the above. */
  readonly ciphertextCapBytes: number;

  readonly coverCapBytes: number;
  /**
   * The largest publisher-supplied lifetime, in days, that a grant will
   * record. Bounds the opt-in so a lifetime stays a commitment inside the
   * storage arithmetic the operator already pays for, not an open-ended one.
   */
  readonly maxTtlDays: number;
  /** Signed download URL validity. */
  readonly urlValiditySeconds: number;
  /** Below this, a clamped mint is refused rather than issuing a dying URL. */
  readonly minViableValiditySeconds: number;
  /** Per-object download cap, priced against the Defender-tenant arithmetic. */
  readonly downloadCap: number;
  /** Repeat mints from one IP inside this window are not distinct opens. */
  readonly mintDedupSeconds: number;
  /** Opens inside this window of publish are dropped from the metric. */
  readonly postPublishWindowSeconds: number;
  /**
   * How long the mint log and tombstones live. Relics with a publisher-set
   * lifetime can outlive this; `assertConfig` says why that is allowed.
   */
  readonly retentionSeconds: number;
  /** How long a publish challenge nonce stays valid. */
  readonly challengeTtlSeconds: number;
  /** Published abuse-response SLA, from arrival. */
  readonly abuseSlaHours: number;

  readonly publishRateLimit: RateLimitConfig;
  readonly mintRateLimit: RateLimitConfig;
  /**
   * Comment writes per IP. Lower than publishing, because a comment costs
   * the writer nothing to produce and the thread is the one surface a
   * link-holder can add to.
   */
  readonly commentRateLimit: RateLimitConfig;
  /** Sign-in requests per IP. Each one can send mail, so it is the tightest. */
  readonly authRateLimit: RateLimitConfig;
  /**
   * Notification sends per recipient per relic. Shared across comments,
   * replies, and change notices.
   * Collapses repeats inside the window and caps outbound mail volume.
   */
  readonly notificationRateLimit: RateLimitConfig;
  /**
   * Share registrations per IP. Lower than publishing, bounds spamming
   * addresses on a relic.
   * decisions.md
   */
  readonly shareRateLimit: RateLimitConfig;
  /**
   * Share registrations per signed-in reader per relic.
   * decisions.md
   */
  readonly readerShareRateLimit: RateLimitConfig;
  /**
   * Maximum addresses accepted in one share request.
   * decisions.md
   */
  readonly shareMaxPerCall: number;
  /**
   * Maximum distinct addresses that can be enrolled on a relic.
   * decisions.md
   */
  readonly shareMaxPerRelic: number;
  /**
   * Stop link clicks per IP.
   * decisions.md
   */
  readonly unsubscribeRateLimit: RateLimitConfig;
  /**
   * Outbound notification emails per window across all relics (covers both
   * change notices on republish and comment notifications).
   * decisions.md
   */
  readonly changeNoticeRateLimit: RateLimitConfig;
  /**
   * The longest comment ciphertext the server will store, in base64url
   * characters. It is a transport bound, not a plaintext one: the real caps
   * are 4096 and 64 bytes, enforced in `@relic/format` before encryption
   * (`format.md` 3.13), and cannot be recomputed from ciphertext. This
   * number only stops an unbounded body from reaching the store.
   */
  readonly commentCiphertextCapChars: number;
  /** How long a sign-in email's link and code stay usable. */
  readonly authLinkTtlSeconds: number;
  /** How long a verified session lasts before the reader signs in again. */
  readonly sessionTtlSeconds: number;
  /** Passkey challenge TTL in seconds. */
  readonly passkeyChallengeTtlSeconds: number;
  /** Decision mutations per IP. */
  readonly decisionRateLimit: RateLimitConfig;
  /** Decision read queries per IP. */
  readonly decisionReadRateLimit: RateLimitConfig;
  /** Passkey operations per IP. */
  readonly passkeyRateLimit: RateLimitConfig;
  /** Passkey sign-in options requests per IP. */
  readonly passkeySignInOptionsRateLimit: RateLimitConfig;
  /** Passkey sign-in options requests per target address. */
  readonly passkeySignInOptionsAddressRateLimit: RateLimitConfig;
  /** Passkey sign-in requests per IP. */
  readonly passkeySignInRateLimit: RateLimitConfig;
  /** Passkey sign-in requests per target address. */
  readonly passkeySignInAddressRateLimit: RateLimitConfig;
  /** Size of the allowCredentials list on email-first passkey sign-in. */
  readonly passkeySignInAllowListSize: number;
  /** Lengths in bytes to pick from for passkey sign-in decoy credential IDs. */
  readonly passkeyDecoyIdLengths: readonly number[];
  /** How long the passkey offer cookie marker lasts in seconds. */
  readonly passkeyOfferMarkerSeconds: number;
  /**
   * How long after a sign-in email (its link or its code) starts a session that
   * session may begin adding the address's first passkey. A session a passkey
   * started never may. Whole minutes, because the disclosure states it in
   * minutes, and at least `passkeyOfferMarkerSeconds`, so no offer card is
   * refused at mount.
   */
  readonly passkeyFreshLinkSeconds: number;
  /** Engaged when egress spend crosses the ceiling. Refuses every mint. */
  readonly killSwitchEngaged: boolean;
  /**
   * Number of trusted proxy hops from the right in X-Forwarded-For.
   *
   * In production on relik.link, an external HTTPS Application Load Balancer
   * fronts Cloud Run, appending `<client-ip>, <lb-ip>` (2 hops from right).
   * Direct Cloud Run without an external load balancer appends `<client-ip>`
   * (1 hop from right). Local development with no proxy sets this to 0.
   */
  readonly trustedProxyHops: number;
  /**
   * Maximum tracked rate limit windows in memory before eviction.
   * Bounds memory under address rotation attacks. At the cap the oldest live
   * windows are evicted, which resets their counters, so the cap must sit far
   * above what an attacker can churn within the per-IP limits: 100,000 windows
   * is roughly 20 MB, a small share of a 256 MiB instance.
   */
  readonly limiterMaxEntries: number;
  /**
   * Number of check operations between routine sweep passes of expired windows.
   */
  readonly limiterSweepInterval: number;
  /**
   * Maximum tracked entries in the separate address and handle rate limiter
   * before eviction. Kept separate from per-IP limiter entries so that
   * churning victim addresses or random user handles cannot evict per-IP
   * buckets. When capacity is reached, the oldest entries are evicted, which
   * resets their counts. This trade-off prioritizes preserving IP-based rate
   * limit state over tracking exhausted address budgets under deliberate
   * memory-exhaustion pressure.
   */
  readonly addressLimiterMaxEntries: number;
  /**
   * Maximum milliseconds to await the passkey-added email notice before
   * timing out. Bounding the await prevents a hung mail provider from turning
   * a successful passkey enrollment into a client request timeout.
   */
  readonly passkeyNoticeTimeoutMs: number;
  /**
   * Rate limit for usernameless passkey sign-in keyed on user handle.
   */
  readonly passkeySignInHandleRateLimit: RateLimitConfig;
  /** Sign-in code submissions per IP. In memory, per instance: the address budget below is the bound that holds across instances. */
  readonly signInCodeRateLimit: RateLimitConfig;
  /** Code attempts per address per window, counted in the store with compare-and-swap; at most a day, because the row lives under the one-day transient prefix. */
  readonly signInCodeAddressAttemptLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  readonly limit: number;
  readonly windowSeconds: number;
}

const DAY = 86_400;

export const DEFAULT_CONFIG: RelicConfig = {
  serviceOrigin: 'https://relic.example',
  usercontentOrigin: 'https://relic-usercontent.example',

  plaintextCapBytes: PLAINTEXT_CAP_BYTES,
  ciphertextCapBytes: ciphertextCapBytes(),

  coverCapBytes: COVER_CAP_BYTES,
  maxTtlDays: 3650,
  urlValiditySeconds: 15 * 60,
  minViableValiditySeconds: 60,
  downloadCap: 200,
  mintDedupSeconds: 10 * 60,
  postPublishWindowSeconds: 120,
  retentionSeconds: 30 * DAY,
  challengeTtlSeconds: 5 * 60,
  abuseSlaHours: 24,

  publishRateLimit: { limit: 60, windowSeconds: 3600 },
  mintRateLimit: { limit: 240, windowSeconds: 3600 },
  commentRateLimit: { limit: 30, windowSeconds: 3600 },
  authRateLimit: { limit: 10, windowSeconds: 3600 },
  notificationRateLimit: { limit: 1, windowSeconds: 10 * 60 },
  shareRateLimit: { limit: 30, windowSeconds: 3600 },
  readerShareRateLimit: { limit: 10, windowSeconds: 3600 },
  shareMaxPerCall: 20,
  shareMaxPerRelic: 50,
  unsubscribeRateLimit: { limit: 60, windowSeconds: 3600 },
  changeNoticeRateLimit: { limit: 300, windowSeconds: 3600 },
  // 4096 plaintext bytes plus a 64-byte name, a 12-byte nonce and a 16-byte
  // tag, JSON framing, then base64url's 4-for-3 expansion, rounded up with
  // room to spare rather than computed to the byte.
  commentCiphertextCapChars: 8192,
  authLinkTtlSeconds: 15 * 60,
  sessionTtlSeconds: 30 * 24 * 3600,
  passkeyChallengeTtlSeconds: 300,
  decisionRateLimit: { limit: 30, windowSeconds: 3600 },
  decisionReadRateLimit: { limit: 600, windowSeconds: 3600 },
  passkeyRateLimit: { limit: 20, windowSeconds: 3600 },
  passkeySignInOptionsRateLimit: { limit: 240, windowSeconds: 3600 },
  passkeySignInOptionsAddressRateLimit: { limit: 60, windowSeconds: 3600 },
  passkeySignInRateLimit: { limit: 30, windowSeconds: 3600 },
  passkeySignInAddressRateLimit: { limit: 30, windowSeconds: 3600 },
  passkeySignInHandleRateLimit: { limit: 30, windowSeconds: 3600 },
  signInCodeRateLimit: { limit: 30, windowSeconds: 3600 },
  signInCodeAddressAttemptLimit: { limit: 10, windowSeconds: 86_400 },
  passkeyNoticeTimeoutMs: 5000,
  addressLimiterMaxEntries: 100_000,
  passkeySignInAllowListSize: 4,
  passkeyDecoyIdLengths: [16, 20, 32, 64],
  passkeyOfferMarkerSeconds: 600,
  passkeyFreshLinkSeconds: 900,
  killSwitchEngaged: false,
  trustedProxyHops: 2,
  limiterMaxEntries: 100_000,
  limiterSweepInterval: 100,
};

/**
 * GCS caps signed URL lifetime at 604800 seconds. Asserted rather than
 * assumed, so a later TTL change cannot silently produce an unsignable URL.
 */
export const GCS_MAX_SIGNED_URL_SECONDS = 604_800;

export function assertConfig(config: RelicConfig): void {
  if (config.urlValiditySeconds > GCS_MAX_SIGNED_URL_SECONDS) {
    throw new Error(
      `url validity ${config.urlValiditySeconds}s exceeds the GCS ceiling`
    );
  }
  if (config.minViableValiditySeconds > config.urlValiditySeconds) {
    throw new Error('minimum viable validity exceeds the validity window');
  }
  if (
    !Number.isInteger(config.trustedProxyHops) ||
    config.trustedProxyHops < 0
  ) {
    throw new Error('trustedProxyHops must be a non-negative integer');
  }
  // `service.md` 7.5 wanted the mint log to outlive every relic, so the
  // metric's publishing-IP filter could still fire on an old relic's self
  // opens. That was expressible only while every relic's life was a single
  // number fixed here. A relic may now outlive any retention window, or
  // never die at all, so no ordering of these two values can promise it, and
  // the check is gone rather than quietly comparing against the wrong life.
  if (config.mintDedupSeconds <= config.postPublishWindowSeconds) {
    throw new Error(
      'mint dedup interval must exceed the post-publish window, or the two ' +
        'rules interact'
    );
  }
  if (
    new URL(config.serviceOrigin).host ===
    new URL(config.usercontentOrigin).host
  ) {
    throw new Error(
      'the usercontent origin must be a distinct host from the service origin'
    );
  }
  if (config.shareMaxPerCall > config.shareMaxPerRelic) {
    throw new Error('shareMaxPerCall cannot exceed shareMaxPerRelic');
  }
  if (
    !Number.isInteger(config.passkeySignInAllowListSize) ||
    config.passkeySignInAllowListSize < 1
  ) {
    throw new Error('passkeySignInAllowListSize must be an integer >= 1');
  }
  if (
    !Array.isArray(config.passkeyDecoyIdLengths) ||
    config.passkeyDecoyIdLengths.length === 0 ||
    config.passkeyDecoyIdLengths.some(
      (len) => !Number.isInteger(len) || len < 16 || len > 1023
    )
  ) {
    throw new Error(
      'passkeyDecoyIdLengths must be non-empty with integers between 16 and 1023'
    );
  }
  if (
    !Number.isInteger(config.passkeyOfferMarkerSeconds) ||
    config.passkeyOfferMarkerSeconds <= 0
  ) {
    throw new Error('passkeyOfferMarkerSeconds must be an integer > 0');
  }
  if (
    !Number.isInteger(config.passkeyFreshLinkSeconds) ||
    config.passkeyFreshLinkSeconds % 60 !== 0 ||
    config.passkeyFreshLinkSeconds < config.passkeyOfferMarkerSeconds
  ) {
    throw new Error(
      'passkeyFreshLinkSeconds must be a whole number of minutes, at least passkeyOfferMarkerSeconds'
    );
  }
  if (
    !Number.isInteger(config.passkeySignInOptionsAddressRateLimit?.limit) ||
    config.passkeySignInOptionsAddressRateLimit.limit < 1 ||
    !Number.isInteger(
      config.passkeySignInOptionsAddressRateLimit?.windowSeconds
    ) ||
    config.passkeySignInOptionsAddressRateLimit.windowSeconds < 1
  ) {
    throw new Error(
      'passkeySignInOptionsAddressRateLimit must have integer limit >= 1 and windowSeconds >= 1'
    );
  }
  if (
    !Number.isInteger(config.passkeySignInAddressRateLimit?.limit) ||
    config.passkeySignInAddressRateLimit.limit < 1 ||
    !Number.isInteger(config.passkeySignInAddressRateLimit?.windowSeconds) ||
    config.passkeySignInAddressRateLimit.windowSeconds < 1
  ) {
    throw new Error(
      'passkeySignInAddressRateLimit must have integer limit >= 1 and windowSeconds >= 1'
    );
  }
  if (
    !Number.isInteger(config.signInCodeRateLimit?.limit) ||
    config.signInCodeRateLimit.limit < 1 ||
    !Number.isInteger(config.signInCodeRateLimit?.windowSeconds) ||
    config.signInCodeRateLimit.windowSeconds < 1
  ) {
    throw new Error(
      'signInCodeRateLimit must have integer limit >= 1 and windowSeconds >= 1'
    );
  }
  if (
    !Number.isInteger(config.signInCodeAddressAttemptLimit?.limit) ||
    config.signInCodeAddressAttemptLimit.limit < 1 ||
    !Number.isInteger(config.signInCodeAddressAttemptLimit?.windowSeconds) ||
    config.signInCodeAddressAttemptLimit.windowSeconds < 1
  ) {
    throw new Error(
      'signInCodeAddressAttemptLimit must have integer limit >= 1 and windowSeconds >= 1'
    );
  }
  if (config.signInCodeAddressAttemptLimit.windowSeconds > 86_400) {
    throw new Error(
      'signInCodeAddressAttemptLimit.windowSeconds must be at most 86400: the budget row lives under the one-day transient lifecycle prefix, which would cut a longer window short'
    );
  }
  if (
    !Number.isInteger(config.limiterMaxEntries) ||
    config.limiterMaxEntries <= 0
  ) {
    throw new Error('limiterMaxEntries must be a positive integer');
  }
  if (
    !Number.isInteger(config.limiterSweepInterval) ||
    config.limiterSweepInterval <= 0
  ) {
    throw new Error('limiterSweepInterval must be a positive integer');
  }
  if (
    !Number.isInteger(config.passkeySignInHandleRateLimit?.limit) ||
    config.passkeySignInHandleRateLimit.limit < 1 ||
    !Number.isInteger(config.passkeySignInHandleRateLimit?.windowSeconds) ||
    config.passkeySignInHandleRateLimit.windowSeconds < 1
  ) {
    throw new Error(
      'passkeySignInHandleRateLimit must have integer limit >= 1 and windowSeconds >= 1'
    );
  }
  if (
    !Number.isInteger(config.addressLimiterMaxEntries) ||
    config.addressLimiterMaxEntries <= 0
  ) {
    throw new Error('addressLimiterMaxEntries must be a positive integer');
  }
  if (
    !Number.isInteger(config.passkeyNoticeTimeoutMs) ||
    config.passkeyNoticeTimeoutMs <= 0
  ) {
    throw new Error('passkeyNoticeTimeoutMs must be a positive integer');
  }
}
