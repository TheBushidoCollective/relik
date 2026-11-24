import { beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  encryptedSize,
  generateRelicId,
  type AuthenticationResponseJSON,
  type RequestOptionsJSON,
} from '@relic/format';
import {
  attestationChallenge,
  decodeBase64url,
  encodeBase64url,
  generateIdentityKeys,
  identityIdOf,
  kemKeyIdOf,
  keyCommitment,
  ownerPublishBodySha256,
  signStatement,
  statementBytes,
  wrapVersionKey,
  type IdentityKeys,
} from '@relic/format/private';
import { createApp, type RelicApp } from '../src/app.ts';
import { gcsStorage } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import {
  attestation as storedAttestation,
  DAY,
  identity,
  NOW,
  relic,
} from './private-fixtures.ts';

const ORIGIN = 'https://relic.example';
const RP = 'relic.example';
const EMAIL = 'owner@example.com';
let now: number;
let app: RelicApp;
let store: MemoryStore;
let storage: MemoryStorage;

interface Authenticator {
  readonly credentialId: string;
  readonly publicJwk: JsonWebKey;
  assert(
    options: RequestOptionsJSON,
    origin: string
  ): Promise<AuthenticationResponseJSON>;
}
interface Owner {
  readonly auth: Authenticator;
  readonly keys: IdentityKeys;
  readonly identityId: string;
  readonly keyId: string;
  readonly cookie: string;
}

beforeEach(() => {
  now = NOW;
  store = new MemoryStore();
  storage = new MemoryStorage();
  app = createApp({ store, storage, now: () => now });
});

async function post(
  path: string,
  body: unknown,
  cookie?: string,
  origin = ORIGIN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers({
    'content-type': 'application/json',
    origin,
    'x-forwarded-for': '198.51.100.30, 130.211.0.1',
  });
  if (cookie !== undefined) headers.set('cookie', cookie);
  const response = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function signer(
  keys: IdentityKeys
): (bytes: Uint8Array) => Promise<Uint8Array> {
  return async (bytes) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.sig.privateKey,
        bytes as BufferSource
      )
    );
}

async function makeAuthenticator() {
  const auth = await fakeAuthenticator({ hasPrf: true });
  await auth.register(
    {
      challenge: encodeBase64url(randomBytes(32)),
      rp: { id: RP, name: 'Relik' },
      user: { id: 'dXNlcg', name: EMAIL, displayName: EMAIL },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      extensions: { prf: {} },
    } as never,
    ORIGIN
  );
  return auth;
}

async function owner(): Promise<Owner> {
  const auth = await makeAuthenticator();
  const keys = await generateIdentityKeys();
  const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const keyId = Buffer.from(await kemKeyIdOf(keys.kemPublicKey)).toString(
    'hex'
  );
  await store.createPasskeys({
    email: EMAIL,
    userHandle: 'dXNlcg',
    credentials: [
      {
        credentialId: auth.credentialId,
        publicKeyJwk: auth.publicJwk,
        alg: -7,
        signCount: 0,
        createdAt: now,
      },
    ],
  });
  await store.createIdentity(
    identity({
      identityId,
      email: EMAIL,
      address: EMAIL,
      kemPublicKey: encodeBase64url(keys.kemPublicKey),
      sigPublicKey: encodeBase64url(keys.sigPublicKey),
      kemKeyId: keyId,
      credentials: [
        {
          credentialId: auth.credentialId,
          encryptedBundle: 'bundle',
          boundAt: now,
          attestation: storedAttestation(),
        },
      ],
    })
  );
  const token = encodeBase64url(randomBytes(32));
  await store.putSession({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    email: EMAIL,
    createdAt: now,
    expiresAt: now + 30 * DAY,
    via: 'passkey',
  });
  return { auth, keys, identityId, keyId, cookie: `relic_session=${token}` };
}

async function grantBody(
  relicId = generateRelicId()
): Promise<Record<string, unknown>> {
  const response = await post('/api/challenge', {});
  expect(response.status).toBe(200);
  expect(
    (response.body['private_shares'] as Record<string, unknown>)[
      'browser_owner_publish'
    ]
  ).toBe(true);
  return {
    challenge_nonce: response.body['challenge_nonce'],
    relic_id: relicId,
    renderer_class: 'code',
    publishing_client: 'relik-web',
    declared_size_bytes: 20,
    declared_ciphertext_bytes: encryptedSize(20),
    access: 'private',
    ttl_days: 7,
  };
}

