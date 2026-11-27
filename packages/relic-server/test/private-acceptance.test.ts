import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  attestationChallenge,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  generateIdentityKeys,
  formatFingerprint,
  identityFingerprint,
  identityIdOf,
  kemKeyIdOf,
  signStatement,
  statementBytes,
  keyCommitment,
  wrapVersionKey,
  type IdentityKeys,
} from '@relic/format/private';
import { encryptedSize, type RequestOptionsJSON } from '@relic/format';
import { createApp, type RelicApp } from '../src/app.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore, type RelicRow } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import { DAY, NOW, RELIC_ID } from './private-fixtures.ts';

type FakeAuthenticator = Awaited<ReturnType<typeof fakeAuthenticator>>;

const ORIGIN = 'https://relic.example';
const RP = 'relic.example';
const PRF_FIRST = Buffer.from('relic/identity-prf/v1').toString('base64url');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

let now = NOW;
let app: RelicApp;
let store: HookStore;
let storage: MemoryStorage;

beforeEach(() => {
  now = NOW;
  store = new HookStore();
  storage = new MemoryStorage();
  app = createApp({ store, storage, now: () => now });
});

/** A signed-in person: a passkey, a session, and a fresh identity when wanted. */
interface Person {
  readonly email: string;
  readonly auth: FakeAuthenticator;
  readonly cookie: string;
  keys?: IdentityKeys;
  identityId?: string;
}

async function person(email: string): Promise<Person> {
  const auth = await fakeAuthenticator({ hasPrf: true });
  // A passkey made with prf requested, as the registration path does.
  await auth.register(
    {
      challenge: encodeBase64url(randomBytes(32)),
      rp: { id: RP, name: 'Relik' },
      user: { id: 'dXNlcg', name: email, displayName: email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      extensions: { prf: {} },
    } as never,
    ORIGIN
  );
  await store.createPasskeys({
    email,
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
  const token = encodeBase64url(randomBytes(32));
  await store.putSession({
    tokenHash: hex(new Uint8Array(createHash('sha256').update(token).digest())),
    email,
    createdAt: now,
    expiresAt: now + 30 * DAY,
    via: 'passkey',
  });
  return { email, auth, cookie: `relic_session=${token}` };
}

function req(
  path: string,
  init: RequestInit & { cookie?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', '198.51.100.30, 130.211.0.1');
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  return new Request(`https://relic.example${path}`, { ...init, headers });
}

function post(
  body: unknown,
  cookie?: string
): RequestInit & { cookie?: string } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function send(
  path: string,
  init: RequestInit & { cookie?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.fetch(req(path, init));
  const text = await response.text();
  return {
    status: response.status,
    body:
      text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function signer(keys: IdentityKeys) {
  return (bytes: Uint8Array) =>
    crypto.subtle
      .sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.sig.privateKey,
        bytes as BufferSource
      )
      .then((sig) => new Uint8Array(sig));
}

/** Makes the person's identity keys and registers the identity over the API. */
async function registerIdentity(who: Person): Promise<void> {
  const keys = await generateIdentityKeys();
  who.keys = keys;
  who.identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const statement = {
    at: now,
    email: who.email,
    identity_id: who.identityId,
    kem_public_key: encodeBase64url(keys.kemPublicKey),
    replaces: null,
    sig_public_key: encodeBase64url(keys.sigPublicKey),
  };
  const attestation = await attest(who, 'identity_register', undefined, [
    { kind: 'identity_register', statement, sign: false },
  ]);
  const response = await send(
    '/api/identity',
    post(
      {
        attestation,
        encrypted_bundle: encodeBase64url(randomBytes(64)),
        replace: false,
      },
      who.cookie
    )
  );
  expect({ status: response.status, code: response.body['code'] }).toEqual({
    status: 201,
    code: undefined,
  });
}

/**
 * A WebAuthn assertion over the statements, through the real nonce route.
 * `sign: false` means the statement names its own key and is signed here by
 * the caller's identity key, which is the registration case.
 */
async function attest(
  who: Person,
  purpose: string,
  relicId: string | undefined,
  statements: {
    kind: string;
    statement: Record<string, unknown>;
    sign?: boolean;
  }[]
): Promise<Record<string, unknown>> {
  const nonceResponse = await send(
    '/api/attest/nonce',
    post(
      relicId === undefined ? { purpose } : { purpose, relic_id: relicId },
      who.cookie
    )
  );
  expect(nonceResponse.status).toBe(200);
  const nonce = nonceResponse.body['nonce'] as string;
  const bytes = statements.map((s) =>
    statementBytes(s.kind as never, s.statement as never)
  );
  const challenge = encodeBase64url(
    await attestationChallenge(decodeBase64url(nonce), bytes)
  );
  const credential = await who.auth.assert(
    {
      challenge,
      rpId: RP,
      timeout: 300_000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: who.auth.credentialId }],
      extensions: { prf: { eval: { first: PRF_FIRST } } },
    } as RequestOptionsJSON,
    ORIGIN
  );
  const signed = [];
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i] as (typeof statements)[number];
    const signature =
      s.sign === false
        ? await signStatement(
            signer(who.keys as IdentityKeys),
            bytes[i] as Uint8Array
          )
        : await signStatement(
            signer(who.keys as IdentityKeys),
            bytes[i] as Uint8Array
          );
    signed.push({
      kind: s.kind,
      statement: s.statement,
      identity_signature: signature,
    });
  }
  // The browser serializer omits clientExtensionResults (plan 4.4), so the PRF output never reaches the server.
  const { clientExtensionResults: _prfOutput, ...wire } =
    credential as unknown as Record<string, unknown>;
  return { nonce, statements: signed, credential: wire };
}

/** Device enrollment and approval by the owner, through the API. */
async function certifyDevice(
  owner: Person
): Promise<{ keys: IdentityKeys; deviceId: string }> {
  const keys = await generateIdentityKeys();
  const deviceId = await deviceIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const label = 'laptop';
  const proofStatement = { at: now, device_id: deviceId, label };
  const proofSignature = await signStatement(
    signer(keys),
    statementBytes('device_enroll', proofStatement as never)
  );
  const enrolled = await send(
    '/api/devices/enrollments',
    post({
      kem_public_key: encodeBase64url(keys.kemPublicKey),
      sig_public_key: encodeBase64url(keys.sigPublicKey),
      label,
      backend: 'file',
      proof: { statement: proofStatement, signature: proofSignature },
    })
  );
  expect(enrolled.status).toBe(201);
  const enrollmentId = String(enrolled.body['enrollment_id']);
  const certStatement = {
    at: now,
    device_fingerprint_typed: await deviceFingerprint(deviceId),
    device_id: deviceId,
    kem_public_key: encodeBase64url(keys.kemPublicKey),
    label,
    not_after: now + 365 * DAY,
    owner_identity_id: owner.identityId,
    sig_public_key: encodeBase64url(keys.sigPublicKey),
  };
  const attestation = await attest(owner, 'device_approve', undefined, [
    { kind: 'device_cert', statement: certStatement },
  ]);
  const approved = await send(
    `/api/devices/enrollments/${enrollmentId}/approve`,
    post({ attestation }, owner.cookie)
  );
  expect(approved.status).toBe(200);
  return { keys, deviceId };
}

/**
 * A private relic published by the owner's device and sealed at version 1,
 * with the owner and the device as its recipients.
 */
async function sealedPrivateRelic(
  owner: Person,
  options: { readonly decisions?: boolean } = {}
): Promise<{
  deviceKeys: IdentityKeys;
  deviceId: string;
  versionKey: Uint8Array;
  digest: string;
  publishToken: string;
}> {
  const { keys: deviceKeys, deviceId } = await certifyDevice(owner);
  const content = randomBytes(64);
  const challenge = await send('/api/challenge', { method: 'POST' });
  const nonce = challenge.body['challenge_nonce'] as string;
  const publish = {
    challenge_nonce: nonce,
    relic_id: RELIC_ID,
    renderer_class: 'markdown',
    publishing_client: 'relic-test/1',
    access: 'private',
    declared_size_bytes: content.byteLength,
    declared_ciphertext_bytes: encryptedSize(content.byteLength),
    ...(options.decisions === true ? { decisions: true } : {}),
  };
  const deviceAuth = {
    device_id: deviceId,
    nonce,
    at: now,
    signature: await signStatement(
      signer(deviceKeys),
      statementBytes('private_publish', {
        at: now,
        challenge_nonce: nonce,
        device_id: deviceId,
        relic_id: RELIC_ID,
        ttl_days: null,
      } as never)
    ),
  };
  const granted = await send(
    '/api/grant',
    post({ ...publish, device_auth: deviceAuth })
  );
  expect(granted.status).toBe(200);
  expect(granted.body['access']).toBe('private');
  expect(granted.body['access_epoch']).toBe(0);

  // The owner's store-side bytes, as the browser or the MCP would upload them.
  storage.put(RELIC_ID, content);
  const digest = hex(
    new Uint8Array(createHash('sha256').update(content).digest())
  );
  const versionKey = randomBytes(16);
  const owner32 = owner.keys as IdentityKeys;
  const ownerRecord = await store.getIdentity(owner.identityId as string);
  const recipients = [
    ownerRecord!.kemKeyId,
    await deviceKeyId(deviceKeys),
  ].sort();
  const sealStatement = {
    access_epoch: 0,
    at: now,
    ciphertext_sha256: digest,
    key_commitment: await keyCommitment({
      relicId: RELIC_ID,
      version: 1,
      key: versionKey,
    }),
    owner_epoch: ownerRecord!.recipientsEpoch,
    recipient_key_ids: recipients,
    relic_id: RELIC_ID,
    signer_id: deviceId,
    version: 1,
  };
  const wraps = [
    await wrap(owner32.kemPublicKey, versionKey, 1),
    await wrap(deviceKeys.kemPublicKey, versionKey, 1),
  ];
  const sealed = await send(
    `/api/relics/${RELIC_ID}/complete`,
    post({
      seal: {
        statement: sealStatement,
        signature: await signStatement(
          signer(deviceKeys),
          statementBytes('seal', sealStatement as never)
        ),
        signer_kind: 'device',
      },
      wraps,
    })
  );
  expect(sealed.status).toBe(200);
  return {
    deviceKeys,
    deviceId,
    versionKey,
    digest,
    publishToken: granted.body['publish_token'] as string,
  };
}

async function deviceKeyId(keys: IdentityKeys): Promise<string> {
  return hex(await kemKeyIdOf(keys.kemPublicKey));
}

async function wrap(
  kemPublicKey: Uint8Array,
  key: Uint8Array,
  version: number
) {
  const w = await wrapVersionKey({
    recipientPublicKey: kemPublicKey,
    relicId: RELIC_ID,
    version,
    key,
  });
  return { recipient_key_id: w.recipientKeyId, version, enc: w.enc, ct: w.ct };
}

/**
 * A store whose next relic-row compare-and-swap first runs a hook. Used to land
 * a grant or a seal in the window between one request's recipient read and its
 * own CAS, which is the race the epochs must catch.
 */
class HookStore extends MemoryStore {
  beforeUpdate: (() => Promise<void>) | undefined;
  beforePutGrant: (() => Promise<void>) | undefined;

  override async updateRelic(
    id: string,
    change: (row: RelicRow) => RelicRow
  ): Promise<RelicRow | undefined> {
    const hook = this.beforeUpdate;
    if (hook !== undefined) {
      this.beforeUpdate = undefined;
      await hook();
    }
    return super.updateRelic(id, change);
  }

  override async putGrant(
    row: Parameters<MemoryStore['putGrant']>[0]
  ): Promise<boolean> {
    const hook = this.beforePutGrant;
    if (hook !== undefined) {
      this.beforePutGrant = undefined;
      await hook();
    }
    return super.putGrant(row);
  }
}

const EMPTY_SHA = createHash('sha256').update('{}').digest('hex');

/** Opens version 2 of the relic at store level, with bytes ready to seal. */
async function openVersionTwo(): Promise<Uint8Array> {
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    version: 2,
    publishedAt: undefined,
    objectLength: undefined,
    objectCrc32c: undefined,
  }));
  const bytes = randomBytes(48);
  storage.put(`${RELIC_ID}/v2`, bytes);
  return bytes;
}

