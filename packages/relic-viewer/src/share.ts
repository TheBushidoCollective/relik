/**
 * Sharing a relic from the viewer, with no DOM in it, so every rule below is
 * testable the way `comments.ts` is.
 *
 * Any reader holding the link and its key can add people to a relic's change
 * emails. Four things shape all of it:
 *
 * 1. **The key never leaves this browser.** The service cannot check that a
 *    reader holds the key, because it never sees it. What it checks is the
 *    share proof (`spec/format.md` 3.14): a value derived from the key under
 *    its own label, whose hash the publisher's client registered. The proof
 *    decrypts nothing.
 * 2. **The reader is signed in.** The same `relic_session` cookie the comment
 *    writes use, so one reader can be rate limited. The service keeps who
 *    shared no longer than that limit needs; the addresses are stored without
 *    the sharer's.
 * 3. **Relic never sends the share email.** It carries the whole link, key
 *    included, so it is composed here, by the same `composeShareEmail` the
 *    publishing client uses, and leaves from the reader's own mail.
 * 4. **The service learns the addresses and stores them in the clear**, to
 *    email them when a new version lands. The panel says so before anything is
 *    typed, which is where `viewer.md` puts a disclosure.
 */

import {
  composeShareEmail,
  deriveShareProof,
  encodeKey,
  type ShareEmail,
  parseRelicId,
} from '@relic/format';
import { commentRefusal, type Refusal } from './comments.ts';
import type { ViewerDeps } from './viewer.ts';

/** The service's `shareMaxPerCall`. A longer list is refused before sending. */
export const SHARE_MAX_PER_CALL = 20;

/** Said at the point of sharing, before an address is typed. */
export const SHARE_FACT_SENDING =
  'Relic never sends this email. You send it from your own mail, because ' +
  'the link in it carries the key.';

/** The other half of the disclosure: what the service keeps, and why. */
export const SHARE_FACT_STORING =
  'Relic stores the addresses you add in the clear, linked to this relic, ' +
  'to email them when someone comments or a new version is published. Each of those emails has ' +
  'a link to stop them.';

/** Why sharing asks for the comment sign-in, said where it asks. */
export const SHARE_SIGN_IN_REASON =
  'Sharing asks for the same verified address as commenting, so Relic can ' +
  'limit how many people one reader adds. Your address is not stored with ' +
  'the ones you add.';

/** Said while the session is being read, before anything can be offered. */
export const SHARE_CHECKING_NOTE =
  'Checking whether this browser is verified. Sharing uses the same sign-in ' +
  'as comments.';

/** The wait, with what is actually happening in it. */
export const SHARE_PROVING_NOTE =
  'Deriving a share proof from the key in your link and adding the ' +
  'addresses. The key stays in this browser.';

/** Said beside the composed email, which is the one place the key travels. */
export const SHARE_KEY_WARNING =
  'The link in this message carries the key. Anyone who gets it can read ' +
  'the relic, so send it only to the people above.';

/** The toast after a successful copy, for the same reason Copy link has one. */
export const SHARE_COPIED_NOTE = 'Message copied. It contains the key.';

/**
 * The service's own test (`looksLikeEmail` in the server), so an entry this
 * page accepts is one the service accepts too. A looser check here would turn
 * a typo into a round trip and a 400.
 */
export function looksLikeEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

export interface ParsedAddresses {
  /** Entries that pass the check, first spelling kept, in typed order. */
  readonly addresses: readonly string[];
  /** Entries that do not, in typed order. */
  readonly invalid: readonly string[];
}

/**
 * Reads what a reader typed or pasted into a list of addresses.
 *
 * Commas, semicolons, new lines and spaces all separate, because that is what
 * address fields copied out of mail clients contain, and `Name <address>`
 * contributes its address. A repeat, in any case, counts once: the service
 * would fold it anyway, and counting it twice here would refuse a list the
 * service would take.
 */
