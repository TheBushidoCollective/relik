/**
 * The comment thread's core, with no DOM in it, so every rule below is
 * testable the way `viewer.ts` is.
 *
 * Four things shape all of it:
 *
 * 1. **The thread lives on the service origin, never in the render frame.**
 *    The frame is network denied, `default-src 'none'` with sandbox exactly
 *    `allow-scripts`, so it could not fetch a comment if it wanted to. The
 *    chrome around it can.
 * 2. **Bodies are ciphertext to the server.** It stores and returns them and
 *    cannot read them, so `GET` needs no authorization: anyone holding the
 *    link can already read the content, and the bodies are opaque.
 * 3. **The address is the identity and it is public to link holders.** That is
 *    `frame.md`'s reversal, and its price. The composer states it before a
 *    reader submits, not after.
 * 4. **The fragment never leaves the browser.** Not to request a magic link,
 *    not on the return path, not in a body or a query string. Everything the
 *    round trip needs is the relic id, which the server already has.
 */

import {
  COMMENT_BODY_LIMIT_BYTES,
  COMMENT_DISPLAY_NAME_LIMIT_BYTES,
  type CommentAnchor,
  CommentDecryptFailedError,
  type CommentPlaintext,
  decryptComment,
  encryptComment,
  MalformedCommentError,
} from '@relic/format';
import type { ViewerDeps } from './viewer.ts';

/**
 * Sealing and opening, bound to one relic's comment key.
 *
 * A pair of closures rather than the key itself, so nothing downstream of here
 * holds key material or has to remember which of the relic's two derived keys
 * it is looking at.
 */
export interface CommentCipher {
  seal(plaintext: CommentPlaintext): Promise<string>;
  open(ciphertext: string): Promise<CommentPlaintext>;
}

export function commentCipher(commentKey: CryptoKey): CommentCipher {
  return {
    seal: (plaintext) => encryptComment(commentKey, plaintext),
    open: (ciphertext) => decryptComment(commentKey, ciphertext),
  };
}

/** What the server stores per comment. The body is opaque to it. */
export interface CommentRecord {
  readonly comment_id: string;
  readonly author: string;
  readonly created_at: string;
  readonly ciphertext: string;
  readonly version?: number | null;
  /** Server-supplied clear routing hint. Never authoritative. */
  readonly addresses?: string | null;
  /**
   * When the author last replaced the body, or absent if never.
   *
   * The service holds one ciphertext per comment, so an edit overwrites and
   * no earlier text survives anywhere. What the reader is owed in exchange
   * is the fact that it happened, which is why this is stamped in the clear
   * beside the author and the creation time the service already holds.
   */
  readonly edited_at?: string | null;
  /** When the comment was marked resolved, and by which address. */
  readonly resolved_at?: string | null;
  readonly resolved_by?: string | null;
}

/**
 * A comment marked done, and by whom.
 *
 * Operator-visible, unlike everything else a comment carries. Resolution is
 * a state the service has to hold rather than a sentence somebody wrote: it
 * decides whether a republish is blocked and whether a mark goes quiet, and
 * both of those are answers the service gives before anything is decrypted.
 * So the operator learns that a comment was settled and by which address,
 * and still cannot read a word of what either party said.
 */
export interface Resolution {
  readonly at: string;
  readonly by: string;
}

/**
 * A comment as the reader sees it. Three states, and only the first has a body.
 *
 * Nothing is ever dropped. A thread that is shorter than it looks is a lie the
 * server could induce by storing one bad row, and the reader has no way to
 * notice it.
 *
 * `sealed` and `unreadable` are separate because they are different facts.
 * Sealed means there was a body and it would not open under this relic's
 * comment key. Unreadable means the row did not arrive in a shape this page
 * can read at all, so there may never have been a body, and calling that
 * sealed would be a guess about what went missing.
 */
export type CommentEntry =
  | {
      readonly kind: 'open';
      readonly id: string;
      readonly author: string;
      readonly createdAt: string;
      readonly body: string;
      readonly displayName: string | null;
      readonly anchor: CommentAnchor | null;
      readonly version?: number | null;
      /** The comment id this one answers, decrypted from the sealed copy only. */
      readonly addresses?: string | null;
      /** The clear routing hint supplied by the server, if any. Never authoritative. */
      readonly clearAddresses?: string | null;
      readonly addressed?: AddressedBy | null;
      /** Set once the author replaced the body. */
      readonly editedAt?: string | null;
      /** Set once somebody marked it done. */
      readonly resolution?: Resolution | null;
    }
  | {
      readonly kind: 'sealed';
      readonly id: string;
      readonly author: string;
      readonly createdAt: string;
      readonly version?: number | null;
      readonly clearAddresses?: string | null;
      readonly addressed?: AddressedBy | null;
      /** Set once the author replaced the body. */
      readonly editedAt?: string | null;
      /** Set once somebody marked it done. */
      readonly resolution?: Resolution | null;
    }
  | {
      /** Whatever the row did carry. Any of it may be absent. */
      readonly kind: 'unreadable';
      readonly id: string | null;
      readonly author: string | null;
      readonly createdAt: string | null;
      readonly version?: number | null;
      readonly clearAddresses?: string | null;
      readonly addressed?: AddressedBy | null;
      /** Set once the author replaced the body. */
      readonly editedAt?: string | null;
      /** Set once somebody marked it done. */
      readonly resolution?: Resolution | null;
    };

/** The literal author the contract uses for a publish-token comment. */
export const PUBLISHER_AUTHOR = 'publisher';

