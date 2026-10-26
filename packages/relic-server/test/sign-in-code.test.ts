import { beforeEach, describe, expect, test } from 'bun:test';
import { createApp, type Mailer, type RelicApp } from '../src/app.ts';
import { sha256Hex } from '../src/gcs.ts';
import { gcsStore } from '../src/gcsstore.ts';
import { normalizeEmail } from '../src/store.ts';

interface FakeGcs {
  readonly fetch: typeof globalThis.fetch;
  readonly objects: Map<string, { body: string; generation: number }>;
  contendOn(name: string, times: number): void;
}

function fakeGcs(): FakeGcs {
  const objects = new Map<string, { body: string; generation: number }>();
  const media = new Map<string, Uint8Array>();
  let nextGeneration = 1;
  const bumps = new Map<string, number>();

  const competingIncrement = (name: string): void => {
    const remaining = bumps.get(name);
    if (remaining === undefined || remaining === 0) return;
    if (remaining > 0) bumps.set(name, remaining - 1);

    const existing = objects.get(name);
    if (existing === undefined) {
      objects.set(name, {
        body: JSON.stringify({}),
        generation: nextGeneration++,
      });
      return;
    }

    const parsed = JSON.parse(existing.body) as Record<string, unknown>;
    if ('mintsUsed' in parsed) {
      parsed['mintsUsed'] = (Number(parsed['mintsUsed']) || 0) + 1;
    }
    if ('attempts' in parsed) {
      parsed['attempts'] = (Number(parsed['attempts']) || 0) + 1;
    }
    objects.set(name, {
      body: JSON.stringify(parsed),
      generation: nextGeneration++,
    });
  };

  const handler = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';

    if (url.pathname.startsWith('/upload/')) {
      const name = url.searchParams.get('name') ?? '';
      const precondition = url.searchParams.get('ifGenerationMatch');

      competingIncrement(name);

      if (precondition !== null) {
        const existing = objects.get(name);
        const current = existing === undefined ? 0 : existing.generation;
        if (String(current) !== precondition) {
          return new Response('precondition failed', { status: 412 });
        }
      }

      if (init?.body instanceof Uint8Array) {
        media.set(name, init.body);
        objects.set(name, {
          body: '',
          generation: nextGeneration++,
        });
      } else {
        objects.set(name, {
          body: String(init?.body ?? ''),
          generation: nextGeneration++,
        });
      }
      return new Response('{}', { status: 200 });
    }

    const objectMatch = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
    if (objectMatch?.[1] !== undefined) {
      const name = decodeURIComponent(objectMatch[1]);

      if (method === 'DELETE') {
        const precondition = url.searchParams.get('ifGenerationMatch');
        if (precondition !== null) {
          const existing = objects.get(name);
          const current = existing === undefined ? 0 : existing.generation;
          if (String(current) !== precondition) {
            return new Response('precondition failed', { status: 412 });
          }
        }
        objects.delete(name);
        media.delete(name);
        return new Response('', { status: 204 });
      }

      const found = objects.get(name);
      if (found === undefined) {
        return new Response('not found', { status: 404 });
      }
      return new Response(found.body, {
        status: 200,
        headers: { 'x-goog-generation': String(found.generation) },
      });
    }

    return new Response('unhandled', { status: 500 });
  };

  return {
    fetch: handler as unknown as typeof globalThis.fetch,
    objects,
    contendOn(name: string, times: number) {
      bumps.set(name, times);
    },
  };
}

function storeOn(gcs: FakeGcs, casAttempts?: number) {
  return gcsStore({
    bucket: 'relics',
    getAccessToken: async () => 'token',
    host: 'https://gcs.test',
    fetch: gcs.fetch,
    ...(casAttempts === undefined ? {} : { casAttempts }),
  });
}

let now = Date.parse('2026-10-26T12:00:00.000Z');
let app: RelicApp;
let sentMails: Array<{
  email: string;
  link: string;
  code?: string | undefined;
}> = [];

const mailer: Mailer = {
  async send(email, link, code) {
    sentMails.push({ email, link, ...(code !== undefined ? { code } : {}) });
  },
};

function build(overrides: Parameters<typeof createApp>[0] = {}): RelicApp {
  return createApp({
    now: () => now,
    mailer,
    ...overrides,
  });
}

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
  return new Request(`https://relic.example${path}`, { ...init, headers });
}

beforeEach(() => {
  now = Date.parse('2026-10-26T12:00:00.000Z');
  sentMails = [];
  app = build();
});