export function parseAddresses(text: string): ParsedAddresses {
  const entries: string[] = [];
  for (const chunk of text.split(/[,;\n]+/)) {
    const angled = /<([^<>]*)>/.exec(chunk);
    if (angled !== null) {
      const inner = (angled[1] ?? '').trim();
      if (inner.length > 0) entries.push(inner);
      continue;
    }
    for (const part of chunk.trim().split(/\s+/)) {
      if (part.length > 0) entries.push(part);
    }
  }
  const seen = new Set<string>();
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const folded = entry.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (looksLikeEmail(entry)) addresses.push(entry);
    else invalid.push(entry);
  }
  return { addresses, invalid };
}

/** How many distinct entries a parse holds, valid or not. */
export function addressCount(parsed: ParsedAddresses): number {
  return parsed.addresses.length + parsed.invalid.length;
}

/**
 * What is wrong with a list before it is sent, or `undefined`.
 *
 * `final` is the press of the button: an empty field is only a problem then,
 * never while somebody is still typing into it.
 */
export function addressProblem(
  parsed: ParsedAddresses,
  final: boolean
): string | undefined {
  const count = addressCount(parsed);
  if (parsed.invalid.length > 0) {
    const one = parsed.invalid.length === 1;
    return (
      `${one ? 'This is not an email address' : 'These are not email addresses'}: ` +
      `${parsed.invalid.join(', ')}. Fix or remove ${one ? 'it' : 'them'}; ` +
      'nothing has been sent.'
    );
  }
  if (count > SHARE_MAX_PER_CALL) {
    return (
      `That is ${count} addresses. One share takes at most ` +
      `${SHARE_MAX_PER_CALL}, so share the rest in a second round.`
    );
  }
  if (final && count === 0) return 'Add at least one address.';
  return undefined;
}

/** The problem-detail extensions a share refusal can carry. */
export interface ShareProblemExtensions {
  readonly retry_after_seconds?: number;
  readonly share_limit?: number;
  readonly shared_count?: number;
  readonly share_max_per_call?: number;
}

const SAFE_RETRY =
  'Trying again is safe: an address already on the list is not added twice.';

function aboutMinutes(seconds: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((seconds ?? 3600) / 60));
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/**
 * Maps a refusal from the share endpoint onto what the reader should be told.
 *
 * Every arm says whether anything was added, because a reader who pressed a
 * button that touches a mailing list wants that answer first. The default arm
 * carries the code verbatim rather than flattening it into "something went
 * wrong", which is the rule `viewer.md` 6.1 item 3 puts on a refused mint.
 */