async function signedGrant(
  who: Owner,
  body: Record<string, unknown>,
  assertion = who.auth
): Promise<Record<string, unknown>> {
  const relicId = body['relic_id'] as string;
  const issued = await post(
    '/api/attest/nonce',
    { purpose: 'owner_publish', relic_id: relicId },
    who.cookie
  );
  expect(issued.status).toBe(200);
  const options = issued.body['public_key'] as {
    allowCredentials: { id: string }[];
  };
  expect(options.allowCredentials.map((c) => c.id)).toEqual([
    who.auth.credentialId,
  ]);
  const statement = {
    at: now,
    owner_identity_id: who.identityId,
    relic_id: relicId,
    challenge_nonce: body['challenge_nonce'],
    body_sha256: await ownerPublishBodySha256(body),
  };
  const bytes = statementBytes('owner_publish', statement as never);
  const nonce = issued.body['nonce'] as string;
  const challenge = encodeBase64url(
    await attestationChallenge(decodeBase64url(nonce), [bytes])
  );
  const credential = await assertion.assert(
    {
      challenge,
      rpId: RP,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: assertion.credentialId }],
    } as RequestOptionsJSON,
    ORIGIN
  );
  const { clientExtensionResults: _extensions, ...wire } =
    credential as unknown as Record<string, unknown>;
  return {
    ...body,
    owner_attestation: {
      nonce,
      statements: [
        {
          kind: 'owner_publish',
          statement,
          identity_signature: await signStatement(signer(who.keys), bytes),
        },
      ],
      credential: wire,
    },
  };
}

test('owner grant requires a session and same-origin JSON before reserving', async () => {
  const who = await owner();
  const body = await grantBody();
  const signed = await signedGrant(who, body);
  const response = await post('/api/grant', signed);
  expect(response.body['code']).toBe('sign_in_required');
  expect(await store.getRelic(body['relic_id'] as string)).toBeUndefined();
  const other = await grantBody();
  const crossOrigin = await post(
    '/api/grant',
    await signedGrant(who, other),
    who.cookie,
    'https://other.example'
  );
  expect(crossOrigin.body['code']).toBe('invalid_statement');
  expect(await store.getRelic(other['relic_id'] as string)).toBeUndefined();
});

test('a registered but unbound passkey is neither offered nor accepted', async () => {
  const who = await owner();
  const unbound = await makeAuthenticator();
  await store.updatePasskeys(EMAIL, (current) => ({
    ...current,
    credentials: [
      ...current.credentials,
      {
        credentialId: unbound.credentialId,
        publicKeyJwk: unbound.publicJwk,
        alg: -7,
        signCount: 0,
        createdAt: now,
      },
    ],
  }));
  const body = await grantBody();
  const signed = await signedGrant(who, body, unbound);
  const refused = await post('/api/grant', signed, who.cookie);
  expect(refused.body['code']).toBe('invalid_statement');
  expect(await store.getRelic(body['relic_id'] as string)).toBeUndefined();
});

test('changed grant fields and a replayed attestation cannot reserve an ID', async () => {
  const who = await owner();
  const body = await grantBody();
  const signed = await signedGrant(who, body);
  const changed = await post(
    '/api/grant',
    { ...signed, ttl_days: 8 },
    who.cookie
  );
  expect(changed.body['code']).toBe('invalid_statement');
  expect(await store.getRelic(body['relic_id'] as string)).toBeUndefined();
  const fresh = await grantBody(body['relic_id'] as string);
  const replay = await post(
    '/api/grant',
    { ...signed, challenge_nonce: fresh['challenge_nonce'] },
    who.cookie
  );
  expect(replay.body['code']).toBe('passkey_verification_failed');
  expect(await store.getRelic(body['relic_id'] as string)).toBeUndefined();
});

test('owner publish signs expiry on the initial and retry PUT and remains unreadable until sealed', async () => {
  const who = await owner();
  const body = await grantBody();
  const relicId = body['relic_id'] as string;
  const granted = await post(
    '/api/grant',
    await signedGrant(who, body),
    who.cookie
  );
  expect(granted.status).toBe(200);
  expect(granted.body['access']).toBe('private');
  expect(granted.body['publish_token']).toBeUndefined();
  const expiry = new Date(now + 7 * DAY).toISOString();
  expect(granted.body['relic_expires_at']).toBe(expiry);
  expect(
    (granted.body['upload_headers'] as Record<string, string>)[
      'x-goog-custom-time'
    ]
  ).toBe(expiry);
  expect(await store.listOwnedRelics(who.identityId)).toHaveLength(1);

  const retry = await post(
    `/api/relics/${relicId}/versions/1/upload-grant`,
    {},
    who.cookie
  );
  expect(retry.status).toBe(200);
  expect(
    (retry.body['upload_headers'] as Record<string, string>)[
      'x-goog-custom-time'
    ]
  ).toBe(expiry);
  const ciphertext = new Uint8Array(encryptedSize(20));
  ciphertext.fill(0x5a);
  storage.put(relicId, ciphertext);
  expect(storage.customTimeOf(relicId)).toBe(now + 7 * DAY);
  const notYet = await post(
    `/api/relics/${relicId}/versions/1/key`,
    {},
    who.cookie
  );
  expect(notYet.body['code']).toBe('relic_not_yet_published');

  const versionKey = new Uint8Array(16);
  crypto.getRandomValues(versionKey);
  const wrap = await wrapVersionKey({
    recipientPublicKey: who.keys.kemPublicKey,
    relicId,
    version: 1,
    key: versionKey,
  });
  const digest = createHash('sha256').update(ciphertext).digest('hex');
  const statement = {
    access_epoch: 0,
    at: now,
    ciphertext_sha256: digest,
    key_commitment: await keyCommitment({
      relicId,
      version: 1,
      key: versionKey,
    }),
    owner_epoch: 0,
    recipient_key_ids: [who.keyId],
    relic_id: relicId,
    signer_id: who.identityId,
    version: 1,
  };
  const seal = {
    statement,
    signer_kind: 'identity',
    signature: await signStatement(
      signer(who.keys),
      statementBytes('seal', statement)
    ),
  };
  const completed = await post(
    `/api/relics/${relicId}/complete`,
    {
      seal,
      wraps: [
        {
          recipient_key_id: wrap.recipientKeyId,
          version: 1,
          enc: wrap.enc,
          ct: wrap.ct,
        },
      ],
    },
    who.cookie
  );
  expect(completed.status).toBe(200);
  expect(completed.body['sealed_version']).toBe(1);
  expect(completed.body['version_digest']).toBe(digest);
  const readback = await post(
    `/api/relics/${relicId}/versions/1/key`,
    {},
    who.cookie
  );
  expect(readback.status).toBe(200);
  expect(
    (readback.body['seal'] as { statement: { ciphertext_sha256: string } })
      .statement.ciphertext_sha256
  ).toBe(digest);
  expect(
    (await post(`/api/relics/${relicId}/versions/1/key`, {})).body['code']
  ).toBe('sign_in_required');
  now += 7 * DAY;
  expect(
    (await post(`/api/relics/${relicId}/versions/1/key`, {}, who.cookie)).body[
      'code'
    ]
  ).toBe('relic_expired');
});

