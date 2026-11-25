import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  attestationChallenge,
  decodeBase64url,
  encodeBase64url,
  generateIdentityKeys,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import { layoutCiphertextSha256 } from '@relic/format/signing';
import { createApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { MemoryStore, type RelicRow, type RelicStore } from '../src/store.ts';
import { fakeGcs } from './fake-gcs.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import {
  attestation,
  identity,
  relic,
  device,
  grant,
  seal,
  wrap,
  GRANTEE_ID,
  RECIPIENT_B,
  NOW,
  OWNER_ID,
  RELIC_ID,
} from './private-fixtures.ts';

const token = 'publisher-secret';
const deviceId = 'd'.repeat(64);
const digest = 'e'.repeat(64);
const path = `/api/relics/${RELIC_ID}/signing/requests`;
const post = (body: unknown) =>
  new Request(`https://relic.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function setup(store: RelicStore) {
  const keys = await generateIdentityKeys();
  await store.createIdentity(identity());
  await store.putDevice({
    ...device(deviceId),
    kemKeyId: '3'.repeat(64),
    sigPublicKey: encodeBase64url(keys.sigPublicKey),
    cert: {
      ...attestation(),
      statements: [
        { kind: 'device_cert', statement: {}, identitySignature: 'x' },
      ],
    },
  });
  await store.putRelic(
    relic({
      ownerIdentityId: OWNER_ID,
      publishTokenHash: await sha256Hex(token),
      publishedAt: NOW,
      shareVerifier: 'a'.repeat(64),
      versionDigests: { '1': digest },
    })
  );
  const make = async (
    overrides: Partial<{
      signers: { email: string; identity_id: string | null }[];
      require_opened: boolean;
      version: number;
      ciphertext_sha256: string;
      order: 'parallel' | 'sequential';
    }> = {}
  ) => {
    const layout = encodeBase64url(randomBytes(64));
    const statement = {
      at: NOW,
      ciphertext_sha256: digest,
      consent: 'relic/sign-consent/v1',
      content_mac: 'f'.repeat(64),
      layout_sha256: layoutCiphertextSha256(layout),
      order: 'parallel',
      owner_identity_id: OWNER_ID,
      relic_id: RELIC_ID,
      request_id: encodeBase64url(randomBytes(16)),
      require_opened: false,
      signer_id: deviceId,
      signers: [{ email: 'reader@example.com', identity_id: null }],
      version: 1,
      ...overrides,
    };
    const signature = await signStatement(
      async (bytes) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys.sig.privateKey,
            bytes as BufferSource
          )
        ),
      statementBytes('signing_request', statement as never)
    );
    return {
      publish_token: token,
      request: {
        statement,
        signature,
        signer_kind: 'device',
        device_id: deviceId,
      },
      layout_ciphertext: layout,
    };
  };
  const cancel = async (requestId: string) => {
    const statement = {
      at: NOW,
      owner_identity_id: OWNER_ID,
      relic_id: RELIC_ID,
      request_id: requestId,
      signer_id: deviceId,
    };
    const signature = await signStatement(
      async (bytes) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys.sig.privateKey,
            bytes as BufferSource
          )
        ),
      statementBytes('signing_cancel', statement)
    );
    return {
      publish_token: token,
      cancel: {
        statement,
        signature,
        signer_kind: 'device',
        device_id: deviceId,
      },
    };
  };
  return {
    a: createApp({ store, now: () => NOW }),
    b: createApp({ store, now: () => NOW }),
    make,
    cancel,
  };
}

describe.each(['memory', 'gcs'] as const)(
  'signing request creation on %s',
  (backend) => {
    test('creates one request across concurrent instances and rejects a second', async () => {
      const fake = fakeGcs();
      const store =
        backend === 'memory'
          ? new MemoryStore()
          : gcsStore({
              bucket: 'relics',
              prefix: 'tenant/m',
              host: 'https://gcs.test',
              getAccessToken: async () => 'test',
              fetch: fake.fetch,
            });
      const { a, b, make } = await setup(store);
      const [one, two] = await Promise.all([make(), make()]);
      const results = await Promise.all([
        a.fetch(post(one)),
        b.fetch(post(two)),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const rejection = results.find((r) => r.status === 409)!;
      expect((await rejection.json()).code).toBe('signing_in_progress');
      expect((await store.getRelic(RELIC_ID))?.signingOpen).toBeDefined();
      const state = await b.fetch(
        new Request(
          `https://relic.example/api/relics/${RELIC_ID}/signing/read`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ publish_token: token }),
          }
        )
      );
      expect((await state.json()).requests).toHaveLength(1);
      if (backend === 'gcs')
        expect(
          [...fake.objects.keys()].some((key) =>
            key.startsWith(`tenant/m/signing/${RELIC_ID}/`)
          )
        ).toBe(true);
    });
    test('cancels idempotently and permits a new request', async () => {
      const fake = fakeGcs();
      const store =
        backend === 'memory'
          ? new MemoryStore()
          : gcsStore({
              bucket: 'relics',
              prefix: 'tenant/m',
              host: 'https://gcs.test',
              getAccessToken: async () => 'test',
              fetch: fake.fetch,
            });
      const { a, b, make, cancel } = await setup(store);
      const request = await make();
      expect((await a.fetch(post(request))).status).toBe(201);
      const cancellation = await cancel(request.request.statement.request_id);
      const submit = () =>
        new Request(
          `https://relic.example/api/relics/${RELIC_ID}/signing/cancel`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(cancellation),
          }
        );
      const first = await b.fetch(submit());
      expect(first.status).toBe(200);
      expect((await first.json()).status).toBe('cancelled');
      expect((await a.fetch(submit())).status).toBe(200);
      expect((await store.getRelic(RELIC_ID))?.signingOpen).toBeUndefined();
      expect((await b.fetch(post(await make()))).status).toBe(201);
    });
    test('cannot cancel missing or completed requests', async () => {
      const fake = fakeGcs();
      const store =
        backend === 'memory'
          ? new MemoryStore()
          : gcsStore({
              bucket: 'relics',
              prefix: 'tenant/m',
              host: 'https://gcs.test',
              getAccessToken: async () => 'test',
              fetch: fake.fetch,
            });
      const { a, make, cancel } = await setup(store);
      const send = (body: unknown) =>
        a.fetch(
          new Request(
            `https://relic.example/api/relics/${RELIC_ID}/signing/cancel`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          )
        );
      const missing = await send(
        await cancel(encodeBase64url(randomBytes(16)))
      );
      expect((await missing.json()).code).toBe('signing_request_not_found');
      const request = await make();
      expect((await a.fetch(post(request))).status).toBe(201);
      await store.updateSigningRequest(
        RELIC_ID,
        request.request.statement.request_id,
        (current) => ({ ...current, status: 'complete', completedAt: NOW })
      );
      const closed = await send(
        await cancel(request.request.statement.request_id)
      );
      expect((await closed.json()).code).toBe('signing_request_closed');
    });
    test('reads signing state with publisher authorization and rejects invalid credentials', async () => {
      const fake = fakeGcs();
      const store =
        backend === 'memory'
          ? new MemoryStore()
          : gcsStore({
              bucket: 'relics',
              prefix: 'tenant/m',
              host: 'https://gcs.test',
              getAccessToken: async () => 'test',
              fetch: fake.fetch,
            });
      const { a, b, make } = await setup(store);
      const request = await make();
      expect((await a.fetch(post(request))).status).toBe(201);
      const read = (body: unknown) =>
        new Request(
          `https://relic.example/api/relics/${RELIC_ID}/signing/read`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
      const bad = await b.fetch(read({ publish_token: 'wrong' }));
      expect(bad.status).toBe(403);
      expect((await bad.json()).code).toBe('invalid_publish_token');
      const noProof = await b.fetch(read({}));
      expect((await noProof.json()).code).toBe('invalid_share_proof');
      const response = await b.fetch(read({ publish_token: token }));
      expect(response.status).toBe(200);
      const state = await response.json();
      expect(state.requests[0].request_id).toBe(
        request.request.statement.request_id
      );
      const shareBytes = randomBytes(32);
      const verifier = await sha256Hex(shareBytes);
      await store.updateRelic(RELIC_ID, (row) => ({
        ...row,
        shareVerifier: verifier,
      }));
      const shared = await b.fetch(
        read({ share_proof: encodeBase64url(shareBytes) })
      );
      expect(shared.status).toBe(200);
      expect((await shared.json()).requests[0].request_id).toBe(
        request.request.statement.request_id
      );
    });
  }
);