/** Bodies are capped before encryption, so the cap is on the plaintext. */
export const MAX_BODY_BYTES = COMMENT_BODY_LIMIT_BYTES;

/** A display name aliases the address. It is decoration, and it is bounded. */
export const MAX_DISPLAY_NAME_BYTES = COMMENT_DISPLAY_NAME_LIMIT_BYTES;

/**
 * Said at the display name field, and nowhere else.
 *
 * It used to ride along with the identity disclosure, which made a
 * three-sentence paragraph out of two facts and one aside. The aside
 * belongs next to the control it describes, where it is a short answer to
 * the question a reader has while looking at it.
 */
export const DISPLAY_NAME_NOTE = 'Shown beside your address, never instead.';

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The disclosure, in one place, because it appears at the composer and in the
 * thread's own copy and those two must not drift.
 *
 * It says what is true rather than what is comfortable. `frame.md` records
 * that the operator gains a participation graph and that magic-link delivery
 * processes the plaintext address, and a composer that implies otherwise
 * would be the overclaim `viewer.md` 6.3 already bans on the load screen.
 */
export const IDENTITY_DISCLOSURE =
  'Your address is shown with your comment and in emails to people ' +
  'following the relic, and Relic sees who commented on what. When someone ' +
  'comments or a new version is published, Relic emails you, with a link ' +
  'to stop.';

/** Said at the point of asking for an address, before one is typed. */
export const DELIVERY_DISCLOSURE =
  'Sending the link means handling your address in the clear. There is no ' +
  'other way to post it.';

export type SessionState =
  /** A valid session cookie, and the address it verified. */
  | { readonly kind: 'verified'; readonly email: string }
  /** No session. The composer asks for an address. */
  | { readonly kind: 'anonymous' }
  /**
   * The session could not be read at all. Distinct from anonymous on purpose:
   * showing "sign in" to somebody already verified is a worse guess than
   * saying the check failed, and the difference is actionable.
   */
  | { readonly kind: 'unknown' };

export interface Refusal {
  readonly code: string;
  readonly headline: string;
  readonly detail: string;
  /** Shown only where pressing it again could plausibly work. */
  readonly retryable: boolean;
}

/**
 * What a read of the thread came back with.
 *
 * No loading arm. Waiting is a DOM state rather than a data state, and the
 * only thing that could be said about it here is that nothing is known yet.
 */
export type ThreadState =
  | { readonly kind: 'ready'; readonly entries: readonly CommentEntry[] }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

export type PostResult =
  /** The address the server attributed it to, which the reader should see. */
  | { readonly kind: 'posted'; readonly author: string }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

/**
 * Strip the bidirectional formatting characters out of a label.
 *
 * A display name is chosen by whoever holds the link and rendered on the
 * origin that holds the fragment, so it is the same untrusted display text
 * `viewer.md` 1.9 rule 2 puts on the filename, and it gets the same
 * treatment: stripped rather than escaped, because a name has no legitimate
 * use for a right-to-left override and one in a label is how `alice` renders
 * as `bob`. The author is run through it too. The server verified the
 * mailbox, which says nothing about how the string draws.
 *
 * That is Trojan Source, CVE-2021-42574: characters that reorder what a
 * reader sees without changing a byte.
 */
export function plainLabel(text: string): string {
  return text.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '');
}

/** How much of a quote the chip shows before it abbreviates. */
export const MARK_QUOTE_DISPLAY_LIMIT = 60;

/**
 * What a chip or row says about a quote target.
 *
 * Quotes are bounded so a reader who selected three paragraphs gets a label
 * that fits in the chip rather than pushing the composer off the screen.
 */
export function quotedTargetLabel(quote: string): string {
  const plain = plainLabel(quote);
  const shown =
    plain.length > MARK_QUOTE_DISPLAY_LIMIT
      ? `${plain.slice(0, MARK_QUOTE_DISPLAY_LIMIT).trimEnd()}…`
      : plain;
  return `Commenting on "${shown}"`;
}

export type LinkRequestResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

/**
 * Maps a refusal code onto what the reader should be told.
 *
 * Every arm names the cause and what to do about it. The default arm carries
 * the code verbatim rather than flattening it into "something went wrong",
 * which is the same rule `viewer.md` 6.1 item 3 puts on a refused mint.
 */
