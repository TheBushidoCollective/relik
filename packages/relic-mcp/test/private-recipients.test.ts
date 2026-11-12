import { describe, expect, test } from 'bun:test';
import {
  identityFingerprint,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import {
  partyIdentity,
  verifyDeviceList,
  verifyRecovery,
} from '../src/device.ts';
import { verifyGrant } from '../src/private.ts';
import {
  DAY_MS,
  makeCert,
  makeDevice,
  makePerson,
  ownerPin,
  type Person,
  signer,
} from './private-fixtures.ts';

const NOT_AFTER = Date.now() + 365 * DAY_MS;
const RELIC_ID = '0123456789abcdefghjkmnpqrs';

interface DeviceLike {
  readonly deviceId: string;
  readonly kem: string;
  readonly sig: string;
  readonly label: string;
}

async function deviceRecord(
  owner: Person,
  device: DeviceLike,
  signedBy?: Person
) {
  const cert = await makeCert({
    owner,
    device,
    notAfter: NOT_AFTER,
    ...(signedBy === undefined ? {} : { signedBy }),
  });
  return {
    device_id: device.deviceId,
    owner_identity_id: owner.identityId,
    kem_public_key: device.kem,
    sig_public_key: device.sig,
    label: device.label,
    backend: 'file',
    not_after: NOT_AFTER,
    certified_at: new Date().toISOString(),
    revoked_at: null,
    cert,
  };
}

function partyJson(person: Person) {
  return {
    email: person.email,
    identity: {
      identity_id: person.identityId,
      email: person.email,
      kem_public_key: person.kem,
      sig_public_key: person.sig,
      created_at: new Date().toISOString(),
      retired_at: null,
    },
  };
}

async function designation(owner: Person, recovery: Person, signedBy: Person) {
  const statement = {
    at: Date.now(),
    fingerprint_typed: await identityFingerprint(
      recovery.identityId,
      recovery.email
    ),
    owner_identity_id: owner.identityId,
    recovery_email: recovery.email,
    recovery_identity_id: recovery.identityId,
  };
  const identitySignature = await signStatement(
    signer(signedBy.keys.sig.privateKey),
    statementBytes('recovery_designation', statement)
  );
  return { statement, identity_signature: identitySignature };
}

describe('recipient verification before any wrap', () => {
  test('a device the pinned owner did not certify is refused', async () => {
    const owner = await makePerson('owner@example.com');
    const attacker = await makePerson('attacker@example.com');
    const device = await makeDevice('forged device');
    const record = await deviceRecord(owner, device, attacker);
    await expect(
      verifyDeviceList([record], ownerPin(owner), Date.now())
    ).rejects.toMatchObject({
      code: 'recipient_uncertified_device',
    });
  });

  test('a device the pinned owner certified is accepted as a recipient', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp');
    const readers = await verifyDeviceList(
      [await deviceRecord(owner, device)],
      ownerPin(owner),
      Date.now()
    );
    expect(readers.map((reader) => reader.kind)).toEqual(['device']);
    expect(readers[0]?.label).toBe('relic-mcp');
  });

  test('a revoked device is skipped as a recipient rather than refused', async () => {
    const owner = await makePerson('owner@example.com');
    const attacker = await makePerson('attacker@example.com');
    const device = await makeDevice('revoked device');
    const record = {
      ...(await deviceRecord(owner, device, attacker)),
      revoked_at: new Date().toISOString(),
    };
    expect(
      await verifyDeviceList([record], ownerPin(owner), Date.now())
    ).toEqual([]);
  });

  test('an unsigned recovery designation is refused', async () => {
    const owner = await makePerson('owner@example.com');
    const recovery = await makePerson('compliance@example.com');
    const attacker = await makePerson('attacker@example.com');
    await expect(
      verifyRecovery(
        {
          identity: partyJson(recovery).identity,
          designation: await designation(owner, recovery, attacker),
        },
        ownerPin(owner)
      )
    ).rejects.toMatchObject({ code: 'recovery_unsigned' });
  });

  test('a designation the pinned owner signed is accepted as the recovery recipient', async () => {
    const owner = await makePerson('owner@example.com');
    const recovery = await makePerson('compliance@example.com');
    const reader = await verifyRecovery(
      {
        identity: partyJson(recovery).identity,
        designation: await designation(owner, recovery, owner),
      },
      ownerPin(owner)
    );
    expect(reader.kind).toBe('recovery');
    expect(reader.email).toBe(recovery.email);
  });

  test('an identity whose keys do not hash to its identity id is refused', async () => {
    const owner = await makePerson('owner@example.com');
    const other = await makePerson('other@example.com');
    await expect(
      partyIdentity({
        identity_id: other.identityId,
        email: owner.email,
        kem_public_key: owner.kem,
        sig_public_key: owner.sig,
      })
    ).rejects.toMatchObject({ code: 'recipient_key_mismatch' });
  });

  test('a grant the pinned owner did not sign is refused, and a signed one is accepted', async () => {
    const owner = await makePerson('owner@example.com');
    const grantee = await makePerson('reader@example.com');
    const attacker = await makePerson('attacker@example.com');
    const statement = {
      at: Date.now(),
      fingerprint_typed: await identityFingerprint(
        grantee.identityId,
        grantee.email
      ),
      grantee_email: grantee.email,
      grantee_identity_id: grantee.identityId,
      owner_identity_id: owner.identityId,
      relic_id: RELIC_ID,
      versions: [1],
    };
    const bytes = statementBytes('grant', statement);
    const grantWith = async (signedBy: Person) => ({
      statement,
      identity_signature: await signStatement(
        signer(signedBy.keys.sig.privateKey),
        bytes
      ),
      granted_at: new Date().toISOString(),
      revoked_at: null,
      grantee: partyJson(grantee),
    });

    await expect(
      verifyGrant(await grantWith(attacker), ownerPin(owner), RELIC_ID)
    ).rejects.toMatchObject({ code: 'recipient_forged_grant' });

    const reader = await verifyGrant(
      await grantWith(owner),
      ownerPin(owner),
      RELIC_ID
    );
    expect(reader.kind).toBe('grantee');
    expect(reader.email).toBe(grantee.email);
  });
});
