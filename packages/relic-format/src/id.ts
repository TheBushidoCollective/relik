/**
 * The relic ID: Crockford base32, lowercase canonical, case-insensitive on
 * lookup (`spec/format.md` 1.1).
 *
 * 26 characters carrying 128 bits of entropy, above the 122-bit floor
 * (`spec/format.md` 1.2, `docs/decisions.md`). The ID is opaque and encodes
 * nothing: no timestamp, no shard, no class.
 */

/** Crockford's alphabet. `i`, `l`, `o`, and `u` are absent by design. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Bytes of entropy drawn per ID. */
export const ID_ENTROPY_BYTES = 16;

/** Every ID is exactly this many characters. Length is the primary guard. */
export const ID_LENGTH = 26;

/**
 * Root-level service paths (`spec/format.md` 1.5). Append-only.
 *
 * Length already excludes every one of these, since the longest is
 * `manifest.webmanifest` at 20 against an ID length of 26. The table is the
 * backstop, because the alphabet is a weaker guard than it looks: `assets`
 * is directly spellable, and `policy`, `api`, and `health` fold onto valid
 * Crockford strings under the normalization lookup applies.
 *
 * Appending a word of exactly ID_LENGTH characters requires comparing its
 * normalized form against every issued ID before it ships.
 */
export const RESERVED_SEGMENTS: readonly string[] = [
  'abuse',
  'policy',
  'robots.txt',
  'favicon.ico',
  'sitemap.xml',
  'manifest.webmanifest',
  'sw.js',
  'assets',
  'api',
  'health',
  '.well-known',
  'sandbox.html',
  // Folds to `1nsta11` under lookup normalization, so the table is doing real
  // work here even though length already excludes it.
  'install',
  // Folds to `dashb0ard` under lookup normalization. Adding both `dashboard`
  // and `dashb0ard` ensures the path cannot collide with relic IDs and that
  // routers matching raw URL segments reserve both spellings.
  'dashboard',
  'dashb0ard',
];

const RESERVED_NORMALIZED = new Set(
  RESERVED_SEGMENTS.map((word) => foldAliases(word.toLowerCase()))
);

/** Which of the three validation checks a candidate ID failed. */
export type IdValidationFailure = 'alphabet' | 'length' | 'reserved';

export class InvalidRelicIdError extends Error {
  override readonly name = 'InvalidRelicIdError';
  constructor(
    readonly failure: IdValidationFailure,
    message: string
  ) {
    super(message);
  }
}

/**
 * Apply Crockford's decode aliases: `i` and `l` to `1`, `o` to `0`.
 *
 * Crockford also permits hyphens as readability separators and says they are
 * ignored during decoding. Relic declines that half (`spec/format.md` 1.1):
 * honoring it would give every ID unbounded valid spellings and break the
 * fixed-length guard. A hyphen is rejected rather than stripped.
 */
function foldAliases(lowered: string): string {
  let out = '';
  for (const ch of lowered) {
    if (ch === 'i' || ch === 'l') out += '1';
    else if (ch === 'o') out += '0';
    else out += ch;
  }
  return out;
}

/**
 * Normalize a candidate ID for comparison: case-fold, then fold aliases.
 *
 * Lookup deliberately accepts a wider language than the encoder emits, which
 * is exactly why RESERVED_SEGMENTS is checked against normalized forms.
 */
export function normalizeRelicId(candidate: string): string {
  return foldAliases(candidate.toLowerCase());
}

/**
 * Validate and normalize, or throw naming which check failed.
 *
 * The three checks are the ones `spec/format.md` 1.3 obliges the server to
 * make at mint, and the failure name is what populates the problem
 * document's `id_validation_failure` member.
 */
export function parseRelicId(candidate: string): string {
  if (candidate.length !== ID_LENGTH) {
    throw new InvalidRelicIdError(
      'length',
      `relic id must be ${ID_LENGTH} characters, got ${candidate.length}`
    );
  }

  const normalized = normalizeRelicId(candidate);

  for (const ch of normalized) {
    if (!ALPHABET.includes(ch)) {
      throw new InvalidRelicIdError(
        'alphabet',
        `relic id contains ${JSON.stringify(ch)}, outside Crockford base32`
      );
    }
  }

  if (RESERVED_NORMALIZED.has(normalized)) {
    throw new InvalidRelicIdError(
      'reserved',
      `relic id normalizes onto the reserved segment ${normalized}`
    );
  }

  return normalized;
}

/** True when `candidate` passes all three checks. */
export function isValidRelicId(candidate: string): boolean {
  try {
    parseRelicId(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode bytes as Crockford base32 in the relic ID alphabet.
 *
 * The bit stream is read most-significant-first. Each character carries five
 * bits, and a final partial group is padded with zero bits on the right. So 16
 * bytes give 26 characters and 20 bytes give exactly 32.
 */
export function encodeCrockford(bytes: Uint8Array): string {
  let out = '';
  let accumulator = 0;
  let bitsHeld = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitsHeld += 8;
    while (bitsHeld >= 5) {
      bitsHeld -= 5;
      const index = (accumulator >>> bitsHeld) & 0x1f;
      out += ALPHABET[index];
    }
  }

  if (bitsHeld > 0) {
    const index = (accumulator << (5 - bitsHeld)) & 0x1f;
    out += ALPHABET[index];
  }

  return out;
}

/**
 * Encode 16 bytes as 26 Crockford characters.
 *
 * 16 bytes is 128 bits and 26 characters hold 130, so the final character
 * carries the last 3 bits padded with 2 zeros on the right.
 */
export function encodeRelicId(entropy: Uint8Array): string {
  if (entropy.length !== ID_ENTROPY_BYTES) {
    throw new InvalidRelicIdError(
      'length',
      `relic id entropy must be ${ID_ENTROPY_BYTES} bytes`
    );
  }
  return encodeCrockford(entropy);
}

/**
 * Draw a fresh relic ID from the platform CSPRNG.
 *
 * The publishing client generates the ID before it requests a grant
 * (`spec/format.md` 1.3), so an upload that succeeds while its confirmation
 * is lost still yields a link the publisher can share.
 *
 * The ID and the key are drawn independently and neither derives from the
 * other: deriving the key from the ID would put the key in the operator's
 * hands, since the operator has every ID.
 */
export function generateRelicId(): string {
  const entropy = new Uint8Array(ID_ENTROPY_BYTES);
  crypto.getRandomValues(entropy);
  return encodeRelicId(entropy);
}
