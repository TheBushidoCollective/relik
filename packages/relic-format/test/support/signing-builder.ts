/**
 * Builds a signing certificate that verifies, for tests. Every signature is
 * made with fresh keys through the package's own statement and digest helpers,
 * so a test starts from a valid certificate and breaks exactly one thing.
 *
 * The keys live only in the returned object. Nothing here is a secret: the
 * test certificates are never used outside the test run.
 */

import {
  attestationChallenge,
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  generateIdentityKeys,
  type IdentityKeys,
  type IdentityPublicJSON,
  type SignatureStatement,
  type SigningRequestStatement,
  type SigningSignerEntry,
  signStatement,
  statementBytes,
} from '../../src/private.ts';
import {
  contentMac,
  deriveSigningKey,
  layoutCiphertextSha256,
  markCiphertextSha256,
  openReceiptSha256,
  SIGN_CONSENT_ID,
  SIGNING_CERTIFICATE_FORMAT,
  sealSignatureMark,
  sealSigningLayout,
  signingRequestSha256,
  type SigningLayout,
  type WebAuthnProofJSON,
} from '../../src/signing.ts';
import { sha256Hex } from '../../src/sha256.ts';
import {
  type VirtualPasskey,
  virtualPasskey,
  toBuffer,
  utf8,
} from './virtual-passkey.ts';

export const RELIC_ID = '7k2m9qxah3tb0p4dvw8cr1nezf';
export const VERSION = 3;
export const ORIGIN = 'https://relik.link';
export const RP_ID = 'relik.link';
export const TITLE = 'Studio lease, Unit 4B';
export const CONTENT = utf8(
  'Studio lease, Unit 4B. The tenant pays rent on the first of each month.'
);
export const T0 = 1767225600000;

export interface BuildOptions {
  readonly access: 'public' | 'private';
  readonly signers: number;
  readonly order?: 'parallel' | 'sequential';
  /** Private only. */
  readonly requireOpened?: boolean;
  readonly requestSigner?: 'identity' | 'device';
  /** Per-signer signing times. Defaults to one minute apart, in order. */
  readonly signAt?: readonly number[];
  readonly deviceNotAfter?: number;
  /** Test only: name a signer other than the one signing the request. */
  readonly signerIdOverride?: string;
  readonly content?: Uint8Array;
  readonly origin?: string;
}

