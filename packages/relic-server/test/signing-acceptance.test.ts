import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { deriveShareProof, generateKey, shareVerifierFor } from '@relic/format';
import { attestationChallenge, decodeBase64url, encodeBase64url, generateIdentityKeys, identityIdOf, kemKeyIdOf, signStatement, statementBytes } from '@relic/format/private';
import type { SigningRequestStatement, SignatureStatement, SigningCancelStatement } from '@relic/format/private';
import { layoutCiphertextSha256, markCiphertextSha256, signingRequestSha256, verifySigningCertificate } from '@relic/format/signing';
import { createApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';
import { attestation, identity, NOW, relic, RELIC_ID, seal, wrap } from './private-fixtures.ts';

const origin = 'https://relic.example';
const root = `/api/relics/${RELIC_ID}`;
const b64 = (bytes: Uint8Array) => encodeBase64url(bytes);

async function fixture() {
  const store = new MemoryStore();
  const storage = new MemoryStorage();
  const a = createApp({ store, storage, now: () => NOW });
  const b = createApp({ store, storage, now: () => NOW });
  const bytes = new TextEncoder().encode('signed ciphertext');
  storage.put(RELIC_ID, bytes);
  const digest = await storage.digest(RELIC_ID) as string;
  const proof = await deriveShareProof(generateKey());
  const shareProof = b64(proof);
  const shareVerifier = await shareVerifierFor(proof);
  async function person(email: string, withIdentity: boolean) {
    const auth = await fakeAuthenticator({ hasPrf: true });
    await auth.register({ challenge: b64(randomBytes(32)), rp: { id: 'relic.example', name: 'Relik' }, user: { id: 'dXNlcg', name: email, displayName: email }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], extensions: { prf: {} } } as never, origin);
    await store.createPasskeys({ email, userHandle: 'dXNlcg', credentials: [{ credentialId: auth.credentialId, publicKeyJwk: auth.publicJwk, alg: -7, signCount: 0, createdAt: NOW }] });
    const token = b64(randomBytes(32));
    await store.putSession({ tokenHash: await sha256Hex(token), email, createdAt: NOW, expiresAt: NOW + 86400000 });
    const keys = await generateIdentityKeys();
    const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
    if (withIdentity) await store.createIdentity(identity({ identityId, email, address: email, kemPublicKey: b64(keys.kemPublicKey), sigPublicKey: b64(keys.sigPublicKey), kemKeyId: Buffer.from(await kemKeyIdOf(keys.kemPublicKey)).toString('hex'), credentials: [{ credentialId: auth.credentialId, encryptedBundle: '', boundAt: NOW, attestation: attestation() }] }));
    return { email, auth, keys, identityId, cookie: `relic_session=${token}` };
  }
  const owner = await person('owner@example.com', true);
  const first = await person('first@example.com', false);
  const second = await person('second@example.com', false);
  await store.putRelic(relic({ ownerIdentityId: owner.identityId, publishedAt: NOW, shareVerifier, versionDigests: { '1': digest } }));
  async function post(app: typeof a, path: string, body: unknown, cookie: string) {
    const response = await app.fetch(new Request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as { nonce: string; signer_index: number; code: string } & Record<string, unknown> };
  }
  async function assertion(who: typeof owner, nonce: string, kind: 'signature' | 'signing_request' | 'signing_cancel', statement: SigningRequestStatement | SignatureStatement | SigningCancelStatement, signIdentity: boolean) {
    const message = statementBytes(kind, statement as never);
    const challenge = b64(await attestationChallenge(decodeBase64url(nonce), [message]));
    const credential = await who.auth.assert({ challenge, rpId: 'relic.example', timeout: 300000, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: who.auth.credentialId }] } as never, origin);
    const { clientExtensionResults: _, ...wire } = credential as unknown as Record<string, unknown>;
    const identitySignature = signIdentity ? await signStatement(async (value) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.sig.privateKey, value as BufferSource)), message) : '';
    return { nonce, statements: [{ kind, statement, identity_signature: identitySignature }], credential: wire };
  }
  async function open(order: 'parallel' | 'sequential' = 'parallel') {
    const nonce = await post(a, '/api/attest/nonce', { purpose: 'signing_request', relic_id: RELIC_ID }, owner.cookie);
    expect(nonce.status).toBe(200);
    const layout = b64(randomBytes(64));
    const statement: SigningRequestStatement = { at: NOW, ciphertext_sha256: digest, consent: 'relic/sign-consent/v1', content_mac: 'f'.repeat(64), layout_sha256: layoutCiphertextSha256(layout), order, owner_identity_id: owner.identityId, relic_id: RELIC_ID, request_id: b64(randomBytes(16)), require_opened: false, signer_id: owner.identityId, signers: [{ email: first.email, identity_id: null }, { email: second.email, identity_id: null }], version: 1 };
    const result = await post(a, `${root}/signing/requests`, { attestation: await assertion(owner, nonce.body.nonce, 'signing_request', statement, true), layout_ciphertext: layout }, owner.cookie);
    expect(result.status).toBe(201);
    return statement;
  }
  async function prepare(who: typeof owner, request: SigningRequestStatement, app = a, storedMark?: string) {
    const options = await post(app, `${root}/signing/options`, { request_id: request.request_id, share_proof: shareProof }, who.cookie);
    expect(options.status).toBe(200);
    const mark = storedMark ?? b64(randomBytes(64));
    const statement: SignatureStatement = { at: NOW, ciphertext_sha256: digest, consent: 'relic/sign-consent/v1', content_mac: request.content_mac, mark_sha256: markCiphertextSha256(mark), opened_receipt_sha256: null, relic_id: RELIC_ID, request_id: request.request_id, request_sha256: signingRequestSha256(request), signer_email: who.email, signer_identity_id: null, signer_index: options.body.signer_index, version: 1 };
    return { request_id: request.request_id, share_proof: shareProof, mark_ciphertext: mark, attestation: await assertion(who, options.body.nonce, 'signature', statement, false) };
  }
  async function cancel(request: SigningRequestStatement) {
    const nonce = await post(a, '/api/attest/nonce', { purpose: 'signing_cancel', relic_id: RELIC_ID }, owner.cookie);
    expect(nonce.status).toBe(200);
    const statement: SigningCancelStatement = { at: NOW, owner_identity_id: owner.identityId, relic_id: RELIC_ID, request_id: request.request_id, signer_id: owner.identityId };
    return { attestation: await assertion(owner, nonce.body.nonce, 'signing_cancel', statement, true) };
  }
  return { store, storage, a, b, owner, first, second, post, open, prepare, cancel, shareProof };
}

