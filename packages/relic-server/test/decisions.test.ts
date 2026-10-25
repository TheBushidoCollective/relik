import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type CreationOptionsJSON,
  type DecisionRecord,
  deriveShareProof,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
  type RequestOptionsJSON,
  shareVerifierFor,
} from '@relic/format';
import { createApp, type RelicApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore, normalizeEmail, type Tombstone } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';

const OPERATOR = new Map([['jason', 'operator-secret']]);

function mockTombstone(id: string): Tombstone {
  return {
    id,
    publishIp: '127.0.0.1',
    publishedAt: now,
    publishingClient: 'test',
    rendererClass: 'markdown',
    ciphertextHash: 'hash',
    deletedAt: now,
    operator: 'operator',
    reasonClass: 'abuse',
    reportReference: undefined,
  };
}

let now = Date.parse('2026-10-24T12:00:00.000Z');
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let sentMails: Array<{ email: string; link: string }> = [];

const ORIGIN = 'https://relic.example';

function build(): RelicApp {
  storage = new MemoryStorage();
  store = new MemoryStore();
  sentMails = [];
  return createApp({
    store,
    storage,
    now: () => now,
    operatorTokens: OPERATOR,
    config: { serviceOrigin: ORIGIN },
    mailer: {
      async send(email, link) {
        sentMails.push({ email, link });
      },
    },
  });
}

beforeEach(() => {
  now = Date.parse('2026-10-24T12:00:00.000Z');
  app = build();
});

function req(
  path: string,
  init: RequestInit & { ip?: string | undefined } = {}
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('x-forwarded-for')) {
    headers.set(
      'x-forwarded-for',
      `${init.ip ?? '198.51.100.10'}, 130.211.0.1`
    );
  }
  return new Request(new URL(path, ORIGIN).toString(), {
    ...init,
    headers,
  });
}

async function signIn(email: string, relicId?: string): Promise<string> {
  const startMails = sentMails.length;
  const res = await app.fetch(
    req('/api/auth/request', {
      method: 'POST',
      body: JSON.stringify({ email, relic_id: relicId ?? 'abc' }),
    })
  );
  expect(res.status).toBe(202);
  const link = sentMails[startMails]?.link;
  if (!link) throw new Error('missing link');
  const url = new URL(link);
  const followed = await app.fetch(
    req(url.pathname + url.search, { redirect: 'manual' })
  );
  const cookie = followed.headers.get('set-cookie');
  if (!cookie) throw new Error('missing cookie');
  const session = cookie.split(';')[0];
  if (!session) throw new Error('empty session');
  return session;
}

interface PublishedRelic {
  id: string;
  key: Uint8Array;
  token: string;
  shareProof: string;
  verifier: string;
  bytes: Uint8Array;
}

async function publishRelic(options?: {
  omitShareVerifier?: boolean;
}): Promise<PublishedRelic> {
  const challengeRes = await app.fetch(
    req('/api/challenge', { method: 'POST' })
  );
  const { challenge_nonce } = (await challengeRes.json()) as {
    challenge_nonce: string;
  };

  const id = generateRelicId();
  const key = generateKey();
  const proof = await deriveShareProof(key);
  const shareProof = Buffer.from(proof).toString('base64url');
  const verifier = await shareVerifierFor(proof);

  const grantRes = await app.fetch(
    req('/api/grant', {
      method: 'POST',
      body: JSON.stringify({
        challenge_nonce,
        relic_id: id,
        renderer_class: 'markdown',
        publishing_client: 'relic-mcp/test',
        declared_size_bytes: 12,
        declared_ciphertext_bytes: encryptedSize(12),
        ...(options?.omitShareVerifier ? {} : { share_verifier: verifier }),
      }),
    })
  );
  expect(grantRes.status).toBe(200);
  const grant = (await grantRes.json()) as Record<string, unknown>;

  const bytes = await encryptRelic({
    content: new TextEncoder().encode('version 1 content'),
    filename: 'doc.md',
    mimetype: 'text/markdown',
    key,
  });
  storage.put(id, bytes);

  return {
    id,
    key,
    token: grant['publish_token'] as string,
    shareProof,
    verifier,
    bytes,
  };
}

