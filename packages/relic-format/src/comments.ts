/**
 * Comment encryption (`spec/format.md` 3.13).
 *
 * A comment about content the operator cannot read, stored in the clear,
 * hands the operator exactly what the architecture exists to deny. So comment
 * bodies are encrypted by whoever writes them, under a key only a holder of
 * the relic's link can derive.
 *
 * **The fragment does not change, and that is the constraint everything here
 * bends around.** `spec/format.md` 2.1 fixes the fragment at the marker and
 * the key, and says a third field takes a version bump. There is therefore no
 * room for a separate comment secret. What there is room for is another HKDF
 * label: RFC 8188 already expands the same input keying material twice, under
 * `Content-Encoding: aes128gcm\0` for the content key and
 * `Content-Encoding: nonce\0` for the base nonce, and a third distinct label
 * yields a third key independent of both. Independence is by construction
 * rather than by assertion, which is why this needs no version bump: the
 * container's bytes, the envelope's fields, and the fragment's shape are all
 * untouched. Nothing that was written before this existed decodes differently
 * after it.
 *
 * The salt is zero-length, unlike the container's, because there is no salt to
 * carry: a comment is not a container and has no header to put one in. RFC
 * 5869 permits it, and the label plus a per-comment nonce is what separates
 * comments from each other.
 *
 * The framing is deliberately not RFC 8188. A comment is small, read whole,
 * and never range-decrypted, so records, padding, and a 21-byte header would
 * all be overhead spent on properties comments do not need. It is
 * `nonce(12) || AES-128-GCM(key, nonce, plaintext)`, transported base64url.
 *
 * This package owns it because the viewer and the publishing client both
 * encrypt and decrypt comments, and a second definition of the derivation is
 * the drift this package exists to prevent.
 */

import type { OtioAnchorV1, OtioRationalTime } from './otio-types.ts';
import {
  CommentDecryptFailedError,
  CommentTooLargeError,
  MalformedCommentError,
} from './errors.ts';

/**
 * The third label. Distinct from RFC 8188's two by construction, and namespaced
 * with a version segment so a later envelope change has a label to move to
 * without colliding with comments already written.
 */
const COMMENT_INFO = new TextEncoder().encode('relic/comments/v1');

/** AES-GCM's standard nonce length, prepended to every comment. */
export const COMMENT_NONCE_BYTES = 12;

/**
 * A body cap, enforced here rather than left to a caller.
 *
 * Enforced before encryption so the refusal names the limit, and enforced in
 * this package so it is one number rather than one per caller. Truncating
 * instead of refusing would change what a comment says, which is worse than
 * refusing to store it.
 */
export const COMMENT_BODY_LIMIT_BYTES = 4096;

/** A display name is decoration, so it gets a decoration-sized cap. */
export const COMMENT_DISPLAY_NAME_LIMIT_BYTES = 64;

/**
 * A comment id, and ids are minted by the service, so this is a sanity bound
 * rather than a format claim: a reply pointing at something id-shaped is the
 * most this package can check without learning the service's id scheme.
 */
export const COMMENT_ADDRESSES_LIMIT_BYTES = 64;

/**
 * A rectangle in unit coordinates of whatever space the anchor carrying it
 * names. `x` and `y` are the top-left corner, `w` and `h` the extent, all in
 * 0 to 1. A zero-area rectangle is refused: a box nobody can see is a point
 * wearing a box's shape, and `pin` already exists for a point.
 */
