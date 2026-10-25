/**
 * The decisions read flow (spec §4.7).
 *
 * Reads approval and rejection decisions for a published relic.
 * Authorized by the share proof derived from the encryption key
 * stored in the local publish state file.
 *
 * Decisions are made in the viewer by a person confirmed with a passkey.
 * No tool records decisions; this module only reads them.
 */

import {
  type DecisionList,
  type DecisionRecord,
  decodeKey,
  deriveShareProof,
  encodeKey,
  isDecisionVerdict,
  isVersionDigest,
} from '@relic/format';
import { localState } from './comments.ts';
import {
  type PublishDeps,
  PublishError,
  postJson,
  ServerRefusal,
} from './publish.ts';

export interface ReadDecisionsOptions {
  readonly version?: number | '*' | undefined;
}

function isDecisionRecord(v: unknown): v is DecisionRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const row = v as Record<string, unknown>;
  return (
    typeof row['id'] === 'string' &&
    typeof row['version'] === 'number' &&
    Number.isSafeInteger(row['version']) &&
    row['version'] >= 1 &&
    isDecisionVerdict(row['verdict']) &&
    typeof row['author'] === 'string' &&
    typeof row['created_at'] === 'string' &&
    isVersionDigest(row['version_digest'])
  );
}

/**
 * Read decisions recorded for a relic.
 *
 * Never calls mint. Reads state locally to derive the share proof,
 * then posts to /api/relics/{id}/decisions/list.
 */
export async function readDecisions(
  relicId: string,
  deps: PublishDeps,
  options?: ReadDecisionsOptions
): Promise<DecisionList> {
  const state = await localState(relicId);
  const shareProof = encodeKey(await deriveShareProof(decodeKey(state.key)));

  const body: Record<string, unknown> = {
    share_proof: shareProof,
  };
  if (options?.version !== undefined) {
    body['version'] = options.version;
  }

  let data: unknown;
  try {
    data = await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${relicId}/decisions/list`,
      body
    );
  } catch (error) {
    if (
      error instanceof ServerRefusal &&
      error.code === 'unknown' &&
      error.status === 404
    ) {
      throw new PublishError(
        'app_response_unusable',
        'This Relic service does not support relic_read_decisions yet.',
        { relic_id: relicId }
      );
    }
    throw error;
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid decision list response shape.',
      { relic_id: relicId }
    );
  }

  const obj = data as Record<string, unknown>;
  const resRelicId = obj['relic_id'];
  const currentVersion = obj['current_version'];
  const decisions = obj['decisions'];

  if (
    typeof resRelicId !== 'string' ||
    resRelicId !== relicId ||
    typeof currentVersion !== 'number' ||
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 1 ||
    !Array.isArray(decisions) ||
    !decisions.every(isDecisionRecord)
  ) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid decision list response shape.',
      { relic_id: relicId }
    );
  }

  return {
    relic_id: resRelicId,
    current_version: currentVersion,
    decisions,
  };
}