/** Seals version 2 for the owner and device, plus any extra recipient keys. */
async function sealVersionTwo(
  owner: Person,
  device: { keys: IdentityKeys; deviceId: string },
  bytes: Uint8Array,
  extra: readonly { kemPublicKey: Uint8Array; keyId: string }[]
): Promise<{ status: number; body: Record<string, unknown>; key: Uint8Array }> {
  const built = await buildSealVersionTwo(owner, device, bytes, extra);
  const result = await send(
    `/api/relics/${RELIC_ID}/complete`,
    post(built.body)
  );
  return { status: result.status, body: result.body, key: built.key };
}

/**
 * The version-two seal request as the device (or the owner's identity) would
 * send it at this moment.
 */
async function buildSealVersionTwo(
  owner: Person,
  device: { keys: IdentityKeys; deviceId: string },
  bytes: Uint8Array,
  extra: readonly { kemPublicKey: Uint8Array; keyId: string }[],
  signedBy: 'device' | 'owner' = 'device'
): Promise<{ body: Record<string, unknown>; key: Uint8Array }> {
  const key = randomBytes(16);
  const ownerRecord = await store.getIdentity(owner.identityId as string);
  const row = await store.getRelic(RELIC_ID);
  const deviceKeyId = await deviceKeyId_(device.keys);
  const recipients = [
    ownerRecord!.kemKeyId,
    deviceKeyId,
    ...extra.map((e) => e.keyId),
  ].sort();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const statement = {
    access_epoch: row!.accessEpoch ?? 0,
    at: now,
    ciphertext_sha256: digest,
    key_commitment: await keyCommitment({
      relicId: RELIC_ID,
      version: 2,
      key,
    }),
    owner_epoch: ownerRecord!.recipientsEpoch,
    recipient_key_ids: recipients,
    relic_id: RELIC_ID,
    signer_id: signedBy === 'owner' ? owner.identityId : device.deviceId,
    version: 2,
  };
  const wraps = [
    await wrap(owner.keys!.kemPublicKey, key, 2),
    await wrap(device.keys.kemPublicKey, key, 2),
    ...(await Promise.all(extra.map((e) => wrap(e.kemPublicKey, key, 2)))),
  ];
  return {
    body: {
      seal: {
        statement,
        signature: await signStatement(
          signer(
            signedBy === 'owner' ? (owner.keys as IdentityKeys) : device.keys
          ),
          statementBytes('seal', statement as never)
        ),
        signer_kind: signedBy === 'owner' ? 'identity' : 'device',
      },
      wraps,
    },
    key,
  };
}

async function deviceKeyId_(keys: IdentityKeys): Promise<string> {
  return hex(await kemKeyIdOf(keys.kemPublicKey));
}

/** A grant of the listed versions to a registered reader, wrapped with `key`. */
async function grantTo(
  owner: Person,
  reader: Person,
  versions: number[],
  key: Uint8Array
): Promise<{ status: number; body: Record<string, unknown> }> {
  const readerRecord = await store.getIdentity(reader.identityId as string);
  const attestation = await attest(owner, 'grant', RELIC_ID, [
    {
      kind: 'grant',
      statement: {
        at: now,
        fingerprint_typed: await identityFingerprint(
          reader.identityId as string,
          reader.email
        ),
        grantee_email: reader.email,
        grantee_identity_id: reader.identityId,
        owner_identity_id: owner.identityId,
        relic_id: RELIC_ID,
        versions,
      },
    },
  ]);
  return send(
    `/api/relics/${RELIC_ID}/grants`,
    post(
      {
        attestation,
        wraps: await Promise.all(
          versions.map((v) =>
            wrap(decodeBase64url(readerRecord!.kemPublicKey), key, v)
          )
        ),
      },
      owner.cookie
    )
  );
}

/** A grant statement for one reader and versions, as the owner's browser signs it. */
async function grantStatementFor(
  owner: Person,
  reader: Person,
  versions: number[]
) {
  return {
    kind: 'grant' as const,
    statement: {
      at: now,
      fingerprint_typed: await identityFingerprint(
        reader.identityId as string,
        reader.email
      ),
      grantee_email: reader.email,
      grantee_identity_id: reader.identityId,
      owner_identity_id: owner.identityId,
      relic_id: RELIC_ID,
      versions,
    },
  };
}