export interface Built {
  /** The certificate as JSON. Tests clone and mutate it, so it is typed loosely. */
  readonly cert: Record<string, unknown>;
  readonly signingKey: Uint8Array;
  readonly content: Uint8Array;
  readonly owner: IdentityKeys;
  readonly passkeys: readonly VirtualPasskey[];
  readonly signerKeys: readonly IdentityKeys[];
  readonly layoutCiphertext: string;
  readonly markCiphertexts: readonly string[];
  readonly origin: string;
  readonly rpId: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Deterministic 32-byte key material: the content key is fixed so the MAC vector is too. */
const CONTENT_KEY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

export async function buildCertificate(options: BuildOptions): Promise<Built> {
  const origin = options.origin ?? ORIGIN;
  const rpId = new URL(origin).hostname;
  const count = options.signers;
  const isPrivate = options.access === 'private';
  const requireOpened = isPrivate && options.requireOpened === true;
  const requestSigner = options.requestSigner ?? 'identity';
  const content = options.content ?? CONTENT;

  const signingKey = await deriveSigningKey(CONTENT_KEY);
  const mac = await contentMac(signingKey, content);
  const ciphertextSha256 = sha256Hex(utf8('the stored ciphertext, for tests'));
  const owner = await generateIdentityKeys();
  const ownerWire = identityWire(owner, 'owner@relik.test');
  const ownerPasskey = await virtualPasskey();

  const emails = Array.from(
    { length: count },
    (_, i) => `signer${i}@harbor.test`
  );
  const signerKeys = isPrivate
    ? await Promise.all(
        Array.from({ length: count }, () => generateIdentityKeys())
      )
    : [];
  const passkeys = await Promise.all(
    Array.from({ length: count }, () => virtualPasskey())
  );

  const layout: SigningLayout = isPrivate
    ? { v: 1, boxes: [] }
    : {
        v: 1,
        boxes: Array.from({ length: count }, (_, i) => ({
          signer: i,
          page: 1,
          rect: { x: 0.1, y: 0.1 + i * 0.1, w: 0.3, h: 0.05 },
        })),
      };
  const layoutCiphertext = await sealSigningLayout({
    signingKey,
    relicId: RELIC_ID,
    version: VERSION,
    layout,
    signerCount: count,
    pdf: !isPrivate,
  });

  const signers: SigningSignerEntry[] = emails.map((email, i) => ({
    email,
    identity_id: isPrivate ? (signerKeys[i]?.identityId ?? null) : null,
  }));

  const device =
    requestSigner === 'device' ? await generateIdentityKeys() : undefined;
  const deviceId =
    device === undefined
      ? undefined
      : await deviceIdOf(device.kemPublicKey, device.sigPublicKey);
  const signerId = deviceId ?? owner.identityId;

  const requestStatement: SigningRequestStatement = {
    at: T0,
    ciphertext_sha256: ciphertextSha256,
    consent: SIGN_CONSENT_ID,
    content_mac: mac,
    layout_sha256: layoutCiphertextSha256(layoutCiphertext),
    order: options.order ?? 'parallel',
    owner_identity_id: owner.identityId,
    relic_id: RELIC_ID,
    request_id: encodeBase64url(
      Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)
    ),
    require_opened: requireOpened,
    signer_id: options.signerIdOverride ?? signerId,
    signers,
    version: VERSION,
  };
  const requestBytes = statementBytes('signing_request', requestStatement);

  let requestSignature: string;
  let attestation: WebAuthnProofJSON | null = null;
  let deviceWire: Record<string, unknown> | null = null;
  if (device !== undefined && deviceId !== undefined) {
    const certStatement = {
      at: T0 - 60_000,
      device_fingerprint_typed: await deviceFingerprint(deviceId),
      device_id: deviceId,
      kem_public_key: encodeBase64url(device.kemPublicKey),
      label: 'test laptop',
      not_after: options.deviceNotAfter ?? T0 + 86_400_000,
      owner_identity_id: owner.identityId,
      sig_public_key: encodeBase64url(device.sigPublicKey),
    };
    const certSignature = await signStatement(
      signWith(owner),
      statementBytes('device_cert', certStatement)
    );
    deviceWire = {
      backend: 'file',
      cert: {
        statement: { ...certStatement },
        identity_signature: certSignature,
      },
      certified_at: iso(T0 - 60_000),
      device_id: deviceId,
      kem_public_key: certStatement.kem_public_key,
      label: certStatement.label,
      not_after: certStatement.not_after,
      owner_identity_id: owner.identityId,
      revoked_at: null,
      sig_public_key: certStatement.sig_public_key,
    };
    requestSignature = await signStatement(signWith(device), requestBytes);
  } else {
    requestSignature = await signStatement(signWith(owner), requestBytes);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const credential = await ownerPasskey.assert({
      challenge: encodeBase64url(
        await attestationChallenge(nonce, [requestBytes])
      ),
      origin,
      rpId,
    });
    attestation = {
      nonce: encodeBase64url(nonce),
      credential,
      credential_id: ownerPasskey.credentialId,
      public_key_jwk: ownerPasskey.publicKeyJwk,
      alg: -7,
      passkey_registered_at: null,
    };
  }

  const signatures: Record<string, unknown>[] = [];
  const markCiphertexts: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = options.signAt?.[i] ?? T0 + 60_000 * (i + 1);
    const markCiphertext = await sealSignatureMark({
      signingKey,
      relicId: RELIC_ID,
      version: VERSION,
      mark: { v: 1, name: `Signer ${i}`, strokes: null },
    });
    markCiphertexts.push(markCiphertext);