test('private access exposes the signing summary only to readable roles', async () => {
  const store = new MemoryStore();
  const { a } = await setup(store);
  await store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    access: 'private',
    expiresAt: NOW + 86400000,
    signingOpen: { requestId: 'request', version: 1 },
    lockedVersions: [2],
  }));
  await store.putSession({
    tokenHash: await sha256Hex('owner-session'),
    email: 'owner@example.com',
    createdAt: NOW,
    expiresAt: NOW + 86400000,
  });
  await store.putSession({
    tokenHash: await sha256Hex('other-session'),
    email: 'other@example.com',
    createdAt: NOW,
    expiresAt: NOW + 86400000,
  });
  const access = (token: string) =>
    a.fetch(
      new Request(`https://relic.example/api/relics/${RELIC_ID}/access`, {
        headers: { cookie: `relic_session=${token}` },
      })
    );
  const owner = await access('owner-session');
  expect(owner.status).toBe(200);
  expect((await owner.json()).signing).toEqual({
    open_version: 1,
    locked_versions: [2],
  });
  const other = await access('other-session');
  expect(other.status).toBe(200);
  expect((await other.json()).signing).toBeNull();
});

test('owner attestation survives the kill switch and cannot be replayed', async () => {
  const store = new MemoryStore();
  const { a } = await setup(store);
  const keys = await generateIdentityKeys();
  const auth = await fakeAuthenticator({ hasPrf: true });
  await auth.register(
    {
      challenge: encodeBase64url(randomBytes(32)),
      rp: { id: 'relic.example', name: 'Relik' },
      user: {
        id: 'dXNlcg',
        name: 'owner@example.com',
        displayName: 'owner@example.com',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      extensions: { prf: {} },
    } as never,
    'https://relic.example'
  );
  await store.createPasskeys({
    email: 'owner@example.com',
    userHandle: 'dXNlcg',
    credentials: [
      {
        credentialId: auth.credentialId,
        publicKeyJwk: auth.publicJwk,
        alg: -7,
        signCount: 0,
        createdAt: NOW,
      },
    ],
  });
  await store.updateIdentity(OWNER_ID, (current) => ({
    ...current,
    sigPublicKey: encodeBase64url(keys.sigPublicKey),
    credentials: [
      {
        credentialId: auth.credentialId,
        encryptedBundle: '',
        boundAt: NOW,
        attestation: attestation(),
      },
    ],
  }));
  await store.putSession({
    tokenHash: await sha256Hex('owner-session'),
    email: 'owner@example.com',
    createdAt: NOW,
    expiresAt: NOW + 86400000,
  });
  const cookie = 'relic_session=owner-session';
  const nonceResponse = await a.fetch(
    new Request('https://relic.example/api/attest/nonce', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ purpose: 'signing_request', relic_id: RELIC_ID }),
    })
  );
  expect(nonceResponse.status).toBe(200);
  const nonce = (await nonceResponse.json()).nonce as string;
  const layout = encodeBase64url(randomBytes(64));
  const statement = {
    at: NOW,
    ciphertext_sha256: digest,
    consent: 'relic/sign-consent/v1',
    content_mac: 'f'.repeat(64),
    layout_sha256: layoutCiphertextSha256(layout),
    order: 'parallel',
    owner_identity_id: OWNER_ID,
    relic_id: RELIC_ID,
    request_id: encodeBase64url(randomBytes(16)),
    require_opened: false,
    signer_id: OWNER_ID,
    signers: [{ email: 'reader@example.com', identity_id: null }],
    version: 1,
  };
  const bytes = statementBytes('signing_request', statement as never);
  const challenge = encodeBase64url(
    await attestationChallenge(decodeBase64url(nonce), [bytes])
  );
  const assertion = await auth.assert(
    {
      challenge,
      rpId: 'relic.example',
      timeout: 300000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: auth.credentialId }],
    } as never,
    'https://relic.example'
  );
  const { clientExtensionResults: _extensions, ...credential } =
    assertion as unknown as Record<string, unknown>;
  const identitySignature = await signStatement(
    async (value) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.sig.privateKey,
          value as BufferSource
        )
      ),
    bytes
  );
  const body = {
    attestation: {
      nonce,
      statements: [
        {
          kind: 'signing_request',
          statement,
          identity_signature: identitySignature,
        },
      ],
      credential,
    },
    layout_ciphertext: layout,
  };
  const request = (contentType = 'application/json') =>
    new Request(`https://relic.example${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType, cookie },
      body: JSON.stringify(body),
    });
  expect((await a.fetch(request('text/plain'))).status).toBe(400);
  const paused = createApp({
    store,
    now: () => NOW,
    config: { killSwitchEngaged: true },
  });
  expect((await paused.fetch(request())).status).toBe(503);
  expect((await a.fetch(request())).status).toBe(201);
  const replay = await a.fetch(request());
  expect(replay.status).toBe(403);
  const problem = await replay.json();
  expect(problem.code).toBe('passkey_verification_failed');
  expect(problem.passkey_check).toBe('nonce');
  const wrongPurpose = await a.fetch(
    new Request('https://relic.example/api/attest/nonce', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ purpose: 'signing_cancel', relic_id: RELIC_ID }),
    })
  );
  expect(wrongPurpose.status).toBe(200);
  const otherNonce = (await wrongPurpose.json()).nonce;
  const wrong = await a.fetch(
    new Request(`https://relic.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        ...body,
        attestation: { ...body.attestation, nonce: otherNonce },
      }),
    })
  );
  expect((await wrong.json()).passkey_check).toBe('nonce');
});

