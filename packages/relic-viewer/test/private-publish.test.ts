import { expect, test } from 'bun:test';
import { encryptRelic } from '@relic/format';
import {
  deriveKek,
  encodeBase64url,
  encryptIdentityBundle,
  generateIdentityKeys,
  kemKeyIdOf,
} from '@relic/format/private';
import { createPrivatePublisher } from '../src/private/publish.ts';
import type { CredentialsLike } from '../src/passkey-common.ts';
import type { ViewerDeps } from '../src/viewer.ts';

const ORIGIN = 'https://relik.test';
const NOW = Date.UTC(2026, 10, 20);
const EXPIRY = new Date(NOW + 7 * 86_400_000).toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function world(
  options: {
    loseCompletion?: boolean;
    alterSeal?: boolean;
    forgedRoster?: boolean;
    recipientsChangedOnce?: boolean;
    invalidGrant?: 'id' | 'access' | 'target' | 'length' | 'expiry';
    identityChangeAfter?: 'nonce' | 'grant';
    lostBeforeSeal?: boolean;
    holdCompletion?: boolean;
    completionConflict?: boolean;
    claimOpen?: boolean;
    unsupported?: boolean;
    keyLagOnce?: boolean;
  } = {}
) {
  const keys = await generateIdentityKeys();
  const rawId = crypto.getRandomValues(new Uint8Array(32));
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const bundle = await encryptIdentityBundle(
    await deriveKek(prf, rawId),
    keys,
    rawId
  );
  const credentialId = encodeBase64url(rawId);
  const credential = {
    id: credentialId,
    rawId: rawId.slice().buffer,
    type: 'public-key',
    response: {
      clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}')
        .buffer,
      authenticatorData: new TextEncoder().encode('auth').buffer,
      signature: new TextEncoder().encode('sig').buffer,
      userHandle: null,
    },
    getClientExtensionResults: () => ({
      prf: { results: { first: prf.slice().buffer } },
    }),
  } as unknown as Credential;
  const credentials: CredentialsLike = {
    get: async () => credential,
    create: async () => null,
  };
  const email = 'owner@example.com';
  const party = {
    email,
    identity: {
      identity_id: keys.identityId,
      email,
      kem_public_key: encodeBase64url(keys.kemPublicKey),
      sig_public_key: encodeBase64url(keys.sigPublicKey),
      created_at: new Date(NOW).toISOString(),
      retired_at: null,
    },
  };
  const identity = {
    ...party.identity,
    credentials: [
      {
        credential_id: credentialId,
        encrypted_bundle: bundle,
        bound_at: new Date(NOW).toISOString(),
      },
    ],
    recovery: null,
    access_log_retention_days: 2190,
    recipients_epoch: 0,
  };
  const keyId = Buffer.from(await kemKeyIdOf(keys.kemPublicKey)).toString(
    'hex'
  );
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let relicId = '';
  let stored:
    | { seal: Record<string, unknown>; wraps: Record<string, unknown>[] }
    | undefined;
  let lost = false;
  let changed = false;
  let keyLagged = false;
  let currentIdentity: typeof identity | null = identity;
  let delayed:
    | { seal: Record<string, unknown>; wraps: Record<string, unknown>[] }
    | undefined;
  const held = Promise.withResolvers<void>();
  const completionStarted = Promise.withResolvers<void>();
  const changeIdentity = (): void => {
    currentIdentity = { ...identity, identity_id: 'different-owner' };
  };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ path, body });
    if (path === '/api/challenge')
      return json({
        challenge_nonce: 'challenge',
        size_limit_bytes: 100_000_000,
        private_shares: {
          browser_owner_publish: !options.unsupported,
          default_ttl_days: 30,
          max_ttl_days: 365,
        },
      });
    if (path === '/api/identity')
      return json({
        identity: currentIdentity,
        passkeys: [{ credential_id: credentialId, bound: true }],
      });
    if (path === '/api/attest/nonce') {
      if (options.identityChangeAfter === 'nonce') changeIdentity();
      return json({
        nonce: encodeBase64url(crypto.getRandomValues(new Uint8Array(32))),
        public_key: {
          rpId: 'relik.test',
          allowCredentials: [{ type: 'public-key', id: credentialId }],
        },
      });
    }
    if (path === '/api/grant') {
      relicId = String(body['relic_id']);
      if (options.identityChangeAfter === 'grant') changeIdentity();
      return json({
        relic_id:
          options.invalidGrant === 'id'
            ? '00000000000000000000000000'
            : relicId,
        access: options.invalidGrant === 'access' ? 'public' : 'private',
        upload_url:
          options.invalidGrant === 'target'
            ? `https://other.example/${relicId}`
            : `${ORIGIN}/storage/${relicId}?signed=1`,
        upload_method: 'PUT',
        upload_headers: {
          'content-length':
            options.invalidGrant === 'length'
              ? '1'
              : String(body['declared_ciphertext_bytes']),
          'x-goog-custom-time':
            options.invalidGrant === 'expiry'
              ? new Date(NOW).toISOString()
              : EXPIRY,
        },
        upload_expires_at: new Date(NOW + 60_000).toISOString(),
        relic_expires_at: EXPIRY,
      });
    }
    if (path === `/api/relics/${relicId}/recipients`)
      return json({
        access_epoch: 0,
        owner_epoch: 0,
        current_version: 1,
        sealed_version: stored === undefined ? null : 1,
        owner: party,
        devices: [],
        grants: [],
        recovery: null,
        recovery_statement: null,
        recipient_key_ids: options.forgedRoster ? ['f'.repeat(64)] : [keyId],
      });
    if (path === `/api/relics/${relicId}/complete`) {
      completionStarted.resolve();
      if (options.recipientsChangedOnce && !changed) {
        changed = true;
        return json({ code: 'recipients_changed' }, 409);
      }
      delayed = {
        seal: body['seal'] as Record<string, unknown>,
        wraps: body['wraps'] as Record<string, unknown>[],
      };
      if (options.lostBeforeSeal && !lost) {
        lost = true;
        throw new Error('connection lost while seal may still be in flight');
      }
      if (options.holdCompletion) await held.promise;
      if (options.claimOpen) return json({ code: 'version_conflict' }, 409);
      stored = delayed;
      if (options.completionConflict)
        return json({ code: 'version_conflict' }, 409);
      if (options.loseCompletion && !lost) {
        lost = true;
        throw new Error('connection lost after seal');
      }
      const statement = stored.seal['statement'] as Record<string, unknown>;
      return json({
        relic_id: relicId,
        access: 'private',
        version: 1,
        sealed_version: 1,
        version_digest: statement['ciphertext_sha256'],
        relic_expires_at: EXPIRY,
      });
    }
    if (path === `/api/relics/${relicId}/versions/1/key`) {
      if (stored === undefined)
        return json({ code: 'relic_not_yet_published' }, 409);
      if (options.keyLagOnce && !keyLagged) {
        keyLagged = true;
        return json({ code: 'relic_not_yet_published' }, 409);
      }
      const statement = stored.seal['statement'] as Record<string, unknown>;
      return json({
        relic_id: relicId,
        version: 1,
        owner: party,
        signer: { kind: 'identity' },
        wrap: stored.wraps[0],
        seal: options.alterSeal
          ? {
              ...stored.seal,
              statement: { ...statement, ciphertext_sha256: 'f'.repeat(64) },
            }
          : stored.seal,
      });
    }
    return json({ code: 'unexpected_route' }, 404);
  };
  const deps: ViewerDeps = {
    serviceOrigin: ORIGIN,
    locationHref: `${ORIGIN}/publish`,
    fetch: Object.assign(fetch, { preconnect: () => {} }),
    credentials,
    now: () => NOW,
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
  };
  const content = new TextEncoder().encode('private browser test');
  let uploads = 0;
  let encrypted = 0;
  let versionKey: Uint8Array | undefined;
  const publisher = createPrivatePublisher({
    deps,
    owner: { identityId: keys.identityId, email },
    ttlDays: 7,
    decisions: true,
    source: {
      plaintextLength: content.length,
      rendererClass: 'code',
      async encrypt(key) {
        encrypted++;
        versionKey = key;
        return encryptRelic({
          content,
          filename: 'secret.txt',
          mimetype: 'text/plain',
          key,
        });
      },
    },
    upload: async (_url, _body, headers) => {
      uploads++;
      expect(headers).toEqual({ 'x-goog-custom-time': EXPIRY });
      return 200;
    },
  });
  return {
    publisher,
    calls,
    completionStarted: completionStarted.promise,
    changeIdentity,
    changeEmail() {
      currentIdentity = { ...identity, email: 'other@example.com' };
    },
    clearIdentity() {
      currentIdentity = null;
    },
    releaseCompletion() {
      held.resolve();
    },
    get keyCleared() {
      return versionKey?.every((byte) => byte === 0) ?? false;
    },
    get uploads() {
      return uploads;
    },
    get encrypted() {
      return encrypted;
    },
  };
}

