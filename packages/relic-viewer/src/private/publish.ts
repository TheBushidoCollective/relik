import {
  encryptedSize,
  generateKey,
  generateRelicId,
  normalizeEmail,
  Sha256,
  type RendererClass,
} from '@relic/format';
import {
  encodeBase64url,
  kemKeyIdOf,
  keyCommitment,
  ownerPublishBodySha256,
  parseStatement,
  signStatement,
  statementBytes,
  type DevicePublicJSON,
  type GrantJSON,
  type KeyJSON,
  type PartyJSON,
  type RecoveryJSON,
  type SealJSON,
  type SignedStatementBody,
  type WrapJSON,
  unwrapVersionKey,
  verifyStatement,
  wrapVersionKey,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import {
  attest,
  loadReviewedIdentity,
  nowMs,
  postJson,
  PrivateRequestError,
  recipientOf,
  type ReviewedPrivateOwner,
  type UnlockedIdentity,
} from './keys.ts';
import {
  hexOf,
  recipientKeyIds,
  verifiedPartyKeys,
  verifiedRecipients,
} from './rekey.ts';

const BROWSER_LIMIT = 100_000_000;
const MAX_RESERVATION_ATTEMPTS = 4;
const MAX_ROSTER_ATTEMPTS = 4;

export interface PrivatePublishSource {
  readonly plaintextLength: number;
  readonly rendererClass: RendererClass;
  encrypt(key: Uint8Array): Promise<Blob | Uint8Array>;
}

export type PrivatePublishPhase =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'encrypting' }
  | {
      readonly kind: 'uploading';
      readonly sent: number;
      readonly total: number;
    }
  | { readonly kind: 'finishing' };

export interface PrivatePublishResult {
  readonly url: string;
  readonly relicId: string;
  readonly relicExpiresAt: string;
  readonly rendererClass: RendererClass;
  readonly access: 'private';
}

export interface PrivatePublisherOptions {
  readonly deps: ViewerDeps;
  readonly source: PrivatePublishSource;
  readonly owner: ReviewedPrivateOwner;
  readonly ttlDays?: number;
  readonly decisions?: boolean;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: PrivatePublishPhase) => void;
  /** Receives only browser-settable signed headers, never Content-Length. */
  readonly upload?: (
    url: string,
    body: Blob | Uint8Array,
    headers: Readonly<Record<string, string>>,
    onProgress: (sent: number, total: number) => void
  ) => Promise<number>;
}

export interface PrivatePublisher {
  publish(): Promise<PrivatePublishResult>;
  retry(): Promise<PrivatePublishResult>;
  /** Discard the in-memory version key and retry state. */
  dispose(): void;
}

interface Pending {
  readonly relicId: string;
  readonly key: Uint8Array;
  readonly ciphertext: Blob | Uint8Array;
  readonly digest: string;
  readonly identity: UnlockedIdentity;
  expiresAt?: string;
  stage: 'grant' | 'upload' | 'seal';
  completionAttempted: boolean;
}