test.each([
  [
    'signing_closed',
    {
      settings: {
        suggestions: true,
        comments: true,
        signing: false,
        notifications: true,
      },
    },
  ],
  ['relic_expired', { expiresAt: NOW - 1 }],
  ['share_unavailable', { shareVerifier: undefined }],
  ['version_locked', { lockedVersions: [1] }],
  [
    'signing_in_progress',
    { signingOpen: { requestId: 'already', version: 1 } },
  ],
] as const)('creation refuses %s on the live row', async (code, change) => {
  const store = new MemoryStore();
  const { a, make } = await setup(store);
  await store.updateRelic(RELIC_ID, (current) => ({ ...current, ...change }));
  const response = await a.fetch(post(await make()));
  expect((await response.json()).code).toBe(code);
});

test.each(['memory', 'gcs'] as const)(
  'private signer on %s requires a current grant and a version wrap',
  async (backend) => {
    const fake = fakeGcs();
    const store =
      backend === 'memory'
        ? new MemoryStore()
        : gcsStore({
            bucket: 'relics',
            prefix: 'tenant/m',
            host: 'https://gcs.test',
            getAccessToken: async () => 'test',
            fetch: fake.fetch,
          });
    const { a, b, make } = await setup(store);
    await store.updateRelic(RELIC_ID, (row) => ({
      ...row,
      access: 'private',
      expiresAt: NOW + 86400000,
      sealedVersion: 1,
    }));
    await store.createIdentity(
      identity({
        identityId: GRANTEE_ID,
        email: 'reader@example.com',
        address: 'reader@example.com',
        kemKeyId: RECIPIENT_B,
      })
    );
    await store.putSeal(seal(1));
    const request = () =>
      make({
        require_opened: true,
        signers: [{ email: 'reader@example.com', identity_id: GRANTEE_ID }],
      });
    const noGrant = await a.fetch(post(await request()));
    expect((await noGrant.json()).code).toBe('signer_without_access');
    await store.putGrant(grant());
    const noWrap = await a.fetch(post(await request()));
    expect((await noWrap.json()).code).toBe('signer_without_access');
    await store.putWrap(wrap(RECIPIENT_B, 1));
    const accepted = await b.fetch(post(await request()));
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).request.statement.require_opened).toBe(true);
    await store.putReceipt(RELIC_ID, {
      version: 1,
      identityId: GRANTEE_ID,
      kind: 'served',
      at: NOW,
    });
    await store.putSession({
      tokenHash: await sha256Hex('signer-session'),
      email: 'reader@example.com',
      createdAt: NOW,
      expiresAt: NOW + 86400000,
    });
    await store.putSession({
      tokenHash: await sha256Hex('stranger-session'),
      email: 'stranger@example.com',
      createdAt: NOW,
      expiresAt: NOW + 86400000,
    });
    const read = (body: unknown, cookie?: string) =>
      new Request(`https://relic.example/api/relics/${RELIC_ID}/signing/read`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      });
    const publisher = await (
      await a.fetch(read({ publish_token: token }))
    ).json();
    expect(publisher.requests[0].signers[0].served_at).toBe(
      new Date(NOW).toISOString()
    );
    const signer = await (
      await b.fetch(read({}, 'relic_session=signer-session'))
    ).json();
    expect(signer.me.served_at).toBe(new Date(NOW).toISOString());
    expect(signer.requests[0].signers[0].served_at).toBeNull();
    const denied = await a.fetch(read({}, 'relic_session=stranger-session'));
    expect((await denied.json()).code).toBe('private_access_denied');
    await store.updateGrant(RELIC_ID, GRANTEE_ID, (current) => ({
      ...current,
      revokedAt: NOW,
    }));
    const revoked = await b.fetch(read({}, 'relic_session=signer-session'));
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).requests[0].signers[0].status).toBe(
      'needs_access'
    );
  }
);