export interface AnchorRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where a comment sits on the relic, encrypted with the body so the
 * operator cannot read the mark either.
 *
 * Missing on a comment that is just a remark about the relic as a whole.
 *
 * **`text` and `pin` are frozen.** They are the two kinds that shipped, they
 * are already stored under keys this package cannot enumerate, and a reader
 * built before this paragraph parses exactly them and refuses any field it
 * has not seen. Extending either in place would turn every comment written
 * by a current writer into `MalformedComment` in that reader, which surfaces
 * to a person as "altered in storage". That is a lie about tampering told by
 * a version gap, so precision arrives as new kinds instead and the frozen
 * two are never widened.
 *
 * - `text` is a quote to re-find in the document. First exact occurrence,
 *   which is why `quote` exists beside it.
 * - `pin` is a point on the stage in unit coordinates.
 * - `quote` is a quote plus the text immediately around it, so a phrase that
 *   appears more than once resolves to the occurrence the reader selected
 *   rather than the first one in the document.
 * - `region` is a box on the artifact's own content box, not the stage's.
 *   The distinction is the whole point: a stage-relative box drifts when the
 *   same image is letterboxed differently at another viewport width, so a
 *   mark placed on a face on a wide screen lands beside it on a phone.
 * - `time` is a moment, or a span, in a media relic, with an optional box
 *   inside that frame.
 * - `page` is one page of a paged document, with an optional box or quote on
 *   it.
 * - `unsupported` is never written. It is what this parser returns for a
 *   `kind` it does not know, so a reader can say a mark exists and it cannot
 *   show it, which is true, instead of reporting the comment as unreadable,
 *   which is not.
 */
export type CommentAnchor =
  | { readonly kind: 'text'; readonly quote: string }
  | { readonly kind: 'pin'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'quote';
      readonly exact: string;
      readonly prefix?: string;
      readonly suffix?: string;
    }
  | { readonly kind: 'region'; readonly rect: AnchorRect }
  | {
      readonly kind: 'time';
      readonly t: number;
      readonly t_end?: number;
      readonly rect?: AnchorRect;
    }
  | {
      readonly kind: 'page';
      readonly page: number;
      readonly rect?: AnchorRect;
      readonly exact?: string;
    }
  | OtioAnchorV1
  | { readonly kind: 'unsupported'; readonly declared: string };

/** Cap on encoded OTIO anchor bytes (1,536 bytes). */
export const COMMENT_ANCHOR_OTIO_LIMIT_BYTES = 1536;

/** Cap on final encrypted base64url comment ciphertext (8,192 characters). */
export const COMMENT_CIPHERTEXT_LIMIT_CHARS = 8192;

/** Longest quote stored on a text mark. A selection is not a document. */
export const COMMENT_ANCHOR_QUOTE_LIMIT_BYTES = 512;

/**
 * Longest run of surrounding text stored beside a quote, each side.
 *
 * Context exists to disambiguate an occurrence, not to reproduce the passage.
 * A run this long already separates every repeat of a phrase a reader could
 * plausibly have selected, and anything longer is the document leaking into
 * the mark.
 */
export const COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES = 128;

/**
 * Highest page number a `page` anchor may carry.
 *
 * A bound exists so a hostile value cannot be handed to a renderer as a page
 * to seek to, and it is far above any document a reader is annotating.
 */
export const COMMENT_ANCHOR_MAX_PAGE = 10_000;

/**
 * Longest media offset a `time` anchor may carry, in seconds.
 *
 * Twenty-four hours. The same reasoning as the page ceiling: the value is
 * handed to a player as a seek target, so it is bounded here rather than
 * trusted there.
 */
export const COMMENT_ANCHOR_MAX_SECONDS = 86_400;

/**
 * What a comment carries.
 *
 * `display_name` aliases the commenter's identity for presentation and never
 * replaces it: the identity is the verified address the service holds, and
 * this is untrusted display text living inside the ciphertext where the
 * service cannot read it.
 *
 * `anchor` is omitted from the sealed JSON when it is null, so a freeform
 * comment stays readable to a parser that has not learned marks yet.
 */
export interface CommentPlaintext {
  readonly body: string;
  readonly display_name: string | null;
  /** Absent or null is a freeform comment, not a mark. */
  readonly anchor?: CommentAnchor | null;
  /**
   * The comment this one answers, by service-minted id.
   *
   * Present on a reply and on the acknowledgement a publisher writes when an
   * update lands, which is what lets a reader see that a remark was taken up
   * rather than passed over. Absent on an ordinary comment.
   *
   * **This copy is the authoritative one**, because it is sealed under the
   * comment key and the AEAD tag covers it. A caller may also hand the same
   * id to the service in the clear so it can route a notification to the
   * person being answered, and that copy is a routing hint the operator can
   * see and could forge. A reader that showed "addressed" on the strength of
   * the clear copy would be repeating the operator's word for it, so nothing
   * may resolve this from anywhere but here.
   */
  readonly addresses?: string | null;
  /**
   * Field names this build found in the sealed JSON and does not understand.
   *
   * Populated on read and refused on write, because it describes a gap in
   * this reader rather than anything a writer gets to assert.
   */
  readonly unsupported_fields?: readonly string[];
}