test('private browser publish returns a keyless link only after an authenticated seal readback', async () => {
  const w = await world();
  const result = await w.publisher.publish();
  expect(result.access).toBe('private');
  expect(new URL(result.url).hash).toBe('');
  expect(result.relicExpiresAt).toBe(EXPIRY);
  expect(w.uploads).toBe(1);
  const grant = w.calls.find((call) => call.path === '/api/grant')?.body;
  expect(grant?.['access']).toBe('private');
  expect(grant?.['decisions']).toBe(true);
  expect(grant?.['title']).toBeUndefined();
  expect(grant?.['filename']).toBeUndefined();
  expect(grant?.['share_verifier']).toBeUndefined();
  expect(w.calls.some((call) => call.path.endsWith('/versions/1/key'))).toBe(
    true
  );
});

test('a lost completion response is resolved by reading the already-sealed version, without a second upload', async () => {
  const w = await world({ loseCompletion: true });
  await expect(w.publisher.publish()).rejects.toThrow();
  const result = await w.publisher.retry();
  expect(new URL(result.url).hash).toBe('');
  expect(w.uploads).toBe(1);
  expect(w.calls.filter((call) => call.path === '/api/grant')).toHaveLength(1);
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(1);
});

test('a changed recipient set is reverified and sealed without reuploading', async () => {
  const w = await world({ recipientsChangedOnce: true });
  const result = await w.publisher.publish();
  expect(new URL(result.url).hash).toBe('');
  expect(w.uploads).toBe(1);
  expect(
    w.calls.filter((call) => call.path.endsWith('/recipients'))
  ).toHaveLength(2);
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(2);
});

