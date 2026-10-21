/**
 * Comments, from an agent's seat.
 *
 * The feature exists so a person can leave a comment and an agent can read it
 * back and act on it. The agent's half has two constraints the person's does
 * not, and both are structural rather than stylistic.
 *
 * **An agent cannot receive email.** `docs/frame.md` makes a verified email
 * address the commenter identity, and verification runs through a magic link,
 * which needs a mailbox. There is no mailbox here. The publish token already
 * proves this machine published the relic, so it stands as the agent's
 * identity and the service attributes the comment to `publisher`. That is
 * attribution, never authorization: the same non-goal entry says verified
 * email buys attribution and not entitlement, and a bearer token buys less.
 *
 * **The share URL is never an argument.** The fragment is the key, so a tool
 * accepting the URL would put the key in the transcript on every read, which
 * is the one disclosure `spec/publish.md` section 5 spends deliberately and
 * exactly once, at publish. These tools take the relic id and read the key
 * from local publish state instead, which draws the same machine boundary
 * republish already draws: only the machine that published can comment on a
 * relic or read its comments here.
 *
 * The comment key is derived from the fragment's key bytes under a distinct
 * HKDF `info`, so it is independent of the container key by construction, and
 * the fragment does not change. `spec/format.md` 2.1 fixes the fragment at
 * the marker and the key, and a third field would cost a version bump.
 */

import {
  type AnchorRect,
  COMMENT_ADDRESSES_LIMIT_BYTES,
  COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
  COMMENT_ANCHOR_MAX_PAGE,
  COMMENT_ANCHOR_MAX_SECONDS,
  COMMENT_ANCHOR_OTIO_LIMIT_BYTES,
  COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
  COMMENT_BODY_LIMIT_BYTES,
  COMMENT_CIPHERTEXT_LIMIT_CHARS,
  COMMENT_DISPLAY_NAME_LIMIT_BYTES,
  type CommentAnchor,
  decodeKey,
  decryptComment,
  deriveCommentKey,
  encryptComment,
  isValidRelicId,
} from '@relic/format';
import { mintRelic } from './inventory.ts';
import {
  getJson,
  type PublishDeps,
  PublishError,
  patchJson,
  postJson,
} from './publish.ts';
import {
  type ContentBlock,
  type ResolvedAnchor,
  resolveAnchors,
} from './resolve-anchor.ts';
import { loadPublishState, type PublishState } from './state.ts';

export interface CommentAddressedBy {
  readonly comment_id: string;
  readonly version: number | null;
}

/**
 * Who settled a comment, and when.
 *
 * Named after the viewer's `Resolution` (`packages/relic-viewer/src/comments.ts`)
 * because it is the same state read from the same three clear fields. It is
 * the one thing about a comment the service holds unencrypted, deliberately:
 * it decides whether a republish is blocked, which the service answers before
 * any key exists on its side. The operator learns that a comment was settled
 * and by which address, and still cannot read a word of it.
 */
export interface Resolution {
  readonly at: string;
  readonly by: string;
}

/** One comment as an agent reads it. */
export interface CommentRecord {
  readonly comment_id: string;
  /**
   * The verified email address of a human commenter, or the literal
   * `publisher` for a comment authorized by a publish token. Returned as the
   * service gave it: `docs/frame.md` makes the address the identity, so a
   * display name aliases it and never replaces it.
   */
  readonly author: string;
  readonly created_at: string;
  /** The commenter's chosen alias, when they set one. Decoration, not identity. */
  readonly display_name: string | null;
  /** Null exactly when `readable` is false. */
  readonly body: string | null;
  /**
   * What the comment is a mark on, or null for a freeform one.
   *
   * Dropping this was a defect rather than an omission. A reviewer's "this
   * line is wrong" is not actionable without the line, and an agent reading a
   * thread back could not tell a mark from a general remark, which is the
   * difference between fixing the right sentence and guessing. It lives inside
   * the encrypted envelope, so it arrives with the body or not at all.
   */
  readonly anchor: CommentAnchor | null;
  /**
   * The comment this one answers or acknowledges, by service-minted id.
   * Taken from the sealed copy only.
   */
  readonly addresses: string | null;
  readonly readable: boolean;
  /** Null exactly when `readable` is true. */
  readonly unreadable_reason: string | null;
  /**
   * True if some other comment carries addresses equal to this comment's id,
   * taken from the sealed copy only.
   */
  readonly addressed: boolean;
  /** The comment that addressed this one, if any. */
  readonly addressed_by: CommentAddressedBy | null;
  readonly addressed_by_comment_id?: string | null;
  readonly addressed_by_version?: number | null;
  /**
   * The version this comment was made on, or null for a row that predates
   * versioning. Dropped once, which was a defect: an agent reading a
   * republished relic could not tell remarks about the version it is reading
   * from remarks about content that no longer exists. The scoping rule that
   * decides which rows a read returns lives in `readComments`.
   */
  readonly version: number | null;
  /**
   * When the comment's body was replaced after it was posted, or null when it
   * never was. There is no edit history: the service holds one ciphertext per
   * comment and an edit overwrites it, so the honest thing on offer is the
   * fact that it happened, not the earlier text.
   */
  readonly edited_at: string | null;
  /**
   * The comment's settled state, or null while it is open. A resolved comment
   * counts as handled: it no longer blocks a republish, and `formatUnaddressedRefusal`
   * names resolving as one of the ways to clear the block.
   */
  readonly resolution: Resolution | null;
  /**
   * Resolved content for this comment's anchor when anchor resolution is
   * requested. Null when freeform or when resolution was not requested.
   */
  readonly resolved?: ResolvedAnchor | null;
}

export interface CommentsSummary {
  readonly total: number;
  readonly addressed: number;
  readonly open: number;
  /** Comments somebody marked settled. Handled, so they do not read as open. */
  readonly resolved: number;
  readonly unreadable: number;
}

export interface ReadCommentsResult {
  readonly relic_id: string;
  readonly count: number;
  /**
   * Comments the comment key did not open. Reported rather than dropped: a
   * silently shortened list reads as agreement, and an agent acting on
   * "nobody objected" when somebody did is the failure this member prevents.
   */
  readonly unreadable_count: number;
  readonly summary: CommentsSummary;
  readonly comments: readonly CommentRecord[];
  /**
   * The scope this read returned: a version number, or `'all'`.
   */
  readonly version_scope: number | 'all';
  /**
   * The relic's current version, as the service reported it. Resolved from
   * the service only when the read had to scope by it, because that read
   * spends one of the relic's finite opens; null when the caller named the
   * scope or asked for every version, and the number would have been a
   * second spend for a fact the scope did not need.
   */
  readonly current_version: number | null;
  /**
   * How many comments exist that this scope did not return. A scoped list
   * that read as a quiet thread would be the exact lie this package refuses
   * everywhere else, so the count rides beside the rows.
   */
  readonly hidden_by_scope: number;
  readonly content_blocks?: readonly ContentBlock[];
}