/**
 * Derive a relic's comment key from the same 16 bytes the fragment carries.
 *
 * HKDF-SHA256, zero-length salt, `relic/comments/v1`, expanded to 128 bits.
 */
export async function deriveCommentKey(
  keyBytes: Uint8Array
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: COMMENT_INFO,
    },
    material,
    128
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Seal one comment. The nonce is drawn fresh per call, never derived from a
 * counter, because comments have no ordering this package can see and a reused
 * nonce under a reused key loses the plaintext outright.
 */
export async function encryptComment(
  commentKey: CryptoKey,
  plaintext: CommentPlaintext
): Promise<string> {
  const bodyBytes = new TextEncoder().encode(plaintext.body);
  if (bodyBytes.length > COMMENT_BODY_LIMIT_BYTES) {
    throw new CommentTooLargeError(
      'body',
      bodyBytes.length,
      COMMENT_BODY_LIMIT_BYTES
    );
  }
  if (plaintext.display_name !== null) {
    const nameBytes = new TextEncoder().encode(plaintext.display_name).length;
    if (nameBytes > COMMENT_DISPLAY_NAME_LIMIT_BYTES) {
      throw new CommentTooLargeError(
        'display_name',
        nameBytes,
        COMMENT_DISPLAY_NAME_LIMIT_BYTES
      );
    }
  }
  if (plaintext.anchor != null) {
    assertWritableAnchor(plaintext.anchor);
  }
  if (plaintext.addresses != null) {
    const addressesBytes = new TextEncoder().encode(plaintext.addresses).length;
    if (addressesBytes > COMMENT_ADDRESSES_LIMIT_BYTES) {
      throw new CommentTooLargeError(
        'addresses',
        addressesBytes,
        COMMENT_ADDRESSES_LIMIT_BYTES
      );
    }
    if (plaintext.addresses.length === 0) {
      throw new MalformedCommentError(
        'addresses is present and empty, which points at no comment'
      );
    }
  }
  if (plaintext.unsupported_fields !== undefined) {
    // It records what a reader could not understand. A writer asserting it
    // would be claiming a gap on someone else's behalf.
    throw new MalformedCommentError(
      'unsupported_fields is read-only and cannot be sealed'
    );
  }

  const encoded = new TextEncoder().encode(
    JSON.stringify({
      body: plaintext.body,
      display_name: plaintext.display_name,
      ...(plaintext.anchor == null ? {} : { anchor: plaintext.anchor }),
      ...(plaintext.addresses == null
        ? {}
        : { addresses: plaintext.addresses }),
    })
  );
  const nonce = crypto.getRandomValues(new Uint8Array(COMMENT_NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(nonce) },
      commentKey,
      toBufferSource(encoded)
    )
  );

  const framed = new Uint8Array(nonce.length + sealed.length);
  framed.set(nonce, 0);
  framed.set(sealed, nonce.length);
  const ciphertext = base64url(framed);
  if (ciphertext.length > COMMENT_CIPHERTEXT_LIMIT_CHARS) {
    throw new CommentTooLargeError(
      'ciphertext',
      ciphertext.length,
      COMMENT_CIPHERTEXT_LIMIT_CHARS
    );
  }
  return ciphertext;
}

/**
 * Open one comment, parsing strictly.
 *
 * An unknown field is refused rather than ignored, so an extension to this
 * envelope has to be a deliberate change instead of something a shrugging
 * parser absorbed. A `display_name` that is present and neither a string nor
 * null is refused for the same reason: coercing it to null would silently
 * discard whatever the writer meant.
 */