describe('email sign-in code', () => {
  test('every 202 sets the exact cookie string; a 429 sets none', async () => {
    // Valid email
    const resValid = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' }),
      })
    );
    expect(resValid.status).toBe(202);
    const cookieValid = resValid.headers.get('set-cookie') ?? '';
    expect(cookieValid).toMatch(
      /^relic_sign_in_request=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/code; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/
    );

    // Invalid email
    const resInvalid = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      })
    );
    expect(resInvalid.status).toBe(202);
    expect(resInvalid.headers.get('set-cookie')).toMatch(
      /^relic_sign_in_request=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/code; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/
    );

    // Missing email
    const resEmpty = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(resEmpty.status).toBe(202);
    expect(resEmpty.headers.get('set-cookie')).toMatch(
      /^relic_sign_in_request=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/code; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/
    );

    // Rate limited IP gets 429 and no cookie
    const limitedApp = build({
      config: { authRateLimit: { limit: 1, windowSeconds: 60 } },
    });
    const ip = '198.51.100.99';
    await limitedApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' }),
        ip,
      })
    );
    const res429 = await limitedApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' }),
        ip,
      })
    );
    expect(res429.status).toBe(429);
    expect(res429.headers.get('set-cookie')).toBeNull();
  });

  test('the mailer receives a 6-digit code', async () => {
    const res = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    expect(res.status).toBe(202);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.email).toBe('reader@example.com');
    expect(sentMails[0]?.code).toBeDefined();
    expect(sentMails[0]?.code).toMatch(/^[0-9]{6}$/);
  });

  test('the right code with the cookie answers 200 {email} with the three cookies, and GET /api/auth/session then returns the address', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    expect(requestRes.status).toBe(202);
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';

    const codeRes = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: requestCookie,
        },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes.status).toBe(200);
    const body = (await codeRes.json()) as { email: string };
    expect(body).toEqual({ email: 'reader@example.com' });

    const cookies = codeRes.headers.getSetCookie();
    expect(cookies).toHaveLength(3);

    const sessionCookieStr = cookies.find((c) =>
      c.startsWith('relic_session=')
    );
    const offerCookieStr = cookies.find((c) =>
      c.startsWith('relic_passkey_offer=')
    );
    const clearedRequestCookieStr = cookies.find((c) =>
      c.startsWith('relic_sign_in_request=')
    );

    expect(sessionCookieStr).toBeDefined();
    expect(sessionCookieStr).toMatch(
      /^relic_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/
    );

    expect(offerCookieStr).toBeDefined();
    expect(offerCookieStr).toMatch(
      /^relic_passkey_offer=1; Path=\/; Secure; SameSite=Lax; Max-Age=600$/
    );

    expect(clearedRequestCookieStr).toBeDefined();
    expect(clearedRequestCookieStr).toMatch(
      /^relic_sign_in_request=; Path=\/api\/auth\/code; HttpOnly; Secure; SameSite=Strict; Max-Age=0$/
    );

    // Verify session
    const sessionToken =
      sessionCookieStr?.split(';')[0]?.replace('relic_session=', '') ?? '';
    const sessionRes = await app.fetch(
      req('/api/auth/session', {
        headers: { cookie: `relic_session=${sessionToken}` },
      })
    );
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toEqual({ email: 'reader@example.com' });
  });

  test('the session row records via: code', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';

    const codeRes = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: requestCookie,
        },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes.status).toBe(200);

    const cookies = codeRes.headers.getSetCookie();
    const sessionCookieStr = cookies.find((c) =>
      c.startsWith('relic_session=')
    );
    const sessionToken =
      sessionCookieStr?.split(';')[0]?.replace('relic_session=', '') ?? '';
    const tokenHash = await sha256Hex(sessionToken);

    const sessionRow = await app.store.getSession(tokenHash);
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.via).toBe('code');
  });

  test('the link then answers 401 invalid_session', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';
    const link = sentMails[0]?.link ?? '';

    // Code is verified
    const codeRes = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: requestCookie,
        },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes.status).toBe(200);

    // Link is now spent
    const linkUrl = new URL(link);
    const linkRes = await app.fetch(
      req(linkUrl.pathname + linkUrl.search, { redirect: 'manual' })
    );
    expect(linkRes.status).toBe(401);
    const linkBody = (await linkRes.json()) as { code: string };
    expect(linkBody.code).toBe('invalid_session');
  });

  test('following the link first makes the code answer 401', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';
    const link = sentMails[0]?.link ?? '';

    // Follow link first
    const linkUrl = new URL(link);
    const linkRes = await app.fetch(
      req(linkUrl.pathname + linkUrl.search, { redirect: 'manual' })
    );
    expect(linkRes.status).toBe(303);

    // Code now answers 401
    const codeRes = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: requestCookie,
        },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes.status).toBe(401);
    const codeBody = (await codeRes.json()) as { code: string };
    expect(codeBody.code).toBe('sign_in_code_failed');
  });

  test('replaying the code answers 401', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';

    // First use answers 200
    const codeRes1 = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: requestCookie,
        },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes1.status).toBe(200);

    // Replay answers 401
    const codeRes2 = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: requestCookie,
        },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes2.status).toBe(401);
    const body2 = (await codeRes2.json()) as { code: string };
    expect(body2.code).toBe('sign_in_code_failed');
  });

  test('these all give byte-identical 401 bodies apart from instance: wrong code, no cookie, unknown nonce, expired (clock advanced past 900 s), and superseded (a second request cookie with the first code)', async () => {
    // 1. Wrong code
    const req1 = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user1@example.com' }),
      })
    );
    const cookie1 = req1.headers.get('set-cookie') ?? '';
    const wrongCode = sentMails[0]?.code === '000000' ? '999999' : '000000';
    const resWrongCode = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie1 },
        body: JSON.stringify({ code: wrongCode }),
      })
    );

    // 2. No cookie
    const resNoCookie = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      })
    );

    // 3. Unknown nonce
    const fakeNonce = 'A'.repeat(43);
    const resUnknownNonce = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `relic_sign_in_request=${fakeNonce}`,
        },
        body: JSON.stringify({ code: '123456' }),
      })
    );

    // 4. Expired
    const reqExpired = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user2@example.com' }),
      })
    );
    const cookieExpired = reqExpired.headers.get('set-cookie') ?? '';
    const codeExpired = sentMails[1]?.code ?? '';
    now += 901 * 1000;
    const resExpired = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieExpired },
        body: JSON.stringify({ code: codeExpired }),
      })
    );
    now -= 901 * 1000;

    // 5. Superseded: request 1, then request 2; cookie 2 with code 1
    const reqSup1 = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user3@example.com' }),
      })
    );
    expect(reqSup1.status).toBe(202);
    const codeSup1 = sentMails[2]?.code ?? '';

    const reqSup2 = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user3@example.com' }),
      })
    );
    const cookieSup2 = reqSup2.headers.get('set-cookie') ?? '';

    const resSuperseded = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieSup2 },
        body: JSON.stringify({ code: codeSup1 }),
      })
    );

    const responses = [
      resWrongCode,
      resNoCookie,
      resUnknownNonce,
      resExpired,
      resSuperseded,
    ];

    for (const r of responses) {
      expect(r.status).toBe(401);
    }

    const bodies = await Promise.all(
      responses.map(async (r) => {
        const body = (await r.json()) as Record<string, unknown>;
        expect(body['code']).toBe('sign_in_code_failed');
        delete body['instance'];
        return JSON.stringify(body);
      })
    );

    const canonical = bodies[0];
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i]).toBe(canonical);
    }
  });

  test('ten wrong codes followed by the right one answers 401, while the link still answers 303. Case variants of an address share one budget. After 24 hours, a new request and its right code answer 200.', async () => {
    // Request for Ada@Example.COM
    const reqAda = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Ada@Example.COM' }),
      })
    );
    expect(reqAda.status).toBe(202);
    const cookieAda = reqAda.headers.get('set-cookie') ?? '';
    const codeAda = sentMails[0]?.code ?? '';
    const linkAda = sentMails[0]?.link ?? '';

    // 10 wrong codes
    const wrongCode = codeAda === '000000' ? '999999' : '000000';
    for (let i = 0; i < 10; i++) {
      const wrongRes = await app.fetch(
        req('/api/auth/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieAda },
          body: JSON.stringify({ code: wrongCode }),
        })
      );
      expect(wrongRes.status).toBe(401);
    }

    // 11th attempt with the RIGHT code is refused by budget
    const rightRes = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieAda },
        body: JSON.stringify({ code: codeAda }),
      })
    );
    expect(rightRes.status).toBe(401);
    const rightBody = (await rightRes.json()) as { code: string };
    expect(rightBody.code).toBe('sign_in_code_failed');

    // The link was not consumed, so it still answers 303
    const linkUrl = new URL(linkAda);
    const linkRes = await app.fetch(
      req(linkUrl.pathname + linkUrl.search, { redirect: 'manual' })
    );
    expect(linkRes.status).toBe(303);

    // Case variants share one budget
    // Make 5 attempts with UPPERCASE, 5 attempts with lowercase
    const freshApp = build();
    const reqVariant1 = await freshApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'TestUser@example.com' }),
      })
    );
    const cookieVar1 = reqVariant1.headers.get('set-cookie') ?? '';
    for (let i = 0; i < 5; i++) {
      await freshApp.fetch(
        req('/api/auth/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieVar1 },
          body: JSON.stringify({ code: '000000' }),
        })
      );
    }

    const reqVariant2 = await freshApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'testuser@example.com' }),
      })
    );
    const cookieVar2 = reqVariant2.headers.get('set-cookie') ?? '';
    for (let i = 0; i < 5; i++) {
      await freshApp.fetch(
        req('/api/auth/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieVar2 },
          body: JSON.stringify({ code: '000000' }),
        })
      );
    }

    // Now total attempts for testuser@example.com is 10. Next attempt (right code) is blocked
    const rightCodeVar2 = sentMails[sentMails.length - 1]?.code ?? '';
    const resBlocked = await freshApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieVar2 },
        body: JSON.stringify({ code: rightCodeVar2 }),
      })
    );
    expect(resBlocked.status).toBe(401);

    // After 24 hours (86_400 s), a new request and its right code answer 200
    now += 86_400 * 1000 + 1;
    const reqAfter24 = await freshApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'testuser@example.com' }),
      })
    );
    const cookieAfter24 = reqAfter24.headers.get('set-cookie') ?? '';
    const codeAfter24 = sentMails[sentMails.length - 1]?.code ?? '';

    const resAfter24 = await freshApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieAfter24 },
        body: JSON.stringify({ code: codeAfter24 }),
      })
    );
    expect(resAfter24.status).toBe(200);
    expect(await resAfter24.json()).toEqual({ email: 'testuser@example.com' });
  });

  test('shape errors (non-JSON, malformed body, missing or non-string code, 5 or 7 digits, letters) answer 400. 123 456 is accepted', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const cookie = requestRes.headers.get('set-cookie') ?? '';

    // Non-JSON content-type
    const resNonJson = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', cookie },
        body: '{"code":"123456"}',
      })
    );
    expect(resNonJson.status).toBe(400);
    const nonJsonBody = (await resNonJson.json()) as { code: string };
    expect(nonJsonBody.code).toBe('invalid_sign_in_code');

    // Malformed JSON
    const resMalformed = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{not-json',
      })
    );
    expect(resMalformed.status).toBe(400);
    const malformedBody = (await resMalformed.json()) as { code: string };
    expect(malformedBody.code).toBe('invalid_sign_in_code');

    // Missing code
    const resMissing = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({}),
      })
    );
    expect(resMissing.status).toBe(400);
    const missingBody = (await resMissing.json()) as { code: string };
    expect(missingBody.code).toBe('invalid_sign_in_code');

    // Non-string code (number)
    const resNumber = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ code: 123456 }),
      })
    );
    expect(resNumber.status).toBe(400);

    // Non-string code (array body)
    const resArray = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify([{ code: '123456' }]),
      })
    );
    expect(resArray.status).toBe(400);

    // 5 digits
    const res5 = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ code: '12345' }),
      })
    );
    expect(res5.status).toBe(400);

    // 7 digits
    const res7 = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ code: '1234567' }),
      })
    );
    expect(res7.status).toBe(400);

    // Letters
    const resLetters = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ code: '12345a' }),
      })
    );
    expect(resLetters.status).toBe(400);

    const sentCode = sentMails[0]?.code ?? '';
    const spacedCode = `${sentCode.slice(0, 3)} ${sentCode.slice(3)}`;
    const resSpaces = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ code: spacedCode }),
      })
    );
    expect(resSpaces.status).toBe(200);
  });

  test('the 429 from auth-code is independent of the request limiter', async () => {
    const limitedApp = build({
      config: {
        authRateLimit: { limit: 2, windowSeconds: 3600 },
        signInCodeRateLimit: { limit: 3, windowSeconds: 3600 },
      },
    });
    const ip = '198.51.100.42';

    // Exhaust authRateLimit on /api/auth/request
    await limitedApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'u1@example.com' }),
        ip,
      })
    );
    await limitedApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'u2@example.com' }),
        ip,
      })
    );
    const req3 = await limitedApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'u3@example.com' }),
        ip,
      })
    );
    expect(req3.status).toBe(429);

    // auth-code is not blocked by authRateLimit
    const codeReq1 = await limitedApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'invalid' }),
        ip,
      })
    );
    expect(codeReq1.status).toBe(400);

    // Exhaust signInCodeRateLimit (3 attempts)
    await limitedApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'invalid' }),
        ip,
      })
    );
    await limitedApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'invalid' }),
        ip,
      })
    );

    // 4th attempt to auth-code is 429
    const codeReq4 = await limitedApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
        ip,
      })
    );
    expect(codeReq4.status).toBe(429);
  });

  test('if Q1 is Yes: a code session within 15 minutes gets a create challenge, and after 16 minutes it gets 401 passkey_fresh_link_required', async () => {
    const requestRes = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'enroll@example.com' }),
      })
    );
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';

    const codeRes = await app.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: requestCookie },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes.status).toBe(200);

    const cookies = codeRes.headers.getSetCookie();
    const sessionCookieStr = cookies.find((c) =>
      c.startsWith('relic_session=')
    );
    const sessionToken =
      sessionCookieStr?.split(';')[0]?.replace('relic_session=', '') ?? '';
    const cookie = `relic_session=${sessionToken}`;

    // Within 15 minutes (now + 5 minutes)
    now += 5 * 60 * 1000;
    const optResValid = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(optResValid.status).toBe(200);
    const optBody = (await optResValid.json()) as { mode: string };
    expect(optBody.mode).toBe('create');

    // After 16 minutes from session creation (now + 11 more minutes = 16 minutes total)
    now += 11 * 60 * 1000;
    const optResExpired = await app.fetch(
      req('/api/auth/passkeys/options', {
        method: 'POST',
        headers: { cookie },
        body: '{}',
      })
    );
    expect(optResExpired.status).toBe(401);
    const expiredBody = (await optResExpired.json()) as {
      code: string;
      title: string;
    };
    expect(expiredBody.code).toBe('passkey_fresh_link_required');
    expect(expiredBody.title).toBe(
      'Adding a first passkey needs a fresh sign-in from an email'
    );
  });

  test('two createApp instances over one fakeGcs give exactly one success when the code and the link race', async () => {
    const gcs = fakeGcs();
    const app1 = build({ store: storeOn(gcs) });
    const app2 = build({ store: storeOn(gcs) });

    const requestRes = await app1.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'racer@example.com' }),
      })
    );
    expect(requestRes.status).toBe(202);
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';
    const link = sentMails[0]?.link ?? '';
    const linkUrl = new URL(link);

    const [codeRes, linkRes] = await Promise.all([
      app1.fetch(
        req('/api/auth/code', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: requestCookie,
          },
          body: JSON.stringify({ code }),
        })
      ),
      app2.fetch(
        req(linkUrl.pathname + linkUrl.search, { redirect: 'manual' })
      ),
    ]);

    const codeSuccess = codeRes.status === 200;
    const linkSuccess = linkRes.status === 303;
    expect((codeSuccess ? 1 : 0) + (linkSuccess ? 1 : 0)).toBe(1);

    if (codeSuccess) {
      expect(linkRes.status).toBe(401);
    } else {
      expect(codeRes.status).toBe(401);
    }
  });

  test('with contendOn(budget, -1), the right code answers 500 and never 200', async () => {
    const gcs = fakeGcs();
    const gcsApp = build({ store: storeOn(gcs) });

    const requestRes = await gcsApp.fetch(
      req('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'contended@example.com' }),
      })
    );
    expect(requestRes.status).toBe(202);
    const requestCookie = requestRes.headers.get('set-cookie') ?? '';
    const code = sentMails[0]?.code ?? '';

    const addressHash = await sha256Hex(
      normalizeEmail('contended@example.com')
    );
    const budgetObject = `m/challenge/sign-in-code-budget/${addressHash}.json`;
    gcs.contendOn(budgetObject, -1);

    const codeRes = await gcsApp.fetch(
      req('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: requestCookie },
        body: JSON.stringify({ code }),
      })
    );
    expect(codeRes.status).toBe(500);
    expect(codeRes.status).not.toBe(200);
  });
});