test('two public signatures complete across instances and the certificate verifies', async () => {
  const f = await fixture();
  const request = await f.open();
  const one = await f.prepare(f.first, request, f.a);
  const two = await f.prepare(f.second, request, f.b);
  const results = await Promise.all([f.post(f.a, `${root}/signing/signatures`, one, f.first.cookie), f.post(f.b, `${root}/signing/signatures`, two, f.second.cookie)]);
  expect(results.map((r) => r.status)).toEqual([201, 201]);
  const certificate = await f.post(f.b, `${root}/signing/certificate`, { request_id: request.request_id, share_proof: f.shareProof }, f.first.cookie);
  expect(certificate.status).toBe(200);
  expect((await verifySigningCertificate(certificate.body, { expectedOrigin: origin, trustedOwnerIdentityId: f.owner.identityId })).valid).toBe(true);
  expect((await f.store.getRelic(RELIC_ID))?.lockedVersions).toContain(1);
});

test('sequential requests refuse a signer out of turn', async () => {
  const f = await fixture();
  const request = await f.open('sequential');
  const response = await f.post(f.b, `${root}/signing/options`, { request_id: request.request_id, share_proof: f.shareProof }, f.second.cookie);
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('signing_not_your_turn');
});

test('signature replay consumes its nonce while request remains open', async () => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  expect((await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie)).status).toBe(201);
  const replay = await f.post(f.b, `${root}/signing/signatures`, first, f.first.cookie);
  expect(replay.status).toBe(403);
  expect(replay.body.code).toBe('passkey_verification_failed');
  expect(replay.body.passkey_check).toBe('nonce');
});

test.each(['identical', 'different'] as const)('a crash after signature storage admits the first stored signature on a %s retry', async (variant) => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  const original = f.store.updateSigningRequest.bind(f.store);
  let fault = true;
  f.store.updateSigningRequest = async (...args) => {
    if (fault) { fault = false; throw new Error('injected crash after signature put'); }
    return original(...args);
  };
  await expect(f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie)).rejects.toThrow('injected crash');
  expect((await f.store.getSigningRequest(RELIC_ID, request.request_id))?.signedBy ?? []).toEqual([]);
  const retry = await f.prepare(f.first, request, f.b, variant === 'identical' ? first.mark_ciphertext : undefined);
  expect(retry.mark_ciphertext === first.mark_ciphertext).toBe(variant === 'identical');
  const recovered = await f.post(f.b, `${root}/signing/signatures`, retry, f.first.cookie);
  expect(recovered.status).toBe(201);
  const stored = await f.store.listSignatures(RELIC_ID, request.request_id);
  expect(stored[0]?.markCiphertext).toBe(first.mark_ciphertext);
  expect((await f.store.getSigningRequest(RELIC_ID, request.request_id))?.signedBy).toEqual([0]);
});