export function commentRefusal(code: string): Refusal {
  switch (code) {
    case 'comment_rate_limited':
      return {
        code,
        headline: 'Too many comments from here just now',
        detail:
          'Relic limits how fast comments arrive, per relic and per address, ' +
          'because an unlimited comment box on a link anybody can hold is an ' +
          'abuse surface. Nothing was lost. Wait a moment and post again.',
        retryable: true,
      };
    case 'auth_rate_limited':
      return {
        code,
        headline: 'Too many link requests from here just now',
        detail:
          'The same limit covers verification, for the same reason. Check ' +
          'the mail already sent before asking again: an earlier link may ' +
          'still be good.',
        retryable: true,
      };
    case 'invalid_session':
      return {
        code,
        headline: 'This browser is not verified any more',
        detail:
          'Verification is a short-lived session rather than an account, so ' +
          'it lapses, and a verification link works once. Enter your ' +
          'address again and follow the new one.',
        retryable: false,
      };
    case 'invalid_comment':
      return {
        code,
        headline: 'The server would not take that comment',
        detail:
          `A comment holds up to ${MAX_BODY_BYTES} bytes of text and has to ` +
          'arrive as one sealed envelope. Nothing was posted.',
        retryable: false,
      };
    case 'body_too_large':
      return {
        code,
        headline: 'That comment is too long',
        detail:
          `A comment holds up to ${MAX_BODY_BYTES} bytes of text. Yours was ` +
          'longer. Shorten it and post again; nothing was sent, and nothing ' +
          'was encrypted.',
        retryable: false,
      };
    case 'comment_forbidden':
      return {
        code,
        headline: 'That comment is not yours to change',
        detail:
          'A comment is edited, resolved and removed by whoever wrote it. ' +
          'The publisher of a relic can resolve anything on it with the ' +
          'token they published with, and the operator can remove the relic ' +
          'entirely. Nothing else moves a comment.',
        retryable: false,
      };
    case 'comment_not_found':
      return {
        code,
        headline: 'That comment is already gone',
        detail: 'Somebody removed it, possibly in another tab.',
        retryable: false,
      };
    case 'nothing_to_change':
      return {
        code,
        headline: 'That change was empty',
        detail:
          'A change carries new text, a resolution, or both. An empty one ' +
          'is refused rather than stamped as an edit that altered nothing.',
        retryable: false,
      };
    case 'service_paused':
      return {
        code,
        headline: 'Comments are paused',
        detail:
          'The operator has stopped writes for now. The relic above is ' +
          'unaffected and still opens.',
        retryable: true,
      };
    case 'relic_removed':
      return {
        code,
        headline: 'This relic was taken down',
        detail:
          'Its comments went with it. A takedown covers every version and ' +
          'everything attached to them.',
        retryable: false,
      };
    case 'relic_not_found':
    case 'invalid_relic_id':
      return {
        code,
        headline: 'This relic does not exist',
        detail: 'There is nothing here to comment on.',
        retryable: false,
      };
    case 'network':
      return {
        code,
        headline: 'Comments could not be reached',
        detail:
          'The request did not complete. That is a network problem rather ' +
          'than a problem with this relic, and the content above is already ' +
          'decrypted and unaffected.',
        retryable: true,
      };
    default:
      return {
        code,
        headline: 'Comments were refused',
        detail:
          `The server refused with ${code}. It is stated rather than ` +
          'flattened, because a specific reason is worth more than an ' +
          'apology.',
        retryable: true,
      };
  }
}

/**
 * The thread's collection URL.
 *
 * One function for two call sites, because a read and a write that drifted
 * onto different paths would look like an empty thread rather than a bug, and
 * because the id is percent-encoded here rather than at each site.
 */
function commentsUrl(origin: string, relicId: string): string {
  return `${origin}/api/relics/${encodeURIComponent(relicId)}/comments`;
}

/** Reads `code` out of an `application/problem+json` body. */
async function refusalFrom(response: Response): Promise<Refusal> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A refusal with no parseable body is still a refusal.
    return commentRefusal(`http_${response.status}`);
  }
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = body.code;
    if (typeof code === 'string') return commentRefusal(code);
  }
  return commentRefusal(`http_${response.status}`);
}

/** One field off a row that failed the guard, kept only if it is a string. */
function stringField(value: unknown, name: string): string | null {
  if (typeof value !== 'object' || value === null || !(name in value)) {
    return null;
  }
  const held: unknown = Reflect.get(value, name);
  return typeof held === 'string' && held.length > 0 ? held : null;
}

/**
 * The resolution off a row, or null.
 *
 * Both halves are required together. A row claiming to be resolved by
 * nobody, or at no time, is a half-written state, and showing a comment as
 * settled on the strength of one field would be repeating a claim the row
 * does not actually make.
 */
function resolutionOf(record: unknown): Resolution | null {
  const at = stringField(record, 'resolved_at');
  const by = stringField(record, 'resolved_by');
  if (at === null || by === null) return null;
  return { at, by };
}

/**
 * A row this page cannot read, reported with whatever it did carry.
 *
 * It counts in the total, which is the point: the reader is told the thread
 * holds something they are not seeing rather than shown a shorter thread.
 */
function unreadableEntry(record: unknown): CommentEntry {
  const version =
    typeof record === 'object' &&
    record !== null &&
    'version' in record &&
    typeof (record as { version?: unknown }).version === 'number'
      ? (record as { version: number }).version
      : null;
  return {
    kind: 'unreadable',
    id: stringField(record, 'comment_id'),
    author: stringField(record, 'author'),
    createdAt: stringField(record, 'created_at'),
    version,
    clearAddresses: stringField(record, 'addresses'),
    editedAt: stringField(record, 'edited_at'),
    resolution: resolutionOf(record),
  };
}

/**
 * Whether one row off the wire is shaped like a comment.
 *
 * The server is not trusted to be well formed here. It cannot read a body, so
 * a malformed row is far likelier to be a version skew than an attack, and
 * either way a row missing its ciphertext must not become an entry claiming
 * to be sealed when there was nothing to open.
 */
function isCommentRecord(value: unknown): value is CommentRecord {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'comment_id' in value &&
    typeof value.comment_id === 'string' &&
    'author' in value &&
    typeof value.author === 'string' &&
    'created_at' in value &&
    typeof value.created_at === 'string' &&
    'ciphertext' in value &&
    typeof value.ciphertext === 'string'
  );
}

/**
 * The body of a magic-link request.
 *
 * Exported so a test can assert what it is: an address and a relic id, and
 * nothing else. The relic id is how the callback knows where to send the
 * reader back, and the server already has it on every request to this relic.
 * The fragment is not here and must never be, which is the one rule in this
 * file that would cost the reader the whole relic if it broke.
 */
