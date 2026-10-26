import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type AuthenticationResponseJSON,
  type CreationOptionsJSON,
  deriveShareProof,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
  type RegistrationResponseJSON,
  type RequestOptionsJSON,
} from '@relic/format';
import { createApp, type RelicApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { fakeAuthenticator } from './fake-authenticator.ts';

const OPERATOR = new Map([['jason', 'operator-secret']]);
const ORIGIN = 'https://relic.example';

let now = Date.parse('2026-10-25T12:00:00.000Z');
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let sentMails: Array<{ email: string; link: string }> = [];

interface AuthenticatorHandle {
  register(
    o: CreationOptionsJSON,
    origin: string
  ): Promise<RegistrationResponseJSON>;
  assert(
    o: RequestOptionsJSON,
    origin: string,
    userHandleOverride?: string | null
  ): Promise<AuthenticationResponseJSON>;
  setSignCount(n: number): void;
  readonly credentialId: string;
}

function build(overrides: Parameters<typeof createApp>[0] = {}): RelicApp {
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
    ...overrides,
  });
}

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.method === 'POST') {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers,
  });
}

async function publishRelic(relicApp: RelicApp = app): Promise<string> {
  const challengeRes = await relicApp.fetch(
    req('/api/challenge', { method: 'POST' })
  );
  const { challenge_nonce } = (await challengeRes.json()) as {
    challenge_nonce: string;
  };

  const id = generateRelicId();
  const key = generateKey();
  const grantRes = await relicApp.fetch(
    req('/api/grant', {
      method: 'POST',
      body: JSON.stringify({
        relic_id: id,
        renderer_class: 'markdown',
        declared_size_bytes: 12,
        declared_ciphertext_bytes: encryptedSize(12),
        challenge_nonce,
        publishing_client: 'relic-mcp/0.1.0 (test)',
      }),
    })
  );
  expect(grantRes.status).toBe(200);
  const { publish_token } = (await grantRes.json()) as {
    publish_token: string;
  };

  const container = await encryptRelic({
    content: new TextEncoder().encode('hello relic'),
    filename: 'test.md',
    mimetype: 'text/markdown',
    key,
  });
  storage.put(id, container);

  await relicApp.fetch(
    req(`/api/relics/${id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${publish_token}` },
    })
  );
  return id;
}

