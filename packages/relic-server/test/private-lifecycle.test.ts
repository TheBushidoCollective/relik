import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  attestationChallenge,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  generateIdentityKeys,
  identityFingerprint,
  identityIdOf,
  kemKeyIdOf,
  signStatement,
  statementBytes,
  keyCommitment,
  wrapVersionKey,
  type IdentityKeys,
} from '@relic/format/private';
import {
  encryptedSize,
  generateRelicId,
  type RequestOptionsJSON,
} from '@relic/format';
import { createApp, type RelicApp } from '../src/app.ts';
import { verifyStoredAttestation } from '../src/private/attest.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import { attestation, DAY, NOW, RELIC_ID, relic } from './private-fixtures.ts';

type FakeAuthenticator = Awaited<ReturnType<typeof fakeAuthenticator>>;

const ORIGIN = 'https://relic.example';
const RP = 'relic.example';
const PRF_FIRST = Buffer.from('relic/identity-prf/v1').toString('base64url');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

let now = NOW;
let app: RelicApp;
let store: MemoryStore;
let storage: MemoryStorage;

beforeEach(() => {
  now = NOW;
  store = new MemoryStore();
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
      rp: { id: RP, name: 'Relic' },
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
async function sealedPrivateRelic(owner: Person): Promise<{
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

describe("a private relic: publish, seal and the owner's own read", () => {
  test('the seal stores the wraps, sets the ciphertext customTime, and the owner can read the key', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);

    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, owner.cookie)
    );
    expect(key.status).toBe(200);
    expect(key.body['version']).toBe(1);
    expect(typeof (key.body['wrap'] as Record<string, unknown>)['enc']).toBe(
      'string'
    );

    expect(storage.customTimeOf(RELIC_ID)).toBe(
      (await store.getRelic(RELIC_ID))!.expiresAt
    );
    expect(sealed.digest).toHaveLength(64);
  });

  test('a grant against a version that is no longer the sealed one is refused and leaves nothing behind', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);

    // Version 2 is opened but never sealed, so version 1 stays the sealed one
    // and a grant that names only version 2 cannot land.
    const bogus = await attest(owner, 'grant', RELIC_ID, [
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
          versions: [2],
        },
      },
    ]);
    const refused = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: bogus,
          wraps: [],
        },
        owner.cookie
      )
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('private_seal_required');
    expect(
      await store.getGrant(RELIC_ID, reader.identityId as string)
    ).toBeUndefined();
    expect(await store.listWraps(RELIC_ID, 2)).toHaveLength(0);
  });
});

describe('grant, offline re-verification, revocation and key refusal', () => {
  test('a grant wraps the reader, re-verifies from the stored bytes alone, and revocation cuts access at once', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const readerKeyId = (await store.getIdentity(reader.identityId as string))!
      .kemKeyId;
    const readerKem = (await store.getIdentity(reader.identityId as string))!
      .kemPublicKey;

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
          versions: [1],
        },
      },
    ]);
    const granted = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation,
          wraps: [await wrap(decodeBase64url(readerKem), sealed.versionKey, 1)],
        },
        owner.cookie
      )
    );
    expect(granted.status).toBe(201);

    // The stored grant verifies from its own bytes, with only the owner's key.
    const stored = await store.getGrant(RELIC_ID, reader.identityId as string);
    expect(stored).toBeDefined();
    const ownerSig = decodeBase64url(
      (await store.getIdentity(owner.identityId as string))!.sigPublicKey
    );
    expect(
      await verifyStoredAttestation(stored!.attestation, () => ownerSig)
    ).toBe(true);

    // The reader opens version 1, and the key fetch and the mint both work.
    const readerKey = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, reader.cookie)
    );
    expect(readerKey.status).toBe(200);
    expect(await store.getWrap(RELIC_ID, 1, readerKeyId)).toBeDefined();
    const minted = await send(
      `/api/relics/${RELIC_ID}/mint`,
      post({ version: 1 }, reader.cookie)
    );
    expect(minted.status).toBe(200);

    // Revoke: the reader's wrap is gone, and both key fetch and mint refuse at once.
    const revocation = await attest(owner, 'revoke', RELIC_ID, [
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
    const revoked = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      post(
        {
          attestation: revocation,
          renderer_class: 'markdown',
          declared_size_bytes: 64,
          declared_ciphertext_bytes: encryptedSize(64),
        },
        owner.cookie
      )
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body['revoked_identity_id']).toBe(reader.identityId);
    const republish = revoked.body['republish'] as Record<string, unknown>;
    expect(republish['version']).toBe(2);
    expect(String(republish['upload_url'])).toContain('upload');

    expect(await store.getWrap(RELIC_ID, 1, readerKeyId)).toBeUndefined();
    const denied = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, reader.cookie)
    );
    expect(denied.status).toBe(403);
    const deniedMint = await send(
      `/api/relics/${RELIC_ID}/mint`,
      post({ version: 1 }, reader.cookie)
    );
    expect(deniedMint.status).toBe(403);

    // The owner's upload grant for the open version re-issues after expiry.
    const reissued = await send(
      `/api/relics/${RELIC_ID}/versions/2/upload-grant`,
      post({}, owner.cookie)
    );
    expect(reissued.status).toBe(200);
    expect(String(reissued.body['upload_url'])).toBeDefined();
  });
});