export function authRequestBody(
  email: string,
  relicId: string
): { readonly email: string; readonly relic_id: string } {
  return { email, relic_id: relicId };
}

/**
 * Whether following a magic link in this tab would keep the key.
 *
 * Reading the fragment strips it from the address bar, so a tab that
 * navigates away and comes back has no key in its URL and depends entirely on
 * what this browser wrote down. Storage can be absent or refuse to write, and
 * when it has, the honest thing is to say so before the reader leaves rather
 * than to show them a missing-key screen afterwards.
 *
 * This reads the vault, it never writes: `load` already recorded the fragment
 * after the mint, so a mismatch means retention failed rather than that it
 * was never attempted.
 */
export function keySurvivesNavigation(
  relicId: string,
  fragment: string,
  deps: ViewerDeps
): boolean {
  return deps.keyVault.recall(relicId) === fragment;
}

/** Copy for the case where it does not. */
export const KEY_AT_RISK_NOTE =
  'This browser is not keeping the key for this relic, so following the ' +
  'link in this tab would lose it. Open the link in a new tab and come ' +
  'back to this one, which still holds the key in memory.';

export async function readSession(deps: ViewerDeps): Promise<SessionState> {
  try {
    const response = await deps.fetch(`${deps.serviceOrigin}/api/auth/session`);
    // Always 200 with an `email` that is either a string or null, never a
    // 401: asking whether this browser is verified is not itself a
    // privileged question, and a 401 here would be indistinguishable from a
    // session that had just lapsed.
    if (!response.ok) return { kind: 'unknown' };
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('email' in body)) {
      return { kind: 'unknown' };
    }
    return typeof body.email === 'string' && body.email.length > 0
      ? { kind: 'verified', email: body.email }
      : { kind: 'anonymous' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Ask for a magic link.
 *
 * The endpoint answers 202 whether or not anything was sent, so the address
 * form cannot be used to find out who has an account. That property is the
 * server's, and it is only worth anything if this copy does not undo it, so
 * nothing here confirms that an address exists.
 */
export async function requestMagicLink(
  relicId: string,
  email: string,
  deps: ViewerDeps
): Promise<LinkRequestResult> {
  try {
    const response = await deps.fetch(
      `${deps.serviceOrigin}/api/auth/request`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authRequestBody(email, relicId)),
      }
    );
    if (response.status === 202) return { kind: 'sent' };
    return { kind: 'refused', refusal: await refusalFrom(response) };
  } catch {
    return { kind: 'refused', refusal: commentRefusal('network') };
  }
}

/** A row that had a body and would not open. Shown, never dropped. */
function sealedEntry(record: CommentRecord): CommentEntry {
  return {
    kind: 'sealed',
    id: record.comment_id,
    author: record.author,
    createdAt: record.created_at,
    version: typeof record.version === 'number' ? record.version : null,
    clearAddresses: stringField(record, 'addresses'),
    editedAt: stringField(record, 'edited_at'),
    resolution: resolutionOf(record),
  };
}

/** Turns one stored row into an entry, sealed rather than dropped on failure. */
export async function openEntry(
  record: CommentRecord,
  cipher: CommentCipher
): Promise<CommentEntry> {
  const version = typeof record.version === 'number' ? record.version : null;
  const clearAddresses = stringField(record, 'addresses');
  const editedAt = stringField(record, 'edited_at');
  const resolution = resolutionOf(record);
  try {
    const plaintext = await cipher.open(record.ciphertext);
    return {
      kind: 'open',
      id: record.comment_id,
      author: record.author,
      createdAt: record.created_at,
      body: plaintext.body,
      displayName:
        plaintext.display_name !== null && plaintext.display_name.length > 0
          ? plaintext.display_name
          : null,
      anchor: plaintext.anchor ?? null,
      version,
      addresses: plaintext.addresses ?? null,
      clearAddresses,
      editedAt,
      resolution,
    };
  } catch (error) {
    // `format.md` 3.13 gives a decrypt failure no cause, and a malformed
    // envelope is the other way one row can fail to open. Both are shown as
    // sealed. Anything else is a bug here rather than a bad row, and
    // rethrowing keeps it from being disguised as one.
    if (
      !(error instanceof CommentDecryptFailedError) &&
      !(error instanceof MalformedCommentError)
    ) {
      throw error;
    }
    return sealedEntry(record);
  }
}

export async function loadThread(
  relicId: string,
  deps: ViewerDeps,
  cipher: CommentCipher
): Promise<ThreadState> {
  let response: Response;
  try {
    response = await deps.fetch(commentsUrl(deps.serviceOrigin, relicId));
  } catch {
    return { kind: 'refused', refusal: commentRefusal('network') };
  }
  if (!response.ok) {
    return { kind: 'refused', refusal: await refusalFrom(response) };
  }
  let records: unknown;
  try {
    records = await response.json();
  } catch {
    return { kind: 'refused', refusal: commentRefusal('malformed_thread') };
  }
  if (!Array.isArray(records)) {
    return { kind: 'refused', refusal: commentRefusal('malformed_thread') };
  }
  const entries: CommentEntry[] = [];
  for (const record of records) {
    // A row that is not shaped like a comment is reported rather than
    // dropped, and reported as its own state rather than as sealed. Sealed
    // means there was a body and it would not open; a row with no ciphertext
    // may never have had one, and guessing which is worse than saying so.
    // Dropping it would be worst of all: the reader would see a thread that
    // is shorter than it is and have no way to notice.
    if (!isCommentRecord(record)) {
      entries.push(unreadableEntry(record));
      continue;
    }
    try {
      entries.push(await openEntry(record, cipher));
    } catch {
      // One sealed row that throws while opening must not hide the others.
      // A malformed anchor used to throw TypeError here and abort the load.
      entries.push(sealedEntry(record));
    }
  }
  return { kind: 'ready', entries };
}