test('a changed readback seal withholds the link', async () => {
  const w = await world({ alterSeal: true });
  await expect(w.publisher.publish()).rejects.toThrow('private_seal_mismatch');
  await expect(w.publisher.retry()).rejects.toThrow('private_seal_mismatch');
});

test('a forged recipient set receives no completion or link', async () => {
  const w = await world({ forgedRoster: true });
  await expect(w.publisher.publish()).rejects.toThrow(
    'private_recipient_mismatch'
  );
  expect(w.calls.some((call) => call.path.endsWith('/complete'))).toBe(false);
});

test('missing browser owner capability refuses before encryption and grant', async () => {
  const w = await world({ unsupported: true });
  await expect(w.publisher.publish()).rejects.toThrow(
    'private_publish_unavailable'
  );
  expect(w.encrypted).toBe(0);
  expect(w.calls.some((call) => call.path === '/api/grant')).toBe(false);
});

for (const invalidGrant of [
  'id',
  'access',
  'target',
  'length',
  'expiry',
] as const) {
  test(`a grant with a mismatched ${invalidGrant} is refused before upload`, async () => {
    const w = await world({ invalidGrant });
    await expect(w.publisher.publish()).rejects.toThrow(
      'invalid_private_grant'
    );
    expect(w.uploads).toBe(0);
    expect(w.calls.some((call) => call.path.endsWith('/complete'))).toBe(false);
  });
}