export async function decryptComment(
  commentKey: CryptoKey,
  ciphertext: string
): Promise<CommentPlaintext> {
  const framed = decodeBase64url(ciphertext);
  if (framed.length <= COMMENT_NONCE_BYTES) {
    throw new MalformedCommentError(
      `comment is ${framed.length} bytes, too short to carry a ` +
        `${COMMENT_NONCE_BYTES}-byte nonce and a tag`
    );
  }

  let opened: Uint8Array;
  try {
    opened = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(framed.subarray(0, COMMENT_NONCE_BYTES)),
        },
        commentKey,
        toBufferSource(framed.subarray(COMMENT_NONCE_BYTES))
      )
    );
  } catch {
    // No cause, per `spec/format.md` 3.5. A wrong key, a truncated value, and
    // a tampered nonce are the same symptom from here.
    throw new CommentDecryptFailedError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(opened)
    );
  } catch {
    throw new MalformedCommentError('comment plaintext is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedCommentError('comment plaintext is not a JSON object');
  }

  const fields = parsed as Record<string, unknown>;
  const known = new Set(['body', 'display_name', 'anchor', 'addresses']);
  // Reported rather than refused, reversing the rule this parser shipped with.
  //
  // Refusing the whole comment on an unknown field was written to catch
  // tampering, and in practice it caught version skew: the published client
  // predated two anchor kinds and reported real comments as unreadable, which
  // reads to a person as "altered in storage". The paragraph on the frozen
  // anchor kinds already names that as a lie about tampering told by a version
  // gap, and a top-level field is the same gap one level up. The AEAD tag is
  // what detects tampering; strictness here only detected age.
  const unsupported = Object.keys(fields).filter((key) => !known.has(key));

  const body = fields['body'];
  if (typeof body !== 'string') {
    throw new MalformedCommentError('comment body is missing or not a string');
  }

  const displayName = fields['display_name'];
  if (displayName !== null && typeof displayName !== 'string') {
    throw new MalformedCommentError(
      'comment display_name is present and is neither a string nor null'
    );
  }

  const addresses = fields['addresses'];
  if (
    addresses !== undefined &&
    addresses !== null &&
    (typeof addresses !== 'string' || addresses.length === 0)
  ) {
    throw new MalformedCommentError(
      'comment addresses is present and is neither a non-empty string nor null'
    );
  }

  return {
    body,
    display_name: displayName,
    anchor: parseAnchor(fields['anchor']),
    addresses: typeof addresses === 'string' ? addresses : null,
    ...(unsupported.length > 0 ? { unsupported_fields: unsupported } : {}),
  };
}

/**
 * Read one anchor off a decrypted comment.
 *
 * Two different strictnesses, and the difference is deliberate. **An unknown
 * field inside a known kind is refused**, exactly as the envelope refuses
 * one, because that is the tampering and typo case and absorbing it would
 * discard whatever the writer meant. **An unknown `kind` is not refused**: it
 * comes back as `unsupported`, because the only thing that produces one is a
 * reader older than the writer, and the honest report is that a mark exists
 * this page cannot show rather than that the comment is unreadable.
 */
