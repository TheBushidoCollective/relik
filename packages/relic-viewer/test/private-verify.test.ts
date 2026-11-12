/**
 * Direct tests of the browser's verifiers for what the service sends the
 * owner: the recipient set a republish wraps to, and the recovery holder a
 * repair wraps to. Every statement is signed with real keys, so each refusal
 * is a signature, binding or fingerprint check failing, not a fixture shape.
 */

import { describe, expect, test } from 'bun:test';
import {
  deviceFingerprint,
  deviceIdOf,
  encodeBase64url,
  type DevicePublicJSON,
  generateIdentityKeys,
  type GrantJSON,
  identityFingerprint,
  identityIdOf,
  type IdentityKeys,
  kemKeyIdOf,
  type PartyJSON,
  type RecoveryJSON,
  signStatement,
  type StatementKind,
  type StatementMap,
  statementBytes,
} from '@relic/format/private';
import type { UnlockedIdentity } from '../src/private/keys.ts';
import type { PrivateKeyOps } from '../src/private/ops.ts';
import { backfillHolder } from '../src/private/recovery.ts';
import { verifiedRecipients } from '../src/private/rekey.ts';
import { VerificationRefusedError } from '../src/private/refusal.ts';
import { RecipientMissingError } from '../src/private/open.ts';
import type { ViewerDeps } from '../src/viewer.ts';

const ORIGIN = 'https://relik.test';
const NOW = Date.UTC(2026, 10, 11);
const DAY = 24 * 60 * 60 * 1000;
const RELIC_A = '00000000000000000000000001';
const RELIC_B = '00000000000000000000000002';

/** A person's keys and the public party record the service would send. */
interface Person {
  readonly keys: IdentityKeys;
  readonly identityId: string;
  readonly email: string;
  readonly party: PartyJSON;
}

async function personOf(email: string): Promise<Person> {
  const keys = await generateIdentityKeys();
  const identityId = await identityIdOf(keys.kemPublicKey, keys.sigPublicKey);
  return {
    keys,
    identityId,
    email,
    party: {
      email,
      identity: {
        identity_id: identityId,
        email,
        kem_public_key: encodeBase64url(keys.kemPublicKey),
        sig_public_key: encodeBase64url(keys.sigPublicKey),
        created_at: '2026-11-01T00:00:00Z',
        retired_at: null,
      },
    },
  };
}

/** The unlocked form the browser holds for the signed-in owner. */
async function unlockedOf(person: Person): Promise<UnlockedIdentity> {
  const unused = async (): Promise<Uint8Array> => {
    throw new Error('not used by the verifiers');
  };
  return {
    identityId: person.identityId,
    email: person.email,
    kemPublicKey: person.keys.kemPublicKey,
    sigPublicKey: person.keys.sigPublicKey,
    kemKeyId: await kemKeyIdOf(person.keys.kemPublicKey),
    credentialId: 'cred',
    dh: unused,
    sign: unused,
  };
}

async function signWith<K extends StatementKind>(
  keys: IdentityKeys,
  kind: K,
  statement: StatementMap[K]
): Promise<string> {
  return signStatement(
    async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.sig.privateKey,
          new Uint8Array(message)
        )
      ),
    statementBytes(kind, statement)
  );
}

/** An owner-signed grant for one relic, with optional defects to refuse. */
async function grantOf(
  owner: Person,
  grantee: Person,
  relicId: string,
  defects: {
    readonly relicId?: string;
    readonly email?: string;
    readonly fingerprint?: string;
  } = {}
): Promise<GrantJSON> {
  const statement = {
    at: NOW,
    fingerprint_typed:
      defects.fingerprint ??
      (await identityFingerprint(grantee.identityId, grantee.email)),
    grantee_email: defects.email ?? grantee.email,
    grantee_identity_id: grantee.identityId,
    owner_identity_id: owner.identityId,
    relic_id: defects.relicId ?? relicId,
    versions: [1],
  };
  return {
    statement,
    identity_signature: await signWith(owner.keys, 'grant', statement),
    granted_at: '2026-11-11T00:00:00Z',
    revoked_at: null,
    grantee: grantee.party,
  };
}

