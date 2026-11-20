/**
 * The republish flow: a new version of an existing relic.
 *
 * The whole point of a version is that the share URL keeps working, and the
 * URL's fragment is the key, so a new version MUST be encrypted under the
 * key the first publish used. That key exists in exactly two places: the
 * URL, and this machine's publish state. The service holds only a hash of
 * the publish token and none of the key, so it cannot help. Republishing is
 * therefore possible only from the machine that published, which is the
 * boundary the state file draws and this flow enforces before any network.
 */

import {
  decodeKey,
  deriveRendererClass,
  encryptRelic,
  guessMimetype,
  isValidRelicId,
  type RendererClass,
} from '@relic/format';
import {
  type PublishDeps,
  PublishError,
  postJson,
  putContainer,
  readSource,
  reportComplete,
} from './publish.ts';
import {
  loadPublishState,
  type PublishState,
  savePublishState,
} from './state.ts';

export interface RepublishInput {
  readonly relic_id: string;
  readonly path: string;
  readonly filename?: string | undefined;
  /**
   * Forwarded on the republish body when set and omitted when unset, the
   * grant's own convention. A relic's lifetime is fixed at its first grant,
   * so the service does not read it here today; carrying it keeps the
   * request honest about what the publisher asked for and needs no client
   * change if that ever shifts.
   */
  readonly ttl_days?: number | undefined;
}

export interface RepublishResult {
  readonly relic_id: string;
  /**
   * The version just published, counted from the local state file: the
   * service does not return one, and a publisher only needs to know how
   * many times this relic has changed.
   */
  readonly version: number;
  /** Null when the relic has no lifetime, which is now the default. */
  readonly relic_expires_at: string | null;
  readonly renderer_class: RendererClass;
  readonly filename: string;
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
  /**
   * Deliberately no `url` member. The share URL is unchanged by a new
   * version, and reprinting it would reprint the key for no new benefit;
   * the first publish disclosed it once and that is the disclosure that
   * counts.
   */
}

export async function republish(
  input: RepublishInput,
  deps: PublishDeps
): Promise<RepublishResult> {
  // The gate comes first, before the file is read and before anything can
  // touch the network: without local state there is nothing to encrypt or
  // authorize with, and a round trip would only produce a refusal this
  // machine already knows the reason for.
  if (!isValidRelicId(input.relic_id)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${input.relic_id}" is not a relic id. Republish takes the ` +
        '26-character id the original publish returned.'
    );
  }

  let state: PublishState;
  try {
    const loaded = await loadPublishState(input.relic_id);
    if (loaded === undefined) {
      throw new PublishError(
        'no_local_publish_state',
        `relic ${input.relic_id} was published from another machine and ` +
          'cannot be republished here. The key and the publish token live ' +
          'only on the machine that made the first publish, and neither can ' +
          'be reconstructed from the link or from the service. Publish the ' +
          'content as a new relic instead.'
      );
    }
    state = loaded;
  } catch (error) {
    // State-file damage is not "published elsewhere"; naming it as that
    // would send someone hunting the wrong machine.
    if (error instanceof PublishError) throw error;
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }

  const source = await readSource(input.path, deps.files);
  const filename = input.filename ?? source.basename;

  // Same rule as a first publish: the class comes from bytes in hand, never
  // from a tool input, so the taxonomy stays machine-attested.
  const rendererClass = deriveRendererClass(source.bytes, filename);

  // The stored key, not a fresh one. This is the line that keeps the
  // existing share URL decrypting the new version; a fresh key here would
  // silently cut every recipient off from content they were told this link
  // carries.
  const container = await encryptRelic({
    content: source.bytes,
    filename,
    mimetype: guessMimetype(filename, rendererClass),
    key: decodeKey(state.key),
  });

  // 1. The republish grant: same shape as a first grant, authorized by the
  //    publish token instead of a challenge nonce, aiming the upload at the
  //    next version's object.
  const grant = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/republish`,
    {
      publish_token: state.publish_token,
      renderer_class: rendererClass,
      declared_size_bytes: source.bytes.length,
      declared_ciphertext_bytes: container.length,
      ...(input.ttl_days === undefined ? {} : { ttl_days: input.ttl_days }),
    }
  );

  // 2. Straight to storage, exactly like a first publish.
  await putContainer(
    deps,
    input.relic_id,
    String(grant['upload_url']),
    container
  );

  // 3. Completion, with the same survivability as a first publish.
  await reportComplete(deps, input.relic_id);

  // 4. Count the version locally before reporting it. The service does not
  //    return one, so this file is the only ledger; if the count drifts, the
  //    number reported drifts with it, and nothing else does.
  const version = state.version + 1;
  try {
    await savePublishState(input.relic_id, { ...state, version });
  } catch (error) {
    throw new PublishError(
      'local_state_write_failed',
      'the new version is live at the existing link, but updating the ' +
        'local record failed, so the next republish from this machine may ' +
        `report a stale version number: ${(error as Error).message}`,
      { relic_id: input.relic_id, version }
    );
  }

  return {
    relic_id: input.relic_id,
    version,
    relic_expires_at:
      grant['relic_expires_at'] == null
        ? null
        : String(grant['relic_expires_at']),
    renderer_class: rendererClass,
    filename,
    resolved_path: source.resolvedPath,
    report_url: String(grant['report_url']),
    disclosure_url: String(grant['disclosure_url']),
  };
}
