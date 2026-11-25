import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  encodeBase64url,
  generateIdentityKeys,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import { layoutCiphertextSha256 } from '@relic/format/signing';
import { createApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { MemoryStore, type RelicStore } from '../src/store.ts';
import { fakeGcs } from './fake-gcs.ts';
import {
  attestation,
  identity,
  relic,
  device,
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
  const make = async () => {
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
    });
  }
);