/** A batch of grants under one owner attestation, each reader wrapped to `keyFor(version)`. */
async function grantBatch(
  owner: Person,
  grants: { reader: Person; versions: number[] }[],
  keyFor: (version: number) => Uint8Array
): Promise<{ status: number; body: Record<string, unknown> }> {
  const attestation = await attest(
    owner,
    'grant',
    RELIC_ID,
    await Promise.all(
      grants.map((g) => grantStatementFor(owner, g.reader, g.versions))
    )
  );
  const wraps = [];
  for (const g of grants) {
    const readerRecord = await store.getIdentity(g.reader.identityId as string);
    for (const version of g.versions) {
      wraps.push(
        await wrap(
          decodeBase64url(readerRecord!.kemPublicKey),
          keyFor(version),
          version
        )
      );
    }
  }
  return send(
    `/api/relics/${RELIC_ID}/grants`,
    post({ attestation, wraps }, owner.cookie)
  );
}

describe('access requests', () => {
  test('a request is pending, repeats answer 200, the owner lists it, and a decline is final', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const statement = {
      at: now,
      relic_id: RELIC_ID,
      requester_identity_id: reader.identityId,
    };

    const first = await send(
      `/api/relics/${RELIC_ID}/requests`,
      post(
        {
          attestation: await attest(reader, 'access_request', RELIC_ID, [
            { kind: 'access_request', statement },
          ]),
        },
        reader.cookie
      )
    );
    expect(first.status).toBe(201);
    expect(first.body['status']).toBe('pending');

    const repeat = await send(
      `/api/relics/${RELIC_ID}/requests`,
      post(
        {
          attestation: await attest(reader, 'access_request', RELIC_ID, [
            { kind: 'access_request', statement },
          ]),
        },
        reader.cookie
      )
    );
    expect(repeat.status).toBe(200);

    const listed = await send(`/api/relics/${RELIC_ID}/requests`, {
      cookie: owner.cookie,
    });
    expect(listed.status).toBe(200);
    const requests = listed.body['requests'] as {
      status: string;
      requester: { email: string };
    }[];
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('pending');
    expect(requests[0]!.requester.email).toBe(reader.email);

    const declined = await send(
      `/api/relics/${RELIC_ID}/requests/${reader.identityId}/decline`,
      post({}, owner.cookie)
    );
    expect(declined.status).toBe(200);
    const missing = await send(
      `/api/relics/${RELIC_ID}/requests/${'e'.repeat(64)}/decline`,
      post({}, owner.cookie)
    );
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('request_not_found');
  });

  test('a caller without an identity is refused, and a full queue refuses the next request', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const stranger = await person('stranger@example.com');
    const noIdentity = await send(
      `/api/relics/${RELIC_ID}/requests`,
      post(
        {
          attestation: {},
        },
        stranger.cookie
      )
    );
    expect(noIdentity.status).toBe(409);
    expect(noIdentity.body['code']).toBe('identity_required');

    const first = await person('first@example.com');
    await registerIdentity(first);
    const second = await person('second@example.com');
    await registerIdentity(second);
    app = createApp({
      store,
      storage,
      now: () => now,
      config: { privatePendingRequestsMax: 1 },
    });
    const requestFor = async (who: Person) =>
      send(
        `/api/relics/${RELIC_ID}/requests`,
        post(
          {
            attestation: await attest(who, 'access_request', RELIC_ID, [
              {
                kind: 'access_request',
                statement: {
                  at: now,
                  relic_id: RELIC_ID,
                  requester_identity_id: who.identityId,
                },
              },
            ]),
          },
          who.cookie
        )
      );
    expect((await requestFor(first)).status).toBe(201);
    const full = await requestFor(second);
    expect(full.status).toBe(409);
    expect(full.body['code']).toBe('request_limit_reached');
  });

  test('the request mail names the requester and not the relik, and the grant mail goes to the grantee without a title', async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    store = new HookStore();
    app = createApp({
      store,
      storage,
      now: () => now,
      mailer: {
        send: async () => {},
        sendMail: async (to, mail) => {
          sent.push({ to, subject: mail.subject, text: mail.text });
        },
      },
    });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);

    await send(
      `/api/relics/${RELIC_ID}/requests`,
      post(
        {
          attestation: await attest(reader, 'access_request', RELIC_ID, [
            {
              kind: 'access_request',
              statement: {
                at: now,
                relic_id: RELIC_ID,
                requester_identity_id: reader.identityId,
              },
            },
          ]),
        },
        reader.cookie
      )
    );
    const requestMail = sent.find((m) => m.to === owner.email);
    expect(requestMail?.subject).toBe(
      `${reader.email} asked for access to a relik`
    );
    expect(requestMail?.text).toContain(reader.email);
    expect(requestMail?.text).toContain(`grant=${reader.identityId}`);
    expect(requestMail?.text).not.toContain('Secret');

    const granted = await grantTo(owner, reader, [1], sealed.versionKey);
    expect(granted.status).toBe(201);
    const grantMail = sent.find((m) => m.to === reader.email);
    expect(grantMail?.subject).toBe('You have access to a relik');
    expect(grantMail?.text).not.toContain('Secret');
  });

  test('a direct share mails the recipient the owner address and their own fingerprint, with no title', async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    store = new HookStore();
    app = createApp({
      store,
      storage,
      now: () => now,
      mailer: {
        send: async () => {},
        sendMail: async (to, mail) => {
          sent.push({ to, subject: mail.subject, text: mail.text });
        },
      },
    });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);

    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );
    const notice = sent.find((m) => m.to === reader.email);
    expect(notice?.subject).toBe(`${owner.email} shared a relik with you`);
    const fingerprint = formatFingerprint(
      await identityFingerprint(reader.identityId as string, reader.email)
    );
    expect(notice?.text).toContain(`Your fingerprint: ${fingerprint}`);
    expect(notice?.text).toContain(owner.email);
    expect(notice?.text).not.toContain('SECRET');
  });
});

