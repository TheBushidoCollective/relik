import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { deriveShareProof, generateKey, shareVerifierFor } from '@relic/format';
import {
  attestationChallenge,
  decodeBase64url,
  encodeBase64url,
  generateIdentityKeys,
  identityIdOf,
  kemKeyIdOf,
  identityFingerprint,
  wrapVersionKey,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import type {
  SigningRequestStatement,
  SignatureStatement,
  SigningCancelStatement,
  DeleteStatement,
} from '@relic/format/private';
import {
  layoutCiphertextSha256,
  markCiphertextSha256,
  signingRequestSha256,
  verifySigningCertificate,
} from '@relic/format/signing';
import { createApp } from '../src/app.ts';
import type { OutboundMail } from '../src/mail.ts';
import { sha256Hex } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { MemoryStorage } from '../src/storage.ts';
import {
  assertVersionUnlocked,
  MemoryStore,
  type RelicStore,
} from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import { fakeGcs } from './fake-gcs.ts';
import {
  attestation,
  grant,
  identity,
  NOW,
  relic,
  RELIC_ID,
  seal,
  wrap,
} from './private-fixtures.ts';

const origin = 'https://relic.example';
const root = `/api/relics/${RELIC_ID}`;
const b64 = (bytes: Uint8Array) => encodeBase64url(bytes);

async function fixture(store: RelicStore = new MemoryStore()) {
  const storage = new MemoryStorage();
  const mails: { email: string; mail: OutboundMail }[] = [];
  const mailer = {
    async send() {},
    async sendMail(email: string, mail: OutboundMail) {
      mails.push({ email, mail });
    },
  };
  const a = createApp({ store, storage, mailer, now: () => NOW });
  const b = createApp({ store, storage, mailer, now: () => NOW });
  const bytes = new TextEncoder().encode('signed ciphertext');
  storage.put(RELIC_ID, bytes);
  const digest = (await storage.digest(RELIC_ID)) as string;
  const proof = await deriveShareProof(generateKey());
  const shareProof = b64(proof);
  const shareVerifier = await shareVerifierFor(proof);
  async function person(email: string, withIdentity: boolean) {
    const auth = await fakeAuthenticator({ hasPrf: true });
    await auth.register(
      {
        challenge: b64(randomBytes(32)),
        rp: { id: 'relic.example', name: 'Relik' },
        user: { id: 'dXNlcg', name: email, displayName: email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        extensions: { prf: {} },
      } as never,
      origin
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
          createdAt: NOW,
        },
      ],
    });
    const token = b64(randomBytes(32));
    await store.putSession({
      tokenHash: await sha256Hex(token),
      email,
      createdAt: NOW,
      expiresAt: NOW + 86400000,
    });
    const keys = await generateIdentityKeys();
    const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
    if (withIdentity)
      await store.createIdentity(
        identity({
          identityId,
          email,
          address: email,
          kemPublicKey: b64(keys.kemPublicKey),
          sigPublicKey: b64(keys.sigPublicKey),
          kemKeyId: Buffer.from(await kemKeyIdOf(keys.kemPublicKey)).toString(
            'hex'
          ),
          credentials: [
            {
              credentialId: auth.credentialId,
              encryptedBundle: '',
              boundAt: NOW,
              attestation: attestation(),
            },
          ],
        })
      );
    return { email, auth, keys, identityId, cookie: `relic_session=${token}` };
  }
  const owner = await person('owner@example.com', true);
  const first = await person('first@example.com', true);
  const second = await person('second@example.com', true);
  await store.putRelic(
    relic({
      ownerIdentityId: owner.identityId,
      publishedAt: NOW,
      shareVerifier,
      versionDigests: { '1': digest },
    })
  );
  async function enablePrivate() {
    await store.updateRelic(RELIC_ID, (row) => ({
      ...row,
      access: 'private',
      title: 'SECRET CLIENT TITLE',
      expiresAt: NOW + 86400000,
      sealedVersion: 1,
    }));
    await store.putSeal({
      ...seal(1),
      signerId: owner.identityId,
      statement: { ciphertext_sha256: digest, key_commitment: 'c'.repeat(64) },
    });
    for (const who of [first, second]) {
      const record = await store.getIdentity(who.identityId);
      if (record === undefined) throw new Error('identity missing');
      await store.putGrant({
        ...grant(who.identityId),
        ownerIdentityId: owner.identityId,
      });
      await store.putWrap(wrap(record.kemKeyId, 1));
    }
  }
  async function post(
    app: typeof a,
    path: string,
    body: unknown,
    cookie: string
  ) {
    const response = await app.fetch(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      })
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        nonce: string;
        signer_index: number;
        signer_identity_id: string | null;
        opened_receipt_sha256: string | null;
        code: string;
      } & Record<string, unknown>,
    };
  }
  async function assertion(
    who: typeof owner,
    nonce: string,
    kind: 'signature' | 'signing_request' | 'signing_cancel' | 'delete',
    statement:
      | SigningRequestStatement
      | SignatureStatement
      | SigningCancelStatement
      | DeleteStatement,
    signIdentity: boolean
  ) {
    const message = statementBytes(kind, statement as never);
    const challenge = b64(
      await attestationChallenge(decodeBase64url(nonce), [message])
    );
    const credential = await who.auth.assert(
      {
        challenge,
        rpId: 'relic.example',
        timeout: 300000,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: who.auth.credentialId }],
      } as never,
      origin
    );
    const { clientExtensionResults: _, ...wire } =
      credential as unknown as Record<string, unknown>;
    const identitySignature = signIdentity
      ? await signStatement(
          async (value) =>
            new Uint8Array(
              await crypto.subtle.sign(
                { name: 'ECDSA', hash: 'SHA-256' },
                who.keys.sig.privateKey,
                value as BufferSource
              )
            ),
          message
        )
      : '';
    return {
      nonce,
      statements: [{ kind, statement, identity_signature: identitySignature }],
      credential: wire,
    };
  }
  async function open(
    order: 'parallel' | 'sequential' = 'parallel',
    isPrivate = false,
    requireOpened = false,
    version = 1,
    signers: readonly (typeof first)[] = [first, second],
    signerOverride?: SigningRequestStatement['signers'],
    expectedStatus = 201,
    extra: Record<string, unknown> = {}
  ) {
    const nonce = await post(
      a,
      '/api/attest/nonce',
      { purpose: 'signing_request', relic_id: RELIC_ID },
      owner.cookie
    );
    expect(nonce.status).toBe(200);
    const layout = b64(randomBytes(64));
    const statement: SigningRequestStatement = {
      at: NOW,
      ciphertext_sha256: digest,
      consent: 'relic/sign-consent/v1',
      content_mac: 'f'.repeat(64),
      layout_sha256: layoutCiphertextSha256(layout),
      order,
      owner_identity_id: owner.identityId,
      relic_id: RELIC_ID,
      request_id: b64(randomBytes(16)),
      require_opened: requireOpened,
      signer_id: owner.identityId,
      signers:
        signerOverride ??
        signers.map((signer) => ({
          email: signer.email,
          identity_id: isPrivate ? signer.identityId : null,
        })),
      version,
    };
    const result = await post(
      a,
      `${root}/signing/requests`,
      {
        attestation: await assertion(
          owner,
          nonce.body.nonce,
          'signing_request',
          statement,
          true
        ),
        layout_ciphertext: layout,
        ...extra,
      },
      owner.cookie
    );
    expect(result.status).toBe(expectedStatus);
    if (expectedStatus === 409)
      expect(result.body.code).toBe('signer_without_access');
    return statement;
  }
  async function prepare(
    who: typeof owner,
    request: SigningRequestStatement,
    app = a,
    storedMark?: string,
    overrides: Partial<SignatureStatement> = {}
  ) {
    const options = await post(
      app,
      `${root}/signing/options`,
      { request_id: request.request_id, share_proof: shareProof },
      who.cookie
    );
    expect(options.status).toBe(200);
    const mark = storedMark ?? b64(randomBytes(64));
    const statement: SignatureStatement = {
      at: NOW,
      ciphertext_sha256: digest,
      consent: 'relic/sign-consent/v1',
      content_mac: request.content_mac,
      mark_sha256: markCiphertextSha256(mark),
      opened_receipt_sha256: options.body.opened_receipt_sha256,
      relic_id: RELIC_ID,
      request_id: request.request_id,
      request_sha256: signingRequestSha256(request),
      signer_email: who.email,
      signer_identity_id: options.body.signer_identity_id,
      signer_index: options.body.signer_index,
      version: 1,
      ...overrides,
    };
    return {
      request_id: request.request_id,
      share_proof: shareProof,
      mark_ciphertext: mark,
      attestation: await assertion(
        who,
        options.body.nonce,
        'signature',
        statement,
        options.body.signer_identity_id !== null
      ),
    };
  }
  async function opened(who: typeof owner) {
    const delivered = await post(a, `${root}/versions/1/key`, {}, who.cookie);
    expect(delivered.status).toBe(200);
    const statement = {
      at: NOW,
      ciphertext_sha256: digest,
      key_commitment: 'c'.repeat(64),
      reader_identity_id: who.identityId,
      relic_id: RELIC_ID,
      version: 1,
    };
    const signature = await signStatement(
      async (value) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            who.keys.sig.privateKey,
            value as BufferSource
          )
        ),
      statementBytes('open_receipt', statement)
    );
    expect(
      (
        await post(
          b,
          `${root}/receipts/opened`,
          { statement, identity_signature: signature },
          who.cookie
        )
      ).status
    ).toBe(201);
  }
  async function cancel(request: SigningRequestStatement) {
    const nonce = await post(
      a,
      '/api/attest/nonce',
      { purpose: 'signing_cancel', relic_id: RELIC_ID },
      owner.cookie
    );
    expect(nonce.status).toBe(200);
    const statement: SigningCancelStatement = {
      at: NOW,
      owner_identity_id: owner.identityId,
      relic_id: RELIC_ID,
      request_id: request.request_id,
      signer_id: owner.identityId,
    };
    return {
      attestation: await assertion(
        owner,
        nonce.body.nonce,
        'signing_cancel',
        statement,
        true
      ),
    };
  }
  return {
    store,
    storage,
    a,
    b,
    owner,
    first,
    second,
    post,
    person,
    assertion,
    open,
    opened,
    prepare,
    cancel,
    enablePrivate,
    shareProof,
    mails,
  };
}