/**
 * What is wrong with a draft, before anything is encrypted.
 *
 * Shared by posting and editing rather than written twice, because two
 * copies of a cap drift and the reader meets the difference as one path
 * refusing what the other accepted.
 */
function draftRefusal(draft: CommentPlaintext): Refusal | undefined {
  if (draft.body.trim().length === 0) return commentRefusal('empty_body');
  if (utf8Bytes(draft.body) > MAX_BODY_BYTES) {
    return commentRefusal('body_too_large');
  }
  if (
    draft.display_name !== null &&
    utf8Bytes(draft.display_name) > MAX_DISPLAY_NAME_BYTES
  ) {
    return commentRefusal('display_name_too_long');
  }
  return undefined;
}

/**
 * Post one comment.
 *
 * The plaintext is capped here, before encryption, because the cap is on what
 * a reader wrote rather than on what the envelope weighs. The server enforces
 * its own; refusing locally first means a reader who overran it is told
 * immediately instead of after a round trip.
 */
export async function postComment(
  relicId: string,
  draft: CommentPlaintext,
  deps: ViewerDeps,
  cipher: CommentCipher,
  version?: number
): Promise<PostResult> {
  const invalid = draftRefusal(draft);
  if (invalid !== undefined) return { kind: 'refused', refusal: invalid };

  const ciphertext = await cipher.seal(draft);
  let response: Response;
  try {
    response = await deps.fetch(commentsUrl(deps.serviceOrigin, relicId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ciphertext,
        ...(typeof version === 'number' ? { version } : {}),
        ...(typeof draft.addresses === 'string' && draft.addresses.length > 0
          ? { addresses: draft.addresses }
          : {}),
      }),
    });
  } catch {
    return { kind: 'refused', refusal: commentRefusal('network') };
  }
  if (!response.ok) {
    return { kind: 'refused', refusal: await refusalFrom(response) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'refused', refusal: commentRefusal('malformed_thread') };
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('author' in body) ||
    typeof body.author !== 'string'
  ) {
    return { kind: 'refused', refusal: commentRefusal('malformed_thread') };
  }
  // The caller reloads the thread rather than splicing this comment in
  // locally. Ordering and timestamps are the server's, and inventing a
  // `created_at` here would put a number on the page that no row holds.
  return { kind: 'posted', author: body.author };
}

/** One comment's own URL, for the writes that address a single row. */
function commentUrl(
  origin: string,
  relicId: string,
  commentId: string
): string {
  return `${commentsUrl(origin, relicId)}/${encodeURIComponent(commentId)}`;
}

export type EditResult =
  | { readonly kind: 'edited' }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

/**
 * Replace the text of a comment already posted.
 *
 * The whole plaintext is re-sealed, so the caller hands back the anchor it
 * already had: an edit changes what a remark says and never where it points.
 * Moving a mark under an existing conversation would leave every reply
 * answering something the reader can no longer see.
 *
 * There is no history. The service holds one ciphertext per comment and this
 * overwrites it, which is why the row carries `edited_at` and the thread
 * says so: the honest thing on offer is not the old text, it is the fact
 * that the text on screen is not the text that was posted.
 */
export async function editComment(
  relicId: string,
  commentId: string,
  draft: CommentPlaintext,
  deps: ViewerDeps,
  cipher: CommentCipher
): Promise<EditResult> {
  const invalid = draftRefusal(draft);
  if (invalid !== undefined) return { kind: 'refused', refusal: invalid };

  const ciphertext = await cipher.seal(draft);
  let response: Response;
  try {
    response = await deps.fetch(
      commentUrl(deps.serviceOrigin, relicId, commentId),
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
      }
    );
  } catch {
    return { kind: 'refused', refusal: commentRefusal('network') };
  }
  if (!response.ok) {
    return { kind: 'refused', refusal: await refusalFrom(response) };
  }
  return { kind: 'edited' };
}

export type ResolveResult =
  | { readonly kind: 'changed' }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

/**
 * Mark a comment settled, or open it again.
 *
 * Unlike the body, this is not encrypted, and it cannot be: it decides
 * whether a republish is blocked and the service answers that before any
 * key exists on its side. The disclosure is the price, and it is stated at
 * the control rather than buried here.
 */
export async function setCommentResolved(
  relicId: string,
  commentId: string,
  resolved: boolean,
  deps: ViewerDeps
): Promise<ResolveResult> {
  let response: Response;
  try {
    response = await deps.fetch(
      commentUrl(deps.serviceOrigin, relicId, commentId),
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolved }),
      }
    );
  } catch {
    return { kind: 'refused', refusal: commentRefusal('network') };
  }
  if (!response.ok) {
    return { kind: 'refused', refusal: await refusalFrom(response) };
  }
  return { kind: 'changed' };
}

/**
 * Whether this reader may replace this comment's text.
 *
 * The page's copy of the service's rule, and it decides only whether the
 * control is offered. The service decides whether the write lands. Offering
 * it to everybody would not make an edit possible, it would make a refusal
 * surprising, and a reader who cannot act on a button has been told
 * something untrue about their own standing.
 *
 * A sealed comment is excluded because there is nothing to edit: this page
 * cannot open the text, so it cannot hand back a sealed copy of it either.
 */