test('signing reads and writes spend separate rate budgets', async () => {
  const store = new MemoryStore();
  const { a } = await setup(store);
  for (let i = 0; i < 60; i++) {
    expect((await a.fetch(post({ publish_token: 'wrong' }))).status).toBe(403);
  }
  const limited = await a.fetch(post({ publish_token: 'wrong' }));
  expect((await limited.json()).code).toBe('signing_rate_limited');
  const read = await a.fetch(
    new Request(`https://relic.example/api/relics/${RELIC_ID}/signing/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publish_token: token }),
    })
  );
  expect(read.status).toBe(200);
});

test('creation reports malformed signers, request ids, layouts and mismatched versions', async () => {
  const store = new MemoryStore();
  const { a, make } = await setup(store);
  const malformedSigners = await make();
  Object.assign(malformedSigners.request.statement, {
    signers: [
      { email: 'reader@example.com', identity_id: null },
      { email: 'Reader@example.com', identity_id: null },
    ],
  });
  const signers = await (await a.fetch(post(malformedSigners))).json();
  expect([signers.code, signers.signing_check]).toEqual([
    'invalid_signing_request',
    'signers',
  ]);
  const malformedId = await make();
  Object.assign(malformedId.request.statement, { request_id: 'bad' });
  const requestId = await (await a.fetch(post(malformedId))).json();
  expect([requestId.code, requestId.signing_check]).toEqual([
    'invalid_signing_request',
    'request_id',
  ]);
  const malformedLayout = await make();
  malformedLayout.layout_ciphertext = 'bad!';
  const layout = await (await a.fetch(post(malformedLayout))).json();
  expect([layout.code, layout.signing_check]).toEqual([
    'invalid_signing_request',
    'layout',
  ]);
  const swappedLayout = await make();
  swappedLayout.layout_ciphertext = encodeBase64url(randomBytes(64));
  const swapped = await (await a.fetch(post(swappedLayout))).json();
  expect([swapped.code, swapped.signing_check]).toEqual([
    'invalid_signing_request',
    'layout',
  ]);
  const version = await (
    await a.fetch(post(await make({ version: 2 })))
  ).json();
  expect([version.code, version.signing_check]).toEqual([
    'invalid_signing_request',
    'version',
  ]);
  const mismatch = await (
    await a.fetch(post(await make({ ciphertext_sha256: '9'.repeat(64) })))
  ).json();
  expect(mismatch.code).toBe('signing_digest_mismatch');
  expect(mismatch.version_digest).toBe(digest);
});

test('owner authentication precedes request verification', async () => {
  const store = new MemoryStore();
  const { a } = await setup(store);
  await store.createIdentity(
    identity({
      identityId: GRANTEE_ID,
      email: 'other@example.com',
      address: 'other@example.com',
      kemKeyId: RECIPIENT_B,
    })
  );
  for (const email of ['other@example.com', 'without-identity@example.com']) {
    await store.putSession({
      tokenHash: await sha256Hex(email),
      email,
      createdAt: NOW,
      expiresAt: NOW + 86400000,
    });
  }
  const submit = (email?: string) =>
    a.fetch(
      new Request(`https://relic.example${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(email === undefined ? {} : { cookie: `relic_session=${email}` }),
        },
        body: JSON.stringify({ attestation: {} }),
      })
    );
  expect((await (await submit()).json()).code).toBe('sign_in_required');
  expect(
    (await (await submit('without-identity@example.com')).json()).code
  ).toBe('identity_required');
  expect((await (await submit('other@example.com')).json()).code).toBe(
    'owner_required'
  );
});