async function republishRelic(
  relic: PublishedRelic,
  version: number,
  content: string
): Promise<{ version: number; bytes: Uint8Array }> {
  const res = await app.fetch(
    req(`/api/relics/${relic.id}/republish`, {
      method: 'POST',
      body: JSON.stringify({
        publish_token: relic.token,
        renderer_class: 'markdown',
        declared_size_bytes: content.length,
        declared_ciphertext_bytes: encryptedSize(content.length),
        share_verifier: relic.verifier,
      }),
    })
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { version: number };
  expect(body.version).toBe(version);

  const bytes = await encryptRelic({
    content: new TextEncoder().encode(content),
    filename: 'doc.md',
    mimetype: 'text/markdown',
    key: relic.key,
  });
  storage.put(`${relic.id}/v${version}`, bytes);

  return { version, bytes };
}

describe('decisions and passkeys end to end (S2 acceptance)', () => {
  test('complete returns version and a version_digest equal to sha256 of the bytes put; republish returns version', async () => {
    const relic = await publishRelic();
    const expectedDigest = createHash('sha256')
      .update(relic.bytes)
      .digest('hex');

    const completeRes = await app.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST' })
    );
    expect(completeRes.status).toBe(200);
    const completeBody = (await completeRes.json()) as {
      version: number;
      version_digest: string;
    };
    expect(completeBody.version).toBe(1);
    expect(completeBody.version_digest).toBe(expectedDigest);

    // Republish to v2
    const repubRes = await app.fetch(
      req(`/api/relics/${relic.id}/republish`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: relic.token,
          renderer_class: 'markdown',
          declared_size_bytes: 12,
          declared_ciphertext_bytes: encryptedSize(12),
        }),
      })
    );
    expect(repubRes.status).toBe(200);
    const repubBody = (await repubRes.json()) as { version: number };
    expect(repubBody.version).toBe(2);
  });

  test('TOFU: first registration is 201; second without assertion is 409 passkey_assertion_required; with enroll assertion is 201', async () => {
    const cookie = await signIn('user@example.com');
    const auth1 = await fakeAuthenticator({ alg: -7 });

    // 1. Get options for registration (no passkey on file -> mode create)
    const optRes1 = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
      })
    );
    expect(optRes1.status).toBe(200);
    const opt1 = (await optRes1.json()) as {
      mode: string;
      public_key: CreationOptionsJSON;
    };
    expect(opt1.mode).toBe('create');

    const reg1 = await auth1.register(opt1.public_key, ORIGIN);

    // 2. Register first passkey -> 201
    const regRes1 = await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg1 }),
      })
    );
    expect(regRes1.status).toBe(201);
    const regBody1 = (await regRes1.json()) as { passkeys: number };
    expect(regBody1.passkeys).toBe(1);

    // 3. Second registration attempt without assertion:
    // Calling /options with no credential returns mode assert
    const optRes2 = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
      })
    );
    expect(optRes2.status).toBe(200);
    const opt2 = (await optRes2.json()) as {
      mode: string;
      public_key: RequestOptionsJSON;
    };
    expect(opt2.mode).toBe('assert');
    // Trying to directly register without assertedBy returns 409 passkey_assertion_required
    const unassertedChallenge = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32))
    ).toString('base64url');
    await store.putWebauthnChallenge({
      challengeHash: await sha256Hex(unassertedChallenge),
      email: 'user@example.com',
      purpose: 'register',
      expiresAt: Date.now() + 60_000,
    });
    const auth2 = await fakeAuthenticator({ alg: -7 });
    const regUnasserted = await auth2.register(
      {
        challenge: unassertedChallenge,
        rp: { id: 'relic.example', name: 'Relic' },
        user: {
          id: 'u',
          name: 'user@example.com',
          displayName: 'user@example.com',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
      ORIGIN
    );
    const unassertedRes = await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: regUnasserted }),
      })
    );
    expect(unassertedRes.status).toBe(409);
    expect(((await unassertedRes.json()) as { code: string }).code).toBe(
      'passkey_assertion_required'
    );
    // If we call options with credential from auth1:
    const assertEnroll = await auth1.assert(opt2.public_key, ORIGIN);
    const optRes3 = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: assertEnroll }),
      })
    );
    expect(optRes3.status).toBe(200);
    const opt3 = (await optRes3.json()) as {
      mode: string;
      public_key: CreationOptionsJSON;
    };
    expect(opt3.mode).toBe('create');

    const reg2 = await auth2.register(opt3.public_key, ORIGIN);

    const regRes2 = await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg2 }),
      })
    );
    const regBody2 = (await regRes2.json()) as {
      passkeys?: number;
      code?: string;
      passkey_check?: string;
    };
    expect(regRes2.status).toBe(201);
    expect(regBody2.passkeys).toBe(2);
  });

  test('Approve on v3 is 201: author is normalized and digest equals complete', async () => {
    const relic = await publishRelic();
    await republishRelic(relic, 2, 'content v2');
    await republishRelic(relic, 3, 'content v3');

    const compRes = await app.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST' })
    );
    expect(compRes.status).toBe(200);
    const { version_digest: v3Digest } = (await compRes.json()) as {
      version_digest: string;
    };

    // User signs in with mixed case email
    const cookie = await signIn('Reader@Example.COM', relic.id);
    const auth = await fakeAuthenticator({ alg: -7 });

    // Register passkey
    const optRes = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
      })
    );
    const { public_key: createOpts } = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(createOpts, ORIGIN);
    const regRes = await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );
    expect(regRes.status).toBe(201);

    // Decision options on v3
    const decOptRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 3,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(decOptRes.status).toBe(200);
    const decOpt = (await decOptRes.json()) as {
      version: number;
      version_digest: string;
      public_key: RequestOptionsJSON;
    };
    expect(decOpt.version).toBe(3);
    expect(decOpt.version_digest).toBe(v3Digest);

    // Assert decision
    const assertion = await auth.assert(decOpt.public_key, ORIGIN);

    // Record decision
    const decRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 3,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: v3Digest,
          credential: assertion,
        }),
      })
    );
    expect(decRes.status).toBe(201);
    const decBody = (await decRes.json()) as {
      relic_id: string;
      id: string;
      version: number;
      verdict: string;
      author: string;
      version_digest: string;
    };
    expect(decBody.relic_id).toBe(relic.id);
    expect(decBody.version).toBe(3);
    expect(decBody.verdict).toBe('approve');
    expect(decBody.author).toBe('reader@example.com');
    expect(decBody.version_digest).toBe(v3Digest);
  });

  test('body with only publish_token and body with publish_token plus valid fields are both 403 decision_requires_reader', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);

    // Only publish_token
    const res1 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        body: JSON.stringify({ publish_token: relic.token }),
      })
    );
    expect(res1.status).toBe(403);
    const body1 = (await res1.json()) as { code: string };
    expect(body1.code).toBe('decision_requires_reader');

    // publish_token plus everything valid
    const res2 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          publish_token: relic.token,
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(res2.status).toBe(403);
    const body2 = (await res2.json()) as { code: string };
    expect(body2.code).toBe('decision_requires_reader');
  });

  test('no cookie is 401 sign_in_required; wrong proof is 403 invalid_share_proof; wrong version_digest is 409', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);

    // 1. No cookie -> 401 sign_in_required
    const res1 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(res1.status).toBe(401);
    expect(((await res1.json()) as { code: string }).code).toBe(
      'sign_in_required'
    );

    // 2. Wrong proof -> 403 invalid_share_proof
    const badProof = Buffer.from(new Uint8Array(32).fill(99)).toString(
      'base64url'
    );
    const res2 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: badProof,
        }),
      })
    );
    expect(res2.status).toBe(403);
    expect(((await res2.json()) as { code: string }).code).toBe(
      'invalid_share_proof'
    );

    // 3. Register passkey so we can test decisions route
    const auth = await fakeAuthenticator({ alg: -7 });
    const optRes = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );

    // Get decision options
    const decOptRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const decOpt = (await decOptRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion = await auth.assert(decOpt.public_key, ORIGIN);

    // Send with wrong version_digest (64 hex characters but wrong)
    const wrongDigest = '0'.repeat(64);
    const res3 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: wrongDigest,
          credential: assertion,
        }),
      })
    );
    expect(res3.status).toBe(409);
    expect(((await res3.json()) as { code: string }).code).toBe(
      'decision_digest_mismatch'
    );
  });

  test('replayed assertion is 403 challenge; challenge issued for approve and used for reject is 403; UV-off is 403 user_verified', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);

    const compRes = await app.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST' })
    );
    const { version_digest: vDigest } = (await compRes.json()) as {
      version_digest: string;
    };

    const auth = await fakeAuthenticator({ alg: -7 });
    const optRes = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );

    // Case A: Challenge issued for approve and used for reject -> 403 challenge
    const optResA = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const optA = (await optResA.json()) as { public_key: RequestOptionsJSON };
    const assertionA = await auth.assert(optA.public_key, ORIGIN);

    const resA = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'reject', // Mismatched verdict
          share_proof: relic.shareProof,
          version_digest: vDigest,
          credential: assertionA,
        }),
      })
    );
    expect(resA.status).toBe(403);
    const errA = (await resA.json()) as {
      code: string;
      passkey_check?: string;
    };
    expect(errA.code).toBe('passkey_verification_failed');
    expect(errA.passkey_check).toBe('challenge');

    // Case B: Replayed assertion
    // Issue challenge for approve, assert and post successfully
    const optResB = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const optB = (await optResB.json()) as { public_key: RequestOptionsJSON };
    const assertionB = await auth.assert(optB.public_key, ORIGIN);

    const firstPost = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: vDigest,
          credential: assertionB,
        }),
      })
    );
    expect(firstPost.status).toBe(201);

    // Replay same assertionB
    const replayPost = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: vDigest,
          credential: assertionB,
        }),
      })
    );
    expect(replayPost.status).toBe(403);
    const replayErr = (await replayPost.json()) as {
      code: string;
      passkey_check?: string;
    };
    expect(replayErr.code).toBe('passkey_verification_failed');
    expect(replayErr.passkey_check).toBe('challenge');

    // Case C: UV-off authenticator -> 403 user_verified
    const optResC = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const optC = (await optResC.json()) as { public_key: RequestOptionsJSON };
    // Fake authenticator with userVerified: false
    const authNoUV = await fakeAuthenticator({
      alg: -7,
      credentialId: auth.credentialId,
      userVerified: false,
    });
    const assertionNoUV = await authNoUV.assert(optC.public_key, ORIGIN);

    const uvRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: vDigest,
          credential: assertionNoUV,
        }),
      })
    );
    expect(uvRes.status).toBe(403);
    const uvErr = (await uvRes.json()) as {
      code: string;
      passkey_check?: string;
    };
    expect(uvErr.code).toBe('passkey_verification_failed');
    expect(uvErr.passkey_check).toBe('user_verified');
  });

  test('Republish to v4: listing v4 gives [], and v3 keeps its record; reject after approve leaves 2 records', async () => {
    const relic = await publishRelic();
    await republishRelic(relic, 2, 'content v2');
    await republishRelic(relic, 3, 'content v3');

    const cookie = await signIn('reader@example.com', relic.id);
    const auth = await fakeAuthenticator({ alg: -7 });
    const optRes = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );

    const compRes = await app.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST' })
    );
    const { version_digest: v3Digest } = (await compRes.json()) as {
      version_digest: string;
    };

    // Record decision 1 on v3: approve
    const opt1 = (
      await (
        await app.fetch(
          req(`/api/relics/${relic.id}/decisions/options`, {
            method: 'POST',
            headers: { cookie },
            body: JSON.stringify({
              version: 3,
              verdict: 'approve',
              share_proof: relic.shareProof,
            }),
          })
        )
      ).json()
    ).public_key;
    const assert1 = await auth.assert(opt1, ORIGIN);
    const decRes1 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 3,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: v3Digest,
          credential: assert1,
        }),
      })
    );
    expect(decRes1.status).toBe(201);
    now += 1000;

    // Record decision 2 on v3: reject (reject after approve)
    const opt2 = (
      await (
        await app.fetch(
          req(`/api/relics/${relic.id}/decisions/options`, {
            method: 'POST',
            headers: { cookie },
            body: JSON.stringify({
              version: 3,
              verdict: 'reject',
              share_proof: relic.shareProof,
            }),
          })
        )
      ).json()
    ).public_key;
    const assert2 = await auth.assert(opt2, ORIGIN);
    const decRes2 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 3,
          verdict: 'reject',
          share_proof: relic.shareProof,
          version_digest: v3Digest,
          credential: assert2,
        }),
      })
    );
    expect(decRes2.status).toBe(201);

    // Listing v3 has 2 records
    const listV3 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/list`, {
        method: 'POST',
        body: JSON.stringify({
          version: 3,
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(listV3.status).toBe(200);
    const listV3Body = (await listV3.json()) as { decisions: DecisionRecord[] };
    expect(listV3Body.decisions.length).toBe(2);
    expect(listV3Body.decisions.map((d) => d.verdict)).toEqual([
      'approve',
      'reject',
    ]);

    // Republish to v4
    await republishRelic(relic, 4, 'content v4');

    // Listing v4 gives []
    const listV4 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/list`, {
        method: 'POST',
        body: JSON.stringify({
          version: 4,
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(listV4.status).toBe(200);
    const listV4Body = (await listV4.json()) as { decisions: DecisionRecord[] };
    expect(listV4Body.decisions).toEqual([]);

    // v3 still keeps its 2 records
    const listV3Again = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/list`, {
        method: 'POST',
        body: JSON.stringify({
          version: 3,
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(listV3Again.status).toBe(200);
    expect(
      ((await listV3Again.json()) as { decisions: DecisionRecord[] }).decisions
        .length
    ).toBe(2);
  });

  test('posting comments creates no decisions', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);

    // Post a comment
    const commentRes = await app.fetch(
      req(`/api/relics/${relic.id}/comments`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudA' }),
      })
    );
    expect(commentRes.status).toBe(201);

    // List decisions: should be empty
    const listRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/list`, {
        method: 'POST',
        body: JSON.stringify({ share_proof: relic.shareProof }),
      })
    );
    expect(listRes.status).toBe(200);
    expect(
      ((await listRes.json()) as { decisions: unknown[] }).decisions
    ).toEqual([]);
  });

  test('with shareVerifier absent, options, record, and list all give 409 decision_unavailable', async () => {
    const relic = await publishRelic({ omitShareVerifier: true });
    const cookie = await signIn('reader@example.com', relic.id);

    // Options gives 409 decision_unavailable
    const optRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(optRes.status).toBe(409);
    expect(((await optRes.json()) as { code: string }).code).toBe(
      'decision_unavailable'
    );

    // Record gives 409 decision_unavailable
    const decRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: '0'.repeat(64),
          credential: {},
        }),
      })
    );
    expect(decRes.status).toBe(409);
    expect(((await decRes.json()) as { code: string }).code).toBe(
      'decision_unavailable'
    );

    // List gives 409 decision_unavailable
    const listRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/list`, {
        method: 'POST',
        body: JSON.stringify({ share_proof: relic.shareProof }),
      })
    );
    expect(listRes.status).toBe(409);
    expect(((await listRes.json()) as { code: string }).code).toBe(
      'decision_unavailable'
    );
  });

  test('operator delete reports decisions_deleted and list then gives 410', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);
    const auth = await fakeAuthenticator({ alg: -7 });

    const optRes = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );

    const compRes = await app.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST' })
    );
    const { version_digest: vDigest } = (await compRes.json()) as {
      version_digest: string;
    };

    const decOpt = (
      await (
        await app.fetch(
          req(`/api/relics/${relic.id}/decisions/options`, {
            method: 'POST',
            headers: { cookie },
            body: JSON.stringify({
              version: 1,
              verdict: 'approve',
              share_proof: relic.shareProof,
            }),
          })
        )
      ).json()
    ).public_key;
    const assertion = await auth.assert(decOpt, ORIGIN);
    await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: vDigest,
          credential: assertion,
        }),
      })
    );

    // Operator delete
    const delRes = await app.fetch(
      req(`/api/relics/${relic.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { decisions_deleted: number };
    expect(delBody.decisions_deleted).toBe(1);

    // List now gives 410 relic_removed
    const listRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/list`, {
        method: 'POST',
        body: JSON.stringify({ share_proof: relic.shareProof }),
      })
    );
    expect(listRes.status).toBe(410);
    expect(((await listRes.json()) as { code: string }).code).toBe(
      'relic_removed'
    );
  });

  test('legacy version without a digest gets one computed once (storage.digest called once across two decisions)', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);
    const auth = await fakeAuthenticator({ alg: -7 });

    const optRes = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );

    // Count storage.digest calls
    let digestCalls = 0;
    const origDigest = storage.digest.bind(storage);
    storage.digest = async (id: string) => {
      digestCalls++;
      return origDigest(id);
    };

    // First decision: options
    const optRes1 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(optRes1.status).toBe(200);
    expect(digestCalls).toBe(1);
    const opt1 = (await optRes1.json()) as {
      version_digest: string;
      public_key: RequestOptionsJSON;
    };

    // Record decision 1
    const assert1 = await auth.assert(opt1.public_key, ORIGIN);
    const decRes1 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
          version_digest: opt1.version_digest,
          credential: assert1,
        }),
      })
    );
    expect(decRes1.status).toBe(201);
    // storage.digest was not called again because recordVersionDigest cached it!
    expect(digestCalls).toBe(1);

    // Second decision: options
    const optRes2 = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'reject',
          share_proof: relic.shareProof,
        }),
      })
    );
    expect(optRes2.status).toBe(200);
    // Still 1!
    expect(digestCalls).toBe(1);
  });

  test('chunked body exceeding 65,536 bytes is aborted and rejected with invalid_decision', async () => {
    const relic = await publishRelic();
    const largeChunk = new Uint8Array(40_000);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(largeChunk);
        controller.enqueue(largeChunk); // 80,000 bytes > 65,536
        controller.close();
      },
    });

    const res = await app.fetch(
      new Request(
        `https://relic.example/api/relics/${relic.id}/decisions/list`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stream,
          duplex: 'half',
        } as RequestInit
      )
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_decision');
  });

  test('streamed body exceeding 65,536 bytes with <= 65,536 characters is rejected with 400', async () => {
    const relic = await publishRelic();
    // 30,000 euro signs = ~30,050 characters, but ~90,050 UTF-8 bytes
    const jsonText = JSON.stringify({
      share_proof: relic.shareProof,
      pad: '€'.repeat(30_000),
    });
    const bytes = new TextEncoder().encode(jsonText);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const res = await app.fetch(
      new Request(
        `https://relic.example/api/relics/${relic.id}/decisions/list`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stream,
          duplex: 'half',
        } as RequestInit
      )
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_decision');
  });

  test('body with invalid UTF-8 bytes is rejected with malformed code', async () => {
    const relic = await publishRelic();
    const invalidUtf8 = new Uint8Array([0xff, 0xff, 0xff]);
    const res = await app.fetch(
      new Request(
        `https://relic.example/api/relics/${relic.id}/decisions/list`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: invalidUtf8,
        }
      )
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_decision');
  });

  test('complete endpoint is rate limited per IP using publishRateLimit', async () => {
    const limitedApp = createApp({
      storage,
      store,
      now: () => now,
      config: {
        serviceOrigin: ORIGIN,
        publishRateLimit: { limit: 2, windowSeconds: 60 },
      },
    });
    const relic = await publishRelic();
    const ip = '198.51.100.42';
    const r1 = await limitedApp.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST', ip })
    );
    expect(r1.status).toBe(200);

    const r2 = await limitedApp.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST', ip })
    );
    expect(r2.status).toBe(200);

    const r3 = await limitedApp.fetch(
      req(`/api/relics/${relic.id}/complete`, { method: 'POST', ip })
    );
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as {
      code: string;
      retry_after_seconds: number;
    };
    expect(body.code).toBe('publish_rate_limited');
    expect(typeof body.retry_after_seconds).toBe('number');
  });

  test('concurrent complete calls single-flight digest computation', async () => {
    const relic = await publishRelic();
    let digestInvocations = 0;
    const origDigest = storage.digest.bind(storage);
    const { promise: unblock, resolve } = Promise.withResolvers<void>();
    storage.digest = async (id: string) => {
      digestInvocations++;
      await unblock;
      return origDigest(id);
    };

    try {
      const calls = Array.from({ length: 5 }, () =>
        app.fetch(req(`/api/relics/${relic.id}/complete`, { method: 'POST' }))
      );
      // Yield microtasks so all calls reach singleFlightDigest before resolving
      await Promise.resolve();
      await Promise.resolve();
      resolve();
      const responses = await Promise.all(calls);
      for (const res of responses) {
        expect(res.status).toBe(200);
        const json = (await res.json()) as { version_digest: string };
        expect(typeof json.version_digest).toBe('string');
      }
      expect(digestInvocations).toBe(1);
    } finally {
      storage.digest = origDigest;
    }
  });

  test('digest mismatch throws in MemoryStorage and does not record version digest', async () => {
    const relic = await publishRelic();
    // Mutate stat length so it differs from storage bytes
    const origStat = storage.stat.bind(storage);
    storage.stat = async (id: string) => {
      const real = await origStat(id);
      if (real === undefined) return undefined;
      return { ...real, length: real.length + 10 };
    };

    try {
      await expect(storage.digest(relic.id)).rejects.toThrow(/mismatch/);

      // In complete, digest computation failure leaves version_digest null
      const compRes = await app.fetch(
        req(`/api/relics/${relic.id}/complete`, { method: 'POST' })
      );
      expect(compRes.status).toBe(200);
      const compBody = (await compRes.json()) as {
        version_digest: string | null;
      };
      expect(compBody.version_digest).toBeNull();

      const row = await store.getRelic(relic.id);
      expect(row?.versionDigests?.['1']).toBeUndefined();
    } finally {
      storage.stat = origStat;
    }
  });

  test('tombstone appearing immediately before appendDecision refuses with relic_removed and writes nothing', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);
    const auth = await fakeAuthenticator({ alg: -7 });
    const optResReg = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optResReg.json()) as {
      public_key: CreationOptionsJSON;
    };
    const regCred = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: regCred }),
      })
    );

    const optRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const optBody = (await optRes.json()) as {
      public_key: RequestOptionsJSON;
      version_digest: string;
    };
    const assertion = await auth.assert(optBody.public_key, ORIGIN);

    const origGetTombstone = store.getTombstone.bind(store);
    let calls = 0;
    store.getTombstone = async (id: string) => {
      calls++;
      if (calls >= 2) {
        return mockTombstone(id);
      }
      return origGetTombstone(id);
    };

    try {
      const decRes = await app.fetch(
        req(`/api/relics/${relic.id}/decisions`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            version: 1,
            verdict: 'approve',
            share_proof: relic.shareProof,
            version_digest: optBody.version_digest,
            credential: assertion,
          }),
        })
      );
      expect(decRes.status).toBe(410);
      const decBody = (await decRes.json()) as { code: string };
      expect(decBody.code).toBe('relic_removed');

      const decisions = await store.listDecisions(relic.id);
      expect(decisions).toEqual([]);
    } finally {
      store.getTombstone = origGetTombstone;
    }
  });

  test('tombstone appearing immediately after appendDecision deletes the just-written row and refuses with relic_removed', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);
    const auth = await fakeAuthenticator({ alg: -7 });
    const optResReg = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optResReg.json()) as {
      public_key: CreationOptionsJSON;
    };
    const regCred = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: regCred }),
      })
    );

    const optRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const optBody = (await optRes.json()) as {
      public_key: RequestOptionsJSON;
      version_digest: string;
    };
    const assertion = await auth.assert(optBody.public_key, ORIGIN);

    const origGetTombstone = store.getTombstone.bind(store);
    let calls = 0;
    store.getTombstone = async (id: string) => {
      calls++;
      if (calls >= 3) {
        return mockTombstone(id);
      }
      return origGetTombstone(id);
    };

    try {
      const decRes = await app.fetch(
        req(`/api/relics/${relic.id}/decisions`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            version: 1,
            verdict: 'approve',
            share_proof: relic.shareProof,
            version_digest: optBody.version_digest,
            credential: assertion,
          }),
        })
      );
      expect(decRes.status).toBe(410);
      const decBody = (await decRes.json()) as { code: string };
      expect(decBody.code).toBe('relic_removed');

      const decisions = await store.listDecisions(relic.id);
      expect(decisions).toEqual([]);
    } finally {
      store.getTombstone = origGetTombstone;
    }
  });

  test('concurrent assertion swap race: second assertion with equal counter is rejected by swap callback', async () => {
    const relic = await publishRelic();
    const cookie = await signIn('reader@example.com', relic.id);
    const auth = await fakeAuthenticator({ alg: -7, signCount: 0 });
    const optResReg = await app.fetch(
      req('/api/auth/passkeys/options', { method: 'POST', headers: { cookie } })
    );
    const { public_key: createOpts } = (await optResReg.json()) as {
      public_key: CreationOptionsJSON;
    };
    const regCred = await auth.register(createOpts, ORIGIN);
    await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: regCred }),
      })
    );

    const optRes = await app.fetch(
      req(`/api/relics/${relic.id}/decisions/options`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          version: 1,
          verdict: 'approve',
          share_proof: relic.shareProof,
        }),
      })
    );
    const optBody = (await optRes.json()) as {
      public_key: RequestOptionsJSON;
      version_digest: string;
    };

    // Authenticator asserts with counter = 5
    auth.setSignCount(4); // 4 + 1 = 5
    const assertion = await auth.assert(optBody.public_key, ORIGIN);

    // Simulate another request having won the race and updated the stored counter to 5
    // before postDecision enters updatePasskeys:
    const origUpdatePasskeys = store.updatePasskeys.bind(store);
    let raced = false;
    store.updatePasskeys = async (email, change) => {
      if (!raced) {
        raced = true;
        // The concurrent winner set signCount to 5
        await origUpdatePasskeys(email, (curr) => ({
          ...curr,
          credentials: curr.credentials.map((c) => ({ ...c, signCount: 5 })),
        }));
      }
      return origUpdatePasskeys(email, change);
    };

    try {
      const decRes = await app.fetch(
        req(`/api/relics/${relic.id}/decisions`, {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({
            version: 1,
            verdict: 'approve',
            share_proof: relic.shareProof,
            version_digest: optBody.version_digest,
            credential: assertion,
          }),
        })
      );
      expect(decRes.status).toBe(403);
      const decBody = (await decRes.json()) as {
        code: string;
        passkey_check: string;
      };
      expect(decBody.code).toBe('passkey_verification_failed');
      expect(decBody.passkey_check).toBe('counter');
    } finally {
      store.updatePasskeys = origUpdatePasskeys;
    }
  });

  test('normalizeEmail lowercases ASCII characters and preserves non-ASCII characters without Unicode folding', () => {
    expect(normalizeEmail('  USER@EXAMPLE.COM  ')).toBe('user@example.com');
    expect(normalizeEmail('İ@EXAMPLE.COM')).toBe('İ@example.com');
    expect(normalizeEmail('MÜLLER@EXAMPLE.COM')).toBe('mÜller@example.com');
  });
});