export interface CommentResult {
  readonly relic_id: string;
  readonly comment_id: string;
  readonly author: string;
  readonly created_at: string;
}
export interface ReadCommentsOptions {
  readonly resolve_anchors?: boolean;
  /**
   * Which versions to read: a positive version number, the literal `'*'` for
   * every comment on every version, or absent for the relic's current
   * version. Current is resolved from the service, never from local publish
   * state, which is stale the moment anything else republished.
   */
  readonly version?: number | '*' | undefined;
}

/** First part of a comment body for refusal summaries, truncated if long. */
export function previewCommentBody(body: string | null, maxChars = 80): string {
  if (body === null || body === undefined) return '';
  const trimmed = body.trim();
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  const text = firstLine.length > 0 ? firstLine : trimmed;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

/** Format the refusal message when republish is blocked by unaddressed comments. */
export function formatUnaddressedRefusal(
  relicId: string,
  openComments: readonly CommentRecord[],
  unreadableComments: readonly CommentRecord[] = []
): string {
  const parts: string[] = [];

  if (openComments.length > 0 && unreadableComments.length > 0) {
    parts.push(
      `cannot republish relic ${relicId} while comments remain unaddressed. ` +
        `${openComments.length} comment(s) are unanswered, and ${unreadableComments.length} comment(s) could not be decrypted. ` +
        'Clear unanswered comments either by replying with relic_comment, by resolving them with relic_resolve_comment, or by passing addresses: [{ comment_id, note }] on republish.'
    );
  } else if (openComments.length > 0) {
    parts.push(
      `cannot republish relic ${relicId} while comments remain unaddressed. ` +
        `${openComments.length} comment(s) are unanswered. ` +
        'Clear each open comment either by replying with relic_comment, by resolving it with relic_resolve_comment, or by passing addresses: [{ comment_id, note }] on republish.'
    );
  } else {
    parts.push(
      `cannot republish relic ${relicId} because ${unreadableComments.length} comment(s) could not be decrypted. ` +
        'A comment this client cannot read cannot be verified as addressed.'
    );
  }

  if (openComments.length > 0) {
    const list = openComments
      .map(
        (c) =>
          `- [${c.comment_id}] from ${c.author} at ${c.created_at}: "${previewCommentBody(c.body)}"`
      )
      .join('\n');
    parts.push(`Open comments (${openComments.length}):\n${list}`);
  }

  if (unreadableComments.length > 0) {
    const list = unreadableComments
      .map(
        (c) =>
          `- [${c.comment_id}] from ${c.author} at ${c.created_at}: unreadable (${c.unreadable_reason ?? "it did not decrypt under this relic's comment key"})`
      )
      .join('\n');
    parts.push(`Unreadable comments (${unreadableComments.length}):\n${list}`);
  }

  return parts.join('\n\n');
}

export type CommentAnchorInput =
  | CommentAnchor
  | {
      readonly kind: 'time';
      readonly t: number | string;
      readonly t_end?: number | string | undefined;
      readonly rect?: AnchorRect | undefined;
    }
  | {
      readonly kind: 'quote';
      readonly exact?: string | undefined;
      readonly quote?: string | undefined;
      readonly prefix?: string | undefined;
      readonly suffix?: string | undefined;
    }
  | {
      readonly kind: 'text';
      readonly quote?: string | undefined;
      readonly exact?: string | undefined;
    }
  | {
      readonly kind: 'page';
      readonly page: number | string;
      readonly rect?: AnchorRect | undefined;
      readonly exact?: string | undefined;
    }
  | {
      readonly kind: 'otio';
      readonly v?: number | undefined;
      readonly relic_version?: number | undefined;
      readonly document_sha256?: string | undefined;
      readonly timeline_id?: string | undefined;
      readonly track_id?: string | null | undefined;
      readonly item_id?: string | undefined;
      readonly range?: unknown;
      readonly snapshot?: unknown;
    };

export interface CommentInput {
  readonly relic_id: string;
  readonly body: string;
  readonly display_name?: string | undefined;
  readonly anchor?: CommentAnchorInput | null | undefined;
  /**
   * Optional service-minted id of the comment this one answers or acknowledges.
   * Sealed into the ciphertext and passed in the clear to the service for notification routing.
   */
  readonly addresses?: string | null | undefined;
}

export async function readComments(
  relicId: string,
  deps: PublishDeps,
  options?: ReadCommentsOptions
): Promise<ReadCommentsResult> {
  const state = await localState(relicId);

  // The scope. Absent means the relic's current version, and current comes
  // from the service, the same source `relic_show` uses, never from local
  // publish state, which is stale the moment anything else republished. A
  // failed read refuses here rather than degrading: a fetch that could not
  // say which version is current must not silently become a permissive
  // scope, a narrower one, or a guess.
  const rawScope = options?.version;
  if (
    rawScope !== undefined &&
    rawScope !== '*' &&
    (typeof rawScope !== 'number' ||
      !Number.isSafeInteger(rawScope) ||
      rawScope < 1)
  ) {
    throw new PublishError(
      'local_version_scope_invalid',
      'version must be a positive version number or the literal "*", not ' +
        `${JSON.stringify(rawScope)}. Omit it to read the relic's current ` +
        'version.'
    );
  }

  let currentVersion: number | null = null;
  let scope: number | 'all';
  if (rawScope === undefined) {
    const minted = await mintRelic(relicId, deps);
    if (minted.kind === 'failed') {
      throw new PublishError(
        'current_version_unavailable',
        `the relic's current version could not be read from the service, so ` +
          `the default scope cannot be resolved: ${minted.detail}. Pass an ` +
          'explicit version, or "*" for every version, to read without it.',
        { relic_id: relicId }
      );
    }
    currentVersion = minted.currentVersion;
    scope = currentVersion;
  } else if (rawScope === '*') {
    scope = 'all';
  } else {
    scope = rawScope;
  }

  // No credential on this read. Anyone holding the link can already fetch the
  // ciphertext, and the bodies are ciphertext the service cannot open, so
  // authorizing it would gate nothing and cost the token an exposure.
  const listed = await getJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${relicId}/comments`
  );
  if (!Array.isArray(listed)) {
    throw new PublishError(
      'app_response_unusable',
      'the comment list did not come back as a JSON array, so there is no ' +
        'way to tell an empty conversation from an unreadable response',
      { relic_id: relicId, leg: 'comments' }
    );
  }

  const commentKey = await deriveCommentKey(decodeKey(state.key));
  interface DecryptedCommentEntry {
    comment_id: string;
    author: string;
    created_at: string;
    display_name: string | null;
    body: string | null;
    anchor: CommentAnchor | null;
    addresses: string | null;
    version: number | null;
    edited_at: string | null;
    resolution: Resolution | null;
    readable: boolean;
    unreadable_reason: string | null;
  }
  const entries: DecryptedCommentEntry[] = [];

  for (const [index, entry] of listed.entries()) {
    const row =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const commentId =
      typeof row['comment_id'] === 'string'
        ? row['comment_id']
        : `unidentified-${index}`;
    const author =
      typeof row['author'] === 'string' ? row['author'] : 'unknown';
    const createdAt =
      typeof row['created_at'] === 'string' ? row['created_at'] : 'unknown';
    const ciphertext = row['ciphertext'];
    const version = typeof row['version'] === 'number' ? row['version'] : null;
    // Clear fields, read the way the viewer reads them
    // (`packages/relic-viewer/src/comments.ts`, `resolutionOf`): the state
    // exists only when both halves arrived.
    const editedAt =
      typeof row['edited_at'] === 'string' ? row['edited_at'] : null;
    const resolvedAt =
      typeof row['resolved_at'] === 'string' ? row['resolved_at'] : null;
    const resolvedBy =
      typeof row['resolved_by'] === 'string' ? row['resolved_by'] : null;
    const resolution =
      resolvedAt === null || resolvedBy === null
        ? null
        : { at: resolvedAt, by: resolvedBy };

    if (typeof ciphertext !== 'string') {
      entries.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: null,
        body: null,
        anchor: null,
        addresses: null,
        version,
        edited_at: editedAt,
        resolution,
        readable: false,
        unreadable_reason: 'the row carried no ciphertext',
      });
      continue;
    }

    try {
      const plaintext = await decryptComment(commentKey, ciphertext);
      entries.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: plaintext.display_name,
        body: plaintext.body,
        // Absent and null both mean freeform. One shape crosses to the agent,
        // so a caller never has to distinguish two ways of saying no mark.
        anchor: plaintext.anchor ?? null,
        addresses: plaintext.addresses ?? null,
        version,
        edited_at: editedAt,
        resolution,
        readable: true,
        unreadable_reason: null,
      });
    } catch (error) {
      // One comment that will not open must not hide the ones that will, and
      // it must not vanish either. It comes back named, with the reason.
      entries.push({
        comment_id: commentId,
        author,
        created_at: createdAt,
        display_name: null,
        body: null,
        anchor: null,
        addresses: null,
        version,
        edited_at: editedAt,
        resolution,
        readable: false,
        unreadable_reason: `it did not decrypt under this relic's comment key: ${
          (error as Error).message
        }`,
      });
    }
  }

  // The sealed copy is authoritative. It sits inside the AEAD. A caller MAY
  // also pass the same id to the service in the clear so the service can route
  // a notification, and that clear copy is a routing hint the operator can see
  // and could forge. Nothing user-facing may resolve "addressed" from the clear
  // copy. We only inspect plaintext.addresses from the decrypted ciphertext.
  const addressedByMap = new Map<
    string,
    { comment_id: string; version: number | null }
  >();

  for (const entry of entries) {
    if (
      entry.readable &&
      entry.addresses !== null &&
      entry.addresses !== entry.comment_id
    ) {
      if (!addressedByMap.has(entry.addresses)) {
        addressedByMap.set(entry.addresses, {
          comment_id: entry.comment_id,
          version: entry.version,
        });
      }
    }
  }

  const comments: CommentRecord[] = entries
    // The version scope, mirroring the viewer's thread filter exactly
    // (packages/relic-viewer/src/main.ts 4577-4597): a relic with no history
    // shows everything regardless of stored version, a row carrying a version
    // shows only on that version, and a row carrying none belongs to version 1.
    .filter((entry) => {
      if (scope === 'all') return true;

      // Current version was not read on an explicitly scoped read. A relic
      // with no history cannot carry a row stamped above version 1, the
      // version never moves backwards, and a scope of 2 or more already
      // proves history, so treating history as present here hides nothing
      // the no-history branch would have shown.
      const hasHistory = currentVersion === null || currentVersion > 1;
      if (!hasHistory) {
        return true;
      }

      if (entry.version !== null && entry.version !== undefined) {
        return entry.version === scope;
      }

      return scope === 1;
    })
    .map((entry) => {
      const addressedBy = addressedByMap.get(entry.comment_id) ?? null;
      const addressed = addressedBy !== null;
      return {
        comment_id: entry.comment_id,
        author: entry.author,
        created_at: entry.created_at,
        display_name: entry.display_name,
        body: entry.body,
        anchor: entry.anchor,
        addresses: entry.addresses,
        readable: entry.readable,
        unreadable_reason: entry.unreadable_reason,
        addressed,
        addressed_by: addressedBy,
        addressed_by_comment_id: addressedBy?.comment_id ?? null,
        addressed_by_version: addressedBy?.version ?? null,
        version: entry.version,
        edited_at: entry.edited_at,
        resolution: entry.resolution,
      };
    });

  const addressedCount = comments.filter((c) => c.addressed).length;
  const unreadableCount = comments.filter((c) => !c.readable).length;
  // A comment is open when it is readable, has not been addressed by another
  // comment, is not itself a reply or update acknowledgement, and has not
  // been resolved. Resolving is one of the ways a comment is handled, so a
  // settled one does not read as open.
  const openCount = comments.filter(
    (c) =>
      c.readable &&
      !c.addressed &&
      c.addresses === null &&
      c.resolution === null
  ).length;
  const resolvedCount = comments.filter((c) => c.resolution !== null).length;

  const summary: CommentsSummary = {
    total: comments.length,
    addressed: addressedCount,
    open: openCount,
    resolved: resolvedCount,
    unreadable: unreadableCount,
  };

  const scopeFields = {
    version_scope: scope,
    current_version: currentVersion,
    hidden_by_scope: entries.length - comments.length,
  };

  if (options?.resolve_anchors === true) {
    const resolved = await resolveAnchors(relicId, comments, deps);
    return {
      relic_id: relicId,
      count: comments.length,
      unreadable_count: unreadableCount,
      summary,
      comments: resolved.comments,
      ...scopeFields,
      content_blocks: resolved.imageBlocks,
    };
  }

  return {
    relic_id: relicId,
    count: comments.length,
    unreadable_count: unreadableCount,
    summary,
    comments,
    ...scopeFields,
  };
}

export async function postComment(
  input: CommentInput,
  deps: PublishDeps
): Promise<CommentResult> {
  const state = await localState(input.relic_id);

  // The caps belong to the envelope, so they are enforced against its numbers
  // rather than a second copy of them, and enforced before encryption so the
  // refusal names the limit instead of a cipher failure.
  const bodyBytes = new TextEncoder().encode(input.body).length;
  if (input.body.trim().length === 0) {
    throw new PublishError(
      'local_comment_body_empty',
      'a comment needs a body. An empty one is attributable noise nobody can ' +
        'answer.'
    );
  }
  if (bodyBytes > COMMENT_BODY_LIMIT_BYTES) {
    throw new PublishError(
      'local_comment_body_too_long',
      `the comment body is ${bodyBytes} bytes of UTF-8 and the limit is ` +
        `${COMMENT_BODY_LIMIT_BYTES}. Shorten it; a truncated comment would ` +
        'change what it says.',
      { body_bytes: bodyBytes, limit_bytes: COMMENT_BODY_LIMIT_BYTES }
    );
  }

  const displayName = input.display_name ?? null;
  if (displayName !== null) {
    const nameBytes = new TextEncoder().encode(displayName).length;
    if (nameBytes > COMMENT_DISPLAY_NAME_LIMIT_BYTES) {
      throw new PublishError(
        'local_comment_name_too_long',
        `the display name is ${nameBytes} bytes of UTF-8 and the limit is ` +
          `${COMMENT_DISPLAY_NAME_LIMIT_BYTES}.`,
        { name_bytes: nameBytes, limit_bytes: COMMENT_DISPLAY_NAME_LIMIT_BYTES }
      );
    }
  }

  let addresses: string | null = null;
  if (input.addresses !== undefined && input.addresses !== null) {
    if (
      typeof input.addresses !== 'string' ||
      input.addresses.trim().length === 0
    ) {
      throw new PublishError(
        'local_comment_addresses_invalid',
        'addresses must be a non-empty string naming the comment being answered.'
      );
    }
    const addressesBytes = new TextEncoder().encode(input.addresses).length;
    if (addressesBytes > COMMENT_ADDRESSES_LIMIT_BYTES) {
      throw new PublishError(
        'local_comment_addresses_too_long',
        `addresses is ${addressesBytes} bytes of UTF-8 and the limit is ${COMMENT_ADDRESSES_LIMIT_BYTES}.`,
        {
          addresses_bytes: addressesBytes,
          limit_bytes: COMMENT_ADDRESSES_LIMIT_BYTES,
        }
      );
    }
    addresses = input.addresses;
  }

  const anchor = validateAndNormalizeAnchor(input.anchor);

  const commentKey = await deriveCommentKey(decodeKey(state.key));
  const ciphertext = await encryptComment(commentKey, {
    body: input.body,
    display_name: displayName,
    anchor,
    ...(addresses == null ? {} : { addresses }),
  });
  refuseOversizedCiphertext(ciphertext);
  // The token travels in the body, where the republish grant already puts it,
  // so the two write paths authorize the same way and neither invents a
  // header the service has to learn.
  // When addressing a comment, the pointer is also sent in the clear for
  // notification routing.
  const posted = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/comments`,
    {
      publish_token: state.publish_token,
      ciphertext,
      ...(addresses == null ? {} : { addresses }),
    }
  );
  return {
    relic_id: input.relic_id,
    comment_id: String(posted['comment_id']),
    author: String(posted['author']),
    created_at: String(posted['created_at']),
  };
}