test('public and mixed grants refuse owner credentials without creating a row', async () => {
  const who = await owner();
  const body = await grantBody();
  const signed = await signedGrant(who, body);
  const mixed = await post(
    '/api/grant',
    { ...signed, device_auth: {} },
    who.cookie
  );
  expect(mixed.body['code']).toBe('private_policy_violation');
  expect(await store.getRelic(body['relic_id'] as string)).toBeUndefined();
  const another = await grantBody();
  const publicGrant = await post(
    '/api/grant',
    { ...(await signedGrant(who, another)), access: 'public' },
    who.cookie
  );
  expect(publicGrant.body['code']).toBe('invalid_publish_metadata');
  expect(await store.getRelic(another['relic_id'] as string)).toBeUndefined();
});

test('an interrupted unsealed owner upload carries its expiry and cannot be reissued after expiry', async () => {
  const who = await owner();
  const body = await grantBody();
  const relicId = body['relic_id'] as string;
  const granted = await post(
    '/api/grant',
    await signedGrant(who, body),
    who.cookie
  );
  expect(granted.status).toBe(200);
  storage.put(relicId, new Uint8Array(encryptedSize(20)));
  expect(storage.customTimeOf(relicId)).toBe(now + 7 * DAY);
  expect(
    (await post(`/api/relics/${relicId}/versions/1/key`, {}, who.cookie)).body[
      'code'
    ]
  ).toBe('relic_not_yet_published');
  now += 7 * DAY;
  expect(
    (
      await post(
        `/api/relics/${relicId}/versions/1/upload-grant`,
        {},
        who.cookie
      )
    ).body['code']
  ).toBe('relic_expired');
  expect(
    (await post(`/api/relics/${relicId}/versions/1/key`, {}, who.cookie)).body[
      'code'
    ]
  ).toBe('relic_expired');
});

test('GCS PUT signs the private lifecycle header and exact length', async () => {
  const gcs = gcsStorage({
    bucket: 'test-bucket',
    signer: {
      clientEmail: 'test@example.com',
      sign: async () => new Uint8Array(256),
    },
  });
  const expiresAt = NOW + 7 * DAY;
  const upload = await gcs.signUpload(
    'test-object',
    encryptedSize(20),
    600,
    NOW,
    expiresAt
  );
  expect(upload.headers['x-goog-custom-time']).toBe(
    new Date(expiresAt).toISOString()
  );
  const signed = new URL(upload.url).searchParams.get('X-Goog-SignedHeaders');
  expect(signed).toBe('content-length;host;x-goog-custom-time');
});

test('relik reservation is create-only in memory and GCS', async () => {
  const id = generateRelicId();
  const first = relic({ id });
  const second = relic({ id, publishingClient: 'other' });
  const outcomes = await Promise.all([
    store.createRelic(first),
    store.createRelic(second),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect((await store.getRelic(id))?.publishingClient).toBe('relic-mcp');

  const urls: string[] = [];
  let exists = false;
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    if (exists) return new Response(null, { status: 412 });
    exists = true;
    return new Response(null, { status: 200 });
  };
  const gcs = gcsStore({
    bucket: 'test-bucket',
    getAccessToken: async () => 'test-token',
    fetch: Object.assign(fetch, { preconnect: () => {} }),
  });
  expect(await gcs.createRelic(first)).toBe(true);
  expect(await gcs.createRelic(second)).toBe(false);
  expect(urls).toHaveLength(2);
  for (const url of urls)
    expect(new URL(url).searchParams.get('ifGenerationMatch')).toBe('0');
});