test('private owner signer needs a current version wrap and other signers need a grant', async () => {
  const f = await fixture();
  await f.enablePrivate();
  const ownerSigner = [
    { email: f.owner.email, identity_id: f.owner.identityId },
  ];
  await f.open('parallel', true, false, 1, undefined, ownerSigner, 409);
  const owner = await f.store.getIdentity(f.owner.identityId);
  expect(owner).toBeDefined();
  await f.store.putWrap(wrap(owner!.kemKeyId, 1));
  await f.store.deleteGrant(RELIC_ID, f.first.identityId);
  await f.open(
    'parallel',
    true,
    false,
    1,
    undefined,
    [...ownerSigner, { email: f.first.email, identity_id: f.first.identityId }],
    409
  );
  await f.open('parallel', true, false, 1, undefined, ownerSigner);
});

test('a signing request grants its named private signer with the same attestation', async () => {
  const f = await fixture();
  await f.enablePrivate();
  await f.store.deleteGrant(RELIC_ID, f.first.identityId);
  const reader = await f.store.getIdentity(f.first.identityId);
  await f.store.deleteWraps(RELIC_ID, { recipientKeyId: reader!.kemKeyId });
  const grantStatement = {
    at: NOW,
    fingerprint_typed: await identityFingerprint(
      f.first.identityId,
      f.first.email
    ),
    grantee_email: f.first.email,
    grantee_identity_id: f.first.identityId,
    owner_identity_id: f.owner.identityId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const signature = await signStatement(
    async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          f.owner.keys.sig.privateKey,
          bytes as BufferSource
        )
      ),
    statementBytes('grant', grantStatement)
  );
  const encrypted = await wrapVersionKey({
    recipientPublicKey: f.first.keys.kemPublicKey,
    relicId: RELIC_ID,
    version: 1,
    key: randomBytes(16),
  });
  await f.open('parallel', true, false, 1, [f.first], undefined, 201, {
    grants: [{ statement: grantStatement, identity_signature: signature }],
    wraps: [
      {
        recipient_key_id: encrypted.recipientKeyId,
        version: 1,
        enc: encrypted.enc,
        ct: encrypted.ct,
      },
    ],
  });
  const saved = await f.store.getGrant(RELIC_ID, f.first.identityId);
  expect(saved?.grantStatement?.statement).toEqual(grantStatement);
  expect(saved?.grantStatement?.identitySignature).toBe(signature);
  expect(saved?.attestation.statements[0]?.kind).toBe('signing_request');
});