/** The state a comment write answers with, as the service's contract defines it. */
export interface CommentStateResult {
  readonly relic_id: string;
  readonly comment_id: string;
  readonly author: string;
  readonly created_at: string;
  readonly edited_at: string | null;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

export interface EditCommentInput {
  readonly relic_id: string;
  readonly comment_id: string;
  readonly body: string;
}

export interface ResolveCommentInput {
  readonly relic_id: string;
  readonly comment_id: string;
  readonly resolved: boolean;
}

/** Narrow the service's comment-write answer into the state it contracts. */
function commentState(
  relicId: string,
  commentId: string,
  posted: Record<string, unknown>
): CommentStateResult {
  return {
    relic_id: relicId,
    comment_id: commentId,
    author: String(posted['author']),
    created_at: String(posted['created_at']),
    edited_at:
      typeof posted['edited_at'] === 'string' ? posted['edited_at'] : null,
    resolved_at:
      typeof posted['resolved_at'] === 'string' ? posted['resolved_at'] : null,
    resolved_by:
      typeof posted['resolved_by'] === 'string' ? posted['resolved_by'] : null,
  };
}

/**
 * Replace the body of a comment this machine's publish token authored.
 *
 * The whole plaintext is re-sealed, so the comment's existing anchor and
 * addresses are carried forward exactly: an edit changes words, never where
 * they point. Moving a mark under an existing conversation would leave every
 * reply answering something the reader can no longer see, and the display
 * name is decoration the edit was never asked to touch.
 *
 * There is no history. The service holds one ciphertext per comment and this
 * overwrites it, which is why the row carries `edited_at` and nothing else
 * about the earlier text is on offer.
 */
export async function editComment(
  input: EditCommentInput,
  deps: PublishDeps
): Promise<CommentStateResult> {
  const state = await localState(input.relic_id);
  if (typeof input.comment_id !== 'string' || input.comment_id.length === 0) {
    throw new PublishError(
      'local_comment_not_found',
      'comment_id is required. The id is service-minted and can only come ' +
        'from having read the relic\u2019s comments.'
    );
  }

  const bodyBytes = new TextEncoder().encode(input.body).length;
  if (input.body.trim().length === 0) {
    throw new PublishError(
      'local_comment_body_empty',
      'a comment needs a body. An empty one is attributable noise nobody can ' +
        'answer.'
    );
  }
  if (bodyBytes > COMMENT_BODY_LIMIT_BYTES) {
    throw new PublishError(
      'local_comment_body_too_long',
      `the comment body is ${bodyBytes} bytes of UTF-8 and the limit is ` +
        `${COMMENT_BODY_LIMIT_BYTES}. Shorten it; a truncated comment would ` +
        'change what it says.',
      { body_bytes: bodyBytes, limit_bytes: COMMENT_BODY_LIMIT_BYTES }
    );
  }

  // The existing comment, read back on the relic it belongs to. The `'*'`
  // scope, because an edit targets a comment by id, not by version, and
  // scoping by current could refuse an edit of a remark left on an older
  // one. Read over the network rather than from any local cache: the
  // comment could have been edited by a newer writer since it was read.
  const thread = await readComments(input.relic_id, deps, { version: '*' });
  const existing = thread.comments.find(
    (c) => c.comment_id === input.comment_id
  );
  if (existing === undefined) {
    throw new PublishError(
      'local_comment_not_found',
      `comment ${input.comment_id} does not exist on relic ` +
        `${input.relic_id}. The comment ids can only come from having read ` +
        'the relic\u2019s comments.'
    );
  }
  if (!existing.readable) {
    throw new PublishError(
      'local_comment_unreadable',
      `comment ${input.comment_id} could not be decrypted on this machine, ` +
        'so its anchor and addresses cannot be carried into a re-sealed ' +
        'copy: editing it here would silently change where it points. ' +
        `${existing.unreadable_reason ?? 'it did not decrypt under this relic\u2019s comment key'}`
    );
  }

  // A fresh plaintext built from the decrypted comment, never the decrypted
  // object passed on: the read stamps `unsupported_fields` when it met a
  // field it did not know, and that member is read-only. Only the body is
  // replaced; the anchor and addresses travel forward untouched.
  const commentKey = await deriveCommentKey(decodeKey(state.key));
  const ciphertext = await encryptComment(commentKey, {
    body: input.body,
    display_name: existing.display_name,
    anchor: existing.anchor,
    ...(existing.addresses == null ? {} : { addresses: existing.addresses }),
  }).catch((error: unknown) => {
    // A comment this machine could read but cannot re-seal (an anchor the
    // current writer refuses, most likely) is a named refusal, not a
    // cipher crash the agent has to interpret.
    throw new PublishError(
      'local_comment_unreadable',
      `comment ${input.comment_id} cannot be re-sealed on this machine: ${
        (error as Error).message
      }`,
      { comment_id: input.comment_id }
    );
  });
  refuseOversizedCiphertext(ciphertext);
  // The token travels in the body, where the republish grant already puts
  // it, so every write path authorizes the same way.
  const posted = await patchJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/comments/${encodeURIComponent(input.comment_id)}`,
    {
      publish_token: state.publish_token,
      ciphertext,
    }
  );
  return commentState(input.relic_id, input.comment_id, posted);
}

/**
 * Set or clear the resolution on a comment on a relic this machine published.
 *
 * The service lets a publish token resolve anything on its own relic, because
 * a publisher settling feedback on their relic is the point of the state. It
 * is not encrypted and cannot be: it decides whether a republish is blocked,
 * and the service answers that before any key exists on its side. The
 * operator learns that a comment was settled and by which address, and still
 * cannot read a word of it.
 */
export async function resolveComment(
  input: ResolveCommentInput,
  deps: PublishDeps
): Promise<CommentStateResult> {
  const state = await localState(input.relic_id);
  if (typeof input.comment_id !== 'string' || input.comment_id.length === 0) {
    throw new PublishError(
      'local_comment_not_found',
      'comment_id is required. The id is service-minted and can only come ' +
        'from having read the relic\u2019s comments.'
    );
  }

  const posted = await patchJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relic_id}/comments/${encodeURIComponent(input.comment_id)}`,
    {
      publish_token: state.publish_token,
      resolved: input.resolved === true,
    }
  );
  return commentState(input.relic_id, input.comment_id, posted);
}