describe('owner hard delete', () => {
  test('removes the row, wraps, seals and objects, leaves an id-only tombstone, and keeps the access log', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);

    const attestation = await attest(owner, 'delete', RELIC_ID, [
      {
        kind: 'delete',
        statement: {
          at: now,
          owner_identity_id: owner.identityId,
          relic_id: RELIC_ID,
          versions: 'all',
        },
      },
    ]);
    const deleted = await send(
      `/api/relics/${RELIC_ID}/delete`,
      post({ attestation }, owner.cookie)
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body['relic_deleted']).toBe(true);

    expect(await store.getRelic(RELIC_ID)).toBeUndefined();
    expect(await store.listWraps(RELIC_ID)).toHaveLength(0);
    expect(await store.getSeal(RELIC_ID, 1)).toBeUndefined();
    expect(await storage.stat(RELIC_ID)).toBeUndefined();
    const stone = await store.getTombstone(RELIC_ID);
    expect(stone).toEqual({ kind: 'owner', id: RELIC_ID, deletedAt: now });
    const events = await store.listAccessEvents(
      owner.identityId as string,
      now
    );
    expect(events.some((e) => e.kind === 'delete')).toBe(true);
  });
});

describe('private gating: comments, shell, cover and republish', () => {
  test('comments on a private relic are refused to anyone without access, and served to the owner', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);

    const anonymous = await send(`/api/relics/${RELIC_ID}/comments`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body['code']).toBe('sign_in_required');

    const outsider = await person('outsider@example.com');
    await registerIdentity(outsider);
    const refused = await send(`/api/relics/${RELIC_ID}/comments`, {
      cookie: outsider.cookie,
    });
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('private_access_denied');

    const listed = await send(`/api/relics/${RELIC_ID}/comments`, {
      cookie: owner.cookie,
    });
    expect(listed.status).toBe(200);
  });

  test('the shell of a private relic shows the generic card, never the title', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const response = await app.fetch(req(`/${RELIC_ID}`));
    const html = await response.text();
    expect(html).toContain('data-relic-access="private"');
    expect(html).toContain('A private relic. Sign in to open it.');
    expect(html).not.toContain('Secret title');
  });

  test('a cover upload to a private relic is refused', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const response = await send(
      `/api/relics/${RELIC_ID}/cover`,
      post({ version: 1 }, owner.cookie)
    );
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('private_policy_violation');
  });

  test('a republish of a private relic with a title is refused before any version opens', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const response = await send(
      `/api/relics/${RELIC_ID}/republish`,
      post({
        publish_token: 'not-the-token',
        title: 'Board pack',
      })
    );
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('private_policy_violation');
    expect((await store.getRelic(RELIC_ID))!.version).toBe(1);
  });
});

