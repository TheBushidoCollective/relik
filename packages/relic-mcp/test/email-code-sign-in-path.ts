/**
 * Loopback proof for Relic email code sign-in (spec §2 and §6 slice P).
 *
 *   RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/email-code-sign-in-path.ts
 *
 * Starts a loopback server with MemoryStore and MemoryStorage, binding 127.0.0.1
 * with serviceOrigin = http://localhost:<port>.
 * Runs all steps and negative controls, ending with EMAIL_CODE_SIGN_IN_PATH_OK.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { signInMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { discoverChrome } from '../src/cover/chrome.ts';
import {
  type CapturedSignInMail,
  runEmailCodeSignInSequence,
} from './email-code-sign-in-steps.ts';

const clientMode = process.env['RELIC_EMAIL_CODE_CLIENT'] ?? 'source';
const isNpxMode = clientMode.startsWith('npx:');

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const relicMcpBundlePath = fileURLToPath(
  new URL('../dist/relic-mcp.js', import.meta.url)
);

function resolveCommand(): readonly string[] {
  if (isNpxMode) {
    const pkg = clientMode.slice(4);
    return ['npx', '-y', `relic-mcp@${pkg}`];
  }
  return ['node', relicMcpBundlePath];
}

async function resolveChrome(): Promise<string> {
  const envChrome = process.env['RELIC_CHROME_PATH'];
  if (envChrome && envChrome !== 'none') {
    return envChrome;
  }
  const discovered = await discoverChrome(undefined);
  if (discovered.kind === 'found') {
    return discovered.path;
  }
  throw new Error(
    'RELIC_CHROME_PATH must be set to an executable Chrome binary or headless shell'
  );
}

const chromePath = await resolveChrome();
const scratch = await mkdtemp(join(tmpdir(), 'relic-email-code-sign-in-path-'));
const statePath = join(scratch, 'state.json');

// --- App server setup with MemoryStore and MemoryStorage -----------------
const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);
const mails: CapturedSignInMail[] = [];

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});

const serviceOrigin = `http://localhost:${service.port}`;
const storage = new MemoryStorage(`${serviceOrigin}/__storage`);

const app = createApp({
  config: {
    serviceOrigin,
  },
  store,
  storage,
  now: () => Date.now(),
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async (to, link, code) => {
      const m = signInMail(link, code);
      mails.push({
        to,
        link,
        code,
        subject: m.subject,
        text: m.text,
      });
    },
    sendMail: async (_to, _mail) => {
      // not used for sign-in codes
    },
  },
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    const bytes = new Uint8Array(await request.arrayBuffer());
    storage.put(relicId, bytes);
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(relicId);
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return app.fetch(request);
};

async function awaitSignInMail(email: string): Promise<CapturedSignInMail> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let found: CapturedSignInMail | undefined;
    for (let i = mails.length - 1; i >= 0; i--) {
      const m = mails[i];
      if (m && m.to.toLowerCase() === email.toLowerCase()) {
        found = m;
        break;
      }
    }
    if (found) {
      return found;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(
    `Sign-in mail for ${email} did not arrive in captured mailer`
  );
}

function parseSetCookie(header: string | null): string {
  if (!header) return '';
  const match = header.match(/^([^;]+)/);
  return match ? (match[1] ?? '') : '';
}

try {
  await runEmailCodeSignInSequence({
    serviceOrigin,
    scratchDir: scratch,
    statePath,
    mcpCommand: resolveCommand(),
    chromePath,
    readerEmail: 'reader+relic-email-code-loopback@example.test',
    awaitSignInMail,
    isLive: false,
    store,
  });

  // --- Negative checks over HTTP with manual cookie jar ---
  // Scenarios:
  // wrong, no_cookie, unknown_request, replay, link_first, locked, link_after_lock, shape_equal, wrong_content_type
  // Distinct address per scenario.

  // 1. wrong
  const emailWrong = 'neg-wrong@example.test';
  const reqWrong = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailWrong }),
    })
  );
  assert.equal(reqWrong.status, 202);
  const cookieWrong = parseSetCookie(reqWrong.headers.get('set-cookie'));
  const mailWrong = await awaitSignInMail(emailWrong);
  const wrongCodeVal = mailWrong.code === '000000' ? '999999' : '000000';
  const resWrong = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieWrong,
      },
      body: JSON.stringify({ code: wrongCodeVal }),
    })
  );

  // 2. no_cookie
  const resNoCookie = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: '123456' }),
    })
  );

  // 3. unknown_request
  const fakeNonce = 'B'.repeat(43);
  const resUnknownRequest = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `relic_sign_in_request=${fakeNonce}`,
      },
      body: JSON.stringify({ code: '123456' }),
    })
  );

  // 4. replay
  const emailReplay = 'neg-replay@example.test';
  const reqReplay = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailReplay }),
    })
  );
  assert.equal(reqReplay.status, 202);
  const cookieReplay = parseSetCookie(reqReplay.headers.get('set-cookie'));
  const mailReplay = await awaitSignInMail(emailReplay);
  const resReplayFirst = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieReplay,
      },
      body: JSON.stringify({ code: mailReplay.code }),
    })
  );
  assert.equal(resReplayFirst.status, 200);
  const resReplay = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieReplay,
      },
      body: JSON.stringify({ code: mailReplay.code }),
    })
  );

  // 5. link_first
  const emailLinkFirst = 'neg-link-first@example.test';
  const reqLinkFirst = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailLinkFirst }),
    })
  );
  assert.equal(reqLinkFirst.status, 202);
  const cookieLinkFirst = parseSetCookie(
    reqLinkFirst.headers.get('set-cookie')
  );
  const mailLinkFirst = await awaitSignInMail(emailLinkFirst);
  // Follow the link first
  const resLinkFirstCallback = await app.fetch(
    new Request(mailLinkFirst.link, {
      method: 'GET',
      redirect: 'manual',
    })
  );
  assert.equal(resLinkFirstCallback.status, 303);
  // Now submit the code
  const resLinkFirst = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieLinkFirst,
      },
      body: JSON.stringify({ code: mailLinkFirst.code }),
    })
  );

  // 6. locked and link_after_lock
  const emailLock = 'neg-lock@example.test';
  const reqLock = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailLock }),
    })
  );
  assert.equal(reqLock.status, 202);
  const cookieLock = parseSetCookie(reqLock.headers.get('set-cookie'));
  const mailLock = await awaitSignInMail(emailLock);
  const badCode = mailLock.code === '111111' ? '222222' : '111111';

  // Submit 10 wrong codes to exhaust budget
  for (let i = 0; i < 10; i++) {
    const r = await app.fetch(
      new Request(`${serviceOrigin}/api/auth/code`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieLock,
        },
        body: JSON.stringify({ code: badCode }),
      })
    );
    assert.equal(r.status, 401);
  }

  // 11th attempt with the RIGHT code -> 401 (locked)
  const resLocked = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieLock,
      },
      body: JSON.stringify({ code: mailLock.code }),
    })
  );

  // Magic link after lock -> 303 (link_after_lock)
  const resLinkAfterLock = await app.fetch(
    new Request(mailLock.link, {
      method: 'GET',
      redirect: 'manual',
    })
  );

  // 7. wrong_content_type
  const resWrongContentType = await app.fetch(
    new Request(`${serviceOrigin}/api/auth/code`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        cookie: cookieWrong,
      },
      body: JSON.stringify({ code: '123456' }),
    })
  );

  // Assert status codes
  assert.equal(resWrong.status, 401, 'wrong status mismatch');
  assert.equal(resNoCookie.status, 401, 'no_cookie status mismatch');
  assert.equal(
    resUnknownRequest.status,
    401,
    'unknown_request status mismatch'
  );
  assert.equal(resReplay.status, 401, 'replay status mismatch');
  assert.equal(resLinkFirst.status, 401, 'link_first status mismatch');
  assert.equal(resLocked.status, 401, 'locked status mismatch');
  assert.equal(resLinkAfterLock.status, 303, 'link_after_lock status mismatch');
  assert.equal(
    resWrongContentType.status,
    400,
    'wrong_content_type status mismatch'
  );

  // Verify shape_equal across the 401 bodies (once instance is deleted)
  const bodies401 = await Promise.all(
    [
      resWrong,
      resNoCookie,
      resUnknownRequest,
      resReplay,
      resLinkFirst,
      resLocked,
    ].map(async (r) => {
      const b = (await r.json()) as Record<string, unknown>;
      assert.equal(b['code'], 'sign_in_code_failed');
      delete b['instance'];
      return JSON.stringify(b);
    })
  );

  const canonical401 = bodies401[0];
  let shapeEqual = true;
  for (let i = 1; i < bodies401.length; i++) {
    if (bodies401[i] !== canonical401) {
      shapeEqual = false;
      break;
    }
  }
  assert.equal(shapeEqual, true, '401 bodies are not shape equal');

  console.log(
    `EMAIL_CODE_NEG_OK wrong=${resWrong.status} no_cookie=${resNoCookie.status} unknown_request=${resUnknownRequest.status} replay=${resReplay.status} link_first=${resLinkFirst.status} locked=${resLocked.status} link_after_lock=${resLinkAfterLock.status} shape_equal=${shapeEqual} wrong_content_type=${resWrongContentType.status}`
  );

  console.log('EMAIL_CODE_SIGN_IN_PATH_OK');
} finally {
  service.stop();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