export function canEditComment(
  entry: CommentEntry,
  session: SessionState
): boolean {
  if (entry.kind !== 'open') return false;
  if (session.kind !== 'verified') return false;
  return entry.author === session.email;
}

/**
 * Whether this reader may settle this comment.
 *
 * The same authorship rule, and deliberately not a publisher rule. The
 * service does let a publish token resolve anything on its own relic, but a
 * publish token lives on the machine that published and never in a browser,
 * so a page cannot hold one and must not pretend otherwise. The publisher's
 * route is their agent.
 *
 * A sealed comment is included: settling a remark you wrote does not require
 * this browser to be able to read it back.
 */
export function canResolveComment(
  entry: CommentEntry,
  session: SessionState
): boolean {
  if (entry.kind === 'unreadable') return false;
  if (session.kind !== 'verified') return false;
  return entry.author === session.email;
}

/** Said beside a comment whose text was replaced after it was posted. */
export const EDITED_LABEL = 'edited';

/** Said on a comment somebody marked settled. */
export function resolvedLabel(resolution: Resolution): string {
  return `Resolved by ${plainLabel(resolution.by)}`;
}

/**
 * The disclosure carried by the resolve control.
 *
 * Every other thing a comment holds is sealed, so the one that is not has to
 * say so where it is used rather than in a document nobody opens.
 */
export const RESOLUTION_DISCLOSURE =
  'Resolving is not encrypted. Relic records who settled it, never what it ' +
  'says.';

/**
 * How a comment's time reads.
 *
 * Absolute rather than relative. A relic is a catalogued object and its
 * comments are part of the record, so "3 hours ago" on a page somebody opens
 * next month is worse than useless. An unparseable timestamp shows verbatim
 * rather than as `Invalid Date`.
 */
export function commentTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The heading, which is also the taskbar's count. */
export function threadCountLabel(count: number): string {
  if (count === 0) return 'No comments';
  return count === 1 ? '1 comment' : `${count} comments`;
}

/**
 * Wrap the first exact occurrence of `quote` in `root` with a mark.
 *
 * Exact rather than fuzzy: a shifted paragraph is shown as detached in the
 * tray instead of highlighting the wrong sentence. Returns whether it found
 * the quote.
 */
export function wrapTextQuote(
  root: ParentNode,
  quote: string,
  id: string
): boolean {
  if (quote.length === 0) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const text = node as Text;
    const index = text.data.indexOf(quote);
    if (index !== -1) {
      const end = index + quote.length;
      const target =
        index === 0 && end === text.data.length ? text : text.splitText(index);
      if (target.data.length > quote.length) target.splitText(quote.length);
      const mark = document.createElement('mark');
      mark.className = 'relic-text-mark';
      mark.dataset.commentId = id;
      target.parentNode?.insertBefore(mark, target);
      mark.appendChild(target);
      return true;
    }
    node = walker.nextNode();
  }
  return false;
}

