/**
 * Passkey signing for relik versions (`docs/plans/signing/plan.md` 3.1, 5.3,
 * 5.4; `docs/spec/format.md` 3.21). Reached as `@relic/format/signing`.
 *
 * It defines what a signature commits to, how a signature's content and
 * appearance are keyed, the completion certificate, and the offline verifier
 * that checks a certificate against the file. WebCrypto only, no network, and
 * the same code runs in the viewer, the service and relic-mcp.
 *
 * Nothing here decides who may sign or when. Those are the service's checks.
 * This module answers one question: does this record say what its signer
 * approved, and do the signatures check out.
 */

import type { AnchorRect } from './comments.ts';
import { RelicFormatError } from './errors.ts';
import {
  attestationChallenge,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  identityIdOf,
  parseStatement,
  SIGN_CONSENT_ID,
  type SignatureStatement,
  type OpenReceiptStatement,
  type SigningRequestStatement,
  statementBytes,
  verifyStatement,
} from './private.ts';
import type { DevicePublicJSON, IdentityPublicJSON } from './private-wire.ts';
import type { AuthenticationResponseJSON } from './passkey.ts';
import { Sha256, sha256Hex } from './sha256.ts';
import {
  verifyWebauthnAssertion,
  WebauthnAssertionError,
} from './webauthn-verify.ts';

export { SIGN_CONSENT_ID } from './private.ts';
export {
  type AssertionExpectation,
  verifyWebauthnAssertion,
  WebauthnAssertionError,
} from './webauthn-verify.ts';
export type {
  DevicePublicJSON,
  IdentityPublicJSON,
  RelicSettingsJSON,
} from './private-wire.ts';

/** The words a signer agrees to. Shown verbatim beside the consent box. */
export const SIGN_CONSENT_TEXT =
  'I agree to sign this document electronically. My passkey approval is my signature on this exact version.';

export const SIGNING_CERTIFICATE_FORMAT = 'relic/signing-certificate/v1';
export const SIGNING_MAX_SIGNERS = 20;
export const SIGNING_MAX_BOXES_PER_SIGNER = 20;
export const SIGNING_MAX_PAGE = 10_000;
/** Plaintext caps. The sealed text adds a 12-byte nonce and a 16-byte tag. */
export const SIGNING_LAYOUT_MAX_BYTES = 16 * 1024;
export const SIGNING_MARK_MAX_BYTES = 32 * 1024;
export const SIGNING_MARK_NAME_MAX_BYTES = 128;
export const SIGNING_MARK_MAX_STROKES = 64;
export const SIGNING_MARK_MAX_POINTS = 2048;

