import { writeFile } from 'node:fs/promises';
import { decodeKey } from '@relic/format';
import { encodeBase64url } from '@relic/format/private';
import {
  deriveSigningKey,
  openSignatureMark,
  openSigningLayout,
  parseSigningCertificate,
  type SigningStateJSON,
} from '@relic/format/signing';
import type { StatementMap } from '@relic/format/private';
import { localRelic } from './comments.ts';
import {
  deviceSigner,
  loadDeviceEntry,
  signDeviceStatement,
} from './device.ts';
import { type PublishDeps, postJson, PublishError } from './publish.ts';
import { privateVersionKey } from './private.ts';

export async function readSigning(
  input: { relicId: string; requestId?: string; saveCertificateTo?: string },
  deps: PublishDeps
) {
  const local = await localRelic(input.relicId);
  const value = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relicId}/signing/read`,
    {
      publish_token: local.state.publish_token,
    }
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>)['relic_id'] !== input.relicId ||
    !Array.isArray((value as Record<string, unknown>)['requests'])
  ) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned invalid signing state.'
    );
  }
  const state = value as unknown as SigningStateJSON;
  const selected =
    input.requestId === undefined
      ? state.requests
      : state.requests.filter((r) => r.request_id === input.requestId);
  if (input.requestId !== undefined && selected.length !== 1)
    throw new PublishError(
      'signing_request_not_found',
      'That signing request was not found.'
    );
  if (input.saveCertificateTo !== undefined && selected.length !== 1)
    throw new PublishError(
      'certificate_not_ready',
      'Select one completed request to save its certificate.'
    );
  const requests = [];
  for (const request of selected) {
    const key = await deriveSigningKey(
      local.access === 'public'
        ? decodeKey(local.state.key)
        : await privateVersionKey(
            deps,
            input.relicId,
            local.state,
            request.version
          )
    );
    const layout = await openSigningLayout({
      signingKey: key,
      relicId: input.relicId,
      version: request.version,
      ciphertext: request.request.layout_ciphertext,
      signerCount: request.signers.length,
    });
    const signers = await Promise.all(
      request.signers.map(async (signer) => ({
        index: signer.index,
        email: signer.email,
        status: signer.status,
        served_at: signer.served_at,
        opened_at: signer.opened_at,
        name:
          signer.signature === null
            ? null
            : (
                await openSignatureMark({
                  signingKey: key,
                  relicId: input.relicId,
                  version: request.version,
                  ciphertext: signer.signature.mark_ciphertext,
                })
              ).name,
      }))
    );
    if (input.saveCertificateTo !== undefined) {
      if (selected.length !== 1 || request.status !== 'complete')
        throw new PublishError(
          'certificate_not_ready',
          'Select one completed request to save its certificate.'
        );
      const certificate = parseSigningCertificate(
        await postJson(
          deps,
          `${deps.serviceOrigin}/api/relics/${input.relicId}/signing/certificate`,
          {
            publish_token: local.state.publish_token,
            request_id: request.request_id,
          }
        )
      );
      if (
        certificate.relic_id !== input.relicId ||
        certificate.version !== request.version ||
        certificate.request.statement['request_id'] !== request.request_id
      )
        throw new PublishError(
          'app_response_unusable',
          'The certificate does not match the requested version.'
        );
      await writeFile(
        input.saveCertificateTo,
        JSON.stringify({ ...certificate, signing_key: encodeBase64url(key) }),
        { flag: 'wx', mode: 0o600 }
      );
    }
    requests.push({
      request_id: request.request_id,
      version: request.version,
      status: request.status,
      layout,
      signers,
    });
  }
  return {
    relic_id: input.relicId,
    current_version: state.current_version,
    locked_versions: state.locked_versions,
    requests,
  };
}

/** Cancel an owner's request with the certified device and the publish token. */
export async function cancelSigning(
  relicId: string,
  requestId: string,
  deps: PublishDeps
) {
  const local = await localRelic(relicId);
  const entry = await loadDeviceEntry(deps.serviceOrigin);
  if (entry?.owner === undefined) {
    throw new PublishError(
      'device_not_enrolled',
      'Enroll and confirm an owner device before cancelling a signing request.'
    );
  }
  const signer = await deviceSigner(entry, deps.secureEnclave);
  const statement: StatementMap['signing_cancel'] = {
    at: Date.now(),
    owner_identity_id: entry.owner.identity_id,
    relic_id: relicId,
    request_id: requestId,
    signer_id: entry.device_id,
  };
  const signature = await signDeviceStatement(
    signer,
    'signing_cancel',
    statement
  );
  const result = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${relicId}/signing/cancel`,
    {
      publish_token: local.state.publish_token,
      cancel: {
        statement,
        signature,
        signer_kind: 'device',
        device_id: entry.device_id,
      },
    }
  );
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result) ||
    (result as Record<string, unknown>)['request_id'] !== requestId ||
    (result as Record<string, unknown>)['status'] !== 'cancelled'
  ) {
    throw new PublishError(
      'app_response_unusable',
      'The service returned an invalid cancellation response.'
    );
  }
  return {
    relic_id: relicId,
    request_id: requestId,
    status: 'cancelled' as const,
  };
}