function parseAnchor(value: unknown): CommentAnchor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MalformedCommentError('comment anchor is not an object');
  }
  const anchor = value as Record<string, unknown>;
  const kind = anchor['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new MalformedCommentError('comment anchor kind is missing');
  }

  if (kind === 'text') {
    const quote = requireQuote(anchor, 'quote', 'text');
    refuseExtra(anchor, ['kind', 'quote'], 'text');
    return { kind: 'text', quote };
  }

  if (kind === 'pin') {
    const x = requireUnit(anchor['x'], 'pin x');
    const y = requireUnit(anchor['y'], 'pin y');
    refuseExtra(anchor, ['kind', 'x', 'y'], 'pin');
    return { kind: 'pin', x, y };
  }

  if (kind === 'quote') {
    const exact = requireQuote(anchor, 'exact', 'quote');
    const prefix = optionalContext(anchor['prefix'], 'quote prefix');
    const suffix = optionalContext(anchor['suffix'], 'quote suffix');
    refuseExtra(anchor, ['kind', 'exact', 'prefix', 'suffix'], 'quote');
    return {
      kind: 'quote',
      exact,
      ...(prefix === undefined ? {} : { prefix }),
      ...(suffix === undefined ? {} : { suffix }),
    };
  }

  if (kind === 'region') {
    const rect = requireRect(anchor['rect'], 'region');
    refuseExtra(anchor, ['kind', 'rect'], 'region');
    return { kind: 'region', rect };
  }

  if (kind === 'time') {
    const t = requireSeconds(anchor['t'], 'time t');
    const end = anchor['t_end'];
    const tEnd =
      end === undefined ? undefined : requireSeconds(end, 'time t_end');
    if (tEnd !== undefined && tEnd <= t) {
      throw new MalformedCommentError(
        'time anchor t_end is not after t, so the span is empty or reversed'
      );
    }
    const box = anchor['rect'];
    const rect = box === undefined ? undefined : requireRect(box, 'time');
    refuseExtra(anchor, ['kind', 't', 't_end', 'rect'], 'time');
    return {
      kind: 'time',
      t,
      ...(tEnd === undefined ? {} : { t_end: tEnd }),
      ...(rect === undefined ? {} : { rect }),
    };
  }

  if (kind === 'page') {
    const page = anchor['page'];
    if (
      typeof page !== 'number' ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > COMMENT_ANCHOR_MAX_PAGE
    ) {
      throw new MalformedCommentError(
        `page anchor page is not an integer in 1 to ${COMMENT_ANCHOR_MAX_PAGE}`
      );
    }
    const box = anchor['rect'];
    const rect = box === undefined ? undefined : requireRect(box, 'page');
    const quoted = anchor['exact'];
    const exact =
      quoted === undefined ? undefined : requireQuote(anchor, 'exact', 'page');
    refuseExtra(anchor, ['kind', 'page', 'rect', 'exact'], 'page');
    return {
      kind: 'page',
      page,
      ...(rect === undefined ? {} : { rect }),
      ...(exact === undefined ? {} : { exact }),
    };
  }

  if (kind === 'otio') {
    const v = anchor['v'];
    if (v !== 1) {
      return { kind: 'unsupported', declared: `otio-v${String(v)}` };
    }
    const relicVersion = anchor['relic_version'];
    if (
      typeof relicVersion !== 'number' ||
      !Number.isInteger(relicVersion) ||
      relicVersion < 1
    ) {
      throw new MalformedCommentError(
        'otio anchor relic_version is not a positive integer'
      );
    }
    const docSha = anchor['document_sha256'];
    if (typeof docSha !== 'string' || !/^[0-9a-fA-F]{64}$/.test(docSha)) {
      throw new MalformedCommentError(
        'otio anchor document_sha256 is not a 64-character hex hash'
      );
    }
    const timelineId = anchor['timeline_id'];
    if (typeof timelineId !== 'string' || timelineId.length === 0) {
      throw new MalformedCommentError(
        'otio anchor timeline_id is missing or empty'
      );
    }
    const trackId = anchor['track_id'];
    if (
      trackId !== null &&
      (typeof trackId !== 'string' || trackId.length === 0)
    ) {
      throw new MalformedCommentError(
        'otio anchor track_id is neither null nor a non-empty string'
      );
    }
    const itemId = anchor['item_id'];
    if (
      itemId !== undefined &&
      (typeof itemId !== 'string' || itemId.length === 0)
    ) {
      throw new MalformedCommentError(
        'otio anchor item_id is present and is not a non-empty string'
      );
    }
    const rangeVal = anchor['range'];
    if (typeof rangeVal !== 'object' || rangeVal === null) {
      throw new MalformedCommentError('otio anchor range is not an object');
    }
    const rangeObj = rangeVal as Record<string, unknown>;
    const startVal = rangeObj['start_time'];
    if (typeof startVal !== 'object' || startVal === null) {
      throw new MalformedCommentError(
        'otio anchor range start_time is missing or not an object'
      );
    }
    const sVal = (startVal as Record<string, unknown>)['value'];
    const sRate = (startVal as Record<string, unknown>)['rate'];
    if (typeof sVal !== 'number' || !Number.isFinite(sVal)) {
      throw new MalformedCommentError(
        'otio anchor range start_time value is not a finite number'
      );
    }
    if (typeof sRate !== 'number' || !Number.isFinite(sRate) || sRate <= 0) {
      throw new MalformedCommentError(
        'otio anchor range start_time rate is not a positive finite number'
      );
    }
    refuseExtra(
      startVal as Record<string, unknown>,
      ['value', 'rate'],
      'range start_time'
    );

    const durVal = rangeObj['duration'];
    if (typeof durVal !== 'object' || durVal === null) {
      throw new MalformedCommentError(
        'otio anchor range duration is missing or not an object'
      );
    }
    const dVal = (durVal as Record<string, unknown>)['value'];
    const dRate = (durVal as Record<string, unknown>)['rate'];
    if (typeof dVal !== 'number' || !Number.isFinite(dVal) || dVal < 0) {
      throw new MalformedCommentError(
        'otio anchor range duration value is not a non-negative finite number'
      );
    }
    if (typeof dRate !== 'number' || !Number.isFinite(dRate) || dRate <= 0) {
      throw new MalformedCommentError(
        'otio anchor range duration rate is not a positive finite number'
      );
    }
    refuseExtra(
      durVal as Record<string, unknown>,
      ['value', 'rate'],
      'range duration'
    );
    refuseExtra(rangeObj, ['start_time', 'duration'], 'otio range');

    const snapshotVal = anchor['snapshot'];
    if (typeof snapshotVal !== 'object' || snapshotVal === null) {
      throw new MalformedCommentError('otio anchor snapshot is not an object');
    }
    const snapObj = snapshotVal as Record<string, unknown>;
    const snapTimeline = snapObj['timeline'];
    if (typeof snapTimeline !== 'string') {
      throw new MalformedCommentError(
        'otio anchor snapshot timeline is not a string'
      );
    }
    const snapTrack = snapObj['track'];
    if (snapTrack !== null && typeof snapTrack !== 'string') {
      throw new MalformedCommentError(
        'otio anchor snapshot track is neither null nor a string'
      );
    }
    const snapItem = snapObj['item'];
    if (snapItem !== null && typeof snapItem !== 'string') {
      throw new MalformedCommentError(
        'otio anchor snapshot item is neither null nor a string'
      );
    }
    refuseExtra(snapObj, ['timeline', 'track', 'item'], 'otio snapshot');

    refuseExtra(
      anchor,
      [
        'kind',
        'v',
        'relic_version',
        'document_sha256',
        'timeline_id',
        'track_id',
        'item_id',
        'range',
        'snapshot',
      ],
      'otio'
    );

    const otioAnchor: OtioAnchorV1 = {
      kind: 'otio',
      v: 1,
      relic_version: relicVersion,
      document_sha256: docSha.toLowerCase(),
      timeline_id: timelineId,
      track_id: trackId,
      ...(itemId === undefined ? {} : { item_id: itemId }),
      range: {
        start_time: { value: sVal, rate: sRate },
        duration: { value: dVal, rate: dRate },
      },
      snapshot: {
        timeline: snapTimeline,
        track: snapTrack,
        item: snapItem,
      },
    };

    const encoded = new TextEncoder().encode(JSON.stringify(otioAnchor)).length;
    if (encoded > COMMENT_ANCHOR_OTIO_LIMIT_BYTES) {
      throw new MalformedCommentError(
        `otio anchor encoded size ${encoded} bytes exceeds cap of ${COMMENT_ANCHOR_OTIO_LIMIT_BYTES}`
      );
    }
    return otioAnchor;
  }
  // The forward-tolerant branch. A `kind` this build has never heard of is a
  // writer newer than this reader, which is a version gap and not a defect in
  // the comment, so it keeps its body and loses only the ability to be shown
  // in place.
  return { kind: 'unsupported', declared: kind };
}

