/**
 * The share flow: register email addresses for change notices and prepare
 * a ready-to-send share email.
 *
 * Runs on the publisher's machine. The key never reaches the service:
 * relic_share sends the service email addresses and the publish token,
 * and composes the share email carrying the full link locally for the
 * sharer to send from their own mailbox.
 */

import {
  composeShareEmail,
  decodeKey,
  isValidRelicId,
  relicUrl,
  type ShareEmail,
  type ShareSender,
  shareMailtoUrl,
} from '@relic/format';
import {
  type PublishDeps,
  PublishError,
  postJson,
  refusePrivateRelic,
  ServerRefusal,
} from './publish.ts';
import { loadPublishState, type PublishState } from './state.ts';

export interface ShareInput {
  readonly relic_id: string;
  readonly emails: readonly string[];
}

export interface ShareResult {
  readonly relic_id: string;
  readonly registered: readonly string[];
  readonly added: number;
  readonly shared_count: number;
  readonly share_limit: number;
  readonly email: ShareEmail;
  readonly mailto_url: string;
}

export { composeShareEmail, shareMailtoUrl, type ShareEmail, type ShareSender };

export async function shareRelic(
  input: ShareInput,
  deps: PublishDeps
): Promise<ShareResult> {
  // 1. Refuse a non-id, including a share URL, with no_local_publish_state,
  //    using the message pattern at comments.ts:892-899.
  if (!isValidRelicId(input.relic_id)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${input.relic_id}" is not a relic id. These tools take the 26-character id ` +
        'the original publish returned, never the share URL: the URL carries ' +
        'the key in its fragment, and passing it would put the key in this ' +
        'transcript for nothing.'
    );
  }

  // 2. Load local state. If the relic is missing, refuse with no_local_publish_state:
  //    "can only be shared from the machine that published it".
  //    If the state file cannot be read, refuse with local_state_unreadable.
  let state: PublishState;
  await refusePrivateRelic(input.relic_id, 'relic_share');

  try {
    const loaded = await loadPublishState(input.relic_id);
    if (loaded === undefined) {
      throw new PublishError(
        'no_local_publish_state',
        `relic ${input.relic_id} was published from another machine and ` +
          'can only be shared from the machine that published it.'
      );
    }
    state = loaded;
  } catch (error) {
    if (error instanceof PublishError) throw error;
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }

  // 3. If the address list is not 1 to 20 entries, refuse with local_share_emails_invalid.
  if (
    !Array.isArray(input.emails) ||
    input.emails.length < 1 ||
    input.emails.length > 20
  ) {
    throw new PublishError(
      'local_share_emails_invalid',
      'The address list must have between 1 and 20 entries.'
    );
  }

  // 4. postJson(deps, `${deps.serviceOrigin}/api/relics/${id}/share`, {publish_token, emails}).
  let data: unknown;
  try {
    data = await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${input.relic_id}/share`,
      {
        publish_token: state.publish_token,
        emails: input.emails,
      }
    );
  } catch (error) {
    // 5. If the service answers a plain 404 (a ServerRefusal with code unknown and status 404),
    //    throw app_response_unusable: "This Relic service does not support relic_share yet."
    if (
      error instanceof ServerRefusal &&
      error.code === 'unknown' &&
      error.status === 404
    ) {
      throw new PublishError(
        'app_response_unusable',
        'This Relic service does not support relic_share yet.',
        { relic_id: input.relic_id }
      );
    }
    throw error;
  }

  // 6. Validate the response shape. On a bad shape, throw app_response_unusable.
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid share response shape.',
      { relic_id: input.relic_id }
    );
  }
  const obj = data as Record<string, unknown>;
  const relicId = obj['relic_id'];
  const emails = obj['emails'];
  const added = obj['added'];
  const sharedCount = obj['shared_count'];
  const shareLimit = obj['share_limit'];
  const rawTitle = obj['title'];

  if (
    typeof relicId !== 'string' ||
    !Array.isArray(emails) ||
    !emails.every((e) => typeof e === 'string') ||
    typeof added !== 'number' ||
    !Number.isSafeInteger(added) ||
    typeof sharedCount !== 'number' ||
    !Number.isSafeInteger(sharedCount) ||
    typeof shareLimit !== 'number' ||
    !Number.isSafeInteger(shareLimit) ||
    (rawTitle !== null && typeof rawTitle !== 'string')
  ) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid share response shape.',
      { relic_id: input.relic_id }
    );
  }

  // 7. Build the URL with relicUrl(deps.relicOrigin, id, decodeKey(state.key)).
  //    Set to to the response's emails, and use the response's title.
  const title = typeof rawTitle === 'string' ? rawTitle : null;
  const key = decodeKey(state.key);
  const url = relicUrl(deps.relicOrigin, input.relic_id, key);
  const email = composeShareEmail({
    url,
    title,
    to: emails as readonly string[],
    sender: 'publisher',
  });
  const mailto_url = shareMailtoUrl(email);

  return {
    relic_id: input.relic_id,
    registered: emails as readonly string[],
    added,
    shared_count: sharedCount,
    share_limit: shareLimit,
    email,
    mailto_url,
  };
}
