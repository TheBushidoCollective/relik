/**
 * The composer's signer resolution: a private signer who cannot open the
 * relik is granted in the same tap, and an address with no key is refused
 * before any request names it. Real identity keys; the lookup is a fake.
 */

import { describe, expect, test } from 'bun:test';
import {
  encodeBase64url,
  generateIdentityKeys,
  identityFingerprint,
  identityIdOf,
  type IdentityKeys,
  type PartyJSON,
} from '@relic/format/private';
import { grantNotice, resolveSigners } from '../src/signing/composer.ts';
import type { ViewerDeps } from '../src/viewer.ts';

const ORIGIN = 'https://relik.test';
const RELIC = '0123456789abcdefghjkmnpqrs';

async function partyFor(
  email: string
): Promise<{ party: PartyJSON; keys: IdentityKeys }> {
  const keys = await generateIdentityKeys();
  const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  return {
    keys,
    party: {
      email,
      identity: {
        identity_id: identityId,
        email,
        kem_public_key: encodeBase64url(keys.kemPublicKey),
        sig_public_key: encodeBase64url(keys.sigPublicKey),
        created_at: '2026-11-02T00:00:00Z',
        retired_at: null,
      },
    },
  };
}

/** A lookup stand-in that answers each address from a table, and records what it was asked. */
function lookupDeps(answers: Record<string, unknown>): {
  deps: ViewerDeps;
  asked: string[][];
} {
  const asked: string[][] = [];
  const deps = {
    serviceOrigin: ORIGIN,
    fetch: async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        emails: string[];
      };
      asked.push(body.emails);
      return Response.json({
        results: body.emails.map(
          (email) =>
            answers[email] ?? {
              email,
              party: null,
              standing: null,
              invites: [],
            }
        ),
      });
    },
  } as unknown as ViewerDeps;
  return { deps, asked };
}

describe('a private signer who cannot open the relik is granted in the same tap', () => {
  test('a registered address is granted, with the fingerprint to check, and signs as its identity', async () => {
    const newcomer = await partyFor('new@example.test');
    const { deps, asked } = lookupDeps({
      'new@example.test': {
        email: 'new@example.test',
        party: newcomer.party,
        standing: null,
        invites: [],
      },
    });
    const resolved = await resolveSigners(
      { deps, relicId: RELIC, grants: [] },
      ['new@example.test']
    );
    expect(resolved.kind).toBe('ready');
    if (resolved.kind !== 'ready') return;
    expect(asked).toEqual([['new@example.test']]);
    expect(resolved.signers).toEqual([
      {
        email: 'new@example.test',
        identity_id: newcomer.party.identity.identity_id,
      },
    ]);
    expect(resolved.grants).toHaveLength(1);
    expect(resolved.grants[0]?.fingerprint).toBe(
      await identityFingerprint(
        newcomer.party.identity.identity_id,
        'new@example.test'
      )
    );
    expect(grantNotice(resolved.grants)).toContain(
      'Relik will grant new@example.test access when you send.'
    );
  });

  test('an address with no key is refused, and nothing is granted', async () => {
    const { deps } = lookupDeps({});
    const resolved = await resolveSigners(
      { deps, relicId: RELIC, grants: [] },
      ['nobody@example.test']
    );
    expect(resolved).toEqual({
      kind: 'refused',
      message:
        "nobody@example.test can't open this relik yet, so they can't be asked to sign. Invite them in Access first.",
    });
  });

  test('an address that holds only an invitation is granted when named to sign', async () => {
    const invited = await partyFor('ben@example.test');
    const { deps } = lookupDeps({
      'ben@example.test': {
        email: 'ben@example.test',
        party: invited.party,
        standing: 'invited',
        invites: [],
      },
    });
    const resolved = await resolveSigners(
      { deps, relicId: RELIC, grants: [] },
      ['ben@example.test']
    );
    expect(resolved.kind).toBe('ready');
  });

  test('the owner and a current reader are known without a lookup', async () => {
    const reader = await partyFor('ana@example.test');
    const readerId = reader.party.identity.identity_id;
    const { deps, asked } = lookupDeps({});
    const resolved = await resolveSigners(
      {
        deps,
        relicId: RELIC,
        grants: [{ email: 'ana@example.test', identityId: readerId }],
        owner: { identityId: 'a'.repeat(64), email: 'owner@example.test' },
      },
      ['ana@example.test', 'owner@example.test']
    );
    expect(asked).toEqual([]);
    expect(resolved).toEqual({
      kind: 'ready',
      signers: [
        { email: 'ana@example.test', identity_id: readerId },
        { email: 'owner@example.test', identity_id: 'a'.repeat(64) },
      ],
      grants: [],
    });
  });

  test('a refusal of one address refuses the whole send, even when another would be granted', async () => {
    const newcomer = await partyFor('new@example.test');
    const { deps } = lookupDeps({
      'new@example.test': {
        email: 'new@example.test',
        party: newcomer.party,
        standing: null,
        invites: [],
      },
    });
    const resolved = await resolveSigners(
      { deps, relicId: RELIC, grants: [] },
      ['new@example.test', 'nobody@example.test']
    );
    expect(resolved.kind).toBe('refused');
  });
});