    const signerKey = signerKeys[i];
    const receipt =
      isPrivate && signerKey !== undefined
        ? {
            at: at - 1,
            ciphertext_sha256: ciphertextSha256,
            key_commitment: sha256Hex(utf8(`commitment ${i}`)),
            reader_identity_id: signerKey.identityId,
            relic_id: RELIC_ID,
            version: VERSION,
          }
        : null;
    const statement: SignatureStatement = {
      at,
      ciphertext_sha256: ciphertextSha256,
      consent: SIGN_CONSENT_ID,
      content_mac: mac,
      mark_sha256: markCiphertextSha256(markCiphertext),
      opened_receipt_sha256:
        requireOpened && receipt !== null ? openReceiptSha256(receipt) : null,
      relic_id: RELIC_ID,
      request_id: requestStatement.request_id,
      request_sha256: signingRequestSha256(requestStatement),
      signer_email: emails[i] as string,
      signer_identity_id: signerKey?.identityId ?? null,
      signer_index: i,
      version: VERSION,
    };
    const signatureBytes = statementBytes('signature', statement);
    const identitySignature =
      signerKey === undefined
        ? ''
        : await signStatement(signWith(signerKey), signatureBytes);

    const passkey = passkeys[i] as VirtualPasskey;
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const credential = await passkey.assert({
      challenge: encodeBase64url(
        await attestationChallenge(nonce, [signatureBytes])
      ),
      origin,
      rpId,
    });
    const webauthn: WebAuthnProofJSON = {
      nonce: encodeBase64url(nonce),
      credential,
      credential_id: passkey.credentialId,
      public_key_jwk: passkey.publicKeyJwk,
      alg: -7,
      passkey_registered_at: null,
    };

    let receipts: Record<string, unknown> | null = null;
    if (isPrivate) {
      const opened =
        requireOpened && receipt !== null && signerKey !== undefined
          ? {
              statement: { ...receipt },
              identity_signature: await signStatement(
                signWith(signerKey),
                statementBytes('open_receipt', receipt)
              ),
            }
          : null;
      receipts = { served_at: iso(at - 2), opened };
    }

    signatures.push({
      signer_index: i,
      statement: { ...statement },
      identity_signature: identitySignature,
      signer_identity:
        signerKey === undefined
          ? null
          : identityWire(signerKey, emails[i] as string),
      mark_ciphertext: markCiphertext,
      webauthn,
      recorded_at: iso(at + 1),
      receipts,
    });
  }

  const cert = {
    format: SIGNING_CERTIFICATE_FORMAT,
    service: { origin, rp_id: rpId },
    relic_id: RELIC_ID,
    access: options.access,
    title: isPrivate ? null : TITLE,
    version: VERSION,
    ciphertext_sha256: ciphertextSha256,
    content_mac: mac,
    request: {
      statement: { ...requestStatement },
      signature: requestSignature,
      signer_kind: requestSigner,
      attestation,
      layout_ciphertext: layoutCiphertext,
    },
    owner: { identity: ownerWire, device: deviceWire },
    signatures,
    completed_at: iso(T0 + 600_000),
  };

  return {
    cert,
    signingKey,
    content,
    owner,
    passkeys,
    signerKeys,
    layoutCiphertext,
    markCiphertexts,
    origin,
    rpId,
  };
}

/** A signing function over one key pair's private half, in the shape `signStatement` takes. */
function signWith(
  keys: IdentityKeys | { sig: CryptoKeyPair }
): (bytes: Uint8Array) => Promise<Uint8Array> {
  const privateKey =
    'sig' in keys ? keys.sig.privateKey : (keys as IdentityKeys).sig.privateKey;
  return async (bytes) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        toBuffer(bytes)
      )
    );
}

export function identityWire(
  keys: IdentityKeys,
  email: string
): IdentityPublicJSON {
  return {
    identity_id: keys.identityId,
    email,
    kem_public_key: encodeBase64url(keys.kemPublicKey),
    sig_public_key: encodeBase64url(keys.sigPublicKey),
    created_at: iso(T0 - 3_600_000),
    retired_at: null,
  };
}

/** A deep copy the test can change without touching the built certificate. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
