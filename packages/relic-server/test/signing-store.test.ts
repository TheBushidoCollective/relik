import { describe, expect, test } from 'bun:test';
import { gcsStore } from '../src/gcsstore.ts';
import { verifyAttestation } from '../src/private/attest.ts';
import {
  assertVersionUnlocked,
  MemoryStore,
  type RelicStore,
  type SigningRequestRow,
} from '../src/store.ts';
import { fakeGcs } from './fake-gcs.ts';
import {
  attestation,
  DAY,
  NOW,
  OWNER_ID,
  privateRelic,
  RELIC_ID,
  relic,
} from './private-fixtures.ts';

const request: SigningRequestRow = {
  statement: { request_id: 'req' },
  signature: 'sig',
  signerKind: 'device',
  signerId: OWNER_ID,
  layoutCiphertext: 'encrypted',
  status: 'open',
  createdAt: NOW,
};
const receipt = {
  version: 1,
  identityId: OWNER_ID,
  kind: 'served' as const,
  at: NOW,
};
const signature = {
  signerIndex: 0,
  email: 'signer@example.com',
  attestation: attestation(),
  markCiphertext: 'encrypted',
  recordedAt: NOW,
};
const makeGcs = () => {
  const fake = fakeGcs();
  return {
    fake,
    store: gcsStore({
      bucket: 'relics',
      prefix: 'tenant/m',
      ciphertextPrefix: 'tenant/cipher',
      getAccessToken: async () => 'token',
      host: 'https://gcs.test',
      fetch: fake.fetch,
    }),
  };
};

test('identity-free verification is limited to signatures on public reliks', async () => {
  const store = new MemoryStore();
  await store.putRelic(privateRelic());
  const env = { store } as never;
  const input = {
    bundle: {},
    email: 'signer@example.com',
    passkeys: undefined,
    signerKey: () => undefined,
    relicId: RELIC_ID,
    identityFree: true,
  };
  await expect(
    verifyAttestation(env, { ...input, purpose: 'grant' })
  ).rejects.toMatchObject({
    code: 'invalid_statement',
    options: { statement_check: 'purpose' },
  });
  await expect(
    verifyAttestation(env, { ...input, purpose: 'sign' })
  ).rejects.toMatchObject({
    code: 'invalid_statement',
    options: { statement_check: 'purpose' },
  });
});

for (const [name, make] of [
  ['memory', () => new MemoryStore()],
  ['gcs', () => makeGcs().store],
] as const) {
  describe(`signing store ${name}`, () => {
    test('create-only records, CAS, first receipts, and whole-relik sweep', async () => {
      const store: RelicStore = make();
      await store.putRelic(privateRelic());
      expect(await store.putSigningRequest(RELIC_ID, 'req', request)).toBe(
        true
      );
      expect(
        await store.putSigningRequest(RELIC_ID, 'req', {
          ...request,
          signature: 'changed',
        })
      ).toBe(false);
      expect((await store.getSigningRequest(RELIC_ID, 'req'))?.signature).toBe(
        'sig'
      );
      expect((await store.listSigningRequests(RELIC_ID)).length).toBe(1);
      expect(
        (
          await store.updateSigningRequest(RELIC_ID, 'req', (row) => ({
            ...row,
            status: 'cancelled',
            cancelledAt: NOW,
          }))
        )?.status
      ).toBe('cancelled');
      await expect(
        store.updateSigningRequest(RELIC_ID, 'req', (row) => ({
          ...row,
          signature: 'tampered',
        }))
      ).rejects.toThrow('immutable');
      await expect(
        store.updateSigningRequest(RELIC_ID, 'req', () => {
          throw new Error('abort');
        })
      ).rejects.toThrow('abort');
      expect((await store.getSigningRequest(RELIC_ID, 'req'))?.status).toBe(
        'cancelled'
      );
      expect(await store.putSignature(RELIC_ID, 'req', signature)).toBe(true);
      expect(await store.putSignature(RELIC_ID, 'req', signature)).toBe(false);
      expect((await store.listSignatures(RELIC_ID, 'req')).length).toBe(1);
      expect(await store.putCertificate(RELIC_ID, 'req', { value: 1 })).toBe(
        true
      );
      expect(await store.putCertificate(RELIC_ID, 'req', { value: 2 })).toBe(
        false
      );
      expect(await store.getCertificate(RELIC_ID, 'req')).toEqual({ value: 1 });
      expect(await store.putReceipt(RELIC_ID, receipt)).toBe(true);
      expect(
        await store.putReceipt(RELIC_ID, { ...receipt, at: NOW + 1 })
      ).toBe(false);
      expect(await store.listReceipts(RELIC_ID, 1)).toEqual([receipt]);
      expect(await store.deleteSigningForRelic(RELIC_ID)).toBe(4);
      expect(await store.deleteSigningForRelic(RELIC_ID)).toBe(0);
    });
    test('public lock refuses republish but private versions may advance', async () => {
      const store = make();
      await store.putRelic(
        relic({ signingOpen: { requestId: 'r', version: 1 } })
      );
      await expect(
        store.beginVersion(RELIC_ID, 'html', 1)
      ).rejects.toMatchObject({ code: 'signing_in_progress' });
      await store.putRelic(relic({ lockedVersions: [1] }));
      await expect(
        store.beginVersion(RELIC_ID, 'html', 1)
      ).rejects.toMatchObject({ code: 'version_locked' });
      await store.putRelic(
        privateRelic({
          signingOpen: { requestId: 'r', version: 1 },
          lockedVersions: [1],
        })
      );
      expect((await store.beginVersion(RELIC_ID, 'html', 1))?.version).toBe(2);
    });
    test('version locks are checked before deletion', () => {
      expect(() =>
        assertVersionUnlocked(
          privateRelic({ signingOpen: { requestId: 'r', version: 1 } }),
          1
        )
      ).toThrow('Signing is in progress');
      expect(() =>
        assertVersionUnlocked(privateRelic({ lockedVersions: [1] }), 1)
      ).toThrow('This version is locked');
      expect(() =>
        assertVersionUnlocked(privateRelic({ lockedVersions: [1] }), 2)
      ).not.toThrow();
    });
  });
}