/** A device's signed context request. A fresh 32-byte nonce unless one is named. */
async function contextRequest(
  device: { keys: IdentityKeys; deviceId: string },
  nonce: string = encodeBase64url(randomBytes(32))
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/api/devices/${device.deviceId}/context`;
  const signature = await signStatement(
    signer(device.keys),
    statementBytes('device_request', {
      at: now,
      body_sha256: createHash('sha256').update('{}').digest('hex'),
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

/** An owner-bind request a device signs for one unowned relic. */
async function ownerBind(
  device: { keys: IdentityKeys; deviceId: string },
  options: {
    readonly relicId: string;
    readonly token: string;
    readonly ownerIdentityId: string;
    readonly nonce?: string;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const nonce = options.nonce ?? encodeBase64url(randomBytes(32));
  const signature = await signStatement(
    signer(device.keys),
    statementBytes('owner_bind', {
      at: now,
      device_id: device.deviceId,
      nonce,
      owner_identity_id: options.ownerIdentityId,
      relic_id: options.relicId,
    } as never)
  );
  return send(
    `/api/relics/${options.relicId}/owner`,
    post({
      publish_token: options.token,
      device_auth: { device_id: device.deviceId, nonce, at: now, signature },
    })
  );
}

/** An unowned private relic whose publish token is `token`. */
function unownedPrivateRelic(token: string, id: string = RELIC_ID) {
  return relic({
    id,
    access: 'private',
    expiresAt: NOW + 30 * DAY,
    publishTokenHash: createHash('sha256').update(token).digest('hex'),
  });
}

/** The owner's revocation of one reader, as the browser signs it. */
async function revocationRequest(owner: Person, reader: Person) {
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
  return post(
    {
      attestation: attested,
      renderer_class: 'markdown',
      declared_size_bytes: 64,
      declared_ciphertext_bytes: encryptedSize(64),
    },
    owner.cookie
  );
}

/** Makes the next wrap sweep throw, as a failed storage write would. Returns the restore. */
function failNextSweep(): () => void {
  const real = store.deleteWraps.bind(store);
  store.deleteWraps = async () => {
    throw new Error('store unavailable');
  };
  return () => {
    store.deleteWraps = real;
  };
}

describe('security review: server fixes', () => {
  test('a wrap alone does not open a version: a stranger with a leftover wrap is refused the key and the mint', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);
    const stranger = await person('stranger@example.com');
    await registerIdentity(stranger);
    const strangerKeyId = (await store.getIdentity(
      stranger.identityId as string
    ))!.kemKeyId;
    await store.putWrap({
      relicId: RELIC_ID,
      version: 1,
      recipientKeyId: strangerKeyId,
      enc: 'enc',
      ct: 'ct',
      createdAt: now,
      source: 'backfill',
    });

    const key = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, stranger.cookie)
    );
    expect(key.status).toBe(403);
    expect(key.body['code']).toBe('private_access_denied');
    const minted = await send(
      `/api/relics/${RELIC_ID}/mint`,
      post({ version: 1 }, stranger.cookie)
    );
    expect(minted.status).toBe(403);
    expect(minted.body['code']).toBe('private_access_denied');
  });

  test('a KEM public key another identity holds is refused at registration', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const ownerKeys = owner.keys as IdentityKeys;
    const stranger = await person('stranger@example.com');
    const fresh = await generateIdentityKeys();
    const keys: IdentityKeys = {
      ...fresh,
      kemPublicKey: ownerKeys.kemPublicKey,
    };
    stranger.keys = keys;
    stranger.identityId = await identityIdOf(
      keys.kemPublicKey,
      keys.sigPublicKey
    );
    const statement = {
      at: now,
      email: stranger.email,
      identity_id: stranger.identityId,
      kem_public_key: encodeBase64url(keys.kemPublicKey),
      replaces: null,
      sig_public_key: encodeBase64url(keys.sigPublicKey),
    };
    const attested = await attest(stranger, 'identity_register', undefined, [
      { kind: 'identity_register', statement, sign: false },
    ]);
    const response = await send(
      '/api/identity',
      post(
        {
          attestation: attested,
          encrypted_bundle: encodeBase64url(randomBytes(64)),
          replace: false,
        },
        stranger.cookie
      )
    );
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('invalid_statement');
    expect(await store.getIdentityForAddress(stranger.email)).toBeUndefined();
  });

  test('a failed wrap sweep leaves the grant standing, so the owner can retry the revocation', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const reader = await person('reader@example.com');
    await registerIdentity(reader);
    const readerKem = (await store.getIdentity(reader.identityId as string))!
      .kemPublicKey;
    const granted = await send(
      `/api/relics/${RELIC_ID}/grants`,
      post(
        {
          attestation: await attest(owner, 'grant', RELIC_ID, [
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
                versions: [1],
              },
            },
          ]),
          wraps: [await wrap(decodeBase64url(readerKem), sealed.versionKey, 1)],
        },
        owner.cookie
      )
    );
    expect(granted.status).toBe(201);

    const restore = failNextSweep();
    await expect(
      app.fetch(
        req(
          `/api/relics/${RELIC_ID}/revocations`,
          await revocationRequest(owner, reader)
        )
      )
    ).rejects.toThrow('store unavailable');
    restore();
    expect(
      (await store.getGrant(RELIC_ID, reader.identityId as string))?.revokedAt
    ).toBeUndefined();

    const retried = await send(
      `/api/relics/${RELIC_ID}/revocations`,
      await revocationRequest(owner, reader)
    );
    expect(retried.status).toBe(200);
    expect(retried.body['revoked_identity_id']).toBe(reader.identityId);
    const denied = await send(
      `/api/relics/${RELIC_ID}/versions/1/key`,
      post({}, reader.cookie)
    );
    expect(denied.status).toBe(403);
  });

  test('a failed wrap sweep leaves the device certified, so revoking it can be retried', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const device = sealed.deviceId;
    const revocationFor = async () =>
      post(
        {
          attestation: await attest(owner, 'device_revoke', undefined, [
            {
              kind: 'device_revocation',
              statement: {
                at: now,
                device_id: device,
                owner_identity_id: owner.identityId,
              },
            },
          ]),
        },
        owner.cookie
      );
    const path = `/api/devices/${device}/revoke`;

    const restore = failNextSweep();
    await expect(app.fetch(req(path, await revocationFor()))).rejects.toThrow(
      'store unavailable'
    );
    restore();
    expect((await store.getDevice(device))?.revokedAt).toBeUndefined();

    const retried = await send(path, await revocationFor());
    expect(retried.status).toBe(200);
    expect((await store.getDevice(device))?.revokedAt).toBeDefined();
  });

  test('a private republish refuses owner_email and a lifetime past the private maximum', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const path = `/api/relics/${RELIC_ID}/republish`;

    const withOwner = await send(
      path,
      post({
        publish_token: sealed.publishToken,
        owner_email: 'someone@example.com',
      })
    );
    expect(withOwner.status).toBe(400);
    expect(withOwner.body['code']).toBe('private_policy_violation');

    const longLived = await send(
      path,
      post({ publish_token: sealed.publishToken, ttl_days: 366 })
    );
    expect(longLived.status).toBe(400);
    expect(longLived.body['code']).toBe('private_policy_violation');
    expect((await store.getRelic(RELIC_ID))?.version).toBe(1);
  });

  test('a device request nonce works once, and a 16-byte nonce is refused', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const device = await certifyDevice(owner);
    const nonce = encodeBase64url(randomBytes(32));

    expect((await contextRequest(device, nonce)).status).toBe(200);
    const replayed = await contextRequest(device, nonce);
    expect(replayed.status).toBe(400);
    expect(replayed.body['code']).toBe('invalid_device');

    const short = await contextRequest(
      device,
      encodeBase64url(randomBytes(16))
    );
    expect(short.status).toBe(400);
    expect(short.body['code']).toBe('invalid_device');
  });

  test('a refused mint of a private relic writes no raw-IP mint log', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    await sealedPrivateRelic(owner);

    const refused = await send(
      `/api/relics/${RELIC_ID}/mint`,
      post({ version: 99 })
    );
    expect(refused.body['code']).toBe('invalid_relic_version');
    expect(await store.readMintLog()).toEqual([]);
  });

  test('the recipients and device context routes return the owner-signed recovery designation', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const sealed = await sealedPrivateRelic(owner);
    const recovery = await person('recovery@example.com');
    await registerIdentity(recovery);
    const designation = {
      at: now,
      fingerprint_typed: await identityFingerprint(
        recovery.identityId as string,
        recovery.email
      ),
      owner_identity_id: owner.identityId,
      recovery_email: recovery.email,
      recovery_identity_id: recovery.identityId,
    };
    await store.updateIdentity(owner.identityId as string, (current) => ({
      ...current,
      recovery: {
        recoveryIdentityId: recovery.identityId as string,
        recoveryEmail: recovery.email,
        designatedAt: now,
        attestation: {
          ...attestation(),
          statements: [
            {
              kind: 'recovery_designation',
              statement: designation,
              identitySignature: 'owner-signature',
            },
          ],
        },
      },
    }));
    const designated = {
      designation: {
        statement: designation,
        identity_signature: 'owner-signature',
      },
    };

    const recipients = await send(
      `/api/relics/${RELIC_ID}/recipients`,
      post({ publish_token: sealed.publishToken })
    );
    expect(recipients.status).toBe(200);
    expect(recipients.body['recovery']).toMatchObject(designated);

    const context = await contextRequest({
      keys: sealed.deviceKeys,
      deviceId: sealed.deviceId,
    });
    expect(context.status).toBe(200);
    expect(context.body['recovery']).toMatchObject(designated);
  });

  test('the recovery lookup needs an identity of the caller', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const stranger = await person('stranger@example.com');
    const path = '/api/identity/recovery/lookup';

    const refused = await send(
      path,
      post({ email: owner.email }, stranger.cookie)
    );
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('identity_required');

    const found = await send(path, post({ email: owner.email }, owner.cookie));
    expect(found.status).toBe(200);
    expect(found.body['party']).toMatchObject({ email: owner.email });
  });

  test('an owner bind gives an unowned private relic the device owner, once, and a nonce binds one relic only', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const device = await certifyDevice(owner);
    const token = encodeBase64url(randomBytes(32));
    const ownerId = owner.identityId as string;
    await store.putRelic(unownedPrivateRelic(token));
    const nonce = encodeBase64url(randomBytes(32));

    const bound = await ownerBind(device, {
      relicId: RELIC_ID,
      token,
      ownerIdentityId: ownerId,
      nonce,
    });
    expect(bound.status).toBe(200);
    expect(bound.body['owner']).toMatchObject({ email: owner.email });
    expect((await store.getRelic(RELIC_ID))?.ownerIdentityId).toBe(ownerId);
    expect(
      (await store.listOwnedRelics(ownerId)).map((o) => o.relicId)
    ).toContain(RELIC_ID);

    const again = await ownerBind(device, {
      relicId: RELIC_ID,
      token,
      ownerIdentityId: ownerId,
    });
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('owner_exists');

    const otherRelic = generateRelicId();
    await store.putRelic(unownedPrivateRelic(token, otherRelic));
    const replayed = await ownerBind(device, {
      relicId: otherRelic,
      token,
      ownerIdentityId: ownerId,
      nonce,
    });
    expect(replayed.status).toBe(400);
    expect(replayed.body['code']).toBe('invalid_device');
    expect((await store.getRelic(otherRelic))?.ownerIdentityId).toBeUndefined();
  });

  test('an owner bind with the wrong publish token is refused', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const device = await certifyDevice(owner);
    await store.putRelic(unownedPrivateRelic(encodeBase64url(randomBytes(32))));

    const refused = await ownerBind(device, {
      relicId: RELIC_ID,
      token: encodeBase64url(randomBytes(32)),
      ownerIdentityId: owner.identityId as string,
    });
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('invalid_publish_token');
    expect((await store.getRelic(RELIC_ID))?.ownerIdentityId).toBeUndefined();
  });

  test('an owner bind from a revoked device is refused', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const device = await certifyDevice(owner);
    const token = encodeBase64url(randomBytes(32));
    await store.putRelic(unownedPrivateRelic(token));
    const revoked = await send(
      `/api/devices/${device.deviceId}/revoke`,
      post(
        {
          attestation: await attest(owner, 'device_revoke', undefined, [
            {
              kind: 'device_revocation',
              statement: {
                at: now,
                device_id: device.deviceId,
                owner_identity_id: owner.identityId,
              },
            },
          ]),
        },
        owner.cookie
      )
    );
    expect(revoked.status).toBe(200);

    const refused = await ownerBind(device, {
      relicId: RELIC_ID,
      token,
      ownerIdentityId: owner.identityId as string,
    });
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('device_revoked');
    expect((await store.getRelic(RELIC_ID))?.ownerIdentityId).toBeUndefined();
  });
});

/** An unowned public relic whose publish token is `token`. */
function unownedPublicRelic(token: string, id: string = RELIC_ID) {
  return relic({
    id,
    publishTokenHash: createHash('sha256').update(token).digest('hex'),
  });
}

describe('owner bind on a public relic', () => {
  test('binds an unowned public relic to the device owner, indexes it as public, and leaves its access alone', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const device = await certifyDevice(owner);
    const token = encodeBase64url(randomBytes(32));
    const ownerId = owner.identityId as string;
    await store.putRelic(unownedPublicRelic(token));

    const bound = await ownerBind(device, {
      relicId: RELIC_ID,
      token,
      ownerIdentityId: ownerId,
    });
    expect(bound.status).toBe(200);
    expect(bound.body['owner']).toMatchObject({ email: owner.email });
    const row = await store.getRelic(RELIC_ID);
    expect(row?.ownerIdentityId).toBe(ownerId);
    expect(row?.access).toBeUndefined();
    expect(await store.listOwnedRelics(ownerId)).toEqual([
      {
        relicId: RELIC_ID,
        ownerIdentityId: ownerId,
        access: 'public',
        at: now,
      },
    ]);

    const dashboard = await send('/api/identity/relics', {
      method: 'GET',
      cookie: owner.cookie,
    });
    expect(dashboard.body['owned']).toEqual([
      expect.objectContaining({ relic_id: RELIC_ID, access: 'public' }),
    ]);
  });

  test('a bound public relic serves, refuses and accepts exactly as an unbound one, and no response names the owner', async () => {
    const owner = await person('owner@example.com');
    await registerIdentity(owner);
    const device = await certifyDevice(owner);
    const ownerId = owner.identityId as string;
    const unboundToken = encodeBase64url(randomBytes(32));
    const boundToken = encodeBase64url(randomBytes(32));
    const unbound = RELIC_ID;
    const bound = generateRelicId();
    await store.putRelic(unownedPublicRelic(unboundToken, unbound));
    await store.putRelic(unownedPublicRelic(boundToken, bound));
    const first = await ownerBind(device, {
      relicId: bound,
      token: boundToken,
      ownerIdentityId: ownerId,
    });
    expect(first.status).toBe(200);
    const again = await ownerBind(device, {
      relicId: bound,
      token: boundToken,
      ownerIdentityId: ownerId,
    });
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('owner_exists');

    // The same requests against each relic. Status, error code and the shape of
    // the body must match, and no body may name the owner.
    const runs = (id: string, token: string) => [
      () => send(`/api/relics/${id}/mint`, post({ version: 1 })),
      () => send(`/api/relics/${id}/access`, { method: 'GET' }),
      () => send(`/api/relics/${id}/comments`, { method: 'GET' }),
      () =>
        send(
          `/api/relics/${id}/republish`,
          post({
            publish_token: token,
            renderer_class: 'markdown',
            publishing_client: 'relic-test/1',
            declared_size_bytes: 1,
          })
        ),
    ];
    const outcome = (r: { status: number; body: Record<string, unknown> }) => ({
      status: r.status,
      code: r.body['code'],
      keys: Object.keys(r.body).sort(),
    });
    const plain: { status: number; body: Record<string, unknown> }[] = [];
    for (const run of runs(unbound, unboundToken)) plain.push(await run());
    const linked: { status: number; body: Record<string, unknown> }[] = [];
    for (const run of runs(bound, boundToken)) linked.push(await run());

    expect(linked.map(outcome)).toEqual(plain.map(outcome));
    for (const response of linked) {
      expect(JSON.stringify(response.body)).not.toContain(owner.email);
    }
  });
});
