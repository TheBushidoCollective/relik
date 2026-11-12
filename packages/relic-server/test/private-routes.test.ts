import { beforeEach, describe, expect, test } from 'bun:test';
import { encryptedSize } from '@relic/format';
import { createApp, type RelicApp } from '../src/app.ts';
import { MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';
import { NOW, RELIC_ID, privateRelic } from './private-fixtures.ts';

let app: RelicApp;

beforeEach(() => {
  app = createApp({
    store: new MemoryStore(),
    storage: new MemoryStorage(),
    now: () => NOW,
    operatorTokens: new Map([['jason', 'operator-secret']]),
  });
});

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', '198.51.100.20, 130.211.0.1');
  return new Request(`https://relic.example${path}`, { ...init, headers });
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** A grant body for a private publish, without any device authority. */
async function privateGrantBody(overrides: Record<string, unknown> = {}) {
  const challenge = await body(
    await app.fetch(req('/api/challenge', { method: 'POST' }))
  );
  return {
    challenge_nonce: challenge['challenge_nonce'],
    relic_id: RELIC_ID,
    renderer_class: 'markdown',
    publishing_client: 'relic-test/1',
    access: 'private',
    declared_size_bytes: 10,
    declared_ciphertext_bytes: encryptedSize(10),
    ...overrides,
  };
}

describe('the challenge advertises the private-share lifetime bounds', () => {
  test('default and maximum TTL, in days', async () => {
    const response = await app.fetch(req('/api/challenge', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect((await body(response))['private_shares']).toEqual({
      default_ttl_days: 30,
      max_ttl_days: 365,
    });
  });
});

describe('the regulated profile refuses what it forbids before anything is stored', () => {
  test('a non-empty title on a private publish is refused', async () => {
    const response = await app.fetch(
      req(
        '/api/grant',
        json(await privateGrantBody({ title: 'Q3 board pack' }))
      )
    );
    expect(response.status).toBe(400);
    expect((await body(response))['code']).toBe('private_policy_violation');
    expect(await app.store.getRelic(RELIC_ID)).toBeUndefined();
  });

  test('a lifetime above the private maximum is refused', async () => {
    const response = await app.fetch(
      req('/api/grant', json(await privateGrantBody({ ttl_days: 400 })))
    );
    expect(response.status).toBe(400);
    expect((await body(response))['code']).toBe('private_policy_violation');
    expect(await app.store.getRelic(RELIC_ID)).toBeUndefined();
  });

  test('a private publish without a certified device is refused', async () => {
    const response = await app.fetch(
      req('/api/grant', json(await privateGrantBody()))
    );
    expect(response.status).toBe(400);
    expect((await body(response))['code']).toBe('invalid_device');
    expect(await app.store.getRelic(RELIC_ID)).toBeUndefined();
  });
});

describe('private-share routes refuse callers without a session', () => {
  test('an attestation nonce needs a signed-in session', async () => {
    const response = await app.fetch(
      req('/api/attest/nonce', json({ purpose: 'grant' }))
    );
    expect(response.status).toBe(401);
    expect((await body(response))['code']).toBe('sign_in_required');
  });

  test('the identity state needs a signed-in session', async () => {
    const response = await app.fetch(req('/api/identity'));
    expect(response.status).toBe(401);
    expect((await body(response))['code']).toBe('sign_in_required');
  });

  test('the access view of a private relic needs a signed-in session', async () => {
    await app.store.putRelic(privateRelic({ id: RELIC_ID }));
    const response = await app.fetch(req(`/api/relics/${RELIC_ID}/access`));
    expect(response.status).toBe(401);
    expect((await body(response))['code']).toBe('sign_in_required');
  });

  test('a private relic delivers no key and no mint to an anonymous caller', async () => {
    await app.store.putRelic(privateRelic({ id: RELIC_ID }));
    const mint = await app.fetch(req(`/api/relics/${RELIC_ID}/mint`, json({})));
    expect(mint.status).toBe(403);
    expect((await body(mint))['code']).toBe('private_access_denied');

    const key = await app.fetch(
      req(`/api/relics/${RELIC_ID}/versions/1/key`, json({}))
    );
    expect(key.status).toBe(401);
    expect((await body(key))['code']).toBe('sign_in_required');
  });

  test('a mint with a wrong publish token is refused, not served', async () => {
    await app.store.putRelic(privateRelic({ id: RELIC_ID }));
    const response = await app.fetch(
      req(
        `/api/relics/${RELIC_ID}/mint`,
        json({ publish_token: 'not-the-token' })
      )
    );
    expect(response.status).toBe(403);
    expect((await body(response))['code']).toBe('invalid_publish_token');
  });
});

describe('device enrollment is refused on a malformed proof', () => {
  test('an empty enrollment body names the device refusal', async () => {
    const response = await app.fetch(req('/api/devices/enrollments', json({})));
    expect(response.status).toBe(400);
    expect((await body(response))['code']).toBe('invalid_device');
  });
});