describe('backfill and coverage', () => {
  test('a recovery designation leaves a coverage gap that a backfill repairs, and bad wraps are refused', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const recovery = await person('recovery@example.com');
    await registerIdentity(recovery);
    const outsider = await person('outsider@example.com');
    await registerIdentity(outsider);

    const designated = await send(
      '/api/identity/recovery',
      post(
        {
          attestation: await attest(owner, 'recovery_designate', undefined, [
            {
              kind: 'recovery_designation',
              statement: {
                at: now,
                fingerprint_typed: await identityFingerprint(
                  recovery.identityId as string,
                  recovery.email
                ),
                owner_identity_id: owner.identityId,
                recovery_email: recovery.email,
                recovery_identity_id: recovery.identityId,
              },
            },
          ]),
        },
        owner.cookie
      )
    );
    expect(designated.status).toBe(200);

    const gapped = await send('/api/identity/relics?coverage=1', {
      cookie: owner.cookie,
    });
    const owned = gapped.body['owned'] as {
      relic_id: string;
      coverage_gaps: number[];
    }[];
    expect(owned[0]!.coverage_gaps).toEqual([1]);

    const recoveryRecord = await store.getIdentity(
      recovery.identityId as string
    );
    const repair = await wrap(
      decodeBase64url(recoveryRecord!.kemPublicKey),
      sealed.versionKey,
      1
    );
    const backfilled = await send(
      '/api/identity/backfill',
      post(
        {
          wraps: [{ relic_id: RELIC_ID, ...repair }],
        },
        owner.cookie
      )
    );
    expect(backfilled.status).toBe(200);
    expect(backfilled.body).toEqual({ stored: 1, skipped: 0 });

    const again = await send(
      '/api/identity/backfill',
      post(
        {
          wraps: [{ relic_id: RELIC_ID, ...repair }],
        },
        owner.cookie
      )
    );
    expect(again.body).toEqual({ stored: 0, skipped: 1 });

    const healed = await send('/api/identity/relics?coverage=1', {
      cookie: owner.cookie,
    });
    expect(
      (healed.body['owned'] as { coverage_gaps: number[] }[])[0]!.coverage_gaps
    ).toEqual([]);

    const notRecipient = await wrap(
      decodeBase64url(
        (await store.getIdentity(outsider.identityId as string))!.kemPublicKey
      ),
      sealed.versionKey,
      1
    );
    const refused = await send(
      '/api/identity/backfill',
      post(
        {
          wraps: [{ relic_id: RELIC_ID, ...notRecipient }],
        },
        owner.cookie
      )
    );
    expect(refused.status).toBe(400);
    expect(refused.body['code']).toBe('invalid_wrap');

    app = createApp({
      store,
      storage,
      now: () => now,
      config: { privateBackfillMaxWraps: 1 },
    });
    const capped = await send(
      '/api/identity/backfill',
      post(
        {
          wraps: [
            { relic_id: RELIC_ID, ...repair },
            { relic_id: RELIC_ID, ...repair },
          ],
        },
        owner.cookie
      )
    );
    expect(capped.status).toBe(400);
    expect(capped.body['code']).toBe('invalid_wrap');
  });
  test('partial grants report only covered gaps and reject uncovered backfills', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const second = await sealVersionTwo(
      owner,
      device,
      await openVersionTwo(),
      []
    );
    expect(second.status).toBe(200);
    expect((await grantTo(owner, reader, [2], second.key)).status).toBe(201);
    const readerKey = (await store.getIdentity(reader.identityId!))!.kemKeyId;
    const coverage = async () =>
      send('/api/identity/relics?coverage=1', { cookie: owner.cookie });
    expect((await coverage()).body['owned']).toMatchObject([
      { coverage_gaps: [] },
    ]);
    const uncovered = await wrap(
      reader.keys!.kemPublicKey,
      sealed.versionKey,
      1
    );
    const backfill = await send(
      '/api/identity/backfill',
      post({ wraps: [{ relic_id: RELIC_ID, ...uncovered }] }, owner.cookie)
    );
    expect(backfill.status).toBe(400);
    expect(backfill.body['code']).toBe('invalid_wrap');
    await store.putWrap({
      relicId: RELIC_ID,
      recipientKeyId: readerKey,
      version: 1,
      enc: uncovered.enc,
      ct: uncovered.ct,
      createdAt: now,
      source: 'backfill',
    });
    const publisherRead = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ publish_token: sealed.publishToken, recipient_key_id: readerKey })
    );
    expect(publisherRead.status).toBe(403);
    await store.deleteWraps(RELIC_ID, {
      recipientKeyId: readerKey,
      version: 2,
    });
    expect((await coverage()).body['owned']).toMatchObject([
      { coverage_gaps: [2] },
    ]);
  });
});

describe('grant lookup', () => {
  test('only the owner may look up addresses and recovery shares the per-address budget', async () => {
    app = createApp({
      store,
      storage,
      now: () => now,
      config: {
        identityLookupRateLimit: { limit: 2, windowSeconds: 3600 },
      },
    });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const path = `/api/relics/${RELIC_ID}/grants/lookup`;
    expect((await send(path, post({ emails: [reader.email] }))).status).toBe(
      401
    );
    expect(
      (await send(path, post({ emails: [reader.email] }, reader.cookie))).status
    ).toBe(403);
    const response = await send(
      path,
      post({ emails: [owner.email, 'missing@example.com'] }, owner.cookie)
    );
    expect(response.status).toBe(200);
    const results = response.body['results'] as Record<string, unknown>[];
    expect(results[0]!['standing']).toBe('owner');
    expect(results[1]!['party']).toBeNull();
    expect(results[1]!['standing']).toBeNull();
    expect(results[1]!['invites']).toEqual([]);
    const blocked = await send(
      '/api/identity/recovery/lookup',
      post({ email: reader.email }, owner.cookie)
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body['code']).toBe('private_rate_limited');
  });
});