/**
 * The machine boundary, checked before anything touches the network.
 *
 * Both tools need the key, and the write needs the publish token too. Neither
 * can be reconstructed from the link or from the service, so a relic this
 * machine never published is refused here rather than after a round trip that
 * could only end the same way.
 */
async function localState(relicId: string): Promise<PublishState> {
  if (!isValidRelicId(relicId)) {
    throw new PublishError(
      'no_local_publish_state',
      `"${relicId}" is not a relic id. These tools take the 26-character id ` +
        'the original publish returned, never the share URL: the URL carries ' +
        'the key in its fragment, and passing it would put the key in this ' +
        'transcript for nothing.'
    );
  }

  try {
    const loaded = await loadPublishState(relicId);
    if (loaded === undefined) {
      throw new PublishError(
        'no_local_publish_state',
        `relic ${relicId} was published from another machine, so its ` +
          'comments can be neither read nor written here. The key that ' +
          'decrypts a comment and the publish token that authorizes one live ' +
          'only on the machine that made the first publish, and neither can ' +
          'be reconstructed from the link or from the service. Open the ' +
          "relic's own page to read its comments, or ask whoever published it."
      );
    }
    return loaded;
  } catch (error) {
    // State-file damage is not "published elsewhere"; naming it as that would
    // send someone hunting the wrong machine.
    if (error instanceof PublishError) throw error;
    throw new PublishError('local_state_unreadable', (error as Error).message);
  }
}