test('grants on a public relik are refused as invalid_statement before the owner lookup', async () => {
  const f = await fixture();
  const response = await f.post(
    f.a,
    `${root}/signing/requests`,
    { grants: [{ statement: {}, identity_signature: '' }] },
    f.first.cookie
  );
  expect(response.status).toBe(400);
  expect(response.body['code']).toBe('invalid_statement');
});

test('a grant that applies stays when the request it came with is refused, and the refusal lists it', async () => {
  const f = await fixture();
  await f.enablePrivate();
  await f.store.deleteGrant(RELIC_ID, f.first.identityId);
  await f.store.deleteGrant(RELIC_ID, f.second.identityId);
  const reader = await f.store.getIdentity(f.first.identityId);
  await f.store.deleteWraps(RELIC_ID, { recipientKeyId: reader!.kemKeyId });
  const grantStatement = {
    at: NOW,
    fingerprint_typed: await identityFingerprint(
      f.first.identityId,
      f.first.email
    ),
    grantee_email: f.first.email,
    grantee_identity_id: f.first.identityId,
    owner_identity_id: f.owner.identityId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const signature = await signStatement(
    async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          f.owner.keys.sig.privateKey,
          bytes as BufferSource
        )
      ),
    statementBytes('grant', grantStatement)
  );
  const encrypted = await wrapVersionKey({
    recipientPublicKey: f.first.keys.kemPublicKey,
    relicId: RELIC_ID,
    version: 1,
    key: randomBytes(16),
  });
  // The second signer has no grant, so the request is refused after the first grant applied.
  await f.open(
    'parallel',
    true,
    false,
    1,
    [f.first, f.second],
    undefined,
    409,
    {
      grants: [{ statement: grantStatement, identity_signature: signature }],
      wraps: [
        {
          recipient_key_id: encrypted.recipientKeyId,
          version: 1,
          enc: encrypted.enc,
          ct: encrypted.ct,
        },
      ],
    }
  );
  expect(await f.store.getGrant(RELIC_ID, f.first.identityId)).toBeDefined();
});

test('two public signatures complete across instances and the certificate verifies', async () => {
  const f = await fixture();
  const request = await f.open();
  const one = await f.prepare(f.first, request, f.a);
  const two = await f.prepare(f.second, request, f.b);
  const results = await Promise.all([
    f.post(f.a, `${root}/signing/signatures`, one, f.first.cookie),
    f.post(f.b, `${root}/signing/signatures`, two, f.second.cookie),
  ]);
  expect(results.map((r) => r.status)).toEqual([201, 201]);
  const certificate = await f.post(
    f.b,
    `${root}/signing/certificate`,
    { request_id: request.request_id, share_proof: f.shareProof },
    f.first.cookie
  );
  expect(certificate.status).toBe(200);
  expect(
    (
      await verifySigningCertificate(certificate.body, {
        expectedOrigin: origin,
        trustedOwnerIdentityId: f.owner.identityId,
      })
    ).valid
  ).toBe(true);
  expect((await f.store.getRelic(RELIC_ID))?.lockedVersions).toContain(1);
  const completionMails = f.mails.filter(({ mail }) =>
    mail.subject.startsWith('Everyone signed')
  );
  expect(completionMails).toHaveLength(3);
  expect(
    completionMails.every(({ mail }) => mail.attachments?.length === 1)
  ).toBe(true);
  expect(f.mails.every(({ mail }) => !mail.text.includes('#'))).toBe(true);
});