async function signInViaLink(
  email: string,
  relicApp: RelicApp = app
): Promise<{ cookie: string; rawCookie: string; returnTo: string }> {
  await relicApp.fetch(
    req('/api/auth/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
  );
  const sent = sentMails.find((m) => m.email === email);
  if (!sent) throw new Error(`No auth link sent for ${email}`);

  const url = new URL(sent.link);
  const res = await relicApp.fetch(
    req(url.pathname + url.search, { redirect: 'manual' })
  );
  expect(res.status).toBe(303);

  const cookies = res.headers.getSetCookie();
  const rawCookie = cookies.find((c) => c.startsWith('relic_session=')) ?? '';
  const cookie = rawCookie.split(';')[0] ?? '';
  const returnTo = res.headers.get('location') ?? '';
  return { cookie, rawCookie, returnTo };
}

async function registerPasskey(
  sessionCookie: string,
  authenticator: AuthenticatorHandle,
  relicApp: RelicApp = app
): Promise<{ credentialId: string; userHandle: string }> {
  const optionsRes = await relicApp.fetch(
    req('/api/auth/passkeys/options', {
      method: 'POST',
      headers: { cookie: sessionCookie },
      body: '{}',
    })
  );
  expect(optionsRes.status).toBe(200);
  const options = (await optionsRes.json()) as {
    mode: string;
    public_key: CreationOptionsJSON;
  };
  expect(options.mode).toBe('create');

  const regResponse = await authenticator.register(options.public_key, ORIGIN);
  const regRes = await relicApp.fetch(
    req('/api/auth/passkeys', {
      method: 'POST',
      headers: { cookie: sessionCookie },
      body: JSON.stringify({ credential: regResponse }),
    })
  );
  expect(regRes.status).toBe(201);
  return {
    credentialId: authenticator.credentialId,
    userHandle: options.public_key.user.id,
  };
}

beforeEach(() => {
  now = Date.parse('2026-10-25T12:00:00.000Z');
  app = build();
});

describe('S1 Server passkey sign-in', () => {
  test('1. A passkey added after a link sign-in signs the reader in with zero mail, and the cookie comments as them', async () => {
    const relicId = await publishRelic();
    const { cookie: linkCookie } = await signInViaLink('reader@example.com');
    const auth = await fakeAuthenticator();
    const { userHandle } = await registerPasskey(linkCookie, auth);

    sentMails = [];

    // Get usernameless options
    const optionsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    expect(optionsRes.status).toBe(200);
    const { public_key } = (await optionsRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    expect(public_key.allowCredentials).toEqual([]);

    // Assert passkey
    const assertion = await auth.assert(public_key, ORIGIN, userHandle);

    // Sign in with passkey
    const signInRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(signInRes.status).toBe(200);
    expect(await signInRes.json()).toEqual({ email: 'reader@example.com' });
    expect(sentMails.length).toBe(0);

    const cookies = signInRes.headers.getSetCookie();
    const sessionHeader =
      cookies.find((c) => c.startsWith('relic_session=')) ?? '';
    const passkeySessionCookie = sessionHeader.split(';')[0] ?? '';
    expect(passkeySessionCookie).toMatch(/^relic_session=[A-Za-z0-9_-]+/);

    // Comment using the passkey session cookie
    const commentRes = await app.fetch(
      req(`/api/relics/${relicId}/comments`, {
        method: 'POST',
        headers: { cookie: passkeySessionCookie },
        body: JSON.stringify({ ciphertext: 'YWJjZA' }),
      })
    );
    expect(commentRes.status).toBe(201);
    const commentBody = (await commentRes.json()) as {
      author: string;
      comment_id: string;
    };
    expect(commentBody.author).toBe('reader@example.com');
  });

  test("2. The session row and cookie match the callback's, and the verified identity is recorded", async () => {
    const auth = await fakeAuthenticator();
    const { rawCookie: callbackCookie } =
      await signInViaLink('bob@example.com');
    const { userHandle } = await registerPasskey(
      callbackCookie.split(';')[0] ?? '',
      auth
    );

    // Sign in via passkey
    const optionsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    const { public_key } = (await optionsRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion = await auth.assert(public_key, ORIGIN, userHandle);
    const signInRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(signInRes.status).toBe(200);

    const passkeyCookie =
      signInRes.headers
        .getSetCookie()
        .find((c) => c.startsWith('relic_session=')) ?? '';

    // Check cookie attributes
    const parseCookieAttrs = (cookieStr: string) => {
      const parts = cookieStr.split(';').map((s) => s.trim());
      const hasHttpOnly = parts.includes('HttpOnly');
      const hasSecure = parts.includes('Secure');
      const sameSite = parts
        .find((p) => p.startsWith('SameSite='))
        ?.split('=')[1];
      const path = parts.find((p) => p.startsWith('Path='))?.split('=')[1];
      const maxAge = parts.find((p) => p.startsWith('Max-Age='))?.split('=')[1];
      return { hasHttpOnly, hasSecure, sameSite, path, maxAge };
    };

    expect(parseCookieAttrs(passkeyCookie)).toEqual(
      parseCookieAttrs(callbackCookie)
    );

    // Check session row in store
    const token = (passkeyCookie.split(';')[0] ?? '').replace(
      'relic_session=',
      ''
    );
    const tokenHash = await sha256Hex(token);
    const sessionRow = await store.getSession(tokenHash);
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.email).toBe('bob@example.com');
    expect(sessionRow?.createdAt).toBe(now);
    expect(sessionRow?.expiresAt).toBe(now + 30 * 24 * 3600 * 1000);

    // Check verified identity
    expect(await store.hasVerifiedIdentity('bob@example.com')).toBe(true);
  });

  test('3. Usernameless options carry no address. Email-first known and unknown responses match in status, keys, count, order and stability, with the real id present only for the known address', async () => {
    const auth = await fakeAuthenticator();
    const { cookie } = await signInViaLink('known@example.com');
    await registerPasskey(cookie, auth);

    // Usernameless carries no allowCredentials (empty array)
    const unameRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    const unameData = (await unameRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    expect(unameData.public_key.allowCredentials).toEqual([]);

    // Email-first: known vs unknown
    const knownRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'known@example.com' }),
      })
    );
    const unknownRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'unknown@example.com' }),
      })
    );

    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);

    const knownData = (await knownRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const unknownData = (await unknownRes.json()) as {
      public_key: RequestOptionsJSON;
    };

    // Keys match
    expect(Object.keys(knownData.public_key).sort()).toEqual(
      Object.keys(unknownData.public_key).sort()
    );

    // Counts match (4 entries per config.passkeySignInAllowListSize)
    const knownCreds = knownData.public_key.allowCredentials ?? [];
    const unknownCreds = unknownData.public_key.allowCredentials ?? [];
    expect(knownCreds).toHaveLength(4);
    expect(unknownCreds).toHaveLength(4);

    // Both sorted by id
    const knownIds = knownCreds.map((c) => c.id);
    const unknownIds = unknownCreds.map((c) => c.id);
    expect(knownIds).toEqual([...knownIds].sort((a, b) => a.localeCompare(b)));
    expect(unknownIds).toEqual(
      [...unknownIds].sort((a, b) => a.localeCompare(b))
    );

    // Stability: calling options again for unknown gives same decoy IDs in same order
    const unknownRes2 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'unknown@example.com' }),
      })
    );
    const unknownData2 = (await unknownRes2.json()) as {
      public_key: RequestOptionsJSON;
    };
    const unknownIds2 = (unknownData2.public_key.allowCredentials ?? []).map(
      (c) => c.id
    );
    expect(unknownIds2).toEqual(unknownIds);

    // Real id is present only for known address
    expect(knownIds).toContain(auth.credentialId);
    expect(unknownIds).not.toContain(auth.credentialId);
  });

  test('4. A table of failures all give an identical 401 with no extension and no cookie: replay, expiry, decide/enroll/register challenges, unknown handle, null handle, handle naming another record, credential not on record, bad signature, UV off, counter replay', async () => {
    const authA = await fakeAuthenticator({ signCount: 1 });
    const { cookie: cookieA } = await signInViaLink('user-a@example.com');
    const { userHandle: userHandleA } = await registerPasskey(cookieA, authA);

    const authB = await fakeAuthenticator({ signCount: 1 });
    const { cookie: cookieB } = await signInViaLink('user-b@example.com');
    const { userHandle: userHandleB } = await registerPasskey(cookieB, authB);

    const getOptions = async (email?: string): Promise<RequestOptionsJSON> => {
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in/options', {
          method: 'POST',
          body: JSON.stringify(email ? { email } : {}),
        })
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { public_key: RequestOptionsJSON };
      return data.public_key;
    };

    const assertFailure401 = (res: Response, body: Record<string, unknown>) => {
      expect(res.status).toBe(401);
      expect(body.code).toBe('passkey_sign_in_failed');
      expect(body.title).toBe('Passkey sign-in did not work');
      expect(res.headers.get('set-cookie')).toBeNull();

      const standardKeys: Record<string, true> = {
        type: true,
        title: true,
        status: true,
        code: true,
        instance: true,
      };
      const extensionKeys = Object.keys(body).filter((k) => !standardKeys[k]);
      expect(extensionKeys).toEqual([]);
    };

    // 1. Replay
    {
      const opts = await getOptions();
      const cred = await authA.assert(opts, ORIGIN, userHandleA);
      const res1 = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      expect(res1.status).toBe(200);

      // Replay identical credential
      const res2 = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res2, (await res2.json()) as Record<string, unknown>);
    }

    // 2. Expiry
    {
      const opts = await getOptions();
      const cred = await authA.assert(opts, ORIGIN, userHandleA);
      now += 305_000; // challenge TTL is 300s
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
      now -= 305_000;
    }

    // 3. decide challenge
    {
      const relicId = await publishRelic();
      const decOptsRes = await app.fetch(
        req(`/api/relics/${relicId}/decisions/options`, {
          method: 'POST',
          headers: { cookie: cookieA },
          body: JSON.stringify({ verdict: 'approve', version: 1 }),
        })
      );
      expect(decOptsRes.status).toBe(200);
      const { public_key } = (await decOptsRes.json()) as {
        public_key: RequestOptionsJSON;
      };
      const cred = await authA.assert(public_key, ORIGIN, userHandleA);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 4. enroll challenge
    {
      const enrollOptsRes = await app.fetch(
        req('/api/auth/passkeys/options', {
          method: 'POST',
          headers: { cookie: cookieA },
          body: '{}',
        })
      );
      expect(enrollOptsRes.status).toBe(200);
      const { public_key } = (await enrollOptsRes.json()) as {
        public_key: RequestOptionsJSON;
      };
      const cred = await authA.assert(public_key, ORIGIN, userHandleA);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 5. register challenge
    {
      const regChallenge = 'b64url_reg_challenge_32bytes_pad_00';
      const regHash = await sha256Hex(regChallenge);
      await store.putWebauthnChallenge({
        challengeHash: regHash,
        email: 'user-a@example.com',
        purpose: 'register',
        expiresAt: now + 60_000,
      });
      const cred = await authA.assert(
        { challenge: regChallenge, rpId: new URL(ORIGIN).hostname },
        ORIGIN,
        userHandleA
      );
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 6. Unknown handle
    {
      const opts = await getOptions();
      const fakeUnknownHandle = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32))
      ).toString('base64url');
      const cred = await authA.assert(opts, ORIGIN, fakeUnknownHandle);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 7. Null handle
    {
      const opts = await getOptions();
      const cred = await authA.assert(opts, ORIGIN, null);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 8. Handle naming another record
    {
      const opts = await getOptions();
      // authA asserts with user-b's handle
      const cred = await authA.assert(opts, ORIGIN, userHandleB);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 9. Credential not on record
    {
      const opts = await getOptions('user-a@example.com');
      const strangerAuth = await fakeAuthenticator();
      const cred = await strangerAuth.assert(opts, ORIGIN);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 10. Bad signature
    {
      const opts = await getOptions();
      const cred = await authA.assert(opts, ORIGIN, userHandleA);
      // Mutate signature
      const badCred = {
        ...cred,
        response: {
          ...cred.response,
          signature: Buffer.from('corrupted_signature_bytes').toString(
            'base64url'
          ),
        },
      };
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: badCred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 11. UV off
    {
      const opts = await getOptions();
      const uvOffAuth = await fakeAuthenticator({
        credentialId: authA.credentialId,
        userVerified: false,
      });
      const cred = await uvOffAuth.assert(opts, ORIGIN, userHandleA);
      const res = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred }),
        })
      );
      assertFailure401(res, (await res.json()) as Record<string, unknown>);
    }

    // 12. Counter replay (signCount <= stored signCount)
    {
      const opts1 = await getOptions();
      authA.setSignCount(10);
      const cred1 = await authA.assert(opts1, ORIGIN, userHandleA);
      const res1 = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred1 }),
        })
      );
      expect(res1.status).toBe(200);

      // Now counter replay with lower or equal signCount (e.g. 5)
      const opts2 = await getOptions();
      authA.setSignCount(5);
      const cred2 = await authA.assert(opts2, ORIGIN, userHandleA);
      const res2 = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: cred2 }),
        })
      );
      assertFailure401(res2, (await res2.json()) as Record<string, unknown>);
    }
  });

  test("5. A sign_in challenge can't decide or enroll", async () => {
    const auth = await fakeAuthenticator();
    const { cookie } = await signInViaLink('user@example.com');
    const { userHandle } = await registerPasskey(cookie, auth);
    const relicId = await publishRelic();

    // Create sign_in options challenge
    const optsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com' }),
      })
    );
    expect(optsRes.status).toBe(200);
    const { public_key } = (await optsRes.json()) as {
      public_key: RequestOptionsJSON;
    };

    const assertion = await auth.assert(public_key, ORIGIN, userHandle);

    // Try to decide with this sign_in assertion
    const digest = '0'.repeat(64);
    const decRes = await app.fetch(
      req(`/api/relics/${relicId}/decisions`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({
          verdict: 'approve',
          version: 1,
          version_digest: digest,
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
    expect(decBody.passkey_check).toBe('challenge');

    // Create another sign_in challenge
    const optsRes2 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com' }),
      })
    );
    const { public_key: pk2 } = (await optsRes2.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion2 = await auth.assert(pk2, ORIGIN, userHandle);

    // Try to enroll with this sign_in assertion
    const enrollRes = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: assertion2 }),
      })
    );
    expect(enrollRes.status).toBe(403);
    const enrollBody = (await enrollRes.json()) as {
      code: string;
      passkey_check: string;
    };
    expect(enrollBody.code).toBe('passkey_verification_failed');
    expect(enrollBody.passkey_check).toBe('challenge');
  });

  test('6. A passkey session deciding without a credential gets 400 invalid_passkey', async () => {
    const auth = await fakeAuthenticator();
    const { cookie } = await signInViaLink('decider@example.com');
    const { userHandle } = await registerPasskey(cookie, auth);
    const relicId = await publishRelic();

    // Sign in by passkey
    const optsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    const { public_key } = (await optsRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion = await auth.assert(public_key, ORIGIN, userHandle);
    const signInRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    const passkeyCookie =
      signInRes.headers
        .getSetCookie()
        .find((c) => c.startsWith('relic_session='))
        ?.split(';')[0] ?? '';

    // Decide without credential
    const decRes = await app.fetch(
      req(`/api/relics/${relicId}/decisions`, {
        method: 'POST',
        headers: { cookie: passkeyCookie },
        body: JSON.stringify({
          verdict: 'approve',
          version: 1,
          version_digest: '0'.repeat(64),
        }),
      })
    );
    expect(decRes.status).toBe(400);
    const decBody = (await decRes.json()) as {
      code: string;
      passkey_check: string;
    };
    expect(decBody.code).toBe('invalid_passkey');
    expect(decBody.passkey_check).toBe('shape');
  });

  test('7. text/plain gets 400', async () => {
    const optsRes = await app.fetch(
      new Request(`${ORIGIN}/api/auth/passkeys/sign-in/options`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })
    );
    expect(optsRes.status).toBe(400);
    const optsBody = (await optsRes.json()) as {
      code: string;
      passkey_check: string;
    };
    expect(optsBody.code).toBe('invalid_passkey');
    expect(optsBody.passkey_check).toBe('shape');

    const signInRes = await app.fetch(
      new Request(`${ORIGIN}/api/auth/passkeys/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ credential: {} }),
      })
    );
    expect(signInRes.status).toBe(400);
    const signBody = (await signInRes.json()) as {
      code: string;
      passkey_check: string;
    };
    expect(signBody.code).toBe('invalid_passkey');
    expect(signBody.passkey_check).toBe('shape');
  });

  test('8. The limits are independent; TOFU still works once the options budget is spent', async () => {
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        passkeySignInOptionsRateLimit: { limit: 2, windowSeconds: 3600 },
        passkeyRateLimit: { limit: 10, windowSeconds: 3600 },
      },
    });

    // Exhaust options rate limit (2 requests allowed, 3rd blocked)
    const r1 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', { method: 'POST', body: '{}' })
    );
    expect(r1.status).toBe(200);
    const r2 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', { method: 'POST', body: '{}' })
    );
    expect(r2.status).toBe(200);
    const r3 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', { method: 'POST', body: '{}' })
    );
    expect(r3.status).toBe(429);
    expect(((await r3.json()) as { code: string }).code).toBe(
      'passkey_rate_limited'
    );

    // TOFU still works because passkeyRateLimit is independent
    const { cookie } = await signInViaLink('user-tofu@example.com', app);
    const tofuOptions = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(tofuOptions.status).toBe(200);

    const auth = await fakeAuthenticator();
    const opts = (await tofuOptions.json()) as {
      public_key: CreationOptionsJSON;
    };
    const reg = await auth.register(opts.public_key, ORIGIN);
    const regRes = await app.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );
    expect(regRes.status).toBe(201);
  });

  test('9. Both create responses require a resident key', async () => {
    const auth = await fakeAuthenticator();
    const { cookie } = await signInViaLink('rk@example.com');

    // 1. TOFU create response
    const tofuRes = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(tofuRes.status).toBe(200);
    const tofuData = (await tofuRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    expect(tofuData.public_key.authenticatorSelection?.residentKey).toBe(
      'required'
    );
    expect(tofuData.public_key.authenticatorSelection?.requireResidentKey).toBe(
      true
    );
    expect(tofuData.public_key.authenticatorSelection?.userVerification).toBe(
      'required'
    );

    // Complete TOFU registration
    await registerPasskey(cookie, auth);

    // 2. Enroll create response (when user already has credential)
    // Request enroll options with assertion from existing passkey
    const enrollChallengeRes = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(enrollChallengeRes.status).toBe(200);
    const { public_key: enrollPk } = (await enrollChallengeRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const enrollAssertion = await auth.assert(enrollPk, ORIGIN);

    const enrollRes = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: enrollAssertion }),
      })
    );
    expect(enrollRes.status).toBe(200);
    const enrollData = (await enrollRes.json()) as {
      public_key: CreationOptionsJSON;
    };
    expect(enrollData.public_key.authenticatorSelection?.residentKey).toBe(
      'required'
    );
    expect(
      enrollData.public_key.authenticatorSelection?.requireResidentKey
    ).toBe(true);
    expect(enrollData.public_key.authenticatorSelection?.userVerification).toBe(
      'required'
    );
  });

  test('10. A reader signed in as Ada@Example.com signs in by passkey as Ada@Example.com and can PATCH and DELETE their earlier comment', async () => {
    const relicId = await publishRelic();
    const { cookie: initialCookie } = await signInViaLink('Ada@Example.com');

    // Post a comment as Ada@Example.com
    const postRes = await app.fetch(
      req(`/api/relics/${relicId}/comments`, {
        method: 'POST',
        headers: { cookie: initialCookie },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudDE' }),
      })
    );
    expect(postRes.status).toBe(201);
    const { comment_id } = (await postRes.json()) as { comment_id: string };

    // Register passkey for Ada@Example.com
    const auth = await fakeAuthenticator();
    const { userHandle } = await registerPasskey(initialCookie, auth);

    // Sign in later with passkey
    const optsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    const { public_key } = (await optsRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion = await auth.assert(public_key, ORIGIN, userHandle);

    const signInRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(signInRes.status).toBe(200);
    // Preserves original casing
    expect(await signInRes.json()).toEqual({ email: 'Ada@Example.com' });

    const passkeyCookie =
      signInRes.headers
        .getSetCookie()
        .find((c) => c.startsWith('relic_session='))
        ?.split(';')[0] ?? '';

    // PATCH earlier comment using passkey session
    const patchRes = await app.fetch(
      req(`/api/relics/${relicId}/comments/${comment_id}`, {
        method: 'PATCH',
        headers: { cookie: passkeyCookie },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudF9wYXRjaGVk' }),
      })
    );
    expect(patchRes.status).toBe(200);

    // DELETE earlier comment using passkey session
    const deleteRes = await app.fetch(
      req(`/api/relics/${relicId}/comments/${comment_id}`, {
        method: 'DELETE',
        headers: { cookie: passkeyCookie },
        body: JSON.stringify({}),
      })
    );
    expect(deleteRes.status).toBe(204);
  });

  test('11. A non-discoverable assertion (userHandleOverride: null) signs in by email-first', async () => {
    const auth = await fakeAuthenticator();
    const { cookie } = await signInViaLink('nondisc@example.com');
    await registerPasskey(cookie, auth);

    // Email-first options
    const optsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'nondisc@example.com' }),
      })
    );
    expect(optsRes.status).toBe(200);
    const { public_key } = (await optsRes.json()) as {
      public_key: RequestOptionsJSON;
    };

    // Non-discoverable assertion with userHandle: null
    const assertion = await auth.assert(public_key, ORIGIN, null);
    expect(assertion.response.userHandle).toBeNull();

    // Sign in by email-first
    const signInRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(signInRes.status).toBe(200);
    expect(await signInRes.json()).toEqual({ email: 'nondisc@example.com' });
    expect(
      signInRes.headers
        .getSetCookie()
        .some((c) => c.startsWith('relic_session='))
    ).toBe(true);
  });

  test('12. The callback sends the session cookie first and the marker second, the marker not HttpOnly; passkey sign-in sends no marker', async () => {
    const auth = await fakeAuthenticator();
    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'marker-test@example.com' }),
      })
    );
    const sent = sentMails[0];
    if (sent === undefined) throw new Error('No sent mail');
    const url = new URL(sent.link);
    const callbackRes = await app.fetch(
      req(url.pathname + url.search, { redirect: 'manual' })
    );
    expect(callbackRes.status).toBe(303);

    const cbCookies = callbackRes.headers.getSetCookie();
    expect(cbCookies.length).toBe(2);
    expect(cbCookies[0]).toMatch(/^relic_session=/);
    expect(cbCookies[0]).toContain('HttpOnly');
    expect(cbCookies[0]).toContain('Secure');

    expect(cbCookies[1]).toMatch(/^relic_passkey_offer=1/);
    expect(cbCookies[1]).toContain('Secure');
    expect(cbCookies[1]).toContain('SameSite=Lax');
    expect(cbCookies[1]).toContain('Max-Age=600');
    expect(cbCookies[1]).not.toContain('HttpOnly');

    // Now register passkey and test passkey sign-in
    const sessionCookie = cbCookies[0]?.split(';')[0] ?? '';
    const { userHandle } = await registerPasskey(sessionCookie, auth);

    const optsRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    const { public_key } = (await optsRes.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion = await auth.assert(public_key, ORIGIN, userHandle);

    const signInRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(signInRes.status).toBe(200);

    const passkeyCookies = signInRes.headers.getSetCookie();
    expect(passkeyCookies.length).toBe(1);
    expect(passkeyCookies[0]).toMatch(/^relic_session=/);
    expect(
      passkeyCookies.some((c) => c.startsWith('relic_passkey_offer'))
    ).toBe(false);
  });

  test('13. /policy contains the new sentences', async () => {
    const res = await app.fetch(req('/policy'));
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain(
      'A reader who added a passkey can later sign in to the same address with it, and that sends no email.'
    );
    expect(text).toContain(
      "A passkey is registered to a reader's verified address. It confirms decisions, and it can sign that reader in instead of a link."
    );
    expect(text).toContain(
      'A second entry, filed under a hash of the user handle, points to that record, so a passkey can sign you in without your typing the address.'
    );
  });
});