/**
 * Plain-language position of a bounding box on an artifact.
 *
 * An agent reasoning about a visual mark needs words like "upper left" or
 * "centre" rather than raw decimal fractions. The position is computed from
 * the box center point, with boxes covering most of the content area
 * labeled "centre".
 */
export function boxPosition(rect: AnchorRect): string {
  if (rect.w >= 0.8 && rect.h >= 0.8) {
    return 'centre';
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  let v = 'middle';
  if (cy < 0.35) v = 'upper';
  else if (cy > 0.65) v = 'lower';

  let h = 'centre';
  if (cx < 0.35) h = 'left';
  else if (cx > 0.65) h = 'right';

  if (v === 'middle' && h === 'centre') return 'centre';
  if (v === 'middle') return `middle ${h}`;
  if (h === 'centre') return `${v} centre`;
  return `${v} ${h}`;
}

/**
 * Format media seconds into "m:ss" or "h:mm:ss" timecode.
 */
export function formatTimecode(seconds: number): string {
  const rounded = Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = Math.floor(rounded % 60);
  const sStr = String(s).padStart(2, '0');
  if (h > 0) {
    const mStr = String(m).padStart(2, '0');
    return `${h}:${mStr}:${sStr}`;
  }
  return `${m}:${sStr}`;
}

/**
 * Parse an offset given as seconds or a timecode string ("m:ss", "h:mm:ss").
 *
 * Models reading "1:23" from a transcript must be able to reply using that
 * exact string and have it round-trip to the same offset.
 */
export function parseTimecode(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PublishError(
        'local_comment_anchor_time_invalid',
        `the ${label} must be a finite number: ${value}.`
      );
    }
    if (value < 0 || value > COMMENT_ANCHOR_MAX_SECONDS) {
      throw new PublishError(
        'local_comment_anchor_time_out_of_range',
        `the ${label} is ${value} seconds, but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds (24 hours).`,
        { time_seconds: value, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
      );
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new PublishError(
        'local_comment_anchor_time_invalid',
        `the ${label} timecode cannot be empty.`
      );
    }
    const parts = trimmed.split(':');
    if (parts.length === 1) {
      const s = Number(parts[0]);
      if (!Number.isFinite(s)) {
        throw new PublishError(
          'local_comment_anchor_time_invalid',
          `the ${label} is not a valid number or timecode: "${value}".`
        );
      }
      if (s < 0 || s > COMMENT_ANCHOR_MAX_SECONDS) {
        throw new PublishError(
          'local_comment_anchor_time_out_of_range',
          `the ${label} is ${s} seconds, but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds (24 hours).`,
          { time_seconds: s, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
        );
      }
      return s;
    }
    if (parts.length === 2) {
      const partM = parts[0] ?? '';
      const partS = parts[1] ?? '';
      const m = Number(partM);
      const s = Number(partS);
      if (
        !Number.isFinite(m) ||
        !Number.isFinite(s) ||
        m < 0 ||
        s < 0 ||
        s >= 60 ||
        partS.length < 2
      ) {
        throw new PublishError(
          'local_comment_anchor_time_invalid',
          `the ${label} timecode "${value}" is invalid. Expected format like "m:ss" with seconds between 00 and 59.`
        );
      }
      const total = m * 60 + s;
      if (total > COMMENT_ANCHOR_MAX_SECONDS) {
        throw new PublishError(
          'local_comment_anchor_time_out_of_range',
          `the ${label} is ${total} seconds (${value}), but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds.`,
          { time_seconds: total, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
        );
      }
      return total;
    }
    if (parts.length === 3) {
      const partH = parts[0] ?? '';
      const partM = parts[1] ?? '';
      const partS = parts[2] ?? '';
      const h = Number(partH);
      const m = Number(partM);
      const s = Number(partS);
      if (
        !Number.isFinite(h) ||
        !Number.isFinite(m) ||
        !Number.isFinite(s) ||
        h < 0 ||
        m < 0 ||
        m >= 60 ||
        s < 0 ||
        s >= 60 ||
        partM.length < 2 ||
        partS.length < 2
      ) {
        throw new PublishError(
          'local_comment_anchor_time_invalid',
          `the ${label} timecode "${value}" is invalid. Expected format like "h:mm:ss" with minutes and seconds between 00 and 59.`
        );
      }
      const total = h * 3600 + m * 60 + s;
      if (total > COMMENT_ANCHOR_MAX_SECONDS) {
        throw new PublishError(
          'local_comment_anchor_time_out_of_range',
          `the ${label} is ${total} seconds (${value}), but must be between 0 and ${COMMENT_ANCHOR_MAX_SECONDS} seconds.`,
          { time_seconds: total, max_seconds: COMMENT_ANCHOR_MAX_SECONDS }
        );
      }
      return total;
    }
  }

  throw new PublishError(
    'local_comment_anchor_time_invalid',
    `the ${label} must be a number of seconds or a timecode string like "1:23".`
  );
}

/**
 * Render what a comment points at into words an agent can act on.
 *
 * Every anchor kind is described without requiring the agent to guess at
 * coordinate systems: quotes include disambiguating context, pins state they
 * are stage-relative, regions give plain-language positions and percentages,
 * times format as timecodes, pages name the page number, and unsupported marks
 * state the declared kind rather than pretending the mark does not exist.
 *
 * A comment without an anchor is described as being about the whole relic,
 * so it is not confused with a mark that failed to place.
 */
export function describeAnchor(anchor: CommentAnchor | null): string {
  if (anchor === null) {
    return 'about the whole relic';
  }

  switch (anchor.kind) {
    case 'text':
      return `on "${anchor.quote}"`;

    case 'quote': {
      const contextParts: string[] = [];
      if (anchor.prefix !== undefined) {
        contextParts.push(`"${anchor.prefix}" before`);
      }
      if (anchor.suffix !== undefined) {
        contextParts.push(`"${anchor.suffix}" after`);
      }
      if (contextParts.length > 0) {
        return `on "${anchor.exact}" (context: ${contextParts.join(', ')})`;
      }
      return `on "${anchor.exact}"`;
    }

    case 'pin': {
      const percent = (value: number): number => Math.round(value * 100);
      return `at ${percent(anchor.x)}% across, ${percent(anchor.y)}% down (stage-relative point)`;
    }

    case 'region': {
      const pos = boxPosition(anchor.rect);
      const r = anchor.rect;
      return (
        `in region (${pos}, ${Math.round(r.x * 100)}% across, ` +
        `${Math.round(r.y * 100)}% down, ${Math.round(r.w * 100)}% wide by ` +
        `${Math.round(r.h * 100)}% high)`
      );
    }

    case 'time': {
      const timeStr =
        anchor.t_end !== undefined
          ? `at ${formatTimecode(anchor.t)} to ${formatTimecode(anchor.t_end)}`
          : `at ${formatTimecode(anchor.t)}`;
      if (anchor.rect !== undefined) {
        const pos = boxPosition(anchor.rect);
        const r = anchor.rect;
        return (
          `${timeStr} in region (${pos}, ${Math.round(r.x * 100)}% across, ` +
          `${Math.round(r.y * 100)}% down, ${Math.round(r.w * 100)}% wide by ` +
          `${Math.round(r.h * 100)}% high)`
        );
      }
      return timeStr;
    }

    case 'page': {
      const parts: string[] = [`on page ${anchor.page}`];
      if (anchor.exact !== undefined) {
        parts.push(`at "${anchor.exact}"`);
      }
      if (anchor.rect !== undefined) {
        const pos = boxPosition(anchor.rect);
        const r = anchor.rect;
        parts.push(
          `in region (${pos}, ${Math.round(r.x * 100)}% across, ` +
            `${Math.round(r.y * 100)}% down, ${Math.round(r.w * 100)}% wide by ` +
            `${Math.round(r.h * 100)}% high)`
        );
      }
      return parts.join(' ');
    }

    case 'otio': {
      const start = anchor.range.start_time;
      const duration = anchor.range.duration;
      const where =
        anchor.track_id === null
          ? `timeline ${anchor.snapshot.timeline}`
          : `track ${anchor.snapshot.track ?? anchor.track_id} of ${anchor.snapshot.timeline}`;
      const span =
        duration.value === 0
          ? `point ${start.value}/${start.rate}`
          : `range ${start.value}/${start.rate} for ${duration.value}/${duration.rate}`;
      return `on ${where} (${span}, relic version ${anchor.relic_version})`;
    }

    case 'unsupported':
      return `carrying a mark this client does not understand (declared kind "${anchor.declared}")`;
  }
}

function parseRectInput(rect: unknown, kind: string): AnchorRect {
  if (typeof rect !== 'object' || rect === null || Array.isArray(rect)) {
    throw new PublishError(
      'local_comment_anchor_rect_invalid',
      `the ${kind} anchor rect must be an object with {x, y, w, h} in unit coordinates (0 to 1).`
    );
  }
  const r = rect as Record<string, unknown>;
  const x = Number(r['x']);
  const y = Number(r['y']);
  const w = Number(r['w']);
  const h = Number(r['h']);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    throw new PublishError(
      'local_comment_anchor_rect_invalid',
      `the ${kind} anchor rect fields {x, y, w, h} must all be finite numbers.`
    );
  }
  if (x < 0 || y < 0 || x > 1 || y > 1) {
    throw new PublishError(
      'local_comment_anchor_rect_out_of_bounds',
      `the ${kind} anchor rect position {x: ${x}, y: ${y}} must be between 0 and 1.`,
      { x, y, w, h }
    );
  }
  if (w <= 0 || h <= 0) {
    throw new PublishError(
      'local_comment_anchor_rect_zero_area',
      `the ${kind} anchor rect dimensions {w: ${w}, h: ${h}} must have real positive area.`,
      { x, y, w, h }
    );
  }
  if (x + w > 1.000001 || y + h > 1.000001) {
    throw new PublishError(
      'local_comment_anchor_rect_overhang',
      `the ${kind} anchor rect overhangs the boundary: x+w=${x + w}, y+h=${y + h}. Coordinates must fit within the unit square.`,
      { x, y, w, h }
    );
  }
  return { x, y, w, h };
}

/** Refuse a sealed comment that cannot fit the service ciphertext cap. */
export function refuseOversizedCiphertext(ciphertext: string): void {
  if (ciphertext.length > COMMENT_CIPHERTEXT_LIMIT_CHARS) {
    throw new PublishError(
      'local_comment_ciphertext_too_long',
      `the sealed comment is ${ciphertext.length} characters and the limit is ${COMMENT_CIPHERTEXT_LIMIT_CHARS}. Shorten the body or the anchor before posting.`,
      {
        ciphertext_chars: ciphertext.length,
        limit_chars: COMMENT_CIPHERTEXT_LIMIT_CHARS,
      }
    );
  }
}

function requireRational(
  value: unknown,
  label: string,
  allowZero: boolean
): { readonly value: number; readonly rate: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      `${label} must be an object with value and rate.`
    );
  }
  const record = value as Record<string, unknown>;
  const rationalValue = record['value'];
  const rate = record['rate'];
  if (typeof rationalValue !== 'number' || !Number.isFinite(rationalValue)) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      `${label} value must be a finite number.`
    );
  }
  if (allowZero && rationalValue < 0) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      `${label} value must be non-negative.`
    );
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      `${label} rate must be a positive finite number.`
    );
  }
  return { value: rationalValue, rate };
}

