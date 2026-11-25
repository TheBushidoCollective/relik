import type { RelicSettingsJSON } from '@relic/format/private';
import { localRelic } from './comments.ts';
import {
  type PublishDeps,
  PublishError,
  postJson,
  ServerRefusal,
} from './publish.ts';

export interface SettingsInput {
  suggestions?: boolean;
  comments?: boolean;
  decisions?: boolean;
  signing?: boolean;
  notifications?: boolean;
  ttl_days?: number | null;
}

export function parseSettings(value: unknown): RelicSettingsJSON | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v['suggestions'] !== 'boolean' ||
    typeof v['comments'] !== 'boolean' ||
    typeof v['decisions'] !== 'boolean' ||
    typeof v['signing'] !== 'boolean' ||
    typeof v['notifications'] !== 'boolean' ||
    !(v['changed_at'] === null || typeof v['changed_at'] === 'string') ||
    !(
      v['changed_by'] === null ||
      v['changed_by'] === 'publisher' ||
      v['changed_by'] === 'owner'
    ) ||
    !(v['expires_at'] === null || typeof v['expires_at'] === 'string')
  )
    return undefined;
  return {
    suggestions: v['suggestions'],
    comments: v['comments'],
    decisions: v['decisions'],
    signing: v['signing'],
    notifications: v['notifications'],
    changed_at: v['changed_at'],
    changed_by: v['changed_by'],
    expires_at: v['expires_at'],
  };
}

export async function updateSettings(
  relicId: string,
  settings: SettingsInput,
  deps: PublishDeps
): Promise<{
  relic_id: string;
  settings: RelicSettingsJSON;
  relic_expires_at: string | null;
}> {
  const local = await localRelic(relicId);
  let data: unknown;
  try {
    data = await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${relicId}/settings`,
      {
        publish_token: local.state.publish_token,
        settings,
      }
    );
  } catch (error) {
    if (
      error instanceof ServerRefusal &&
      error.code === 'unknown' &&
      error.status === 404
    ) {
      throw new PublishError(
        'app_response_unusable',
        'This Relik service does not support relic_settings yet.',
        { relic_id: relicId }
      );
    }
    throw error;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid settings response.',
      { relic_id: relicId }
    );
  }
  const obj = data as Record<string, unknown>;
  const parsed = parseSettings(obj['settings']);
  const expiry = obj['relic_expires_at'];
  if (
    obj['relic_id'] !== relicId ||
    parsed === undefined ||
    !(expiry === null || typeof expiry === 'string')
  ) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid settings response.',
      { relic_id: relicId }
    );
  }
  return { relic_id: relicId, settings: parsed, relic_expires_at: expiry };
}