test('ambiguous CAS failure does not cancel a request that actually opened', async () => {
  class AmbiguousStore extends MemoryStore {
    failAfterCommit = false;
    override async updateRelic(
      id: string,
      change: (row: RelicRow) => RelicRow
    ): Promise<RelicRow | undefined> {
      const result = await super.updateRelic(id, change);
      if (this.failAfterCommit && result?.signingOpen !== undefined) {
        this.failAfterCommit = false;
        throw new Error('response lost after commit');
      }
      return result;
    }
  }
  const store = new AmbiguousStore();
  const { a, make } = await setup(store);
  const request = await make();
  store.failAfterCommit = true;
  await expect(a.fetch(post(request))).rejects.toThrow(
    'response lost after commit'
  );
  expect((await store.getRelic(RELIC_ID))?.signingOpen?.requestId).toBe(
    request.request.statement.request_id
  );
  expect(
    (
      await store.getSigningRequest(
        RELIC_ID,
        request.request.statement.request_id
      )
    )?.status
  ).toBe('open');
});

test('ambiguous creation CAS preserves a request completed before the error returns', async () => {
  class CompletedStore extends MemoryStore {
    failAfterCommit = false;
    override async updateRelic(
      id: string,
      change: (row: RelicRow) => RelicRow
    ): Promise<RelicRow | undefined> {
      const result = await super.updateRelic(id, change);
      if (this.failAfterCommit && result?.signingOpen !== undefined) {
        this.failAfterCommit = false;
        const requestId = result.signingOpen.requestId;
        await super.updateSigningRequest(id, requestId, (row) => ({
          ...row,
          status: 'complete',
          completedAt: NOW,
        }));
        await super.updateRelic(id, (row) => {
          const { signingOpen: _open, ...rest } = row;
          return { ...rest, lockedVersions: [1] };
        });
        await super.putCertificate(id, requestId, { marker: 'complete' });
        throw new Error('response lost after completion');
      }
      return result;
    }
  }
  const store = new CompletedStore();
  const { a, make } = await setup(store);
  const request = await make();
  store.failAfterCommit = true;
  await expect(a.fetch(post(request))).rejects.toThrow(
    'response lost after completion'
  );
  const requestId = request.request.statement.request_id;
  expect((await store.getSigningRequest(RELIC_ID, requestId))?.status).toBe(
    'complete'
  );
  expect(await store.getCertificate(RELIC_ID, requestId)).toEqual({
    marker: 'complete',
  });
});