export function shareRefusal(
  code: string,
  extensions: ShareProblemExtensions = {}
): Refusal {
  switch (code) {
    case 'share_unavailable':
      return {
        code,
        headline: 'Sharing is not turned on for this relic',
        detail:
          'This relic was published before sharing existed. Its publisher ' +
          'can republish it to turn sharing on. Until then you can copy the ' +
          'link and send it yourself, but Relic will not email those people ' +
          'about new comments or versions. Nothing was added.',
        retryable: false,
      };
    case 'invalid_share_proof':
      return {
        code,
        headline: 'Relic could not confirm this link\u2019s key',
        detail:
          'Sharing sends a value derived from the key in your link, and it ' +
          'does not match the one this relic\u2019s publisher registered. ' +
          'Nothing was added. Republishing registers it again, so this one is ' +
          'for the publisher.',
        retryable: false,
      };
    case 'share_rate_limited':
      return {
        code,
        headline: 'Too many shares from here just now',
        detail:
          'Relic limits how many addresses one reader and one network can ' +
          'add in an hour, because each one joins a mailing list. Nothing ' +
          `was added. Try again in about ${aboutMinutes(extensions.retry_after_seconds)}.`,
        // The wait is the answer. A Try again beside it would only be
        // refused again, and the form's own button is still there for later.
        retryable: false,
      };
    case 'share_limit_reached': {
      const limit = extensions.share_limit;
      const count = extensions.shared_count;
      let detail =
        'It holds as many shared addresses as Relic allows. Nothing was ' +
        'added. The people on the list still get emails about new comments and versions.';
      if (limit !== undefined && count !== undefined) {
        detail =
          count >= limit
            ? `It already holds all ${limit} shared addresses Relic allows. ` +
              'Nothing was added. The people on the list still get emails ' +
              'about new comments and versions, and you can still copy the link and send it yourself.'
            : `It holds ${count} of the ${limit} shared addresses Relic ` +
              'allows, and these would take it past that. Nothing was added. ' +
              'Remove some and try again; the people already on the list ' +
              'still get emails about new comments and versions.';
      }
      return {
        code,
        headline: 'This relic\u2019s share list is full',
        detail,
        retryable: false,
      };
    }
    case 'invalid_share':
      return {
        code,
        headline: 'Relic would not take that list',
        detail:
          'Each entry has to be one email address, and one share takes at ' +
          `most ${extensions.share_max_per_call ?? SHARE_MAX_PER_CALL}. ` +
          'Nothing was added.',
        retryable: false,
      };
    case 'invalid_session':
      // The comment path's copy, because it is the comment path's session.
      return commentRefusal(code);
    case 'service_paused':
      return {
        code,
        headline: 'Sharing is paused',
        detail:
          'The operator has stopped writes for now. The relic is unaffected ' +
          'and still opens. Nothing was added.',
        retryable: true,
      };
    case 'relic_expired':
      return {
        code,
        headline: 'This relic has expired',
        detail:
          'Its lifetime ran out, so Relic sends no more emails about ' +
          'it and takes no new addresses.',
        retryable: false,
      };
    case 'download_cap_exhausted':
      return {
        code,
        headline: 'This relic has been opened as often as it allows',
        detail:
          'It reached its download cap, so Relic sends no more emails ' +
          'about it and takes no new addresses.',
        retryable: false,
      };
    case 'relic_removed':
      return {
        code,
        headline: 'This relic was taken down',
        detail:
          'Its comments and shared addresses went with it. There is nothing ' +
          'left to share.',
        retryable: false,
      };
    case 'relic_not_found':
    case 'invalid_relic_id':
      return {
        code,
        headline: 'This relic does not exist',
        detail: 'There is nothing here to share.',
        retryable: false,
      };
    case 'http_404':
      return {
        code,
        headline: 'This Relic service cannot take shares yet',
        detail:
          'The page is newer than the service answering it. Nothing was added.',
        retryable: false,
      };
    case 'no_share_key':
      return {
        code,
        headline: 'Sharing needs the key from your link',
        detail:
          'The share proof is derived from the key in this link, and this ' +
          'page does not have it. Nothing was sent.',
        retryable: false,
      };
    case 'network':
      return {
        code,
        headline: 'Sharing could not be reached',
        detail:
          'The request did not complete. That is a network problem rather ' +
          `than a problem with this relic. ${SAFE_RETRY}`,
        retryable: true,
      };
    case 'malformed_share':
      return {
        code,
        headline: 'Relic\u2019s answer could not be read',
        detail: `The addresses may have been added. ${SAFE_RETRY}`,
        retryable: true,
      };
    default:
      return {
        code,
        headline: 'Sharing was refused',
        detail: `The server refused with ${code}. Nothing was added.`,
        retryable: true,
      };
  }
}

/**
 * Refusals about the relic rather than the attempt.
 *
 * No edit to the list and no amount of waiting changes these, so the panel
 * stops offering the form instead of leaving a button that cannot work.
 */
const ENDS_SHARING: Readonly<Record<string, true>> = {
  share_unavailable: true,
  invalid_share_proof: true,
  relic_expired: true,
  download_cap_exhausted: true,
  relic_removed: true,
  relic_not_found: true,
  invalid_relic_id: true,
  http_404: true,
  no_share_key: true,
};

export function refusalEndsSharing(code: string): boolean {
  return Object.hasOwn(ENDS_SHARING, code);
}

export interface ShareRequestBody {
  /** Unpadded base64url of the 32-byte proof. Never the key. */
  readonly share_proof: string;
  readonly emails: readonly string[];
}

/**
 * The body of a reader share. Exported so a test can assert exactly what goes
 * on the wire: the proof derived from the key, the addresses, and nothing
 * else. The key, the fragment and the sharer's address are not in it.
 */
export async function shareRequestBody(
  key: Uint8Array,
  emails: readonly string[]
): Promise<ShareRequestBody> {
  const proof = await deriveShareProof(key);
  return { share_proof: encodeKey(proof), emails: [...emails] };
}