describe('grant authority', () => {
  test('the owner cannot grant to their own identity', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);

    const refused = await grantTo(owner, owner, [1], sealed.versionKey);
    expect(refused.status).toBe(400);
    expect(refused.body['code']).toBe('invalid_statement');
    expect(refused.body['statement_check']).toBe('grantee');
    expect(
      await store.getGrant(RELIC_ID, owner.identityId as string)
    ).toBeUndefined();
  });

  test('each roster entry serves its own signed grant statement', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const first = await person('first@example.com');
    const second = await person('second@example.com');
    await registerIdentity(first);
    await registerIdentity(second);
    expect((await grantTo(owner, first, [1], sealed.versionKey)).status).toBe(
      201
    );
    expect((await grantTo(owner, second, [1], sealed.versionKey)).status).toBe(
      201
    );
    const firstGrant = await store.getGrant(
      RELIC_ID,
      first.identityId as string
    );
    const secondGrant = await store.getGrant(
      RELIC_ID,
      second.identityId as string
    );
    await store.updateGrant(RELIC_ID, second.identityId as string, (row) => ({
      ...row,
      attestation: {
        ...row.attestation,
        statements: [
          firstGrant!.attestation.statements[0]!,
          secondGrant!.attestation.statements[0]!,
        ],
      },
    }));

    const response = await recipientsOf(owner);
    expect(response.status).toBe(200);
    const grants = response.body['grants'] as {
      statement: Record<string, unknown>;
      identity_signature: string;
    }[];
    const served = grants.find(
      (entry) => entry.statement['grantee_identity_id'] === second.identityId
    );
    expect(served?.identity_signature).toBe(
      secondGrant!.attestation.statements[0]!.identitySignature
    );
  });

  test('a grant that loses its row race keeps the winner and rolls back its own extra wraps', async () => {
    store = new HookStore();
    app = createApp({ store, storage, now: () => now });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const bytes = await openVersionTwo();
    const second = await sealVersionTwo(owner, device, bytes, []);
    expect(second.status).toBe(200);
    // The winner keeps version 2 even though the loser wrote both wraps.
    let winner: { status: number; body: Record<string, unknown> } | undefined;
    store.beforePutGrant = async () => {
      winner = await grantBatch(
        owner,
        [{ reader, versions: [2] }],
        (version) => (version === 1 ? sealed.versionKey : second.key)
      );
    };
    const loser = await grantBatch(
      owner,
      [{ reader, versions: [1, 2] }],
      (version) => (version === 1 ? sealed.versionKey : second.key)
    );

    expect(winner?.status).toBe(201);
    expect(loser.status).toBe(409);
    expect(loser.body['code']).toBe('grant_exists');
    expect(loser.body['grantee_identity_id']).toBe(reader.identityId);
    const readerRecord = await store.getIdentity(reader.identityId as string);
    const kept = await store.getGrant(RELIC_ID, reader.identityId as string);
    expect(kept?.versions).toEqual([2]);
    expect(
      await store.getWrap(RELIC_ID, 2, readerRecord!.kemKeyId)
    ).toBeDefined();
    const denied = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, reader.cookie)
    );
    expect(denied.status).toBe(403);
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/versions/2/key`,
          post({}, reader.cookie)
        )
      ).status
    ).toBe(200);
  });

  test('one attestation grants two readers, and the response lists each grant', async () => {
    store = new HookStore();
    app = createApp({ store, storage, now: () => now });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const first = await person('first@example.com');
    const second = await person('second@example.com');
    await registerIdentity(first);
    await registerIdentity(second);

    const res = await grantBatch(
      owner,
      [
        { reader: first, versions: [1] },
        { reader: second, versions: [1] },
      ],
      () => sealed.versionKey
    );
    expect(res.status).toBe(201);
    expect(res.body['grant']).toBeNull();
    const grants = res.body['grants'] as {
      statement: Record<string, unknown>;
    }[];
    expect(
      grants.map((g) => g.statement['grantee_identity_id']).sort()
    ).toEqual([first.identityId, second.identityId].sort());
    expect(
      await store.getGrant(RELIC_ID, first.identityId as string)
    ).toBeDefined();
    expect(
      await store.getGrant(RELIC_ID, second.identityId as string)
    ).toBeDefined();
  });

  test('a reader who already reads the relik is refused by grant_exists, and nothing changes', async () => {
    store = new HookStore();
    app = createApp({ store, storage, now: () => now });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );
    const before = await store.getGrant(RELIC_ID, reader.identityId as string);

    const again = await grantTo(owner, reader, [1], sealed.versionKey);
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('grant_exists');
    expect(again.body['grantee_identity_id']).toBe(reader.identityId);
    expect(await store.getGrant(RELIC_ID, reader.identityId as string)).toEqual(
      before
    );
  });

  test('a batch over privateShareMaxPerCall is refused by count before anything is written', async () => {
    store = new HookStore();
    app = createApp({
      store,
      storage,
      now: () => now,
      config: { privateShareMaxPerCall: 1 },
    });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const first = await person('first@example.com');
    const second = await person('second@example.com');
    await registerIdentity(first);
    await registerIdentity(second);

    const res = await grantBatch(
      owner,
      [
        { reader: first, versions: [1] },
        { reader: second, versions: [1] },
      ],
      () => sealed.versionKey
    );
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('invalid_statement');
    expect(res.body['statement_check']).toBe('count');
    expect(await store.listGrants(RELIC_ID)).toEqual([]);
  });

  test('the direct-share budget refuses a whole batch and charges nothing for it', async () => {
    store = new HookStore();
    app = createApp({
      store,
      storage,
      now: () => now,
      config: { directShareRateLimit: { limit: 1, windowSeconds: 3600 } },
    });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const first = await person('first@example.com');
    const second = await person('second@example.com');
    await registerIdentity(first);
    await registerIdentity(second);

    const refused = await grantBatch(
      owner,
      [
        { reader: first, versions: [1] },
        { reader: second, versions: [1] },
      ],
      () => sealed.versionKey
    );
    expect(refused.status).toBe(429);
    expect(refused.body['code']).toBe('private_rate_limited');
    expect(await store.listGrants(RELIC_ID)).toEqual([]);

    // Nothing was charged, so one grant still fits the one unit.
    expect((await grantTo(owner, first, [1], sealed.versionKey)).status).toBe(
      201
    );
  });
});

describe('the interleaved grant and seal race', () => {
  test('a grant landing between a seal’s recipient read and its CAS refuses the seal, and a re-seal wraps the grantee into the new version', async () => {
    store = new HookStore();
    app = createApp({ store, storage, now: () => now });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const bytes = await openVersionTwo();
    const readerRecord = await store.getIdentity(reader.identityId as string);
    const readerExtra = [
      {
        kemPublicKey: decodeBase64url(readerRecord!.kemPublicKey),
        keyId: readerRecord!.kemKeyId,
      },
    ];

    let granted: { status: number; body: Record<string, unknown> } | undefined;
    store.beforeUpdate = async () => {
      granted = await grantTo(owner, reader, [1], sealed.versionKey);
    };
    const racedSeal = await sealVersionTwo(owner, device, bytes, []);
    expect(granted?.status).toBe(201);
    expect(racedSeal.status).toBe(409);
    expect(racedSeal.body['code']).toBe('recipients_changed');

    const retried = await sealVersionTwo(owner, device, bytes, readerExtra);
    expect(retried.status).toBe(200);
    expect(
      await store.getWrap(RELIC_ID, 2, readerRecord!.kemKeyId)
    ).toBeDefined();
  });

  test('a seal winning the grant CAS leaves inert wraps and allows a later partial grant', async () => {
    store = new HookStore();
    app = createApp({ store, storage, now: () => now });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const bytes = await openVersionTwo();
    const readerRecord = await store.getIdentity(reader.identityId as string);
    const readerExtra = [
      {
        kemPublicKey: decodeBase64url(readerRecord!.kemPublicKey),
        keyId: readerRecord!.kemKeyId,
      },
    ];

    // The grant writes its row before its CAS, so a seal inside that window
    // sees the reader as a recipient and must wrap the reader for version 2.
    let sealedFirst: { status: number; key: Uint8Array } | undefined;
    store.beforeUpdate = async () => {
      sealedFirst = await sealVersionTwo(owner, device, bytes, readerExtra);
    };
    const refused = await grantTo(owner, reader, [1], sealed.versionKey);
    expect(sealedFirst?.status).toBe(200);
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('grant_stale_version');
    expect(
      await store.getGrant(RELIC_ID, reader.identityId as string)
    ).toBeUndefined();
    for (const version of [1, 2]) {
      expect(
        (
          await send(
            `/api/relics/${RELIC_ID}/versions/${version}/key`,
            post({}, reader.cookie)
          )
        ).status
      ).toBe(403);
    }
    expect((await grantTo(owner, reader, [2], sealedFirst!.key)).status).toBe(
      201
    );
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/versions/1/key`,
          post({}, reader.cookie)
        )
      ).status
    ).toBe(403);
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/versions/2/key`,
          post({}, reader.cookie)
        )
      ).status
    ).toBe(200);
  });
});

test('a former recovery holder only reads versions covered by their grant', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const sealed = await sealedPrivateRelic(owner);
  const holder = await person('holder@example.com');
  await registerIdentity(holder);
  expect((await designate(owner, holder)).status).toBe(200);
  const holderRecord = (await store.getIdentity(holder.identityId!))!;
  const recoveryWrap = await wrap(
    holder.keys!.kemPublicKey,
    sealed.versionKey,
    1
  );
  expect(
    (
      await send(
        '/api/identity/backfill',
        post({ wraps: [{ relic_id: RELIC_ID, ...recoveryWrap }] }, owner.cookie)
      )
    ).status
  ).toBe(200);
  const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
  const second = await sealVersionTwo(owner, device, await openVersionTwo(), [
    { kemPublicKey: holder.keys!.kemPublicKey, keyId: holderRecord.kemKeyId },
  ]);
  expect(second.status).toBe(200);
  expect((await grantTo(owner, holder, [2], second.key)).status).toBe(201);
  expect((await designate(owner, undefined)).status).toBe(200);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, holder.cookie)
      )
    ).status
  ).toBe(403);
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/2/key`,
        post({}, holder.cookie)
      )
    ).status
  ).toBe(200);
});