const SIGNING_LABEL = utf8('relic/signing/v1');
const CONTENT_MAC_LABEL = utf8('relic/signing/content-mac/v1');
const APPEARANCE_LABEL = utf8('relic/signing/appearance/v1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const RELIC_ID_RE = new RegExp(`^[${B32}]{26}$`);
const HEX64_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const CONTROL_RE = /\p{Cc}/u;

/** The what and the reason of a refusal. The reason names a field, never a value. */
export class SigningInputError extends RelicFormatError {
  override readonly name = 'SigningInputError';

  constructor(
    readonly what: 'layout' | 'mark' | 'appearance' | 'key' | 'certificate',
    readonly reason: string
  ) {
    super(`signing ${what} refused: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Keys and the content MAC (plan 3.1).
// ---------------------------------------------------------------------------

/**
 * `signingKey = HKDF(ikm = content key, info "relic/signing/v1", 32)`. The
 * content key is the 16-byte fragment key of a public relik or the version key
 * of a private one. Holding the signing key confirms the file and reads the
 * sealed layout and marks; it does not reveal the content key or the comment key.
 */
export async function deriveSigningKey(
  contentKey: Uint8Array
): Promise<Uint8Array> {
  requireBytes(contentKey, 16, 'content key');
  return hkdf(contentKey, SIGNING_LABEL, 32);
}

/** The bytes a content MAC covers: any iterable of chunks, or one buffer. */
export type ContentBytes =
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

/**
 * `content_mac = hex(HMAC-SHA256(HKDF(signingKey, "relic/signing/content-mac/v1", 32), content))`,
 * streamed through `Sha256` so a folder of any size is hashed in chunks.
 * `content` is the bytes the content records decrypt to, after the envelope
 * header: the file for envelope v1, the whole stream for v2 (format 3.20).
 */
export async function contentMac(
  signingKey: Uint8Array,
  content: ContentBytes
): Promise<string> {
  requireBytes(signingKey, 32, 'signing key');
  const macKey = await hkdf(signingKey, CONTENT_MAC_LABEL, 32);
  const block = new Uint8Array(64);
  block.set(macKey);
  const inner = new Sha256().update(xorPad(block, 0x36));
  for await (const chunk of chunksOf(content)) inner.update(chunk);
  const outer = new Sha256()
    .update(xorPad(block, 0x5c))
    .update(hexToBytes(inner.hex()));
  return outer.hex();
}

// ---------------------------------------------------------------------------
// The sealed layout and mark (plan 3.1). AES-128-GCM under a key derived from
// the signing key, with the kind, the relik and the version bound as AAD.
// ---------------------------------------------------------------------------

/** One signature box: the page and the rectangle a named signer signs in. */
export interface SigningBox {
  readonly signer: number;
  readonly page: number;
  readonly rect: AnchorRect;
}

/** Where each signer signs. A signer with no box signs in the block after the document. */
export interface SigningLayout {
  readonly v: 1;
  readonly boxes: readonly SigningBox[];
}

/** What a layout is checked against: how many signers there are, and whether the class is PDF. */
export interface SigningLayoutContext {
  readonly signerCount: number;
  readonly pdf: boolean;
}

/** A signer's typed or drawn mark. `strokes` holds flat `[x0,y0,x1,y1,...]` arrays in unit coordinates. */
export interface SignatureMark {
  readonly v: 1;
  readonly name: string;
  readonly strokes: readonly (readonly number[])[] | null;
}

/**
 * Strictly parse a layout. Unknown fields are refused. Boxes are refused unless
 * `pdf` is true. Each signer index must name a signer, and each rectangle must
 * fit the page it is measured against.
 */
export function parseSigningLayout(
  value: unknown,
  context: SigningLayoutContext
): SigningLayout {
  const object = exactObject(value, 'layout', ['boxes', 'v']);
  if (object.v !== 1) refuse('layout', 'version');
  if (!Array.isArray(object.boxes)) refuse('layout', 'boxes');
  if (object.boxes.length > 0 && !context.pdf) {
    refuse('layout', 'boxes need a PDF');
  }
  const perSigner = new Map<number, number>();
  const boxes = (object.boxes as unknown[]).map((box) => {
    const parsed = parseBox(box, context.signerCount);
    const count = (perSigner.get(parsed.signer) ?? 0) + 1;
    if (count > SIGNING_MAX_BOXES_PER_SIGNER)
      refuse('layout', 'too many boxes');
    perSigner.set(parsed.signer, count);
    return parsed;
  });
  return { v: 1, boxes };
}

/**
 * Strictly parse a mark. The name is 1 to 128 UTF-8 bytes with no control or
 * bidirectional characters. Strokes are flat coordinate arrays in [0,1] at
 * three decimals, with at most 64 strokes and 2048 points in total.
 */
export function parseSignatureMark(value: unknown): SignatureMark {
  const object = exactObject(value, 'mark', ['name', 'strokes', 'v']);
  if (object.v !== 1) refuse('mark', 'version');
  if (typeof object.name !== 'string') refuse('mark', 'name');
  const nameBytes = utf8(object.name).length;
  if (
    nameBytes < 1 ||
    nameBytes > SIGNING_MARK_NAME_MAX_BYTES ||
    CONTROL_RE.test(object.name) ||
    BIDI_RE.test(object.name)
  ) {
    refuse('mark', 'name');
  }
  if (object.strokes === null)
    return { v: 1, name: object.name, strokes: null };
  if (!Array.isArray(object.strokes)) refuse('mark', 'strokes');
  if (object.strokes.length > SIGNING_MARK_MAX_STROKES) {
    refuse('mark', 'too many strokes');
  }
  let points = 0;
  const strokes = (object.strokes as unknown[]).map((stroke) => {
    if (
      !Array.isArray(stroke) ||
      stroke.length < 2 ||
      stroke.length % 2 !== 0
    ) {
      refuse('mark', 'stroke');
    }
    points += stroke.length / 2;
    if (points > SIGNING_MARK_MAX_POINTS) refuse('mark', 'too many points');
    return (stroke as unknown[]).map((coordinate) => {
      if (!isUnitDecimal(coordinate)) refuse('mark', 'coordinate');
      return coordinate;
    });
  });
  return { v: 1, name: object.name, strokes };
}

/** Seal a layout under the signing key. The layout is parsed first, so only a valid one is sealed. */
export async function sealSigningLayout(input: {
  readonly signingKey: Uint8Array;
  readonly relicId: string;
  readonly version: number;
  readonly layout: unknown;
  readonly signerCount: number;
  readonly pdf: boolean;
}): Promise<string> {
  const layout = parseSigningLayout(input.layout, {
    signerCount: input.signerCount,
    pdf: input.pdf,
  });
  return sealAppearance(
    input.signingKey,
    'layout',
    input.relicId,
    input.version,
    layout,
    SIGNING_LAYOUT_MAX_BYTES
  );
}

/** Open a sealed layout. Refuses a wrong key, a wrong relik or version, or a layout that does not parse. */
export async function openSigningLayout(input: {
  readonly signingKey: Uint8Array;
  readonly relicId: string;
  readonly version: number;
  readonly ciphertext: string;
  readonly signerCount: number;
}): Promise<SigningLayout> {
  const parsed = await openAppearance(
    input.signingKey,
    'layout',
    input.relicId,
    input.version,
    input.ciphertext,
    SIGNING_LAYOUT_MAX_BYTES
  );
  return parseSigningLayout(parsed, {
    signerCount: input.signerCount,
    pdf: true,
  });
}

/** Seal a mark under the signing key. */
export async function sealSignatureMark(input: {
  readonly signingKey: Uint8Array;
  readonly relicId: string;
  readonly version: number;
  readonly mark: unknown;
}): Promise<string> {
  const mark = parseSignatureMark(input.mark);
  return sealAppearance(
    input.signingKey,
    'mark',
    input.relicId,
    input.version,
    mark,
    SIGNING_MARK_MAX_BYTES
  );
}

/** Open a sealed mark. Refuses a wrong key, a wrong relik or version, or a mark that does not parse. */
export async function openSignatureMark(input: {
  readonly signingKey: Uint8Array;
  readonly relicId: string;
  readonly version: number;
  readonly ciphertext: string;
}): Promise<SignatureMark> {
  const parsed = await openAppearance(
    input.signingKey,
    'mark',
    input.relicId,
    input.version,
    input.ciphertext,
    SIGNING_MARK_MAX_BYTES
  );
  return parseSignatureMark(parsed);
}

// ---------------------------------------------------------------------------
// Digests a signature commits to (plan 3.1, 4).
// ---------------------------------------------------------------------------

/** `request_sha256`: hex SHA-256 of the signing request's statement bytes. */
export function signingRequestSha256(
  statement: SigningRequestStatement
): string {
  return sha256Hex(statementBytes('signing_request', statement));
}

/** `opened_receipt_sha256`: hex SHA-256 of an open receipt's statement bytes. */
export function openReceiptSha256(statement: OpenReceiptStatement): string {
  return sha256Hex(statementBytes('open_receipt', statement));
}

/** `layout_sha256`: hex SHA-256 of the sealed layout's UTF-8 text, as stored. */
export function layoutCiphertextSha256(ciphertext: string): string {
  return sha256Hex(utf8(ciphertext));
}

/** `mark_sha256`: hex SHA-256 of the sealed mark's UTF-8 text, as stored. */
export function markCiphertextSha256(ciphertext: string): string {
  return sha256Hex(utf8(ciphertext));
}

// ---------------------------------------------------------------------------
// Wire JSON (plan 3.1), snake_case.
// ---------------------------------------------------------------------------

/** A passkey assertion with the key it verifies under and the nonce it answers. */
export interface WebAuthnProofJSON {
  readonly nonce: string;
  readonly credential: AuthenticationResponseJSON;
  readonly credential_id: string;
  readonly public_key_jwk: JsonWebKey;
  readonly alg: -7 | -257;
  readonly passkey_registered_at: string | null;
}

/** The owner's active signing state for one relik, as `/access` reports it. */
export interface SigningSummaryJSON {
  readonly open_version: number | null;
  readonly locked_versions: readonly number[];
}

/** One signer's recorded signature. `identity_signature` is `''` on a public relik. */
export interface SignatureRecordJSON {
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string | null;
  readonly mark_ciphertext: string;
  readonly webauthn: WebAuthnProofJSON;
  readonly recorded_at: string;
  readonly opened_receipt: {
    readonly statement: Record<string, unknown>;
    readonly identity_signature: string;
  } | null;
}

/** The signed request as the service stores it. */
export interface SigningRequestPayload {
  readonly statement: Record<string, unknown>;
  readonly signature: string;
  readonly signer_kind: 'identity' | 'device';
  readonly attestation: WebAuthnProofJSON | null;
  readonly layout_ciphertext: string;
}

export interface SigningRequestJSON {
  readonly request_id: string;
  readonly version: number;
  readonly status: 'open' | 'complete' | 'cancelled';
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly cancelled_at: string | null;
  readonly request: SigningRequestPayload;
  readonly owner: {
    readonly identity: IdentityPublicJSON;
    readonly device: DevicePublicJSON | null;
  };
  readonly signers: readonly {
    readonly index: number;
    readonly email: string;
    readonly identity: IdentityPublicJSON | null;
    readonly status: 'waiting' | 'ready' | 'signed' | 'needs_access';
    readonly served_at: string | null;
    readonly opened_at: string | null;
    readonly signature: SignatureRecordJSON | null;
  }[];
  readonly cancellation: {
    readonly statement: Record<string, unknown>;
    readonly signature: string;
    readonly signer_kind: 'identity' | 'device';
    readonly attestation: WebAuthnProofJSON | null;
  } | null;
}

/** What a reader sees of a relik's signing state. Receipts appear only to the owner or publisher. */
export interface SigningStateJSON {
  readonly relic_id: string;
  readonly current_version: number;
  readonly locked_versions: readonly number[];
  readonly me: {
    readonly signer_index: number;
    readonly served_at: string | null;
    readonly opened_at: string | null;
  } | null;
  readonly requests: readonly SigningRequestJSON[];
}

// ---------------------------------------------------------------------------
// The completion certificate (plan 5.3).
// ---------------------------------------------------------------------------

export interface SigningCertificateOwner {
  readonly identity: IdentityPublicJSON;
  readonly device: DevicePublicJSON | null;
}

export interface SigningCertificateSignature {
  readonly signer_index: number;
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
  readonly signer_identity: IdentityPublicJSON | null;
  readonly mark_ciphertext: string;
  readonly webauthn: WebAuthnProofJSON;
  /** The service's clock when it recorded the signature. Unsigned. */
  readonly recorded_at: string;
  /** Null on a public relik, which has no receipts. */
  readonly receipts: {
    /** The service's served record. Unsigned, and absent for a public relik. */
    readonly served_at: string | null;
    readonly opened: {
      readonly statement: Record<string, unknown>;
      readonly identity_signature: string;
    } | null;
  } | null;
}

/** The certificate a completed request yields. `signing_key` appears only in a copy the reader or relic-mcp built. */
export interface SigningCertificate {
  readonly format: typeof SIGNING_CERTIFICATE_FORMAT;
  readonly service: { readonly origin: string; readonly rp_id: string };
  readonly relic_id: string;
  readonly access: 'public' | 'private';
  /** The title on a public relik, an unsigned service record. Always null on a private one. */
  readonly title: string | null;
  readonly version: number;
  readonly ciphertext_sha256: string;
  readonly content_mac: string;
  readonly request: SigningRequestPayload;
  readonly owner: SigningCertificateOwner;
  readonly signatures: readonly SigningCertificateSignature[];
  /** The service's clock when the request completed. Unsigned. */
  readonly completed_at: string;
  readonly signing_key?: string;
}

/** One named check of a certificate, and whether it passed. */
export type CertificateCheckId =
  | 'format'
  | 'request_statement'
  | 'request_signer'
  | 'request_attestation'
  | 'signers_complete'
  | 'signature_statement'
  | 'consent'
  | 'signature_binding'
  | 'mark_hash'
  | 'signature_webauthn'
  | 'signature_identity'
  | 'opened_receipt'
  | 'order'
  | 'appearance'
  | 'content';

export interface CertificateCheck {
  readonly id: CertificateCheckId;
  readonly ok: boolean;
  readonly signer_index?: number;
  readonly detail?: string;
}

export interface CertificateSigner {
  readonly index: number;
  readonly email: string;
  /** The signer's own clock, from the signed statement. */
  readonly signed_at: number | null;
  /** The service's clock, unsigned. */
  readonly recorded_at: string | null;
  readonly credential_id: string | null;
  readonly identity_fingerprint: string | null;
  /** Null on a public relik. */
  readonly opened: boolean | null;
  /** The name the signer typed, shown only when the signing key was given. */
  readonly name: string | null;
}

export interface CertificateReport {
  /** Cryptographic consistency alone does not establish the owner's identity. */
  readonly internal_consistency: boolean;
  readonly trust: {
    readonly owner: 'matches' | 'mismatch' | 'unchecked';
    readonly signers: readonly {
      readonly index: number;
      readonly status: 'matches' | 'mismatch' | 'unchecked';
      readonly method: 'identity_id' | 'trust_on_first_use';
    }[];
  };
  readonly valid: boolean;
  readonly checks: readonly CertificateCheck[];
  readonly relic_id: string | null;
  readonly version: number | null;
  readonly access: 'public' | 'private' | null;
  readonly completed_at: string | null;
  /** The origin the signatures were checked against. */
  readonly origin: string | null;
  readonly owner: {
    readonly email: string;
    /** This address is an unsigned claim from the certificate. */
    readonly email_status: 'claimed';
    readonly identity_id: string;
    readonly fingerprint: string;
  } | null;
  readonly signers: readonly CertificateSigner[];
  readonly content: 'match' | 'mismatch' | 'not_checked';
}

export interface CertificateVerifyOptions {
  /** The signing key. With it the report shows names, and with `content` it compares the MAC. */
  readonly signingKey?: Uint8Array;
  /** The file's content bytes. Needs `signingKey`. */
  readonly content?: ContentBytes;
  /** The origin the certificate must claim. When absent the report states the origin it used. */
  readonly expectedOrigin?: string;
  /** Owner identity id obtained independently of this certificate. */
  readonly trustedOwnerIdentityId?: string;
  /** Independently obtained private signer identity ids by signer index. */
  readonly trustedSignerIdentityIds?: Readonly<Record<number, string>>;
}

/** A check run on its own, so one failure does not hide the others. */
export interface CheckResult<Id extends string> {
  readonly id: Id;
  readonly ok: boolean;
  readonly detail?: string;
}

export type RequestCheckId =
  | 'request_statement'
  | 'request_signer'
  | 'request_attestation';
export type SignatureCheckId =
  | 'signature_statement'
  | 'consent'
  | 'signature_binding'
  | 'mark_hash'
  | 'signature_webauthn'
  | 'signature_identity'
  | 'opened_receipt';

/**
 * Strictly parse a certificate's shape. Nested statements stay as records,
 * because the verifier parses each one against its kind. Throws
 * `SigningInputError` naming the field that did not parse.
 */
export function parseSigningCertificate(value: unknown): SigningCertificate {
  const top = exactObject(
    value,
    'certificate',
    [
      'access',
      'ciphertext_sha256',
      'completed_at',
      'content_mac',
      'format',
      'owner',
      'relic_id',
      'request',
      'service',
      'signatures',
      'title',
      'version',
    ],
    ['signing_key']
  );
  if (top.format !== SIGNING_CERTIFICATE_FORMAT)
    refuse('certificate', 'format');
  const service = exactObject(top.service, 'certificate', ['origin', 'rp_id']);
  requireString(service.origin, 'origin');
  requireString(service.rp_id, 'rp_id');
  if (typeof top.relic_id !== 'string' || !RELIC_ID_RE.test(top.relic_id)) {
    refuse('certificate', 'relic_id');
  }
  if (top.access !== 'public' && top.access !== 'private') {
    refuse('certificate', 'access');
  }
  if (top.title !== null && typeof top.title !== 'string') {
    refuse('certificate', 'title');
  }
  if (top.access === 'private' && top.title !== null) {
    refuse('certificate', 'a private relik has no title');
  }
  requireVersion(top.version);
  requireHex64(top.ciphertext_sha256, 'ciphertext_sha256');
  requireHex64(top.content_mac, 'content_mac');
  requireString(top.completed_at, 'completed_at');
  if (top.signing_key !== undefined) {
    requireBase64url(top.signing_key, 'signing_key', 32);
  }
  const request = parseRequestPayload(top.request);
  const owner = parseOwner(top.owner);
  if (!Array.isArray(top.signatures)) refuse('certificate', 'signatures');
  if (top.signatures.length > SIGNING_MAX_SIGNERS)
    refuse('certificate', 'too many signatures');
  // Bound all nested strings and structures before parsing or any cryptography.
  boundedCertificate(top);
  const requestSigners = parseStatement(
    'signing_request',
    request.statement
  ).signers;
  if (top.signatures.length > requestSigners.length)
    refuse('certificate', 'too many signatures for request');
  const signatures = (top.signatures as unknown[]).map(parseSignature);
  const certificate: SigningCertificate = {
    format: SIGNING_CERTIFICATE_FORMAT,
    service: {
      origin: service.origin as string,
      rp_id: service.rp_id as string,
    },
    relic_id: top.relic_id as string,
    access: top.access as 'public' | 'private',
    title: top.title as string | null,
    version: top.version as number,
    ciphertext_sha256: top.ciphertext_sha256 as string,
    content_mac: top.content_mac as string,
    request,
    owner,
    signatures,
    completed_at: top.completed_at as string,
  };
  return typeof top.signing_key === 'string'
    ? { ...certificate, signing_key: top.signing_key }
    : certificate;
}

/**
 * Verify a certificate against the file, offline. Every check runs
 * independently and is named in the report. It makes no network call and reads
 * no clock. A certificate that does not parse yields a report whose only check
 * is `format`.
 */
export async function verifySigningCertificate(
  cert: unknown,
  opts: CertificateVerifyOptions = {}
): Promise<CertificateReport> {
  let parsed: SigningCertificate;
  try {
    parsed = parseSigningCertificate(cert);
  } catch (error) {
    return unparsedReport(detailOf(error));
  }

  const checks: CertificateCheck[] = [];
  const formatCheck = await runCheck('format', () => {
    const origin = parsed.service.origin;
    if (new URL(origin).origin !== origin) refuse('certificate', 'origin');
    if (new URL(origin).hostname !== parsed.service.rp_id) {
      refuse('certificate', 'rp_id is not the origin host');
    }
    if (opts.expectedOrigin !== undefined && origin !== opts.expectedOrigin) {
      refuse('certificate', 'origin is not the expected origin');
    }
  });
  checks.push(formatCheck);
  if (!formatCheck.ok)
    return finishReport(parsed, checks, undefined, [], 'not_checked');

  const origin = parsed.service.origin;
  const rpId = parsed.service.rp_id;
  const requestChecks = await verifySigningRequest({
    request: parsed.request,
    owner: parsed.owner,
    expect: {
      access: parsed.access,
      relicId: parsed.relic_id,
      version: parsed.version,
      ciphertextSha256: parsed.ciphertext_sha256,
      contentMac: parsed.content_mac,
      origin,
      rpId,
    },
  });
  checks.push(...requestChecks);
  const requestStatement = requestStatementOf(parsed.request);

  checks.push(
    await runCheck('signers_complete', () => {
      const count = requestStatement?.signers.length ?? 0;
      const indices = parsed.signatures.map(
        (sig) => parseStatement('signature', sig.statement).signer_index
      );
      if (parsed.signatures.some((sig, i) => sig.signer_index !== indices[i])) {
        refuse('certificate', 'record index differs from signed index');
      }
      const unique = new Set(indices);
      if (
        count === 0 ||
        indices.length !== count ||
        unique.size !== count ||
        indices.some((index) => index < 0 || index >= count)
      ) {
        refuse('certificate', 'a signer has no signature, or has two');
      }
    })
  );

  for (const signature of parsed.signatures) {
    const results = await verifySignatureRecord({
      request: parsed.request,
      record: {
        statement: signature.statement,
        identity_signature: signature.identity_signature,
        mark_ciphertext: signature.mark_ciphertext,
        webauthn: signature.webauthn,
        signer_identity: signature.signer_identity,
        opened_receipt: signature.receipts?.opened ?? null,
      },
      origin,
      rpId,
    });
    for (const result of results) {
      const signedIndex = signature.statement.signer_index;
      checks.push(
        withSigner(result, typeof signedIndex === 'number' ? signedIndex : -1)
      );
    }
  }

  checks.push(
    await runCheck('order', () => {
      if (requestStatement?.order !== 'sequential') return;
      const ordered = [...parsed.signatures].sort(
        (a, b) =>
          parseStatement('signature', a.statement).signer_index -
          parseStatement('signature', b.statement).signer_index
      );
      let previous = Number.NEGATIVE_INFINITY;
      for (const signature of ordered) {
        const at = parseStatement('signature', signature.statement).at;
        if (at < previous) refuse('certificate', 'signed out of order');
        previous = at;
      }
    })
  );

  let content: 'match' | 'mismatch' | 'not_checked' = 'not_checked';
  const names = new Map<number, string | null>();
  if (opts.signingKey !== undefined) {
    const key = opts.signingKey;
    checks.push(
      await runCheck('appearance', async () => {
        const count = requestStatement?.signers.length ?? 0;
        if (requestStatement === undefined) refuse('certificate', 'no request');
        await openSigningLayout({
          signingKey: key,
          relicId: parsed.relic_id,
          version: parsed.version,
          ciphertext: parsed.request.layout_ciphertext,
          signerCount: count,
        });
        for (const signature of parsed.signatures) {
          const mark = await openSignatureMark({
            signingKey: key,
            relicId: parsed.relic_id,
            version: parsed.version,
            ciphertext: signature.mark_ciphertext,
          });
          names.set(
            parseStatement('signature', signature.statement).signer_index,
            mark.name
          );
        }
      })
    );
  }
  if (opts.signingKey !== undefined && opts.content !== undefined) {
    const mac = await contentMac(opts.signingKey, opts.content);
    const matches =
      mac === parsed.content_mac && mac === requestStatement?.content_mac;
    content = matches ? 'match' : 'mismatch';
    checks.push({
      id: 'content',
      ok: matches,
      ...(matches
        ? {}
        : { detail: 'the file does not match the signed content' }),
    });
  }

  return finishReport(
    parsed,
    checks,
    requestStatement,
    parsed.signatures,
    content,
    names,
    opts
  );
}

/**
 * Check one signature record of a request: the statement, its binding to the
 * request and file, the mark, the identity (private), the passkey assertion,
 * and the opened receipt when one is required. Never throws; each failure is a
 * named result.
 */
export async function verifySignatureRecord(input: {
  readonly request: SigningRequestPayload;
  readonly record: {
    readonly statement: Record<string, unknown>;
    readonly identity_signature: string;
    readonly mark_ciphertext: string;
    readonly webauthn: WebAuthnProofJSON;
    readonly signer_identity: IdentityPublicJSON | null;
    readonly opened_receipt: {
      readonly statement: Record<string, unknown>;
      readonly identity_signature: string;
    } | null;
  };
  readonly origin: string;
  readonly rpId: string;
}): Promise<CheckResult<SignatureCheckId>[]> {
  const { request, record } = input;
  const holder: {
    request?: SigningRequestStatement;
    signature?: SignatureStatement;
  } = {};
  const results: CheckResult<SignatureCheckId>[] = [];
  const signers = (): SigningRequestStatement['signers'] => {
    if (holder.request === undefined)
      refuse('certificate', 'request did not parse');
    return holder.request.signers;
  };
  const signature = (): SignatureStatement => {
    if (holder.signature === undefined)
      refuse('certificate', 'statement did not parse');
    return holder.signature;
  };
  const signerEntry = () => {
    const entry = signers()[signature().signer_index];
    if (entry === undefined)
      refuse('certificate', 'signer index is out of range');
    return entry;
  };
  const isPrivate = (): boolean =>
    signers().every((s) => s.identity_id !== null);

  results.push(
    await runCheck('signature_statement', () => {
      holder.request = parseStatement('signing_request', request.statement);
      holder.signature = parseStatement('signature', record.statement);
    })
  );
  results.push(
    await runCheck('consent', () => {
      if (signature().consent !== SIGN_CONSENT_ID)
        refuse('certificate', 'consent');
    })
  );
  results.push(
    await runCheck('signature_binding', async () => {
      const sig = signature();
      const req = holder.request;
      if (req === undefined) refuse('certificate', 'request did not parse');
      if (
        sig.relic_id !== req.relic_id ||
        sig.version !== req.version ||
        sig.ciphertext_sha256 !== req.ciphertext_sha256 ||
        sig.content_mac !== req.content_mac ||
        sig.request_id !== req.request_id
      ) {
        refuse(
          'certificate',
          'the signature is for another version or request'
        );
      }
      if (sig.request_sha256 !== signingRequestSha256(req)) {
        refuse('certificate', 'the request does not match its digest');
      }
      const entry = signerEntry();
      if (sig.signer_email !== entry.email)
        refuse('certificate', 'signer email');
      if (sig.signer_identity_id !== entry.identity_id) {
        refuse('certificate', 'signer identity');
      }
      if (req.require_opened) {
        if (sig.opened_receipt_sha256 === null) {
          refuse('certificate', 'a required opened receipt is missing');
        }
      } else if (sig.opened_receipt_sha256 !== null) {
        refuse('certificate', 'an opened receipt is not required');
      }
    })
  );
  results.push(
    await runCheck('mark_hash', () => {
      if (
        markCiphertextSha256(record.mark_ciphertext) !== signature().mark_sha256
      ) {
        refuse('certificate', 'the mark does not match its digest');
      }
    })
  );
  results.push(
    await runCheck('signature_webauthn', async () => {
      const challenge = await attestedChallenge(record.webauthn.nonce, [
        statementBytes('signature', signature()),
      ]);
      await verifyWebauthnAssertion(record.webauthn.credential, {
        challenge,
        origin: input.origin,
        rpId: input.rpId,
        publicKeyJwk: record.webauthn.public_key_jwk,
        alg: record.webauthn.alg,
        credentialId: record.webauthn.credential_id,
      });
    })
  );
  results.push(
    await runCheck('signature_identity', async () => {
      if (!isPrivate()) {
        if (
          record.identity_signature !== '' ||
          record.signer_identity !== null
        ) {
          refuse('certificate', 'a public signature carries an identity');
        }
        return;
      }
      const identity = record.signer_identity;
      if (identity === null)
        refuse('certificate', 'a private signature has no identity');
      const keys = await identityKeys(identity);
      if (keys.id !== signerEntry().identity_id) {
        refuse('certificate', 'the signer identity is not the pinned one');
      }
      if (identity.email !== signerEntry().email) {
        refuse(
          'certificate',
          'signer identity address differs from the request'
        );
      }
      const ok = await verifyStatement(
        keys.sig,
        statementBytes('signature', signature()),
        record.identity_signature
      );
      if (!ok) refuse('certificate', 'the identity signature does not verify');
    })
  );
  results.push(
    await runCheck('opened_receipt', async () => {
      const req = holder.request;
      if (req === undefined) refuse('certificate', 'request did not parse');
      if (!req.require_opened) {
        if (record.opened_receipt !== null)
          refuse('certificate', 'an unrequired receipt');
        return;
      }
      const opened = record.opened_receipt;
      if (opened === null)
        refuse('certificate', 'the opened receipt is missing');
      const receipt = parseStatement('open_receipt', opened.statement);
      if (
        receipt.relic_id !== req.relic_id ||
        receipt.version !== req.version ||
        receipt.ciphertext_sha256 !== req.ciphertext_sha256
      ) {
        refuse('certificate', 'the receipt is for another version');
      }
      if (receipt.reader_identity_id !== signerEntry().identity_id) {
        refuse('certificate', 'the receipt is by another identity');
      }
      const keys = await identityKeys(
        record.signer_identity ?? refuseMissing()
      );
      const ok = await verifyStatement(
        keys.sig,
        statementBytes('open_receipt', receipt),
        opened.identity_signature
      );
      if (!ok) refuse('certificate', 'the receipt signature does not verify');
      if (openReceiptSha256(receipt) !== signature().opened_receipt_sha256) {
        refuse('certificate', 'the receipt does not match its digest');
      }
    })
  );
  return results;
}

/**
 * Check a signed request: its statement and binding to the file, the signer
 * (an owner identity, or an owner device under its owner-signed certificate),
 * and the owner's passkey assertion for an identity request. Never throws.
 */
export async function verifySigningRequest(input: {
  readonly request: SigningRequestPayload;
  readonly owner: SigningCertificateOwner;
  readonly expect: {
    readonly access: 'public' | 'private';
    readonly relicId: string;
    readonly version: number;
    readonly ciphertextSha256: string;
    readonly contentMac: string;
    readonly origin: string;
    readonly rpId: string;
  };
}): Promise<CheckResult<RequestCheckId>[]> {
  const { request, owner, expect } = input;
  const holder: { statement?: SigningRequestStatement } = {};
  const statement = (): SigningRequestStatement => {
    if (holder.statement === undefined)
      refuse('certificate', 'request did not parse');
    return holder.statement;
  };
  const results: CheckResult<RequestCheckId>[] = [];

  results.push(
    await runCheck('request_statement', () => {
      const s = parseStatement('signing_request', request.statement);
      holder.statement = s;
      if (
        s.relic_id !== expect.relicId ||
        s.version !== expect.version ||
        s.ciphertext_sha256 !== expect.ciphertextSha256 ||
        s.content_mac !== expect.contentMac
      ) {
        refuse('certificate', 'the request is for another version');
      }
      if (
        s.layout_sha256 !== layoutCiphertextSha256(request.layout_ciphertext)
      ) {
        refuse('certificate', 'the layout does not match its digest');
      }
      if (s.owner_identity_id !== owner.identity.identity_id) {
        refuse('certificate', 'the request names another owner');
      }
      const anonymous = s.signers.every(
        (signer) => signer.identity_id === null
      );
      if (expect.access === 'public' && !anonymous) {
        refuse('certificate', 'a public request names identities');
      }
      if (expect.access === 'private' && anonymous) {
        refuse('certificate', 'a private request names no identities');
      }
    })
  );

  results.push(
    await runCheck('request_signer', async () => {
      const s = statement();
      if (request.signer_kind === 'identity') {
        if (s.signer_id !== s.owner_identity_id) {
          refuse('certificate', 'the signer is not the owner identity');
        }
        const keys = await identityKeys(owner.identity);
        const ok = await verifyStatement(
          keys.sig,
          statementBytes('signing_request', s),
          request.signature
        );
        if (!ok) refuse('certificate', 'the owner signature does not verify');
        return;
      }
      await verifyDeviceRequest(s, request, owner);
    })
  );

  results.push(
    await runCheck('request_attestation', async () => {
      if (request.signer_kind === 'device') {
        if (request.attestation !== null) {
          refuse('certificate', 'a device request carries an attestation');
        }
        return;
      }
      const attestation = request.attestation;
      if (attestation === null)
        refuse('certificate', 'the owner passkey is missing');
      const challenge = await attestedChallenge(attestation.nonce, [
        statementBytes('signing_request', statement()),
      ]);
      await verifyWebauthnAssertion(attestation.credential, {
        challenge,
        origin: expect.origin,
        rpId: expect.rpId,
        publicKeyJwk: attestation.public_key_jwk,
        alg: attestation.alg,
        credentialId: attestation.credential_id,
      });
    })
  );
  return results;
}

async function verifyDeviceRequest(
  s: SigningRequestStatement,
  request: SigningRequestPayload,
  owner: SigningCertificateOwner
): Promise<void> {
  const device = owner.device;
  if (device === null)
    refuse('certificate', 'a device signed the request but no device is given');
  if (device.owner_identity_id !== s.owner_identity_id) {
    refuse('certificate', 'the device belongs to another owner');
  }
  const ownerKeys = await identityKeys(owner.identity);
  const kem = decodeBase64url(device.kem_public_key);
  const sig = decodeBase64url(device.sig_public_key);
  if ((await deviceIdOf(kem, sig)) !== s.signer_id) {
    refuse('certificate', 'the signer is not the device');
  }
  const cert = parseStatement('device_cert', device.cert.statement);
  if (
    cert.device_id !== device.device_id ||
    cert.owner_identity_id !== device.owner_identity_id ||
    cert.kem_public_key !== device.kem_public_key ||
    cert.sig_public_key !== device.sig_public_key ||
    cert.not_after !== device.not_after ||
    cert.label !== device.label ||
    cert.device_fingerprint_typed !== (await deviceFingerprint(cert.device_id))
  ) {
    refuse('certificate', 'the device certificate names another device');
  }
  const certOk = await verifyStatement(
    ownerKeys.sig,
    statementBytes('device_cert', cert),
    device.cert.identity_signature
  );
  if (!certOk)
    refuse('certificate', 'the device certificate is not owner-signed');
  if (cert.at > s.at || s.at > cert.not_after) {
    refuse(
      'certificate',
      'the device certificate was not valid at the request time'
    );
  }
  const ok = await verifyStatement(
    sig,
    statementBytes('signing_request', s),
    request.signature
  );
  if (!ok) refuse('certificate', 'the device signature does not verify');
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

async function hkdf(
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    toBuffer(ikm),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: toBuffer(info),
    },
    material,
    bytes * 8
  );
  return new Uint8Array(bits);
}

async function sealAppearance(
  signingKey: Uint8Array,
  kind: 'layout' | 'mark',
  relicId: string,
  version: number,
  value: object,
  maxBytes: number
): Promise<string> {
  requireBytes(signingKey, 32, 'signing key');
  const plaintext = utf8(appearanceJson(value));
  if (plaintext.length > maxBytes) refuse(kind, 'too large');
  const key = await appearanceKey(signingKey);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toBuffer(nonce),
        additionalData: toBuffer(appearanceAad(kind, relicId, version)),
        tagLength: 128,
      },
      key,
      toBuffer(plaintext)
    )
  );
  return encodeBase64url(concat(nonce, sealed));
}

async function openAppearance(
  signingKey: Uint8Array,
  kind: 'layout' | 'mark',
  relicId: string,
  version: number,
  ciphertext: string,
  maxBytes: number
): Promise<unknown> {
  requireBytes(signingKey, 32, 'signing key');
  let sealed: Uint8Array;
  try {
    sealed = decodeBase64url(ciphertext);
  } catch {
    refuse('appearance', 'not base64url');
  }
  if (
    sealed.length < NONCE_BYTES + TAG_BYTES ||
    sealed.length > NONCE_BYTES + maxBytes + TAG_BYTES
  ) {
    refuse('appearance', 'the length is out of range');
  }
  const key = await appearanceKey(signingKey);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toBuffer(sealed.subarray(0, NONCE_BYTES)),
          additionalData: toBuffer(appearanceAad(kind, relicId, version)),
          tagLength: 128,
        },
        key,
        toBuffer(sealed.subarray(NONCE_BYTES))
      )
    );
  } catch {
    refuse('appearance', 'did not open under this key, relik and version');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (appearanceJson(parsed) !== text) refuse('appearance', 'not canonical');
  } catch {
    refuse('appearance', 'not canonical JSON');
  }
  return parsed;
}

async function appearanceKey(signingKey: Uint8Array): Promise<CryptoKey> {
  const bits = await hkdf(signingKey, APPEARANCE_LABEL, 16);
  return crypto.subtle.importKey(
    'raw',
    toBuffer(bits),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Canonical JSON for sealed appearance values: sorted keys, no whitespace, and
 * finite numbers in their shortest round-trip form. A rectangle's coordinates
 * are fractions, which `canonicalJson` refuses by design, so the statement
 * serializer stays integer-only and this one is used for appearance values alone.
 */
function appearanceJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('appearance', 'not a finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(appearanceJson).join(',')}]`;
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${appearanceJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  refuse('appearance', 'not a JSON value');
}

function appearanceAad(
  kind: 'layout' | 'mark',
  relicId: string,
  version: number
): Uint8Array {
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version);
  return concat(utf8(kind), Uint8Array.of(0), utf8(relicId), versionBytes);
}

function parseBox(value: unknown, signerCount: number): SigningBox {
  const box = exactObject(value, 'layout', ['page', 'rect', 'signer']);
  const signer = box.signer;
  if (
    !Number.isSafeInteger(signer) ||
    (signer as number) < 0 ||
    (signer as number) >= signerCount
  ) {
    refuse('layout', 'signer');
  }
  const page = box.page;
  if (
    !Number.isSafeInteger(page) ||
    (page as number) < 1 ||
    (page as number) > SIGNING_MAX_PAGE
  ) {
    refuse('layout', 'page');
  }
  const rect = exactObject(box.rect, 'layout', ['h', 'w', 'x', 'y']);
  const x = unitNumber(rect.x);
  const y = unitNumber(rect.y);
  const w = unitNumber(rect.w);
  const h = unitNumber(rect.h);
  if (w === 0 || h === 0 || x + w > 1 || y + h > 1) refuse('layout', 'rect');
  return {
    signer: signer as number,
    page: page as number,
    rect: { x, y, w, h },
  };
}

function unitNumber(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    refuse('layout', 'rect coordinate');
  }
  return value;
}

function isUnitDecimal(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1 &&
    Number(value.toFixed(3)) === value
  );
}

function parseRequestPayload(value: unknown): SigningRequestPayload {
  const object = exactObject(value, 'certificate', [
    'attestation',
    'layout_ciphertext',
    'signature',
    'signer_kind',
    'statement',
  ]);
  if (!isPlainObject(object.statement))
    refuse('certificate', 'request statement');
  requireString(object.signature, 'request signature');
  requireString(object.layout_ciphertext, 'layout_ciphertext');
  if (
    (object.layout_ciphertext as string).length >
    Math.ceil(((SIGNING_LAYOUT_MAX_BYTES + 28) * 4) / 3)
  )
    refuse('certificate', 'layout ciphertext too large');
  if (object.signer_kind !== 'identity' && object.signer_kind !== 'device') {
    refuse('certificate', 'signer_kind');
  }
  return {
    statement: object.statement,
    signature: object.signature as string,
    signer_kind: object.signer_kind,
    attestation:
      object.attestation === null ? null : parseAttestation(object.attestation),
    layout_ciphertext: object.layout_ciphertext as string,
  };
}

function parseOwner(value: unknown): SigningCertificateOwner {
  const object = exactObject(value, 'certificate', ['device', 'identity']);
  const identity = parseIdentity(object.identity);
  if (object.device === null) return { identity, device: null };
  const device = exactObject(
    object.device,
    'certificate',
    [
      'backend',
      'cert',
      'certified_at',
      'device_id',
      'kem_public_key',
      'label',
      'not_after',
      'owner_identity_id',
      'revoked_at',
      'sig_public_key',
    ],
    ['revocation']
  );
  const cert = exactObject(device.cert, 'certificate', [
    'identity_signature',
    'statement',
  ]);
  if (!isPlainObject(cert.statement))
    refuse('certificate', 'device cert statement');
  requireString(cert.identity_signature, 'device cert signature');
  requireString(device.device_id, 'device_id');
  requireString(device.kem_public_key, 'device kem key');
  requireString(device.sig_public_key, 'device sig key');
  requireString(device.label, 'device label');
  requireString(device.owner_identity_id, 'device owner');
  requireString(device.certified_at, 'device certified_at');
  if (!Number.isSafeInteger(device.not_after))
    refuse('certificate', 'device not_after');
  return {
    identity,
    device: device as unknown as DevicePublicJSON,
  };
}

function parseIdentity(value: unknown): IdentityPublicJSON {
  const object = exactObject(value, 'certificate', [
    'created_at',
    'email',
    'identity_id',
    'kem_public_key',
    'retired_at',
    'sig_public_key',
  ]);
  requireString(object.identity_id, 'identity_id');
  requireString(object.email, 'identity email');
  requireString(object.kem_public_key, 'identity kem key');
  requireString(object.sig_public_key, 'identity sig key');
  requireString(object.created_at, 'identity created_at');
  if (object.retired_at !== null && typeof object.retired_at !== 'string') {
    refuse('certificate', 'identity retired_at');
  }
  return object as unknown as IdentityPublicJSON;
}

function parseAttestation(value: unknown): WebAuthnProofJSON {
  const object = exactObject(value, 'certificate', [
    'alg',
    'credential',
    'credential_id',
    'nonce',
    'passkey_registered_at',
    'public_key_jwk',
  ]);
  if (object.alg !== -7 && object.alg !== -257) refuse('certificate', 'alg');
  if (!isPlainObject(object.credential)) refuse('certificate', 'credential');
  if (!isPlainObject(object.public_key_jwk))
    refuse('certificate', 'public_key_jwk');
  requireString(object.credential_id, 'credential_id');
  requireString(object.nonce, 'nonce');
  if (
    object.passkey_registered_at !== null &&
    typeof object.passkey_registered_at !== 'string'
  ) {
    refuse('certificate', 'passkey_registered_at');
  }
  return object as unknown as WebAuthnProofJSON;
}

function parseSignature(value: unknown): SigningCertificateSignature {
  const object = exactObject(value, 'certificate', [
    'identity_signature',
    'mark_ciphertext',
    'receipts',
    'recorded_at',
    'signer_identity',
    'signer_index',
    'statement',
    'webauthn',
  ]);
  if (
    !Number.isSafeInteger(object.signer_index) ||
    (object.signer_index as number) < 0
  ) {
    refuse('certificate', 'signer_index');
  }
  if (!isPlainObject(object.statement))
    refuse('certificate', 'signature statement');
  requireString(object.identity_signature, 'identity_signature');
  requireString(object.mark_ciphertext, 'mark_ciphertext');
  if (
    (object.mark_ciphertext as string).length >
    Math.ceil(((SIGNING_MARK_MAX_BYTES + 28) * 4) / 3)
  )
    refuse('certificate', 'mark ciphertext too large');
  requireString(object.recorded_at, 'recorded_at');
  const identity =
    object.signer_identity === null
      ? null
      : parseIdentity(object.signer_identity);
  const webauthn = parseAttestation(object.webauthn);
  let receipts: SigningCertificateSignature['receipts'] = null;
  if (object.receipts !== null) {
    const r = exactObject(object.receipts, 'certificate', [
      'opened',
      'served_at',
    ]);
    if (r.served_at !== null && typeof r.served_at !== 'string') {
      refuse('certificate', 'served_at');
    }
    let opened: {
      statement: Record<string, unknown>;
      identity_signature: string;
    } | null = null;
    if (r.opened !== null) {
      const o = exactObject(r.opened, 'certificate', [
        'identity_signature',
        'statement',
      ]);
      if (!isPlainObject(o.statement))
        refuse('certificate', 'receipt statement');
      requireString(o.identity_signature, 'receipt signature');
      opened = {
        statement: o.statement,
        identity_signature: o.identity_signature as string,
      };
    }
    receipts = { served_at: r.served_at as string | null, opened };
  }
  return {
    signer_index: object.signer_index as number,
    statement: object.statement,
    identity_signature: object.identity_signature as string,
    signer_identity: identity,
    mark_ciphertext: object.mark_ciphertext as string,
    webauthn,
    recorded_at: object.recorded_at as string,
    receipts,
  };
}

function requestStatementOf(
  request: SigningRequestPayload
): SigningRequestStatement | undefined {
  try {
    return parseStatement('signing_request', request.statement);
  } catch {
    return undefined;
  }
}

async function identityKeys(
  identity: IdentityPublicJSON
): Promise<{ id: string; sig: Uint8Array }> {
  const kem = decodeBase64url(identity.kem_public_key);
  const sig = decodeBase64url(identity.sig_public_key);
  const id = await identityIdOf(kem, sig);
  if (id !== identity.identity_id)
    refuse('certificate', 'identity id does not match its keys');
  return { id, sig };
}

/** The challenge a passkey answers: SHA-256 of the attestation label, nonce and statement digests, base64url. */
async function attestedChallenge(
  nonceText: string,
  statements: Uint8Array[]
): Promise<string> {
  const nonce = decodeBase64url(nonceText);
  return encodeBase64url(await attestationChallenge(nonce, statements));
}

function refuseMissing(): never {
  refuse('certificate', 'the identity is missing');
}

function withSigner(
  result: CheckResult<SignatureCheckId>,
  index: number
): CertificateCheck {
  return {
    id: result.id,
    ok: result.ok,
    signer_index: index,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

async function runCheck<Id extends string>(
  id: Id,
  body: () => void | Promise<void>
): Promise<CheckResult<Id>> {
  try {
    await body();
    return { id, ok: true };
  } catch (error) {
    return { id, ok: false, detail: detailOf(error) };
  }
}

function detailOf(error: unknown): string {
  if (error instanceof RelicFormatError) return error.message;
  if (error instanceof WebauthnAssertionError) return error.message;
  return 'could not be verified';
}

async function finishReport(
  parsed: SigningCertificate,
  checks: readonly CertificateCheck[],
  requestStatement: SigningRequestStatement | undefined,
  signatures: readonly SigningCertificateSignature[],
  content: 'match' | 'mismatch' | 'not_checked',
  names: ReadonlyMap<number, string | null> = new Map(),
  opts: CertificateVerifyOptions = {}
): Promise<CertificateReport> {
  const owner = await ownerSummary(parsed);
  const signers: CertificateSigner[] = [];
  for (const [index, entry] of (requestStatement?.signers ?? []).entries()) {
    const signature = signatures.find(
      (sig) => sig.statement.signer_index === index
    );
    const opened = signature?.receipts?.opened ?? null;
    signers.push({
      index,
      email: entry.email,
      signed_at: signature === undefined ? null : signedAt(signature),
      recorded_at: signature?.recorded_at ?? null,
      credential_id: signature?.webauthn.credential_id ?? null,
      identity_fingerprint: await signerFingerprint(signature),
      opened: parsed.access === 'private' ? opened !== null : null,
      name: names.get(index) ?? null,
    });
  }
  const ownerTrust =
    opts.trustedOwnerIdentityId === undefined
      ? 'unchecked'
      : opts.trustedOwnerIdentityId === requestStatement?.owner_identity_id
        ? 'matches'
        : 'mismatch';
  const signerTrust = (requestStatement?.signers ?? []).map((entry, index) => {
    const expected = opts.trustedSignerIdentityIds?.[index];
    return {
      index,
      status:
        expected === undefined
          ? ('unchecked' as const)
          : expected === entry.identity_id
            ? ('matches' as const)
            : ('mismatch' as const),
      method:
        entry.identity_id === null
          ? ('trust_on_first_use' as const)
          : ('identity_id' as const),
    };
  });
  const internalConsistency =
    checks.every((check) => check.ok) && checks.length > 0;
  return {
    valid:
      internalConsistency &&
      ownerTrust === 'matches' &&
      signerTrust.every((s) => s.status !== 'mismatch'),
    internal_consistency: internalConsistency,
    trust: { owner: ownerTrust, signers: signerTrust },
    checks,
    relic_id: parsed.relic_id,
    version: parsed.version,
    access: parsed.access,
    completed_at: parsed.completed_at,
    origin: parsed.service.origin,
    owner,
    signers,
    content,
  };
}

function signedAt(signature: SigningCertificateSignature): number | null {
  try {
    return parseStatement('signature', signature.statement).at;
  } catch {
    return null;
  }
}

async function signerFingerprint(
  signature: SigningCertificateSignature | undefined
): Promise<string | null> {
  const identity = signature?.signer_identity;
  if (identity === null || identity === undefined) return null;
  try {
    const keys = await identityKeys(identity);
    return keys.id;
  } catch {
    return null;
  }
}

async function ownerSummary(
  parsed: SigningCertificate
): Promise<CertificateReport['owner']> {
  try {
    const { email } = parsed.owner.identity;
    const keys = await identityKeys(parsed.owner.identity);
    return {
      email,
      email_status: 'claimed',
      identity_id: keys.id,
      fingerprint: keys.id,
    };
  } catch {
    return null;
  }
}

/** Bound untrusted certificate structures before hashing, key imports, or signature checks. */
function boundedCertificate(value: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (++nodes > 20_000 || item.depth > 24)
      refuse('certificate', 'structure too large');
    if (typeof item.value === 'string') {
      if (item.value.length > 48_000) refuse('certificate', 'field too large');
    } else if (Array.isArray(item.value)) {
      if (item.value.length > 100) refuse('certificate', 'array too large');
      for (const child of item.value)
        stack.push({ value: child, depth: item.depth + 1 });
    } else if (isPlainObject(item.value)) {
      const keys = Object.keys(item.value);
      if (keys.length > 100) refuse('certificate', 'object too large');
      for (const key of keys) {
        if (key.length > 1024) refuse('certificate', 'field name too large');
        stack.push({ value: item.value[key], depth: item.depth + 1 });
      }
    } else if (
      item.value !== null &&
      typeof item.value !== 'number' &&
      typeof item.value !== 'boolean'
    ) {
      refuse('certificate', 'invalid value');
    }
  }
}

function unparsedReport(detail: string): CertificateReport {
  return {
    valid: false,
    internal_consistency: false,
    trust: { owner: 'unchecked', signers: [] },
    checks: [{ id: 'format', ok: false, detail }],
    relic_id: null,
    version: null,
    access: null,
    completed_at: null,
    origin: null,
    owner: null,
    signers: [],
    content: 'not_checked',
  };
}

function exactObject(
  value: unknown,
  what: 'layout' | 'mark' | 'certificate',
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!isPlainObject(value)) refuse(what, 'not an object');
  for (const key of required) {
    if (!Object.hasOwn(value, key)) refuse(what, `missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      refuse(what, `unknown field ${key}`);
    }
  }
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string') refuse('certificate', field);
}

function requireVersion(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    refuse('certificate', 'version');
  }
}

function requireHex64(value: unknown, field: string): void {
  if (typeof value !== 'string' || !HEX64_RE.test(value))
    refuse('certificate', field);
}

function requireBase64url(value: unknown, field: string, bytes: number): void {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value))
    refuse('certificate', field);
  if (decodeBase64url(value as string).length !== bytes)
    refuse('certificate', field);
}

function requireBytes(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) {
    throw new SigningInputError('key', `${what} must be ${length} bytes`);
  }
}

function refuse(
  what: 'layout' | 'mark' | 'appearance' | 'key' | 'certificate',
  reason: string
): never {
  throw new SigningInputError(what, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

async function* chunksOf(content: ContentBytes): AsyncGenerator<Uint8Array> {
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  for await (const chunk of content) yield chunk;
}

function xorPad(block: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = (block[i] ?? 0) ^ byte;
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A copy of exactly this view's bytes, as WebCrypto requires. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