test.each(['cancel-first', 'sign-first'] as const)('cancel and final signature: %s', async (order) => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  expect((await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie)).status).toBe(201);
  const last = await f.prepare(f.second, request);
  const cancel = await f.cancel(request);
  if (order === 'cancel-first') {
    expect((await f.post(f.a, `${root}/signing/cancel`, cancel, f.owner.cookie)).status).toBe(200);
    expect((await f.post(f.b, `${root}/signing/signatures`, last, f.second.cookie)).body.code).toBe('signing_request_closed');
    expect((await f.store.getSigningRequest(RELIC_ID, request.request_id))?.status).toBe('cancelled');
    expect(await f.store.getCertificate(RELIC_ID, request.request_id)).toBeUndefined();
  } else {
    expect((await f.post(f.b, `${root}/signing/signatures`, last, f.second.cookie)).status).toBe(201);
    expect((await f.post(f.a, `${root}/signing/cancel`, cancel, f.owner.cookie)).body.code).toBe('signing_request_closed');
    expect((await f.store.getSigningRequest(RELIC_ID, request.request_id))?.status).toBe('complete');
    expect(await f.store.getCertificate(RELIC_ID, request.request_id)).toBeDefined();
  }
});

test('cancel wins while an unadmitted signature write is in flight', async () => {
  const f = await fixture();
  const request = await f.open();
  const first = await f.prepare(f.first, request);
  expect((await f.post(f.a, `${root}/signing/signatures`, first, f.first.cookie)).status).toBe(201);
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
  const signing = f.post(f.b, `${root}/signing/signatures`, last, f.second.cookie);
  await arrived.promise;
  const cancelled = await f.post(f.a, `${root}/signing/cancel`, cancellation, f.owner.cookie);
  gate.resolve();
  expect(cancelled.status).toBe(200);
  expect((await signing).body.code).toBe('signing_request_closed');
  expect((await f.store.getSigningRequest(RELIC_ID, request.request_id))?.signedBy).toEqual([0]);
  expect(await f.store.getCertificate(RELIC_ID, request.request_id)).toBeUndefined();
});

test('private delivery creates a served receipt and a signed opened receipt is first-write-wins', async () => {
  const f = await fixture();
  const owner = await f.store.getIdentity(f.owner.identityId);
  expect(owner).toBeDefined();
  const digest = await f.storage.digest(RELIC_ID);
  const commitment = 'c'.repeat(64);
  await f.store.updateRelic(RELIC_ID, (row) => ({ ...row, access: 'private', expiresAt: NOW + 86400000, sealedVersion: 1 }));
  await f.store.putSeal({ ...seal(1), signerId: f.owner.identityId, statement: { ciphertext_sha256: digest, key_commitment: commitment } });
  await f.store.putWrap(wrap(owner!.kemKeyId, 1));
  const statement = { at: NOW, ciphertext_sha256: digest!, key_commitment: commitment, reader_identity_id: f.owner.identityId, relic_id: RELIC_ID, version: 1 };
  const signature = await signStatement(async (value) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, f.owner.keys.sig.privateKey, value as BufferSource)), statementBytes('open_receipt', statement));
  const body = { statement, identity_signature: signature };
  const before = await f.post(f.a, `${root}/receipts/opened`, body, f.owner.cookie);
  expect(before.body.code).toBe('receipt_not_served');
  const delivered = await f.post(f.a, `${root}/versions/1/key`, {}, f.owner.cookie);
  expect(delivered.status).toBe(200);
  expect((await f.store.listReceipts(RELIC_ID, 1)).find((item) => item.kind === 'served')?.identityId).toBe(f.owner.identityId);
  const invalid = await f.post(f.a, `${root}/receipts/opened`, { ...body, identity_signature: 'bad' }, f.owner.cookie);
  expect(invalid.body.code).toBe('invalid_receipt');
  const mismatch = await f.post(f.a, `${root}/receipts/opened`, { ...body, statement: { ...statement, key_commitment: 'd'.repeat(64) } }, f.owner.cookie);
  expect(mismatch.body.receipt_check).toBe('seal');
  const opened = await f.post(f.b, `${root}/receipts/opened`, body, f.owner.cookie);
  expect(opened.status).toBe(201);
  const repeated = await f.post(f.a, `${root}/receipts/opened`, body, f.owner.cookie);
  expect(repeated.status).toBe(200);
  expect(repeated.body.opened_at).toBe(opened.body.opened_at);
});