test('a later seal remains readable to an existing grantee', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const sealed = await sealedPrivateRelic(owner);
  const reader = await person('reader@example.com');
  await registerIdentity(reader);
  expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
    201
  );
  const readerRecord = (await store.getIdentity(reader.identityId!))!;
  const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
  const second = await sealVersionTwo(owner, device, await openVersionTwo(), [
    { kemPublicKey: reader.keys!.kemPublicKey, keyId: readerRecord.kemKeyId },
  ]);
  expect(second.status).toBe(200);
  for (const version of [1, 2]) {
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/versions/${version}/key`,
          post({}, reader.cookie)
        )
      ).status
    ).toBe(200);
  }
});

test('a failed revocation epoch move restores the grant without deleting its wraps', async () => {
  const owner = await person('owner@example.com');
  await registerIdentity(owner);
  const sealed = await sealedPrivateRelic(owner);
  const reader = await person('reader@example.com');
  await registerIdentity(reader);
  expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
    201
  );
  store.beforeUpdate = async () => {
    await store.updateRelic(RELIC_ID, (current) => ({
      ...current,
      version: current.version + 1,
    }));
  };
  const failed = await revokeGrant(owner, reader);
  expect(failed.status).toBe(409);
  expect(failed.body['code']).toBe('version_conflict');
  expect(
    (await store.getGrant(RELIC_ID, reader.identityId!))?.revokedAt
  ).toBeUndefined();
  expect(
    (
      await send(
        `/api/relics/${RELIC_ID}/versions/1/key`,
        post({}, reader.cookie)
      )
    ).status
  ).toBe(200);
});

describe('device enrollment and context', () => {
  test('a pending enrollment reports its public keys, a mismatched fingerprint is refused, and a revoked device gets 403', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const keys = await generateIdentityKeys();
    const deviceId = await deviceIdOf(keys.kemPublicKey, keys.sigPublicKey);
    const proof = { at: now, device_id: deviceId, label: 'laptop' };
    const enrolled = await send(
      '/api/devices/enrollments',
      post({
        kem_public_key: encodeBase64url(keys.kemPublicKey),
        sig_public_key: encodeBase64url(keys.sigPublicKey),
        label: 'laptop',
        backend: 'file',
        proof: {
          statement: proof,
          signature: await signStatement(
            signer(keys),
            statementBytes('device_enroll', proof as never)
          ),
        },
      })
    );
    expect(enrolled.status).toBe(201);
    const enrollmentId = String(enrolled.body['enrollment_id']);

    const pending = await send(`/api/devices/enrollments/${enrollmentId}`);
    expect(pending.body['status']).toBe('pending');
    expect(pending.body['kem_public_key']).toBe(
      encodeBase64url(keys.kemPublicKey)
    );
    expect(pending.body['sig_public_key']).toBe(
      encodeBase64url(keys.sigPublicKey)
    );

    const wrongCert = {
      at: now,
      device_fingerprint_typed: 'a'.repeat(32),
      device_id: deviceId,
      kem_public_key: encodeBase64url(keys.kemPublicKey),
      label: 'laptop',
      not_after: now + 365 * DAY,
      owner_identity_id: owner.identityId,
      sig_public_key: encodeBase64url(keys.sigPublicKey),
    };
    const mismatched = await send(
      `/api/devices/enrollments/${enrollmentId}/approve`,
      post(
        {
          attestation: await attest(owner, 'device_approve', undefined, [
            { kind: 'device_cert', statement: wrongCert },
          ]),
        },
        owner.cookie
      )
    );
    expect(mismatched.status).toBe(409);
    expect(mismatched.body['code']).toBe('fingerprint_mismatch');

    const certified = await certifyDevice(owner);
    const context = async (path: string) => {
      const nonce = encodeBase64url(randomBytes(32));
      const signature = await signStatement(
        signer(certified.keys),
        statementBytes('device_request', {
          at: now,
          body_sha256: EMPTY_SHA,
          device_id: certified.deviceId,
          method: 'POST',
          nonce,
          path,
        } as never)
      );
      return send(
        path,
        post({
          device_auth: {
            device_id: certified.deviceId,
            nonce,
            at: now,
            signature,
          },
        })
      );
    };
    const path = `/api/devices/${certified.deviceId}/context`;
    expect((await context(path)).status).toBe(200);

    const revoked = await send(
      `/api/devices/${certified.deviceId}/revoke`,
      post(
        {
          attestation: await attest(owner, 'device_revoke', undefined, [
            {
              kind: 'device_revocation',
              statement: {
                at: now,
                device_id: certified.deviceId,
                owner_identity_id: owner.identityId,
              },
            },
          ]),
        },
        owner.cookie
      )
    );
    expect(revoked.status).toBe(200);
    const after = await context(path);
    expect(after.status).toBe(403);
    expect(after.body['code']).toBe('device_revoked');
  });
});
describe('decisions and share on a private relik', () => {
  test('a reader with access lists decisions with no share proof, an outsider is refused, and the publish token lists too', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner, { decisions: true });
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const outsider = await person('outsider@example.com');
    await registerIdentity(outsider);
    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );

    const listed = await send(
      `/api/relics/${RELIC_ID}/decisions/list`,
      post({}, reader.cookie)
    );
    expect(listed.status).toBe(200);

    const refused = await send(
      `/api/relics/${RELIC_ID}/decisions/list`,
      post({}, outsider.cookie)
    );
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('private_access_denied');

    const byToken = await send(
      `/api/relics/${RELIC_ID}/decisions/list`,
      post({ publish_token: sealed.publishToken })
    );
    expect(byToken.status).toBe(200);
  });

  test('a private relik whose author did not ask for decisions refuses the list', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );

    const listed = await send(
      `/api/relics/${RELIC_ID}/decisions/list`,
      post({}, reader.cookie)
    );
    expect(listed.status).toBe(409);
    expect(listed.body['code']).toBe('decision_unavailable');
  });

  test('a reader with access can share, and an outsider cannot', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const outsider = await person('outsider@example.com');
    await registerIdentity(outsider);
    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );

    const shared = await send(
      `/api/relics/${RELIC_ID}/share`,
      post({ emails: ['friend@example.com'] }, reader.cookie)
    );
    expect(shared.status).toBe(200);

    const refused = await send(
      `/api/relics/${RELIC_ID}/share`,
      post({ emails: ['other@example.com'] }, outsider.cookie)
    );
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('private_access_denied');
  });
});

describe('notifications for a private relik', () => {
  test('comment fan-out sends only the generic activity mail, with List-Unsubscribe and no title or commenter', async () => {
    const sent: {
      to: string;
      subject: string;
      text: string;
      headers: Record<string, string> | undefined;
    }[] = [];
    store = new HookStore();
    app = createApp({
      store,
      storage,
      now: () => now,
      mailer: {
        send: async () => {},
        sendMail: async (to, mail) => {
          sent.push({
            to,
            subject: mail.subject,
            text: mail.text,
            headers: mail.headers,
          });
        },
      },
    });
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );

    const ownerComment = await send(
      `/api/relics/${RELIC_ID}/comments`,
      post(
        {
          ciphertext: encodeBase64url(randomBytes(64)),
          version: 1,
        },
        owner.cookie
      )
    );
    expect(ownerComment.status).toBe(201);
    sent.length = 0;

    const readerComment = await send(
      `/api/relics/${RELIC_ID}/comments`,
      post(
        {
          ciphertext: encodeBase64url(randomBytes(64)),
          version: 1,
        },
        reader.cookie
      )
    );
    expect(readerComment.status).toBe(201);

    const toOwner = sent.filter((m) => m.to === owner.email);
    expect(toOwner.length).toBeGreaterThan(0);
    for (const mail of sent) {
      expect(mail.subject).toBe('Activity on a relik');
      expect(mail.text).not.toContain(reader.email);
      expect(mail.text).not.toContain('Secret');
      expect(mail.headers?.['List-Unsubscribe']).toBeDefined();
    }
  });
});

/** Makes the next wrap sweep for `keyId` run `inside` after it deletes. Returns the restore. */
function sweepHook(keyId: string, inside: () => Promise<void>): () => void {
  const real = store.deleteWrapIf.bind(store);
  let fired = false;
  store.deleteWrapIf = async (relicId, version, recipientKeyId, matches) => {
    const removed = await real(relicId, version, recipientKeyId, matches);
    if (!fired && recipientKeyId === keyId) {
      fired = true;
      await inside();
    }
    return removed;
  };
  return () => {
    store.deleteWrapIf = real;
  };
}

/** Makes every wrap sweep throw, as a failed storage write would. Returns the restore. */
function failWrapSweeps(): () => void {
  const real = store.deleteWrapIf.bind(store);
  store.deleteWrapIf = async () => {
    throw new Error('store unavailable');
  };
  return () => {
    store.deleteWrapIf = real;
  };
}

/** The owner's device revocation, as the browser signs it. */
async function deviceRevocation(owner: Person, deviceId: string) {
  return post(
    {
      attestation: await attest(owner, 'device_revoke', undefined, [
        {
          kind: 'device_revocation',
          statement: {
            at: now,
            device_id: deviceId,
            owner_identity_id: owner.identityId,
          },
        },
      ]),
    },
    owner.cookie
  );
}

/** The owner's designation of `holder`, or the removal when `holder` is undefined. */
async function designationRequest(owner: Person, holder: Person | undefined) {
  const statement =
    holder === undefined
      ? {
          at: now,
          fingerprint_typed: null,
          owner_identity_id: owner.identityId,
          recovery_email: null,
          recovery_identity_id: null,
        }
      : {
          at: now,
          fingerprint_typed: await identityFingerprint(
            holder.identityId as string,
            holder.email
          ),
          owner_identity_id: owner.identityId,
          recovery_email: holder.email,
          recovery_identity_id: holder.identityId,
        };
  return post(
    {
      attestation: await attest(owner, 'recovery_designate', undefined, [
        { kind: 'recovery_designation', statement },
      ]),
    },
    owner.cookie
  );
}

async function designate(owner: Person, holder: Person | undefined) {
  return send(
    '/api/identity/recovery',
    await designationRequest(owner, holder)
  );
}

/** The statement and signature a request body carried for its first statement. */
function sentStatement(init: RequestInit): {
  statement: Record<string, unknown>;
  identity_signature: string;
} {
  const body = JSON.parse(init.body as string) as {
    attestation: {
      statements: {
        statement: Record<string, unknown>;
        identity_signature: string;
      }[];
    };
  };
  const first = body.attestation.statements[0]!;
  return {
    statement: first.statement,
    identity_signature: first.identity_signature,
  };
}

async function holderKem(who: Person) {
  const record = (await store.getIdentity(who.identityId as string))!;
  return {
    keyId: record.kemKeyId,
    kemPublicKey: decodeBase64url(record.kemPublicKey),
  };
}

/** A grant revocation of one reader, as the browser signs it. */
async function revokeGrant(owner: Person, reader: Person) {
  const attested = await attest(owner, 'revoke', RELIC_ID, [
    {
      kind: 'revocation',
      statement: {
        at: now,
        grantee_identity_id: reader.identityId,
        owner_identity_id: owner.identityId,
        relic_id: RELIC_ID,
      },
    },
    {
      kind: 'republish',
      statement: {
        at: now,
        owner_identity_id: owner.identityId,
        previous_version: 1,
        reason: 'rekey',
        relic_id: RELIC_ID,
      },
    },
  ]);
  const response = await send(
    `/api/relics/${RELIC_ID}/revocations`,
    post(
      {
        attestation: attested,
        renderer_class: 'markdown',
        declared_size_bytes: 64,
        declared_ciphertext_bytes: encryptedSize(64),
      },
      owner.cookie
    )
  );
  return { ...response, attested };
}

async function recipientsOf(owner: Person) {
  return send(`/api/relics/${RELIC_ID}/recipients`, post({}, owner.cookie));
}

async function deviceContext(device: { keys: IdentityKeys; deviceId: string }) {
  const path = `/api/devices/${device.deviceId}/context`;
  const nonce = encodeBase64url(randomBytes(32));
  const signature = await signStatement(
    signer(device.keys),
    statementBytes('device_request', {
      at: now,
      body_sha256: EMPTY_SHA,
      device_id: device.deviceId,
      method: 'POST',
      nonce,
      path,
    } as never)
  );
  return send(
    path,
    post({
      device_auth: { device_id: device.deviceId, nonce, at: now, signature },
    })
  );
}

describe('a seal that races a change to the recipient set (PS2-06)', () => {
  test('a seal built before a device revocation and sent inside its sweep is refused, and leaves no wrap for the device', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const deviceKey = await deviceKeyId_(device.keys);
    const bytes = await openVersionTwo();
    // Owner-signed, so the refusal comes from the epoch fence and not from the
    // revoked device being refused as a signer.
    const inFlight = await buildSealVersionTwo(
      owner,
      device,
      bytes,
      [],
      'owner'
    );

    const outcomes: { status: number; body: Record<string, unknown> }[] = [];
    const restore = sweepHook(deviceKey, async () => {
      const result = await send(
        `/api/relics/${RELIC_ID}/complete`,
        post(inFlight.body)
      );
      outcomes.push({ status: result.status, body: result.body });
    });
    const revoked = await send(
      `/api/devices/${device.deviceId}/revoke`,
      await deviceRevocation(owner, device.deviceId)
    );
    restore();

    expect(revoked.status).toBe(200);
    expect(outcomes[0]?.status).toBe(409);
    expect(outcomes[0]?.body['code']).toBe('recipients_changed');
    expect(await store.getWrap(RELIC_ID, 2, deviceKey)).toBeUndefined();
  });

  test('a seal built before a recovery change and sent inside the old holder’s sweep is refused, and leaves no wrap for that holder', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const first = await person('first@example.com');
    await registerIdentity(first);
    expect((await designate(owner, first)).status).toBe(200);
    const firstKem = await holderKem(first);
    // A designated holder holds no wraps until the owner's browser backfills
    // them. This backfill is the old holder's wrap the designation must sweep.
    const backfilled = await send(
      '/api/identity/backfill',
      post(
        {
          wraps: [
            {
              relic_id: RELIC_ID,
              ...(await wrap(firstKem.kemPublicKey, sealed.versionKey, 1)),
            },
          ],
        },
        owner.cookie
      )
    );
    expect(backfilled.status).toBe(200);
    expect(backfilled.body).toEqual({ stored: 1, skipped: 0 });
    const second = await person('second@example.com');
    await registerIdentity(second);
    const bytes = await openVersionTwo();
    const inFlight = await buildSealVersionTwo(owner, device, bytes, [
      { kemPublicKey: firstKem.kemPublicKey, keyId: firstKem.keyId },
    ]);

    const outcomes: { status: number; body: Record<string, unknown> }[] = [];
    const restore = sweepHook(firstKem.keyId, async () => {
      const result = await send(
        `/api/relics/${RELIC_ID}/complete`,
        post(inFlight.body)
      );
      outcomes.push({ status: result.status, body: result.body });
    });
    const moved = await designate(owner, second);
    restore();

    expect(moved.status).toBe(200);
    expect(await store.getWrap(RELIC_ID, 1, firstKem.keyId)).toBeUndefined();
    expect(outcomes[0]?.status).toBe(409);
    expect(outcomes[0]?.body['code']).toBe('recipients_changed');
    expect(await store.getWrap(RELIC_ID, 2, firstKem.keyId)).toBeUndefined();
  });

  test('a revoked device carries its owner-signed revocation on the recipients answer', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const revoked = await send(
      `/api/devices/${sealed.deviceId}/revoke`,
      await deviceRevocation(owner, sealed.deviceId)
    );
    expect(revoked.status).toBe(200);
    const answer = await send(
      `/api/relics/${RELIC_ID}/recipients`,
      post({ publish_token: sealed.publishToken })
    );
    expect(answer.status).toBe(200);
    const devices = answer.body['devices'] as Record<string, unknown>[];
    const entry = devices.find(
      (device) => device['device_id'] === sealed.deviceId
    );
    expect(entry?.['revoked_at']).toEqual(expect.any(String));
    const revocation = entry?.['revocation'] as {
      statement: Record<string, unknown>;
      identity_signature: string;
    } | null;
    expect(revocation?.statement['device_id']).toBe(sealed.deviceId);
    expect(revocation?.statement['owner_identity_id']).toBe(owner.identityId);
    expect(revocation?.identity_signature).toEqual(expect.any(String));
  });

  test('the publish token refuses a wrap for a key that is no longer a current recipient', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const deviceKey = await deviceKeyId_(sealed.deviceKeys);
    const ownerKey = (await store.getIdentity(owner.identityId as string))!
      .kemKeyId;
    const revoked = await send(
      `/api/devices/${sealed.deviceId}/revoke`,
      await deviceRevocation(owner, sealed.deviceId)
    );
    expect(revoked.status).toBe(200);
    // A wrap a racing seal left behind after the sweep.
    await store.putWrap({
      relicId: RELIC_ID,
      version: 1,
      recipientKeyId: deviceKey,
      enc: 'enc',
      ct: 'ct',
      createdAt: now,
      source: 'seal',
    });

    const refused = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ publish_token: sealed.publishToken, recipient_key_id: deviceKey })
    );
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('private_access_denied');
    const current = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({ publish_token: sealed.publishToken, recipient_key_id: ownerKey })
    );
    expect(current.status).toBe(200);
  });
});

describe('a wrap sweep keeps keys still current in another role (PS2-07)', () => {
  test('a recovery holder who is also a live grantee keeps the grantee wrap when the designation moves on', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const holder = await person('holder@example.com');
    await registerIdentity(holder);
    expect((await designate(owner, holder)).status).toBe(200);
    expect((await grantTo(owner, holder, [1], sealed.versionKey)).status).toBe(
      201
    );
    const next = await person('next@example.com');
    await registerIdentity(next);
    expect((await designate(owner, next)).status).toBe(200);

    const holderKey = (await holderKem(holder)).keyId;
    expect(await store.getWrap(RELIC_ID, 1, holderKey)).toBeDefined();
    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, holder.cookie)
    );
    expect(key.status).toBe(200);
  });

  test('a grantee who is also the recovery holder keeps the recovery wrap when the grant is revoked', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const holder = await person('holder@example.com');
    await registerIdentity(holder);
    expect((await designate(owner, holder)).status).toBe(200);
    expect((await grantTo(owner, holder, [1], sealed.versionKey)).status).toBe(
      201
    );

    expect((await revokeGrant(owner, holder)).status).toBe(200);
    const holderKey = (await holderKem(holder)).keyId;
    expect(await store.getWrap(RELIC_ID, 1, holderKey)).toBeDefined();
    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, holder.cookie)
    );
    expect(key.status).toBe(200);
  });
});

describe('a designation whose sweep failed (PS2-06)', () => {
  test('the next designation still sweeps the replaced holder that the failed one left pending', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const first = await person('first@example.com');
    await registerIdentity(first);
    expect((await designate(owner, first)).status).toBe(200);
    const firstKem = await holderKem(first);
    const repair = await wrap(firstKem.kemPublicKey, sealed.versionKey, 1);
    const backfilled = await send(
      '/api/identity/backfill',
      post({ wraps: [{ relic_id: RELIC_ID, ...repair }] }, owner.cookie)
    );
    expect(backfilled.status).toBe(200);
    const second = await person('second@example.com');
    await registerIdentity(second);

    const restore = failWrapSweeps();
    const sweep = spyOn(store, 'deleteWrapIf');
    // Reverse the former rejection assertion: the boundary returns a generic 500.
    const failedResponse = await app.fetch(
      req('/api/identity/recovery', await designationRequest(owner, second))
    );
    expect(sweep).toHaveBeenCalled();
    expect(failedResponse.status).toBe(500);
    expect(failedResponse.headers.get('content-type')).toBe('text/plain');
    expect(await failedResponse.text()).toBe('Something went wrong!');
    sweep.mockRestore();
    restore();
    expect(await store.getWrap(RELIC_ID, 1, firstKem.keyId)).toBeDefined();

    expect((await designate(owner, second)).status).toBe(200);
    expect(await store.getWrap(RELIC_ID, 1, firstKem.keyId)).toBeUndefined();
  });
});

describe('the roster statements (plan 4.7)', () => {
  test('recipients lists a revoked grant with the owner-signed revocation it was signed with', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    expect((await grantTo(owner, reader, [1], sealed.versionKey)).status).toBe(
      201
    );
    const revoked = await revokeGrant(owner, reader);
    expect(revoked.status).toBe(200);

    const roster = await recipientsOf(owner);
    expect(roster.status).toBe(200);
    const grants = roster.body['grants'] as {
      grantee: { email: string };
      revoked_at: string | null;
      revocation: {
        statement: Record<string, unknown>;
        identity_signature: string;
      } | null;
    }[];
    const entry = grants.find((g) => g.grantee.email === reader.email);
    expect(entry).toBeDefined();
    expect(entry?.revoked_at).toEqual(expect.any(String));
    const signed = (
      revoked.attested['statements'] as {
        kind: string;
        statement: Record<string, unknown>;
        identity_signature: string;
      }[]
    )[0]!;
    expect(entry?.revocation).toEqual({
      statement: signed.statement,
      identity_signature: signed.identity_signature,
    });
  });

  test('recipients and device context carry the latest signed designation, a removal included, and the owner epoch', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const device = { keys: sealed.deviceKeys, deviceId: sealed.deviceId };
    const holder = await person('holder@example.com');
    await registerIdentity(holder);
    const epoch = async () =>
      (await store.getIdentity(owner.identityId as string))!.recipientsEpoch;

    const designation = await designationRequest(owner, holder);
    expect((await send('/api/identity/recovery', designation)).status).toBe(
      200
    );
    const designed = sentStatement(designation);
    let roster = await recipientsOf(owner);
    expect(roster.body['recovery_statement']).toEqual(designed);
    expect(roster.body['owner_epoch']).toBe(await epoch());
    let context = await deviceContext(device);
    expect(context.status).toBe(200);
    expect(context.body['recovery_statement']).toEqual(designed);
    expect(context.body['owner_epoch']).toBe(await epoch());

    const removal = await designationRequest(owner, undefined);
    expect((await send('/api/identity/recovery', removal)).status).toBe(200);
    const removed = sentStatement(removal);
    expect(removed.statement).toMatchObject({
      fingerprint_typed: null,
      recovery_email: null,
      recovery_identity_id: null,
    });
    roster = await recipientsOf(owner);
    expect(roster.body['recovery']).toBeNull();
    expect(roster.body['recovery_statement']).toEqual(removed);
    expect(roster.body['owner_epoch']).toBe(await epoch());
    context = await deviceContext(device);
    expect(context.body['recovery']).toBeNull();
    expect(context.body['recovery_statement']).toEqual(removed);
    expect(context.body['owner_epoch']).toBe(await epoch());
  });
});

describe('owner settings attestation', () => {
  test('only the owner can change settings and a nonce cannot be replayed', async () => {
    const owner = await person('owner@example.test');
    const stranger = await person('stranger@example.test');
    const noIdentity = await person('no-key@example.test');
    await registerIdentity(owner);
    await registerIdentity(stranger);
    await store.putRelic({
      id: RELIC_ID,
      publishIp: '198.51.100.1',
      grantedAt: now,
      expiresAt: undefined,
      rendererClass: 'markdown',
      publishingClient: 'test',
      declaredSizeBytes: 10,
      version: 1,
      publishTokenHash: '0'.repeat(64),
      mintsUsed: 0,
      ownerIdentityId: owner.identityId,
    });
    const endpoint = `/api/relics/${RELIC_ID}/settings`;
    expect(
      (await send(endpoint, post({ attestation: {} }, noIdentity.cookie))).body[
        'code'
      ]
    ).toBe('identity_required');
    expect(
      (await send(endpoint, post({ attestation: {} }, stranger.cookie))).body[
        'code'
      ]
    ).toBe('owner_required');
    expect(
      (
        await send(
          '/api/attest/nonce',
          post(
            { purpose: 'relic_settings', relic_id: RELIC_ID },
            stranger.cookie
          )
        )
      ).body['code']
    ).toBe('owner_required');
    const ownerAccess = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: owner.cookie,
    });
    const strangerAccess = await send(`/api/relics/${RELIC_ID}/access`, {
      cookie: stranger.cookie,
    });
    expect(ownerAccess.body['manage']).toBe(true);
    expect(strangerAccess.body['manage']).toBe(false);
    const statement = {
      at: now,
      relic_id: RELIC_ID,
      owner_identity_id: owner.identityId,
      suggestions: true,
      comments: false,
      decisions: false,
      signing: true,
      notifications: true,
      lifetime: 'keep',
    };
    const bundle = await attest(owner, 'relic_settings', RELIC_ID, [
      { kind: 'relic_settings', statement },
    ]);
    const plain = await send(endpoint, {
      ...post({ attestation: bundle }, owner.cookie),
      headers: { 'content-type': 'text/plain' },
    });
    expect(plain.status).toBe(400);
    expect((await store.getRelic(RELIC_ID))?.settings).toBeUndefined();
    const paused = createApp({
      store,
      storage,
      now: () => now,
      config: { killSwitchEngaged: true },
    });
    const pausedResponse = await paused.fetch(
      req(endpoint, post({ attestation: bundle }, owner.cookie))
    );
    expect(pausedResponse.status).toBe(503);
    expect((await store.getRelic(RELIC_ID))?.settings).toBeUndefined();
    expect(
      (await send(endpoint, post({ attestation: bundle }, owner.cookie))).status
    ).toBe(200);
    const challenge = encodeBase64url(
      await attestationChallenge(decodeBase64url(bundle['nonce'] as string), [
        statementBytes('relic_settings', statement as never),
      ])
    );
    const newerAssertion = await owner.auth.assert(
      {
        challenge,
        rpId: RP,
        timeout: 300_000,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: owner.auth.credentialId }],
      } as RequestOptionsJSON,
      ORIGIN
    );
    const { clientExtensionResults: _extensions, ...credential } =
      newerAssertion as unknown as Record<string, unknown>;
    const replay = await send(
      endpoint,
      post({ attestation: { ...bundle, credential } }, owner.cookie)
    );
    expect(replay.body['code']).toBe('passkey_verification_failed');
    expect(replay.body['passkey_check']).toBe('nonce');
    expect(
      (
        await send(
          `/api/relics/${RELIC_ID}/comments`,
          post({ ciphertext: 'abcd' }, owner.cookie)
        )
      ).status
    ).toBe(201);
  });
});
