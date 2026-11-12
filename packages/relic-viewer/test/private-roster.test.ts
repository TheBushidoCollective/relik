/**
 * What the browser admits to a wrap when the service answers about the owner's
 * roster (PS2-02, PS-05). These drive `verifiedRecipients`, the call a revoke or
 * republish makes before it wraps a version key, with real owner keys. A
 * revocation or designation counts only when the owner signed it, and what the
 * service asserts alone never moves the floor this browser keeps for the owner.
 */

import { describe, expect, test } from 'bun:test';
import {
  encodeBase64url,
  generateIdentityKeys,
  type GrantJSON,
  type IdentityKeys,
  identityFingerprint,
  type RecoveryJSON,
  type SignedStatementBody,
  signStatement,
  type StatementKind,
  statementBytes,
} from '@relic/format/private';
import type { UnlockedIdentity } from '../src/private/keys.ts';
import { verifiedRecipients } from '../src/private/rekey.ts';
import { VerificationRefusedError } from '../src/private/refusal.ts';

const RELIC = '0123456789abcdefghjkmnpqrs';

interface Person {
  readonly keys: IdentityKeys;
  readonly email: string;
}

async function personOf(email: string): Promise<Person> {
  return { keys: await generateIdentityKeys(), email };
}

/** The unlocked identity the browser checks against. Only its public keys and signing key are read. */
function unlocked(owner: Person): UnlockedIdentity {
  return {
    identityId: owner.keys.identityId,
    kemPublicKey: owner.keys.kemPublicKey,
    sigPublicKey: owner.keys.sigPublicKey,
  } as unknown as UnlockedIdentity;
}

async function signedBy(
  person: Person,
  kind: StatementKind,
  statement: Record<string, unknown>
): Promise<SignedStatementBody> {
  const identity_signature = await signStatement(
    async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          person.keys.sig.privateKey,
          new Uint8Array(bytes)
        )
      ),
    statementBytes(kind, statement as never)
  );
  return { statement, identity_signature };
}

function partyOf(person: Person) {
  return {
    email: person.email,
    identity: {
      identity_id: person.keys.identityId,
      email: person.email,
      kem_public_key: encodeBase64url(person.keys.kemPublicKey),
      sig_public_key: encodeBase64url(person.keys.sigPublicKey),
      created_at: new Date().toISOString(),
      retired_at: null,
    },
  };
}

async function grantOf(
  owner: Person,
  grantee: Person,
  relicId: string,
  at: number,
  over: {
    revoked_at?: string | null;
    revocation?: SignedStatementBody | null;
  } = {}
): Promise<GrantJSON> {
  const statement = {
    at,
    fingerprint_typed: await identityFingerprint(
      grantee.keys.identityId,
      grantee.email
    ),
    grantee_email: grantee.email,
    grantee_identity_id: grantee.keys.identityId,
    owner_identity_id: owner.keys.identityId,
    relic_id: relicId,
    versions: [1],
  };
  return {
    statement,
    identity_signature: (await signedBy(owner, 'grant', statement))
      .identity_signature,
    granted_at: new Date(at).toISOString(),
    revoked_at: null,
    grantee: partyOf(grantee),
    ...over,
  };
}

async function revocationOf(
  by: Person,
  owner: Person,
  grantee: Person,
  relicId: string,
  at: number
): Promise<SignedStatementBody> {
  return signedBy(by, 'revocation', {
    at,
    grantee_identity_id: grantee.keys.identityId,
    owner_identity_id: owner.keys.identityId,
    relic_id: relicId,
  });
}

async function holderOf(
  owner: Person,
  holder: Person,
  at: number
): Promise<RecoveryJSON> {
  const designation = await signedBy(owner, 'recovery_designation', {
    at,
    fingerprint_typed: await identityFingerprint(
      holder.keys.identityId,
      holder.email
    ),
    owner_identity_id: owner.keys.identityId,
    recovery_email: holder.email,
    recovery_identity_id: holder.keys.identityId,
  });
  return {
    ...partyOf(holder),
    designated_at: new Date(at).toISOString(),
    designation,
  } as unknown as RecoveryJSON;
}