/** An owner-certified device. The record's fields can be made to differ from the cert. */
async function deviceOf(
  owner: Person,
  notAfter: number,
  record: { readonly label?: string; readonly notAfter?: number } = {}
): Promise<DevicePublicJSON> {
  const keys = await generateIdentityKeys();
  const deviceId = await deviceIdOf(keys.kemPublicKey, keys.sigPublicKey);
  const kem = encodeBase64url(keys.kemPublicKey);
  const sig = encodeBase64url(keys.sigPublicKey);
  const statement = {
    at: NOW,
    device_fingerprint_typed: await deviceFingerprint(deviceId),
    device_id: deviceId,
    kem_public_key: kem,
    label: 'laptop',
    not_after: notAfter,
    owner_identity_id: owner.identityId,
    sig_public_key: sig,
  };
  return {
    device_id: deviceId,
    owner_identity_id: owner.identityId,
    kem_public_key: kem,
    sig_public_key: sig,
    label: record.label ?? 'laptop',
    backend: 'file',
    not_after: record.notAfter ?? notAfter,
    certified_at: '2026-11-11T00:00:00Z',
    revoked_at: null,
    cert: {
      statement,
      identity_signature: await signWith(owner.keys, 'device_cert', statement),
    },
  };
}

/** An owner-signed recovery designation for a holder. */
async function recoveryOf(
  owner: Person,
  holder: Person,
  defects: {
    readonly signer?: IdentityKeys;
    readonly fingerprint?: string | null;
    readonly owner?: string;
    readonly omitDesignation?: boolean;
  } = {}
): Promise<RecoveryJSON> {
  const statement = {
    at: NOW,
    fingerprint_typed:
      defects.fingerprint === undefined
        ? await identityFingerprint(holder.identityId, holder.email)
        : defects.fingerprint,
    owner_identity_id: defects.owner ?? owner.identityId,
    recovery_email: holder.email,
    recovery_identity_id: holder.identityId,
  };
  const designation = {
    statement,
    identity_signature: await signWith(
      defects.signer ?? owner.keys,
      'recovery_designation',
      statement
    ),
  };
  const base = {
    ...holder.party,
    designated_at: '2026-11-11T00:00:00Z',
  };
  if (defects.omitDesignation) {
    return base as unknown as RecoveryJSON;
  }
  return { ...base, designation };
}

/** The request body backfill sends: the shape this test's service records. */
interface BackfillBody {
  readonly wraps: readonly {
    readonly relic_id: string;
    readonly version: number;
    readonly recipient_key_id: string;
  }[];
}

/**
 * A version-key stand-in. Backfill reads only `key` from the response, so the
 * stand-in returns only that field. The cast is the one place a test narrows a
 * whole function to the seam's type.
 */
function keyStub(
  open: (version: number) => Uint8Array
): PrivateKeyOps['fetchVersionKey'] {
  return (async (_deps: ViewerDeps, _relicId: string, version: number) => ({
    key: open(version),
  })) as unknown as PrivateKeyOps['fetchVersionKey'];
}
interface Recorded {
  readonly url: string;
  readonly body: unknown;
}

/** Deps whose service records every POST and answers backfill with counts. */
function depsWith(
  privateKeys: Partial<PrivateKeyOps>,
  posts: Recorded[]
): ViewerDeps {
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    posts.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ stored: 1, skipped: 0 }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    serviceOrigin: ORIGIN,
    fetch: Object.assign(fetch, { preconnect: () => {} }),
    locationHref: `${ORIGIN}/r`,
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
    now: () => NOW,
    privateKeys: {
      fetchVersionKey: keyStub(() => new Uint8Array(16)),
      ...privateKeys,
    } as PrivateKeyOps,
  };
}