test('another instance sees signing disabled and expired reads remain available', async () => {
  const store = new MemoryStore();
  const { a, b, make } = await setup(store);
  const settings = await a.fetch(
    new Request(`https://relic.example/api/relics/${RELIC_ID}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publish_token: token,
        settings: { signing: false },
      }),
    })
  );
  expect(settings.status).toBe(200);
  const refused = await b.fetch(post(await make()));
  expect((await refused.json()).code).toBe('signing_closed');
  await store.updateRelic(RELIC_ID, (row) => ({ ...row, expiresAt: NOW - 1 }));
  const read = await b.fetch(
    new Request(`https://relic.example/api/relics/${RELIC_ID}/signing/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publish_token: token }),
    })
  );
  expect(read.status).toBe(200);
});

test('creation rejects unknown, invalid, revoked and non-owner devices', async () => {
  const store = new MemoryStore();
  const { a, make } = await setup(store);
  const invalid = await make();
  invalid.request.device_id = 'invalid';
  expect((await (await a.fetch(post(invalid))).json()).code).toBe(
    'invalid_device'
  );
  const missing = await make();
  missing.request.device_id = '9'.repeat(64);
  missing.request.statement.signer_id = missing.request.device_id;
  expect((await (await a.fetch(post(missing))).json()).code).toBe(
    'device_not_found'
  );
  const wrongOwner = await make();
  wrongOwner.request.statement.owner_identity_id = '9'.repeat(64);
  expect((await (await a.fetch(post(wrongOwner))).json()).code).toBe(
    'owner_required'
  );
  await store.updateDevice(deviceId, (current) => ({
    ...current,
    certifiedAt: NOW + 1,
  }));
  expect((await (await a.fetch(post(await make()))).json()).code).toBe(
    'invalid_device'
  );
  await store.updateDevice(deviceId, (current) => ({
    ...current,
    certifiedAt: NOW,
    notAfter: NOW - 1,
  }));
  expect((await (await a.fetch(post(await make()))).json()).code).toBe(
    'device_revoked'
  );
  await store.updateDevice(deviceId, (current) => ({
    ...current,
    notAfter: NOW + 86400000,
    revokedAt: NOW,
  }));
  expect((await (await a.fetch(post(await make()))).json()).code).toBe(
    'device_revoked'
  );
});