/**
 * Refuse an anchor that must never be written, and enforce the caps.
 *
 * `unsupported` is the one kind a writer may never seal: it exists to
 * describe a gap a reader found, and writing it would store a comment
 * pointing at nothing, permanently, under a key nobody can rewrite.
 */
function assertWritableAnchor(anchor: CommentAnchor): void {
  if (anchor.kind === 'unsupported') {
    throw new MalformedCommentError(
      'an unsupported anchor describes a reader gap and is never written'
    );
  }
  if (anchor.kind === 'text') capQuote(anchor.quote);
  if (anchor.kind === 'quote') {
    capQuote(anchor.exact);
    capContext(anchor.prefix);
    capContext(anchor.suffix);
  }
  if (anchor.kind === 'page' && anchor.exact !== undefined) {
    capQuote(anchor.exact);
  }
  if (anchor.kind === 'otio') {
    const encoded = new TextEncoder().encode(JSON.stringify(anchor)).length;
    if (encoded > COMMENT_ANCHOR_OTIO_LIMIT_BYTES) {
      throw new CommentTooLargeError(
        'anchor',
        encoded,
        COMMENT_ANCHOR_OTIO_LIMIT_BYTES
      );
    }
  }
  // Every other field is a bounded number, and the bound is checked on the
  // way back in by `parseAnchor`. Round-tripping a value this side accepted
  // and that side refuses would be the real defect, so the writer runs the
  // same predicates rather than a second, looser copy of them.
  parseAnchor(JSON.parse(JSON.stringify(anchor)) as unknown);
}

