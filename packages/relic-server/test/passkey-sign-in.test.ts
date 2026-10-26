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
  shareVerifierFor,
} from '@relic/format';
import {
  createApp,
  type Mailer,
  type RelicApp,
  resetPasskeyNoticeWarningForTesting,
} from '../src/app.ts';
import type { OutboundMail } from '../src/mail.ts';
import { sha256Hex } from '../src/gcs.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { assertConfig, DEFAULT_CONFIG } from '../src/config.ts';
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

async function publishRelic(
  relicApp: RelicApp = app
): Promise<{ id: string; shareProof: string }> {
  const challengeRes = await relicApp.fetch(
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
        share_verifier: verifier,
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
  return { id, shareProof };
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
  const sent = sentMails
    .slice()
    .reverse()
    .find((m) => m.email === email);
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
    const { id: relicId } = await publishRelic();
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
    expect(sessionRow?.via).toBe('passkey');

    const callbackToken = (callbackCookie.split(';')[0] ?? '').replace(
      'relic_session=',
      ''
    );
    const callbackSessionRow = await store.getSession(
      await sha256Hex(callbackToken)
    );
    expect(callbackSessionRow?.via).toBe('link');
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
        detail: true,
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
      const { id: relicId, shareProof } = await publishRelic();
      const decOptsRes = await app.fetch(
        req(`/api/relics/${relicId}/decisions/options`, {
          method: 'POST',
          headers: { cookie: cookieA },
          body: JSON.stringify({
            verdict: 'approve',
            version: 1,
            share_proof: shareProof,
          }),
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
    const { id: relicId, shareProof } = await publishRelic();

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
          share_proof: shareProof,
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
    const { id: relicId, shareProof } = await publishRelic();

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
          share_proof: shareProof,
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
    const { id: relicId } = await publishRelic();
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

  test('14. L4: POST /api/auth/passkeys/sign-in/options rejects invalid email syntax with 400 invalid_passkey shape', async () => {
    app = build();

    // non-string email
    const r1 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 12345 }),
      })
    );
    expect(r1.status).toBe(400);
    const b1 = (await r1.json()) as { code: string; passkey_check: string };
    expect(b1.code).toBe('invalid_passkey');
    expect(b1.passkey_check).toBe('shape');

    // fails looksLikeEmail (no @ or domain)
    const r2 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'not-an-email' }),
      })
    );
    expect(r2.status).toBe(400);
    const b2 = (await r2.json()) as { code: string; passkey_check: string };
    expect(b2.code).toBe('invalid_passkey');
    expect(b2.passkey_check).toBe('shape');

    // longer than 320 characters
    const longEmail = `${'a'.repeat(315)}@example.com`;
    expect(longEmail.length).toBeGreaterThan(320);
    const r3 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: longEmail }),
      })
    );
    expect(r3.status).toBe(400);
    const b3 = (await r3.json()) as { code: string; passkey_check: string };
    expect(b3.code).toBe('invalid_passkey');
    expect(b3.passkey_check).toBe('shape');

    // whitespace in email
    const r4 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'user name@example.com' }),
      })
    );
    expect(r4.status).toBe(400);
    const b4 = (await r4.json()) as { code: string; passkey_check: string };
    expect(b4.code).toBe('invalid_passkey');
    expect(b4.passkey_check).toBe('shape');

    // Valid syntax (unknown address) succeeds with 200 and decoys
    const r5 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: 'unknown.valid@example.com' }),
      })
    );
    expect(r5.status).toBe(200);
  });

  test('15. L3: Per-address rate limit bounds email-first options and sign-in by sha256(norm), independent of IP', async () => {
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        passkeySignInOptionsRateLimit: { limit: 100, windowSeconds: 3600 },
        passkeySignInOptionsAddressRateLimit: { limit: 2, windowSeconds: 3600 },
        passkeySignInRateLimit: { limit: 100, windowSeconds: 3600 },
        passkeySignInAddressRateLimit: { limit: 2, windowSeconds: 3600 },
      },
    });

    // Part A: Options per-address limit
    // Request 1 from IP 1.1.1.1
    const opt1 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' },
        body: JSON.stringify({ email: 'target@example.com' }),
      })
    );
    expect(opt1.status).toBe(200);

    // Request 2 from different IP 2.2.2.2 with uppercase (normalizes to same hash)
    const opt2 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        headers: { 'x-forwarded-for': '2.2.2.2, 10.0.0.1' },
        body: JSON.stringify({ email: 'TARGET@example.com' }),
      })
    );
    expect(opt2.status).toBe(200);

    // Request 3 from third IP 3.3.3.3: IP budget is untouched, but address budget is exhausted
    const opt3 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' },
        body: JSON.stringify({ email: 'target@example.com' }),
      })
    );
    expect(opt3.status).toBe(429);
    const optBody3 = (await opt3.json()) as { code: string };
    expect(optBody3.code).toBe('passkey_rate_limited');

    // Different address from IP 3.3.3.3 still works
    const optOther = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' },
        body: JSON.stringify({ email: 'other@example.com' }),
      })
    );
    expect(optOther.status).toBe(200);

    // Part B: Sign-in per-address limit (email-first)
    // Build an app with high options limit and low sign-in limit
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        passkeySignInOptionsAddressRateLimit: {
          limit: 100,
          windowSeconds: 3600,
        },
        passkeySignInAddressRateLimit: { limit: 2, windowSeconds: 3600 },
      },
    });
    const getChal = async (email: string) => {
      const r = await app.fetch(
        req('/api/auth/passkeys/sign-in/options', {
          method: 'POST',
          body: JSON.stringify({ email }),
        })
      );
      const data = (await r.json()) as { public_key: { challenge: string } };
      return data.public_key.challenge;
    };

    const c1 = await getChal('test-signer@example.com');
    const c2 = await getChal('test-signer@example.com');
    const c3 = await getChal('test-signer@example.com');

    // Sign-in attempt 1 from IP 1.1.1.1
    const dummyCred = (challenge: string) => ({
      id: 'cred-1',
      rawId: 'cred-1',
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: 'webauthn.get',
            challenge,
            origin: ORIGIN,
          })
        ).toString('base64url'),
        authenticatorData: Buffer.from([0, 0, 0, 0, 0x05, 0, 0, 0, 0]).toString(
          'base64url'
        ),
        signature: 'dummy-sig',
      },
      type: 'public-key',
    });

    const s1 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' },
        body: JSON.stringify({ credential: dummyCred(c1) }),
      })
    );
    // Fails on assertion or record, not 429
    expect(s1.status).toBe(401);

    // Sign-in attempt 2 from IP 2.2.2.2
    const s2 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': '2.2.2.2, 10.0.0.1' },
        body: JSON.stringify({ credential: dummyCred(c2) }),
      })
    );
    expect(s2.status).toBe(401);

    // Sign-in attempt 3 from IP 3.3.3.3 hits per-address limit -> 429 passkey_rate_limited
    const s3 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' },
        body: JSON.stringify({ credential: dummyCred(c3) }),
      })
    );
    expect(s3.status).toBe(429);
    const sBody3 = (await s3.json()) as { code: string };
    expect(sBody3.code).toBe('passkey_rate_limited');
  });

  test('16. L3: Usernameless sign-in rate limit refusal returns 401 passkey_sign_in_failed to avoid address oracle', async () => {
    const auth = await fakeAuthenticator();
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        passkeySignInHandleRateLimit: { limit: 1, windowSeconds: 3600 },
      },
    });

    const { cookie } = await signInViaLink('user-usernameless@example.com');
    const { userHandle } = await registerPasskey(cookie, auth);

    // Step 1: Normal usernameless sign-in succeeds
    const optRes = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', { method: 'POST', body: '{}' })
    );
    const optData = (await optRes.json()) as { public_key: RequestOptionsJSON };
    const assertion = await auth.assert(optData.public_key, ORIGIN, userHandle);
    const signRes = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(signRes.status).toBe(200);

    // Step 2: Now address rate limit for user-usernameless@example.com is spent (limit is 1).
    // A second usernameless sign-in attempt must return 401 passkey_sign_in_failed (not 429),
    // making it indistinguishable from an unknown userHandle.
    const optRes2 = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', { method: 'POST', body: '{}' })
    );
    const optData2 = (await optRes2.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertion2 = await auth.assert(
      optData2.public_key,
      ORIGIN,
      userHandle
    );
    const signRes2 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertion2 }),
      })
    );
    expect(signRes2.status).toBe(401);
    const body2 = (await signRes2.json()) as { code: string };
    expect(body2.code).toBe('passkey_sign_in_failed');
  });

  test('17. assertConfig validates passkeySignInOptionsAddressRateLimit and passkeySignInAddressRateLimit', () => {
    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeySignInOptionsAddressRateLimit: { limit: 0, windowSeconds: 3600 },
      })
    ).toThrow('passkeySignInOptionsAddressRateLimit');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeySignInOptionsAddressRateLimit: { limit: 10, windowSeconds: -1 },
      })
    ).toThrow('passkeySignInOptionsAddressRateLimit');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeySignInAddressRateLimit: { limit: -5, windowSeconds: 3600 },
      })
    ).toThrow('passkeySignInAddressRateLimit');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeySignInAddressRateLimit: { limit: 10, windowSeconds: 0 },
      })
    ).toThrow('passkeySignInAddressRateLimit');
    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeySignInHandleRateLimit: { limit: -1, windowSeconds: 3600 },
      })
    ).toThrow('passkeySignInHandleRateLimit');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeySignInHandleRateLimit: { limit: 10, windowSeconds: 0 },
      })
    ).toThrow('passkeySignInHandleRateLimit');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        addressLimiterMaxEntries: 0,
      })
    ).toThrow('addressLimiterMaxEntries');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeyNoticeTimeoutMs: -10,
      })
    ).toThrow('passkeyNoticeTimeoutMs');

    // Valid default passes
    expect(() => assertConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  test('18. Window boundary. The window covers the full 900 s exactly', async () => {
    const notices: Array<{ email: string; mail: OutboundMail }> = [];
    const testApp = build({
      mailer: {
        async send(email, link) {
          sentMails.push({ email, link });
        },
        async sendMail(email, mail) {
          notices.push({ email, mail });
        },
      },
    });

    const mintTime = now;
    const { cookie } = await signInViaLink('window@example.com', testApp);

    // At mint + 900_000, options returns 200 with create mode
    now = mintTime + 900_000;
    const resExact = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(resExact.status).toBe(200);
    const dataExact = (await resExact.json()) as { mode: string };
    expect(dataExact.mode).toBe('create');

    // Spy on store.putWebauthnChallenge
    let putChallengeCalled = false;
    const origPutChallenge = store.putWebauthnChallenge.bind(store);
    store.putWebauthnChallenge = async (ch) => {
      putChallengeCalled = true;
      return origPutChallenge(ch);
    };

    // At +900_001, the response is exactly 401 with code passkey_fresh_link_required
    now = mintTime + 900_001;
    const resExpired = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(resExpired.status).toBe(401);
    const bodyExpired = (await resExpired.json()) as Record<string, unknown>;
    expect(bodyExpired.code).toBe('passkey_fresh_link_required');
    expect(bodyExpired.title).toBe(
      'Adding a first passkey needs a fresh sign-in link'
    );
    expect(Object.keys(bodyExpired).sort()).toEqual(
      ['code', 'detail', 'instance', 'status', 'title', 'type'].sort()
    );
    expect(putChallengeCalled).toBe(false);
    expect(notices.length).toBe(0);
  });

  test('19. Passkey session refused', async () => {
    const testApp = build();
    const staleLinkTime = now - 900_001;
    // Seed a stale link session
    const staleToken = 'stale-token';
    await store.putSession({
      tokenHash: await sha256Hex(staleToken),
      email: 'oracle@example.com',
      createdAt: staleLinkTime,
      expiresAt: now + 3600_000,
      via: 'link',
    });

    // Seed a passkey session at now
    const passkeyToken = 'passkey-token';
    await store.putSession({
      tokenHash: await sha256Hex(passkeyToken),
      email: 'oracle@example.com',
      createdAt: now,
      expiresAt: now + 3600_000,
      via: 'passkey',
    });

    const staleRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie: `relic_session=${staleToken}` },
        body: '{}',
      })
    );
    expect(staleRes.status).toBe(401);
    const staleBody = (await staleRes.json()) as Record<string, unknown>;

    const passkeyRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie: `relic_session=${passkeyToken}` },
        body: '{}',
      })
    );
    expect(passkeyRes.status).toBe(401);
    const passkeyBody = (await passkeyRes.json()) as Record<string, unknown>;

    expect(passkeyBody.code).toBe('passkey_fresh_link_required');
    const { instance: _i1, ...staleRest } = staleBody;
    const { instance: _i2, ...passkeyRest } = passkeyBody;
    expect(passkeyRest).toEqual(staleRest);
  });

  test('20. Legacy rows count as links', async () => {
    const testApp = build();
    // Seed a row without via at now
    const tokenFresh = 'legacy-fresh';
    await store.putSession({
      tokenHash: await sha256Hex(tokenFresh),
      email: 'legacy@example.com',
      createdAt: now,
      expiresAt: now + 3600_000,
    });

    const freshRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie: `relic_session=${tokenFresh}` },
        body: '{}',
      })
    );
    expect(freshRes.status).toBe(200);
    const freshData = (await freshRes.json()) as { mode: string };
    expect(freshData.mode).toBe('create');

    // Seed a row without via at now - 900_001
    const tokenStale = 'legacy-stale';
    await store.putSession({
      tokenHash: await sha256Hex(tokenStale),
      email: 'legacy@example.com',
      createdAt: now - 900_001,
      expiresAt: now + 3600_000,
    });

    const staleRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie: `relic_session=${tokenStale}` },
        body: '{}',
      })
    );
    expect(staleRes.status).toBe(401);
    const staleData = (await staleRes.json()) as { code: string };
    expect(staleData.code).toBe('passkey_fresh_link_required');
  });

  test('21. Challenge honoured after the window', async () => {
    const notices: Array<{ email: string; mail: OutboundMail }> = [];
    const testApp = build({
      mailer: {
        async send(email, link) {
          sentMails.push({ email, link });
        },
        async sendMail(email, mail) {
          notices.push({ email, mail });
        },
      },
    });

    const mintTime = now;
    const { cookie } = await signInViaLink('honour@example.com', testApp);

    now = mintTime + 899_000;
    const optRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(optRes.status).toBe(200);
    const optData = (await optRes.json()) as {
      mode: string;
      public_key: CreationOptionsJSON;
    };

    const auth = await fakeAuthenticator();
    const reg = await auth.register(optData.public_key, ORIGIN);

    // Advance clock past the 900s fresh link window (e.g. +60_000 ms)
    now += 60_000;
    const regRes = await testApp.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );
    expect(regRes.status).toBe(201);
    expect(notices.length).toBe(1);
    expect(notices[0]?.email).toBe('honour@example.com');
  });

  test('22. Enroll is exempt', async () => {
    const notices: Array<{ email: string; mail: OutboundMail }> = [];
    const testApp = build({
      mailer: {
        async send(email, link) {
          sentMails.push({ email, link });
        },
        async sendMail(email, mail) {
          notices.push({ email, mail });
        },
      },
    });

    const mintTime = now;
    const { cookie } = await signInViaLink('enroll@example.com', testApp);
    const auth1 = await fakeAuthenticator();
    await registerPasskey(cookie, auth1, testApp);

    expect(notices.length).toBe(1);
    const d1 = new Date(mintTime);
    const hh1 = String(d1.getUTCHours()).padStart(2, '0');
    const mm1 = String(d1.getUTCMinutes()).padStart(2, '0');
    const when1 = `${d1.getUTCDate()} Oct ${d1.getUTCFullYear()} at ${hh1}:${mm1} UTC`;
    expect(notices[0]?.mail.text).toBe(
      `A passkey was added for enroll@example.com on ${when1}.\n\n` +
        'It signs in to Relic as this address without a link, and it confirms decisions. This address has 1 passkey.\n\n' +
        'If you added it, you can ignore this message.\n\n' +
        'If you did not, whoever added it can read this mailbox, or used a browser that had just signed in with a link sent here. Relic has no way to remove a passkey.'
    );

    // Advance now by 2 hours (7_200_000 ms)
    now += 7_200_000;

    // Options returns assert mode
    const optRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(optRes.status).toBe(200);
    const optData = (await optRes.json()) as {
      mode: string;
      public_key: RequestOptionsJSON;
    };
    expect(optData.mode).toBe('assert');

    // Assertion gives create mode
    const assertion = await auth1.assert(optData.public_key, ORIGIN);
    const enrollRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: assertion }),
      })
    );
    expect(enrollRes.status).toBe(200);
    const enrollData = (await enrollRes.json()) as {
      mode: string;
      public_key: CreationOptionsJSON;
    };
    expect(enrollData.mode).toBe('create');

    // Register second passkey gives 201
    const auth2 = await fakeAuthenticator();
    const reg2 = await auth2.register(enrollData.public_key, ORIGIN);
    const addRes = await testApp.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg2 }),
      })
    );
    expect(addRes.status).toBe(201);
    expect(notices.length).toBe(2);
    expect(notices[1]?.mail.text).toContain('This address has 2 passkeys.');
    const d2 = new Date(now);
    const hh2 = String(d2.getUTCHours()).padStart(2, '0');
    const mm2 = String(d2.getUTCMinutes()).padStart(2, '0');
    const when2 = `${d2.getUTCDate()} Oct ${d2.getUTCFullYear()} at ${hh2}:${mm2} UTC`;
    expect(notices[1]?.mail.text).toBe(
      `A passkey was added for enroll@example.com on ${when2}.\n\n` +
        'It signs in to Relic as this address without a link, and it confirms decisions. A passkey this address already had confirmed it. This address has 2 passkeys.\n\n' +
        'If you added it, you can ignore this message.\n\n' +
        'If you did not, whoever added it could use a passkey this address already had. Relic has no way to remove a passkey.'
    );
  });

  test('23. Failed notice', async () => {
    const errorLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map(String).join(' '));
    };

    try {
      const testApp = build({
        mailer: {
          async send(email, link) {
            sentMails.push({ email, link });
          },
          async sendMail(email, _mail) {
            throw new Error(`Resend network fail for ${email}`);
          },
        },
      });

      const { cookie } = await signInViaLink('failnotice@example.com', testApp);
      const auth = await fakeAuthenticator();
      const optRes = await testApp.fetch(
        req('/api/auth/passkeys/options', {
          method: 'POST',
          headers: { cookie },
          body: '{}',
        })
      );
      const optData = (await optRes.json()) as {
        public_key: CreationOptionsJSON;
      };
      const reg = await auth.register(optData.public_key, ORIGIN);

      const regRes = await testApp.fetch(
        req('/api/auth/passkeys', {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({ credential: reg }),
        })
      );
      expect(regRes.status).toBe(201);

      // getPasskeys holds the credential
      const record = await store.getPasskeys('failnotice@example.com');
      expect(record?.credentials.length).toBe(1);

      // console.error spy gets exactly one line matching regex, without the address in it
      expect(errorLogs.length).toBe(1);
      expect(errorLogs[0]).toMatch(
        /^relic: passkey notice failed for recipient [0-9a-f]{64}: /
      );
      expect(errorLogs[0]).not.toContain('failnotice@example.com');
    } finally {
      console.error = origError;
    }
  });

  test('24. send never carries the notice', async () => {
    const testApp = build(); // default has only send
    const { cookie } = await signInViaLink('nosend@example.com', testApp);
    const auth = await fakeAuthenticator();
    await registerPasskey(cookie, auth, testApp);

    // sentMails has length 1 (the link only)
    expect(sentMails.length).toBe(1);
    expect(sentMails[0]?.email).toBe('nosend@example.com');
  });

  test('25. No notice on refusals', async () => {
    const notices: Array<{ email: string; mail: OutboundMail }> = [];
    const testApp = build({
      mailer: {
        async send(email, link) {
          sentMails.push({ email, link });
        },
        async sendMail(email, mail) {
          notices.push({ email, mail });
        },
      },
    });

    const mintTime = now;
    const { cookie } = await signInViaLink('refusal@example.com', testApp);

    // Stale session refusal
    now = mintTime + 900_001;
    const optRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(optRes.status).toBe(401);
    expect(notices.length).toBe(0);

    // Reset clock for race that answers 409 passkey_assertion_required
    now = mintTime;
    const optRes2 = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    const optData2 = (await optRes2.json()) as {
      public_key: CreationOptionsJSON;
    };
    const auth = await fakeAuthenticator();
    const reg = await auth.register(optData2.public_key, ORIGIN);

    // Seed an existing passkey record to simulate race collision
    await store.createPasskeys({
      email: 'refusal@example.com',
      userHandle: 'userhandle123',
      credentials: [
        {
          credentialId: 'existing-id',
          publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' },
          alg: -7,
          signCount: 0,
          transports: ['internal'],
          createdAt: now,
        },
      ],
    });

    const regRes = await testApp.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );
    expect(regRes.status).toBe(409);
    const errBody = (await regRes.json()) as { code: string };
    expect(errBody.code).toBe('passkey_assertion_required');
    expect(notices.length).toBe(0);
  });

  test('26. assertConfig validates passkeyFreshLinkSeconds', () => {
    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeyFreshLinkSeconds: 599,
      })
    ).toThrow('passkeyFreshLinkSeconds');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeyFreshLinkSeconds: 930,
      })
    ).toThrow('passkeyFreshLinkSeconds');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeyFreshLinkSeconds: 1.5,
      })
    ).toThrow('passkeyFreshLinkSeconds');

    expect(() =>
      assertConfig({
        ...DEFAULT_CONFIG,
        passkeyFreshLinkSeconds: 900,
      })
    ).not.toThrow();
  });

  test('27. /policy contains the new paragraph and disclosure text', async () => {
    const testApp = build();
    const res = await testApp.fetch(req('/policy'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(
      'only a session that a sign-in link started in the previous 15 minutes can begin adding it'
    );
    expect(text).toContain(
      'That email has no stop link, because it is about the address rather than a relic.'
    );
  });
  test('28. M1: Exhausting the email-first budget for an address does not block usernameless sign-in', async () => {
    const auth = await fakeAuthenticator();
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        passkeySignInAddressRateLimit: { limit: 2, windowSeconds: 3600 },
        passkeySignInHandleRateLimit: { limit: 10, windowSeconds: 3600 },
      },
    });

    const targetEmail = 'exhaust-email-first@example.com';
    const { cookie } = await signInViaLink(targetEmail);
    const { userHandle } = await registerPasskey(cookie, auth);

    // Spend the email-first sign-in budget (2 requests)
    for (let i = 0; i < 2; i++) {
      const optRes = await app.fetch(
        req('/api/auth/passkeys/sign-in/options', {
          method: 'POST',
          body: JSON.stringify({ email: targetEmail }),
        })
      );
      const optData = (await optRes.json()) as {
        public_key: RequestOptionsJSON;
      };
      const assertion = await auth.assert(
        optData.public_key,
        ORIGIN,
        userHandle
      );
      const signRes = await app.fetch(
        req('/api/auth/passkeys/sign-in', {
          method: 'POST',
          body: JSON.stringify({ credential: assertion }),
        })
      );
      expect(signRes.status).toBe(200);
    }

    // 3rd email-first request hits 429 passkey_rate_limited
    const optResBlocked = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: JSON.stringify({ email: targetEmail }),
      })
    );
    const optDataBlocked = (await optResBlocked.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertionBlocked = await auth.assert(
      optDataBlocked.public_key,
      ORIGIN,
      userHandle
    );
    const signResBlocked = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertionBlocked }),
      })
    );
    expect(signResBlocked.status).toBe(429);
    const bodyBlocked = (await signResBlocked.json()) as { code: string };
    expect(bodyBlocked.code).toBe('passkey_rate_limited');

    // Usernameless sign-in for the same address still succeeds
    const optResUsernameless = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        body: '{}',
      })
    );
    const optDataUsernameless = (await optResUsernameless.json()) as {
      public_key: RequestOptionsJSON;
    };
    const assertionUsernameless = await auth.assert(
      optDataUsernameless.public_key,
      ORIGIN,
      userHandle
    );
    const signResUsernameless = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        body: JSON.stringify({ credential: assertionUsernameless }),
      })
    );
    expect(signResUsernameless.status).toBe(200);
    const successBody = (await signResUsernameless.json()) as { email: string };
    expect(successBody.email).toBe(targetEmail);
  });

  test('29. L1: Two IPv6 addresses in one /64 share the sign-in IP budget', async () => {
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        passkeySignInRateLimit: { limit: 2, windowSeconds: 3600 },
      },
    });

    const ip1 = '2001:db8:abcd:12::1';
    const ip2 = '2001:db8:abcd:12:dead:beef::99';
    const lbIp = '10.0.0.1';

    // Request 1 from ip1
    const res1 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': `${ip1}, ${lbIp}` },
        body: JSON.stringify({ credential: { id: 'invalid' } }),
      })
    );
    expect(res1.status).not.toBe(429);

    // Request 2 from ip2 (same /64)
    const res2 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': `${ip2}, ${lbIp}` },
        body: JSON.stringify({ credential: { id: 'invalid' } }),
      })
    );
    expect(res2.status).not.toBe(429);

    // Request 3 from ip1: /64 budget (limit: 2) is spent -> 429 passkey_rate_limited
    const res3 = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': `${ip1}, ${lbIp}` },
        body: JSON.stringify({ credential: { id: 'invalid' } }),
      })
    );
    expect(res3.status).toBe(429);
    const body3 = (await res3.json()) as { code: string };
    expect(body3.code).toBe('passkey_rate_limited');

    // Request from different /64 is not rate limited
    const resOther = await app.fetch(
      req('/api/auth/passkeys/sign-in', {
        method: 'POST',
        headers: { 'x-forwarded-for': `2001:db8:abcd:13::1, ${lbIp}` },
        body: JSON.stringify({ credential: { id: 'invalid' } }),
      })
    );
    expect(resOther.status).not.toBe(429);
  });

  test('30. L2: Filling the address limiter leaves IP rate limit buckets intact', async () => {
    app = build({
      config: {
        serviceOrigin: ORIGIN,
        addressLimiterMaxEntries: 3,
        passkeySignInOptionsRateLimit: { limit: 10, windowSeconds: 3600 },
        passkeySignInOptionsAddressRateLimit: {
          limit: 10,
          windowSeconds: 3600,
        },
      },
    });

    const testIp = '198.51.100.42';
    const lbIp = '10.0.0.1';

    // 1. Consume 1 request from testIp on IP limiter
    const rInitial = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        headers: { 'x-forwarded-for': `${testIp}, ${lbIp}` },
        body: '{}',
      })
    );
    expect(rInitial.status).toBe(200);

    // 2. Churn 5 distinct email addresses to trigger eviction in addressLimiter
    for (let i = 1; i <= 5; i++) {
      const churnRes = await app.fetch(
        req('/api/auth/passkeys/sign-in/options', {
          method: 'POST',
          headers: { 'x-forwarded-for': `192.0.2.${i}, ${lbIp}` },
          body: JSON.stringify({ email: `victim-${i}@example.com` }),
        })
      );
      expect(churnRes.status).toBe(200);
    }

    // 3. Verify addressLimiter evicted entries to stay within addressLimiterMaxEntries
    expect(app.addressLimiter.size).toBeLessThanOrEqual(3);

    // 4. Verify testIp in limiter has count 1 intact; 9 more succeed, 11th is 429
    for (let i = 2; i <= 10; i++) {
      const r = await app.fetch(
        req('/api/auth/passkeys/sign-in/options', {
          method: 'POST',
          headers: { 'x-forwarded-for': `${testIp}, ${lbIp}` },
          body: '{}',
        })
      );
      expect(r.status).toBe(200);
    }
    const rBlocked = await app.fetch(
      req('/api/auth/passkeys/sign-in/options', {
        method: 'POST',
        headers: { 'x-forwarded-for': `${testIp}, ${lbIp}` },
        body: '{}',
      })
    );
    expect(rBlocked.status).toBe(429);
  });

  test('31. L3: Passkey register returns 201 within bound and stores record even when mailer never resolves', async () => {
    const neverMailer: Mailer = {
      async send(email, link) {
        sentMails.push({ email, link });
      },
      sendMail() {
        return new Promise(() => {});
      },
    };
    const testApp = build({
      mailer: neverMailer,
      config: {
        serviceOrigin: ORIGIN,
        passkeyNoticeTimeoutMs: 50,
      },
    });

    const testEmail = 'hung-mailer@example.com';
    const { cookie } = await signInViaLink(testEmail, testApp);

    const optRes = await testApp.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(optRes.status).toBe(200);
    const optData = (await optRes.json()) as {
      public_key: CreationOptionsJSON;
    };

    const auth = await fakeAuthenticator();
    const reg = await auth.register(optData.public_key, ORIGIN);

    const start = Date.now();
    const regRes = await testApp.fetch(
      req('/api/auth/passkeys', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ credential: reg }),
      })
    );
    const duration = Date.now() - start;

    expect(regRes.status).toBe(201);
    expect(duration).toBeLessThan(1000);
    const regData = (await regRes.json()) as {
      passkeys: number;
      email: string;
    };
    expect(regData.passkeys).toBe(1);

    const stored = await store.getPasskeys(testEmail);
    expect(stored).toBeDefined();
    expect(stored?.credentials.length).toBe(1);
  });

  test('32. I1: Logs one warning per process when mailer has no sendMail', async () => {
    resetPasskeyNoticeWarningForTesting();
    const noSendMailApp = build({
      mailer: {
        async send(email, link) {
          sentMails.push({ email, link });
        },
      },
    });

    const warnLogs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLogs.push(args.map(String).join(' '));
    };

    try {
      const { cookie: cookie1 } = await signInViaLink(
        'no-sendmail-1@example.com',
        noSendMailApp
      );
      const optRes1 = await noSendMailApp.fetch(
        req('/api/auth/passkeys/options', {
          method: 'POST',
          headers: { cookie: cookie1 },
          body: '{}',
        })
      );
      const optData1 = (await optRes1.json()) as {
        public_key: CreationOptionsJSON;
      };
      const auth1 = await fakeAuthenticator();
      const reg1 = await auth1.register(optData1.public_key, ORIGIN);
      const regRes1 = await noSendMailApp.fetch(
        req('/api/auth/passkeys', {
          method: 'POST',
          headers: { cookie: cookie1 },
          body: JSON.stringify({ credential: reg1 }),
        })
      );
      expect(regRes1.status).toBe(201);

      const { cookie: cookie2 } = await signInViaLink(
        'no-sendmail-2@example.com',
        noSendMailApp
      );
      const optRes2 = await noSendMailApp.fetch(
        req('/api/auth/passkeys/options', {
          method: 'POST',
          headers: { cookie: cookie2 },
          body: '{}',
        })
      );
      const optData2 = (await optRes2.json()) as {
        public_key: CreationOptionsJSON;
      };
      const auth2 = await fakeAuthenticator();
      const reg2 = await auth2.register(optData2.public_key, ORIGIN);
      const regRes2 = await noSendMailApp.fetch(
        req('/api/auth/passkeys', {
          method: 'POST',
          headers: { cookie: cookie2 },
          body: JSON.stringify({ credential: reg2 }),
        })
      );
      expect(regRes2.status).toBe(201);

      expect(warnLogs.length).toBe(1);
      expect(warnLogs[0]).toContain(
        'relic: passkey notices are disabled: mailer has no sendMail'
      );
    } finally {
      console.warn = origWarn;
    }
  });
});