async function removalOf(
  owner: Person,
  at: number
): Promise<SignedStatementBody> {
  return signedBy(owner, 'recovery_designation', {
    at,
    fingerprint_typed: null,
    owner_identity_id: owner.keys.identityId,
    recovery_email: null,
    recovery_identity_id: null,
  });
}

/** The roles a republish would wrap to, in order. */
async function rolesFor(
  owner: Person,
  relicId: string,
  parts: {
    grants?: readonly GrantJSON[];
    recovery?: RecoveryJSON | null;
    recovery_statement?: SignedStatementBody | null;
  }
): Promise<string[]> {
  const recipients = await verifiedRecipients(
    unlocked(owner),
    relicId,
    {
      devices: [],
      grants: parts.grants ?? [],
      recovery: parts.recovery ?? null,
      recovery_statement: parts.recovery_statement ?? null,
    },
    'no-such-identity',
    Date.now()
  );
  return recipients.map((recipient) => recipient.role);
}

describe('a grant the owner revoked is never wrapped to (PS2-02)', () => {
  test('a revoked grant the service lists live again is not wrapped to', async () => {
    const owner = await personOf('owner@example.com');
    const grantee = await personOf('reader@example.com');
    const at = Date.now() - 60_000;
    const revokedAt = Date.now() - 1_000;
    const revoked = await grantOf(owner, grantee, RELIC, at, {
      revoked_at: new Date(revokedAt).toISOString(),
      revocation: await revocationOf(owner, owner, grantee, RELIC, revokedAt),
    });
    expect(await rolesFor(owner, RELIC, { grants: [revoked] })).toEqual([
      'owner',
    ]);
    expect(
      await rolesFor(owner, RELIC, {
        grants: [await grantOf(owner, grantee, RELIC, at)],
      })
    ).toEqual(['owner']);
  });

  test('a live grant the service flags revoked without a signed revocation is still wrapped to', async () => {
    const owner = await personOf('owner@example.com');
    const grantee = await personOf('reader@example.com');
    const flagged = await grantOf(owner, grantee, RELIC, Date.now() - 60_000, {
      revoked_at: new Date().toISOString(),
      revocation: null,
    });
    expect(await rolesFor(owner, RELIC, { grants: [flagged] })).toEqual([
      'owner',
      'reader',
    ]);
  });

  test('a revoked entry whose revocation does not verify is ignored and does not abort', async () => {
    const owner = await personOf('owner@example.com');
    const grantee = await personOf('reader@example.com');
    const attacker = await personOf('attacker@example.com');
    const forged = await grantOf(owner, grantee, RELIC, Date.now() - 60_000, {
      revoked_at: new Date().toISOString(),
      revocation: await revocationOf(
        attacker,
        owner,
        grantee,
        RELIC,
        Date.now() - 1_000
      ),
    });
    expect(await rolesFor(owner, RELIC, { grants: [forged] })).toEqual([
      'owner',
      'reader',
    ]);
  });
});

describe('a recovery designation never goes back on the floor (PS-05)', () => {
  test('an older designation than the one accepted is refused', async () => {
    const owner = await personOf('owner@example.com');
    const holder = await personOf('holder@example.com');
    const newer = Date.now() - 1_000;
    expect(
      await rolesFor(owner, RELIC, {
        recovery: await holderOf(owner, holder, newer),
      })
    ).toEqual(['owner', 'recovery']);
    await expect(
      rolesFor(owner, RELIC, {
        recovery: await holderOf(owner, holder, newer - 60_000),
      })
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });

  test('a removal the owner signed is no recovery recipient, even when an older answer still names the holder', async () => {
    const owner = await personOf('owner@example.com');
    const holder = await personOf('holder@example.com');
    const designated = Date.now() - 60_000;
    const removed = Date.now() - 1_000;
    expect(
      await rolesFor(owner, RELIC, {
        recovery: await holderOf(owner, holder, designated),
        recovery_statement: await removalOf(owner, removed),
      })
    ).toEqual(['owner']);
    await expect(
      rolesFor(owner, RELIC, {
        recovery: await holderOf(owner, holder, designated),
        recovery_statement: null,
      })
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });
});
