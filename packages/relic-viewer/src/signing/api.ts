import type { RequestOptionsJSON } from '@relic/format';
import { parseStatement } from '@relic/format/private';
import {
  contentMac,
  openSigningLayout,
  type SigningCertificate,
  type SigningLayout,
  type SigningRequestJSON,
  type SigningStateJSON,
  verifySigningRequest,
} from '@relic/format/signing';
import { CONTENT_BATCH_BYTES, type RelicContent } from '../content.ts';
import { postJson } from '../private/keys.ts';
import type { ViewerDeps } from '../viewer.ts';

export interface SigningOptions {
  readonly nonce: string;
  readonly expires_at: string;
  readonly public_key: Omit<RequestOptionsJSON, 'challenge'>;
  readonly request_id: string;
  readonly version: number;
  readonly version_digest: string;
  readonly content_mac: string;
  readonly request_sha256: string;
  readonly signer_index: number;
  readonly signer_identity_id: string | null;
  readonly opened_receipt_sha256: string | null;
  readonly consent: { readonly id: string; readonly text: string };
}

/** The public proof is omitted for private reliks. Keys never go on the wire. */
export function signingApi(
  deps: ViewerDeps,
  relicId: string,
  shareProof?: string
) {
  const base = `/api/relics/${encodeURIComponent(relicId)}/signing`;
  const proof = shareProof === undefined ? {} : { share_proof: shareProof };
  return {
    read: () =>
      postJson(deps, `${base}/read`, proof) as Promise<SigningStateJSON>,
    options: (requestId: string) =>
      postJson(deps, `${base}/options`, {
        ...proof,
        request_id: requestId,
      }) as Promise<SigningOptions>,
    signature: (
      requestId: string,
      attestation: unknown,
      markCiphertext: string
    ) =>
      postJson(deps, `${base}/signatures`, {
        ...proof,
        request_id: requestId,
        attestation,
        mark_ciphertext: markCiphertext,
      }),
    request: (attestation: unknown, layoutCiphertext: string) =>
      postJson(deps, `${base}/requests`, {
        attestation,
        layout_ciphertext: layoutCiphertext,
      }) as Promise<SigningRequestJSON>,
    cancel: (attestation: unknown) =>
      postJson(deps, `${base}/cancel`, {
        attestation,
      }) as Promise<SigningRequestJSON>,
    certificate: (requestId: string) =>
      postJson(deps, `${base}/certificate`, {
        ...proof,
        request_id: requestId,
      }) as Promise<SigningCertificate>,
  };
}

/** Hash the original decrypted stream, including a folder's manifest. */
export async function* signingContent(
  content: RelicContent
): AsyncIterable<Uint8Array> {
  for (let start = 0; start < content.size; start += CONTENT_BATCH_BYTES) {
    yield await content.read(
      start,
      Math.min(start + CONTENT_BATCH_BYTES, content.size)
    );
  }
}

/** Refuse a request before showing its layout unless its complete chain and content match. */
export async function verifyViewerSigningRequest(input: {
  readonly request: SigningRequestJSON;
  readonly relicId: string;
  readonly version: number;
  readonly digest: string;
  readonly content: RelicContent;
  readonly signingKey: Uint8Array;
  readonly access: 'public' | 'private';
  readonly origin: string;
  readonly pinnedOwnerIdentityId?: string;
  readonly pdf: boolean;
}): Promise<SigningLayout> {
  const { request } = input;
  if (
    input.access === 'private' &&
    request.owner.identity.identity_id !== input.pinnedOwnerIdentityId
  ) {
    throw new Error('signing_owner_mismatch');
  }
  const statement = parseStatement(
    'signing_request',
    request.request.statement
  );
  const checks = await verifySigningRequest({
    request: request.request,
    owner: request.owner,
    expect: {
      access: input.access,
      relicId: input.relicId,
      version: input.version,
      ciphertextSha256: statement.ciphertext_sha256,
      contentMac: statement.content_mac,
      origin: input.origin,
      rpId: new URL(input.origin).hostname,
    },
  });
  if (checks.some((check) => !check.ok))
    throw new Error('signing_request_invalid');
  if (statement.ciphertext_sha256 !== input.digest)
    throw new Error('signing_digest_mismatch');
  const mac = await contentMac(input.signingKey, signingContent(input.content));
  if (mac !== statement.content_mac)
    throw new Error('signing_content_mismatch');
  if (
    request.request_id !== statement.request_id ||
    request.version !== statement.version
  ) {
    throw new Error('signing_request_invalid');
  }
  const layout = await openSigningLayout({
    signingKey: input.signingKey,
    relicId: input.relicId,
    version: input.version,
    ciphertext: request.request.layout_ciphertext,
    signerCount: statement.signers.length,
  });
  if (!input.pdf && layout.boxes.length !== 0)
    throw new Error('signing_layout_invalid');
  return layout;
}