function normalizeOtioAnchor(
  obj: Record<string, unknown>
): Extract<CommentAnchor, { kind: 'otio' }> {
  if (obj['v'] !== 1) {
    throw new PublishError(
      'local_comment_anchor_unsupported',
      `otio anchor version ${JSON.stringify(obj['v'])} is unsupported. This client writes version 1 only. A newer version is not treated as tampering when read back.`
    );
  }
  const relicVersion = obj['relic_version'];
  if (
    typeof relicVersion !== 'number' ||
    !Number.isSafeInteger(relicVersion) ||
    relicVersion < 1
  ) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'an otio anchor requires relic_version as a positive integer.'
    );
  }
  const digest = obj['document_sha256'];
  if (typeof digest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(digest)) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'an otio anchor requires document_sha256 as 64 hex characters.'
    );
  }
  const timelineId = obj['timeline_id'];
  if (typeof timelineId !== 'string' || timelineId.length === 0) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'an otio anchor requires a non-empty timeline_id.'
    );
  }
  const trackId = obj['track_id'];
  if (trackId !== null && (typeof trackId !== 'string' || trackId.length === 0)) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'otio track_id must be null for the whole composition or a non-empty track id.'
    );
  }
  const itemId = obj['item_id'];
  if (itemId !== undefined && (typeof itemId !== 'string' || itemId.length === 0)) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'otio item_id, when present, must be a non-empty string.'
    );
  }
  if (typeof obj['range'] !== 'object' || obj['range'] === null) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'an otio anchor requires a range object.'
    );
  }
  const range = obj['range'] as Record<string, unknown>;
  const start = requireRational(range['start_time'], 'range start_time', false);
  const duration = requireRational(range['duration'], 'range duration', true);
  const snapshot = obj['snapshot'];
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'an otio anchor requires a snapshot with timeline, track, and item labels.'
    );
  }
  const snap = snapshot as Record<string, unknown>;
  if (typeof snap['timeline'] !== 'string') {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'otio snapshot.timeline must be a string.'
    );
  }
  if (snap['track'] !== null && typeof snap['track'] !== 'string') {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'otio snapshot.track must be a string or null.'
    );
  }
  if (snap['item'] !== null && typeof snap['item'] !== 'string') {
    throw new PublishError(
      'local_comment_anchor_otio_invalid',
      'otio snapshot.item must be a string or null.'
    );
  }
  const anchor: Extract<CommentAnchor, { kind: 'otio' }> = {
    kind: 'otio',
    v: 1,
    relic_version: relicVersion,
    document_sha256: digest.toLowerCase(),
    timeline_id: timelineId,
    track_id: trackId,
    ...(itemId === undefined ? {} : { item_id: itemId }),
    range: { start_time: start, duration },
    snapshot: {
      timeline: snap['timeline'],
      track: snap['track'],
      item: snap['item'],
    },
  };
  const encoded = new TextEncoder().encode(JSON.stringify(anchor)).length;
  if (encoded > COMMENT_ANCHOR_OTIO_LIMIT_BYTES) {
    throw new PublishError(
      'local_comment_anchor_otio_too_long',
      `the otio anchor is ${encoded} bytes and the limit is ${COMMENT_ANCHOR_OTIO_LIMIT_BYTES}.`,
      {
        anchor_bytes: encoded,
        limit_bytes: COMMENT_ANCHOR_OTIO_LIMIT_BYTES,
      }
    );
  }
  return anchor;
}