/** Remove marks this page painted, leaving the document text in place. */
export function unwrapTextQuotes(root: ParentNode): void {
  for (const mark of [...root.querySelectorAll('mark.relic-text-mark')]) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

export interface QuoteContext {
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

/**
 * Elements whose text is not the document's content.
 *
 * Overlays and controls this page added, script and style, and anything
 * hidden. `pre.raw` is the Markdown source the view keeps beside the rendered
 * prose for the source toggle: including it puts the whole document into the
 * flow twice, which gives every phrase a second candidate and lets a mark
 * resolve into an element the reader cannot see.
 *
 * `mark.relic-text-mark` is deliberately not here. See below.
 */
const NON_CONTENT =
  '.comment-pins, .comment-region, .mark-bubble, .mark-hint,' +
  ' .mark-quote-action, .popover, script, style, [hidden], pre.raw';

/**
 * The document's content text, in order, as the reader sees it.
 *
 * **A mark's text is content.** This used to skip text inside
 * `mark.relic-text-mark`, so the flow changed shape depending on which
 * comments happened to be painted, and capture and resolution read different
 * documents: capture runs with marks on the page, resolution runs immediately
 * after `unwrapTextQuotes` has removed them.
 *
 * That asymmetry is the defect this function exists to remove. A reader who
 * had already commented, then selected text inside their own mark, produced a
 * selection whose container was not in the flow at all; capture fell back to
 * the first occurrence it could still see, which was in another paragraph,
 * and the new comment anchored there. The chip named the right words and the
 * mark landed beside the previous comment.
 *
 * Nesting was the reason for the old rule and it is handled where it belongs:
 * `paintMarks` unwraps every mark before it paints, so resolution never sees
 * one, and `wrapTextQuoteWithContext` skips a node already inside a mark so a
 * provisional mark cannot nest inside a posted one painted in the same pass.
 */
export function walkContentTextNodes(root: ParentNode): Text[] {
  const nodes: Text[] = [];
  if (
    typeof document === 'undefined' ||
    typeof document.createTreeWalker !== 'function'
  ) {
    return nodes;
  }

  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return (node as Text).parentElement?.closest(NON_CONTENT)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let curr = walker.nextNode(); curr !== null; curr = walker.nextNode()) {
    nodes.push(curr as Text);
  }
  return nodes;
}

/**
 * Wrap the occurrence of `quote` in `root` that best matches surrounding context.
 *
 * This supports quotes spanning inline elements (such as `the <em>third</em> paragraph`)
 * by walking text nodes, finding the best-scoring candidate occurrence across the
 * concatenated content flow, and wrapping the overlapping text slices in each text node
 * with `<mark class="relic-text-mark" data-comment-id="${id}">`.
 *
 * All occurrences of `exact` are candidates. Each is scored by how much of `prefix`
 * matches immediately before it and `suffix` immediately after. A unique best match
 * wins; a tie falls back to the first candidate, deterministically.
 *
 * Returns false when the quote is not present on the page or when `exact` is empty.
 * Never matches inside an existing `mark` to avoid nesting.
 */
export function wrapTextQuoteWithContext(
  root: ParentNode,
  quote: QuoteContext,
  id: string
): boolean {
  if (quote.exact.length === 0) return false;

  const textNodes = walkContentTextNodes(root);
  if (textNodes.length === 0) return false;

  interface NodeSpan {
    readonly node: Text;
    readonly start: number;
    readonly end: number;
  }

  const spans: NodeSpan[] = [];
  let fullText = '';
  for (const node of textNodes) {
    const start = fullText.length;
    fullText += node.data;
    spans.push({ node, start, end: fullText.length });
  }

  const exact = quote.exact;
  const candidates: number[] = [];
  let idx = fullText.indexOf(exact);
  while (idx !== -1) {
    candidates.push(idx);
    idx = fullText.indexOf(exact, idx + 1);
  }

  const firstCand = candidates[0];
  if (firstCand === undefined) return false;

  const prefix = quote.prefix ?? '';
  const suffix = quote.suffix ?? '';

  let bestIndex = firstCand;
  let bestScore = -1;

  for (const candStart of candidates) {
    const candEnd = candStart + exact.length;

    let prefixScore = 0;
    if (prefix.length > 0) {
      for (let k = 1; k <= prefix.length && k <= candStart; k++) {
        if (fullText[candStart - k] === prefix[prefix.length - k]) {
          prefixScore++;
        } else {
          break;
        }
      }
    }

    let suffixScore = 0;
    if (suffix.length > 0) {
      for (let k = 0; k < suffix.length && candEnd + k < fullText.length; k++) {
        if (fullText[candEnd + k] === suffix[k]) {
          suffixScore++;
        } else {
          break;
        }
      }
    }

    const score = prefixScore + suffixScore;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = candStart;
    }
  }

  const matchStart = bestIndex;
  const matchEnd = matchStart + exact.length;

  let markedAny = false;
  for (const span of spans) {
    if (span.end <= matchStart || span.start >= matchEnd) {
      continue;
    }

    // Overlap is painted, not skipped. Two readers commenting on the same
    // words is an ordinary thing, and a comment whose mark was silently
    // dropped reads to the reader as a comment pointing at nothing while the
    // text sits in front of them.
    //
    // Repaint cannot accumulate nesting, because `paintMarks` unwraps every
    // mark before it paints, so the only marks present during a pass are the
    // ones this pass put there.

    const textNode = span.node;
    const localStart = Math.max(0, matchStart - span.start);
    const localEnd = Math.min(textNode.data.length, matchEnd - span.start);
    if (localStart >= localEnd) continue;

    let target: Text;
    if (localStart === 0 && localEnd === textNode.data.length) {
      target = textNode;
    } else if (localStart === 0) {
      target = textNode;
      target.splitText(localEnd);
    } else {
      target = textNode.splitText(localStart);
      const targetLength = localEnd - localStart;
      if (target.data.length > targetLength) {
        target.splitText(targetLength);
      }
    }

    const mark = document.createElement('mark');
    mark.className = 'relic-text-mark';
    mark.dataset.commentId = id;
    if (id === 'pending:target') {
      mark.classList.add('is-pending');
    }
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
    markedAny = true;
  }

  return markedAny;
}

export interface AddressedBy {
  readonly kind: 'update' | 'reply';
  readonly version: number | null;
}

/**
 * Determines whether an answer is an update or a reply.
 *
 * An update is an answer from the publisher whose version is newer than the
 * target comment or where the target comment predates versioning. All other
 * answers are replies.
 */
export function answerKind(
  target: CommentEntry | undefined,
  answering: CommentEntry
): 'update' | 'reply' {
  if (answering.author === PUBLISHER_AUTHOR) {
    if (
      target !== undefined &&
      target.version !== null &&
      target.version !== undefined &&
      answering.version !== null &&
      answering.version !== undefined
    ) {
      return answering.version > target.version ? 'update' : 'reply';
    }
    return 'update';
  }
  return 'reply';
}

export function addressedBadgeLabel(addressed: AddressedBy): string {
  if (addressed.version !== null && addressed.version !== undefined) {
    return `Addressed by ${addressed.kind} in version ${addressed.version}`;
  }
  return `Addressed by ${addressed.kind}`;
}

/**
 * Resolves which comments in a thread have been answered.
 *
 * The sealed copy is the only authoritative source. The clear copy supplied
 * by the server is an operator-visible routing hint and must never be what
 * decides whether a remark is addressed.
 */
export function resolveAddressedMap(
  entries: readonly CommentEntry[]
): Map<string, AddressedBy> {
  const map = new Map<string, AddressedBy>();
  const idToEntry = new Map<string, CommentEntry>();
  for (const entry of entries) {
    if (entry.id !== null) {
      idToEntry.set(entry.id, entry);
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'open') continue;
    // Authoritative sealed pointer only:
    const targetId = entry.addresses;
    if (typeof targetId !== 'string' || targetId.length === 0) continue;

    const target = idToEntry.get(targetId);
    const kind = answerKind(target, entry);
    const version = typeof entry.version === 'number' ? entry.version : null;
    const candidate: AddressedBy = { kind, version };

    const existing = map.get(targetId);
    if (existing === undefined) {
      map.set(targetId, candidate);
    } else {
      if (existing.kind !== 'update' && candidate.kind === 'update') {
        map.set(targetId, candidate);
      } else if (
        existing.kind === candidate.kind &&
        (candidate.version ?? 0) >= (existing.version ?? 0)
      ) {
        map.set(targetId, candidate);
      }
    }
  }

  return map;
}