function capQuote(quote: string): void {
  const bytes = new TextEncoder().encode(quote).length;
  if (bytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
    throw new CommentTooLargeError(
      'anchor',
      bytes,
      COMMENT_ANCHOR_QUOTE_LIMIT_BYTES
    );
  }
}

function capContext(context: string | undefined): void {
  if (context === undefined) return;
  const bytes = new TextEncoder().encode(context).length;
  if (bytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
    throw new CommentTooLargeError(
      'anchor',
      bytes,
      COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES
    );
  }
}

function requireQuote(
  anchor: Record<string, unknown>,
  field: string,
  kind: string
): string {
  const quote = anchor[field];
  if (typeof quote !== 'string' || quote.length === 0) {
    throw new MalformedCommentError(`${kind} anchor ${field} is missing`);
  }
  const bytes = new TextEncoder().encode(quote).length;
  if (bytes > COMMENT_ANCHOR_QUOTE_LIMIT_BYTES) {
    throw new MalformedCommentError(
      `${kind} anchor ${field} is ${bytes} bytes, over the ` +
        `${COMMENT_ANCHOR_QUOTE_LIMIT_BYTES}-byte cap`
    );
  }
  return quote;
}

function optionalContext(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new MalformedCommentError(`${label} is present and is not a string`);
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES) {
    throw new MalformedCommentError(
      `${label} is ${bytes} bytes, over the ` +
        `${COMMENT_ANCHOR_CONTEXT_LIMIT_BYTES}-byte cap`
    );
  }
  return value;
}

function requireUnit(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new MalformedCommentError(`${label} is out of unit range`);
  }
  return value;
}

function requireSeconds(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > COMMENT_ANCHOR_MAX_SECONDS
  ) {
    throw new MalformedCommentError(
      `${label} is not a finite offset in 0 to ${COMMENT_ANCHOR_MAX_SECONDS} seconds`
    );
  }
  return value;
}

function requireRect(value: unknown, kind: string): AnchorRect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedCommentError(`${kind} anchor rect is not an object`);
  }
  const rect = value as Record<string, unknown>;
  const x = requireUnit(rect['x'], `${kind} rect x`);
  const y = requireUnit(rect['y'], `${kind} rect y`);
  const w = requireUnit(rect['w'], `${kind} rect w`);
  const h = requireUnit(rect['h'], `${kind} rect h`);
  if (w === 0 || h === 0) {
    throw new MalformedCommentError(
      `${kind} anchor rect has no area, so it marks nothing`
    );
  }
  if (x + w > 1 || y + h > 1) {
    throw new MalformedCommentError(
      `${kind} anchor rect runs past the edge of what it is measured against`
    );
  }
  refuseExtra(rect, ['x', 'y', 'w', 'h'], `${kind} rect`);
  return { x, y, w, h };
}

function refuseExtra(
  value: Record<string, unknown>,
  allowed: readonly string[],
  kind: string
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new MalformedCommentError(
      `${kind} anchor carries unknown field(s): ${extra.join(', ')}`
    );
  }
}

/** Unpadded base64url (RFC 4648 section 5), the same encoding the key uses. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
    throw new MalformedCommentError('comment is not unpadded base64url');
  }
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  } catch {
    throw new MalformedCommentError('comment is not decodable base64url');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Bun and the DOM disagree on whether a `Uint8Array` over a `SharedArrayBuffer`
 * satisfies `BufferSource`. Narrowing here keeps every call site clean, the
 * same way `rfc8188.ts` does.
 */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