interface UploadGrant {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

interface Roster {
  readonly access_epoch: number;
  readonly owner_epoch: number;
  readonly current_version: number;
  readonly sealed_version: number | null;
  readonly owner: PartyJSON;
  readonly devices: readonly DevicePublicJSON[];
  readonly grants: readonly GrantJSON[];
  readonly recovery: RecoveryJSON | null;
  readonly recovery_statement?: SignedStatementBody | null;
  readonly recipient_key_ids: readonly string[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrivateRequestError('invalid_private_publish_response', 0);
  }
  return value as Record<string, unknown>;
}

function bytesLength(body: Blob | Uint8Array): number {
  return body instanceof Blob ? body.size : body.byteLength;
}

async function ciphertextDigest(body: Blob | Uint8Array): Promise<string> {
  const hash = new Sha256();
  if (body instanceof Uint8Array) return hash.update(body).hex();
  const reader = body.stream().getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      hash.update(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.hex();
}

/** Validate the service's target and the headers pinned in the signed PUT. */
function uploadGrant(
  value: unknown,
  relicId: string,
  size: number,
  serviceOrigin: string,
  now: number,
  expectedExpiry?: string
): UploadGrant {
  const grant = record(value);
  if (
    grant['relic_id'] !== relicId ||
    grant['access'] !== 'private' ||
    (grant['version'] !== undefined && grant['version'] !== 1) ||
    grant['upload_method'] !== 'PUT' ||
    typeof grant['upload_url'] !== 'string' ||
    typeof grant['upload_expires_at'] !== 'string' ||
    !Number.isFinite(Date.parse(grant['upload_expires_at'])) ||
    Date.parse(grant['upload_expires_at']) <= now ||
    typeof grant['relic_expires_at'] !== 'string' ||
    !Number.isFinite(Date.parse(grant['relic_expires_at'])) ||
    Date.parse(grant['relic_expires_at']) <= now ||
    (expectedExpiry !== undefined &&
      grant['relic_expires_at'] !== expectedExpiry) ||
    'publish_token' in grant
  ) {
    throw new PrivateRequestError('invalid_private_grant', 0);
  }
  let url: URL;
  try {
    url = new URL(grant['upload_url']);
  } catch {
    throw new PrivateRequestError('invalid_private_grant', 0);
  }
  const service = new URL(serviceOrigin);
  const trustedTarget =
    url.origin === service.origin ||
    (url.protocol === 'https:' &&
      url.hostname === 'storage.googleapis.com' &&
      url.port === '');
  if (
    !trustedTarget ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    decodeURIComponent(url.pathname.split('/').pop() ?? '') !== relicId
  ) {
    throw new PrivateRequestError('invalid_private_grant', 0);
  }
  const headers = record(grant['upload_headers']);
  const expectedTime = new Date(grant['relic_expires_at']).toISOString();
  if (
    headers['content-length'] !== String(size) ||
    headers['x-goog-custom-time'] !== expectedTime ||
    Object.keys(headers).some(
      (key) => key !== 'content-length' && key !== 'x-goog-custom-time'
    )
  ) {
    throw new PrivateRequestError('invalid_private_grant', 0);
  }
  return {
    url: url.href,
    headers: { 'x-goog-custom-time': expectedTime },
    expiresAt: grant['relic_expires_at'],
  };
}

function compareBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

async function checkOwner(
  party: PartyJSON,
  identity: UnlockedIdentity
): Promise<void> {
  if (
    party?.identity?.identity_id !== identity.identityId ||
    party.identity.kem_public_key !== encodeBase64url(identity.kemPublicKey) ||
    party.identity.sig_public_key !== encodeBase64url(identity.sigPublicKey) ||
    normalizeEmail(party.email) !== normalizeEmail(identity.email) ||
    normalizeEmail(party.identity.email) !== normalizeEmail(identity.email) ||
    party.identity.retired_at !== null
  ) {
    throw new PrivateRequestError('private_owner_mismatch', 0);
  }
  await verifiedPartyKeys(party);
}

/** Read the owner seal, verify its signature and check our own wrap. */
async function readBack(
  p: Pending,
  options: PrivatePublisherOptions
): Promise<void> {
  const answer = record(
    await postJson(
      options.deps,
      `/api/relics/${p.relicId}/versions/1/key`,
      {},
      options.signal
    )
  ) as unknown as KeyJSON;
  if (
    answer.relic_id !== p.relicId ||
    answer.version !== 1 ||
    answer.signer?.kind !== 'identity' ||
    answer.seal?.signer_kind !== 'identity' ||
    answer.wrap?.version !== 1
  ) {
    throw new PrivateRequestError('private_seal_mismatch', 0);
  }
  await checkOwner(answer.owner, p.identity);
  const seal = parseStatement('seal', answer.seal.statement);
  if (
    seal.relic_id !== p.relicId ||
    seal.version !== 1 ||
    seal.signer_id !== p.identity.identityId ||
    seal.ciphertext_sha256 !== p.digest ||
    seal.key_commitment !==
      (await keyCommitment({ relicId: p.relicId, version: 1, key: p.key })) ||
    answer.wrap.recipient_key_id !== hexOf(p.identity.kemKeyId) ||
    !seal.recipient_key_ids.includes(answer.wrap.recipient_key_id) ||
    !(await verifyStatement(
      p.identity.sigPublicKey,
      statementBytes('seal', seal),
      answer.seal.signature
    ))
  ) {
    throw new PrivateRequestError('private_seal_mismatch', 0);
  }
  const opened = await unwrapVersionKey({
    recipient: recipientOf(p.identity),
    relicId: p.relicId,
    version: 1,
    enc: answer.wrap.enc,
    ct: answer.wrap.ct,
  });
  const matches = compareBytes(opened, p.key);
  opened.fill(0);
  if (!matches) throw new PrivateRequestError('private_seal_mismatch', 0);
}

async function sealPending(
  p: Pending,
  options: PrivatePublisherOptions
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ROSTER_ATTEMPTS; attempt++) {
    const answer = record(
      await postJson(
        options.deps,
        `/api/relics/${p.relicId}/recipients`,
        {},
        options.signal
      )
    ) as unknown as Roster;
    if (
      !Number.isSafeInteger(answer.access_epoch) ||
      answer.access_epoch < 0 ||
      !Number.isSafeInteger(answer.owner_epoch) ||
      answer.owner_epoch < 0 ||
      answer.current_version !== 1 ||
      answer.sealed_version !== null ||
      !Array.isArray(answer.devices) ||
      !Array.isArray(answer.grants) ||
      !Array.isArray(answer.recipient_key_ids) ||
      !('recovery' in answer)
    ) {
      throw new PrivateRequestError('invalid_private_roster', 0);
    }
    await checkOwner(answer.owner, p.identity);
    const recipients = await verifiedRecipients(
      p.identity,
      p.relicId,
      answer,
      '',
      nowMs(options.deps)
    );
    const ids = await recipientKeyIds(recipients);
    if (JSON.stringify(ids) !== JSON.stringify(answer.recipient_key_ids)) {
      throw new PrivateRequestError('private_recipient_mismatch', 0);
    }
    const wrapsById = new Map<string, WrapJSON>();
    for (const recipient of recipients) {
      const recipientId = hexOf(await kemKeyIdOf(recipient.kemPublicKey));
      if (wrapsById.has(recipientId)) continue;
      const wrap = await wrapVersionKey({
        recipientPublicKey: recipient.kemPublicKey,
        relicId: p.relicId,
        version: 1,
        key: p.key,
      });
      wrapsById.set(wrap.recipientKeyId, {
        recipient_key_id: wrap.recipientKeyId,
        version: 1,
        enc: wrap.enc,
        ct: wrap.ct,
      });
    }
    const statement = parseStatement('seal', {
      access_epoch: answer.access_epoch,
      at: nowMs(options.deps),
      ciphertext_sha256: p.digest,
      key_commitment: await keyCommitment({
        relicId: p.relicId,
        version: 1,
        key: p.key,
      }),
      owner_epoch: answer.owner_epoch,
      recipient_key_ids: ids,
      relic_id: p.relicId,
      signer_id: p.identity.identityId,
      version: 1,
    });
    const seal: SealJSON = {
      statement: { ...statement },
      signature: await signStatement(
        (bytes) => p.identity.sign(bytes),
        statementBytes('seal', statement)
      ),
      signer_kind: 'identity',
    };
    await loadReviewedIdentity(options.deps, options.owner, options.signal);
    // A lost response can leave the server finishing this exact request.
    p.completionAttempted = true;
    let response: Record<string, unknown>;
    try {
      response = record(
        await postJson(
          options.deps,
          `/api/relics/${p.relicId}/complete`,
          { seal, wraps: [...wrapsById.values()] },
          options.signal
        )
      );
    } catch (error) {
      if (
        error instanceof PrivateRequestError &&
        error.code === 'recipients_changed'
      ) {
        p.completionAttempted = false;
        continue;
      }
      if (
        error instanceof PrivateRequestError &&
        error.code === 'version_conflict'
      ) {
        await readBack(p, options);
        return;
      }
      throw error;
    }
    if (
      response['relic_id'] !== p.relicId ||
      response['access'] !== 'private' ||
      response['version'] !== 1 ||
      response['sealed_version'] !== 1 ||
      response['version_digest'] !== p.digest ||
      response['relic_expires_at'] !== p.expiresAt
    ) {
      throw new PrivateRequestError('private_seal_mismatch', 0);
    }
    await readBack(p, options);
    return;
  }
  throw new PrivateRequestError('recipients_changed', 409);
}

export function createPrivatePublisher(
  options: PrivatePublisherOptions
): PrivatePublisher {
  let pending: Pending | undefined;
  let unretainedKey: Uint8Array | undefined;
  let result: PrivatePublishResult | undefined;
  let busy = false;
  let disposed = false;
  const phase = options.onPhase ?? (() => undefined);
  const abort = new AbortController();
  const abortFromCaller = (): void => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const activeOptions: PrivatePublisherOptions = {
    ...options,
    signal: abort.signal,
  };
  const requireActive = (): void => {
    if (disposed || abort.signal.aborted) {
      throw new PrivateRequestError('private_publish_disposed', 0);
    }
  };

  async function upload(p: Pending, raw: unknown): Promise<void> {
    requireActive();
    await loadReviewedIdentity(options.deps, options.owner, abort.signal);
    requireActive();
    const grant = uploadGrant(
      raw,
      p.relicId,
      bytesLength(p.ciphertext),
      options.deps.serviceOrigin,
      nowMs(options.deps),
      p.expiresAt
    );
    p.expiresAt = grant.expiresAt;
    phase({ kind: 'uploading', sent: 0, total: bytesLength(p.ciphertext) });
    const progress = (sent: number, total: number) =>
      phase({ kind: 'uploading', sent, total });
    const status =
      options.upload === undefined
        ? (
            await options.deps.fetch(grant.url, {
              method: 'PUT',
              headers: grant.headers,
              body:
                p.ciphertext instanceof Blob
                  ? p.ciphertext
                  : (p.ciphertext as Uint8Array<ArrayBuffer>),
              credentials: 'omit',
              redirect: 'error',
              signal: abort.signal,
            })
          ).status
        : await options.upload(
            grant.url,
            p.ciphertext,
            grant.headers,
            progress
          );
    requireActive();
    if (status < 200 || status >= 300)
      throw new PrivateRequestError('private_upload_failed', status);
    p.stage = 'seal';
  }

  async function finish(p: Pending): Promise<PrivatePublishResult> {
    requireActive();
    phase({ kind: 'finishing' });
    await sealPending(p, activeOptions);
    await loadReviewedIdentity(options.deps, options.owner, abort.signal);
    requireActive();
    if (p.expiresAt === undefined)
      throw new PrivateRequestError('invalid_private_grant', 0);
    const url = new URL(`/${p.relicId}`, options.deps.serviceOrigin);
    result = {
      url: url.href,
      relicId: p.relicId,
      relicExpiresAt: p.expiresAt,
      rendererClass: options.source.rendererClass,
      access: 'private',
    };
    p.key.fill(0);
    pending = undefined;
    return result;
  }

  async function start(): Promise<PrivatePublishResult> {
    if (
      !Number.isSafeInteger(options.source.plaintextLength) ||
      options.source.plaintextLength <= 0 ||
      options.source.plaintextLength > BROWSER_LIMIT
    ) {
      throw new PrivateRequestError('private_source_size', 0);
    }
    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt++) {
      phase({ kind: 'preparing' });
      const challenge = record(
        await postJson(options.deps, '/api/challenge', {}, abort.signal)
      );
      const capabilities = record(challenge['private_shares']);
      const max = capabilities['max_ttl_days'];
      const defaultTtl = capabilities['default_ttl_days'];
      if (
        capabilities['browser_owner_publish'] !== true ||
        typeof challenge['challenge_nonce'] !== 'string' ||
        typeof challenge['size_limit_bytes'] !== 'number' ||
        !Number.isSafeInteger(challenge['size_limit_bytes']) ||
        challenge['size_limit_bytes'] < options.source.plaintextLength ||
        typeof max !== 'number' ||
        !Number.isSafeInteger(max) ||
        max < 1 ||
        typeof defaultTtl !== 'number' ||
        !Number.isSafeInteger(defaultTtl) ||
        defaultTtl < 1 ||
        defaultTtl > max ||
        (options.ttlDays !== undefined &&
          (!Number.isSafeInteger(options.ttlDays) ||
            options.ttlDays < 1 ||
            options.ttlDays > max))
      ) {
        throw new PrivateRequestError('private_publish_unavailable', 0);
      }
      const relicId = generateRelicId();
      const key = generateKey();
      unretainedKey = key;
      phase({ kind: 'encrypting' });
      const ciphertext = await options.source.encrypt(key);
      if (abort.signal.aborted) {
        key.fill(0);
        requireActive();
      }
      const size = bytesLength(ciphertext);
      if (size !== encryptedSize(options.source.plaintextLength)) {
        key.fill(0);
        throw new PrivateRequestError('private_ciphertext_size', 0);
      }
      const body: Record<string, unknown> = {
        challenge_nonce: challenge['challenge_nonce'],
        relic_id: relicId,
        renderer_class: options.source.rendererClass,
        publishing_client: 'relik-web',
        declared_size_bytes: options.source.plaintextLength,
        declared_ciphertext_bytes: size,
        access: 'private',
        ...(options.ttlDays === undefined ? {} : { ttl_days: options.ttlDays }),
        ...(options.decisions === true ? { decisions: true } : {}),
      };
      const hash = await ownerPublishBodySha256(body);
      const signed = await attest(
        options.deps,
        {
          purpose: 'owner_publish',
          relicId,
          reviewedOwner: options.owner,
          build: (identityId) => [
            {
              kind: 'owner_publish',
              statement: {
                at: nowMs(options.deps),
                owner_identity_id: identityId,
                relic_id: relicId,
                challenge_nonce: body['challenge_nonce'],
                body_sha256: hash,
              },
            },
          ],
        },
        abort.signal
      );
      if (abort.signal.aborted) {
        key.fill(0);
        requireActive();
      }
      const p: Pending = {
        relicId,
        key,
        ciphertext,
        digest: await ciphertextDigest(ciphertext),
        identity: signed.identity,
        stage: 'grant',
        completionAttempted: false,
      };
      if (abort.signal.aborted) {
        key.fill(0);
        requireActive();
      }
      pending = p;
      unretainedKey = undefined;
      await loadReviewedIdentity(options.deps, options.owner, abort.signal);
      requireActive();
      let grant: unknown;
      try {
        grant = await postJson(
          options.deps,
          '/api/grant',
          { ...body, owner_attestation: signed.bundle },
          abort.signal
        );
      } catch (error) {
        if (
          error instanceof PrivateRequestError &&
          (error.code === 'relic_id_collision' ||
            error.code === 'invalid_challenge_nonce')
        ) {
          p.key.fill(0);
          pending = undefined;
          continue;
        }
        throw error;
      }
      p.stage = 'upload';
      await upload(p, grant);
      return finish(p);
    }
    throw new PrivateRequestError('relic_id_collision', 409);
  }

