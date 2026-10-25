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
  deriveShareProof,
  encryptRelic,
  isValidRelicId,
  normalizeTitle,
  type RendererClass,
  shareVerifierFor,
  versionDigest,
} from '@relic/format';
import type { CoverOutcome, CoverReport } from '@relic/format/cover';
import { keyToMnemonic } from '@relic/format/mnemonic';
import {
  type CommentResult,
  formatUnaddressedRefusal,
  postComment,
  readComments,
} from './comments.ts';
import { uploadCover } from './cover/upload.ts';
import {
  contentDigest,
  guessMimetype,
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

export interface RepublishAddressEntry {
  readonly comment_id: string;
  readonly note: string;
}

export interface RepublishInput {
  readonly relic_id: string;
  readonly path: string;
  readonly filename?: string | undefined;
  /**
   * Optional plaintext title for the new version. Defaults to the new
   * version's filename. Pass "" to clear the relic's title.
   */
  readonly title?: string | undefined;
  /**
   * Forwarded on the republish body when set and omitted when unset, the
   * grant's own convention. A relic's lifetime is fixed at its first grant,
   * so the service does not read it here today; carrying it keeps the
   * request honest about what the publisher asked for and needs no client
   * change if that ever shifts.
   */
  readonly ttl_days?: number | undefined;
  /**
   * Optional acknowledgement notes for open comments being addressed by this
   * update. Each entry posts an acknowledgement comment stamped with the new
   * version after it lands. Every open comment on the relic must be addressed
   * either by an entry here or by a prior reply.
   */
  readonly addresses?: readonly RepublishAddressEntry[] | undefined;
  /**
   * Optional cover image flag. Defaults to true. Pass false to decline
   * rendering and uploading a cover image for link previews.
   */
  readonly cover?: boolean | undefined;
  /**
   * Optional change notice flag. Defaults to true. Pass false to decline
   * emailing a change notice for this version.
   */
  readonly notify?: boolean | undefined;
}

export interface RepublishResult {
  readonly relic_id: string;
  /**
   * The version just published, counted from the local state file: the
   * service does not return one, and a publisher only needs to know how
   * many times this relic has changed.
   */
  readonly version: number;
  /** Lowercase hex SHA-256 digest of the encrypted ciphertext container. */
  readonly version_digest: string;
  /** Null when the relic has no lifetime, which is now the default. */
  readonly relic_expires_at: string | null;
  readonly renderer_class: RendererClass;
  readonly filename: string;
  /**
   * Stored by the service in the clear for link previews. Null when cleared
   * or published without a title.
   */
  readonly title: string | null;
  readonly resolved_path: string;
  readonly report_url: string;
  readonly disclosure_url: string;
  readonly key_phrase: string;
  /**
   * Acknowledgement comments posted for comments addressed by this update.
   */
  readonly acknowledgements?: readonly CommentResult[] | undefined;
  /**
   * Deliberately no `url` member. The share URL is unchanged by a new
   * version, and reprinting it would reprint the key for no new benefit;
   * the first publish disclosed it once and that is the disclosure that
   * counts.
   */
  readonly cover: CoverReport;
  readonly notify: boolean;
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
  // Validate addresses entries up front before any network or file reads.
  const addressesEntries = input.addresses;
  if (addressesEntries !== undefined) {
    if (!Array.isArray(addressesEntries)) {
      throw new PublishError(
        'invalid_acknowledgements',
        'addresses must be an array of { comment_id, note } entries.'
      );
    }
    const seen = new Set<string>();
    for (const entry of addressesEntries) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof entry.comment_id !== 'string' ||
        entry.comment_id.trim().length === 0
      ) {
        throw new PublishError(
          'invalid_acknowledgement_comment_id',
          'acknowledgement comment_id must be a non-empty string.'
        );
      }
      if (typeof entry.note !== 'string' || entry.note.trim().length === 0) {
        throw new PublishError(
          'empty_acknowledgement_note',
          `acknowledgement note for comment ${entry.comment_id} cannot be empty or whitespace-only: it must say what was done to address the comment.`
        );
      }
      if (seen.has(entry.comment_id)) {
        throw new PublishError(
          'duplicate_acknowledgement',
          `duplicate acknowledgement entry for comment ${entry.comment_id}.`
        );
      }
      seen.add(entry.comment_id);
    }
  }

  // The duplicate gate, still local: read the file, name what its plaintext
  // is, and refuse when that is already what the link serves.
  //
  // A version is a thing recipients are told to look at again. One that
  // changes nothing cannot be told apart from a real one until it has been
  // read, and the reader has to hold both in their head to discover that
  // nothing moved, so an identical version spends their attention and
  // returns nothing. It is refused here rather than uploaded, because the
  // service has no way to know: it holds ciphertext, and a fresh salt makes
  // two encryptions of one file differ byte for byte.
  //
  // Before the comment read, which is the first thing here that touches the
  // network. An identical file is also the likeliest reason comments are
  // still open, so naming the duplicate first names the cause.
  const source = await readSource(input.path, deps.files);
  const filename = input.filename ?? source.basename;
  const normalizedTitle = normalizeTitle(input.title ?? filename);
  // Same rule as a first publish: the class comes from bytes in hand, never
  // from a tool input, so the taxonomy stays machine-attested.
  const rendererClass = deriveRendererClass(source.bytes, filename);
  const digest = await contentDigest({
    content: source.bytes,
    filename,
    title: normalizedTitle,
  });
  const same =
    state.content_sha256 !== undefined && state.content_sha256 === digest;
  const requested = input.cover !== false;
  const previous = state.cover_uploaded === true;

  let renderedOutcome: CoverOutcome | undefined;

  if (same) {
    if (!requested) {
      if (!previous) {
        throw new PublishError(
          'duplicate_version',
          `version ${state.version} of relic ${input.relic_id} already holds ` +
            'exactly this content, under this name and title, so a new version ' +
            'would show a reader nothing they are not already reading at the ' +
            'same link. Change the file, or leave the relic where it is.',
          {
            relic_id: input.relic_id,
            version: state.version,
            content_sha256: digest,
          }
        );
      }
      // same && !requested && previous -> proceed (removes the cover)
    } else {
      if (previous) {
        throw new PublishError(
          'duplicate_version',
          `version ${state.version} of relic ${input.relic_id} already holds ` +
            'exactly this content, under this name and title, so a new version ' +
            'would show a reader nothing they are not already reading at the ' +
            'same link. Change the file, or leave the relic where it is.',
          {
            relic_id: input.relic_id,
            version: state.version,
            content_sha256: digest,
          }
        );
      }
      // same && requested && !previous -> render first
      const outcome = await deps.renderCover({
        bytes: source.bytes,
        filename,
        mimetype: guessMimetype(filename, rendererClass),
        rendererClass,
      });
      if (outcome.status === 'rendered') {
        renderedOutcome = outcome;
        // proceed (adds the cover)
      } else {
        throw new PublishError(
          'duplicate_version',
          `version ${state.version} of relic ${input.relic_id} already holds ` +
            'exactly this content, under this name and title, so a new version ' +
            'would show a reader nothing they are not already reading at the ' +
            `same link, and no cover could be rendered: ${outcome.detail}. ` +
            'Change the file, or leave the relic where it is.',
          {
            relic_id: input.relic_id,
            version: state.version,
            content_sha256: digest,
            cover_skip_reason: outcome.reason,
            cover_skip_detail: outcome.detail,
          }
        );
      }
    }
  }

  let coverOutcome: CoverOutcome;
  if (!requested) {
    coverOutcome = {
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'declined by publisher',
    };
  } else if (renderedOutcome !== undefined) {
    coverOutcome = renderedOutcome;
  } else {
    try {
      coverOutcome = await deps.renderCover({
        bytes: source.bytes,
        filename,
        mimetype: guessMimetype(filename, rendererClass),
        rendererClass,
      });
    } catch (error) {
      coverOutcome = {
        status: 'skipped',
        reason: 'render_failed',
        detail: (error as Error).message,
      };
    }
  }

  // The comment gate: before publishing a new version, read the relic's
  // comments, decrypt them locally, and verify every comment has been
  // addressed. Unaddressed or unreadable comments refuse the republish.
  // The read is explicitly scoped to every version, never the newer
  // current-version default: a remark left unanswered on version 1 still
  // blocks, and inheriting the default would silently weaken this
  // guarantee the moment the relic had any history at all. A resolved
  // comment counts as handled and no longer blocks; resolving is one of
  // the two ways to clear the gate, the other being an acknowledgement.
  const commentResult = await readComments(input.relic_id, deps, {
    version: '*',
  });
  const unreadableComments = commentResult.comments.filter((c) => !c.readable);
  const openComments = commentResult.comments.filter(
    (c) =>
      c.readable &&
      !c.addressed &&
      c.addresses === null &&
      c.resolution === null
  );

  if (addressesEntries && addressesEntries.length > 0) {
    for (const entry of addressesEntries) {
      const match = commentResult.comments.find(
        (c) => c.comment_id === entry.comment_id
      );
      if (!match) {
        throw new PublishError(
          'unknown_comment_id',
          `comment ${entry.comment_id} does not exist on relic ${input.relic_id}. The comment ids can only come from having read the relic's comments.`
        );
      }
      if (!match.readable) {
        throw new PublishError(
          'unreadable_comment_cannot_be_addressed',
          `comment ${entry.comment_id} cannot be addressed because it could not be decrypted.`
        );
      }
    }
  }

  const addressesSet = new Set(
    addressesEntries?.map((e) => e.comment_id) ?? []
  );
  const remainingOpen = openComments.filter(
    (c) => !addressesSet.has(c.comment_id)
  );

  if (unreadableComments.length > 0 || remainingOpen.length > 0) {
    throw new PublishError(
      'unaddressed_comments',
      formatUnaddressedRefusal(
        input.relic_id,
        remainingOpen,
        unreadableComments
      ),
      {
        relic_id: input.relic_id,
        open_count: remainingOpen.length,
        unreadable_count: unreadableComments.length,
        open_comments: remainingOpen.map((c) => ({
          comment_id: c.comment_id,
          author: c.author,
          created_at: c.created_at,
          body: c.body,
        })),
        unreadable_comments: unreadableComments.map((c) => ({
          comment_id: c.comment_id,
          author: c.author,
          created_at: c.created_at,
          unreadable_reason: c.unreadable_reason,
        })),
      }
    );
  }

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
  const localVersionDigest = await versionDigest(container);

  // 1. The republish grant: same shape as a first grant, authorized by the
  //    publish token instead of a challenge nonce, aiming the upload at the
  //    next version's object.
  const shareVerifier = await shareVerifierFor(
    await deriveShareProof(decodeKey(state.key))
  );
  const grant = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/republish`,
    {
      publish_token: state.publish_token,
      renderer_class: rendererClass,
      declared_size_bytes: source.bytes.length,
      declared_ciphertext_bytes: container.length,
      title: normalizedTitle,
      ...(input.ttl_days === undefined ? {} : { ttl_days: input.ttl_days }),
      ...(input.notify === false ? { notify: false } : {}),
      share_verifier: shareVerifier,
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
  const complete = await reportComplete(deps, input.relic_id);
  const serverDigest = complete?.['version_digest'];

  // 4. The reported republish version is complete.version ?? grant.version ?? state.version + 1.
  const version =
    typeof complete?.['version'] === 'number'
      ? (complete['version'] as number)
      : typeof grant['version'] === 'number'
        ? (grant['version'] as number)
        : state.version + 1;

  if (typeof serverDigest === 'string' && serverDigest !== localVersionDigest) {
    throw new PublishError(
      'version_digest_mismatch',
      `the version digest computed by the server (${serverDigest}) does not match the local container digest (${localVersionDigest})`,
      {
        relic_id: input.relic_id,
        version,
        local: localVersionDigest,
        server: serverDigest,
      }
    );
  }
  const resolvedVersionDigest =
    typeof serverDigest === 'string' ? serverDigest : localVersionDigest;
  try {
    // The filename tracks the newest version, because that is the one the
    // link now serves and the one an inventory should name. `published_at`
    // is deliberately untouched: it answers when this relic was made, and a
    // republish overwriting it would erase the only date this machine has.
    await savePublishState(input.relic_id, {
      ...state,
      version,
      filename,
      content_sha256: digest,
      updated_at: new Date().toISOString(),
      cover_uploaded: false,
    });
  } catch (error) {
    throw new PublishError(
      'local_state_write_failed',
      'the new version is live at the existing link, but updating the ' +
        'local record failed, so the next republish from this machine may ' +
        `report a stale version number: ${(error as Error).message}`,
      { relic_id: input.relic_id, version }
    );
  }

  let coverReport: CoverReport;
  if (!requested) {
    coverReport = { status: 'declined' };
  } else if (coverOutcome.status === 'skipped') {
    coverReport = {
      status: 'skipped',
      reason: coverOutcome.reason,
      detail: coverOutcome.detail,
    };
  } else {
    coverReport = await uploadCover(deps, {
      relicId: input.relic_id,
      publishToken: state.publish_token,
      version,
      kind: coverOutcome.kind,
      type: coverOutcome.type,
      bytes: coverOutcome.bytes,
    });
    if (coverReport.status === 'uploaded') {
      try {
        await savePublishState(input.relic_id, {
          ...state,
          version,
          filename,
          content_sha256: digest,
          updated_at: new Date().toISOString(),
          cover_uploaded: true,
        });
      } catch {
        // If the second write fails the publish still succeeds
      }
    }
  }

  // After the new version lands, post an acknowledgement comment for each
  // addressed entry, so the acknowledgement is stamped with the new version.
  const acknowledgements: CommentResult[] = [];
  if (addressesEntries && addressesEntries.length > 0) {
    for (const entry of addressesEntries) {
      const ack = await postComment(
        {
          relic_id: input.relic_id,
          body: entry.note,
          addresses: entry.comment_id,
        },
        deps
      );
      acknowledgements.push(ack);
    }
  }

  return {
    relic_id: input.relic_id,
    version,
    version_digest: resolvedVersionDigest,
    relic_expires_at:
      grant['relic_expires_at'] == null
        ? null
        : String(grant['relic_expires_at']),
    renderer_class: rendererClass,
    filename,
    title: normalizedTitle.length === 0 ? null : normalizedTitle,
    resolved_path: source.resolvedPath,
    report_url: String(grant['report_url']),
    disclosure_url: String(grant['disclosure_url']),
    key_phrase: keyToMnemonic(decodeKey(state.key)).join(' '),
    ...(acknowledgements.length > 0 ? { acknowledgements } : {}),
    cover: coverReport,
    notify: input.notify !== false,
  };
}