test('sequential requests refuse a signer out of turn', async () => {
  const f = await fixture();
  const request = await f.open('sequential');
  const response = await f.post(
    f.b,
    `${root}/signing/options`,
    { request_id: request.request_id, share_proof: f.shareProof },
    f.second.cookie
  );
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('signing_not_your_turn');
});

test('signature replay consumes its nonce while request remains open', async () => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  const replay = await f.post(
    f.b,
    `${root}/signing/signatures`,
    first,
    f.first.cookie
  );
  expect(replay.status).toBe(403);
  expect(replay.body.code).toBe('passkey_verification_failed');
  expect(replay.body.passkey_check).toBe('nonce');
});

test.each(['identical', 'different'] as const)(
  'a crash after signature storage admits the first stored signature on a %s retry',
  async (variant) => {
    const f = await fixture();
    const request = await f.open();
    const first = await f.prepare(f.first, request);
    const original = f.store.updateSigningRequest.bind(f.store);
    let fault = true;
    f.store.updateSigningRequest = async (...args) => {
      if (fault) {
        fault = false;
        throw new Error('injected crash after signature put');
      }
      return original(...args);
    };
    // Reverse the former rejection assertion: the boundary returns a generic 500.
    const failedResponse = await f.a.fetch(
      new Request(`${origin}${root}/signing/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: f.first.cookie },
        body: JSON.stringify(first),
      })
    );
    expect(fault).toBe(false);
    expect(failedResponse.status).toBe(500);
    expect(failedResponse.headers.get('content-type')).toBe('text/plain');
    expect(await failedResponse.text()).toBe('Something went wrong!');
    expect(
      (await f.store.getSigningRequest(RELIC_ID, request.request_id))
        ?.signedBy ?? []
    ).toEqual([]);
    const retry = await f.prepare(
      f.first,
      request,
      f.b,
      variant === 'identical' ? first.mark_ciphertext : undefined
    );
    expect(retry.mark_ciphertext === first.mark_ciphertext).toBe(
      variant === 'identical'
    );
    const recovered = await f.post(
      f.b,
      `${root}/signing/signatures`,
      retry,
      f.first.cookie
    );
    expect(recovered.status).toBe(201);
    const stored = await f.store.listSignatures(RELIC_ID, request.request_id);
    expect(stored[0]?.markCiphertext).toBe(first.mark_ciphertext);
    expect(
      (await f.store.getSigningRequest(RELIC_ID, request.request_id))?.signedBy
    ).toEqual([0]);
  }
);

test.each(['cancel-first', 'sign-first'] as const)(
  'cancel and final signature: %s',
  async (order) => {
    const f = await fixture();
    const request = await f.open();
    const first = await f.prepare(f.first, request);
    expect(
      (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
        .status
    ).toBe(201);
    const last = await f.prepare(f.second, request);
    const cancel = await f.cancel(request);
    if (order === 'cancel-first') {
      expect(
        (await f.post(f.a, `${root}/signing/cancel`, cancel, f.owner.cookie))
          .status
      ).toBe(200);
      expect(
        (await f.post(f.b, `${root}/signing/signatures`, last, f.second.cookie))
          .body.code
      ).toBe('signing_request_closed');
      expect(
        (await f.store.getSigningRequest(RELIC_ID, request.request_id))?.status
      ).toBe('cancelled');
      expect(
        await f.store.getCertificate(RELIC_ID, request.request_id)
      ).toBeUndefined();
    } else {
      expect(
        (await f.post(f.b, `${root}/signing/signatures`, last, f.second.cookie))
          .status
      ).toBe(201);
      expect(
        (await f.post(f.a, `${root}/signing/cancel`, cancel, f.owner.cookie))
          .body.code
      ).toBe('signing_request_closed');
      expect(
        (await f.store.getSigningRequest(RELIC_ID, request.request_id))?.status
      ).toBe('complete');
      expect(
        await f.store.getCertificate(RELIC_ID, request.request_id)
      ).toBeDefined();
    }
  }
);

test('cancel wins while an unadmitted signature write is in flight', async () => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  const last = await f.prepare(f.second, request);
  const cancellation = await f.cancel(request);
  const original = f.store.putSignature.bind(f.store);
  const arrived = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.store.putSignature = async (...args) => {
    const result = await original(...args);
    arrived.resolve();
    await gate.promise;
    return result;
  };
  const signing = f.post(
    f.b,
    `${root}/signing/signatures`,
    last,
    f.second.cookie
  );
  await arrived.promise;
  const cancelled = await f.post(
    f.a,
    `${root}/signing/cancel`,
    cancellation,
    f.owner.cookie
  );
  gate.resolve();
  expect(cancelled.status).toBe(200);
  expect((await signing).body.code).toBe('signing_request_closed');
  expect(
    (await f.store.getSigningRequest(RELIC_ID, request.request_id))?.signedBy
  ).toEqual([0]);
  expect(
    await f.store.getCertificate(RELIC_ID, request.request_id)
  ).toBeUndefined();
});

test('private delivery creates a served receipt and a signed opened receipt is first-write-wins', async () => {
  const f = await fixture();
  const owner = await f.store.getIdentity(f.owner.identityId);
  expect(owner).toBeDefined();
  const digest = await f.storage.digest(RELIC_ID);
  const commitment = 'c'.repeat(64);
  await f.store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    access: 'private',
    expiresAt: NOW + 86400000,
    sealedVersion: 1,
  }));
  await f.store.putSeal({
    ...seal(1),
    signerId: f.owner.identityId,
    statement: { ciphertext_sha256: digest, key_commitment: commitment },
  });
  await f.store.putWrap(wrap(owner!.kemKeyId, 1));
  const statement = {
    at: NOW,
    ciphertext_sha256: digest!,
    key_commitment: commitment,
    reader_identity_id: f.owner.identityId,
    relic_id: RELIC_ID,
    version: 1,
  };
  const signature = await signStatement(
    async (value) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          f.owner.keys.sig.privateKey,
          value as BufferSource
        )
      ),
    statementBytes('open_receipt', statement)
  );
  const body = { statement, identity_signature: signature };
  const before = await f.post(
    f.a,
    `${root}/receipts/opened`,
    body,
    f.owner.cookie
  );
  expect(before.body.code).toBe('receipt_not_served');
  const delivered = await f.post(
    f.a,
    `${root}/versions/1/key`,
    {},
    f.owner.cookie
  );
  expect(delivered.status).toBe(200);
  expect(
    (await f.store.listReceipts(RELIC_ID, 1)).find(
      (item) => item.kind === 'served'
    )?.identityId
  ).toBe(f.owner.identityId);
  const invalid = await f.post(
    f.a,
    `${root}/receipts/opened`,
    { ...body, identity_signature: 'bad' },
    f.owner.cookie
  );
  expect(invalid.body.code).toBe('invalid_receipt');
  const mismatch = await f.post(
    f.a,
    `${root}/receipts/opened`,
    { ...body, statement: { ...statement, key_commitment: 'd'.repeat(64) } },
    f.owner.cookie
  );
  expect(mismatch.body.receipt_check).toBe('seal');
  const opened = await f.post(
    f.b,
    `${root}/receipts/opened`,
    body,
    f.owner.cookie
  );
  expect(opened.status).toBe(201);
  const repeated = await f.post(
    f.a,
    `${root}/receipts/opened`,
    body,
    f.owner.cookie
  );
  expect(repeated.status).toBe(200);
  expect(repeated.body.opened_at).toBe(opened.body.opened_at);
});

test('private invitations stay generic and honor recipient stop links', async () => {
  const f = await fixture();
  await f.enablePrivate();
  await f.store.putOptOut({
    relicId: RELIC_ID,
    addressHash: await sha256Hex(f.second.email),
    at: NOW,
  });
  await f.open('parallel', true);
  expect(f.mails).toHaveLength(1);
  expect(f.mails[0]?.email).toBe(f.first.email);
  const notice = f.mails[0]!.mail;
  expect(JSON.stringify(notice)).not.toContain('SECRET CLIENT TITLE');
  expect(JSON.stringify(notice)).not.toContain(f.second.email);
  expect(notice.text).not.toContain('#');
  expect(notice.text).toContain('/unsubscribe?');
});

test('private signing requires verified opens and produces a verifiable certificate', async () => {
  const f = await fixture();
  await f.enablePrivate();
  const request = await f.open('parallel', true, true);
  const refused = await f.post(
    f.a,
    `${root}/signing/options`,
    { request_id: request.request_id },
    f.first.cookie
  );
  expect(refused.body.code).toBe('signing_open_required');
  await f.opened(f.first);
  await f.opened(f.second);
  const first = await f.prepare(f.first, request);
  const second = await f.prepare(f.second, request, f.b);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  const redacted = await f.post(
    f.b,
    `${root}/signing/read`,
    {},
    f.second.cookie
  );
  const view = redacted.body.requests as {
    signers: {
      signature: {
        opened_receipt: unknown;
        opened_receipt_withheld?: boolean;
      } | null;
    }[];
  }[];
  expect(view[0]?.signers[0]?.signature?.opened_receipt).toBeNull();
  expect(view[0]?.signers[0]?.signature?.opened_receipt_withheld).toBe(true);
  expect(
    (await f.post(f.b, `${root}/signing/signatures`, second, f.second.cookie))
      .status
  ).toBe(201);
  const certificate = await f.post(
    f.b,
    `${root}/signing/certificate`,
    { request_id: request.request_id },
    f.first.cookie
  );
  expect(certificate.status).toBe(200);
  expect(
    (
      await verifySigningCertificate(certificate.body, {
        expectedOrigin: origin,
        trustedOwnerIdentityId: f.owner.identityId,
      })
    ).valid
  ).toBe(true);
  const locked = await f.store.getRelic(RELIC_ID);
  expect(() => assertVersionUnlocked(locked!, 1)).toThrow();
  expect((await f.store.beginVersion(RELIC_ID, 'html', 42))?.version).toBe(2);
  const nonce = await f.post(
    f.a,
    '/api/attest/nonce',
    { purpose: 'delete', relic_id: RELIC_ID },
    f.owner.cookie
  );
  expect(nonce.status).toBe(200);
  const deletion: DeleteStatement = {
    at: NOW,
    owner_identity_id: f.owner.identityId,
    relic_id: RELIC_ID,
    versions: [1],
  };
  const attempted = await f.post(
    f.a,
    `${root}/delete`,
    {
      attestation: await f.assertion(
        f.owner,
        nonce.body.nonce,
        'delete',
        deletion,
        true
      ),
    },
    f.owner.cookie
  );
  expect(attempted.body.code).toBe('version_locked');
  expect(
    f.mails.every(
      ({ mail }) => !JSON.stringify(mail).includes('SECRET CLIENT TITLE')
    )
  ).toBe(true);
});

test.each([
  ['content MAC', { content_mac: '0'.repeat(64) }, 'signing_content_mismatch'],
  ['request hash', { request_sha256: '0'.repeat(64) }, 'invalid_signature'],
  [
    'signer email',
    { signer_email: 'intruder@example.com' },
    'invalid_signature',
  ],
  ['mark hash', { mark_sha256: '0'.repeat(64) }, 'invalid_signature'],
  [
    'ciphertext digest',
    { ciphertext_sha256: '0'.repeat(64) },
    'signing_digest_mismatch',
  ],
] as const)(
  'signature refuses mismatched %s',
  async (_name, overrides, code) => {
    const f = await fixture();
    const request = await f.open();
    const body = await f.prepare(f.first, request, f.a, undefined, overrides);
    const response = await f.post(
      f.a,
      `${root}/signing/signatures`,
      body,
      f.first.cookie
    );
    expect(response.body.code).toBe(code);
    expect(
      await f.store.listSignatures(RELIC_ID, request.request_id)
    ).toHaveLength(0);
  }
);

test('replaced ciphertext is refused even when the stored digest cache is unchanged', async () => {
  const f = await fixture();
  const request = await f.open();
  const body = await f.prepare(f.first, request);
  f.storage.put(RELIC_ID, new TextEncoder().encode('replacement ciphertext'));
  const response = await f.post(
    f.b,
    `${root}/signing/signatures`,
    body,
    f.first.cookie
  );
  expect(response.body.code).toBe('signing_digest_mismatch');
});

test('kill switch refuses before spending the signing nonce', async () => {
  const f = await fixture();
  const request = await f.open();
  const body = await f.prepare(f.first, request);
  const paused = createApp({
    store: f.store,
    storage: f.storage,
    now: () => NOW,
    config: { killSwitchEngaged: true },
  });
  expect(
    (await f.post(paused, `${root}/signing/signatures`, body, f.first.cookie))
      .body.code
  ).toBe('service_paused');
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, body, f.first.cookie))
      .status
  ).toBe(201);
});

test('sequential signatures complete and public version remains frozen', async () => {
  const f = await fixture();
  const request = await f.open('sequential');
  await expect(f.store.beginVersion(RELIC_ID, 'html', 42)).rejects.toThrow();
  const first = await f.prepare(f.first, request);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  const second = await f.prepare(f.second, request);
  expect(
    (await f.post(f.b, `${root}/signing/signatures`, second, f.second.cookie))
      .status
  ).toBe(201);
  await expect(f.store.beginVersion(RELIC_ID, 'html', 42)).rejects.toThrow();
  const certificate = await f.post(
    f.b,
    `${root}/signing/certificate`,
    { request_id: request.request_id, share_proof: f.shareProof },
    f.first.cookie
  );
  expect(
    (
      await verifySigningCertificate(certificate.body, {
        expectedOrigin: origin,
        trustedOwnerIdentityId: f.owner.identityId,
      })
    ).valid
  ).toBe(true);
  expect(
    (
      await f.post(
        f.a,
        `${root}/signing/options`,
        { request_id: request.request_id, share_proof: f.shareProof },
        f.first.cookie
      )
    ).body.code
  ).toBe('signing_request_closed');
});

test('a session not named as signer is refused', async () => {
  const f = await fixture();
  const request = await f.open();
  const response = await f.post(
    f.a,
    `${root}/signing/options`,
    { request_id: request.request_id, share_proof: f.shareProof },
    f.owner.cookie
  );
  expect(response.body.code).toBe('not_a_signer');
});

test('unknown consent identifiers are refused', async () => {
  const f = await fixture();
  const request = await f.open();
  const body = await f.prepare(f.first, request, f.a, undefined, {
    consent: 'other-consent' as SignatureStatement['consent'],
  });
  const response = await f.post(
    f.a,
    `${root}/signing/signatures`,
    body,
    f.first.cookie
  );
  expect(response.body.code).toBe('invalid_statement');
});

test('private signatures require the bound identity signature', async () => {
  const f = await fixture();
  await f.enablePrivate();
  const request = await f.open('parallel', true);
  const body = await f.prepare(f.first, request);
  body.attestation.statements[0]!.identity_signature = 'bad';
  const response = await f.post(
    f.a,
    `${root}/signing/signatures`,
    body,
    f.first.cookie
  );
  expect(response.body.code).toBe('invalid_statement');
  expect(
    await f.store.listSignatures(RELIC_ID, request.request_id)
  ).toHaveLength(0);
});

test('live signing switch pauses options and signature submission', async () => {
  const f = await fixture();
  const request = await f.open();
  const body = await f.prepare(f.first, request);
  await f.store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    settings: {
      suggestions: true,
      comments: true,
      signing: false,
      notifications: true,
    },
  }));
  const options = await f.post(
    f.b,
    `${root}/signing/options`,
    { request_id: request.request_id, share_proof: f.shareProof },
    f.second.cookie
  );
  expect(options.body.code).toBe('signing_closed');
  const signing = await f.post(
    f.b,
    `${root}/signing/signatures`,
    body,
    f.first.cookie
  );
  expect(signing.body.code).toBe('signing_closed');
});

test('two instances complete and verify a certificate with prefixed fake GCS storage', async () => {
  const fake = fakeGcs();
  const store = gcsStore({
    bucket: 'relics',
    prefix: 'tenant/m',
    host: 'https://gcs.test',
    getAccessToken: async () => 'test',
    fetch: fake.fetch,
  });
  const f = await fixture(store);
  const request = await f.open();
  const one = await f.prepare(f.first, request);
  const two = await f.prepare(f.second, request, f.b);
  const results = await Promise.all([
    f.post(f.a, `${root}/signing/signatures`, one, f.first.cookie),
    f.post(f.b, `${root}/signing/signatures`, two, f.second.cookie),
  ]);
  expect(results.map((result) => result.status)).toEqual([201, 201]);
  const certificate = await f.post(
    f.b,
    `${root}/signing/certificate`,
    { request_id: request.request_id, share_proof: f.shareProof },
    f.first.cookie
  );
  expect(
    (
      await verifySigningCertificate(certificate.body, {
        expectedOrigin: origin,
        trustedOwnerIdentityId: f.owner.identityId,
      })
    ).valid
  ).toBe(true);
  expect(
    [...fake.objects.keys()].some((key) =>
      key.startsWith(`tenant/m/signing/${RELIC_ID}/`)
    )
  ).toBe(true);
});

test('concurrent signatures by one signer admit exactly one record', async () => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request, f.a);
  const second = await f.prepare(f.first, request, f.b);
  const results = await Promise.all([
    f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie),
    f.post(f.b, `${root}/signing/signatures`, second, f.first.cookie),
  ]);
  expect(results.filter((result) => result.status === 201)).toHaveLength(1);
  expect(
    (await f.store.getSigningRequest(RELIC_ID, request.request_id))?.signedBy
  ).toEqual([0]);
  expect(
    await f.store.listSignatures(RELIC_ID, request.request_id)
  ).toHaveLength(1);
});

test('optional opened receipts do not invalidate private signing completion', async () => {
  const f = await fixture();
  await f.enablePrivate();
  const request = await f.open('parallel', true, false);
  await f.opened(f.first);
  await f.opened(f.second);
  const first = await f.prepare(f.first, request);
  const second = await f.prepare(f.second, request, f.b);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  expect(
    (await f.post(f.b, `${root}/signing/signatures`, second, f.second.cookie))
      .status
  ).toBe(201);
  const certificate = await f.post(
    f.b,
    `${root}/signing/certificate`,
    { request_id: request.request_id },
    f.first.cookie
  );
  expect(certificate.status).toBe(200);
  expect(
    (
      await verifySigningCertificate(certificate.body, {
        expectedOrigin: origin,
        trustedOwnerIdentityId: f.owner.identityId,
      })
    ).valid
  ).toBe(true);
});

test('sequential signing rejects a later signer clock behind an admitted signature', async () => {
  const f = await fixture();
  const request = await f.open('sequential');
  const first = await f.prepare(f.first, request);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  const second = await f.prepare(f.second, request, f.b, undefined, {
    at: NOW - 1000,
  });
  const refused = await f.post(
    f.b,
    `${root}/signing/signatures`,
    second,
    f.second.cookie
  );
  expect(refused.status).toBe(400);
  expect(refused.body.code).toBe('invalid_signature');
  expect(
    (await f.store.getSigningRequest(RELIC_ID, request.request_id))?.status
  ).toBe('open');
  const correct = await f.prepare(f.second, request);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, correct, f.second.cookie))
      .status
  ).toBe(201);
});

test('a revoked signer cannot read unrelated requests or their certificates', async () => {
  const f = await fixture();
  await f.enablePrivate();
  const first = await f.open('parallel', true);
  const cancel = await f.cancel(first);
  expect(
    (await f.post(f.a, `${root}/signing/cancel`, cancel, f.owner.cookie)).status
  ).toBe(200);
  const original = await f.store.getSigningRequest(RELIC_ID, first.request_id);
  expect(original).toBeDefined();
  const otherId = b64(randomBytes(16));
  await f.store.putSigningRequest(RELIC_ID, otherId, {
    ...original!,
    statement: {
      ...original!.statement,
      request_id: otherId,
      signers: [{ email: f.second.email, identity_id: f.second.identityId }],
    },
    status: 'complete',
    completedAt: NOW,
  });
  await f.store.putCertificate(RELIC_ID, otherId, { marker: 'unrelated' });
  await f.store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    lockedVersions: [1],
  }));
  await f.store.updateGrant(RELIC_ID, f.first.identityId, (row) => ({
    ...row,
    revokedAt: NOW,
  }));
  const read = await f.post(f.a, `${root}/signing/read`, {}, f.first.cookie);
  expect(read.status).toBe(200);
  expect(
    (read.body.requests as { request_id: string }[]).map(
      (item) => item.request_id
    )
  ).toEqual([first.request_id]);
  const certificate = await f.post(
    f.a,
    `${root}/signing/certificate`,
    { request_id: otherId },
    f.first.cookie
  );
  expect(certificate.body.code).toBe('private_access_denied');
});

test('current grantees can sign a newly sealed version without regranting', async () => {
  const f = await fixture();
  await f.enablePrivate();
  await f.store.beginVersion(RELIC_ID, 'html', 42);
  const first = await f.store.getIdentity(f.first.identityId);
  const second = await f.store.getIdentity(f.second.identityId);
  await f.store.putSeal({
    ...seal(2),
    statement: {
      ciphertext_sha256: await f.storage.digest(RELIC_ID),
      key_commitment: 'c'.repeat(64),
    },
  });
  await f.store.putWrap(wrap(first!.kemKeyId, 2));
  await f.store.putWrap(wrap(second!.kemKeyId, 2));
  f.storage.put(
    `${RELIC_ID}/v2`,
    new TextEncoder().encode('signed ciphertext')
  );
  await f.store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    publishedAt: NOW,
    sealedVersion: 2,
  }));
  const request = await f.open('parallel', true, false, 2);
  expect(request.version).toBe(2);
});

test('recovery access does not let a revoked grantee sign', async () => {
  const f = await fixture();
  await f.enablePrivate();
  const request = await f.open('parallel', true);
  const prepared = await f.prepare(f.first, request);
  await f.store.updateIdentity(f.owner.identityId, (owner) => ({
    ...owner,
    recovery: {
      recoveryIdentityId: f.first.identityId,
      recoveryEmail: f.first.email,
      designatedAt: NOW,
      attestation: attestation(),
    },
  }));
  await f.store.updateGrant(RELIC_ID, f.first.identityId, (row) => ({
    ...row,
    revokedAt: NOW,
  }));
  expect(
    (await f.post(f.a, `${root}/versions/1/key`, {}, f.first.cookie)).status
  ).toBe(200);
  const options = await f.post(
    f.a,
    `${root}/signing/options`,
    { request_id: request.request_id },
    f.first.cookie
  );
  expect(options.body.code).toBe('private_access_denied');
  const signing = await f.post(
    f.b,
    `${root}/signing/signatures`,
    prepared,
    f.first.cookie
  );
  expect(signing.body.code).toBe('private_access_denied');
});

test('completion mail attaches the winning stored certificate', async () => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  const second = await f.prepare(f.second, request);
  const put = f.store.putCertificate.bind(f.store);
  f.store.putCertificate = async (id, requestId, certificate) => {
    await put(id, requestId, { ...certificate, title: 'concurrent winner' });
    return false;
  };
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  expect(
    (await f.post(f.b, `${root}/signing/signatures`, second, f.second.cookie))
      .status
  ).toBe(201);
  const stored = await f.store.getCertificate(RELIC_ID, request.request_id);
  const message = f.mails.find(
    ({ email, mail }) =>
      email === f.owner.email && mail.subject.startsWith('Everyone signed')
  );
  expect(message?.mail.attachments).toHaveLength(1);
  const attached = JSON.parse(
    new TextDecoder().decode(message!.mail.attachments![0]!.content)
  );
  expect(attached).toEqual(stored);
});

test('an unused nonce cannot authorize a replacement request', async () => {
  const f = await fixture();
  const oldRequest = await f.open();
  const unused = await f.prepare(f.first, oldRequest);
  const cancellation = await f.cancel(oldRequest);
  expect(
    (await f.post(f.a, `${root}/signing/cancel`, cancellation, f.owner.cookie))
      .status
  ).toBe(200);
  const replacement = await f.open();
  const fresh = await f.prepare(f.first, replacement);
  const oldNonceAttestation = await f.assertion(
    f.first,
    unused.attestation.nonce,
    'signature',
    fresh.attestation.statements[0]!.statement,
    false
  );
  const result = await f.post(
    f.b,
    `${root}/signing/signatures`,
    { ...fresh, attestation: oldNonceAttestation },
    f.first.cookie
  );
  expect(result.body.code).toBe('passkey_verification_failed');
  expect(result.body.passkey_check).toBe('nonce');
});

test('a signed relik cannot have its lifetime shortened', async () => {
  const f = await fixture();
  const deadline = NOW + 3 * 86400000;
  const tokenHash = await sha256Hex('settings-token');
  await f.store.updateRelic(RELIC_ID, (row) => ({
    ...row,
    expiresAt: deadline,
    publishTokenHash: tokenHash,
  }));
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  const second = await f.prepare(f.second, request);
  expect(
    (await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie))
      .status
  ).toBe(201);
  expect(
    (await f.post(f.b, `${root}/signing/signatures`, second, f.second.cookie))
      .status
  ).toBe(201);
  const result = await f.post(
    f.a,
    `${root}/settings`,
    { publish_token: 'settings-token', settings: { ttl_days: 1 } },
    f.owner.cookie
  );
  expect(result.body.code).toBe('version_locked');
  expect((await f.store.getRelic(RELIC_ID))?.expiresAt).toBe(deadline);
});

test('ten signatures leave room for the owner completion mail', async () => {
  const f = await fixture();
  const signers = [f.first, f.second];
  for (let i = 2; i < 10; i++)
    signers.push(await f.person(`signer${i}@example.com`, false));
  const request = await f.open('parallel', false, false, 1, signers);
  for (const signer of signers) {
    const body = await f.prepare(signer, request, f.a);
    expect(
      (await f.post(f.a, `${root}/signing/signatures`, body, signer.cookie))
        .status
    ).toBe(201);
  }
  const ownerMails = f.mails.filter((item) => item.email === f.owner.email);
  expect(
    ownerMails.filter(({ mail }) => mail.subject.startsWith('Everyone signed'))
  ).toHaveLength(1);
  expect(ownerMails.length).toBeLessThanOrEqual(10);
});
