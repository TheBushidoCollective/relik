import { describe, expect, test } from 'bun:test';
import { lookupShares } from '../src/private/direct-share.ts';
import { PrivateApiError, problemMessage } from '../src/private/fingerprint-input.ts';
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
    const deps = fake({ results: [{ email: 'a@example.test', party: null, standing: null, invites }] }, capture);
    expect(await lookupShares(deps, 'abc', ['a@example.test'], new Set())).toEqual([
      { kind: 'unregistered', email: 'a@example.test', invites },
    ]);
    expect(capture).toEqual(['https://example.test/api/relics/abc/grants/lookup', JSON.stringify({ emails: ['a@example.test'] })]);
  });

  test('rejects a lookup answer for a different address', async () => {
    const deps = fake({ results: [{ email: 'other@example.test', party: null, standing: null, invites: [] }] }, []);
    await expect(lookupShares(deps, 'abc', ['a@example.test'], new Set())).rejects.toThrow('invalid lookup response');
  });

  test('describes an existing grant without treating it as success', () => {
    expect(problemMessage(new PrivateApiError(409, 'grant_exists'))).toBe('This person can already read this relik.');
  });
});