test('private lifetime sweep includes signing, receipts, reverse indexes and prefixed ciphertext only for this relik', async () => {
  const { fake, store } = makeGcs();
  const old = new Date(NOW + 30 * DAY).toISOString();
  const target = NOW + 60 * DAY;
  await store.putRelic(privateRelic());
  await store.putSigningRequest(RELIC_ID, 'req', request);
  await store.putReceipt(RELIC_ID, receipt);
  const names = [
    `tenant/m/comment/${RELIC_ID}/c.json`,
    `tenant/m/commenter/${RELIC_ID}/_complete.json`,
    `tenant/m/share/${RELIC_ID}/s.json`,
    `tenant/m/optout/${RELIC_ID}/o.json`,
    `tenant/m/decision/${RELIC_ID}/d.json`,
    `tenant/m/wrap/${RELIC_ID}/1/a.json`,
    `tenant/m/seal/${RELIC_ID}/1.json`,
    `tenant/m/grant/${RELIC_ID}/a.json`,
    `tenant/m/access-request/${RELIC_ID}/a.json`,
    `tenant/m/settings/${RELIC_ID}/s.json`,
    `tenant/m/author_relic/a/${RELIC_ID}.json`,
    `tenant/m/grant-by-grantee/a/${RELIC_ID}.json`,
    `tenant/m/owner-relic/a/${RELIC_ID}.json`,
    `tenant/cipher/${RELIC_ID}`,
    `tenant/cipher/${RELIC_ID}/2`,
  ];
  for (const name of names)
    fake.objects.set(name, { body: '{}', generation: 1, customTime: old });
  const other = 'tenant/m/signing/other/req/request.json';
  fake.objects.set(other, { body: '{}', generation: 1, customTime: old });
  await store.extendPrivateLifetime(RELIC_ID, target);
  for (const name of [
    ...names,
    `tenant/m/relic/${RELIC_ID}.json`,
    `tenant/m/signing/${RELIC_ID}/req/request.json`,
    `tenant/m/receipt/${RELIC_ID}/1/${OWNER_ID}/served.json`,
  ])
    expect(fake.objects.get(name)?.customTime).toBe(
      new Date(target).toISOString()
    );
  expect(fake.objects.get(other)?.customTime).toBe(old);
  await store.extendPrivateLifetime(RELIC_ID, NOW + DAY);
  expect(fake.objects.get(names[0] as string)?.customTime).toBe(
    new Date(target).toISOString()
  );
  expect(fake.requests.some(({ init }) => init.method === 'DELETE')).toBe(
    false
  );
});