/**
 * Said on a remark whose sealed address loops back onto itself.
 *
 * The loop is broken for display. Both remarks stay visible, once, with this
 * note, instead of disappearing because neither has a root.
 */
export const THREAD_CYCLE_RECOVERY =
  'This remark points at another remark that points back, so each one is ' +
  'shown once instead of hidden in the loop.';

/**
 * Said on a remark whose parent is in the thread but not shown.
 *
 * A reply whose own target is missing stays omitted, so a version filter
 * does not paint it as a new top-level comment. A reply to that omitted row
 * would otherwise vanish with it. This note is why that reply is still here.
 */
export const THREAD_ORPHAN_RECOVERY =
  'This remark answers one that is not shown in this thread, so it is ' +
  'shown on its own instead of dropped.';

export interface ThreadRecovery {
  readonly kind: 'cycle' | 'orphan';
  readonly detail: string;
  /** Sealed comment id this remark addresses. Never the server's clear copy. */
  readonly addresses: string;
}

export interface CommentNode {
  readonly entry: CommentEntry;
  readonly replies: CommentNode[];
  readonly recovery?: ThreadRecovery;
}

interface MutableCommentNode {
  entry: CommentEntry;
  replies: CommentNode[];
  recovery?: ThreadRecovery;
}

/**
 * The sealed address, or null when this row does not answer another.
 *
 * The server's clear `addresses` is a routing hint. It is never read here.
 */
function sealedTarget(entry: CommentEntry): string | null {
  if (entry.kind !== 'open') return null;
  const target = entry.addresses;
  if (typeof target !== 'string' || target.length === 0) return null;
  return target;
}

function cycleMembers(
  parentOf: ReadonlyMap<string, string | null>
): Set<string> {
  const cycles = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, stack: readonly string[]): void => {
    if (cycles.has(id) || state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const at = stack.indexOf(id);
      for (const member of stack.slice(at)) cycles.add(member);
      return;
    }
    state.set(id, 'visiting');
    const parent = parentOf.get(id);
    if (typeof parent === 'string') walk(parent, stack.concat(id));
    state.set(id, 'done');
  };
  for (const id of parentOf.keys()) walk(id, []);
  return cycles;
}

function recovery(kind: 'cycle' | 'orphan', addresses: string): ThreadRecovery {
  return {
    kind,
    detail: kind === 'cycle' ? THREAD_CYCLE_RECOVERY : THREAD_ORPHAN_RECOVERY,
    addresses,
  };
}

/**
 * Structures flat comments into top-level comments and nested replies.
 *
 * The sealed pointer is the only parent. A reply whose target is missing or
 * filtered out of this set stays omitted, so it does not appear as a new
 * root on a version that does not hold its parent. A loop, or a reply to a
 * row that omission hid, is shown once with recovery context instead of
 * being dropped or walked forever.
 */
export function threadEntries(entries: readonly CommentEntry[]): CommentNode[] {
  const nodesById = new Map<string, MutableCommentNode>();
  for (const entry of entries) {
    if (entry.id !== null) {
      nodesById.set(entry.id, { entry, replies: [] });
    }
  }

  const parentOf = new Map<string, string | null>();
  for (const [id, node] of nodesById) {
    const target = sealedTarget(node.entry);
    if (target === null) continue;
    parentOf.set(id, nodesById.has(target) ? target : null);
  }
  const cycles = cycleMembers(parentOf);

  const roots: CommentNode[] = [];
  const placed = new Set<string>();
  for (const entry of entries) {
    if (entry.id === null) {
      roots.push({ entry, replies: [] });
      continue;
    }
    const node = nodesById.get(entry.id);
    if (node === undefined || node.entry !== entry || placed.has(entry.id)) {
      continue;
    }
    placed.add(entry.id);
    const parent = parentOf.get(entry.id);
    if (cycles.has(entry.id)) {
      const addresses =
        typeof parent === 'string'
          ? parent
          : sealedTarget(entry) ?? entry.id;
      node.recovery = recovery('cycle', addresses);
      roots.push(node);
      continue;
    }
    if (parent === null) continue;
    if (parent === undefined) {
      roots.push(node);
      continue;
    }
    const parentNode = nodesById.get(parent);
    const parentOmitted =
      parentOf.get(parent) === null && !cycles.has(parent);
    if (parentNode === undefined || parentOmitted) {
      node.recovery = recovery('orphan', parent);
      roots.push(node);
      continue;
    }
    parentNode.replies.push(node);
  }

  return roots;
}

export function collectDisplayedEntries(
  nodes: readonly CommentNode[]
): CommentEntry[] {
  const out: CommentEntry[] = [];
  const seen = new Set<CommentEntry>();
  const walk = (list: readonly CommentNode[]): void => {
    for (const node of list) {
      if (seen.has(node.entry)) continue;
      seen.add(node.entry);
      out.push(node.entry);
      if (node.replies.length > 0) walk(node.replies);
    }
  };
  walk(nodes);
  return out;
}
