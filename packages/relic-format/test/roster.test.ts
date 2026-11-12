import { describe, expect, test } from 'bun:test';
import {
  advanceRosterFloor,
  generateIdentityKeys,
  type IdentityKeys,
  rosterAdmits,
  type RosterFloor,
  RosterStaleError,
  signStatement,
  type StatementKind,
  statementBytes,
  verifySignedStatement,
} from '../src/private.ts';

const RELIC = '0123456789abcdefghjkmnpqrs';
const GRANTEE = 'ab'.repeat(32);

async function sign(
  keys: IdentityKeys,
  kind: StatementKind,
  statement: Record<string, unknown>
): Promise<{ statement: Record<string, unknown>; identity_signature: string }> {
  const signature = await signStatement(
    async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.sig.privateKey,
          new Uint8Array(bytes)
        )
      ),
    statementBytes(kind, statement as never)
  );
  return { statement, identity_signature: signature };
}

function revocation(at: number, ownerIdentityId: string) {
  return {
    at,
    grantee_identity_id: GRANTEE,
    owner_identity_id: ownerIdentityId,
    relic_id: RELIC,
  };
}

describe('verifySignedStatement', () => {
  test('returns the parsed statement when the owner key signed it exactly', async () => {
    const owner = await generateIdentityKeys();
    const at = Date.now();
    const signed = await sign(
      owner,
      'revocation',
      revocation(at, owner.identityId)
    );
    const parsed = await verifySignedStatement(
      'revocation',
      signed,
      owner.sigPublicKey
    );
    expect(parsed?.at).toBe(at);
  });

  test('is undefined under another key, for a changed field, and for an extra field', async () => {
    const owner = await generateIdentityKeys();
    const other = await generateIdentityKeys();
    const at = Date.now();
    const signed = await sign(
      owner,
      'revocation',
      revocation(at, owner.identityId)
    );
    expect(
      await verifySignedStatement('revocation', signed, other.sigPublicKey)
    ).toBeUndefined();
    expect(
      await verifySignedStatement(
        'revocation',
        { ...signed, statement: { ...signed.statement, at: at + 1 } },
        owner.sigPublicKey
      )
    ).toBeUndefined();
    expect(
      await verifySignedStatement(
        'revocation',
        { ...signed, statement: { ...signed.statement, extra: 1 } },
        owner.sigPublicKey
      )
    ).toBeUndefined();
    expect(
      await verifySignedStatement('revocation', signed, owner.sigPublicKey)
    ).toBeDefined();
  });
});

describe('advanceRosterFloor', () => {
  test('a verified revocation excludes every statement at or before it, permanently', () => {
    const floor = advanceRosterFloor(
      {},
      { grants: { g: { at: 200, revoked: true } } }
    );
    // A later answer that lists the old grant live is not admitted.
    const next = advanceRosterFloor(floor, {
      grants: { g: { at: 100, revoked: false } },
    });
    expect(rosterAdmits(next.grants?.['g'], 100)).toBe(false);
    expect(next.grants?.['g']).toEqual({ at: 200, revoked: true });
  });

  test('a live statement newer than the revocation is a new authorization and is admitted', () => {
    const floor = advanceRosterFloor(
      {},
      { grants: { g: { at: 200, revoked: true } } }
    );
    const next = advanceRosterFloor(floor, {
      grants: { g: { at: 300, revoked: false } },
    });
    expect(rosterAdmits(next.grants?.['g'], 300)).toBe(true);
  });

  test('a revocation older than a live statement already accepted is refused', () => {
    const floor = advanceRosterFloor(
      {},
      { devices: { d: { at: 500, revoked: false } } }
    );
    expect(() =>
      advanceRosterFloor(floor, { devices: { d: { at: 400, revoked: true } } })
    ).toThrow(RosterStaleError);
  });

  test('an older live statement is refused, and the floor is not changed', () => {
    const floor: RosterFloor = advanceRosterFloor(
      {},
      { devices: { d: { at: 500, revoked: false } } }
    );
    expect(() =>
      advanceRosterFloor(floor, { devices: { d: { at: 499, revoked: false } } })
    ).toThrow(RosterStaleError);
    expect(floor.devices?.['d']).toEqual({ at: 500, revoked: false });
  });

  test('an older designation is refused, and a newer removal replaces it', () => {
    const floor = advanceRosterFloor(
      {},
      { designation: { at: 500, removed: false } }
    );
    expect(() =>
      advanceRosterFloor(floor, { designation: { at: 400, removed: false } })
    ).toThrow(RosterStaleError);
    const next = advanceRosterFloor(floor, {
      designation: { at: 600, removed: true },
    });
    expect(next.designation).toEqual({ at: 600, removed: true });
  });

  test('an answer with no signed designation is refused once a designation is accepted', () => {
    const floor = advanceRosterFloor(
      {},
      { designation: { at: 500, removed: false } }
    );
    expect(() => advanceRosterFloor(floor, { designation: null })).toThrow(
      RosterStaleError
    );
  });

  test('an answer that does not speak to designations leaves the designation alone', () => {
    const floor = advanceRosterFloor(
      {},
      { designation: { at: 500, removed: false } }
    );
    expect(advanceRosterFloor(floor, { devices: {} }).designation).toEqual({
      at: 500,
      removed: false,
    });
  });

  test('two designations at the same time that disagree are refused', () => {
    const floor = advanceRosterFloor(
      {},
      { designation: { at: 500, removed: false } }
    );
    expect(() =>
      advanceRosterFloor(floor, { designation: { at: 500, removed: true } })
    ).toThrow(RosterStaleError);
  });
});