  async function resume(): Promise<PrivatePublishResult> {
    const p = pending;
    if (p === undefined) return start();
    if (p.stage === 'seal') {
      try {
        await readBack(p, activeOptions);
        await loadReviewedIdentity(options.deps, options.owner, abort.signal);
        requireActive();
        if (p.expiresAt === undefined)
          throw new PrivateRequestError('invalid_private_grant', 0);
        result = {
          url: new URL(`/${p.relicId}`, options.deps.serviceOrigin).href,
          relicId: p.relicId,
          relicExpiresAt: p.expiresAt,
          rendererClass: options.source.rendererClass,
          access: 'private',
        };
        p.key.fill(0);
        pending = undefined;
        return result;
      } catch (error) {
        if (
          !(error instanceof PrivateRequestError) ||
          error.code !== 'relic_not_yet_published'
        )
          throw error;
        if (p.completionAttempted)
          throw new PrivateRequestError('private_publish_in_progress', 0);
      }
      return finish(p);
    }
    let reissued: unknown;
    try {
      reissued = await postJson(
        options.deps,
        `/api/relics/${p.relicId}/versions/1/upload-grant`,
        {},
        abort.signal
      );
    } catch (error) {
      if (
        p.stage === 'grant' &&
        error instanceof PrivateRequestError &&
        error.code === 'relic_not_found'
      ) {
        p.key.fill(0);
        pending = undefined;
        return start();
      }
      throw error;
    }
    p.stage = 'upload';
    await upload(p, reissued);
    return finish(p);
  }

  async function run(): Promise<PrivatePublishResult> {
    requireActive();
    if (result !== undefined) return result;
    if (busy) throw new PrivateRequestError('private_publish_in_progress', 0);
    busy = true;
    try {
      await loadReviewedIdentity(options.deps, options.owner, abort.signal);
      requireActive();
      return await resume();
    } catch (error) {
      if (
        error instanceof PrivateRequestError &&
        error.code === 'private_owner_changed'
      ) {
        disposed = true;
        abort.abort();
        options.signal?.removeEventListener('abort', abortFromCaller);
        pending?.key.fill(0);
        pending = undefined;
      }
      throw error;
    } finally {
      unretainedKey?.fill(0);
      unretainedKey = undefined;
      busy = false;
    }
  }

  return {
    publish: run,
    retry: run,
    dispose() {
      disposed = true;
      abort.abort();
      options.signal?.removeEventListener('abort', abortFromCaller);
      unretainedKey?.fill(0);
      unretainedKey = undefined;
      pending?.key.fill(0);
      pending = undefined;
    },
  };
}
