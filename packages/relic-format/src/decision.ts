/**
 * Decision records, lists, digests, and verdicts (spec §4.6).
 *
 * Decisions represent an explicit stamp (approval or rejection) made on a
 * specific version of a relic by a verified reader in the viewer, confirmed
 * by a passkey.
 */

/**
 * A decision verdict: either 'approve' or 'reject'.
 */
export type DecisionVerdict = 'approve' | 'reject';

/**
 * Type guard for DecisionVerdict.
 */
export function isDecisionVerdict(value: unknown): value is DecisionVerdict {
  return value === 'approve' || value === 'reject';
}

/**
 * An individual decision record.
 */
export interface DecisionRecord {
  readonly id: string;
  readonly version: number;
  readonly verdict: DecisionVerdict;
  readonly author: string;
  readonly created_at: string;
  readonly version_digest: string;
}

/**
 * The listing of decisions for a relic.
 */
export interface DecisionList {
  readonly relic_id: string;
  readonly current_version: number;
  readonly decisions: readonly DecisionRecord[];
}

const HEX_DIGEST_REGEX = /^[0-9a-f]{64}$/;

/**
 * Check whether a value is a valid 64-character lowercase hex SHA-256 digest string.
 */
export function isVersionDigest(value: unknown): value is string {
  return typeof value === 'string' && HEX_DIGEST_REGEX.test(value);
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Compute the lowercase hex SHA-256 digest of arbitrary bytes using WebCrypto.
 *
 * @param bytes - The input bytes (for example, the container or ciphertext).
 * @returns 64-character lowercase hex SHA-256 string.
 */
export async function versionDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBufferSource(bytes));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Filter and resolve the latest decision record per author for a specific version.
 *
 * Only records matching the specified version are considered.
 * For each author, the latest record is selected (ordered chronologically by
 * `created_at`, then tie-broken by `id`).
 * The returned list of current decisions is ordered by `created_at` then `id`.
 *
 * @param records - Collection of decision records.
 * @param version - The relic version number to select decisions for.
 * @returns Array of the latest DecisionRecord per author on that version,
 * ordered by created_at then id.
 */
export function currentDecisions(
  records: readonly DecisionRecord[],
  version: number
): readonly DecisionRecord[] {
  const versionRecords = records.filter((r) => r.version === version);

  const compareChronological = (
    a: DecisionRecord,
    b: DecisionRecord
  ): number => {
    const timeDiff =
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };

  const byAuthor = new Map<string, DecisionRecord>();
  for (const record of versionRecords) {
    const existing = byAuthor.get(record.author);
    if (!existing || compareChronological(existing, record) < 0) {
      byAuthor.set(record.author, record);
    }
  }

  const result = Array.from(byAuthor.values());
  result.sort(compareChronological);
  return result;
}
