import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  contentLengthOf,
  decodeKey,
  deriveRendererClass,
  relicUrl,
  streamAnyRelicContent,
} from '@relic/format';
import { encodeBase64url, SIGN_CONSENT_ID } from '@relic/format/private';
import {
  contentMac,
  deriveSigningKey,
  openSignatureMark,
  openSigningLayout,
  parseSigningCertificate,
  layoutCiphertextSha256,
  sealSigningLayout,
  type SigningStateJSON,
} from '@relic/format/signing';
import type { StatementMap } from '@relic/format/private';
import { localRelic } from './comments.ts';
import {
  deviceSigner,
  loadDeviceEntry,
  signDeviceStatement,
} from './device.ts';
import {
  type PublishDeps,
  postJson,
  PublishError,
  ServerRefusal,
} from './publish.ts';
import { bindOwner, privateVersionKey, verifyGrant } from './private.ts';
import { grantUrl } from './share.ts';

export interface RequestSignaturesInput {
  relicId: string;
  signers: {
    email: string;
    boxes?: { page: number; x: number; y: number; w: number; h: number }[];
  }[];
  order: 'parallel' | 'sequential';
  requireOpened: boolean;
}

export async function requestSignatures(
  input: RequestSignaturesInput,
  deps: PublishDeps
) {
  const local = await localRelic(input.relicId);
  const device = await loadDeviceEntry(deps.serviceOrigin);
  if (device?.owner === undefined)
    throw new PublishError(
      'device_not_enrolled',
      'Enroll and confirm an owner device before requesting signatures.'
    );
  const signer = await deviceSigner(device, deps.secureEnclave);
  if (local.access === 'public') {
    try {
      await bindOwner({ relic_id: input.relicId }, deps);
    } catch (error) {
      if (!(error instanceof ServerRefusal && error.code === 'owner_exists'))
        throw error;
    }
  }
  const mint = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relicId}/mint`,
    local.access === 'private'
      ? { publish_token: local.state.publish_token }
      : {}
  );
  if (typeof mint !== 'object' || mint === null || Array.isArray(mint))
    throw new PublishError('app_response_unusable', 'Invalid mint response.');
  const m = mint as Record<string, unknown>;
  if (
    typeof m['url'] !== 'string' ||
    typeof m['version'] !== 'number' ||
    !Number.isSafeInteger(m['version']) ||
    typeof m['object_length'] !== 'number' ||
    m['version'] !== m['current_version']
  )
    throw new PublishError(
      'app_response_unusable',
      'The service did not return the current published version.'
    );
  const version = m['version'];
  const response = await deps.fetch(m['url']);
  if (!response.ok)
    throw new PublishError(
      'app_response_unusable',
      'The version ciphertext could not be fetched.'
    );
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  if (ciphertext.length !== m['object_length'])
    throw new PublishError(
      'app_response_unusable',
      'The version ciphertext has the wrong length.'
    );
  const key =
    local.access === 'public'
      ? decodeKey(local.state.key)
      : await privateVersionKey(deps, input.relicId, local.state, version);
  let content = new Uint8Array(0);
  let offset = 0;
  const envelope = await streamAnyRelicContent(
    new Response(ciphertext).body!,
    key,
    {
      objectLength: ciphertext.length,
      onEnvelope(value) {
        content = new Uint8Array(contentLengthOf(value));
      },
      onContent(chunk) {
        content.set(chunk, offset);
        offset += chunk.length;
      },
    }
  );
  const pdf =
    envelope.version === 1 &&
    deriveRendererClass(content, envelope.entries[0]?.filename ?? '') === 'pdf';
  const signingKey = await deriveSigningKey(key);
  const boxes = input.signers.flatMap((entry, index) =>
    (entry.boxes ?? []).map(({ page, ...rect }) => ({
      signer: index,
      page,
      rect,
    }))
  );
  const layout = await sealSigningLayout({
    signingKey,
    relicId: input.relicId,
    version,
    signerCount: input.signers.length,
    pdf,
    layout: { v: 1, boxes },
  });
  let signers: { email: string; identity_id: string | null }[];
  if (local.access === 'private') {
    const recipients = await postJson(
      deps,
      `${deps.serviceOrigin}/api/relics/${input.relicId}/recipients`,
      { publish_token: local.state.publish_token }
    );
    if (
      typeof recipients !== 'object' ||
      recipients === null ||
      !Array.isArray((recipients as Record<string, unknown>)['grants'])
    )
      throw new PublishError(
        'app_response_unusable',
        'The private recipient list was invalid.'
      );
    const grants = await Promise.all(
      (
        (recipients as Record<string, unknown>)['grants'] as Record<
          string,
          unknown
        >[]
      ).map((grant) => verifyGrant(grant, device.owner!, input.relicId))
    );
    signers = input.signers.map(({ email }) => {
      if (email.toLowerCase() === device.owner!.email.toLowerCase()) {
        return {
          email: device.owner!.email,
          identity_id: device.owner!.identity_id,
        };
      }
      const grant = grants.find(
        (g) =>
          !g.mark.revoked &&
          g.reader.email?.toLowerCase() === email.toLowerCase()
      );
      if (grant === undefined)
        throw new PublishError(
          'recipient_forged_grant',
          `${email} can't open this relik yet, so they can't be asked to sign. Grant access or invite them first: open grant_url in your browser and tap your passkey. An invited person can sign once they accept and you confirm.`,
          { signer_email: email, grant_url: grantUrl(deps.relicOrigin, input.relicId, [email]) }
        );
      return {
        email: grant.reader.email!,
        identity_id: grant.granteeIdentityId,
      };
    });
  } else {
    if (input.requireOpened)
      throw new PublishError(
        'app_response_unusable',
        'Require opened is only available for private reliks.'
      );
    signers = input.signers.map(({ email }) => ({ email, identity_id: null }));
  }
  const statement: StatementMap['signing_request'] = {
    at: Date.now(),
    ciphertext_sha256: createHash('sha256').update(ciphertext).digest('hex'),
    consent: SIGN_CONSENT_ID,
    content_mac: await contentMac(signingKey, content),
    layout_sha256: layoutCiphertextSha256(layout),
    order: input.order,
    owner_identity_id: device.owner.identity_id,
    relic_id: input.relicId,
    request_id: encodeBase64url(randomBytes(16)),
    require_opened: input.requireOpened,
    signer_id: device.device_id,
    signers,
    version,
  };
  const signature = await signDeviceStatement(
    signer,
    'signing_request',
    statement
  );
  const result = await postJson(
    deps,
    `${deps.serviceOrigin}/api/relics/${input.relicId}/signing/requests`,
    {
      publish_token: local.state.publish_token,
      request: {
        statement,
        signature,
        signer_kind: 'device',
        device_id: device.device_id,
      },
      layout_ciphertext: layout,
    }
  );
  if (
    typeof result !== 'object' ||
    result === null ||
    (result as Record<string, unknown>)['request_id'] !==
      statement.request_id ||
    (result as Record<string, unknown>)['status'] !== 'open'
  )
    throw new PublishError(
      'app_response_unusable',
      'Invalid signing request response.'
    );
  const invitations =
    local.access === 'public'
      ? signers.map(({ email }) => {
          const url = relicUrl(deps.relicOrigin, input.relicId, key);
          const subject = 'Please sign this relik';
          const text = `Please open this link to review and sign:\n\n${url}\n\nYour passkey approval signs this exact version. Relik does not verify identity or claim electronic signatures are legally binding.`;
          return {
            to: email,
            subject,
            text,
            mailto_url: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`,
          };
        })
      : undefined;
  return {
    relic_id: input.relicId,
    request_id: statement.request_id,
    version,
    status: 'open',
    order: input.order,
    signers,
    ...(invitations === undefined
      ? { notice: 'Relik emailed each signer.' }
      : { invitations }),
  };
}

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