test.each(['requests', 'cancel', 'read'] as const)(
  '%s refuses invalid, missing and removed reliks',
  async (operation) => {
    const store = new MemoryStore();
    const { a } = await setup(store);
    const send = (id: string) =>
      a.fetch(
        new Request(
          `https://relic.example/api/relics/${id}/signing/${operation}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }
        )
      );
    expect((await (await send('not-an-id')).json()).code).toBe(
      'invalid_relic_id'
    );
    await store.deleteRelicRow(RELIC_ID);
    expect((await (await send(RELIC_ID)).json()).code).toBe('relic_not_found');
    await store.putTombstone({ kind: 'owner', id: RELIC_ID, deletedAt: NOW });
    expect((await (await send(RELIC_ID)).json()).code).toBe('relic_removed');
  }
);

test('sequential requests show only the first unsigned signer ready', async () => {
  const store = new MemoryStore();
  const { a, make } = await setup(store);
  const request = await make({
    order: 'sequential',
    signers: [
      { email: 'one@example.com', identity_id: null },
      { email: 'two@example.com', identity_id: null },
    ],
  });
  const response = await a.fetch(post(request));
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(
    result.signers.map((signer: { status: string }) => signer.status)
  ).toEqual(['ready', 'waiting']);
});

test('a retired owner device cannot create or cancel requests', async () => {
  const store = new MemoryStore();
  const { a, make, cancel } = await setup(store);
  const request = await make();
  expect((await a.fetch(post(request))).status).toBe(201);
  await store.updateIdentity(OWNER_ID, (owner) => ({
    ...owner,
    retiredAt: NOW,
  }));
  const cancellation = await a.fetch(
    new Request(`https://relic.example/api/relics/${RELIC_ID}/signing/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await cancel(request.request.statement.request_id)),
    })
  );
  expect((await cancellation.json()).code).toBe('owner_required');
  const creation = await a.fetch(post(await make()));
  expect((await creation.json()).code).toBe('owner_required');
});

test('cancellation racing staged creation cannot leave an open pointer', async () => {
  class PausedStore extends MemoryStore {
    readonly inserted = Promise.withResolvers<void>();
    readonly resume = Promise.withResolvers<void>();
    override async putSigningRequest(
      ...args: Parameters<MemoryStore['putSigningRequest']>
    ) {
      const result = await super.putSigningRequest(...args);
      this.inserted.resolve();
      await this.resume.promise;
      return result;
    }
  }
  const store = new PausedStore();
  const { a, b, make, cancel } = await setup(store);
  const request = await make();
  const creating = a.fetch(post(request));
  await store.inserted.promise;
  const cancelled = await b.fetch(
    new Request(`https://relic.example/api/relics/${RELIC_ID}/signing/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await cancel(request.request.statement.request_id)),
    })
  );
  expect(cancelled.status).toBe(200);
  store.resume.resolve();
  const creation = await creating;
  expect((await creation.json()).code).toBe('signing_request_closed');
  expect((await store.getRelic(RELIC_ID))?.signingOpen).toBeUndefined();
});