for (const change of ['identity', 'email', 'missing'] as const) {
  test(`a ${change} owner at publish requires a new review before nonce or grant`, async () => {
    const w = await world();
    if (change === 'identity') w.changeIdentity();
    else if (change === 'email') w.changeEmail();
    else w.clearIdentity();
    await expect(w.publisher.publish()).rejects.toThrow(
      'private_owner_changed'
    );
    expect(w.calls.some((call) => call.path === '/api/attest/nonce')).toBe(
      false
    );
    expect(w.calls.some((call) => call.path === '/api/grant')).toBe(false);
    expect(w.uploads).toBe(0);
    await expect(w.publisher.retry()).rejects.toThrow(
      'private_publish_disposed'
    );
  });
}

test('an owner change during attestation prevents the grant', async () => {
  const w = await world({ identityChangeAfter: 'nonce' });
  await expect(w.publisher.publish()).rejects.toThrow('private_owner_changed');
  expect(w.calls.some((call) => call.path === '/api/attest/nonce')).toBe(true);
  expect(w.calls.some((call) => call.path === '/api/grant')).toBe(false);
  expect(w.uploads).toBe(0);
  expect(w.keyCleared).toBe(true);
  await expect(w.publisher.retry()).rejects.toThrow('private_publish_disposed');
});

test('an owner change after the grant prevents the upload', async () => {
  const w = await world({ identityChangeAfter: 'grant' });
  await expect(w.publisher.publish()).rejects.toThrow('private_owner_changed');
  expect(w.calls.some((call) => call.path === '/api/grant')).toBe(true);
  expect(w.uploads).toBe(0);
  expect(w.keyCleared).toBe(true);
  await expect(w.publisher.retry()).rejects.toThrow('private_publish_disposed');
});

test('a retry checks the reviewed owner before reading or modifying a pending seal', async () => {
  const w = await world({ lostBeforeSeal: true });
  await expect(w.publisher.publish()).rejects.toThrow();
  const priorCalls = w.calls.length;
  w.changeIdentity();
  await expect(w.publisher.retry()).rejects.toThrow('private_owner_changed');
  expect(w.calls.slice(priorCalls).map((call) => call.path)).toEqual([
    '/api/identity',
  ]);
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(1);
  await expect(w.publisher.retry()).rejects.toThrow('private_publish_disposed');
});

test('a second publish cannot issue completion while the first is in flight', async () => {
  const w = await world({ holdCompletion: true });
  const first = w.publisher.publish();
  await w.completionStarted;
  await expect(w.publisher.retry()).rejects.toThrow(
    'private_publish_in_progress'
  );
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(1);
  w.releaseCompletion();
  expect((await first).access).toBe('private');
});

test('a retry after a lost completion sends a new completion and completes without a second upload', async () => {
  const w = await world({ lostBeforeSeal: true });
  await expect(w.publisher.publish()).rejects.toThrow();
  const result = await w.publisher.retry();
  expect(result.access).toBe('private');
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(2);
  expect(w.uploads).toBe(1);
});

test('a completion refused by an open claim reports in progress until a later retry completes', async () => {
  const options = { claimOpen: true };
  const w = await world(options);
  await expect(w.publisher.publish()).rejects.toThrow(
    'private_publish_in_progress'
  );
  options.claimOpen = false;
  const result = await w.publisher.retry();
  expect(result.access).toBe('private');
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(2);
  expect(w.uploads).toBe(1);
});

test('a seal that commits between the readback and the roster is accepted by reading it back', async () => {
  const w = await world({ loseCompletion: true, keyLagOnce: true });
  await expect(w.publisher.publish()).rejects.toThrow();
  const result = await w.publisher.retry();
  expect(result.access).toBe('private');
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(1);
  expect(w.uploads).toBe(1);
});

test('a completion conflict returns the verified accepted seal without a second completion', async () => {
  const w = await world({ completionConflict: true });
  const result = await w.publisher.publish();
  expect(result.access).toBe('private');
  expect(
    w.calls.filter((call) => call.path.endsWith('/complete'))
  ).toHaveLength(1);
  expect(w.calls.some((call) => call.path.endsWith('/versions/1/key'))).toBe(
    true
  );
});
