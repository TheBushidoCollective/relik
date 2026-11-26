import { describe, expect, test } from 'bun:test';
import {
  decodeBase64url,
  inviteRecipient,
  parseInviteFragment,
  unwrapVersionKey,
  generateIdentityKeys,
  identityIdOf,
  encodeBase64url,
} from '@relic/format/private';
import {
  lookupShares,
  parseShareFragment,
  shareBatch,
} from '../src/private/direct-share.ts';
import {
  PrivateApiError,
  problemMessage,
} from '../src/private/fingerprint-input.ts';
import type { ViewerDeps } from '../src/viewer.ts';

function fake(answer: unknown, capture: string[]): ViewerDeps {
  return {
    serviceOrigin: 'https://example.test',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      capture.push(String(url), String(init?.body));
      return Response.json(answer);
    },
  } as ViewerDeps;
}

describe('direct share lookup', () => {
  test('sends addresses to the owner lookup and preserves invitation state', async () => {
    const capture: string[] = [];
    const invites = [{ invite_id: 'a', expires_at: '2026-12-01T00:00:00Z' }];
    const deps = fake(
      {
        results: [
          { email: 'a@example.test', party: null, standing: null, invites },
        ],
      },
      capture
    );
    expect(
      await lookupShares(deps, 'abc', ['a@example.test'], new Set())
    ).toEqual([{ kind: 'unregistered', email: 'a@example.test', invites }]);
    expect(capture).toEqual([
      'https://example.test/api/relics/abc/grants/lookup',
      JSON.stringify({ emails: ['a@example.test'] }),
    ]);
  });

  test('rejects a lookup answer for a different address', async () => {
    const deps = fake(
      {
        results: [
          {
            email: 'other@example.test',
            party: null,
            standing: null,
            invites: [],
          },
        ],
      },
      []
    );
    await expect(
      lookupShares(deps, 'abc', ['a@example.test'], new Set())
    ).rejects.toThrow('invalid lookup response');
  });

  test('describes an existing grant without treating it as success', () => {
    expect(problemMessage(new PrivateApiError(409, 'grant_exists'))).toBe(
      'This person can already read this relik.'
    );
  });
});

test('lookup refuses forged owner and mismatched identity address', async () => {
  const keys = await generateIdentityKeys();
  const id = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const identity = {
    identity_id: id,
    email: 'other@example.test',
    kem_public_key: encodeBase64url(keys.kemPublicKey),
    sig_public_key: encodeBase64url(keys.sigPublicKey),
    created_at: '2026-11-01T00:00:00Z',
    retired_at: null,
  };
  const email = 'a@example.test';
  const party = { email, identity };
  for (const standing of ['owner', null]) {
    const deps = fake(
      { results: [{ email, party, standing, invites: [] }] },
      []
    );
    expect(
      await lookupShares(deps, 'abc', [email], new Set(), 'b'.repeat(64))
    ).toEqual([{ kind: 'unverified', email }]);
  }
});

test('prefill decodes once, deduplicates and caps addresses', () => {
  expect(
    parseShareFragment(
      '#to=one%40example.test%2C%20ONE%40example.test%2Ctwo%40example.test'
    )
  ).toEqual(['one@example.test', 'two@example.test']);
  expect(parseShareFragment('#to=%ZZ')).toEqual([]);
  expect(
    parseShareFragment(
      `#to=${Array.from({ length: 21 }, (_, i) => `${i}%40example.test`).join('%2C')}`
    )
  ).toHaveLength(20);
});