describe('the republish recipient set only includes what the owner signed for this relic', () => {
  test('a grant the owner signed for another relic is refused, not wrapped', async () => {
    const owner = await personOf('sam@example.com');
    const reader = await personOf('ada@example.com');
    const grant = await grantOf(owner, reader, RELIC_A, { relicId: RELIC_B });

    await expect(
      verifiedRecipients(
        await unlockedOf(owner),
        RELIC_A,
        { devices: [], grants: [grant], recovery: null },
        'revoked-id',
        NOW
      )
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });

  test('a grant whose grantee email differs from the party email is refused', async () => {
    const owner = await personOf('sam@example.com');
    const reader = await personOf('ada@example.com');
    const grant = await grantOf(owner, reader, RELIC_A, {
      email: 'mallory@example.com',
    });

    await expect(
      verifiedRecipients(
        await unlockedOf(owner),
        RELIC_A,
        { devices: [], grants: [grant], recovery: null },
        'revoked-id',
        NOW
      )
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });

  test('a grant whose typed fingerprint is for another identity is refused', async () => {
    const owner = await personOf('sam@example.com');
    const reader = await personOf('ada@example.com');
    const other = await personOf('ada@example.com');
    const grant = await grantOf(owner, reader, RELIC_A, {
      fingerprint: await identityFingerprint(other.identityId, other.email),
    });

    await expect(
      verifiedRecipients(
        await unlockedOf(owner),
        RELIC_A,
        { devices: [], grants: [grant], recovery: null },
        'revoked-id',
        NOW
      )
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });

  test('a grant for this relic, with matching email and fingerprint, is wrapped to its grantee', async () => {
    const owner = await personOf('sam@example.com');
    const reader = await personOf('ada@example.com');
    const grant = await grantOf(owner, reader, RELIC_A);

    const recipients = await verifiedRecipients(
      await unlockedOf(owner),
      RELIC_A,
      { devices: [], grants: [grant], recovery: null },
      'revoked-id',
      NOW
    );

    expect(recipients.map((recipient) => recipient.role)).toEqual([
      'owner',
      'reader',
    ]);
  });

  test('a device record whose not_after differs from its certificate is refused', async () => {
    const owner = await personOf('sam@example.com');
    const device = await deviceOf(owner, NOW + DAY, {
      notAfter: NOW + 2 * DAY,
    });

    await expect(
      verifiedRecipients(
        await unlockedOf(owner),
        RELIC_A,
        { devices: [device], grants: [], recovery: null },
        'revoked-id',
        NOW
      )
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });

  test('a device record whose label differs from its certificate is refused', async () => {
    const owner = await personOf('sam@example.com');
    const device = await deviceOf(owner, NOW + DAY, { label: 'phone' });

    await expect(
      verifiedRecipients(
        await unlockedOf(owner),
        RELIC_A,
        { devices: [device], grants: [], recovery: null },
        'revoked-id',
        NOW
      )
    ).rejects.toBeInstanceOf(VerificationRefusedError);
  });

  test('a certified device matching its record is wrapped to', async () => {
    const owner = await personOf('sam@example.com');
    const device = await deviceOf(owner, NOW + DAY);

    const recipients = await verifiedRecipients(
      await unlockedOf(owner),
      RELIC_A,
      { devices: [device], grants: [], recovery: null },
      'revoked-id',
      NOW
    );

    expect(recipients.map((recipient) => recipient.role)).toEqual([
      'owner',
      'device',
    ]);
  });

  test('a recovery holder with no designation is refused with a reason, not a crash', async () => {
    const owner = await personOf('sam@example.com');
    const holder = await recoveryOf(owner, await personOf('ops@example.com'), {
      omitDesignation: true,
    });

    const attempt = verifiedRecipients(
      await unlockedOf(owner),
      RELIC_A,
      { devices: [], grants: [], recovery: holder },
      'revoked-id',
      NOW
    );
    await expect(attempt).rejects.toBeInstanceOf(VerificationRefusedError);
    await expect(attempt).rejects.toThrow(/designation/);
  });
});

describe('a repair wraps only to a recovery holder the owner designated', () => {
  test('a designation signed by another key is refused before anything is wrapped', async () => {
    const owner = await personOf('sam@example.com');
    const attacker = await personOf('mallory@example.com');
    const holder = await personOf('ops@example.com');
    const forged = await recoveryOf(owner, holder, { signer: attacker.keys });
    const posts: Recorded[] = [];
    let fetched = 0;
    const deps = depsWith(
      {
        fetchVersionKey: keyStub(() => {
          fetched += 1;
          return new Uint8Array(16);
        }),
      },
      posts
    );

    await expect(
      backfillHolder(deps, await unlockedOf(owner), forged, [
        { relic_id: RELIC_A, coverage_gaps: [1] },
      ])
    ).rejects.toBeInstanceOf(VerificationRefusedError);
    expect(fetched).toBe(0);
    expect(posts).toEqual([]);
  });

  test('a designation whose fingerprint is for another identity is refused', async () => {
    const owner = await personOf('sam@example.com');
    const holder = await personOf('ops@example.com');
    const other = await personOf('ops@example.com');
    const forged = await recoveryOf(owner, holder, {
      fingerprint: await identityFingerprint(other.identityId, other.email),
    });
    const posts: Recorded[] = [];
    const deps = depsWith({}, posts);

    await expect(
      backfillHolder(deps, await unlockedOf(owner), forged, [
        { relic_id: RELIC_A, coverage_gaps: [1] },
      ])
    ).rejects.toBeInstanceOf(VerificationRefusedError);
    expect(posts).toEqual([]);
  });

  test('a designation naming another owner is refused', async () => {
    const owner = await personOf('sam@example.com');
    const other = await personOf('pat@example.com');
    const holder = await personOf('ops@example.com');
    const forged = await recoveryOf(owner, holder, {
      owner: other.identityId,
    });
    const posts: Recorded[] = [];
    const deps = depsWith({}, posts);

    await expect(
      backfillHolder(deps, await unlockedOf(owner), forged, [
        { relic_id: RELIC_A, coverage_gaps: [1] },
      ])
    ).rejects.toBeInstanceOf(VerificationRefusedError);
    expect(posts).toEqual([]);
  });

  test('a holder with no designation is refused with a reason', async () => {
    const owner = await personOf('sam@example.com');
    const holder = await recoveryOf(owner, await personOf('ops@example.com'), {
      omitDesignation: true,
    });
    const posts: Recorded[] = [];
    const deps = depsWith({}, posts);

    await expect(
      backfillHolder(deps, await unlockedOf(owner), holder, [
        { relic_id: RELIC_A, coverage_gaps: [1] },
      ])
    ).rejects.toThrow(/designation/);
    expect(posts).toEqual([]);
  });

  test('a designated holder is wrapped every version this identity can open, and only those', async () => {
    const owner = await personOf('sam@example.com');
    const holder = await personOf('ops@example.com');
    const designated = await recoveryOf(owner, holder);
    const posts: Recorded[] = [];
    const opened: number[] = [];
    const deps = depsWith(
      {
        fetchVersionKey: keyStub((version) => {
          if (version === 2) throw new RecipientMissingError('recipient');
          opened.push(version);
          return new Uint8Array(16);
        }),
      },
      posts
    );

    const result = await backfillHolder(
      deps,
      await unlockedOf(owner),
      designated,
      [{ relic_id: RELIC_A, coverage_gaps: [1, 2] }]
    );

    expect(opened).toEqual([1]);
    expect(result).toEqual({ stored: 1, skipped: 0 });
    const [post] = posts;
    expect(post?.url).toBe(`${ORIGIN}/api/identity/backfill`);
    // The body this test's own service recorded: the shape backfill sends.
    const sent = post?.body as BackfillBody;
    const wraps = sent.wraps;
    expect(wraps.map((wrap) => [wrap.relic_id, wrap.version])).toEqual([
      [RELIC_A, 1],
    ]);
    expect(wraps[0]?.recipient_key_id).toBe(
      Array.from(await kemKeyIdOf(holder.keys.kemPublicKey), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    );
  });
});