/**
 * Validate and canonicalize an anchor input at the tool boundary.
 *
 * Enforces all format bounds and caps before reaching encryption, returning
 * human-readable PublishError refusals rather than opaque cipher failures.
 */
export function validateAndNormalizeAnchor(raw: unknown): CommentAnchor | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PublishError(
      'local_comment_anchor_invalid',
      'the anchor must be an object or omitted.'
    );
  }

  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (typeof kind !== 'string') {
    throw new PublishError(
      'local_comment_anchor_invalid',
      'the anchor is missing a "kind" string.'
    );
  }

  switch (kind) {
    case 'unsupported':
      throw new PublishError(
        'local_comment_anchor_unsupported',
        'unsupported is a parser output kind and cannot be written as a comment anchor.'
      );

    case 'text': {
      const quoteVal = obj['quote'] ?? obj['exact'];
      if (typeof quoteVal !== 'string' || quoteVal.trim().length === 0) {
        throw new PublishError(
          'local_comment_anchor_quote_empty',
          'a text anchor requires a non-empty "quote" string.'
        );
      }
      const quoteBytes = new TextEncoder().encode(quoteVal).length;
      if (quoteBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
        throw new PublishError(
          'local_comment_anchor_quote_too_long',
          `the quote is ${quoteBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}.`,
          {
            quote_bytes: quoteBytes,
            limit_bytes: COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
          }
        );
      }
      return { kind: 'text', quote: quoteVal };
    }

    case 'quote': {
      const exactVal = obj['exact'] ?? obj['quote'];
      if (typeof exactVal !== 'string' || exactVal.trim().length === 0) {
        throw new PublishError(
          'local_comment_anchor_quote_empty',
          'a quote anchor requires a non-empty "exact" string.'
        );
      }
      const exactBytes = new TextEncoder().encode(exactVal).length;
      if (exactBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
        throw new PublishError(
          'local_comment_anchor_quote_too_long',
          `the exact quote is ${exactBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}.`,
          {
            quote_bytes: exactBytes,
            limit_bytes: COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
          }
        );
      }

      let prefix: string | undefined;
      if (obj['prefix'] !== undefined && obj['prefix'] !== null) {
        if (typeof obj['prefix'] !== 'string') {
          throw new PublishError(
            'local_comment_anchor_context_invalid',
            'the quote prefix must be a string or omitted.'
          );
        }
        const prefixBytes = new TextEncoder().encode(obj['prefix']).length;
        if (prefixBytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
          throw new PublishError(
            'local_comment_anchor_context_too_long',
            `the quote prefix is ${prefixBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES}.`,
            {
              context_bytes: prefixBytes,
              limit_bytes: COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
              context_type: 'prefix',
            }
          );
        }
        prefix = obj['prefix'];
      }

      let suffix: string | undefined;
      if (obj['suffix'] !== undefined && obj['suffix'] !== null) {
        if (typeof obj['suffix'] !== 'string') {
          throw new PublishError(
            'local_comment_anchor_context_invalid',
            'the quote suffix must be a string or omitted.'
          );
        }
        const suffixBytes = new TextEncoder().encode(obj['suffix']).length;
        if (suffixBytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
          throw new PublishError(
            'local_comment_anchor_context_too_long',
            `the quote suffix is ${suffixBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES}.`,
            {
              context_bytes: suffixBytes,
              limit_bytes: COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES,
              context_type: 'suffix',
            }
          );
        }
        suffix = obj['suffix'];
      }

      return {
        kind: 'quote',
        exact: exactVal,
        ...(prefix !== undefined ? { prefix } : {}),
        ...(suffix !== undefined ? { suffix } : {}),
      };
    }

    case 'pin': {
      const x = Number(obj['x']);
      const y = Number(obj['y']);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1
      ) {
        throw new PublishError(
          'local_comment_anchor_pin_invalid',
          `the pin coordinates {x: ${obj['x']}, y: ${obj['y']}} must be numbers between 0 and 1.`,
          { x: obj['x'], y: obj['y'] }
        );
      }
      return { kind: 'pin', x, y };
    }

    case 'region': {
      const rect = parseRectInput(obj['rect'], 'region');
      return { kind: 'region', rect };
    }

    case 'time': {
      if (obj['t'] === undefined || obj['t'] === null) {
        throw new PublishError(
          'local_comment_anchor_time_missing',
          'a time anchor requires a "t" timestamp.'
        );
      }
      const t = parseTimecode(obj['t'], 'start time (t)');
      let t_end: number | undefined;
      if (obj['t_end'] !== undefined && obj['t_end'] !== null) {
        t_end = parseTimecode(obj['t_end'], 'end time (t_end)');
        if (t_end <= t) {
          throw new PublishError(
            'local_comment_anchor_time_span_invalid',
            `the end time (${t_end}s) must be strictly after the start time (${t}s).`,
            { t, t_end }
          );
        }
      }
      let rect: AnchorRect | undefined;
      if (obj['rect'] !== undefined && obj['rect'] !== null) {
        rect = parseRectInput(obj['rect'], 'time');
      }
      return {
        kind: 'time',
        t,
        ...(t_end !== undefined ? { t_end } : {}),
        ...(rect !== undefined ? { rect } : {}),
      };
    }

    case 'page': {
      if (obj['page'] === undefined || obj['page'] === null) {
        throw new PublishError(
          'local_comment_anchor_page_missing',
          'a page anchor requires a "page" number.'
        );
      }
      const page = Number(obj['page']);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > COMMENT_ANCHOR_MAX_PAGE
      ) {
        throw new PublishError(
          'local_comment_anchor_page_out_of_range',
          `the page number (${obj['page']}) must be an integer between 1 and ${COMMENT_ANCHOR_MAX_PAGE}.`,
          { page: obj['page'], max_page: COMMENT_ANCHOR_MAX_PAGE }
        );
      }
      let rect: AnchorRect | undefined;
      if (obj['rect'] !== undefined && obj['rect'] !== null) {
        rect = parseRectInput(obj['rect'], 'page');
      }
      let exact: string | undefined;
      if (obj['exact'] !== undefined && obj['exact'] !== null) {
        if (
          typeof obj['exact'] !== 'string' ||
          obj['exact'].trim().length === 0
        ) {
          throw new PublishError(
            'local_comment_anchor_quote_empty',
            'the page exact quote must be a non-empty string.'
          );
        }
        const exactBytes = new TextEncoder().encode(obj['exact']).length;
        if (exactBytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
          throw new PublishError(
            'local_comment_anchor_quote_too_long',
            `the page quote is ${exactBytes} bytes of UTF-8 and the limit is ${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}.`,
            {
              quote_bytes: exactBytes,
              limit_bytes: COMMENT_ANCHOR_QUOTE_LIMIT_BYTES,
            }
          );
        }
        exact = obj['exact'];
      }
      return {
        kind: 'page',
        page,
        ...(rect !== undefined ? { rect } : {}),
        ...(exact !== undefined ? { exact } : {}),
      };
    }

    case 'otio':
      return normalizeOtioAnchor(obj);

    default:
      throw new PublishError(
        'local_comment_anchor_kind_unknown',
        `unknown anchor kind "${kind}". Expected one of: quote, text, pin, region, time, page, otio.`
      );
  }
}