test('invite key stays in the link and opens each returned wrap', async () => {
  const calls: string[] = [];
  const drafts: Record<string, unknown>[] = [];
  const keys = new Map<number, Uint8Array>([
    [1, new Uint8Array(16).fill(1)],
    [2, new Uint8Array(16).fill(2)],
  ]);
  const owner = 'a'.repeat(64);
  const deps = {
    serviceOrigin: 'https://example.test',
    locationHref: 'https://example.test/0123456789abcdefghjkmnpqrs',
    now: () => 1_700_000_000_000,
    fetch: async (_url: unknown, init: RequestInit) => {
      calls.push(String(init.body));
      return Response.json({ grants: [], invites: [] });
    },
    privateKeys: {
      attest: async (
        _deps: unknown,
        request: { build(id: string): Record<string, unknown>[] }
      ) => {
        drafts.push(...request.build(owner));
        return {
          identity: { identityId: owner },
          bundle: { statements: drafts },
        };
      },
      fetchVersionKey: async (
        _deps: unknown,
        _id: unknown,
        version: number
      ) => ({
        key: keys.get(version),
        keyJson: { owner: { identity: { identity_id: owner } } },
      }),
    },
  } as unknown as ViewerDeps;
  const links = await shareBatch(deps, {
    relicId: '0123456789abcdefghjkmnpqrs',
    versions: [1, 2],
    relicExpiresAt: 1_800_000_000_000,
    grants: [],
    invites: [{ email: 'new@example.test', days: 7 }],
    origin: 'https://example.test',
  });
  const link = links[0];
  expect(link).toBeDefined();
  if (!link) throw new Error('missing link');
  const url = new URL(link.url);
  const d = parseInviteFragment(url.hash.slice(1));
  expect(d).toBeDefined();
  expect(calls[0]).not.toContain(url.hash.slice(3));
  const statement = drafts[0]?.statement as { invite_public_key: string };
  const recipient = await inviteRecipient(
    d!,
    decodeBase64url(statement.invite_public_key)
  );
  const body = JSON.parse(calls[0]!) as {
    wraps: { version: number; enc: string; ct: string }[];
  };
  expect(body.wraps).toHaveLength(2);
  for (const wrap of body.wraps) {
    expect(
      await unwrapVersionKey({
        recipient,
        relicId: '0123456789abcdefghjkmnpqrs',
        version: wrap.version,
        enc: wrap.enc,
        ct: wrap.ct,
      })
    ).toEqual(keys.get(wrap.version)!);
  }
});

test('an invitation key is never written to storage or sent in a body', async () => {
  const writes: string[] = [];
  const originals = {
    local: globalThis.localStorage,
    session: globalThis.sessionStorage,
  };
  const recorder = {
    setItem: (key: string) => writes.push(key),
    getItem: () => null,
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: recorder,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: recorder,
    configurable: true,
  });
  try {
    const bodies: string[] = [];
    const owner = 'b'.repeat(64);
    const keys = new Map<number, Uint8Array>([[1, new Uint8Array(16).fill(7)]]);
    const deps = {
      serviceOrigin: 'https://example.test',
      locationHref: 'https://example.test/0123456789abcdefghjkmnpqrs',
      now: () => 1_700_000_000_000,
      fetch: async (_url: unknown, init: RequestInit) => {
        bodies.push(String(init.body));
        return Response.json({});
      },
      privateKeys: {
        attest: async (
          _deps: unknown,
          request: { build(id: string): Record<string, unknown>[] }
        ) => ({
          identity: { identityId: owner },
          bundle: { statements: request.build(owner) },
        }),
        fetchVersionKey: async () => ({
          key: keys.get(1),
          keyJson: { owner: { identity: { identity_id: owner } } },
        }),
      },
    } as unknown as ViewerDeps;
    const [link] = await shareBatch(deps, {
      relicId: '0123456789abcdefghjkmnpqrs',
      versions: [1],
      relicExpiresAt: 1_800_000_000_000,
      grants: [],
      invites: [{ email: 'x@example.test', days: 7 }],
      origin: 'https://example.test',
    });
    expect(link).toBeDefined();
    const fragment = new URL(link!.url).hash.slice(3);
    expect(writes).toEqual([]);
    for (const body of bodies) expect(body).not.toContain(fragment);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originals.local,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: originals.session,
      configurable: true,
    });
  }
});