/** What the service answered a share with. */
export interface Shared {
  readonly kind: 'shared';
  /** The addresses as the service normalized them, in request order. */
  readonly emails: readonly string[];
  /** How many of them were new to the list. */
  readonly added: number;
  readonly sharedCount: number;
  readonly shareLimit: number;
  /** The relic's plaintext title, or null when it was published without one. */
  readonly title: string | null;
}

export type ShareOutcome =
  | Shared
  | { readonly kind: 'refused'; readonly refusal: Refusal };

function numberField(body: object, name: string): number | undefined {
  if (!(name in body)) return undefined;
  const value: unknown = Reflect.get(body, name);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function extensionsOf(body: object): ShareProblemExtensions {
  const out: {
    retry_after_seconds?: number;
    share_limit?: number;
    shared_count?: number;
    share_max_per_call?: number;
  } = {};
  for (const name of [
    'retry_after_seconds',
    'share_limit',
    'shared_count',
    'share_max_per_call',
  ] as const) {
    const value = numberField(body, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

async function refusalFrom(response: Response): Promise<Refusal> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return shareRefusal(`http_${response.status}`);
  }
  if (typeof body !== 'object' || body === null) {
    return shareRefusal(`http_${response.status}`);
  }
  const code = 'code' in body && typeof body.code === 'string' ? body.code : '';
  return shareRefusal(
    code.length > 0 ? code : `http_${response.status}`,
    extensionsOf(body)
  );
}

function sharedFrom(body: unknown): Shared | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const emails = 'emails' in body ? body.emails : undefined;
  if (
    !Array.isArray(emails) ||
    !emails.every((entry): entry is string => typeof entry === 'string')
  ) {
    return undefined;
  }
  const added = numberField(body, 'added');
  const sharedCount = numberField(body, 'shared_count');
  const shareLimit = numberField(body, 'share_limit');
  const title = 'title' in body ? body.title : undefined;
  if (
    added === undefined ||
    sharedCount === undefined ||
    shareLimit === undefined ||
    (title !== null && typeof title !== 'string')
  ) {
    return undefined;
  }
  return { kind: 'shared', emails, added, sharedCount, shareLimit, title };
}

/**
 * Adds addresses to a relic's change emails, as a signed-in reader.
 *
 * `credentials: 'same-origin'` is stated rather than left to the default,
 * because the session cookie travelling is the whole of the reader's half of
 * the authority, and a refactor to a cross-origin service would otherwise
 * drop it without a sound.
 */
export async function requestShare(
  relicId: string,
  key: Uint8Array,
  emails: readonly string[],
  deps: ViewerDeps
): Promise<ShareOutcome> {
  const body = await shareRequestBody(key, emails);
  let response: Response;
  try {
    let canonical = relicId;
    try {
      canonical = parseRelicId(relicId);
    } catch {}
    response = await deps.fetch(
      `${deps.serviceOrigin}/api/relics/${encodeURIComponent(canonical)}/share`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { kind: 'refused', refusal: shareRefusal('network') };
  }
  if (!response.ok) {
    return { kind: 'refused', refusal: await refusalFrom(response) };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: 'refused', refusal: shareRefusal('malformed_share') };
  }
  const shared = sharedFrom(parsed);
  if (shared === undefined) {
    return { kind: 'refused', refusal: shareRefusal('malformed_share') };
  }
  return shared;
}

/** The line that opens the success state: what changed, and what did not. */
export function sharedSummary(shared: Shared): string {
  const already = Math.max(0, shared.emails.length - shared.added);
  return (
    `Added to this relic\u2019s emails about new comments and versions: ${shared.added} new, ` +
    `${already} already there. Its list holds ${shared.sharedCount} of ` +
    `${shared.shareLimit}. Relic has emailed nobody.`
  );
}

/**
 * The email a reader sends, addressed to the list as the service normalized
 * it and titled as the service has it, so what the reader sends matches what
 * was registered.
 */
export function readerShareEmail(shareUrl: string, shared: Shared): ShareEmail {
  return composeShareEmail({
    url: shareUrl,
    title: shared.title,
    to: shared.emails,
    sender: 'reader',
  });
}
